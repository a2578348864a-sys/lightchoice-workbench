/**
 * lib/server/research/reportEvidenceIntegrity.ts
 *
 * AI 研报「证据可信度」统一投影（P0 修复：V6_RESEARCH_EVIDENCE_INTEGRITY_P0_FIX）
 *
 * 背景缺陷：advisory 绑定阶段只删除非法 evidenceRef，却把失去支撑的事实句子原样保留，
 * 造成 `evidenceRefs 全部合法` 但 `summary 仍含未获合法证据支撑的肯定式事实`。
 *
 * 本模块只做两件事，且都是**保守**的：
 *  1. `assessReportEvidenceIntegrity` —— 判定一份研报中哪些**已持久化**的陈述必须暂停展示。
 *  2. `sanitizeReportForConsumption` —— 产出可消费的安全投影，并把拒收原因一并带出。
 *
 * 硬边界：
 *  - 不修改持久化记录、不修改 reportHash、不改 researchRevision；
 *  - 无事可做时**原样返回同一对象引用**，保证 `hashJson(report)` 与持久化 reportHash 完全一致，
 *    不影响既有绑定校验与下游流程；
 *  - 不做语义事实核验（「模型没写引用却编造的新事实」当前契约无法确定性验证，该限制如实上报）。
 *
 * 判定来源有两类（都来自研报自身已有的审计通道，不新增事实来源）：
 *  A. 新研报：`report.rejectedClaims`（绑定阶段写入的结构化拒收记录）。
 *  B. 历史研报：`report.unverifiedAssumptions` 中的绑定阶段审计文本。
 */

export const EVIDENCE_SUMMARY_SUPPRESSED_NOTICE =
  "本段 AI 摘要包含未通过证据校验的具体事实，已暂停作为有效研究结论展示。请查看下方经验证的机会、风险和来源证据。";

export const EVIDENCE_BLOCK_SUPPRESSED_NOTICE =
  "该部分包含引用证据白名单之外来源的陈述，无法确认其支撑范围，已暂停作为有效研究结论展示。";

export type RejectedClaimDisposition =
  /** 绑定阶段即整条拒收，**未进入**正式研报 */
  | "rejected_whole_statement"
  /** 历史缺陷：该条曾被保留在正式研报中，但其支撑范围不可知 —— 必须暂停展示 */
  | "retained_legacy_unsupported";

export type RejectedClaim = {
  /** 草稿字段路径，例如 `summary` / `opportunities[3]` / `vocAnalysis.painPoints[0]` */
  field: string;
  reason: "illegal_evidence_ref";
  /** 触发拒收的白名单外引用 */
  illegalRefs: string[];
  /** 模型当时声明的全部引用（含合法引用） */
  declaredRefs: string[];
  disposition: RejectedClaimDisposition;
  textPreview: string;
};

export type ReportEvidenceIntegrity = {
  /** 是否存在任何被拒收的陈述（含已从正式研报中剔除、仅留审计的情形） */
  contaminated: boolean;
  /** 是否存在**已持久化内容**被暂停展示（用于下游阻断判定） */
  suppressed: boolean;
  suppressedSummary: boolean;
  suppressedOpportunities: number[];
  suppressedRisks: number[];
  suppressedVoc: Record<string, number[]>;
  /** 无法确定句子级映射、只能整块暂停展示的字段路径 */
  suppressedWholeFields: string[];
  rejectedClaims: RejectedClaim[];
  /** 面向用户/审计的屏蔽原因（仅在有内容被暂停展示时出现） */
  notices: string[];
  /** 仅审计用途的一句话（即使无需屏蔽也会出现），未拒收时为 null */
  auditSummary: string | null;
  /**
   * P5-v6：因**结论强度超过证据**（销量估算当确认、样本代表性不足等）被暂停展示的条目。
   * 与「证据白名单」抑制分开计数，便于 UI 说明原因。
   */
  strengthSuppressed?: { readonly opportunities: number[]; readonly risks: number[] };
};

/** P5-v6：结论强度超过证据时的统一说明。 */
const EVIDENCE_STRENGTH_SUPPRESSED_NOTICE =
  "本研报有结论的强度超过其证据（例如把页面展示的购买量估算当作已确认销量、或用少量评论的代表性推断总体），已暂停展示这些条目；原文保留在研报历史中，修正表述后可重新评估。";

