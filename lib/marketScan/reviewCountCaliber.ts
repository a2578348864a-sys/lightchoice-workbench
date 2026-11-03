/**
 * 评论量口径（reviewCount caliber）。
 *
 * 背景（真实数据，2026-10-13 同一天、同一 ASIN）：
 * - 搜索卡片读数与商品页读数不一致：27 / 27,477、123 / 123,796、3 / 3,354 ……；
 *   每一组的小值都恰好是大值「千分位之前的前缀」。累计评价数是单调不减的，
 *   在商品页已读到 27,477 之后再读到 27 是不可能的下降，因此该锁定读数不可信。
 * - 也有商品页与搜索卡片一致的情况（39、570、225 …… 均小于 1000，不存在千分位）。
 *
 * 本模块只做「读数是否可复核」的判定，不改写任何证据、快照或事实：
 * - `verified`：锁定的读数来自商品页，或有商品页读数与它一致；
 * - `conflict`：同主体商品页读数与锁定读数在时间上无法用增长解释（见 monotonicity）；
 * - `unverified`：只有搜索卡片等非商品页读数，没有可复核对照；
 * - `missing`：没有任何读数。
 *
 * 允许并列保留原始读数；调用方（统计/AI 输入）不得把 conflict / unverified 当已知值使用。
 */

export type ReviewCountSurface = "detail" | "search" | "other";

export type ReviewCountObservation = {
  value: number;
  capturedAt: string;
  evidenceId: string;
  version: number | null;
  surface: ReviewCountSurface;
};

export type ReviewCountCaliberState = "verified" | "conflict" | "unverified" | "missing";

export type ReviewCountCaliber = {
  state: ReviewCountCaliberState;
  /** 锁定样本里的读数（原样保留，不替换）。 */
  lockedValue: number | null;
  lockedSurface: ReviewCountSurface;
  /** 同主体商品页读数（用于并列展示，不代表已被采纳）。 */
  productPageValue: number | null;
  productPageCapturedAt: string | null;
  productPageEvidenceId: string | null;
  /** 与锁定读数无法共存的商品页读数，原样保留。 */
  conflicts: ReviewCountObservation[];
  reason: string | null;
};

const AMAZON_HOST = /(^|\.)amazon\./i;
const PRODUCT_PATH = /\/dp\/[A-Z0-9]{10}(?:\/|$)/i;
const SEARCH_MARKERS = /\/ref=sr_|^\/s$/i;

/**
 * 判断读数来自哪种页面，字段语义不同、可信度不同：
 * 商品页（/dp/...）是累计评价数的规范来源；搜索卡片是列表页投影。
 */
export function classifyReviewSurface(sourceUrl: string | null | undefined): ReviewCountSurface {
  if (typeof sourceUrl !== "string" || !sourceUrl.trim()) return "other";
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return "other";
  }
  if (!AMAZON_HOST.test(parsed.hostname)) return "other";
  if (!PRODUCT_PATH.test(parsed.pathname)) return "other";
  if (SEARCH_MARKERS.test(parsed.pathname)) return "search";
  const params = parsed.searchParams;
  if (params.has("keywords") || params.has("k") || params.has("qid") || params.has("sr")) return "search";
  return "detail";
}

const validValue = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** 同一 evidenceId 只保留一次；按采集时间升序。 */
export function dedupeObservations(observations: readonly ReviewCountObservation[]): ReviewCountObservation[] {
  const byEvidence = new Map<string, ReviewCountObservation>();
  for (const observation of observations) {
    if (!validValue(observation.value) || !observation.evidenceId) continue;
    if (!byEvidence.has(observation.evidenceId)) byEvidence.set(observation.evidenceId, observation);
  }
  return [...byEvidence.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

export function assessReviewCount(input: {
  lockedValue: number | null;
  lockedCapturedAt: string | null;
  lockedSourceUrl: string | null;
  observations?: readonly ReviewCountObservation[];
}): ReviewCountCaliber {
  const lockedSurface = classifyReviewSurface(input.lockedSourceUrl);
  const observations = dedupeObservations(input.observations ?? []);
  const productPage = observations.filter((observation) => observation.surface === "detail");
  const latestProductPage = productPage.at(-1) ?? null;
  const base = {
    lockedValue: validValue(input.lockedValue) ? input.lockedValue : null,
    lockedSurface,
    productPageValue: latestProductPage?.value ?? null,
    productPageCapturedAt: latestProductPage?.capturedAt ?? null,
    productPageEvidenceId: latestProductPage?.evidenceId ?? null,
  };

  if (base.lockedValue === null) {
    return { ...base, state: "missing", conflicts: [], reason: "no_reading" };
  }
  const lockedValue = base.lockedValue;
  const lockedCapturedAt = input.lockedCapturedAt ?? "";
  // 累计评价数只能增长：商品页在锁定读数之前（或同时）就读到更大的值，锁定读数必然有误。
  const contradictedBefore = productPage.filter((observation) => observation.value > lockedValue && observation.capturedAt <= lockedCapturedAt);
  // 锁定读数来自商品页，却比更晚的商品页读数还大：同样不成立。
  const contradictedAfter = lockedSurface === "detail"
    ? productPage.filter((observation) => observation.value < lockedValue && observation.capturedAt >= lockedCapturedAt)
    : [];
  const conflicts = dedupeObservations([...contradictedBefore, ...contradictedAfter]);
  if (conflicts.length) {
    return { ...base, state: "conflict", conflicts, reason: "product_page_reading_incompatible" };
  }
  if (productPage.length || lockedSurface === "detail") {
    return { ...base, state: "verified", conflicts: [], reason: lockedSurface === "detail" ? "product_page_surface" : "product_page_agrees" };
  }
  return { ...base, state: "unverified", conflicts: [], reason: "search_surface_only" };
}
