/** Phase 2：MarketScan 之间的可比性与确定性增量。无 IO、无 AI、无阈值判断。 */

import { stableStringify } from "@/lib/marketScan/metrics";
import type { MarketScanRecordView } from "@/lib/server/marketScanRepository";
import type {
  MarketOpportunityComparison,
  MarketOpportunityComparisonReason,
} from "@/lib/marketOpportunity/types";

type ScanMetricSource = MarketScanRecordView;

function delta(
  from: number | null | undefined,
  to: number | null | undefined,
): number | null {
  if (typeof from !== "number" || !Number.isFinite(from)
    || typeof to !== "number" || !Number.isFinite(to)) return null;
  return to - from;
}

function structuralReasons(from: ScanMetricSource, to: ScanMetricSource): MarketOpportunityComparisonReason[] {
  const reasons: MarketOpportunityComparisonReason[] = [];
  if (from.marketplace !== to.marketplace) reasons.push("marketplace_mismatch");
  if (stableStringify(from.nicheDefinition) !== stableStringify(to.nicheDefinition)) {
    reasons.push("niche_definition_mismatch");
  }
  if (stableStringify(from.sampleDefinition) !== stableStringify(to.sampleDefinition)) {
    reasons.push("sample_definition_mismatch");
  }
  if (from.metricsVersion !== to.metricsVersion) reasons.push("metrics_version_mismatch");
  return reasons;
}

function metricValues(from: ScanMetricSource, to: ScanMetricSource) {
  return {
    priceMedianDelta: delta(from.metrics.price.value?.median, to.metrics.price.value?.median),
    knownSalesDelta: delta(from.metrics.sales.value?.total, to.metrics.sales.value?.total),
    knownRevenueDelta: delta(from.metrics.revenue.value?.total, to.metrics.revenue.value?.total),
    cr5Delta: delta(
      from.metrics.salesConcentration.cr5.value?.ratio,
      to.metrics.salesConcentration.cr5.value?.ratio,
    ),
    brandCountDelta: delta(
      from.metrics.brandConcentration.uniqueBrandCount.value,
      to.metrics.brandConcentration.uniqueBrandCount.value,
    ),
    ratingDelta: delta(
      from.metrics.rating.averageRating.value,
      to.metrics.rating.averageRating.value,
    ),
    reviewBarrierDelta: delta(
      from.metrics.reviews.medianReviewCount.value,
      to.metrics.reviews.medianReviewCount.value,
    ),
  };
}

/**
 * 比较规则固定为：市场、机会定义、样本定义和 metricsVersion 全部一致才可比。
 * 结构不匹配时不计算任何数值增量；单个指标缺失时只将该字段置 null，绝不补 0。
 */
export function compareMarketScans(
  from: ScanMetricSource,
  to: ScanMetricSource,
): MarketOpportunityComparison {
  const reasons = structuralReasons(from, to);
  if (reasons.length > 0) {
    return {
      status: "INSUFFICIENT_DATA",
      fromScanId: from.id,
      toScanId: to.id,
      reasons,
      priceMedianDelta: null,
      knownSalesDelta: null,
      knownRevenueDelta: null,
      cr5Delta: null,
      brandCountDelta: null,
      ratingDelta: null,
      reviewBarrierDelta: null,
    };
  }

  const values = metricValues(from, to);
  const hasMissingMetric = Object.values(values).some((value) => value === null);
  return {
    status: "COMPARABLE",
    fromScanId: from.id,
    toScanId: to.id,
    reasons: hasMissingMetric ? ["metric_missing"] : [],
    ...values,
  };
}

export function latestComparableScan(
  scans: readonly ScanMetricSource[],
  latest: ScanMetricSource,
): ScanMetricSource | null {
  for (const candidate of scans) {
    if (candidate.id === latest.id) continue;
    const comparison = compareMarketScans(candidate, latest);
    if (comparison.status === "COMPARABLE"
      && !comparison.reasons.some((reason) => reason !== "metric_missing")) {
      return candidate;
    }
  }
  return null;
}
