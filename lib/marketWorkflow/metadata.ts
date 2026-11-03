import type { MarketScanSampleItemV1 } from "@/lib/marketScan/types";

export const MARKET_WORKFLOW_METADATA_SCHEMA = "market-workflow.v1" as const;

export const MARKET_GATE_STATUSES = [
  "PENDING",
  "PROCEED",
  "VALIDATE_MORE",
  "PAUSE",
  "DROP",
] as const;

export type MarketGateStatus = (typeof MARKET_GATE_STATUSES)[number];

export const REPRESENTATIVE_ROLES = ["benchmark", "newcomer", "pain_point"] as const;
export type RepresentativeRole = (typeof REPRESENTATIVE_ROLES)[number];

export type MarketRepresentative = {
  readonly marketSampleKey: string;
  readonly asin: string;
  readonly subjectKey: string;
  readonly role: RepresentativeRole;
  readonly note: string | null;
  readonly selectedAt: string;
  readonly selectedBy: string;
  readonly researchContext?: OpportunityResearchSnapshot;
};

export type MarketWorkflowMetadata = {
  readonly schemaVersion: typeof MARKET_WORKFLOW_METADATA_SCHEMA;
  readonly revision: number;
  readonly marketGate: {
    readonly status: MarketGateStatus;
    readonly marketScanId: string;
    readonly reason: string | null;
    readonly chosenAt: string | null;
    readonly chosenBy: string | null;
    readonly sampleHash: string;
    readonly metricsHash: string;
    readonly metricsVersion: string;
    readonly missingDataAcknowledged: boolean;
    readonly missingDataCodes: readonly string[];
  };
  readonly representatives: {
    readonly marketScanId: string;
    readonly sampleHash: string;
    readonly metricsVersion: string;
    readonly selectedAt: string | null;
    readonly selectedBy: string | null;
    readonly items: readonly MarketRepresentative[];
  };
  readonly parentVariationDedup: {
    readonly status: "APPLIED" | "NOT_AVAILABLE";
    readonly basis: "parentAsin" | "familyIdentity" | "not_available";
    readonly groupsCollapsed: number;
    readonly sourceItemCount: number;
    readonly retainedItemCount: number;
    readonly notice: string;
  };
};

