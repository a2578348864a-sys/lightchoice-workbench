/** Read models only. These projections never change a fact, decision or frozen metric. */
import type { ReviewCountCaliber } from "./reviewCountCaliber";
export type MarketCitation = {
  id: string; subjectKey: string; evidenceId: string; contentHash: string;
  version: number | null; capturedAt: string; sourceUrl: string | null; nature: string;
};
export type MarketIntelligenceSample = {
  asin: string; subjectKey: string; title: string | null; brand: string | null;
  price: number | null; priceCurrency: string | null; rating: number | null;
  reviewCount: number | null; monthlySalesEstimate: number | null; bsr: number | null;
  valid: boolean; evidence: MarketCitation;
  brandEvidence?: MarketCitation;
  /** 评论量是否可复核；`reviewCount` 本身保持锁定值，不被替换。 */
  reviewCountCaliber?: ReviewCountCaliber;
};
export type SupplementarySource = {
  module: string; label: string; subjectKey: string; scope: "product" | "query";
  status: "available" | "partial" | "blocked" | "unusable";
  freshness?: "fresh" | "stale" | "unknown";
  reason: string; limitations: readonly string[]; evidence: MarketCitation;
};
export type KeywordSignal = {
  keyword: string; subjectKey: string; module: string; searchVolume: number | null;
  /** Source-declared data time when the provider exposes it; capture time stays in evidence. */
  observedAt?: string | null;
  metrics: Record<string, { value: number | null; unit: string; metricNature: string }>;
  evidence: MarketCitation;
};
/**
 * 关键词证据的两种语义，必须分开统计与展示：
 * - market_keyword_demand：以**研究关键词**为查询对象的相关词需求（种子词挖掘）。
 * - competitor_traffic_keyword：以**明确 ASIN** 为查询对象的竞品流量词（ASIN 反查）。
 * 两者都叫「关键词」，但不是同一数据集：不相加、不跨主体去重、不混成一个分母。
 */
