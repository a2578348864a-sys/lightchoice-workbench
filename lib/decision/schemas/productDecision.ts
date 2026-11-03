/**
 * lib/decision/schemas/productDecision.ts
 *
 * 运行时结构校验（plain 对象校验，无外部 schema 库依赖）。
 * 用于验证 AI provider 返回的数据结构是否符合 ProductDecision 契约。
 */
import type { ProductDecision, DecisionPriority, DecisionStatus } from "@/lib/decision/types";

const VALID_PRIORITIES = new Set<DecisionPriority>(["P1", "P2", "P3"]);
const VALID_STATUSES = new Set<DecisionStatus>(["completed", "pending", "failed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * 校验并规范化 provider 返回值是否符合 ProductDecision 契约。
 * 返回规范化后的 ProductDecision，或 null（校验失败）。
 */
export function parseProductDecision(raw: unknown, provider: string, model: string): ProductDecision | null {
  if (!isRecord(raw)) return null;

  // priority
  const priority = raw["priority"];
  if (!VALID_PRIORITIES.has(priority as DecisionPriority)) return null;

  // score
  const score = raw["score"];
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) return null;

  // status
  const status = raw["status"];
  if (!VALID_STATUSES.has(status as DecisionStatus)) return null;

  // confidence
  const confidence = raw["confidence"];
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  )
    return null;

  // reasons
  const reasons = raw["reasons"];
  if (!isStringArray(reasons)) return null;

  // risks
  const risks = raw["risks"];
  if (!isStringArray(risks)) return null;

  // timestamp
  const timestamp = raw["timestamp"];
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) return null;

  return {
    priority: priority as DecisionPriority,
    score: Math.round(score * 10) / 10,
    status: status as DecisionStatus,
    confidence: Math.round(confidence * 1000) / 1000,
    reasons: reasons.slice(0, 5).map((r) => r.trim()).filter(Boolean),
    risks: risks.slice(0, 3).map((r) => r.trim()).filter(Boolean),
    provider,
    model,
    timestamp,
  };
}

/**
 * 构建一个「待分析」状态的 ProductDecision（provider 暂不可用时返回）。
 */
export function buildPendingDecision(provider: string, model: string): ProductDecision {
  return {
    priority: "P2",
    score: 0,
    status: "pending",
    confidence: 0,
    reasons: ["AI 分析服务暂时不可用，请稍后重试。"],
    risks: [],
    provider,
    model,
    timestamp: new Date().toISOString(),
  };
}

/**
 * 构建一个「分析失败」状态的 ProductDecision；不会隐式替换为另一个 Provider。
 */
export function buildFailedDecision(provider: string, model: string): ProductDecision {
  return {
    priority: "P2",
    score: 0,
    status: "failed",
    confidence: 0,
    reasons: ["AI 分析未能完成，已保留为不可用状态，不影响正常研究流程。"],
    risks: ["建议手动评估商品研究优先级。"],
    provider,
    model,
    timestamp: new Date().toISOString(),
  };
}