const TAINT_PATTERN = /^(.+?) 引用了 allowlist 外证据 \[(.+?)\]，已 fail-closed。$/u;
/** 旧版写法：整条陈述因缺少合法 citation 绑定被剔除（该条**未进入**正式研报） */
const DROPPED_PATTERN = /^(.+?) 缺少合法 citation 绑定，已移入未验证假设: /u;
/** 新版写法：整条陈述因引用白名单外证据被剔除（该条**未进入**正式研报） */
const REJECTED_PATTERN = /^(.+?) 因引用白名单外证据整条拒收/u;

const VOC_CATEGORIES = [
  "painPoints",
  "positiveSignals",
  "failureModes",
  "useCases",
  "replacementSignals",
  "switchReasons",
  "ownershipClaims",
] as const;

export const EMPTY_REPORT_EVIDENCE_INTEGRITY: ReportEvidenceIntegrity = Object.freeze({
  contaminated: false,
  suppressed: false,
  suppressedSummary: false,
  suppressedOpportunities: [],
  suppressedRisks: [],
  suppressedVoc: {},
  suppressedWholeFields: [],
  rejectedClaims: [],
  notices: [],
  auditSummary: null,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function persistedArrayItemHasText(list: string, value: unknown): boolean {
  if (hasText(value)) return true;
  if (!list.startsWith("vocAnalysis.") || !isRecord(value)) return false;
  return [value.text, value.summary, value.analysis, value.claim].some(hasText);
}

type BindingAudit = {
  /** 声明过白名单外引用的字段路径 */
  tainted: Set<string>;
  /** 已确认被整条剔除、未进入正式研报的字段路径 */
  dropped: Set<string>;
  /** 字段路径 → 该字段出现过的白名单外引用 */
  illegalByField: Map<string, Set<string>>;
};

/** 解析绑定阶段的拒收审计文本。 */
function parseBindingAudit(unverifiedAssumptions: string[]): BindingAudit {
  const tainted = new Set<string>();
  const dropped = new Set<string>();
  const illegalByField = new Map<string, Set<string>>();
  for (const line of unverifiedAssumptions) {
    if (typeof line !== "string") continue;
    const taint = TAINT_PATTERN.exec(line);
    if (taint) {
      const [, field, ref] = taint;
      tainted.add(field);
      const set = illegalByField.get(field) ?? new Set<string>();
      set.add(ref);
      illegalByField.set(field, set);
      continue;
    }
    const rejected = REJECTED_PATTERN.exec(line);
    if (rejected) { dropped.add(rejected[1]); continue; }
    const droppedMatch = DROPPED_PATTERN.exec(line);
    if (droppedMatch) dropped.add(droppedMatch[1]);
  }
  return { tainted, dropped, illegalByField };
}

/** 解析新研报的结构化拒收记录（容错：任何字段形态异常都忽略该条，不抛错）。 */
function parseStructuredRejectedClaims(value: unknown): RejectedClaim[] {
  if (!Array.isArray(value)) return [];
  const claims: RejectedClaim[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const field = typeof entry.field === "string" ? entry.field.trim() : "";
    if (!field) continue;
    claims.push({
      field,
      reason: "illegal_evidence_ref",
      illegalRefs: stringList(entry.illegalRefs),
      declaredRefs: stringList(entry.declaredRefs),
      disposition: "rejected_whole_statement",
      textPreview: typeof entry.textPreview === "string" ? entry.textPreview.slice(0, 160) : "",
    });
  }
  return claims;
}

/** `opportunities[3]` → { list: "opportunities", index: 3 }；非数组路径返回 null。 */
function parseArrayPath(field: string): { list: string; index: number } | null {
  const match = /^([A-Za-z0-9_.]+)\[(\d+)\]$/u.exec(field);
  if (!match) return null;
  return { list: match[1], index: Number(match[2]) };
}

/**
 * 判定研报中必须暂停展示的内容。
 *
 * 关键区分（这就是原缺陷的反面）：
 *  - 「声明了白名单外引用 **且** 有合法引用」→ 该条被**保留**在正式研报里，但支撑范围不可知 ⇒ 必须暂停展示。
 *  - 「声明了白名单外引用 **但** 无任何合法引用」→ 该条已被剔除，**未进入**正式研报 ⇒ 无需暂停展示。
 *  - 「完全没有引用」→ 该条已被剔除，未进入正式研报 ⇒ 无需暂停展示。
 *
 * 历史研报的数组下标经过「剔除项前移」换算；一旦无法确定映射，则整块暂停展示该字段
 * （宁可不展示，也不把不可靠陈述当作已确认事实）。
 */
export function assessReportEvidenceIntegrity(
  report: unknown,
  options?: { readonly strengthBlockedTexts?: readonly string[] },
): ReportEvidenceIntegrity {
  if (!isRecord(report)) return EMPTY_REPORT_EVIDENCE_INTEGRITY;

  const structuredClaims = parseStructuredRejectedClaims(report.rejectedClaims);
  const { tainted, dropped, illegalByField } = parseBindingAudit(stringList(report.unverifiedAssumptions));

  // 审计记录：结构化拒收 + 由历史审计文本重建的拒收（含历史缺陷中「被保留」的那一类）
  const rejectedClaims: RejectedClaim[] = [...structuredClaims];
  for (const field of tainted) {
    if (structuredClaims.some((claim) => claim.field === field)) continue;
    rejectedClaims.push({
      field,
      reason: "illegal_evidence_ref",
      illegalRefs: [...(illegalByField.get(field) ?? [])],
      declaredRefs: [],
      disposition: dropped.has(field) ? "rejected_whole_statement" : "retained_legacy_unsupported",
      textPreview: "",
    });
  }

  const suppressedWholeFields: string[] = [];
  const notices: string[] = [];
  const suppressedIndexes = new Map<string, Set<number>>();
  const markSuppressed = (list: string, index: number) => {
    const set = suppressedIndexes.get(list) ?? new Set<number>();
    set.add(index);
    suppressedIndexes.set(list, set);
  };
  const markWholeField = (list: string) => {
    if (!suppressedWholeFields.includes(list)) suppressedWholeFields.push(list);
  };

  // ── summary：单字段，无映射歧义。仅当**已持久化的 summary 真的有内容**时才需要屏蔽
  //    （新研报在绑定阶段已整条拒收，summary 本就是 null，无需二次处理，从而保持 hash 不变）。
  const summaryText = report.summary;
  const summaryPersisted = hasText(summaryText);
  const structuredSummaryRejected = structuredClaims.some((claim) => claim.field === "summary");
  const summaryTainted = (tainted.has("summary") && !dropped.has("summary")) || structuredSummaryRejected;
  let suppressedSummary = summaryPersisted && summaryTainted;
  if (suppressedSummary) notices.push(EVIDENCE_SUMMARY_SUPPRESSED_NOTICE);

  // ── 数组字段：opportunities / risks / vocAnalysis.<category>
  for (const field of tainted) {
    if (field === "summary") continue;
    if (dropped.has(field)) continue; // 已确认被剔除，未进入正式研报
    const path = parseArrayPath(field);
    if (!path) { markWholeField(field); continue; }
    const vocMatch = /^vocAnalysis\.([A-Za-z0-9_]+)$/u.exec(path.list);
    const persisted = vocMatch && isRecord(report.vocAnalysis)
      ? report.vocAnalysis[vocMatch[1]!]
      : report[path.list];
    if (!Array.isArray(persisted)) { markWholeField(path.list); continue; }
    const droppedBefore = [...dropped].filter((item) => {
      const other = parseArrayPath(item);
      return other !== null && other.list === path.list && other.index < path.index;
    }).length;
    const target = path.index - droppedBefore;
    if (!Number.isSafeInteger(target) || target < 0 || target >= persisted.length || !persistedArrayItemHasText(path.list, persisted[target])) {
      // 无法确定句子级映射（或该下标已无内容）→ 整块暂停展示该字段
      markWholeField(path.list);
      continue;
    }
    markSuppressed(path.list, target);
  }

  if (suppressedWholeFields.length > 0 && !notices.includes(EVIDENCE_BLOCK_SUPPRESSED_NOTICE)) {
    notices.push(EVIDENCE_BLOCK_SUPPRESSED_NOTICE);
  }

  const suppressedOpportunities = suppressedWholeFields.includes("opportunities")
    ? Array.from({ length: Array.isArray(report.opportunities) ? report.opportunities.length : 0 }, (_, index) => index)
    : [...(suppressedIndexes.get("opportunities") ?? [])].sort((a, b) => a - b);
  const suppressedRisks = suppressedWholeFields.includes("risks")
    ? Array.from({ length: Array.isArray(report.risks) ? report.risks.length : 0 }, (_, index) => index)
    : [...(suppressedIndexes.get("risks") ?? [])].sort((a, b) => a - b);

  const rawVoc = isRecord(report.vocAnalysis) ? report.vocAnalysis as Record<string, unknown> : {};
  const suppressedVoc: Record<string, number[]> = {};
  for (const category of VOC_CATEGORIES) {
    const key = `vocAnalysis.${category}`;
    const items = Array.isArray(rawVoc[category]) ? rawVoc[category] as unknown[] : [];
    if (suppressedWholeFields.includes(key)) {
      suppressedVoc[category] = Array.from({ length: items.length }, (_, index) => index);
      continue;
    }
    const indexes = suppressedIndexes.get(key);
    if (indexes && indexes.size) suppressedVoc[category] = [...indexes].sort((a, b) => a - b);
  }

  // P5-v6：结论强度超过证据的条目（销量估算当确认 / 样本代表性不足）同样暂停展示。
  // 比较时去掉全部空白：模型输出常带换行/多余空格，纯文本归一化会让同一句匹配不上。
  const squash = (value: string) => value.replace(/\s+/gu, "");
  const blocked = [...new Set((options?.strengthBlockedTexts ?? []).map((text) => squash(text)).filter(Boolean))];
  const strengthIndexesOf = (items: unknown): number[] => {
    if (!blocked.length || !Array.isArray(items)) return [];
    return items.flatMap((item, index) => {
      const value = typeof item === "string" ? item : isRecord(item) && typeof item.text === "string" ? item.text : null;
      if (!value) return [];
      const text = squash(value);
      if (!text) return [];
      const hit = blocked.some((candidate) => text === candidate || text.includes(candidate) || candidate.includes(text));
      return hit ? [index] : [];
    });
  };
  if (typeof report.summary === "string" && strengthIndexesOf([report.summary]).length) suppressedSummary = true;
  const strengthPainPoints = strengthIndexesOf(rawVoc.painPoints);
  if (strengthPainPoints.length) suppressedVoc.painPoints = [...new Set([...(suppressedVoc.painPoints ?? []), ...strengthPainPoints])].sort((a, b) => a - b);
  const strengthOpportunities = strengthIndexesOf(report.opportunities);
  const strengthRisks = strengthIndexesOf(report.risks);
  const mergedOpportunities = [...new Set([...suppressedOpportunities, ...strengthOpportunities])].sort((a, b) => a - b);
  const mergedRisks = [...new Set([...suppressedRisks, ...strengthRisks])].sort((a, b) => a - b);
  if (mergedOpportunities.length > suppressedOpportunities.length || mergedRisks.length > suppressedRisks.length || strengthPainPoints.length || (suppressedSummary && !summaryTainted)) {
    notices.push(EVIDENCE_STRENGTH_SUPPRESSED_NOTICE);
  }

  const suppressed = suppressedSummary
    || mergedOpportunities.length > 0
    || mergedRisks.length > 0
    || Object.values(suppressedVoc).some((indexes) => indexes.length > 0)
    || suppressedWholeFields.length > 0;

  const legacyUnsupportedCount = rejectedClaims.filter((claim) => claim.disposition === "retained_legacy_unsupported").length;
  const droppedCount = rejectedClaims.filter((claim) => claim.disposition === "rejected_whole_statement").length;
  const auditSummary = rejectedClaims.length === 0 ? null
    : legacyUnsupportedCount > 0
      ? `本研报有 ${legacyUnsupportedCount} 条陈述引用了证据白名单之外的来源，其支撑范围无法确认，已暂停展示。`
      : `本次 AI 生成过程中有 ${droppedCount} 条陈述因引用证据白名单之外来源被整条拒收，未进入正式研报。`;

  return {
    contaminated: suppressed || rejectedClaims.length > 0,
    suppressed,
    suppressedSummary,
    suppressedOpportunities: mergedOpportunities,
    suppressedRisks: mergedRisks,
    suppressedVoc,
    suppressedWholeFields,
    rejectedClaims,
    notices,
    auditSummary,
    strengthSuppressed: { opportunities: strengthOpportunities, risks: strengthRisks },
  };
}

function dropIndexes<T>(items: unknown, indexes: number[]): unknown {
  if (!Array.isArray(items) || indexes.length === 0) return items;
  const drop = new Set(indexes);
  return items.filter((_, index) => !drop.has(index));
}

/**
 * 产出可消费的安全投影。
 *
 * - 无需屏蔽时**原样返回同一对象**（保证 reportHash 语义不变、零回归）；
 * - 需要屏蔽时返回新对象：受影响陈述被移除，其余合法内容（机会点、风险、VOC、缺失清单、
 *   版本绑定字段）全部保留；并附加 `evidenceIntegrity` 供 UI / 下游展示原因。
 */
export function sanitizeReportForConsumption<T>(
  report: T,
  options?: { readonly strengthBlockedTexts?: readonly string[] },
): { report: T; integrity: ReportEvidenceIntegrity } {
  const integrity = assessReportEvidenceIntegrity(report, options);
  if (!isRecord(report) || !integrity.suppressed) return { report, integrity };

  const source = report as Record<string, unknown>;
  const cleanOpportunities = dropIndexes(source.opportunities, integrity.suppressedOpportunities);
  const cleanRisks = dropIndexes(source.risks, integrity.suppressedRisks);

  let cleanVoc = source.vocAnalysis;
  if (isRecord(source.vocAnalysis)) {
    const voc = source.vocAnalysis as Record<string, unknown>;
    cleanVoc = Object.fromEntries(Object.entries(voc).map(([category, items]) => (
      [category, dropIndexes(items, integrity.suppressedVoc[category] ?? [])]
    )));
  }

  const suppressedArrayIndexes = new Map<string, Set<number>>([
    ["opportunities", new Set(integrity.suppressedOpportunities)],
    ["risks", new Set(integrity.suppressedRisks)],
    ...Object.entries(integrity.suppressedVoc).map(([category, indexes]) => [`vocAnalysis.${category}`, new Set(indexes)] as const),
  ]);
  const wholeSuppressed = new Set(integrity.suppressedWholeFields);
  const cleanBindings = Array.isArray(source.narrativeBindings)
    ? source.narrativeBindings.filter((entry) => {
      if (!isRecord(entry) || typeof entry.field !== "string") return true;
      const field = entry.field;
      if (integrity.suppressedSummary && field === "summary") return false;
      for (const base of wholeSuppressed) {
        if (field === base || field.startsWith(`${base}[`)) return false;
      }
      const path = parseArrayPath(field);
      if (path && suppressedArrayIndexes.get(path.list)?.has(path.index)) return false;
      return true;
    }).map((entry) => {
      if (!isRecord(entry) || typeof entry.field !== "string") return entry;
      const path = parseArrayPath(entry.field);
      if (!path) return entry;
      const dropped = suppressedArrayIndexes.get(path.list);
      const shift = dropped ? [...dropped].filter(index => index < path.index).length : 0;
      return shift ? { ...entry, field: `${path.list}[${path.index - shift}]` } : entry;
    })
    : source.narrativeBindings;

  const sanitized: Record<string, unknown> = {
    ...source,
    summary: integrity.suppressedSummary ? null : source.summary,
    opportunities: cleanOpportunities,
    risks: cleanRisks,
    vocAnalysis: cleanVoc,
    narrativeBindings: cleanBindings,
    evidenceIntegrity: {
      schemaVersion: "research-report-evidence-integrity.v1",
      suppressed: true,
      suppressedSummary: integrity.suppressedSummary,
      suppressedOpportunities: integrity.suppressedOpportunities,
      suppressedRisks: integrity.suppressedRisks,
      suppressedVoc: integrity.suppressedVoc,
      suppressedWholeFields: integrity.suppressedWholeFields,
      rejectedClaims: integrity.rejectedClaims,
      notices: integrity.notices,
      auditSummary: integrity.auditSummary,
      /** 原始持久化内容与 reportHash 未被修改；此处仅为读侧投影。 */
      rawReportUnchanged: true,
    },
  };

  return { report: sanitized as T, integrity };
}
