/**
 * lib/server/research/jevReadinessInput.ts
 *
 * Jev Research Readiness — 生产输入适配（只读）。
 *
 * 从正式 Research 读边界组装 `ReadinessSourcePort` 并构建 `JevReadinessInput`：
 * - 输入全部来自：当前 Research Task 状态（绑定四元组）、ResearchInputBundle、
 *   DecisionDelivery（确定性 11 条风险规则 + 决策摘要）、正式 VOC 分析快照、
 *   `loadCanonicalResearchBoundary().allowedEvidenceRefs`；
 * - 不从旧 Candidate sourceMetaJson 读取过期字段冒充正式 ProductFact；
 * - 不重新抓取证据、不调用 DeepSeek、不生成研报、不写任何存储。
 *
 * 证据纪律（P0-A）：
 * - Research 叙述以正式 `report.narrativeBindings`（生成时已绑定 allowlist 引用）为准，
 *   逐条经 `isNarrativeVerifiable`（生产 `isVerifiedNarrative` + allowlist）复核；
 * - VOC 主题引用（externalContentId）→ 观测凭证（`attachment:<groupId>`）映射由本模块
 *   自行构建并复核（不依赖上游假设）；任一条不可映射/跨任务/不在白名单 → 由
 *   `resolveVocThemeCredentials` 整主题降级（fail-closed，不作事实使用）。
 */
import "server-only";

import type { ResearchInputBundle } from "@/lib/sourceLayer/v2/contracts";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import type { DecisionDelivery } from "@/lib/server/research/decisionDelivery";
import type { VocAnalysisV1 } from "@/lib/server/vocAnalysis";
import {
  buildJevReadinessInput,
  type ReadinessSourcePort,
  type VocObservationCredential,
  type VocThemeProjection,
} from "@/lib/decision/readiness/inputAdapter";
import { JEV_READINESS_RERUN_COOLDOWN_MS, type JevReadinessPolicy, type JevReadinessProviderKind } from "@/lib/decision/readiness/policy";
import type { JevReadinessInput, ReadinessInputBinding, ReadinessRunResult } from "@/lib/decision/readiness/types";
import type { ReadinessPeek } from "@/lib/server/research/jevReadinessRuntime";

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ── 字段存在性（present/missing，缺失一律显式） ─────────────────── */

type FactFieldLike = { readonly status?: unknown } | null | undefined;

function presenceOf(field: FactFieldLike): "present" | "missing" {
  return field && field.status === "present" ? "present" : "missing";
}

export function fieldPresenceOf(productFact: ProductFact | null | undefined): Readonly<Record<string, "present" | "missing">> {
  if (!productFact) return {};
  const basic = productFact.basic;
  const market = productFact.market;
  const profit = productFact.profit;
  const bsr = presenceOf(market?.bsr) === "present" || presenceOf(market?.subCategoryBsr) === "present" ? "present" : "missing";
  return {
    brand: presenceOf(basic?.brand),
    category: presenceOf(basic?.category),
    price: presenceOf(basic?.price),
    rating: presenceOf(basic?.rating),
    reviewCount: presenceOf(basic?.reviewCount),
    bsr,
    monthlySalesEstimate: presenceOf(market?.monthlySalesEstimate),
    fbaFee: presenceOf(profit?.fbaFee),
    packageWeight: presenceOf(profit?.packageWeight),
  };
}

/* ── 研报叙述（以生成时绑定为准） ───────────────────────────────── */

function narrativesFromReport(report: Record<string, unknown>): {
  entries: { text: string | null; evidenceRefs: readonly string[] }[];
} {
  const entries: { text: string | null; evidenceRefs: readonly string[] }[] = [];
  const bindings = Array.isArray(report["narrativeBindings"]) ? (report["narrativeBindings"] as unknown[]) : [];
  for (const item of bindings) {
    if (!isRecordLike(item)) continue;
    const text = typeof item["text"] === "string" ? (item["text"] as string) : null;
    const refsRaw = item["evidenceRefs"];
    const evidenceRefs = Array.isArray(refsRaw) ? refsRaw.filter((ref): ref is string => typeof ref === "string") : [];
    entries.push({ text, evidenceRefs });
  }
  // 未验证假设（含缺失字段提示/非法引用提示）：作为“未验证叙述”供模型区分，绝不作为事实。
  const unverifiedRaw = Array.isArray(report["unverifiedAssumptions"]) ? (report["unverifiedAssumptions"] as unknown[]) : [];
  for (const item of unverifiedRaw) {
    if (typeof item !== "string" || !item.trim()) continue;
    entries.push({ text: item.slice(0, 600), evidenceRefs: [] });
  }
  return { entries };
}

/* ── VOC 观测凭证（defense in depth） ───────────────────────────── */

