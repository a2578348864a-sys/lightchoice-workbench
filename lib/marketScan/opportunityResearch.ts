import type { MarketCitation, MarketIntelligenceReport, MarketReportOpportunity, MarketResearchRecommendation } from "./intelligence";

/** A human-adopted research brief, stored in existing representative/provenance JSON. Never ProductFact. */
export type OpportunityResearchSelection = { reportId: string; inputHash: string; opportunityIds: string[] };
export type OpportunityResearchSnapshot = {
  schema: "market-opportunity-research.v1";
  reportId: string; inputHash: string; generatedAt: string; subjectKey: string;
  recommendation: MarketResearchRecommendation;
  opportunities: MarketReportOpportunity[];
  evidence: MarketCitation[];
};

export function readOpportunityResearchSnapshot(value: unknown): OpportunityResearchSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as OpportunityResearchSnapshot;
  const texts = (items: unknown): items is string[] => Array.isArray(items) && items.every((item) => typeof item === "string");
  if (raw.schema !== "market-opportunity-research.v1" || typeof raw.reportId !== "string" || typeof raw.inputHash !== "string"
    || typeof raw.generatedAt !== "string" || typeof raw.subjectKey !== "string" || !raw.recommendation
    || raw.recommendation.subjectKey !== raw.subjectKey || typeof raw.recommendation.rationale !== "string"
    || !texts(raw.recommendation.researchQuestions) || !texts(raw.recommendation.opportunityIds) || !texts(raw.recommendation.citations)
    || !Array.isArray(raw.opportunities) || !raw.opportunities.every((item) => item && typeof item.title === "string"
      && typeof item.hypothesis === "string" && typeof item.buyerProblem === "string" && typeof item.scenario === "string"
      && texts(item.unverified) && texts(item.citations) && (item.counterEvidence === undefined || texts(item.counterEvidence))
      && (item.rejectionConditions === undefined || texts(item.rejectionConditions)) && (item.developmentConstraints === undefined || texts(item.developmentConstraints)))
    || !Array.isArray(raw.evidence) || !raw.evidence.every((item) => item && typeof item.id === "string" && typeof item.contentHash === "string")) return undefined;
  return raw;
}

export function buildOpportunityResearchSnapshot(
  report: MarketIntelligenceReport,
  subjectKey: string,
  selection: OpportunityResearchSelection,
  currentInputHash: string,
): OpportunityResearchSnapshot {
  if (selection.reportId !== report.id || selection.inputHash !== report.inputHash || report.inputHash !== currentInputHash) throw new Error("MARKET_RECOMMENDATION_STALE");
  const recommendation = report.researchRecommendations?.find((item) => item.subjectKey === subjectKey);
  if (!recommendation || !Array.isArray(selection.opportunityIds) || !selection.opportunityIds.length
    || new Set(selection.opportunityIds).size !== selection.opportunityIds.length
    || selection.opportunityIds.some((id) => !recommendation.opportunityIds.includes(id))) throw new Error("MARKET_RECOMMENDATION_INVALID");
  const opportunities = (report.productOpportunities ?? []).filter((item) => item.id && selection.opportunityIds.includes(item.id));
  if (opportunities.length !== selection.opportunityIds.length) throw new Error("MARKET_RECOMMENDATION_INVALID");
  const citations = new Set([...recommendation.citations, ...opportunities.flatMap((item) => item.citations)]);
  const evidence = (report.citedEvidence ?? report.inputManifest?.evidence ?? []).filter((item) => citations.has(item.id));
  if ([...citations].some((id) => !evidence.some((item) => item.id === id))) throw new Error("MARKET_RECOMMENDATION_EVIDENCE_MISSING");
  const snapshot: OpportunityResearchSnapshot = {
    schema: "market-opportunity-research.v1", reportId: report.id, inputHash: report.inputHash,
    generatedAt: report.generatedAt, subjectKey,
    recommendation: { ...recommendation, opportunityIds: [...selection.opportunityIds] },
    opportunities, evidence,
  };
  return structuredClone(snapshot);
}

/** Draft text is editable. The immutable research context is independently checked server-side on save. */
export function recommendationDraftNote(report: MarketIntelligenceReport, recommendation: MarketResearchRecommendation): string {
  const titles = (report.productOpportunities ?? []).filter((item) => item.id && recommendation.opportunityIds.includes(item.id)).map((item) => item.title);
  return `研究机会：${titles.join("；")}\n选择理由：${recommendation.rationale}\n03 待验证：${recommendation.researchQuestions.join("；")}`.slice(0, 1000);
}
