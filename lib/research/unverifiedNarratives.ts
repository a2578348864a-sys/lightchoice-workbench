import {
  isVerifiedNarrative,
  formatResearchNarrative,
  type ResearchNarrative,
  type ResearchReport,
} from "./researchContracts";

/** 单份报告最多收集的未验证假设条数（够用于提示，不构成第二份报告）。 */
export const MAX_UNVERIFIED_NARRATIVES = 40;

/**
 * JEV-002：收集一份报告中所有「有文本、但没有任何可追溯证据引用」的 AI 内容。
 *
 * - 新报告：引擎已把这类内容从分析字段移出，集中到 report.unverifiedAssumptions；
 * - 历史报告：分析字段里可能仍留有缺引用的内联文本，这里一并收集，
 *   保证它们既不会被当作研究结论使用，也不会被静默丢弃。
 *
 * 纯函数、无副作用、不依赖任何服务端能力，客户端可直接调用。
 */
export function collectUnverifiedNarratives(report: ResearchReport): string[] {
  const collected: string[] = [];

  const push = (value: ResearchNarrative | null | undefined) => {
    if (!value) return;
    if (isVerifiedNarrative(value)) return;
    const text = formatResearchNarrative(value);
    if (text) collected.push(text);
  };

  const sectionAnalyses: readonly (ResearchNarrative | null | undefined)[] = [
    report.executiveSummary?.analysis,
    report.marketOpportunity?.analysis,
    report.competitionInsight?.analysis,
    report.vocAnalysis?.analysis,
    report.unitEconomics?.analysis,
    report.supplyChain?.analysis,
    report.riskAssessment?.analysis,
  ];
  sectionAnalyses.forEach(push);
  (report.executiveSummary?.keyPoints ?? []).forEach(push);
  (report.competitionInsight?.differentiationSuggestions ?? []).forEach(push);
  (report.vocAnalysis?.painPoints ?? []).forEach(push);
  (report.riskAssessment?.risks ?? []).forEach(push);
  (report.unverifiedAssumptions ?? []).forEach(push);
  for (const cause of report.competitionInsight?.causalHypotheses ?? []) {
    if (cause.text) collected.push(`【待验证原因假设】${formatResearchNarrative(cause)}`);
  }
  for (const cause of report.competitionInsight?.causalInvestigations ?? []) {
    collected.push(`【待验证原因假设】${formatResearchNarrative(cause.hypothesis) ?? "原因未知"}`);
    push(cause.rationale);
    cause.supportingEvidence.forEach(push);
    cause.counterevidence.forEach(push);
  }

  const seen = new Set<string>();
  const output: string[] = [];
  for (const text of collected) {
    if (seen.has(text)) continue;
    seen.add(text);
    output.push(text);
    if (output.length >= MAX_UNVERIFIED_NARRATIVES) break;
  }
  return output;
}