export type MarketKeywordCategory = "market_keyword_demand" | "competitor_traffic_keyword";
export function marketKeywordCategory(module: string): MarketKeywordCategory | null {
  if (module === "reverse_asin") return "competitor_traffic_keyword";
  if (module === "keyword_mining_trend" || module === "keyword_mining" || module === "keyword_evidence") return "market_keyword_demand";
  return null;
}
export const MARKET_KEYWORD_CATEGORY_LABELS: Record<MarketKeywordCategory, string> = {
  market_keyword_demand: "市场关键词需求",
  competitor_traffic_keyword: "竞品流量关键词",
};
export type MarketIntelligence = {
  schema: "market-intelligence.v1"; scanId: string; scanName: string; marketplace: string;
  resourceVersion: string; sampleHash: string; inputHash: string; observedAt: string;
  samples: MarketIntelligenceSample[]; sources: SupplementarySource[];
  keywords: KeywordSignal[];
  productMarkets: Array<{ subjectKey: string; rows: readonly import("@/lib/sourceLayer/sellerSpriteSupplementProjection").SellerSpriteQueryProduct[]; evidence: MarketCitation }>;
  productSignals: Array<{ subjectKey: string; metrics: readonly { metric: string; value: number; unit: string; metricNature: string; currency?: string }[]; evidence: MarketCitation }>;
  trends: Array<{ subjectKey: string; field: string; points: Array<{ date: string; value: number }>; evidence: MarketCitation }>;
  reviews: Array<{ id?: string; subjectKey: string; subjectKeys?: string[]; title: string | null; text: string; rating: number | null; evidence: MarketCitation }>;
  variations: Array<{ subjectKey: string; parentAsin: string | null; members: readonly string[]; outcome: string; evidence: MarketCitation }>;
  category: { subjectKey: string; capturedAt: string; sourceUrl: string; batchId: string; evidence: MarketCitation; rows: readonly { segment: string; metrics: readonly { key: string; label: string; value: number | null; usableForMetrics: boolean; nature: string; unit: string }[] }[] } | null;
  queryBindings: string[];
  bindingCandidates: Array<{ subjectKey: string; module: string; label: string }>;
  evidenceChanges: string[];
  limitations: string[];
  provider: { ready: boolean; code: string; message: string };
  reports: MarketIntelligenceReport[];
  /** Reports persisted but rejected by the strict reader. Never silently treated as "never generated". */
  reportReadIssues?: Array<{ id: string; reason: string }>;
  statistics?: import("./researchStatistics").ResearchStatistics;
  scope?: { hash: string; excluded: string[]; applied: string[] | null; changed: boolean; pending: number };
  translations?: Record<string, { text: string; originalHash: string; model: string; generatedAt: string }>;
  research?: { keyword: string | null; sourceBatchId: string | null; captureEnabled: boolean };
  aiOperations?: Array<{ id: string; operation: string; status: string; updatedAt: string; recoverable: boolean }>;
  recoverableReport?: { id: string; inputHash: string; generatedAt: string; model: string; comparisonSubjects: string[]; reason: string; stale: boolean };
  productDetails?: Array<{ subjectKey: string; facts: import("@/lib/server/research/researchDetailFactProjection").ResearchDetailFactProjection; evidence: MarketCitation; supplementalEvidence?: MarketCitation[] }>;
};
export type MarketReportPoint = {
  text: string; nature: "fact" | "estimate" | "calculation" | "inference" | "unknown"; citations: string[];
};
export const MARKET_REPORT_SECTIONS = ["overview", "competition", "demand", "voice", "comparison"] as const;
export type MarketReportSection = typeof MARKET_REPORT_SECTIONS[number];
/** Overview is expressed by judgment/findings/risks/opportunities/actions; the other four workspaces have their own block. */
export const MARKET_REPORT_WORKSPACES = ["competition", "demand", "voice", "comparison"] as const;
export const MARKET_REPORT_V3_SCHEMA = "market-intelligence-report.v3";
export const MARKET_REPORT_V3_PROMPT_VERSION = "market-report.opportunities.v3.2";
export type MarketVoiceTheme = {
  id?: string; label: string; sentiment: "negative" | "positive" | "mixed"; statement: MarketReportPoint;
  reviewIds: string[]; reviewCount: number; productCount: number;
  scenario: string; hypothesis: string; improvement: string; verification: string[];
};
/** Structured report fields. Only v3 uses them; v1/v2 stay readable with their original generic points. */
export type MarketReportJudgment = {
  text: string; canJudge: string; cannotJudge: string; nature: MarketReportPoint["nature"]; citations: string[];
};
export type MarketReportFinding = {
  title: string; what: string; why: string; basis: string; limits: string[];
  section: MarketReportSection; nature: MarketReportPoint["nature"]; citations: string[];
};
export type MarketReportRisk = {
  title: string; text: string; gap: string; impact: string;
  nature: MarketReportPoint["nature"]; citations: string[];
};
export type MarketReportOpportunity = {
  title: string; buyerProblem: string; scenario: string; hypothesis: string;
  unverified: string[]; citations: string[];
  id?: string;
  counterEvidence?: string[];
  rejectionConditions?: string[];
  developmentConstraints?: string[];
};
export type MarketResearchRecommendation = {
  subjectKey: string; opportunityIds: string[]; role: "benchmark" | "newcomer" | "pain_point";
  rationale: string; researchQuestions: string[]; citations: string[];
};
export type MarketRecommendationDecision = {
  status: "recommend" | "insufficient" | "do_not_continue"; reason: string; citations: string[];
};
export type MarketReportAction = {
  question: string; neededEvidence: string; howToVerify: string; doneWhen: string; citations: string[];
};
export type MarketWorkspaceReport = {
  status: "assessed" | "insufficient"; reason: string; summary: MarketReportPoint; limits: string[];
};
export type MarketComparisonDifference = { dimension: string; text: string; citations: string[] };
export type MarketComparisonItem = {
  subjectKey: string; advantages: string[]; limitations: string[]; unknowns: string[]; citations: string[];
};
export type MarketReviewResult = {
  reviewId: string; status: "themed" | "no_match" | "unable"; themeIds: string[];
};
export type MarketVoiceCoverage = {
  available: number; sampled: number; themed: number; noMatch: number; unable: number;
  sampledProducts: number; lowStarSampled: number; samplePolicy: string;
};
export type MarketIntelligenceReport = {
  schema: "market-intelligence-report.v1" | "market-intelligence-report.v2" | "market-intelligence-report.v3";
  id: string; inputHash: string;
  generatedAt: string; model: string; summary: MarketReportPoint;
  opportunities: MarketReportPoint[]; risks: MarketReportPoint[]; unknowns: MarketReportPoint[]; actions: MarketReportPoint[];
  sections?: Record<MarketReportSection, MarketReportPoint[]>;
  voiceThemes?: MarketVoiceTheme[];
  comparisonSubjects?: string[];
  promptVersion?: string;
  configuredModel?: string;
  inputManifest?: { evidence: MarketCitation[]; reviewIds: string[]; keywordRows: Array<{subjectKey:string;keyword:string;evidenceId:string}> };
  usage?: { completionTokens: number | null; elapsedMs: number; finishReason: string | null };
  analysisCoverage?: { statisticsHash: string; samples: number; reviewsRead: number; reviewsAvailable: number; keywordsRead: number; keywordsAvailable: number; modules: string[]; policy: string };
  /** v3: structured, user-readable findings with explicit limits. */
  judgment?: MarketReportJudgment;
  findings?: MarketReportFinding[];
  riskGaps?: MarketReportRisk[];
  productOpportunities?: MarketReportOpportunity[];
  recommendationDecision?: MarketRecommendationDecision;
  researchRecommendations?: MarketResearchRecommendation[];
  nextActions?: MarketReportAction[];
  workspaces?: Partial<Record<MarketReportSection, MarketWorkspaceReport>>;
  comparisonItems?: MarketComparisonItem[];
  comparisonDifferences?: MarketComparisonDifference[];
  reviewResults?: MarketReviewResult[];
  voiceCoverage?: MarketVoiceCoverage;
  /** v3 input binding: every input evidence identity/hash, plus full citations for evidence actually used. */
  inputEvidenceIndex?: Array<{ id: string; contentHash: string }>;
  citedEvidence?: MarketCitation[];
};

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const REPORT_NATURES = ["fact", "estimate", "calculation", "inference", "unknown"] as const;
type ReportNature = typeof REPORT_NATURES[number];