function credentialsFromBundle(bundle: ResearchInputBundle): VocObservationCredential[] {
  const byExternalId = new Map<string, Set<string>>();
  for (const group of bundle.customerVoiceEvidence ?? []) {
    const attachmentId = typeof group.attachmentId === "string" ? group.attachmentId.trim() : "";
    if (!attachmentId) continue;
    const ref = `attachment:${attachmentId}`;
    for (const observation of group.observations ?? []) {
      const externalContentId = typeof observation.externalContentId === "string" ? observation.externalContentId.trim() : "";
      // 自行复核（不依赖上游假设）：refId 必须 == 观测所在附件凭证；
      // 与 researchInputBundle 组装约束、vocAnalysis 409 CUSTOMER_VOICE_EVIDENCE_INVALID 保持一致。
      if (!externalContentId || observation.refId !== ref) continue;
      const existing = byExternalId.get(externalContentId);
      if (existing) existing.add(ref);
      else byExternalId.set(externalContentId, new Set([ref]));
    }
  }
  const credentials: VocObservationCredential[] = [];
  for (const [externalContentId, refs] of byExternalId) {
    // 同一观测被多个附件映射 → 歧义 → 整体拒收（可确定性映射是进入凭证索引的前提）。
    if (refs.size !== 1) continue;
    credentials.push({ externalContentId, evidenceRefs: [...refs], taskId: bundle.taskId });
  }
  return credentials;
}

/* ── VOC 主题投影 ───────────────────────────────────────────────── */

const VOC_THEME_CATEGORIES = [
  { field: "painPointThemes", kind: "pain" },
  { field: "positiveThemes", kind: "positive" },
  { field: "recurringRequests", kind: "request" },
] as const;

function vocFromAnalysis(analysis: VocAnalysisV1 | null): ReadinessSourcePort["voc"] {
  if (!analysis) return null;
  const themes: VocThemeProjection[] = [];
  for (const { field, kind } of VOC_THEME_CATEGORIES) {
    const list = analysis.themes?.[field] ?? [];
    for (const theme of list) {
      const label = typeof theme.label === "string" ? theme.label.trim() : "";
      if (!label) continue;
      const strength = theme.strength === "recurring" || theme.strength === "weak" || theme.strength === "isolated"
        ? theme.strength
        // 非法强度值一律保守降级为 isolated（宁少不过度声称）。
        : "isolated";
      themes.push({
        label,
        reviewCount: typeof theme.reviewCount === "number" && Number.isFinite(theme.reviewCount) ? theme.reviewCount : 0,
        strength,
        kind,
        evidenceRefs: Array.isArray(theme.evidenceRefs) ? theme.evidenceRefs.filter((ref): ref is string => typeof ref === "string") : [],
      });
    }
  }
  const reviewsUsed = typeof analysis.datasetSnapshot?.reviewsUsed === "number" ? analysis.datasetSnapshot.reviewsUsed : null;
  const totalReviews = typeof analysis.datasetSnapshot?.totalReviews === "number" ? analysis.datasetSnapshot.totalReviews : null;
  const themeMentionCount = themes.reduce((sum, theme) => sum + theme.reviewCount, 0);
  return { independentReviewCount: reviewsUsed ?? totalReviews ?? null, themeMentionCount, themes };
}

/* ── DecisionDelivery 投影 ─────────────────────────────────────── */

function riskGateFromDelivery(delivery: DecisionDelivery | null): ReadinessSourcePort["riskGate"] {
  if (!delivery || delivery.status !== "available" || !delivery.riskGate || !delivery.riskCounts) return null;
  return {
    status: delivery.riskGate.status,
    hasBlockingRisk: delivery.riskGate.hasBlockingRisk,
    blockingReasons: [...delivery.riskGate.blockingReasons],
    warningReasons: [...delivery.riskGate.warningReasons],
    ruleCounts: {
      blocking: delivery.riskCounts.blocking,
      warning: delivery.riskCounts.warning,
      notComputable: delivery.riskCounts.notComputable,
      passed: delivery.riskCounts.passed,
    },
  };
}

function decisionSummaryFromDelivery(delivery: DecisionDelivery | null): ReadinessSourcePort["decisionSummary"] {
  if (!delivery || delivery.status !== "available" || !delivery.decisionSummary) return null;
  const summary = delivery.decisionSummary;
  return {
    researchPriority: summary.researchPriority,
    recommendedNextAction: summary.recommendedNextAction,
    keyReasons: [...summary.keyReasons],
    blockingRisks: [...summary.blockingRisks],
    missingInformation: [...summary.missingInformation],
  };
}

/* ── 输入构建入口 ───────────────────────────────────────────────── */

export type JevReadinessInputBuildResult =
  | { readonly ok: true; readonly input: JevReadinessInput }
  | { readonly ok: false; readonly reason: string };

