import {
  isResearchReviewStale,
  isVerifiedNarrative,
  type ResearchDecision,
  type ResearchEvidenceRef,
  type ResearchExportRecord,
  type ResearchNarrative,
  type ResearchReport,
} from "./researchContracts";
import { decisionSummaryOf } from "./decisionSummary";
import { collectUnverifiedNarratives } from "./unverifiedNarratives";
import { auditResearchClaims } from "./evidenceAudit";

export const SALES_ESTIMATE_NOTICE = "【估算口径】月销量来自 monthlySalesEstimate，仅为来源估算，不是已确认销量，不能据此认定动销或开发价值。";

export type BuildResearchExportRecordInput = {
  readonly taskId: string;
  readonly candidateId: string;
  readonly report: ResearchReport;
  readonly reportHash: string;
  readonly decision?: ResearchDecision | null;
};

function textOf(value: { text: string | null } | null | undefined): string | null {
  const text = value?.text?.trim();
  return text || null;
}

/**
 * JEV-002：仅导出「已核实」的分析文本；无引用的文本单独走 unverifiedAssumptions。
 */
function verifiedTextOf(value: ResearchNarrative | null | undefined): string | null {
  return isVerifiedNarrative(value) ? textOf(value) : null;
}

function verifiedTextsOf(values: readonly ResearchNarrative[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((item) => verifiedTextOf(item)).filter((text): text is string => Boolean(text));
}

type CitationEntry = ResearchReport["citationIndex"][number];

/** 历史报告没有 source 字段：按旧语义一律视为事实字段引用。 */
function isFactEntry(entry: CitationEntry): boolean {
  return (entry.source ?? "fact") === "fact";
}

function unionRefIds(entries: readonly CitationEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    for (const ref of entry.evidenceRefs as readonly ResearchEvidenceRef[]) {
      if (typeof ref?.refId === "string" && ref.refId) ids.add(ref.refId);
    }
  }
  return ids;
}

/**
 * 纯函数：根据已保存的 ResearchReport、reportHash 与可选的 ResearchDecision 构建导出记录。
 *
 * 铁律：
 * 1. 所有字段必须直接来源于已保存报告的事实切片、决策摘要与人工作业记录。
 * 2. 严禁在此处调用任何大模型生成内容，严禁进行外部网络抓取，严禁修改原报告。
 * 3. JEV-002：没有可追溯引用的 AI 文本不得进入 summary / opportunity / risks，
 *    只能进入 research.unverifiedAssumptions 作为提示。
 * 4. RESEARCH-001：人工复核必须带 reviewedReportHash，并按当前报告 hash 标注是否过期。
 * 5. RESEARCH-002：citationCount 表示整份报告的引用数量（事实 ∪ narrative，按 refId 去重）。
 */