export type MarketWorkflowProjection = {
  readonly metadata: MarketWorkflowMetadata;
  readonly stale: boolean;
  readonly staleReason: string | null;
  readonly effectiveGateStatus: MarketGateStatus;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function roleOf(value: unknown): RepresentativeRole {
  return REPRESENTATIVE_ROLES.includes(value as RepresentativeRole) ? value as RepresentativeRole : "benchmark";
}

export function parseMarketWorkflowMetadata(value: unknown): MarketWorkflowMetadata | null {
  if (!isRecord(value) || value.schemaVersion !== MARKET_WORKFLOW_METADATA_SCHEMA) return null;
  const gate = isRecord(value.marketGate) ? value.marketGate : null;
  const representatives = isRecord(value.representatives) ? value.representatives : null;
  const dedup = isRecord(value.parentVariationDedup) ? value.parentVariationDedup : null;
  if (!gate || !representatives || !dedup) return null;
  const status = MARKET_GATE_STATUSES.includes(gate.status as MarketGateStatus) ? gate.status as MarketGateStatus : "PENDING";
  const items = Array.isArray(representatives.items)
    ? representatives.items.flatMap((raw) => {
        if (!isRecord(raw)) return [];
        const marketSampleKey = text(raw.marketSampleKey);
        const asin = text(raw.asin)?.toUpperCase();
        const subjectKey = text(raw.subjectKey);
        if (!marketSampleKey || !asin || !subjectKey) return [];
        return [{
          marketSampleKey,
          asin,
          subjectKey,
          role: roleOf(raw.role),
          note: text(raw.note),
          selectedAt: text(raw.selectedAt) ?? new Date(0).toISOString(),
          selectedBy: text(raw.selectedBy) ?? "owner:v1",
          ...(readOpportunityResearchSnapshot(raw.researchContext) ? { researchContext: readOpportunityResearchSnapshot(raw.researchContext) } : {}),
        } satisfies MarketRepresentative];
      })
    : [];
  const fallbackHash = text(gate.sampleHash) ?? "";
  return {
    schemaVersion: MARKET_WORKFLOW_METADATA_SCHEMA,
    revision: Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 ? Number(value.revision) : 0,
    marketGate: {
      status,
      marketScanId: text(gate.marketScanId) ?? "",
      reason: text(gate.reason),
      chosenAt: text(gate.chosenAt),
      chosenBy: text(gate.chosenBy),
      sampleHash: text(gate.sampleHash) ?? fallbackHash,
      metricsHash: text(gate.metricsHash) ?? "",
      metricsVersion: text(gate.metricsVersion) ?? "",
      missingDataAcknowledged: gate.missingDataAcknowledged === true,
      missingDataCodes: Array.isArray(gate.missingDataCodes) ? gate.missingDataCodes.filter((x): x is string => typeof x === "string") : [],
    },
    representatives: {
      marketScanId: text(representatives.marketScanId) ?? "",
      sampleHash: text(representatives.sampleHash) ?? fallbackHash,
      metricsVersion: text(representatives.metricsVersion) ?? "",
      selectedAt: text(representatives.selectedAt),
      selectedBy: text(representatives.selectedBy),
      items,
    },
    parentVariationDedup: {
      status: dedup.status === "APPLIED" ? "APPLIED" : "NOT_AVAILABLE",
      basis: dedup.basis === "parentAsin" || dedup.basis === "familyIdentity" ? dedup.basis : "not_available",
      groupsCollapsed: Number.isSafeInteger(dedup.groupsCollapsed) ? Number(dedup.groupsCollapsed) : 0,
      sourceItemCount: Number.isSafeInteger(dedup.sourceItemCount) ? Number(dedup.sourceItemCount) : 0,
      retainedItemCount: Number.isSafeInteger(dedup.retainedItemCount) ? Number(dedup.retainedItemCount) : 0,
      notice: text(dedup.notice) ?? "父子变体合并未执行：当前来源没有可靠的父 ASIN 或同族标识。",
    },
  };
}

export function buildInitialMarketWorkflowMetadata(input: {
  scanId: string;
  sampleHash: string;
  metricsHash: string;
  metricsVersion: string;
  parentVariationDedup?: MarketWorkflowMetadata["parentVariationDedup"];
}): MarketWorkflowMetadata {
  return {
    schemaVersion: MARKET_WORKFLOW_METADATA_SCHEMA,
    revision: 0,
    marketGate: {
      status: "PENDING",
      marketScanId: input.scanId,
      reason: null,
      chosenAt: null,
      chosenBy: null,
      sampleHash: input.sampleHash,
      metricsHash: input.metricsHash,
      metricsVersion: input.metricsVersion,
      missingDataAcknowledged: false,
      missingDataCodes: [],
    },
    representatives: {
      marketScanId: input.scanId,
      sampleHash: input.sampleHash,
      metricsVersion: input.metricsVersion,
      selectedAt: null,
      selectedBy: null,
      items: [],
    },
    parentVariationDedup: input.parentVariationDedup ?? {
      status: "NOT_AVAILABLE",
      basis: "not_available",
      groupsCollapsed: 0,
      sourceItemCount: 0,
      retainedItemCount: 0,
      notice: "父子变体合并未执行：当前来源没有可靠的父 ASIN 或同族标识，无法识别变体关系。",
    },
  };
}

export function readMarketWorkflowMetadata(
  sampleDefinition: unknown,
  input: { scanId: string; sampleHash: string; metricsHash: string; metricsVersion: string },
): MarketWorkflowProjection {
  const metadata = parseMarketWorkflowMetadata(isRecord(sampleDefinition) ? sampleDefinition.workflow : null)
    ?? buildInitialMarketWorkflowMetadata(input);
  const reasons: string[] = [];
  if (isRecord(sampleDefinition) && isRecord(sampleDefinition.marketIntelligence) && sampleDefinition.marketIntelligence.needsHumanReview === true) reasons.push("marketIntelligence");
  if (metadata.marketGate.marketScanId !== input.scanId) reasons.push("marketScanId");
  if (metadata.marketGate.sampleHash !== input.sampleHash) reasons.push("sampleHash");
  if (metadata.marketGate.metricsHash !== input.metricsHash) reasons.push("metricsHash");
  if (metadata.marketGate.metricsVersion !== input.metricsVersion) reasons.push("metricsVersion");
  if (metadata.representatives.marketScanId !== input.scanId) reasons.push("representatives.marketScanId");
  if (metadata.representatives.sampleHash !== input.sampleHash) reasons.push("representatives.sampleHash");
  return {
    metadata,
    stale: reasons.length > 0,
    staleReason: reasons.length ? `MARKET_WORKFLOW_STALE:${reasons.join(",")}` : null,
    effectiveGateStatus: reasons.length && metadata.marketGate.status !== "PENDING" ? "PENDING" : metadata.marketGate.status,
  };
}

export function writeMarketWorkflowMetadata(sampleDefinitionJson: string, metadata: MarketWorkflowMetadata): string {
  let root: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(sampleDefinitionJson);
    if (isRecord(parsed)) root = parsed;
  } catch {
    root = {};
  }
  return JSON.stringify({ ...root, workflow: metadata });
}

export function roleLabel(role: RepresentativeRole): string {
  return role === "benchmark" ? "基准商品" : role === "newcomer" ? "新进入者" : "痛点样本";
}

export function deterministicRepresentativeSuggestions(
  items: readonly Pick<MarketScanSampleItemV1, "asin" | "factValues" | "capturedAt">[],
): ReadonlyArray<{ asin: string; role: RepresentativeRole }> {
  const sorted = [...items].sort((left, right) => left.asin.localeCompare(right.asin));
  const withSales = sorted.filter((item) => item.factValues.monthlySalesEstimate.presence === "present");
  const benchmark = [...(withSales.length ? withSales : sorted)].sort((left, right) => {
    const l = left.factValues.monthlySalesEstimate.presence === "present" ? left.factValues.monthlySalesEstimate.value : -1;
    const r = right.factValues.monthlySalesEstimate.presence === "present" ? right.factValues.monthlySalesEstimate.value : -1;
    return r - l || left.asin.localeCompare(right.asin);
  })[0];
  const newest = [...sorted].sort((left, right) => right.capturedAt.localeCompare(left.capturedAt) || left.asin.localeCompare(right.asin))
    .find((item) => item.asin !== benchmark?.asin);
  const pain = [...sorted].sort((left, right) => {
    const l = left.factValues.rating.presence === "present" ? left.factValues.rating.value : Number.POSITIVE_INFINITY;
    const r = right.factValues.rating.presence === "present" ? right.factValues.rating.value : Number.POSITIVE_INFINITY;
    return l - r || left.asin.localeCompare(right.asin);
  }).find((item) => item.asin !== benchmark?.asin && item.asin !== newest?.asin);
  return [
    ...(benchmark ? [{ asin: benchmark.asin, role: "benchmark" as const }] : []),
    ...(newest ? [{ asin: newest.asin, role: "newcomer" as const }] : []),
    ...(pain ? [{ asin: pain.asin, role: "pain_point" as const }] : []),
  ];
}
import { readOpportunityResearchSnapshot, type OpportunityResearchSnapshot } from "@/lib/marketScan/opportunityResearch";
