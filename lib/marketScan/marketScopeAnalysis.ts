import type { MarketFactValuesV1, MarketScanSampleItemV1 } from "@/lib/marketScan/types";

export const MARKET_SCOPE_ANALYSIS_VERSION = "market-scope-analysis.v1" as const;

export type MarketScopeStatus = "IN_SCOPE" | "OUT_OF_SCOPE" | "UNCERTAIN";

export type MarketScopeItemAnalysis = {
  asin: string;
  title: string | null;
  status: MarketScopeStatus;
  reason: string;
  titleOnly: true;
  comparabilityFlags: string[];
  evidence: {
    evidenceId: string;
    evidenceVersion: number;
    sourceProofHash: string;
    capturedAt: string;
  };
};

export type MarketScopeAnalysisV1 = {
  version: typeof MARKET_SCOPE_ANALYSIS_VERSION;
  basis: "FROZEN_MARKETSCAN_TITLE_ONLY";
  sampleHash: string;
  totalCount: number;
  counts: Record<MarketScopeStatus, number>;
  strictComparability: {
    status: "NOT_ESTABLISHED";
    reason: string;
  };
  items: MarketScopeItemAnalysis[];
  listingPrice: {
    status: "AVAILABLE" | "NO_VALID_PRICES" | "MIXED_CURRENCY";
    currency: string | null;
    sampleCount: number;
    missingCount: number;
    min: number | null;
    median: number | null;
    max: number | null;
    basis: "OBSERVED_LISTING_PRICE_NOT_UNIT_PRICE";
  };
  fieldCoverage: Record<
    "title" | "brand" | "category" | "price" | "rating" | "reviewCount" | "bsr" | "monthlySalesEstimate" | "monthlyRevenueEstimate" | "launchedDate",
    { presentCount: number; missingCount: number; totalCount: number }
  >;
  limits: string[];
};

export type OutsideMarketScanCandidate = {
  asin: string;
  title: string | null;
  missingSignals: string[];
  evidenceStatus: string;
  promotionEligible: boolean;
  evidence: {
    evidenceId: string | null;
    evidenceVersion: number | null;
    capturedAt: string | null;
    contentHash: string | null;
  };
};

export type SourceBatchCoverageV1 = {
  version: "market-sample-candidate-coverage.v1";
  sourceBatchId: string;
  sampleHash: string;
  sourceBatchCandidateCount: number;
  lockedSampleCount: number;
  outsideCount: number;
  outsideCandidates: OutsideMarketScanCandidate[];
};

const CONFIRMED_SILICONE_BAKING_MAT_LABELS = new Set([
  "silicone baking mat",
  "silicone baking mats",
  "硅胶烘焙垫",
]);

type ScopeInput = Pick<
  MarketScanSampleItemV1,
  "asin" | "sourceProofHash" | "evidenceId" | "evidenceVersion" | "capturedAt" | "factValues"
> & Partial<Pick<MarketScanSampleItemV1, "parentAsin">>;

/**
 * This title-based scope analysis is specific to a confirmed silicone baking mat
 * research topic. Keep the gate exact; do not infer a topic from scan names,
 * notes, or sample titles.
 */
export function analyzeMarketScopeForConfirmedTopic(
  nicheDefinition: unknown,
  items: readonly ScopeInput[],
  sampleHash: string,
): MarketScopeAnalysisV1 | undefined {
  if (typeof nicheDefinition !== "object" || nicheDefinition === null || Array.isArray(nicheDefinition)) return undefined;
  const label = (nicheDefinition as Record<string, unknown>).label;
  if (typeof label !== "string") return undefined;
  const normalizedLabel = label.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");
  if (!CONFIRMED_SILICONE_BAKING_MAT_LABELS.has(normalizedLabel)) return undefined;
  return analyzeMarketSampleScope(items, sampleHash);
}

const BAKING_USE = /\b(?:baking|bake|pastry|macaron|eclair|éclair|cookie|dough|oven liner)\b/iu;
const OTHER_USE = /\b(?:counter\s*top|craft\s*(?:table|mat)|placemat|desk\s*(?:mat|pad)|drawer\s+liner|sink\s+mat|pet\s+mat)\b/iu;