function normalizeReportNature(value: unknown): ReportNature | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if ((REPORT_NATURES as readonly string[]).includes(raw)) return raw as ReportNature;
  if (raw === "source_observed" || raw === "provider_observed" || raw === "observed") return "fact";
  if (raw === "provider_estimate" || raw === "estimated") return "estimate";
  if (raw === "calculated") return "calculation";
  if (raw === "inferred") return "inference";
  return null;
}

function normalizeReportSection(value: unknown): MarketReportSection | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if ((MARKET_REPORT_SECTIONS as readonly string[]).includes(raw)) return raw as MarketReportSection;
  if (raw === "market") return "competition";
  if (raw === "keywords" || raw === "keyword") return "demand";
  if (raw === "voc" || raw === "reviews" || raw === "review") return "voice";
  if (raw === "products" || raw === "product") return "comparison";
  return null;
}

function reportText(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error("MARKET_AI_OUTPUT_INVALID");
  const trimmed = value.trim();
  if ((!allowEmpty && !trimmed) || trimmed.length > max) throw new Error("MARKET_AI_OUTPUT_INVALID");
  return trimmed;
}

function reportTextList(value: unknown, maxItems: number, maxLength: number, minItems = 0): string[] {
  if (minItems === 0 && (value === undefined || value === null)) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      if (minItems > 0) throw new Error("MARKET_AI_OUTPUT_INVALID");
      return [];
    }
    return [reportText(trimmed, maxLength)];
  }
  if (!Array.isArray(value) || value.length > maxItems || value.length < minItems) throw new Error("MARKET_AI_OUTPUT_INVALID");
  return value.map((entry) => reportText(entry, maxLength));
}

function reportCitations(
  value: unknown,
  allowedRefs: ReadonlySet<string>,
  max = 60,
  min = 0,
  refResolver?: ReadonlyMap<string, string>,
): string[] {
  if (min === 0 && (value === undefined || value === null)) return [];
  if (!Array.isArray(value) || value.length > max || value.length < min) throw new Error("MARKET_AI_OUTPUT_INVALID");
  const citations = value.map((ref) => {
    if (typeof ref !== "string") throw new Error("MARKET_AI_OUTPUT_INVALID");
    const trimmed = ref.trim();
    const resolved = allowedRefs.has(trimmed)
      ? trimmed
      : (refResolver?.get(trimmed) ?? refResolver?.get(trimmed.toUpperCase()));
    if (!resolved || !allowedRefs.has(resolved)) throw new Error("MARKET_AI_OUTPUT_INVALID");
    return resolved;
  });
  return [...new Set(citations)];
}

function reportPoint(
  value: unknown,
  allowedRefs: ReadonlySet<string>,
  maxLength = 2000,
  refResolver?: ReadonlyMap<string, string>,
): MarketReportPoint {
  const p = record(value);
  const nature = normalizeReportNature(p.nature);
  if (typeof p.text !== "string" || !p.text.trim() || p.text.length > maxLength
    || !nature
    || (p.citations !== undefined && p.citations !== null && (!Array.isArray(p.citations) || p.citations.length > 60))) {
    throw new Error("MARKET_AI_OUTPUT_INVALID");
  }
  const citations = reportCitations(p.citations ?? [], allowedRefs, 60, 0, refResolver);
  if (nature !== "unknown" && citations.length === 0) throw new Error("MARKET_AI_OUTPUT_INVALID");
  return { text: p.text.trim(), nature, citations };
}

function reportPointList(value: unknown, allowedRefs: ReadonlySet<string>) {
  if (!Array.isArray(value) || value.length > 12) throw new Error("MARKET_AI_OUTPUT_INVALID");
  return value.map((entry) => reportPoint(entry, allowedRefs));
}

type ReportValidationContext = {
  reviews: MarketIntelligence["reviews"];
  comparisonSubjects: string[];
  /** v3 model output uses short R1..Rn aliases so 60 review results stay inside the output budget. */
  reviewAliases?: Map<string, MarketIntelligence["reviews"][number]>;
  /** Exact alias resolver for model outputs that cite R1, review.id, or evidenceId without hash suffix. */
  refResolver?: ReadonlyMap<string, string>;
  formalSubjects?: string[];
  requireRecommendations?: boolean;
  subjectEvidence?: ReadonlyMap<string, ReadonlySet<string>>;
};

