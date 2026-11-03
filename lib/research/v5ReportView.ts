/**
 * v5 综合研报的只读展示投影（用于 03 改良假设 + 04 决策摘要）。
 *
 * 为什么需要它：`research-report.v1`（深度研报）有 `competitionInsight.causalInvestigations`
 * 这一层原因假设；`research-report.v5`（当前主线综合研报）**没有**这一层，只有
 * summary / opportunities / risks / vocAnalysis.painPoints / citations / unverifiedAssumptions。
 * 而 03 此前只在 v1 为权威时渲染改良假设卡，于是主线 v5 任务看不到任何内容。
 *
 * 硬边界：
 *  - 纯函数、只读投影：不写库、不调用模型、不改 reportHash / 权威判定；
 *  - 只搬运已持久化文本与引用，缺的字段如实列进 `missingFacts`，不补造、不拼接其他报告；
 *  - 不把「已采集 / 已持久化」当作「已确认」，不把估算当事实。
 */

export type V5ReportNarrative = {
  readonly text: string;
  /** 该行自己的来源引用；空数组表示这一行没有带引用（不得当成已确认）。 */
  readonly evidenceRefs: readonly string[];
};

export type V5ReportView = {
  readonly schema: "research-report-view.v5";
  readonly source: "v5";
  readonly reportHash: string;
  readonly researchRevision: number | null;
  readonly authoritative: boolean;
  readonly summary: V5ReportNarrative | null;
  readonly painPoints: readonly V5ReportNarrative[];
  readonly failureModes: readonly V5ReportNarrative[];
  readonly useCases: readonly V5ReportNarrative[];
  readonly opportunities: readonly V5ReportNarrative[];
  readonly risks: readonly V5ReportNarrative[];
  readonly unverifiedAssumptions: readonly string[];
  readonly citationCount: number;
  readonly allowedEvidenceRefCount: number;
  /** v5 契约是否包含逐项原因假设层。当前恒为 false；为 true 时说明契约已升级。 */
  readonly hasCausalLayer: boolean;
  /** 改良假设所需、但本契约缺失的字段（如实列出，供 UI 明确降级说明）。 */
  readonly missingFacts: readonly string[];
  readonly evidenceBoundary: string;
  /**
   * 证据强度审查（服务端读侧计算，确定性，不调用模型）。
   * 历史报告不改原文，只在读侧给出「哪句结论超过证据」的提示。
   */
  readonly claimAudit?: import("./evidenceAudit").ResearchClaimAudit | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value.trim() : null;
  if (isRecord(value) && typeof value.text === "string" && value.text.trim()) return value.text.trim();
  return null;
}

function refIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item.trim()];
    if (isRecord(item) && typeof item.refId === "string" && item.refId.trim()) return [item.refId.trim()];
    return [];
  });
}

/** 叙事行可能是纯字符串，也可能是 {text, evidenceRefs}；两种都保留引用，不合并来源。 */
function narrativesOf(value: unknown, limit = 20): V5ReportNarrative[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const text = textOf(item);
    if (!text) return [];
    return [{ text: text.slice(0, 2_000), evidenceRefs: refIdsOf(isRecord(item) ? item.evidenceRefs : null) }];
  }).slice(0, limit);
}

function stringsOf(value: unknown, limit = 40): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const text = typeof item === "string" ? item.trim() : null;
    return text ? [text.slice(0, 2_000)] : [];
  }).slice(0, limit);
}

/**
 * 改良假设需要的五类字段与在 v5 契约中的对应位置。
 * `present` 只按真实结构判断，不做「应该有」的推断。
 */
const CAUSAL_FACT_PROBES: readonly { readonly label: string; readonly present: (report: Record<string, unknown>) => boolean }[] = [
  { label: "原因假设（competitionInsight.causalInvestigations）", present: (report) => Array.isArray((report.competitionInsight as Record<string, unknown> | undefined)?.causalInvestigations) },
  { label: "假设提出理由（causalInvestigations[].rationale）", present: (report) => causalList(report).some((item) => Boolean(item.rationale)) },
  { label: "逐条支持线索（causalInvestigations[].supportingEvidence）", present: (report) => causalList(report).some((item) => Array.isArray(item.supportingEvidence) && item.supportingEvidence.length > 0) },
  { label: "逐条反证线索（causalInvestigations[].counterevidence）", present: (report) => causalList(report).some((item) => Array.isArray(item.counterevidence) && item.counterevidence.length > 0) },
  { label: "逐条未知事项（causalInvestigations[].unknowns）", present: (report) => causalList(report).some((item) => Array.isArray(item.unknowns) && item.unknowns.length > 0) },
  { label: "验证动作（causalInvestigations[].verification / verificationItems）", present: (report) => causalList(report).some((item) => Array.isArray(item.verification) && item.verification.length > 0) || Array.isArray((report.competitionInsight as Record<string, unknown> | undefined)?.verificationItems) },
];

function causalList(report: Record<string, unknown>): Record<string, unknown>[] {
  const list = (report.competitionInsight as Record<string, unknown> | undefined)?.causalInvestigations;
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

export function buildV5ReportView(
  report: unknown,
  meta: { readonly reportHash: string; readonly researchRevision: number | null },
): V5ReportView | null {
  if (!isRecord(report)) return null;
  const voc = isRecord(report.vocAnalysis) ? report.vocAnalysis : {};
  const missingFacts = CAUSAL_FACT_PROBES.filter((probe) => !probe.present(report)).map((probe) => probe.label);
  return {
    schema: "research-report-view.v5",
    source: "v5",
    reportHash: meta.reportHash,
    researchRevision: meta.researchRevision,
    authoritative: true,
    summary: (() => {
      const text = textOf(report.summary);
      if (!text) return null;
      const binding = Array.isArray(report.narrativeBindings)
        ? report.narrativeBindings.filter(isRecord).find((row) => row.field === "summary")
        : undefined;
      return { text: text.slice(0, 4_000), evidenceRefs: refIdsOf(binding?.evidenceRefs) };
    })(),
    painPoints: narrativesOf(voc.painPoints),
    failureModes: narrativesOf(voc.failureModes),
    useCases: narrativesOf(voc.useCases),
    opportunities: narrativesOf(report.opportunities),
    risks: narrativesOf(report.risks),
    unverifiedAssumptions: stringsOf(report.unverifiedAssumptions),
    citationCount: Array.isArray(report.citations) ? report.citations.length : 0,
    allowedEvidenceRefCount: Array.isArray(report.allowedEvidenceRefs) ? report.allowedEvidenceRefs.length : 0,
    hasCausalLayer: missingFacts.length < CAUSAL_FACT_PROBES.length,
    missingFacts,
    evidenceBoundary:
      "以上为已持久化的研究陈述与引用；已采集不等于已确认，估算值不等于真实值，未带引用的行只能作为待核实观察。",
  };
}

/** 把 v5 的产品问题陈述转成改良假设的输入（只取有引用的痛点，其余如实标注无引用）。 */
export function observationsFromV5View(view: V5ReportView): { statement: string; evidenceRefs: readonly string[] }[] {
  return view.painPoints.map((pain) => ({ statement: pain.text, evidenceRefs: pain.evidenceRefs }));
}
