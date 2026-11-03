/**
 * Jev Research Readiness — 输出运行时校验（fail-closed）
 *
 * 设计原则（沿用旧 lib/decision 的「输出必须运行时校验 + 失败不得静默降级」）：
 * - 任何契约违规 → 返回 null，由调用方映射为 failed，绝不降级为「成功」；
 * - 禁止字段（分数/概率/优先级/自动决策）一旦出现即整份拒收；
 * - 引用必须落在 allowlist 内；不在白名单的条目被**拒收并计数**，不静默保留；
 * - inputBinding 必须与输入四元组完全一致（防止把旧版本的结论套到新研究上）。
 */
import type {
  EvidenceRefVerdict,
  JevReadinessAdvice,
  JevReadinessInput,
  ReadinessInputBinding,
} from "./types";

/** 明确禁止的输出字段名（含嵌套任意层级） */
export const FORBIDDEN_OUTPUT_KEYS: readonly string[] = [
  "score",
  "opportunityscore",
  "productscore",
  "priority",
  "p1",
  "p2",
  "p3",
  "confidence",
  "probability",
  "proceed",
  "autoproceed",
  "autodecision",
  "decision",
  "recommendeddecision",
  "productbrief",
  "targetprice",
  "profitforecast",
];

const VALID_STATUS = new Set(["available", "unavailable", "failed"]);
const VALID_READINESS = new Set(["READY_FOR_HUMAN_REVIEW", "NEED_MORE_EVIDENCE", "HIGH_RISK"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectForbiddenKeys(value: unknown, found: Set<string>, depth = 0): void {
  if (depth > 6) return;
  if (Array.isArray(value)) {
    for (const item of value) collectForbiddenKeys(item, found, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_OUTPUT_KEYS.includes(key.trim().toLowerCase())) found.add(key);
    collectForbiddenKeys(child, found, depth + 1);
  }
}

/**
 * 单条证据引用机械校验（P0-2 修复核心）。
 *
 * 顺序不可调整：**先完成运行时类型验证，再做任何字符串处理**。
 * - 必须是数组；
 * - 每个元素必须是非空白字符串（null / undefined / number / object / 空串 / 空白串 一律拒收，**不静默忽略**）；
 * - 每个引用必须属于 allowlist；
 * - 只有全部通过才返回规范化引用，调用方无需再次处理原始值（避免未捕获 TypeError）。
 */
export function verdictEvidenceRefs(
  text: unknown,
  evidenceRefs: unknown,
  allowed: readonly string[],
): EvidenceRefVerdict {
  const reject = (reason: EvidenceRefVerdict["reason"], invalidRefs: readonly string[] = []): EvidenceRefVerdict =>
    ({ accepted: false, reason, invalidRefs, refs: [] });

  if (typeof text !== "string" || text.trim().length === 0) return reject("empty_text");

  if (!Array.isArray(evidenceRefs)) return reject("EVIDENCE_REFS_NOT_ARRAY");
  if (evidenceRefs.length === 0) return reject("empty_refs");

  // 逐元素类型校验：任何非字符串 / 空白字符串都是契约违规，不得过滤后继续
  for (const [index, ref] of evidenceRefs.entries()) {
    if (typeof ref !== "string") return reject(`EVIDENCE_REF_TYPE_INVALID:${index}`);
    if (ref.trim().length === 0) return reject(`EVIDENCE_REF_EMPTY:${index}`);
  }

  const normalized = (evidenceRefs as string[]).map((ref) => ref.trim());
  const allowedSet = new Set(allowed);
  const invalidRefs = normalized.filter((ref) => !allowedSet.has(ref));
  if (invalidRefs.length > 0) return reject("not_in_allowlist", invalidRefs);

  return { accepted: true, reason: "ok", invalidRefs: [], refs: normalized };
}

function sameBinding(a: ReadinessInputBinding, b: ReadinessInputBinding): boolean {
  return a.reportHash === b.reportHash
    && a.factHash === b.factHash
    && a.evidenceHash === b.evidenceHash
    && a.researchRevision === b.researchRevision;
}

function readBinding(raw: unknown): ReadinessInputBinding | null {
  if (!isRecord(raw)) return null;
  const reportHash = raw["reportHash"];
  const factHash = raw["factHash"];
  const evidenceHash = raw["evidenceHash"];
  const researchRevision = raw["researchRevision"];
  const asNullableString = (v: unknown) => (typeof v === "string" || v === null ? (v as string | null) : undefined);
  const rh = asNullableString(reportHash);
  const fh = asNullableString(factHash);
  const eh = asNullableString(evidenceHash);
  const rev = typeof researchRevision === "number" && Number.isFinite(researchRevision) ? researchRevision : researchRevision === null ? null : undefined;
  if (rh === undefined || fh === undefined || eh === undefined || rev === undefined) return null;
  return { reportHash: rh, factHash: fh, evidenceHash: eh, researchRevision: rev };
}

export type ParseAdviceOutcome =
  | {
    readonly ok: true;
    readonly advice: JevReadinessAdvice;
    readonly droppedQuestions: number;
    readonly droppedContradictions: number;
  }
  | {
    readonly ok: false;
    readonly reason: string;
    readonly droppedQuestions: number;
    readonly droppedContradictions: number;
    readonly forbiddenFields: readonly string[];
    readonly bindingMismatch: boolean;
  };

/**
 * 校验并规范化 Provider 返回值为 JevReadinessAdvice。
 * 任何违规 → ok:false（调用方必须映射为 failed，不得降级为成功）。
 */
export function parseJevReadinessAdvice(raw: unknown, input: JevReadinessInput): ParseAdviceOutcome {
  const empty = { droppedQuestions: 0, droppedContradictions: 0, forbiddenFields: [] as string[], bindingMismatch: false };
  if (!isRecord(raw)) return { ok: false, reason: "NOT_AN_OBJECT", ...empty };

  const forbidden = new Set<string>();
  collectForbiddenKeys(raw, forbidden);
  if (forbidden.size > 0) {
    return { ok: false, reason: "FORBIDDEN_FIELD_PRESENT", ...empty, forbiddenFields: [...forbidden] };
  }

  const status = raw["status"];
  if (typeof status !== "string" || !VALID_STATUS.has(status)) return { ok: false, reason: "UNKNOWN_STATUS_ENUM", ...empty };

  const readiness = raw["readiness"];
  if (readiness !== null && (typeof readiness !== "string" || !VALID_READINESS.has(readiness))) {
    return { ok: false, reason: "UNKNOWN_READINESS_ENUM", ...empty };
  }

  const binding = readBinding(raw["inputBinding"]);
  if (!binding) return { ok: false, reason: "INPUT_BINDING_MALFORMED", ...empty };
  if (!sameBinding(binding, input.binding)) {
    return { ok: false, reason: "INPUT_BINDING_MISMATCH", ...empty, bindingMismatch: true };
  }

  const asStringArray = (v: unknown, cap: number): string[] | null => {
    if (!Array.isArray(v)) return null;
    const out = v.filter((item): item is string => typeof item === "string").map((s) => s.trim()).filter(Boolean);
    if (out.length !== v.length) return null;
    return out.slice(0, cap);
  };

  const missingEvidence = asStringArray(raw["missingEvidence"], 20);
  const limitations = asStringArray(raw["limitations"], 20);
  if (missingEvidence === null || limitations === null) return { ok: false, reason: "STRING_ARRAY_MALFORMED", ...empty };

  const rawQuestions = raw["reviewQuestions"];
  const rawContradictions = raw["contradictions"];
  if (!Array.isArray(rawQuestions) || !Array.isArray(rawContradictions)) {
    return { ok: false, reason: "ITEM_ARRAY_MALFORMED", ...empty };
  }

  const filterItems = (items: unknown[]) => {
    const kept: { text: string; evidenceRefs: string[] }[] = [];
    let dropped = 0;
    for (const item of items) {
      if (!isRecord(item)) { dropped += 1; continue; }
      const verdict = verdictEvidenceRefs(item["text"], item["evidenceRefs"], input.allowedEvidenceRefs);
      if (!verdict.accepted) { dropped += 1; continue; }
      // 使用校验后已规范化的引用，不再触碰原始值（P0-2）
      const rawText = item["text"];
      kept.push({
        text: (rawText as string).trim(),
        evidenceRefs: [...verdict.refs],
      });
    }
    return { kept: kept.slice(0, 12), dropped };
  };

  const questions = filterItems(rawQuestions);
  const contradictions = filterItems(rawContradictions);

  // 任何条目因引用非法/文本为空被拒收 → 视为 Provider 违反证据契约，整份拒收（fail-closed）。
  // 设计取舍：生产可改为「保留合法条目 + 显式展示拒收计数」，但 Spike 采用更严格口径。
  if (questions.dropped > 0 || contradictions.dropped > 0) {
    return {
      ok: false,
      reason: "EVIDENCE_REFS_REJECTED",
      droppedQuestions: questions.dropped,
      droppedContradictions: contradictions.dropped,
      forbiddenFields: [],
      bindingMismatch: false,
    };
  }

  // 失败/不可用态不得携带任何结论内容（防止「失败但塞了结论」）
  if (status !== "available") {
    if (readiness !== null || questions.kept.length > 0 || contradictions.kept.length > 0) {
      return { ok: false, reason: "NON_AVAILABLE_CARRIES_CONTENT", ...empty };
    }
  } else if (readiness === null) {
    return { ok: false, reason: "AVAILABLE_WITHOUT_READINESS", ...empty };
  }

  return {
    ok: true,
    advice: {
      status: status as JevReadinessAdvice["status"],
      readiness: readiness as JevReadinessAdvice["readiness"],
      reviewQuestions: questions.kept,
      contradictions: contradictions.kept,
      missingEvidence,
      limitations,
      inputBinding: binding,
    },
    droppedQuestions: questions.dropped,
    droppedContradictions: contradictions.dropped,
  };
}
