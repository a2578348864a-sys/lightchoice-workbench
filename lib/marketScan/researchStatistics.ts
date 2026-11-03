import type { MarketIntelligence, MarketIntelligenceSample, MarketReviewResult, MarketVoiceCoverage } from "./intelligence";
import { distribution, marketKeywordCategory } from "./intelligence";

export const RESEARCH_STATISTICS_VERSION = "keyword-market-statistics.v1";
export type ResearchStatistics = ReturnType<typeof buildResearchStatistics> & { hash: string };

/** Coverage is derived from validated per-review results, never from model-written counts. */
export function buildVoiceCoverage(results: MarketReviewResult[], reviews: MarketIntelligence["reviews"], available: number): MarketVoiceCoverage {
  const byId = new Map(reviews.filter((review) => review.id).map((review) => [review.id!, review]));
  const subjects = new Set<string>();
  let lowStarSampled = 0;
  for (const result of results) {
    const review = byId.get(result.reviewId);
    if (!review) continue;
    for (const subject of review.subjectKeys ?? [review.subjectKey]) subjects.add(subject);
    if (review.rating !== null && review.rating >= 1 && review.rating <= 3) lowStarSampled += 1;
  }
  return {
    available, sampled: results.length,
    themed: results.filter((result) => result.status === "themed").length,
    noMatch: results.filter((result) => result.status === "no_match").length,
    unable: results.filter((result) => result.status === "unable").length,
    sampledProducts: subjects.size, lowStarSampled,
    samplePolicy: "低星优先、非随机抽样；数量只描述本次输入子集，不能推断全部评论或全体买家的发生率。",
  };
}

/** A display search never changes this persisted, explicitly approved subject set. */
export function approvedResearchSubjects(definition: unknown): Set<string> | null {
  const state = (definition as { marketIntelligence?: { analysisSampleKeys?: unknown } } | null)?.marketIntelligence;
  return Array.isArray(state?.analysisSampleKeys) ? new Set(state.analysisSampleKeys.filter((key): key is string => typeof key === "string")) : null;
}

const median = (numbers: number[]) => {
  const sorted = [...numbers].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : null;
};
const value = (number: unknown): number is number => typeof number === "number" && Number.isFinite(number) && number >= 0;

/** Same-ASIN conflicting frozen readings are excluded, never arbitrarily chosen. Observations remain in EvidenceStore. */
export function uniqueResearchSamples(samples: MarketIntelligenceSample[]) {
  const byIdentity = new Map<string, MarketIntelligenceSample | null>();
  for (const sample of samples) {
    if (!byIdentity.has(sample.subjectKey)) byIdentity.set(sample.subjectKey, sample);
    else {
      const current = byIdentity.get(sample.subjectKey);
      if (current && JSON.stringify({ ...current, evidence: undefined }) !== JSON.stringify({ ...sample, evidence: undefined })) byIdentity.set(sample.subjectKey, null);
    }
  }
  return [...byIdentity.values()].filter((sample): sample is MarketIntelligenceSample => sample !== null);
}

const VOC_RULES = [
  { id: "cleaning", label: "清洁困难或残留", expression: /hard to clean|difficult to clean|(?:can.?t|cannot|couldn.?t).*clean|greasy after|stains? (?:won.?t|remain)|难清洗|清洗困难|洗不掉/iu },
  { id: "slipping", label: "打滑或不易固定", expression: /too slippery|slips? (?:around|off)|slides? (?:around|off)|keeps? sliding|打滑|固定不住/iu },
  { id: "durability", label: "破损或耐用性问题", expression: /(?:broke|broken|tore|ripped|cracked|falling apart)|不耐用|破损|开裂/iu },
  { id: "fit", label: "尺寸或适配问题", expression: /too (?:small|large|big|short)|does(?:n.?t| not) fit|wrong size|尺寸不符|放不下/iu },
  { id: "odor", label: "气味问题", expression: /strong (?:smell|odor)|smells? (?:bad|like chemicals)|chemical smell|异味|刺鼻/iu },
] as const;

/**
 * 展示层：把「确定性短语规则」命中的字面片段切出来，用于原文强调。
 * 只切分文本、不新增判断：命中的仍是同一条 VOC_RULES 表达式，
 * 与 voc 统计同源；不改变原文内容，也不把命中升级为结论。
 */
