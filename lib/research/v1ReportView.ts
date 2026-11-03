import { formatResearchNarrative, type ResearchNarrative, type ResearchReport } from "@/lib/research/researchContracts";

/**
 * P2-04 / P3-01-B 读侧：v1 正式研报的只读展示投影。
 *
 * 为什么需要它：v1 研报（`/api/tasks/[id]/research-v1` 写入根节点 `researchReport`）
 * 与 v5 研报（`v5Research.report`）形状不同。v5 缺失时，03 页面此前会显示
 * 「尚无正式研报」，与已保存的 v1 研报和人工决定自相矛盾。
 *
 * 硬边界：
 *  - 只读投影，不回写、不改 reportHash / researchRevision / stale 判定；
 *  - 不参与任何门禁计算，也不替代人工决定；
 *  - 只搬运已持久化内容，未验证文本按原样标注，不新增事实或推断。
 */
export type V1ReportCausalInvestigation = {
  readonly hypothesis: string;
  /** 该原因是否带可追溯证据引用；false 表示只能作为待验证方向。 */
  readonly hypothesisVerified: boolean;
  readonly rationale: string | null;
  readonly supportingEvidence: readonly string[];
  readonly counterevidence: readonly string[];
  readonly unknowns: readonly string[];
  readonly confidence: "low" | "medium" | "high" | "unknown";
  readonly verification: readonly string[];
};

export type V1ReportView = {
  readonly auditStatus?: "complete" | "incomplete";
  readonly schema: "research-report-view.v1";
  readonly source: "v1";
  readonly reportHash: string;
  readonly generatedAt: string;
  /**
   * 该报告是否记录了生成时的事实/证据绑定。
   * unbound = 历史 v1 报告无法判断时效，界面必须显示「时效未知」而不是「有效」。
   */
  readonly bindingStatus: "bound" | "unbound";
  /**
   * 是否为当前权威报告。false = 存在另一份报告且权威未确定，
   * 此时只能作为「另一份历史报告」阅读，不得标注为「报告有效」。
   */
  readonly authoritative: boolean;
  readonly generationStatus: string | null;
  readonly summary: string | null;
  readonly keyPoints: readonly string[];
  readonly marketOpportunity: string | null;
  readonly competitionAnalysis: string | null;
  readonly differentiationSuggestions: readonly string[];
  readonly causalHypotheses: readonly string[];
  readonly causalInvestigations: readonly V1ReportCausalInvestigation[];
  readonly alternatives: readonly string[];
  readonly supportingEvidence: readonly string[];
  readonly counterevidence: readonly string[];
  readonly verificationItems: readonly string[];
  readonly vocAnalysis: string | null;
  readonly painPoints: readonly string[];
  readonly riskAnalysis: string | null;
  readonly risks: readonly string[];
  readonly riskVerificationItems: readonly string[];
  readonly unitEconomicsAnalysis: string | null;
  readonly supplyChainAnalysis: string | null;
  readonly unverifiedAssumptions: readonly string[];
};

function textOf(value: ResearchNarrative | null | undefined): string | null {
  return formatResearchNarrative(value);
}

function textsOf(values: readonly ResearchNarrative[] | null | undefined): string[] {
  return (values ?? []).flatMap((value) => {
    const text = textOf(value);
    return text ? [text] : [];
  });
}

export function buildV1ReportView(report: ResearchReport, meta: { reportHash: string; generatedAt: string; bindingStatus?: "bound" | "unbound" }): V1ReportView {
  const competition = report.competitionInsight;
  const risk = report.riskAssessment;
  const voc = report.vocAnalysis;
  return {
    schema: "research-report-view.v1",
    ...(report.audit ? { auditStatus: report.audit.status } : {}),
    source: "v1",
    reportHash: meta.reportHash,
    generatedAt: meta.generatedAt,
    bindingStatus: meta.bindingStatus ?? "unbound",
    authoritative: true,
    generationStatus: typeof report.generationStatus === "string" ? report.generationStatus : null,
    summary: textOf(report.executiveSummary.analysis),
    keyPoints: textsOf(report.executiveSummary.keyPoints),
    marketOpportunity: textOf(report.marketOpportunity.analysis),
    competitionAnalysis: textOf(competition.analysis),
    differentiationSuggestions: textsOf(competition.differentiationSuggestions),
    causalHypotheses: textsOf(competition.causalHypotheses).map((text) => `【待验证原因假设】${text}`),
    causalInvestigations: (competition.causalInvestigations ?? []).map((item) => ({
      hypothesis: item.hypothesis.text ? `【待验证原因假设】${textOf(item.hypothesis)}` : "",
      hypothesisVerified: false,
      rationale: textOf(item.rationale),
      supportingEvidence: textsOf(item.supportingEvidence),
      counterevidence: textsOf(item.counterevidence),
      unknowns: (item.unknowns ?? []).filter((value) => typeof value === "string" && value.trim().length > 0),
      confidence: item.confidence,
      verification: (item.verification ?? []).filter((value) => typeof value === "string" && value.trim().length > 0),
    })).filter((item) => item.hypothesis.length > 0 || item.unknowns.length > 0),
    alternatives: textsOf(competition.alternatives),
    supportingEvidence: textsOf(competition.supportingEvidence),
    counterevidence: textsOf(competition.counterevidence),
    verificationItems: textsOf(competition.verificationItems),
    vocAnalysis: textOf(voc.analysis),
    painPoints: textsOf(voc.painPoints),
    riskAnalysis: textOf(risk.analysis),
    risks: textsOf(risk.risks),
    riskVerificationItems: textsOf(risk.verificationItems),
    unitEconomicsAnalysis: textOf(report.unitEconomics.analysis),
    supplyChainAnalysis: textOf(report.supplyChain.analysis),
    unverifiedAssumptions: textsOf(report.unverifiedAssumptions),
  };
}
