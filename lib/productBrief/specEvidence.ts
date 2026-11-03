import type { ProductBriefSpecRow } from "./contract";

/**
 * 规格证据的最小正确性边界：
 * - 没有具体 evidenceRefs 的行不能保持 FACT / verified，只能按假设处理；
 * - 改动名称、数值或单位后，旧引用不再支持新内容，必须移除并降级；
 * - 新增行不得在保存时自带引用（引用只能来自正式生成/已有行，不靠前端自报）；
 * - 内容未变化时，服务端只保留自己已存的引用与状态，不接受客户端替换或提升。
 * 本文件只处理规格行的证据状态，不新建第二套证据库或审核流程。
 */

export function specContentChanged(previous: ProductBriefSpecRow, next: ProductBriefSpecRow): boolean {
  return previous.label !== next.label
    || previous.value !== next.value
    || (previous.unit ?? null) !== (next.unit ?? null);
}

function normalizedSpecVerification(value: ProductBriefSpecRow["verification"]): ProductBriefSpecRow["verification"] {
  return value === "not_applicable" ? "not_applicable" : "unverified";
}

/**
 * 读取或保存已存规格时执行：
 * - 规格没有正式核验机制，verified 只能是人工选择，统一降为未验证；
 * - 没有引用时 FACT 也降为假设；
 * - 引用、内容与 not_applicable 保留。
 */
export function enforceSpecEvidenceRules(row: ProductBriefSpecRow): ProductBriefSpecRow {
  const verification = normalizedSpecVerification(row.verification);
  if (row.evidenceRefs.length > 0) return { ...row, verification };
  return { ...row, nature: "ASSUMPTION", verification };
}

/**
 * 编辑单行规格时使用：只接受名称、数值、单位三类内容修改。
 * 内容不变时保留当前已载入（服务端可信）的性质与引用；内容变化时移除旧引用并降级。
 * 客户端传入的 nature / verification / evidenceRefs / id 一律忽略。
 */
export function applySpecContentPatch(row: ProductBriefSpecRow, patch: Partial<ProductBriefSpecRow>): ProductBriefSpecRow {
  const content = {
    label: patch.label ?? row.label,
    value: patch.value ?? row.value,
    unit: patch.unit !== undefined ? patch.unit : row.unit,
  };
  const next = { ...row, ...content };
  if (!specContentChanged(row, next)) return enforceSpecEvidenceRules(row);
  return { ...row, ...content, evidenceRefs: [], nature: "ASSUMPTION", verification: "unverified" };
}

function incomingRow(value: unknown): ProductBriefSpecRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.label !== "string" || typeof record.value !== "string") return null;
  return {
    id: record.id,
    label: record.label,
    value: record.value,
    unit: typeof record.unit === "string" ? record.unit : null,
    nature: record.nature === "FACT" || record.nature === "EVIDENCE_DERIVED" ? record.nature : "ASSUMPTION",
    verification: record.verification === "verified" || record.verification === "not_applicable" ? record.verification : "unverified",
    evidenceRefs: Array.isArray(record.evidenceRefs) ? record.evidenceRefs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0) : [],
  };
}

/**
 * 服务端保存前使用：以当前已存规格为唯一可信基准。
 * - 新增行、伪造/重复 ID：清除引用，降级为待确认假设、未验证；
 * - 名称/数值/单位变化：清除旧引用，降级为待确认假设、未验证；
 * - 内容未变化：原样返回服务端已存行，忽略客户端提供的引用、性质与验证状态。
 * 不修改历史版本；历史快照仍由 preserveBriefHistory 原样保存。
 */
export function sanitizeIncomingSpecifications(incoming: unknown, previous: readonly ProductBriefSpecRow[]): unknown {
  if (!Array.isArray(incoming)) return incoming;
  const previousById = new Map(previous.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const sanitized: unknown[] = [];
  for (const raw of incoming) {
    const parsed = incomingRow(raw);
    if (!parsed) {
      sanitized.push(raw);
      continue;
    }
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    const before = previousById.get(parsed.id);
    if (!before) {
      sanitized.push({ ...parsed, evidenceRefs: [], nature: "ASSUMPTION", verification: "unverified" });
      continue;
    }
    if (specContentChanged(before, parsed)) {
      sanitized.push({ ...parsed, evidenceRefs: [], nature: "ASSUMPTION", verification: "unverified" });
      continue;
    }
    sanitized.push(enforceSpecEvidenceRules({ ...before }));
  }
  return sanitized;
}