export function buildResearchExportRecord(
  input: BuildResearchExportRecordInput,
): ResearchExportRecord {
  const { taskId, candidateId, report, reportHash, decision } = input;
  const basic = report.facts.basic;
  const market = report.facts.market;
  const decisionSummary = decisionSummaryOf(report);

  const citationIndex: readonly CitationEntry[] = Array.isArray(report.citationIndex)
    ? report.citationIndex
    : [];
  const factRefIds = unionRefIds(citationIndex.filter(isFactEntry));
  const narrativeRefIds = unionRefIds(citationIndex.filter((entry) => !isFactEntry(entry)));
  const allRefIds = new Set<string>([...factRefIds, ...narrativeRefIds]);

  const unverifiedAssumptions = collectUnverifiedNarratives(report);
  // 对保存的原文重新作只读审查，引用合法不能把估算升级为确认结论。
  // monthlySalesEstimate 即使旧报告缺 metricNature，仍只能是估算。
  const summaryText = verifiedTextOf(report.executiveSummary?.analysis);
  const opportunityText = verifiedTextOf(report.marketOpportunity?.analysis);
  const riskTexts = verifiedTextsOf(report.riskAssessment?.risks);
  const audit = auditResearchClaims({
    summary: summaryText,
    opportunities: [summaryText ?? "", opportunityText ?? ""],
    risks: riskTexts,
    painPoints: (report.vocAnalysis?.painPoints ?? []).map((pain) => ({
      text: pain.text ?? "",
      evidenceRefs: pain.evidenceRefs.map((ref) => ref.refId),
    })),
    salesGrade: market.monthlySalesEstimate.status === "present" && market.monthlySalesEstimate.value !== null
      ? "ESTIMATED" : "NOT_AVAILABLE",
    reviewBase: basic.reviewCount.value ?? null,
  });
  const safeText = (text: string | null, field: "opportunities" | "risks", index: number): string | null => {
    if (audit.verdict === "UNAVAILABLE") return null;
    const flags = audit.flags.filter((flag) => flag.field === field && flag.index === index);
    if (flags.some((flag) => flag.severity === "BLOCKING")) return null;
    return text && flags.length ? `【待复核，不能作为已确认结论】${text}` : text;
  };
  const auditNotices = audit.verdict === "UNAVAILABLE"
    ? ["【证据审查不可用·暂停采信】无法核验证据强度，不输出确认性研究结论。"]
    : audit.flags.map((flag) => `【证据审查·${flag.severity === "BLOCKING" ? "暂停采信" : "待复核"}】${flag.reason} ${flag.suggested}`);
  for (const flag of audit.flags) {
    unverifiedAssumptions.push(`【证据审查·待人工复核原文】${flag.text}（${flag.reason}）`);
  }
  // 只导出真的带验证动作的原因；没有动作的原因不占位，避免制造「已验证」的错觉。
  const causalVerification = (report.competitionInsight?.causalInvestigations ?? [])
    .map((cause) => ({
      hypothesis: cause.hypothesis?.text ?? null,
      confidence: cause.confidence,
      actions: [...(cause.verification ?? [])],
    }))
    .filter((item) => item.actions.length > 0);
  const risks = [...riskTexts.map((text, index) => safeText(text, "risks", index)).filter((text): text is string => text !== null), ...auditNotices,
    ...(market.monthlySalesEstimate.value !== null ? [SALES_ESTIMATE_NOTICE] : [])];

  const humanDecision = decision
    ? {
        status: decision.status,
        nextAction: decision.nextAction,
        notes: decision.notes,
        reviewedReportHash: decision.reviewedReportHash ?? null,
        reviewStale: isResearchReviewStale(decision, reportHash) || audit.verdict === "BLOCKED" || audit.verdict === "UNAVAILABLE",
      }
    : null;

  return {
    taskId,
    candidateId,
    subjectKey: report.subjectKey,
    product: {
      asin: basic.asin.value ?? null,
      title: basic.title.value ?? null,
      image: basic.image.value ?? null,
      category: basic.category.value ?? null,
    },
    market: {
      price: basic.price.value
        ? {
            amount: basic.price.value.amount,
            currency: basic.price.value.currency,
          }
        : null,
      sales: market.monthlySalesEstimate.value ?? null,
      bsr: market.bsr.value ?? null,
    },
    research: {
      summary: safeText(summaryText, "opportunities", 0),
      priority: decisionSummary.researchPriority,
      opportunity: safeText(opportunityText, "opportunities", 1),
      risks,
      unverifiedAssumptions,
      causalVerification,
    },
    humanDecision,
    evidence: {
      claimAuditVerdict: audit.verdict,
      ...(report.audit ? { auditStatus: report.audit.status } : {}),
      reportHash,
      generatedAt: report.generatedAt,
      citationCount: allRefIds.size,
      factCitationCount: factRefIds.size,
      narrativeCitationCount: narrativeRefIds.size,
      unverifiedAssumptionCount: unverifiedAssumptions.length,
    },
  };
}