function validateV3ReviewResults(
  raw: unknown,
  themes: MarketVoiceTheme[],
  context: ReportValidationContext | undefined,
): MarketReviewResult[] {
  const themeIds = new Set(themes.map((theme) => theme.id!));
  const results: MarketReviewResult[] = [];
  if (context?.reviewAliases) {
    const aliases = context.reviewAliases;
    const object = record(raw);
    const normalized = new Map<string, unknown>();
    for (const [rawKey, entry] of Object.entries(object)) {
      const key = rawKey.trim().toUpperCase();
      if (!/^R\d{1,3}$/u.test(key) || normalized.has(key)) throw new Error("MARKET_AI_REVIEW_COVERAGE_INVALID");
      normalized.set(key, entry);
    }
    if (normalized.size !== aliases.size || [...normalized.keys()].some((key) => !aliases.has(key))) throw new Error("MARKET_AI_REVIEW_COVERAGE_INVALID");
    for (const [alias, review] of aliases) {
      if (!review.id) throw new Error("MARKET_AI_REVIEW_COVERAGE_INVALID");
      const entry = normalized.get(alias);
      if (entry === null) {
        results.push({ reviewId: review.id, status: "unable", themeIds: [] });
        continue;
      }
      if (!Array.isArray(entry) || entry.length > 5 || entry.some((id) => typeof id !== "string" || !themeIds.has(id.trim().toLowerCase()))) throw new Error("MARKET_AI_REVIEW_COVERAGE_INVALID");
      const ids = [...new Set((entry as string[]).map((id) => id.trim().toLowerCase()))];
      results.push({ reviewId: review.id, status: ids.length ? "themed" : "no_match", themeIds: ids });
    }
    // Reconcile theme.reviewRefs and reviewResults so representative subsets in voiceThemes and full 60-review tags stay 100% consistent.
    const resultByReviewId = new Map(results.map((r) => [r.reviewId, r]));
    const reviewById = new Map(context.reviews.filter((review) => review.id).map((review) => [review.id!, review]));
    for (const theme of themes) {
      const tid = theme.id!;
      const fromResults = results.filter((r) => r.themeIds.includes(tid)).map((r) => r.reviewId);
      const nonUnableFromTheme = theme.reviewIds.filter((id) => resultByReviewId.get(id)?.status !== "unable");
      const merged = [...new Set([...(nonUnableFromTheme.length || fromResults.length ? nonUnableFromTheme : theme.reviewIds), ...fromResults])];
      theme.reviewIds = merged;
      for (const reviewId of merged) {
        const row = resultByReviewId.get(reviewId);
        if (row && !row.themeIds.includes(tid)) {
          row.themeIds.push(tid);
          row.status = "themed";
        }
        const evId = reviewById.get(reviewId)?.evidence.id;
        if (evId && !theme.statement.citations.includes(evId)) {
          theme.statement.citations.push(evId);
        }
      }
    }
  } else {
    if (!Array.isArray(raw)) throw new Error("MARKET_AI_REVIEW_COVERAGE_INVALID");
    const seen = new Set<string>();
    for (const entry of raw) {
      const row = record(entry);
      const reviewId = reportText(row.reviewId, 200);
      if (seen.has(reviewId)) throw new Error("MARKET_AI_REVIEW_COVERAGE_INVALID");
      seen.add(reviewId);
      const status = String(row.status);
      if (!["themed", "no_match", "unable"].includes(status)) throw new Error("MARKET_AI_REVIEW_COVERAGE_INVALID");
      const ids = reportTextList(row.themeIds, 5, 20);
      const unique = [...new Set(ids)];
      if (unique.some((id) => !themeIds.has(id))) throw new Error("MARKET_AI_REVIEW_COVERAGE_INVALID");
      if ((status === "themed") !== (unique.length > 0)) throw new Error("MARKET_AI_REVIEW_COVERAGE_INVALID");
      results.push({ reviewId, status: status as MarketReviewResult["status"], themeIds: unique });
    }
  }
  // Every theme must be supported by at least one classified review; counts are always computed here.
  for (const theme of themes) {
    const supporting = results.filter((result) => result.themeIds.includes(theme.id!));
    const expected = new Set(theme.reviewIds);
    if (!supporting.length || supporting.length !== expected.size || supporting.some((result) => !expected.has(result.reviewId))) throw new Error("MARKET_AI_VOICE_INVALID");
    theme.reviewCount = supporting.length;
  }
  return results;
}