export function analyzeMarketSampleScope(
  items: readonly ScopeInput[],
  sampleHash: string,
): MarketScopeAnalysisV1 {
  const analyzed = items.map(analyzeItem);
  const counts: Record<MarketScopeStatus, number> = {
    IN_SCOPE: analyzed.filter((item) => item.status === "IN_SCOPE").length,
    OUT_OF_SCOPE: analyzed.filter((item) => item.status === "OUT_OF_SCOPE").length,
    UNCERTAIN: analyzed.filter((item) => item.status === "UNCERTAIN").length,
  };
  const byAsin = new Map(items.map((item) => [item.asin, item]));
  const inScope = analyzed
    .filter((item) => item.status === "IN_SCOPE")
    .map((item) => byAsin.get(item.asin))
    .filter((item): item is ScopeInput => item !== undefined);
  const listingPrice = listingPriceDistribution(inScope);
  const fieldCoverage = coverageFor(items);

  const limits = [
    "相关性只依据锁定快照中的标题关键词；标题匹配不等于详情页用途或规格已核验。",
    "价格是商品页面记录的标价，不是单件价格、采购价或已确认成本；组合数量、尺寸和垫型未统一。",
  ];
  if (fieldCoverage.brand.presentCount === 0) limits.push("样本没有品牌字段，不能计算品牌集中度。");
  if (fieldCoverage.monthlySalesEstimate.presentCount === 0 || fieldCoverage.monthlyRevenueEstimate.presentCount === 0) {
    limits.push("样本没有销量或销售额估算，不能计算市场规模或销售集中度。");
  }
  if (fieldCoverage.launchedDate.presentCount === 0) limits.push("样本没有上架日期，低评论数不能单独证明是新品。");
  if (items.some((item) => !item.parentAsin)) limits.push("部分或全部样本没有父体标识，未据此合并父子变体或判定重复商品。");

  return {
    version: MARKET_SCOPE_ANALYSIS_VERSION,
    basis: "FROZEN_MARKETSCAN_TITLE_ONLY",
    sampleHash,
    totalCount: items.length,
    counts,
    strictComparability: {
      status: "NOT_ESTABLISHED",
      reason: "快照没有统一的单件数量、尺寸、垫型和材料规格，无法建立严格同规格对照组。",
    },
    items: analyzed,
    listingPrice,
    fieldCoverage,
    limits,
  };
}

function analyzeItem(item: ScopeInput): MarketScopeItemAnalysis {
  const title = presentString(item.factValues.title);
  const titleText = title ?? "";
  const hasBakingUse = BAKING_USE.test(titleText);
  const hasOtherUse = OTHER_USE.test(titleText);
  const status: MarketScopeStatus = hasBakingUse
    ? "IN_SCOPE"
    : hasOtherUse
      ? "OUT_OF_SCOPE"
      : "UNCERTAIN";
  const reason = status === "IN_SCOPE"
    ? "标题明确出现烘焙、糕点、面团或烤箱垫用途词；详情用途与规格仍待核验。"
    : status === "OUT_OF_SCOPE"
      ? "标题突出其他用途且未出现烘焙用途词；暂不纳入本烘焙垫细分市场比较。"
      : "标题不足以确认是否用于烘焙；保持待核实，不纳入可比较样本。";

  return {
    asin: item.asin,
    title,
    status,
    reason,
    titleOnly: true,
    comparabilityFlags: comparabilityFlags(titleText),
    evidence: {
      evidenceId: item.evidenceId,
      evidenceVersion: item.evidenceVersion,
      sourceProofHash: item.sourceProofHash,
      capturedAt: item.capturedAt,
    },
  };
}

function comparabilityFlags(title: string): string[] {
  const flags: string[] = [];
  if (/\b(?:\d+\s*[- ]?pack|pack\s+of\s+\d+|set\s*(?:of\s*)?\d+|\d+\s*(?:pcs|pieces))\b/iu.test(title)) {
    flags.push("组合数量可能不同");
  }
  if (/\b\d+(?:\.\d+)?\s*(?:x|×)\s*\d+(?:\.\d+)?\s*(?:in|inch|inches)?\b|\b(?:half|quarter)\s*sheet\b/iu.test(title)) {
    flags.push("尺寸或烤盘规格可能不同");
  }
  if (/\b(?:roll|\d+\s*(?:ft|feet)|perforated|eclair|macaron|toaster\s*oven|round|square)\b/iu.test(title)) {
    flags.push("形态或使用场景可能不同");
  }
  return flags;
}

