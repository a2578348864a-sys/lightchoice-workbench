import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticated, requireOwnerOnly } from "@/lib/server/demoGuard";
import { getAuthoritativeCandidate } from "@/lib/server/candidateAuthority";
import { logAgentEvent } from "@/lib/server/agentEventLogger";
import { prisma } from "@/lib/server/db";
import { parseSellerSpriteCandidateSourceMeta } from "@/lib/server/sellerSpriteImportContract";
import {
  analyzeResearchPriority,
  buildDecisionSnapshot,
  parseDecisionSnapshot,
} from "@/lib/decision/decisionEngine";
import type { ProductFacts } from "@/lib/decision/types";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ candidateId: string }> };

/**
 * 对象级授权失败一律 404：不区分「不存在」与「不属于当前访问身份」，
 * 避免通过状态码探测正式候选是否存在（与 /api/opportunity-candidates/research-context 一致）。
 */
const CANDIDATE_NOT_FOUND = {
  ok: false,
  error: {
    code: "candidate_not_found",
    message: "候选不存在或不属于当前访问身份，请返回发现商品重新选择。",
  },
} as const;

function candidateNotFound() {
  return NextResponse.json(CANDIDATE_NOT_FOUND, { status: 404 });
}

/**
 * POST /api/decision/research-priority/[candidateId]
 *
 * 读取候选商品的已有字段，调用 AI 分析研究优先级，返回 ProductDecision。
 *
 * 授权（AUTH-001）：
 * - 本接口会把 DecisionSnapshot 写回 Candidate.analysisJson（对象级写操作），
 *   因此要求 Owner 身份；Demo/访客一律 403（demo_action_forbidden）。
 * - 对象范围统一走 getAuthoritativeCandidate：Owner 只能命中正式 Candidate，
 *   sandbox / 本地草稿 id 一律 404；跨范围不调用 Provider、不读正式数据、不写 analysisJson。
 *
 * 设计原则：
 * - 只读候选的 sourceMetaJson / analysisJson，不访问 EvidenceStore；
 * - 分析结果以 DecisionSnapshot 形式追加到 analysisJson，不覆盖证据；
 * - 若候选已有有效快照且未超过缓存时间（30 分钟），直接返回缓存结果；
 * - AI provider 失败时返回可见的 failed / unavailable 建议状态，HTTP 仍为 200（不阻断主流程）。
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const auth = requireOwnerOnly(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: { code: auth.code, message: auth.message } },
      { status: auth.status }
    );
  }

  const { candidateId: rawCandidateId } = await context.params;
  const candidateId = rawCandidateId?.trim();
  if (!candidateId) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_candidate_id", message: "缺少有效候选商品 ID。" } },
      { status: 400 }
    );
  }

  try {
    // AUTH-001：对象级授权（Owner 仅正式 Candidate；sandbox / 本地草稿 id → 404）
    const candidate = await getAuthoritativeCandidate(auth.context, candidateId);
    if (!candidate) return candidateNotFound();

    // 检查已有缓存（30 分钟内有效）
    const existingSnapshot = parseDecisionSnapshot(candidate.analysisJson);
    if (existingSnapshot) {
      const snapshotAge = Date.now() - new Date(existingSnapshot.createdAt).getTime();
      const CACHE_TTL_MS = 30 * 60 * 1000;
      if (snapshotAge < CACHE_TTL_MS) {
        return NextResponse.json({ ok: true, data: existingSnapshot.output, cached: true });
      }
    }

    // 从 sourceMetaJson 提取 ProductFacts（来自已有字段，不读 EvidenceStore）
    const facts = extractProductFacts(candidate);

    // 调用 AI 分析（内部已有 fallback 链）
    const decision = await analyzeResearchPriority(facts);

    // 构建并持久化 DecisionSnapshot（追加到 analysisJson，不覆盖证据）
    const snapshot = buildDecisionSnapshot(facts, decision);
    await persistDecisionSnapshot(candidate.id, candidate.analysisJson, snapshot);

    return NextResponse.json({ ok: true, data: decision, cached: false });
  } catch {
    await logAgentEvent({ module: "research-priority", event: "analysis_failed", level: "error", message: "Research priority analysis failed.", metadata: { candidateId, errorCode: "decision_analysis_failed" } });
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "decision_analysis_failed",
          message: "AI 分析服务暂时不可用，不影响正常研究流程。",
        },
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/decision/research-priority/[candidateId]
 * 读取已有快照（不重新触发分析）。
 *
 * 授权（AUTH-001）：允许 Owner 读取正式 Candidate；Demo 仅能读取同一 demoAccessId
 * 的 sandbox Candidate。跨范围一律 404，且不触发 Provider。
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: { code: auth.code, message: auth.message } },
      { status: auth.status }
    );
  }

  const { candidateId: rawCandidateId } = await context.params;
  const candidateId = rawCandidateId?.trim();
  if (!candidateId) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_candidate_id", message: "缺少有效候选商品 ID。" } },
      { status: 400 }
    );
  }

  try {
    const candidate = await getAuthoritativeCandidate(auth.context, candidateId);
    if (!candidate) return candidateNotFound();

    const snapshot = parseDecisionSnapshot(candidate.analysisJson);
    if (!snapshot) {
      return NextResponse.json({ ok: true, data: null });
    }

    return NextResponse.json({ ok: true, data: snapshot.output, cached: true });
  } catch {
    console.warn("[research-priority] snapshot read failed", { code: "snapshot_read_failed" });
    // fail-closed：授权/读取异常时不泄露候选存在性
    return candidateNotFound();
  }
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * 从候选记录中提取 ProductFacts。
 * 仅读取 sourceMetaJson（sellerSprite 字段），不访问 EvidenceStore。
 */