/** Every factual/estimated/analytical assertion must cite the exact input revision. */
export function validateMarketReport(value: unknown, allowedRefs: ReadonlySet<string>, context?: ReportValidationContext): Omit<MarketIntelligenceReport, "id" | "inputHash" | "generatedAt" | "model"> {
  const raw = record(value);
  const refResolver = context?.refResolver;
  if (raw.schema === MARKET_REPORT_V3_SCHEMA) {
    const judgmentRaw = record(raw.judgment);
    const judgmentNature = normalizeReportNature(judgmentRaw.nature);
    if (!judgmentNature) throw new Error("MARKET_AI_OUTPUT_INVALID");
    const judgmentCitations = reportCitations(judgmentRaw.citations, allowedRefs, 60, 0, refResolver);
    if (judgmentNature !== "unknown" && judgmentCitations.length === 0) throw new Error("MARKET_AI_OUTPUT_INVALID");
    const judgment: MarketReportJudgment = {
      text: reportText(judgmentRaw.text, 2000),
      canJudge: reportText(judgmentRaw.canJudge, 1200),
      cannotJudge: reportText(judgmentRaw.cannotJudge, 1200),
      nature: judgmentNature,
      citations: judgmentCitations,
    };

    if (!Array.isArray(raw.findings) || raw.findings.length > 8) throw new Error("MARKET_AI_FINDINGS_INVALID");
    const findings: MarketReportFinding[] = raw.findings.map((entry) => {
      const finding = record(entry);
      const nature = normalizeReportNature(finding.nature);
      const section = normalizeReportSection(finding.section);
      if (!nature || !section) throw new Error("MARKET_AI_FINDINGS_INVALID");
      const citations = reportCitations(finding.citations, allowedRefs, 60, 0, refResolver);
      if (nature !== "unknown" && citations.length === 0) throw new Error("MARKET_AI_FINDINGS_INVALID");
      return {
        title: reportText(finding.title, 120),
        what: reportText(finding.what, 1000),
        why: reportText(finding.why, 1000),
        basis: reportText(finding.basis, 1000),
        limits: reportTextList(finding.limits, 6, 400, 0),
        section,
        nature,
        citations,
      };
    });

    if (!Array.isArray(raw.riskGaps) || raw.riskGaps.length > 6) throw new Error("MARKET_AI_RISKS_INVALID");
    const riskGaps: MarketReportRisk[] = raw.riskGaps.map((entry) => {
      const risk = record(entry);
      const rawNature = normalizeReportNature(risk.nature);
      if (!rawNature) throw new Error("MARKET_AI_RISKS_INVALID");
      const citations = reportCitations(risk.citations, allowedRefs, 60, 0, refResolver);
      const nature: ReportNature = citations.length === 0 ? "unknown" : rawNature;
      return {
        title: reportText(risk.title, 120),
        text: reportText(risk.text, 800),
        gap: reportText(risk.gap, 800),
        impact: reportText(risk.impact, 800),
        nature,
        citations,
      };
    });

    if (!Array.isArray(raw.productOpportunities) || raw.productOpportunities.length > 6) throw new Error("MARKET_AI_OPPORTUNITIES_INVALID");
    const productOpportunities: MarketReportOpportunity[] = raw.productOpportunities.map((entry) => {
      const opportunity = record(entry);
      return {
        title: reportText(opportunity.title, 120),
        buyerProblem: reportText(opportunity.buyerProblem, 1000),
        scenario: reportText(opportunity.scenario, 1000),
        hypothesis: reportText(opportunity.hypothesis, 1000),
        unverified: reportTextList(opportunity.unverified, 6, 400, 0),
        citations: reportCitations(opportunity.citations, allowedRefs, 60, context?.requireRecommendations ? 1 : context?.reviewAliases ? 0 : 1, refResolver),
        ...(opportunity.id !== undefined ? {
          id: reportText(opportunity.id, 40),
          counterEvidence: reportTextList(opportunity.counterEvidence, 5, 400, 0),
          rejectionConditions: reportTextList(opportunity.rejectionConditions, 5, 400, 1),
          developmentConstraints: reportTextList(opportunity.developmentConstraints, 5, 400, 1),
        } : {}),
      };
    });

    let recommendationDecision: MarketRecommendationDecision | undefined;
    let researchRecommendations: MarketResearchRecommendation[] | undefined;
    if (context?.requireRecommendations || raw.recommendationDecision !== undefined || raw.researchRecommendations !== undefined) {
      const decision = record(raw.recommendationDecision);
      if (!["recommend", "insufficient", "do_not_continue"].includes(String(decision.status))) throw new Error("MARKET_AI_RECOMMENDATIONS_INVALID");
      recommendationDecision = {
        status: decision.status as MarketRecommendationDecision["status"],
        reason: reportText(decision.reason, 800),
        citations: reportCitations(decision.citations, allowedRefs, 30, decision.status === "insufficient" ? 0 : 1, refResolver),
      };
      const ids = productOpportunities.map((opportunity) => opportunity.id);
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error("MARKET_AI_RECOMMENDATIONS_INVALID");
      if (!Array.isArray(raw.researchRecommendations) || raw.researchRecommendations.length > 50) throw new Error("MARKET_AI_RECOMMENDATIONS_INVALID");
      researchRecommendations = raw.researchRecommendations.map((entry) => {
        const item = record(entry);
        const subjectKey = reportText(item.subjectKey, 100);
        if (!/^amazon:US:[A-Z0-9]{10}$/u.test(subjectKey) || (context?.formalSubjects && !context.formalSubjects.includes(subjectKey))) throw new Error("MARKET_AI_RECOMMENDATION_OUTSIDE_SCOPE");
        if (!["benchmark", "newcomer", "pain_point"].includes(String(item.role))) throw new Error("MARKET_AI_RECOMMENDATIONS_INVALID");
        const opportunityIds = reportTextList(item.opportunityIds, 6, 40, 1);
        if (new Set(opportunityIds).size !== opportunityIds.length || opportunityIds.some((id) => !ids.includes(id))) throw new Error("MARKET_AI_RECOMMENDATIONS_INVALID");
        const citations = reportCitations(item.citations, allowedRefs, 30, 1, refResolver);
        if (context?.subjectEvidence && !citations.some((id) => context.subjectEvidence!.get(subjectKey)?.has(id))) throw new Error("MARKET_AI_RECOMMENDATION_EVIDENCE_MISMATCH");
        return {
          subjectKey, opportunityIds, role: item.role as MarketResearchRecommendation["role"],
          rationale: reportText(item.rationale, 800),
          researchQuestions: reportTextList(item.researchQuestions, 5, 500, 1),
          citations,
        };
      });
      if (new Set(researchRecommendations.map((item) => item.subjectKey)).size !== researchRecommendations.length
        || (recommendationDecision.status === "recommend" ? researchRecommendations.length === 0 : researchRecommendations.length !== 0)) throw new Error("MARKET_AI_RECOMMENDATIONS_INVALID");
    }

    if (!Array.isArray(raw.nextActions) || raw.nextActions.length > 8) throw new Error("MARKET_AI_ACTIONS_INVALID");
    const nextActions: MarketReportAction[] = raw.nextActions.map((entry) => {
      const action = record(entry);
      return {
        question: reportText(action.question, 800),
        neededEvidence: reportText(action.neededEvidence, 800),
        howToVerify: reportText(action.howToVerify, 800),
        doneWhen: reportText(action.doneWhen, 800),
        citations: reportCitations(action.citations, allowedRefs, 20, 0, refResolver),
      };
    });

    const workspaceRaw = record(raw.workspaces);
    const workspaces: Partial<Record<MarketReportSection, MarketWorkspaceReport>> = {};
    for (const key of MARKET_REPORT_WORKSPACES) {
      const block = record(workspaceRaw[key]);
      const status = String(block.status);
      if (status !== "assessed" && status !== "insufficient") throw new Error("MARKET_AI_WORKSPACE_INVALID");
      const rawReason = typeof block.reason === "string" ? block.reason.trim() : "";
      if (status === "insufficient" && !rawReason) throw new Error("MARKET_AI_WORKSPACE_INVALID");
      let summary: MarketReportPoint;
      if (status === "insufficient") {
        const s = record(block.summary);
        const sCitations = reportCitations(s.citations ?? [], allowedRefs, 60, 0, refResolver);
        const sText = typeof s.text === "string" && s.text.trim() ? s.text.trim() : rawReason;
        const sNature = sCitations.length > 0 ? (normalizeReportNature(s.nature) ?? "unknown") : "unknown";
        summary = { text: reportText(sText, 1200), nature: sNature, citations: sCitations };
      } else {
        summary = reportPoint(block.summary, allowedRefs, 1200, refResolver);
        if (!summary.text) throw new Error("MARKET_AI_WORKSPACE_INVALID");
      }
      const reason = status === "insufficient" ? reportText(rawReason, 800) : rawReason.slice(0, 800);
      workspaces[key] = { status, reason, summary, limits: reportTextList(block.limits, 6, 400, 0) };
    }

    const comparisonSubjects = context?.comparisonSubjects ?? (Array.isArray(raw.comparisonSubjects) ? raw.comparisonSubjects.filter((subject): subject is string => typeof subject === "string") : []);
    if (comparisonSubjects.length > 3 || new Set(comparisonSubjects).size !== comparisonSubjects.length) throw new Error("MARKET_AI_COMPARISON_INVALID");
    if (!Array.isArray(raw.comparisonItems) || raw.comparisonItems.length > 3) throw new Error("MARKET_AI_COMPARISON_INVALID");
    const comparisonItems: MarketComparisonItem[] = raw.comparisonItems.map((entry) => {
      const item = record(entry);
      let subjectKey = reportText(item.subjectKey, 120);
      if (comparisonSubjects.length && !comparisonSubjects.includes(subjectKey)) {
        const asinMatch = comparisonSubjects.filter((s) => s.endsWith(`:${subjectKey}`));
        if (asinMatch.length === 1) subjectKey = asinMatch[0];
        else throw new Error("MARKET_AI_COMPARISON_INVALID");
      }
      return {
        subjectKey,
        advantages: reportTextList(item.advantages, 6, 600, 0),
        limitations: reportTextList(item.limitations, 6, 600, 0),
        unknowns: reportTextList(item.unknowns, 6, 600, 0),
        citations: reportCitations(item.citations, allowedRefs, 20, 0, refResolver),
      };
    });
    if (new Set(comparisonItems.map((item) => item.subjectKey)).size !== comparisonItems.length) throw new Error("MARKET_AI_COMPARISON_INVALID");
    if (comparisonSubjects.length && comparisonItems.length !== comparisonSubjects.length) throw new Error("MARKET_AI_COMPARISON_INVALID");
    if (!comparisonSubjects.length && comparisonItems.length) throw new Error("MARKET_AI_COMPARISON_INVALID");
    if (!Array.isArray(raw.comparisonDifferences) || raw.comparisonDifferences.length > 8) throw new Error("MARKET_AI_COMPARISON_INVALID");
    const comparisonDifferences: MarketComparisonDifference[] = raw.comparisonDifferences.map((entry) => {
      const difference = record(entry);
      return {
        dimension: reportText(difference.dimension, 80),
        text: reportText(difference.text, 800),
        citations: reportCitations(difference.citations, allowedRefs, 20, 0, refResolver),
      };
    });

    if (!Array.isArray(raw.voiceThemes) || raw.voiceThemes.length > 5) throw new Error("MARKET_AI_VOICE_INVALID");
    const aliasMap = context?.reviewAliases;
    const themes: MarketVoiceTheme[] = raw.voiceThemes.map((entry) => {
      const theme = record(entry);
      const id = reportText(theme.id, 8).toLowerCase();
      if (!/^t[1-5]$/u.test(id) || !["negative", "positive", "mixed"].includes(String(theme.sentiment))
        || !Array.isArray(theme.reviewRefs) && !Array.isArray(theme.reviewIds)) throw new Error("MARKET_AI_VOICE_INVALID");
      const storedIds = aliasMap ? null : theme.reviewIds;
      const ids = aliasMap
        ? (theme.reviewRefs as unknown[]).map((ref) => {
            if (typeof ref !== "string" || !aliasMap.has(ref.trim().toUpperCase())) throw new Error("MARKET_AI_VOICE_INVALID");
            const review = aliasMap.get(ref.trim().toUpperCase())!;
            if (!review.id) throw new Error("MARKET_AI_VOICE_INVALID");
            return review.id;
          })
        : (Array.isArray(storedIds) ? storedIds : []).map((id) => reportText(id, 200));
      const uniqueIds = [...new Set(ids)];
      if (!uniqueIds.length || uniqueIds.length > 60) throw new Error("MARKET_AI_VOICE_INVALID");
      const rawStatement = record(theme.statement);
      if (aliasMap && context) {
        const reviewById = new Map(context.reviews.filter((review) => review.id).map((review) => [review.id!, review]));
        const autoCitations = uniqueIds.map((rid) => reviewById.get(rid)?.evidence.id).filter((cid): cid is string => Boolean(cid));
        const existingCitations = Array.isArray(rawStatement.citations) ? rawStatement.citations : [];
        rawStatement.citations = [...existingCitations, ...autoCitations];
      }
      const statement = reportPoint(rawStatement, allowedRefs, 1200, refResolver);
      if (aliasMap && context) {
        const reviewById = new Map(context.reviews.filter((review) => review.id).map((review) => [review.id!, review]));
        if (uniqueIds.some((rid) => !statement.citations.includes(reviewById.get(rid)!.evidence.id))) throw new Error("MARKET_AI_VOICE_CITATION_INVALID");
      }
      if (!aliasMap && (theme.reviewCount !== uniqueIds.length || !Number.isSafeInteger(theme.productCount) || Number(theme.productCount) < 1)) {
        throw new Error("MARKET_AI_VOICE_INVALID");
      }
      const rawVerification = reportTextList(theme.verification, 6, 500, aliasMap ? 0 : 1);
      const verification = rawVerification.length ? rawVerification : [reportText(theme.improvement || theme.hypothesis || "结合后续评论与样品核验", 500)];
      return {
        id,
        label: reportText(theme.label, 80),
        sentiment: theme.sentiment as MarketVoiceTheme["sentiment"],
        statement,
        reviewIds: uniqueIds,
        reviewCount: uniqueIds.length,
        productCount: aliasMap ? 1 : Number(theme.productCount),
        scenario: reportText(theme.scenario, 800),
        hypothesis: reportText(theme.hypothesis, 800),
        improvement: reportText(theme.improvement, 800),
        verification,
      };
    });
    if (new Set(themes.map((theme) => theme.id)).size !== themes.length) throw new Error("MARKET_AI_VOICE_INVALID");
    const reviewResults = validateV3ReviewResults(raw.reviewResults, themes, context);
    if (context?.reviews?.length) {
      const reviewById = new Map(context.reviews.filter((review) => review.id).map((review) => [review.id!, review]));
      for (const theme of themes) {
        const subjects = new Set(theme.reviewIds.flatMap((id) => reviewById.get(id)?.subjectKeys ?? (reviewById.get(id) ? [reviewById.get(id)!.subjectKey] : [])));
        if (subjects.size > 0) theme.productCount = subjects.size;
      }
    }
    if (!context?.reviewAliases) {
      // A stored v3 report must carry its own coverage and keep theme counts internally consistent.
      if (raw.voiceCoverage === undefined) throw new Error("MARKET_AI_VOICE_INVALID");
      const coverage = record(raw.voiceCoverage);
      const numbers = ["available", "sampled", "themed", "noMatch", "unable", "sampledProducts", "lowStarSampled"].map((key) => Number(coverage[key]));
      if (numbers.some((number) => !Number.isSafeInteger(number) || number < 0)) throw new Error("MARKET_AI_VOICE_INVALID");
      const [available, sampled, themed, noMatch, unable] = numbers;
      if (sampled !== reviewResults.length || themed !== reviewResults.filter((result) => result.status === "themed").length
        || noMatch !== reviewResults.filter((result) => result.status === "unable" ? false : result.status === "no_match").length
        || unable !== reviewResults.filter((result) => result.status === "unable").length || available < sampled) throw new Error("MARKET_AI_VOICE_INVALID");
      const manifestReviewIds = Array.isArray(record(raw.inputManifest).reviewIds) ? (record(raw.inputManifest).reviewIds as unknown[]) : null;
      if (manifestReviewIds) {
        const manifest = new Set(manifestReviewIds.filter((id): id is string => typeof id === "string"));
        if (manifest.size !== reviewResults.length || reviewResults.some((result) => !manifest.has(result.reviewId))) throw new Error("MARKET_AI_REVIEW_COVERAGE_INVALID");
      }
    }

    return {
      schema: MARKET_REPORT_V3_SCHEMA,
      summary: { text: judgment.text, nature: judgment.nature, citations: judgment.citations },
      opportunities: [], risks: [], unknowns: [], actions: [],
      judgment, findings, riskGaps, productOpportunities, nextActions, workspaces,
      ...(recommendationDecision ? { recommendationDecision, researchRecommendations } : {}),
      comparisonSubjects, comparisonItems, comparisonDifferences,
      voiceThemes: themes, reviewResults,
      promptVersion: recommendationDecision ? MARKET_REPORT_V3_PROMPT_VERSION : "market-report.v3",
    };
  }
  const point = reportPoint;
  const list = (value: unknown) => reportPointList(value, allowedRefs);
  if (raw.schema === "market-intelligence-report.v2") {
    const sections = Object.fromEntries(MARKET_REPORT_SECTIONS.map((key) => {
      const points = list(record(raw.sections)[key]);
      if (!points.length) throw new Error("MARKET_AI_SECTION_MISSING");
      return [key, points];
    })) as Record<MarketReportSection, MarketReportPoint[]>;
    if (!Array.isArray(raw.voiceThemes) || raw.voiceThemes.length > 8) throw new Error("MARKET_AI_VOICE_INVALID");
    const smallText = (v: unknown) => typeof v === "string" && v.length <= 800 ? v.trim() : "";
    const reviews = new Map(context?.reviews.filter((r) => r.id).map((r) => [r.id!, r]));
    const voiceThemes: MarketVoiceTheme[] = raw.voiceThemes.map((entry) => {
      const theme = record(entry);
      if (!smallText(theme.label) || !["negative", "positive", "mixed"].includes(String(theme.sentiment)) || !Array.isArray(theme.reviewIds) || !theme.reviewIds.length || theme.reviewIds.length > 60 || theme.reviewIds.some((id) => typeof id !== "string" || (context && !reviews.has(id))) || !Array.isArray(theme.verification) || theme.verification.length > 8 || theme.verification.some((v) => !smallText(v))) throw new Error("MARKET_AI_VOICE_INVALID");
      const ids = [...new Set(theme.reviewIds as string[])];
      const subjects = new Set(ids.flatMap((id) => reviews.get(id)?.subjectKeys ?? (reviews.get(id) ? [reviews.get(id)!.subjectKey] : [])));
      const statement = point(theme.statement, allowedRefs);
      if (context && ids.some((id) => !statement.citations.includes(reviews.get(id)!.evidence.id))) throw new Error("MARKET_AI_VOICE_CITATION_INVALID");
      if (!context && (theme.reviewCount !== ids.length || !Number.isSafeInteger(theme.productCount) || Number(theme.productCount) < 1)) throw new Error("MARKET_AI_VOICE_INVALID");
      return { label: smallText(theme.label), sentiment: theme.sentiment as MarketVoiceTheme["sentiment"], statement, reviewIds: ids, reviewCount: ids.length, productCount: context ? subjects.size : Number(theme.productCount), scenario: smallText(theme.scenario), hypothesis: smallText(theme.hypothesis), improvement: smallText(theme.improvement), verification: theme.verification.map(smallText) };
    });
    return { schema: raw.schema, summary: sections.overview[0], opportunities: [], risks: [], unknowns: [], actions: [], sections, voiceThemes, comparisonSubjects: context?.comparisonSubjects ?? (Array.isArray(raw.comparisonSubjects) ? raw.comparisonSubjects.filter((v): v is string => typeof v === "string") : []), promptVersion: "market-five-sections.v2" };
  }
  if (raw.schema !== "market-intelligence-report.v1") throw new Error("MARKET_AI_OUTPUT_INVALID");
  return { schema: raw.schema, summary: point(raw.summary, allowedRefs), opportunities: list(raw.opportunities), risks: list(raw.risks), unknowns: list(raw.unknowns), actions: list(raw.actions) };
}