function listingPriceDistribution(items: readonly ScopeInput[]): MarketScopeAnalysisV1["listingPrice"] {
  const prices = items.flatMap((item) => {
    const field = item.factValues.price;
    if (field.presence !== "present" || !Number.isFinite(field.value.amount) || field.value.amount <= 0) return [];
    return [{ amount: field.value.amount, currency: field.value.currency.trim().toUpperCase() }];
  });
  const currencies = [...new Set(prices.map((price) => price.currency))];
  const missingCount = items.length - prices.length;
  if (currencies.length > 1) {
    return { status: "MIXED_CURRENCY", currency: null, sampleCount: prices.length, missingCount, min: null, median: null, max: null, basis: "OBSERVED_LISTING_PRICE_NOT_UNIT_PRICE" };
  }
  if (prices.length === 0) {
    return { status: "NO_VALID_PRICES", currency: null, sampleCount: 0, missingCount, min: null, median: null, max: null, basis: "OBSERVED_LISTING_PRICE_NOT_UNIT_PRICE" };
  }
  const values = prices.map((price) => price.amount).sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
  return {
    status: "AVAILABLE",
    currency: currencies[0],
    sampleCount: values.length,
    missingCount,
    min: roundMoney(values[0]),
    median: roundMoney(median),
    max: roundMoney(values[values.length - 1]),
    basis: "OBSERVED_LISTING_PRICE_NOT_UNIT_PRICE",
  };
}

function coverageFor(items: readonly ScopeInput[]): MarketScopeAnalysisV1["fieldCoverage"] {
  const fields = ["title", "brand", "category", "price", "rating", "reviewCount", "bsr", "monthlySalesEstimate", "monthlyRevenueEstimate", "launchedDate"] as const;
  const presentByField = Object.fromEntries(fields.map((field) => [field, 0])) as Record<typeof fields[number], number>;
  for (const item of items) {
    for (const field of fields) {
      if (item.factValues[field].presence === "present") presentByField[field] += 1;
    }
  }
  return Object.fromEntries(fields.map((field) => [field, {
    presentCount: presentByField[field],
    missingCount: items.length - presentByField[field],
    totalCount: items.length,
  }])) as MarketScopeAnalysisV1["fieldCoverage"];
}

function presentString(value: MarketFactValuesV1["title"]): string | null {
  return value.presence === "present" && value.value.trim() !== "" ? value.value.trim() : null;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function summarizeSourceCandidatesOutsideMarketScan(input: {
  sourceBatchId: string;
  sampleHash: string;
  lockedSampleAsins: readonly string[];
  candidates: readonly {
    asin: string;
    title: string | null;
    promotionEligible: boolean;
    evidenceStatus: string;
    ratingStatus: string | null;
    reviewCountStatus: string | null;
    launchedDateStatus: string | null;
    evidenceId: string | null;
    evidenceVersion: number | null;
    capturedAt: string | null;
    contentHash: string | null;
  }[];
}): SourceBatchCoverageV1 {
  const locked = new Set(input.lockedSampleAsins.map((asin) => asin.trim().toUpperCase()));
  const outsideCandidates = input.candidates
    .filter((candidate) => !locked.has(candidate.asin.trim().toUpperCase()))
    .map((candidate) => ({
      asin: candidate.asin,
      title: candidate.title,
      missingSignals: [
        candidate.ratingStatus === "missing" ? "评分" : null,
        candidate.reviewCountStatus === "missing" ? "评论数" : null,
        candidate.launchedDateStatus === "missing" ? "上架日期" : null,
      ].filter((value): value is string => value !== null),
      evidenceStatus: candidate.evidenceStatus,
      promotionEligible: candidate.promotionEligible,
      evidence: {
        evidenceId: candidate.evidenceId,
        evidenceVersion: candidate.evidenceVersion,
        capturedAt: candidate.capturedAt,
        contentHash: candidate.contentHash,
      },
    }));

  return {
    version: "market-sample-candidate-coverage.v1",
    sourceBatchId: input.sourceBatchId,
    sampleHash: input.sampleHash,
    sourceBatchCandidateCount: input.candidates.length,
    lockedSampleCount: input.lockedSampleAsins.length,
    outsideCount: outsideCandidates.length,
    outsideCandidates,
  };
}
