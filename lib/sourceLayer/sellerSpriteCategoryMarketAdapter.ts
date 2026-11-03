import { randomBytes } from "node:crypto";

import {
  CATEGORY_MARKET_CAPTURE_MAX_ROWS,
  type CategoryMarketCaptureBatch,
  type CategoryMarketOpportunityRow,
  type ProviderEstimate,
} from "@/lib/sourceLayer/categoryMarketCapture";

const SOURCE_URL = "https://www.sellersprite.com/v2/market-research" as const;

const COLUMN_ALIASES = {
  segment: ["细分市场", "市场细分", "子市场"],
  sample: ["样本数量", "样本量"],
  monthlyTotalSales: ["月总销量", "月销量总计"],
  topMonthlyAverageSales: ["月均销量(头部)", "月均销量（头部）", "月均销量"],
  topMonthlyAverageRevenueUsd: ["月均销售额(头部)", "月均销售额（头部）", "月均销售额"],
  averageReviewAndRating: ["平均评分数/星级", "平均评论数/星级", "平均评分数 / 星级", "平均评分数"],
  averageTopBsr: ["平均BSR(头部)", "平均BSR（头部）", "平均BSR"],
  averageSellerCount: ["平均卖家数", "平均卖家数平均价格"],
  averagePriceUsd: ["平均价格", "平均售价", "平均卖家数平均价格"],
  sellerType: ["卖家类型", "卖家结构"],
  concentration: ["集中度指标", "集中度"],
  newProducts: ["新品数量/占比", "新品数量 / 占比", "新品数/占比", "新品数量"],
  totalProductCount: ["商品总数", "商品数"],
  returnRatePercent: ["退货率", "退货率(估算)", "退货率（估算）"],
} as const;

type AdapterInput = {
  query: string;
  category: { id: string; label: string; products: number | null };
  headers: readonly unknown[];
  rows: readonly (readonly unknown[])[];
  sourceUrl: string;
  capturedAt: string;
};

type ColumnName = keyof typeof COLUMN_ALIASES;

export function adaptSellerSpriteCategoryMarketTable(input: AdapterInput): CategoryMarketCaptureBatch {
  assertInput(input);
  const headerIndexes = new Map<string, number>();
  for (const [index, rawHeader] of input.headers.entries()) {
    if (typeof rawHeader !== "string") continue;
    const normalized = normalizeHeader(rawHeader);
    if (normalized && !headerIndexes.has(normalized)) headerIndexes.set(normalized, index);
  }

  const resolved = new Map<ColumnName, number | null>();
  for (const [column, aliases] of Object.entries(COLUMN_ALIASES) as [ColumnName, readonly string[]][]) {
    resolved.set(column, aliases
      .map((alias) => headerIndexes.get(normalizeHeader(alias)))
      .find((index): index is number => index !== undefined) ?? null);
  }

  const missingColumns = [...resolved.entries()]
    .filter(([column, index]) => column !== "segment" && index === null)
    .map(([column]) => column);
  const rows = input.rows.map((row) => mapRow(row, resolved, missingColumns));

  return {
    schemaVersion: "category-market-capture-batch.v1",
    batchId: `category-${randomBytes(12).toString("hex")}`,
    sourceType: "category",
    provider: "SellerSprite",
    marketplace: "US",
    query: input.query.trim(),
    category: {
      nodeId: input.category.id.trim(),
      label: input.category.label.trim(),
      productCount: estimate(input.category.products),
    },
    capturedAt: input.capturedAt,
    sourceUrl: SOURCE_URL,
    rowCount: rows.length,
    amazonConfirmed: false,
    rows,
    observedHeaders: input.headers.filter((header): header is string => typeof header === "string").map(header => header.trim().slice(0, 240)),
  };
}

function assertInput(input: AdapterInput): void {
  if (!input || typeof input !== "object"
    || typeof input.query !== "string" || input.query.trim().length < 1 || input.query.length > 120
    || !input.category || typeof input.category.id !== "string"
    || !/^[0-9]+(?::[0-9]+)*$/u.test(input.category.id.trim()) || input.category.id.length > 80
    || typeof input.category.label !== "string" || input.category.label.trim().length < 1
    || input.category.label.length > 240
    || !(input.category.products === null || (typeof input.category.products === "number"
      && Number.isFinite(input.category.products) && input.category.products >= 0))
    || !Array.isArray(input.headers) || input.headers.length > 100
    || !Array.isArray(input.rows)
    || !input.rows.every((row) => Array.isArray(row) && row.length <= 100)) {
    throw new Error("CATEGORY_MARKET_INPUT_INVALID");
  }
  if (input.sourceUrl !== SOURCE_URL) throw new Error("CATEGORY_MARKET_SOURCE_INVALID");
  if (!Number.isFinite(Date.parse(input.capturedAt))) throw new Error("CATEGORY_MARKET_CAPTURED_AT_INVALID");
  if (input.rows.length < 1) throw new Error("CATEGORY_MARKET_TABLE_EMPTY");
  if (input.rows.length > CATEGORY_MARKET_CAPTURE_MAX_ROWS) throw new Error("CATEGORY_MARKET_ROW_LIMIT");
  if (!input.headers.some((header) => typeof header === "string" && COLUMN_ALIASES.segment
    .some((alias) => normalizeHeader(header) === normalizeHeader(alias)))) {
    throw new Error("CATEGORY_MARKET_SEGMENT_COLUMN_MISSING");
  }
}