/** Collect every evidence reference a stored report claims, so the reader validates against exactly those identities. */
export function collectReportCitations(value: unknown): Set<string> {
  const citations = new Set<string>();
  const add = (refs: unknown) => {
    if (Array.isArray(refs)) for (const ref of refs) if (typeof ref === "string") citations.add(ref);
  };
  const addPoint = (entry: unknown) => {
    const point = record(entry);
    add(point.citations);
  };
  const raw = record(value);
  addPoint(raw.summary);
  for (const list of [raw.opportunities, raw.risks, raw.unknowns, raw.actions, ...Object.values(record(raw.sections))]) {
    if (Array.isArray(list)) list.forEach(addPoint);
  }
  if (Array.isArray(raw.voiceThemes)) for (const theme of raw.voiceThemes) addPoint(record(theme).statement);
  if (raw.judgment) addPoint(raw.judgment);
  if (raw.recommendationDecision) addPoint(raw.recommendationDecision);
  for (const list of [raw.findings, raw.riskGaps, raw.productOpportunities, raw.researchRecommendations, raw.nextActions, raw.comparisonItems, raw.comparisonDifferences]) {
    if (Array.isArray(list)) for (const entry of list) add(record(entry).citations);
  }
  const workspaces = record(raw.workspaces);
  for (const key of Object.keys(workspaces)) addPoint(record(workspaces[key]).summary);
  if (Array.isArray(raw.citedEvidence)) for (const entry of raw.citedEvidence) {
    if (typeof record(entry).id === "string") citations.add(String(record(entry).id));
  }
  return citations;
}

export function distribution(values: readonly number[], edges: readonly number[]) {
  return edges.map((edge, i) => ({ label: i === edges.length - 1 ? `≥ ${edge}` : `${edge}–${edges[i + 1]}`, count: values.filter((value) => value >= edge && (i === edges.length - 1 || value < edges[i + 1])).length }));
}
