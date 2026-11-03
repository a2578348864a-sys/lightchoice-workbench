import type {
  MarketMetricsV1,
  NicheDefinitionV1,
  SampleDefinitionV1,
} from "@/lib/marketScan/types";
import type { RepresentativeSelectionSet } from "@/lib/marketOpportunity/representatives";
import type {
  ProductConceptHumanDecision,
  ProductConceptSnapshot,
  ProductProjectSync,
} from "@/lib/marketOpportunity/concept";

export const MARKET_OPPORTUNITY_SCHEMA = "market-opportunity.v1" as const;
export const MARKET_OPPORTUNITY_NICHE_SCHEMA = "market-opportunity-niche.v1" as const;
export const MARKET_OPPORTUNITY_ANALYSIS_SCHEMA = "market-opportunity-analysis.v1" as const;
export const MARKET_OPPORTUNITY_AI_SCHEMA = "market-opportunity-ai.v1" as const;
export const MARKET_OPPORTUNITY_EXPORT_SCHEMA = "opportunity-export.v1" as const;

export const MARKET_OPPORTUNITY_OWNER_SCOPE = "owner:v1" as const;

export const ANALYSIS_STATUSES = ["DRAFT", "READY", "FAILED"] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const AI_STATUSES = ["NOT_REQUESTED", "RUNNING", "READY", "FAILED"] as const;
export type AiStatus = (typeof AI_STATUSES)[number];

export const HUMAN_DECISIONS = ["UNREVIEWED", "CONTINUE", "WATCH", "NEED_DATA", "DROP"] as const;
export type HumanDecisionStatus = (typeof HUMAN_DECISIONS)[number];

export const LARK_SYNC_STATUSES = ["NOT_SYNCED", "SYNCED", "FAILED"] as const;
export type LarkSyncStatus = (typeof LARK_SYNC_STATUSES)[number];

export type MarketOpportunityNicheDefinition = Omit<NicheDefinitionV1, "schemaVersion"> & {
  readonly schemaVersion: typeof MARKET_OPPORTUNITY_NICHE_SCHEMA;
};

export type MarketOpportunityScanRef = {
  readonly scanId: string;
  readonly sampleHash: string;
  readonly metricsVersion: string;
  readonly sampleCount: number;
  readonly createdAt: string;
};

export type MarketOpportunityComparisonReason =
  | "marketplace_mismatch"
  | "niche_definition_mismatch"
  | "sample_definition_mismatch"
  | "metrics_version_mismatch"
  | "metric_missing";

export type MarketOpportunityDelta = number | null;

export type MarketOpportunityComparison = {
  readonly status: "COMPARABLE" | "INSUFFICIENT_DATA";
  readonly fromScanId: string;
  readonly toScanId: string;
  readonly reasons: readonly MarketOpportunityComparisonReason[];
  readonly priceMedianDelta: MarketOpportunityDelta;
  readonly knownSalesDelta: MarketOpportunityDelta;
  readonly knownRevenueDelta: MarketOpportunityDelta;
  readonly cr5Delta: MarketOpportunityDelta;
  readonly brandCountDelta: MarketOpportunityDelta;
  readonly ratingDelta: MarketOpportunityDelta;
  readonly reviewBarrierDelta: MarketOpportunityDelta;
};

export type MarketOpportunityAnalysisSnapshot = {
  readonly schemaVersion: typeof MARKET_OPPORTUNITY_ANALYSIS_SCHEMA;
  readonly status: AnalysisStatus;
  readonly latestScanId: string;
  readonly scanRef: MarketOpportunityScanRef;
  readonly sampleDefinition: SampleDefinitionV1;
  readonly metrics: MarketMetricsV1;
  readonly comparison: MarketOpportunityComparison | null;
  readonly missingEvidence: readonly string[];
  readonly generatedAt: string;
};

export type MarketOpportunityFactRef = {
  readonly path: string;
  readonly source: "market_scan_metrics" | "market_scan_sample" | "scan_comparison" | "coverage";
  readonly scanId: string;
};

export type MarketOpportunityAiInterpretation = {
  readonly schemaVersion: typeof MARKET_OPPORTUNITY_AI_SCHEMA;
  readonly status: AiStatus;
  readonly summary: string | null;
  readonly observations: readonly string[];
  readonly risks: readonly string[];
  readonly missingEvidence: readonly string[];
  readonly questionsToValidate: readonly string[];
  readonly suggestedNextStep: string | null;
  readonly factRefs: readonly MarketOpportunityFactRef[];
  readonly generatedAt: string | null;
  readonly model: string | null;
  readonly errorCode?: string;
};

export type MarketOpportunityHumanDecision = {
  readonly status: HumanDecisionStatus;
  readonly reason: string | null;
  readonly nextAction: string | null;
  readonly decidedAt: string | null;
  readonly revision: number;
};

export type OpportunityExportRecord = {
  readonly schemaVersion: typeof MARKET_OPPORTUNITY_EXPORT_SCHEMA;
  readonly opportunityId: string;
  readonly name: string;
  readonly marketplace: string;
  readonly nicheKind: string;
  readonly latestScanId: string;
  readonly sampleCount: number;
  readonly metricsSummary: Readonly<Record<string, unknown>>;
  readonly humanDecision: HumanDecisionStatus;
  readonly decisionReason: string | null;
  readonly opportunityUrl: string;
  readonly exportedAt: string;
};

export type MarketOpportunityLarkSync = {
  readonly status: LarkSyncStatus;
  readonly exportContractVersion: typeof MARKET_OPPORTUNITY_EXPORT_SCHEMA;
  readonly opportunityId: string | null;
  readonly tableId: string | null;
  readonly recordId: string | null;
  readonly viewUrl: string | null;
  readonly syncedAt: string | null;
  readonly idempotencyKey: string | null;
  readonly errorCode?: string;
};

export type MarketOpportunityRecordView = {
  readonly id: string;
  readonly ownerScope: string;
  readonly schemaVersion: typeof MARKET_OPPORTUNITY_SCHEMA;
  readonly name: string;
  readonly marketplace: string;
  readonly nicheKind: string;
  readonly nicheDefinition: MarketOpportunityNicheDefinition;
  readonly latestMarketScanId: string;
  readonly scanRefs: readonly MarketOpportunityScanRef[];
  readonly analysisSnapshot: MarketOpportunityAnalysisSnapshot;
  readonly aiInterpretation: MarketOpportunityAiInterpretation | null;
  readonly humanDecision: MarketOpportunityHumanDecision | null;
  readonly larkSync: MarketOpportunityLarkSync;
  readonly representativeSet: RepresentativeSelectionSet;
  readonly conceptSnapshot: ProductConceptSnapshot | null;
  readonly conceptProjectSync: ProductProjectSync;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type { ProductConceptHumanDecision, ProductConceptSnapshot, ProductProjectSync, RepresentativeSelectionSet };
