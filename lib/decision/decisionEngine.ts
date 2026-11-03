/**
 * lib/decision/decisionEngine.ts
 *
 * Decision Engine — 业务层统一调用门面。
 *
 * 调用规范：
 * - 业务层（API 路由、服务层）统一通过本模块访问 AI 决策能力；
 * - 禁止业务层直接 import 具体 provider（如 typesafeProvider / mockProvider）；
 * - 本模块负责：provider 选取、失败状态保留、DecisionSnapshot 构造、输入哈希计算。
 *
 * Fallback 链：
 *   configured provider → failed / unavailable decision（不静默替换 Provider）
 */
import "server-only";

import { createHash } from "crypto";
import type { ProductFacts, ProductDecision, DecisionSnapshot } from "@/lib/decision/types";
import { getDecisionProvider } from "@/lib/decision/providers/index";
import { buildFailedDecision } from "@/lib/decision/schemas/productDecision";

/** 对输入 facts 计算 SHA-256 指纹，用于 DecisionSnapshot 追溯 */
function hashProductFacts(facts: ProductFacts): string {
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(facts)
        .filter(([, v]) => v !== null && v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
    )
  );
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * 分析商品研究价值，返回 AI 建议。
 *
 * Fallback 策略：Provider 失败时只返回带真实 provider 状态的 failed 结果，
 * 不在生产环境静默切换为 Mock；主研究流程不依赖此辅助建议。
 */
export async function analyzeProductDecision(facts: ProductFacts): Promise<ProductDecision> {
  const provider = getDecisionProvider();

  try {
    const result = await provider.analyzeProduct(facts);
    return result;
  } catch {
    return buildFailedDecision(provider.providerId, "unknown");
  }
}

/**
 * 分析研究优先级（单候选视角）。
 * 结果与 analyzeProductDecision 相同，语义上强调"排序视角"。
 */
export async function analyzeResearchPriority(facts: ProductFacts): Promise<ProductDecision> {
  const provider = getDecisionProvider();

  try {
    const result = await provider.analyzeResearchPriority(facts);
    return result;
  } catch {
    return buildFailedDecision(provider.providerId, "unknown");
  }
}

/**
 * 构造可持久化的 DecisionSnapshot。
 * 保存到候选 analysisJson 中，不覆盖证据，不修改事实。
 */
export function buildDecisionSnapshot(
  facts: ProductFacts,
  decision: ProductDecision
): DecisionSnapshot {
  return {
    schema: "decision-snapshot.v1",
    provider: decision.provider,
    model: decision.model,
    inputFactsHash: hashProductFacts(facts),
    output: decision,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 从候选的 analysisJson 中解析已有的 DecisionSnapshot（如有）。
 * 返回 null 表示尚未有 AI 分析记录。
 */
export function parseDecisionSnapshot(analysisJson: string | null | undefined): DecisionSnapshot | null {
  if (!analysisJson) return null;
  try {
    const parsed: unknown = JSON.parse(analysisJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const snap = record["decisionSnapshot"];
    if (!snap || typeof snap !== "object" || Array.isArray(snap)) return null;
    const s = snap as Record<string, unknown>;
    if (s["schema"] !== "decision-snapshot.v1") return null;
    if (typeof s["provider"] !== "string") return null;
    if (typeof s["model"] !== "string") return null;
    if (typeof s["inputFactsHash"] !== "string") return null;
    if (typeof s["createdAt"] !== "string") return null;
    if (!s["output"] || typeof s["output"] !== "object") return null;
    return snap as DecisionSnapshot;
  } catch {
    return null;
  }
}