function extractProductFacts(candidate: {
  name: string;
  sourceMetaJson: string | null;
}): ProductFacts {
  const meta = parseSellerSpriteCandidateSourceMeta(candidate.sourceMetaJson ?? "");
  if (meta) {
    return {
      title: meta.snapshot.title ?? candidate.name,
      brand: meta.snapshot.brand ?? null,
      category: meta.snapshot.category ?? null,
      price: meta.snapshot.priceUsd ?? null,
      rating: meta.snapshot.rating ?? null,
      reviewCount: meta.snapshot.reviewCount ?? null,
      rootCategoryBsr: meta.estimates.rootCategoryBsr ?? meta.estimates.searchRank ?? null,
      subCategoryBsr: meta.estimates.subCategoryBsr ?? null,
      estimatedMonthlySales: meta.estimates.estimatedMonthlySales ?? null,
      estimatedMonthlyRevenueUsd: meta.estimates.estimatedMonthlyRevenueUsd ?? null,
      asin: meta.identity.asin ?? null,
      marketplace: "Amazon US",
    };
  }

  // 无 sellerSprite 元数据时返回最简 facts（仅商品名，其余字段为 null）
  return {
    title: candidate.name,
    brand: null,
    category: null,
    price: null,
    rating: null,
    reviewCount: null,
    rootCategoryBsr: null,
    subCategoryBsr: null,
    estimatedMonthlySales: null,
    estimatedMonthlyRevenueUsd: null,
    asin: null,
    marketplace: null,
  };
}

/**
 * 将 DecisionSnapshot 追加写入候选的 analysisJson。
 * 不覆盖证据字段，只更新 decisionSnapshot 键。
 */
async function persistDecisionSnapshot(
  candidateId: string,
  existingAnalysisJson: string | null,
  snapshot: import("@/lib/decision/types").DecisionSnapshot
): Promise<void> {
  let existing: Record<string, unknown> = {};
  if (existingAnalysisJson) {
    try {
      const parsed: unknown = JSON.parse(existingAnalysisJson);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // 旧格式无法解析时保持空对象
    }
  }
  const updated = { ...existing, decisionSnapshot: snapshot };
  await prisma.opportunityCandidate.update({
    where: { id: candidateId },
    data: { analysisJson: JSON.stringify(updated) },
  });
}