/** 从正式读边界构建 Jev 输入；缺失/不完整一律显式不可用（不补齐、不造假）。 */
export function buildJevReadinessInputFromProduction(args: {
  readonly taskId: string;
  readonly asin: string | null;
  readonly binding: ReadinessInputBinding;
  readonly report: Record<string, unknown> | null;
  readonly bundle: ResearchInputBundle;
  readonly allowedEvidenceRefs: readonly string[];
  readonly delivery: DecisionDelivery | null;
  readonly vocAnalysis: VocAnalysisV1 | null;
}): JevReadinessInputBuildResult {
  if (!args.report) return { ok: false, reason: "RESEARCH_REPORT_MISSING" };
  const binding = args.binding;
  if (!binding.reportHash || !binding.factHash || !binding.evidenceHash || typeof binding.researchRevision !== "number") {
    return { ok: false, reason: "RESEARCH_BINDING_INCOMPLETE" };
  }

  const { entries } = narrativesFromReport(args.report);
  const port: ReadinessSourcePort = {
    taskId: args.taskId,
    asin: args.asin,
    binding: { ...binding },
    riskGate: riskGateFromDelivery(args.delivery),
    decisionSummary: decisionSummaryFromDelivery(args.delivery),
    narratives: entries,
    voc: vocFromAnalysis(args.vocAnalysis),
    vocObservationCredentials: credentialsFromBundle(args.bundle),
    allowedEvidenceRefs: [...args.allowedEvidenceRefs],
    fieldPresence: fieldPresenceOf(args.bundle.productFact),
  };

  try {
    const built = buildJevReadinessInput(port);
    // 降级主题的提及数不得进入模型上下文：themeMentionCount 仅统计已验证主题（fail-closed 语义）。
    const verifiedMentionCount = built.voc ? built.voc.themes.reduce((sum, theme) => sum + theme.reviewCount, 0) : 0;
    return {
      ok: true,
      input: built.voc ? { ...built, voc: { ...built.voc, themeMentionCount: verifiedMentionCount } } : built,
    };
  } catch (error) {
    return { ok: false, reason: `JEV_INPUT_BUILD_FAILED:${error instanceof Error ? error.message : "unknown"}` };
  }
}

/* ── 详情读侧视图（轻投影；不触发任何 Provider） ────────────────── */

export type JevReadinessViewState = {
  /** 功能总开关（默认 false）。 */
  readonly enabled: boolean;
  /** 解析后的 Provider 类型。 */
  readonly providerKind: JevReadinessProviderKind;
  /** Provider 不可用的机器可读原因；可用时为 null。 */
  readonly providerReason: string | null;
  /** 是否具备运行条件（enabled && providerKind !== unavailable）。 */
  readonly providerReady: boolean;
  /** 输入（研报 + 绑定 + 边界）是否可构建。 */
  readonly inputAvailable: boolean;
  /** 输入不可用的原因（如 RESEARCH_REPORT_MISSING）。 */
  readonly inputReason: string | null;
  /** 当前绑定四元组（供 UI 与结果绑定对比）。 */
  readonly binding: ReadinessInputBinding;
  /** 当前有效的最近一次运行结果（进程内缓存；重启/新浏览器会话后消失属预期）。 */
  readonly lastResult: ReadinessRunResult | null;
  /** 存在历史运行但绑定/输入已失效（只给提示，不回传正文，避免作为当前建议呈现）。 */
  readonly staleResult: { readonly generatedAt: string; readonly binding: ReadinessInputBinding | null } | null;
  /** 同版本强制重跑冷却时长（毫秒）。 */
  readonly rerunCooldownMs: number;
};

export function buildJevReadinessViewState(args: {
  readonly policy: JevReadinessPolicy;
  readonly providerKind: JevReadinessProviderKind;
  readonly providerReason: string | null;
  readonly binding: ReadinessInputBinding;
  readonly inputAvailable: boolean;
  readonly inputReason: string | null;
  readonly peek: ReadinessPeek | null;
}): JevReadinessViewState {
  return {
    enabled: args.policy.enabled,
    providerKind: args.providerKind,
    providerReason: args.providerReason,
    providerReady: args.policy.enabled && args.providerKind !== "unavailable",
    inputAvailable: args.inputAvailable,
    inputReason: args.inputReason,
    binding: { ...args.binding },
    lastResult: args.peek && args.peek.fresh ? args.peek.result : null,
    staleResult: args.peek && !args.peek.fresh
      ? { generatedAt: args.peek.result.generatedAt, binding: args.peek.result.advice?.inputBinding ?? null }
      : null,
    rerunCooldownMs: JEV_READINESS_RERUN_COOLDOWN_MS,
  };
}
