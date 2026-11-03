/**
 * Jev Phase 7A — Semantic Assist。
 *
 * 这是一个有边界的结构化候选契约，不是事实写入器，也不是自动采集器。
 * 当前实现只负责验证/封装已由确定性提取器发现的候选；未来模型调用也必须
 * 经过同一验证器。登录、验证码、套餐限制和无可见来源永远不进入此角色。
 */
export const SEMANTIC_ASSIST_SCHEMA = "source-layer-jev-semantic-assist.v1" as const;

export const SEMANTIC_ASSIST_TRIGGER_CODES = [
  "SELECTOR_MISS",
  "SELECTOR_FAILED",
  "DOM_CHANGED",
  "FIELD_AMBIGUOUS",
  "MULTIPLE_CANDIDATES",
  "LABEL_NORMALIZATION_REQUIRED",
  "ENTITY_BINDING_UNCERTAIN",
] as const;
export type SemanticAssistTriggerCode = (typeof SEMANTIC_ASSIST_TRIGGER_CODES)[number];

export const SEMANTIC_ASSIST_DECISIONS = ["needs_review", "estimated", "missing", "conflict"] as const;
export type SemanticAssistDecision = (typeof SEMANTIC_ASSIST_DECISIONS)[number];

export type SemanticAssistCandidate = {
  schemaVersion: typeof SEMANTIC_ASSIST_SCHEMA;
  jevRole: "semantic_assist";
  targetField: string;
  candidateValue: string | number | boolean | null;
  normalizedValue: string | number | boolean | null;
  evidenceRefs: string[];
  confidence: number;
  reason: string;
  triggerCode: SemanticAssistTriggerCode;
  decision: SemanticAssistDecision;
  modelVersion: string | null;
  promptVersion: string | null;
  recipeVersion: string | null;
  pageTemplateHash: string | null;
  evidenceHash: string | null;
};

export type SemanticAssistValidation =
  | { ok: true; candidate: SemanticAssistCandidate }
  | { ok: false; code: "EVIDENCE_REQUIRED" | "TRIGGER_NOT_ALLOWED" | "CONFIRMED_FORBIDDEN" | "CONFIDENCE_INVALID" | "CANDIDATE_INVALID"; reason: string };

export type SemanticAssistInput = Omit<SemanticAssistCandidate, "schemaVersion" | "jevRole">;

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

export function validateSemanticAssistCandidate(value: unknown): SemanticAssistValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "CANDIDATE_INVALID", reason: "候选结果必须是对象。" };
  }
  const item = value as Record<string, unknown>;
  if (item.jevRole !== "semantic_assist") {
    return { ok: false, code: "CANDIDATE_INVALID", reason: "Jev 角色不匹配。" };
  }
  if (typeof item.targetField !== "string" || !item.targetField.trim()) {
    return { ok: false, code: "CANDIDATE_INVALID", reason: "缺少目标字段。" };
  }
  if (!isScalar(item.candidateValue) || !isScalar(item.normalizedValue)) {
    return { ok: false, code: "CANDIDATE_INVALID", reason: "候选值必须是可审计标量。" };
  }
  if (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0
    || item.evidenceRefs.some((ref) => typeof ref !== "string" || !ref.trim())) {
    return { ok: false, code: "EVIDENCE_REQUIRED", reason: "Semantic Assist 候选必须绑定 evidenceRefs。" };
  }
  if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence)
    || item.confidence < 0 || item.confidence > 1) {
    return { ok: false, code: "CONFIDENCE_INVALID", reason: "置信度必须位于 0 到 1。" };
  }
  if (!SEMANTIC_ASSIST_TRIGGER_CODES.includes(item.triggerCode as SemanticAssistTriggerCode)) {
    return { ok: false, code: "TRIGGER_NOT_ALLOWED", reason: "该问题不属于 Semantic Assist 允许范围。" };
  }
  if (item.decision === "confirmed" || !SEMANTIC_ASSIST_DECISIONS.includes(item.decision as SemanticAssistDecision)) {
    return { ok: false, code: "CONFIRMED_FORBIDDEN", reason: "Jev 不得输出 confirmed。" };
  }
  if (typeof item.reason !== "string" || !item.reason.trim()) {
    return { ok: false, code: "CANDIDATE_INVALID", reason: "缺少候选原因。" };
  }
  const candidate: SemanticAssistCandidate = {
    schemaVersion: SEMANTIC_ASSIST_SCHEMA,
    jevRole: "semantic_assist",
    targetField: item.targetField.trim().slice(0, 160),
    candidateValue: item.candidateValue as SemanticAssistCandidate["candidateValue"],
    normalizedValue: item.normalizedValue as SemanticAssistCandidate["normalizedValue"],
    evidenceRefs: [...new Set((item.evidenceRefs as string[]).map((ref) => ref.trim().slice(0, 240)))].slice(0, 32),
    confidence: item.confidence,
    reason: item.reason.trim().slice(0, 500),
    triggerCode: item.triggerCode as SemanticAssistTriggerCode,
    decision: item.decision as SemanticAssistDecision,
    modelVersion: typeof item.modelVersion === "string" ? item.modelVersion.trim().slice(0, 96) : null,
    promptVersion: typeof item.promptVersion === "string" ? item.promptVersion.trim().slice(0, 96) : null,
    recipeVersion: typeof item.recipeVersion === "string" ? item.recipeVersion.trim().slice(0, 96) : null,
    pageTemplateHash: typeof item.pageTemplateHash === "string" ? item.pageTemplateHash.trim().slice(0, 128) : null,
    evidenceHash: typeof item.evidenceHash === "string" ? item.evidenceHash.trim().slice(0, 128) : null,
  };
  return { ok: true, candidate };
}

/** 仅封装确定性候选，不调用模型、不写事实。 */
export function buildSemanticAssistCandidate(input: SemanticAssistInput): SemanticAssistValidation {
  return validateSemanticAssistCandidate({
    ...input,
    jevRole: "semantic_assist",
    schemaVersion: SEMANTIC_ASSIST_SCHEMA,
  });
}
