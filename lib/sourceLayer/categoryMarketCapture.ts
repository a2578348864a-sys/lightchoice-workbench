export const CATEGORY_MARKET_CAPTURE_SCHEMA = "category-market-capture-batch.v1" as const;
export const CATEGORY_MARKET_CAPTURE_ATTACHMENT_KIND = "sellersprite_category_market_capture_v1" as const;
export const CATEGORY_MARKET_CAPTURE_MAX_ROWS = 60;

export type CategoryMarketCaptureSourceType = "asin" | "keyword" | "category";

export type ProviderDerivedText = {
  value: string;
  authority: "provider_derived";
};

export type ProviderEstimate = {
  value: number | null;
  nature: "provider_estimate";
};

export type CategoryMarketOpportunityRow = {
  segment: ProviderDerivedText;
  sampleProductCount: ProviderEstimate;
  sampleBrandCount: ProviderEstimate;
  sampleSellerCount: ProviderEstimate;
  monthlyTotalSales: ProviderEstimate;
  topMonthlyAverageSales: ProviderEstimate;
  topMonthlyAverageRevenueUsd: ProviderEstimate;
  averageReviewCount: ProviderEstimate;
  averageRating: ProviderEstimate;
  averageTopBsr: ProviderEstimate;
  averageSellerCount: ProviderEstimate;
  averagePriceUsd: ProviderEstimate;
  fbaSellerSharePercent: ProviderEstimate;
  amazonSellerSharePercent: ProviderEstimate;
  fbmSellerSharePercent: ProviderEstimate;
  productConcentrationPercent: ProviderEstimate;
  brandConcentrationPercent: ProviderEstimate;
  sellerConcentrationPercent: ProviderEstimate;
  newProductCount: ProviderEstimate;
  newProductSharePercent: ProviderEstimate;
  totalProductCount: ProviderEstimate;
  returnRatePercent: ProviderEstimate;
  warnings: string[];
  /** Present on new captures only; historical Evidence remains unchanged. */
  fieldCoverage?: { missingColumns: string[]; unavailableFields: string[]; availableMetricCount: number; totalMetricCount: number };
};

export type CategoryMarketCaptureBatch = {
  schemaVersion: typeof CATEGORY_MARKET_CAPTURE_SCHEMA;
  batchId: string;
  sourceType: "category";
  provider: "SellerSprite";
  marketplace: "US";
  query: string;
  category: {
    nodeId: string;
    label: string;
    productCount: ProviderEstimate;
  };
  capturedAt: string;
  sourceUrl: "https://www.sellersprite.com/v2/market-research";
  rowCount: number;
  /** SellerSprite 数值是第三方估算，不是 Amazon 确认值。 */
  amazonConfirmed: false;
  rows: CategoryMarketOpportunityRow[];
  observedHeaders?: string[];
};

export function categoryMarketSubjectKey(nodeId: string): string {
  if (!/^[0-9]+(?::[0-9]+)*$/u.test(nodeId) || nodeId.length > 80) {
    throw new Error("CATEGORY_MARKET_NODE_ID_INVALID");
  }
  return `market:US:category:${nodeId}`;
}

export function isCategoryMarketSubjectKey(value: string): boolean {
  return /^market:US:category:[0-9]+(?::[0-9]+)*$/u.test(value)
    && value.length <= 120;
}

export function assertCategoryMarketCaptureBatch(value: unknown): asserts value is CategoryMarketCaptureBatch {
  if (!isRecord(value)
    || value.schemaVersion !== CATEGORY_MARKET_CAPTURE_SCHEMA
    || value.sourceType !== "category"
    || value.provider !== "SellerSprite"
    || value.marketplace !== "US"
    || value.amazonConfirmed !== false
    || typeof value.batchId !== "string"
    || !/^category-[a-f0-9]{24}$/u.test(value.batchId)
    || typeof value.query !== "string"
    || value.query.trim().length < 1
    || value.query.length > 120
    || typeof value.category !== "object"
    || value.category === null
    || !isRecord(value.category)
    || typeof value.category.nodeId !== "string"
    || !/^[0-9]+(?::[0-9]+)*$/u.test(value.category.nodeId)
    || value.category.nodeId.length > 80
    || typeof value.category.label !== "string"
    || value.category.label.trim().length < 1
    || value.category.label.length > 240
    || !isProviderEstimate(value.category.productCount)
    || typeof value.capturedAt !== "string"
    || Number.isNaN(Date.parse(value.capturedAt))
    || value.sourceUrl !== "https://www.sellersprite.com/v2/market-research"
    || !Array.isArray(value.rows)
    || value.rows.length < 1
    || value.rows.length > CATEGORY_MARKET_CAPTURE_MAX_ROWS
    || value.rowCount !== value.rows.length
    || !value.rows.every(isCategoryMarketOpportunityRow)
    || (value.observedHeaders !== undefined && (!Array.isArray(value.observedHeaders)
      || value.observedHeaders.length > 100 || !value.observedHeaders.every(header => typeof header === "string" && header.length <= 240)))) {
    throw new Error("CATEGORY_MARKET_BATCH_INVALID");
  }
}

function isCategoryMarketOpportunityRow(value: unknown): value is CategoryMarketOpportunityRow {
  if (!isRecord(value) || !isRecord(value.segment) || value.segment.authority !== "provider_derived"
    || typeof value.segment.value !== "string" || value.segment.value.trim().length < 1
    || value.segment.value.length > 240 || !Array.isArray(value.warnings)
    || !value.warnings.every((warning) => typeof warning === "string" && warning.length <= 80)) return false;
  if (value.fieldCoverage !== undefined) {
    const coverage = value.fieldCoverage;
    if (!isRecord(coverage) || !Array.isArray(coverage.missingColumns) || !Array.isArray(coverage.unavailableFields)
      || ![...coverage.missingColumns, ...coverage.unavailableFields].every(field => typeof field === "string" && field.length <= 80)
      || coverage.missingColumns.length > 30 || coverage.unavailableFields.length > 30
      || typeof coverage.availableMetricCount !== "number" || typeof coverage.totalMetricCount !== "number"
      || !Number.isInteger(coverage.availableMetricCount) || !Number.isInteger(coverage.totalMetricCount)
      || coverage.availableMetricCount < 0 || coverage.availableMetricCount > coverage.totalMetricCount || coverage.totalMetricCount > 30) return false;
  }
  return [
    value.sampleProductCount,
    value.sampleBrandCount,
    value.sampleSellerCount,
    value.monthlyTotalSales,
    value.topMonthlyAverageSales,
    value.topMonthlyAverageRevenueUsd,
    value.averageReviewCount,
    value.averageRating,
    value.averageTopBsr,
    value.averageSellerCount,
    value.averagePriceUsd,
    value.fbaSellerSharePercent,
    value.amazonSellerSharePercent,
    value.fbmSellerSharePercent,
    value.productConcentrationPercent,
    value.brandConcentrationPercent,
    value.sellerConcentrationPercent,
    value.newProductCount,
    value.newProductSharePercent,
    value.totalProductCount,
    value.returnRatePercent,
  ].every(isProviderEstimate);
}

function isProviderEstimate(value: unknown): value is ProviderEstimate {
  return isRecord(value)
    && value.nature === "provider_estimate"
    && (value.value === null || (typeof value.value === "number" && Number.isFinite(value.value) && value.value >= 0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