export function voicePhraseSegments(ruleId: string, text: string): Array<{ text: string; hit: boolean }> {
  const rule = VOC_RULES.find((item) => item.id === ruleId);
  if (!rule || !text) return [{ text, hit: false }];
  const scanner = new RegExp(rule.expression.source, "giu");
  const segments: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const match of text.matchAll(scanner)) {
    const start = match.index ?? 0;
    if (!match[0]) continue;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), hit: false });
    segments.push({ text: match[0], hit: true });
    cursor = start + match[0].length;
  }
  if (!segments.length) return [{ text, hit: false }];
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}

/** The sole numeric read model for charts and model input. No browser or model recomputation. */
export function buildResearchStatistics(data: Pick<MarketIntelligence, "samples" | "reviews" | "keywords" | "trends" | "sources">, approved: Set<string> | null = null) {
  const unique = uniqueResearchSamples(data.samples), technicallyValid = unique.filter((s) => s.valid);
  const samples = technicallyValid.filter((s) => approved === null || approved.has(s.subjectKey));
  const subjects = new Set(samples.map((s) => s.subjectKey));
  const currencies = [...new Set(samples.filter((s) => value(s.price) && s.priceCurrency).map((s) => s.priceCurrency!))].sort();
  const prices = currencies.map((currency) => {
    const entries = samples.filter((s) => s.priceCurrency === currency && value(s.price)), numbers = entries.map((s) => s.price!);
    return { currency, denominator: numbers.length, median: median(numbers), min: numbers.length ? Math.min(...numbers) : null, max: numbers.length ? Math.max(...numbers) : null, bins: distribution(numbers, [0, 10, 20, 30, 50, 100]), subjects: entries.map((s) => s.subjectKey) };
  });
  const ratings = samples.filter((s) => value(s.rating) && s.rating! <= 5);
  // 评论量：只有「商品页读数或与商品页一致」的锁定值才进入分布。
  // 搜索卡片读数（27,477 → 27 一类）与商品页冲突的读数并列保留，但不得当作已知值参与统计。
  const reviewReadings = samples.filter((s) => value(s.reviewCount));
  const reviewStates = reviewReadings.map((s) => s.reviewCountCaliber?.state);
  const reviewValues = reviewReadings.filter((_, index) => reviewStates[index] === undefined || reviewStates[index] === "verified").map((s) => s.reviewCountCaliber?.lockedValue ?? s.reviewCount!);
  const reviewConflicts = reviewReadings.filter((s) => s.reviewCountCaliber?.state === "conflict").map((s) => ({
    subjectKey: s.subjectKey, asin: s.asin,
    lockedValue: s.reviewCountCaliber!.lockedValue, lockedSurface: s.reviewCountCaliber!.lockedSurface,
    lockedCapturedAt: s.evidence.capturedAt, lockedEvidenceId: s.evidence.evidenceId,
    productPageValue: s.reviewCountCaliber!.productPageValue,
    productPageCapturedAt: s.reviewCountCaliber!.productPageCapturedAt,
    productPageEvidenceId: s.reviewCountCaliber!.productPageEvidenceId,
  }));
  const reviewUnverified = reviewReadings.filter((s) => s.reviewCountCaliber?.state === "unverified");
  const brands = new Map<string, number>();
  for (const sample of samples) if (sample.brand) brands.set(sample.brand, (brands.get(sample.brand) ?? 0) + 1);
  const reviews = data.reviews.filter((r) => subjects.has(r.subjectKey));
  const voc = VOC_RULES.map((rule) => {
    const matches = reviews.filter((r) => rule.expression.test(`${r.title ?? ""} ${r.text}`));
    return { id: rule.id, label: rule.label, count: matches.length, denominator: reviews.length, productCount: new Set(matches.flatMap((r) => r.subjectKeys ?? [r.subjectKey]).filter((key) => subjects.has(key))).size, reviewIds: matches.map((r) => r.id ?? r.evidence.id), nature: "calculation" as const, method: "明确短语规则命中，仅作待核实线索，不是AI结论；同一评论可命中多个主题" };
  });
  const keywordRows = data.keywords.filter((k) => subjects.has(k.subjectKey) || k.subjectKey.startsWith("sellersprite:"));
  const searchRows = keywordRows.filter((k) => value(k.searchVolume));
  // 两类关键词必须分开计数：种子词挖掘是「市场需求」，ASIN 反查是「竞品流量词」，分母不可相加。
  const marketKeywordRows = keywordRows.filter((k) => marketKeywordCategory(k.module) === "market_keyword_demand");
  const competitorKeywordRows = keywordRows.filter((k) => marketKeywordCategory(k.module) === "competitor_traffic_keyword");
  const unclassifiedKeywordRows = keywordRows.length - marketKeywordRows.length - competitorKeywordRows.length;
  return {
    schema: RESEARCH_STATISTICS_VERSION, rawCount: data.samples.length, uniqueCount: unique.length,
    technicallyValidCount: technicallyValid.length, sampleCount: samples.length, excludedCount: technicallyValid.length - samples.length,
    subjects: samples.map((s) => s.subjectKey).sort(), prices,
    rating: { denominator: ratings.length, mean: ratings.length ? ratings.reduce((n, s) => n + s.rating!, 0) / ratings.length : null, bins: distribution(ratings.map((s) => s.rating!), [0, 3, 4, 4.5, 4.8, 5]) },
    reviewCount: {
      denominator: reviewValues.length, median: median(reviewValues), bins: distribution(reviewValues, [0, 50, 200, 1000, 5000, 10000]),
      lockedCount: reviewReadings.length, verifiedCount: reviewValues.length,
      conflictCount: reviewConflicts.length, unverifiedCount: reviewUnverified.length,
      unclassifiedCount: reviewStates.filter((state) => state === undefined).length,
      conflicts: reviewConflicts, unverifiedSubjects: reviewUnverified.map((s) => s.subjectKey).sort(),
      policy: "只统计有商品页读数或与商品页一致的商品累计评价数；搜索卡片单次读数、与商品页冲突的读数并列保留但不进入分布。商品累计评价数不是本次读取的评论条数，也不是销量。",
    },
    brands: { basis: "known_brand_product_count", denominator: samples.filter((s) => s.brand).length, missing: samples.filter((s) => !s.brand).length, coverage: samples.length ? samples.filter((s) => s.brand).length / samples.length : null, rows: [...brands].map(([brand, count]) => ({ brand, count, share: count / samples.filter((s) => s.brand).length })).sort((a, b) => b.count - a.count || a.brand.localeCompare(b.brand)) },
    reviews: { total: reviews.length, rated: reviews.filter((r) => value(r.rating)).length, lowStars: reviews.filter((r) => r.rating !== null && r.rating >= 1 && r.rating <= 3).length, highStars: reviews.filter((r) => r.rating !== null && r.rating >= 4 && r.rating <= 5).length, bins: [1, 2, 3, 4, 5].map((star) => ({ label: `${star}星`, count: reviews.filter((r) => r.rating !== null && Math.floor(r.rating) === star).length })), policy: "本次从已保存证据去重后读取到的评论条数（低星优先、非随机抽样）；与商品累计评价数（reviewCount）不是同一口径，不能互相替代或相加。" },
    voc, keywords: {
      rows: keywordRows.length, withSearchVolume: searchRows.length, policy: "不同关键词/来源的搜索量不相加；第三方估算不等于销量或全市场规模",
      market: { rows: marketKeywordRows.length, withSearchVolume: marketKeywordRows.filter((k) => value(k.searchVolume)).length, withMonthlyPurchase: marketKeywordRows.filter((k) => k.metrics.estimatedMonthlyPurchase?.value != null).length, subjects: [...new Set(marketKeywordRows.map((k) => k.subjectKey))].sort() },
      competitorTraffic: { rows: competitorKeywordRows.length, withTrafficShare: competitorKeywordRows.filter((k) => k.metrics.trafficShare?.value != null).length, withSearchVolume: competitorKeywordRows.filter((k) => value(k.searchVolume)).length, subjects: [...new Set(competitorKeywordRows.map((k) => k.subjectKey))].sort() },
      unclassified: unclassifiedKeywordRows,
      separationPolicy: "市场关键词需求（种子词查询）与竞品流量关键词（ASIN 反查）是两类数据集：分别统计、不相加、不跨主体去重、不共用分母。",
    },
    modules: ["sellersprite_product_market", "reverse_asin", "keyword_mining_trend", "historical_trend"].map((module) => {
      const sources = data.sources.filter((s) => s.module === module && (subjects.has(s.subjectKey) || s.scope === "query"));
      return { module, total: sources.length, usable: sources.filter((s) => s.status === "available" || s.status === "partial").length, blocked: sources.filter((s) => s.status === "blocked").length, unusable: sources.filter((s) => s.status === "unusable").length };
    }),
    timeRange: { from: samples.map((s) => s.evidence.capturedAt).sort()[0] ?? null, to: samples.map((s) => s.evidence.capturedAt).sort().at(-1) ?? null },
    evidenceRefs: [...new Set(samples.flatMap((s) => [s.evidence.id, ...(s.brandEvidence ? [s.brandEvidence.id] : [])]))].sort(),
  };
}