function mapRow(
  row: readonly unknown[],
  columns: ReadonlyMap<ColumnName, number | null>,
  missingColumns: readonly string[],
): CategoryMarketOpportunityRow {
  const cell = (column: ColumnName) => {
    const index = columns.get(column);
    return index === null || index === undefined ? "" : safeCell(row[index]);
  };
  const sample = cell("sample");
  const reviewAndRating = cell("averageReviewAndRating");
  const sellerType = cell("sellerType");
  const concentration = cell("concentration");
  const newProducts = cell("newProducts");
  const combinedSellerPrice = columns.get("averageSellerCount") !== null
    && columns.get("averageSellerCount") === columns.get("averagePriceUsd");
  const sellerPrice = cell("averageSellerCount");
  const usdPriceMatch = sellerPrice.match(/(?:USD|\$)\s*([\d,]+(?:\.\d+)?)/iu);
  const warnings: string[] = [];
  if (missingColumns.length) warnings.push("market_columns_missing");

  const mapped: CategoryMarketOpportunityRow = {
    segment: { value: cell("segment").trim().slice(0, 240), authority: "provider_derived" },
    sampleProductCount: estimate(labelledNumber(sample, "商品", "products")),
    sampleBrandCount: estimate(labelledNumber(sample, "品牌", "brands")),
    sampleSellerCount: estimate(labelledNumber(sample, "卖家", "sellers")),
    monthlyTotalSales: estimate(firstNumber(cell("monthlyTotalSales"))),
    topMonthlyAverageSales: estimate(firstNumber(cell("topMonthlyAverageSales"))),
    topMonthlyAverageRevenueUsd: estimate(firstNumber(cell("topMonthlyAverageRevenueUsd"))),
    averageReviewCount: estimate(labelledNumber(reviewAndRating, "评分数|评论数", "reviewCount")),
    averageRating: estimate(labelledNumber(reviewAndRating, "星级|评分", "rating")),
    averageTopBsr: estimate(firstNumber(cell("averageTopBsr"))),
    averageSellerCount: estimate(combinedSellerPrice
      ? usdPriceMatch ? firstNumber(sellerPrice.replace(usdPriceMatch[0], "")) : null
      : firstNumber(cell("averageSellerCount"))),
    averagePriceUsd: estimate(combinedSellerPrice
      ? usdPriceMatch ? parseNumber(usdPriceMatch[1]) : null
      : firstNumber(cell("averagePriceUsd"))),
    fbaSellerSharePercent: estimate(labelledNumber(sellerType, "FBA", "FBA")),
    amazonSellerSharePercent: estimate(labelledNumber(sellerType, "AMZ|Amazon", "Amazon")),
    fbmSellerSharePercent: estimate(labelledNumber(sellerType, "FBM", "FBM")),
    productConcentrationPercent: estimate(labelledNumber(concentration, "商品|产品", "product")),
    brandConcentrationPercent: estimate(labelledNumber(concentration, "品牌", "brand")),
    sellerConcentrationPercent: estimate(labelledNumber(concentration, "卖家", "seller")),
    newProductCount: estimate(firstNumber(newProducts)),
    newProductSharePercent: estimate(percentageAfterCount(newProducts)),
    totalProductCount: estimate(firstNumber(cell("totalProductCount"))),
    returnRatePercent: estimate(firstNumber(cell("returnRatePercent"))),
    warnings,
  };
  const metricEntries = Object.entries(mapped).filter((entry): entry is [string, ProviderEstimate] =>
    typeof entry[1] === "object" && entry[1] !== null && "nature" in entry[1]);
  const unavailableFields = metricEntries.filter(([, metric]) => metric.value === null).map(([name]) => name);
  const availableMetricCount = metricEntries.length - unavailableFields.length;
  // A missing optional column is not evidence that all numeric values are unavailable.
  if (availableMetricCount === 0) warnings.push("market_values_unavailable");
  else if (unavailableFields.length) warnings.push("market_values_partial");
  mapped.fieldCoverage = { missingColumns: [...missingColumns], unavailableFields,
    availableMetricCount, totalMetricCount: metricEntries.length };
  return mapped;
}

function normalizeHeader(value: string): string {
  return value.trim().replace(/[\s（）()]/gu, "").replace(/[／]/gu, "/").toLowerCase();
}

function safeCell(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).slice(0, 1000);
  return "";
}

function estimate(value: number | null): ProviderEstimate {
  return { value: value !== null && Number.isFinite(value) && value >= 0 ? value : null, nature: "provider_estimate" };
}

function firstNumber(value: string): number | null {
  const match = value.match(/\d+(?:,\d{3})*(?:\.\d+)?/u);
  return match ? parseNumber(match[0]) : null;
}

function labelledNumber(value: string, labelPattern: string, key: string): number | null {
  const match = value.match(new RegExp(`(?:${labelPattern})\\s*[:：]?\\s*([\\d,]+(?:\\.\\d+)?)`, "iu"));
  if (match?.[1]) return parseNumber(match[1]);
  if (key === "reviewCount" && !/(?:星级|评分)/iu.test(value)) return firstNumber(value);
  if (key === "rating" && !/(?:评分数|评论数|FBA|FBM|AMZ|Amazon|商品|品牌|卖家)/iu.test(value)) {
    const numbers = [...value.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/gu)];
    const last = numbers.at(-1)?.[0];
    return last ? parseNumber(last) : null;
  }
  return null;
}

function percentageAfterCount(value: string): number | null {
  const match = value.match(/\(\s*(\d+(?:\.\d+)?)\s*%\s*\)/u)
    ?? value.match(/\d+(?:,\d{3})*(?:\.\d+)?\s*[-·/]\s*(\d+(?:\.\d+)?)\s*%/u)
    ?? value.match(/(\d+(?:\.\d+)?)\s*%/u);
  return match?.[1] ? parseNumber(match[1]) : null;
}

function parseNumber(rawValue: string): number | null {
  const value = Number(rawValue.replaceAll(",", ""));
  return Number.isFinite(value) && value >= 0 ? value : null;
}
