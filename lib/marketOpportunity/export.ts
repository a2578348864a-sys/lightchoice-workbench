/** Phase 2：机会池的飞书导出契约。只导出机会，不复用 ResearchExportRecord / ASIN 主键。 */

import { sha256Hex, stableStringify } from "@/lib/marketScan/metrics";
import { parseOpportunityExportRecord } from "@/lib/marketOpportunity/contract";
import type {
  MarketOpportunityRecordView,
  OpportunityExportRecord,
} from "@/lib/marketOpportunity/types";

function baseUrlOf(value: string | undefined): string {
  const fallback = "http://127.0.0.1:3010";
  const raw = value?.trim() || fallback;
  try {
    return new URL(raw).origin;
  } catch {
    return fallback;
  }
}

export function buildOpportunityExportRecord(
  record: MarketOpportunityRecordView,
  options: { readonly appBaseUrl?: string; readonly exportedAt?: string } = {},
): OpportunityExportRecord {
  const humanDecision = record.humanDecision?.status ?? "UNREVIEWED";
  return parseOpportunityExportRecord({
    schemaVersion: "opportunity-export.v1",
    opportunityId: record.id,
    name: record.name,
    marketplace: record.marketplace,
    nicheKind: record.nicheKind,
    latestScanId: record.latestMarketScanId,
    sampleCount: record.analysisSnapshot.metrics.sampleCount,
    metricsSummary: {
      priceMedian: record.analysisSnapshot.metrics.price.value?.median ?? null,
      knownSalesTotal: record.analysisSnapshot.metrics.sales.value?.total ?? null,
      knownRevenueTotal: record.analysisSnapshot.metrics.revenue.value?.total ?? null,
      cr5: record.analysisSnapshot.metrics.salesConcentration.cr5.value?.ratio ?? null,
      uniqueBrandCount: record.analysisSnapshot.metrics.brandConcentration.uniqueBrandCount.value ?? null,
      coverage: record.analysisSnapshot.metrics.fieldCoverage,
    },
    humanDecision,
    decisionReason: record.humanDecision?.reason ?? null,
    opportunityUrl: `${baseUrlOf(options.appBaseUrl)}/market-opportunities/${encodeURIComponent(record.id)}`,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
  });
}

/** 同一机会 + 同一人工决策版本得到同一幂等键；时间字段不参与。 */
export function opportunityIdempotencyKey(record: MarketOpportunityRecordView, tableId = ""): string {
  return sha256Hex(stableStringify({
    schemaVersion: "opportunity-export.v1",
    opportunityId: record.id,
    tableId,
    exportContractVersion: "opportunity-export.v1",
  }));
}

export function opportunityExportFields(record: OpportunityExportRecord): Record<string, unknown> {
  return {
    OpportunityID: record.opportunityId,
    Name: record.name,
    Marketplace: record.marketplace,
    NicheKind: record.nicheKind,
    LatestMarketScanID: record.latestScanId,
    SampleCount: record.sampleCount,
    MetricsSummary: JSON.stringify(record.metricsSummary),
    HumanDecision: record.humanDecision,
    DecisionReason: record.decisionReason ?? "",
    OpportunityURL: record.opportunityUrl,
    ExportedAt: record.exportedAt,
  };
}
