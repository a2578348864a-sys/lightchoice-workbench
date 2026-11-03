import type {
  CollectionPageStatus,
  ObservedMarketContext,
  RequestedMarketContext,
} from "../../../lib/upstream/contracts";

export type AmazonCollectorOptions = {
  query: string;
  page: number;
  maxAppearances: number;
  capturedAt: string;
  pageUrl?: string;
  requested: RequestedMarketContext;
  observed: ObservedMarketContext;
};

export type AmazonPageContextSignals = {
  pageUrl: string;
  amazonBrandMarkerPresent: boolean;
  deliveryRegion: string | null;
  language: string | null;
};

export type AmazonSponsoredPlacementDiagnostic = {
  schemaVersion: "amazon-sponsored-placement-diagnostic.v1";
  state: boolean | null;
  markerSource: "known_dom_selector" | "visible_text" | "known_card_structure" | "none";
  selectorCategory:
    | "aria_label_sponsored"
    | "sponsored_label_class"
    | "sponsored_component_marker"
    | "ambiguous_ad_text"
    | "standard_search_result_card"
    | "unrecognized_card_structure";
  reasonCode:
    | "sponsored_marker_present"
    | "known_organic_structure"
    | "ambiguous_ad_text_without_known_marker"
    | "insufficient_sponsored_evidence";
  matchedText: string | null;
};

export type AmazonCouponObservation = {
  text: string | null;
  amount: number | null;
  percent: number | null;
  currency: string | null;
};

/** 搜索卡片的稳定结构；V2 新增字段可缺省，以兼容历史 fixture 与诊断回放。 */
export type AmazonSearchObservation = {
  appearanceKey: string;
  page: number;
  position: number;
  sponsored: boolean | null;
  sponsoredFlag?: boolean | null;
  naturalRank?: number | null;
  sponsoredDiagnostic: AmazonSponsoredPlacementDiagnostic;
  asin: string | null;
  identityMissingReason: string | null;
  title: string | null;
  priceText: string | null;
  priceCurrency: "USD" | "JPY" | null;
  ratingText: string | null;
  reviewCountText: string | null;
  brand: string | null;
  coupon?: AmazonCouponObservation | null;
  bestSellerBadge?: boolean | null;
  amazonChoiceBadge?: boolean | null;
  boughtPastMonth?: number | null;
  observedProductUrl?: string;
  productUrl: string | null;
  imageUrl: string | null;
  capturedAt: string;
  fieldMissingReasons: Record<string, string>;
};

export type AmazonSearchPageExtraction = {
  schemaVersion: "amazon-search-page-extraction.v2";
  requested: RequestedMarketContext;
  observed: ObservedMarketContext;
  query: string;
  page: number;
  capturedAt: string;
  pageStatus: CollectionPageStatus;
  blocked: boolean;
  keyContainerFound: boolean;
  rawCardCount: number;
  sampledObservationIds: string[];
  diagnosticVisiblePriceNodeCount: number;
  observations: AmazonSearchObservation[];
};

export function sanitizeCollectorText(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

export function buildCanonicalAmazonProductUrl(asin: string): string {
  const normalized = asin.trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(normalized)) throw new Error("AMAZON_ASIN_INVALID");
  return `https://www.amazon.com/dp/${normalized}`;
}

/**
 * 返回搜索卡片中实际观察到的商品链接。
 *
 * 搜索结果里的 ASIN 只能证明身份，不能凭空构造来源 URL。只有当卡片
 * 暴露的链接能绑定到同一 ASIN、且仍在 Amazon US 站点时，才接受它作为
 * source binding；其余情况必须保留为 null 进入隔离路径。
 */
export function extractObservedAmazonProductUrl(
  card: HTMLElement,
  asin: string | null,
  pageUrl: string,
): string | null {
  if (!asin) return null;
  const anchor = card.querySelector<HTMLAnchorElement>(
    "h2 a[href], a.a-link-normal[href*='/dp/'], a[href*='/gp/product/'], a[href*='/gp/aw/d/']",
  );
  const href = sanitizeCollectorText(anchor?.getAttribute("href"), 2048);
  if (!href) return null;
  try {
    const url = new URL(href, pageUrl);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (hostname !== "amazon.com" && !hostname.endsWith(".amazon.com"))) return null;
    const urlAsin = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i.exec(url.pathname)?.[1]?.toUpperCase();
    if (urlAsin !== asin.toUpperCase()) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function detectPriceCurrency(priceText: string | null): "USD" | "JPY" | null {
  if (!priceText) return null;
  const normalized = priceText.trim().toUpperCase();
  if (/\bJPY\b|[\u00A5\uFFE5]/.test(normalized)) return "JPY";
  if (/\bUSD\b|US\$|^\$/.test(normalized)) return "USD";
  return null;
}

export function inspectAmazonPageContext(root: Document, pageUrl: string): AmazonPageContextSignals {
  const deliveryNode = root.querySelector?.("#glow-ingress-line2, #glow-ingress-block");
  const brandMarker = root.querySelector?.("#nav-logo, [aria-label='Amazon'], [aria-label^='Amazon']");
  return {
    pageUrl,
    amazonBrandMarkerPresent: brandMarker !== null && brandMarker !== undefined,
    deliveryRegion: sanitizeCollectorText(deliveryNode?.textContent, 160),
    language: sanitizeCollectorText(root.documentElement?.getAttribute?.("lang"), 40)?.toLowerCase() ?? null,
  };
}

export function deriveObservedAmazonMarketContext(
  signals: AmazonPageContextSignals,
  sampledPriceCurrencies: Array<"USD" | "JPY" | null>,
  expectedPostalCode: string,
): ObservedMarketContext {
  let hostname: string | null = null;
  try {
    const url = new URL(signals.pageUrl);
    hostname = url.protocol === "https:" ? url.hostname.toLowerCase() : null;
  } catch {
    hostname = null;
  }
  const marketplace = signals.amazonBrandMarkerPresent && (hostname === "amazon.com" || hostname === "www.amazon.com")
    ? "amazon.com"
    : null;
  const normalizedPostalCode = expectedPostalCode.trim();
  // The browser profile may already be calibrated to another valid US ZIP.
  // Preserve the caller's preferred ZIP as a fast path, but accept any
  // explicitly observed US ZIP/region marker; the evidence is still page DOM,
  // never a guessed marketplace.
  const deliveryRegion = signals.deliveryRegion ?? "";
  const deliveryRegionMarket = (
    (normalizedPostalCode.length > 0 && deliveryRegion.includes(normalizedPostalCode))
    || /\b\d{5}(?:-\d{4})?\b/.test(deliveryRegion)
    || /\b(?:new york|ny|united states|usa)\b/i.test(deliveryRegion)
  )
    ? "US"
    : null;
  const pricedCurrencies = sampledPriceCurrencies.filter((value): value is "USD" | "JPY" => value !== null);
  const uniqueCurrencies = new Set(pricedCurrencies);
  // 无价格样本（例如 "See options"）不构成币种证据，也不与已观测币种冲突；
  // 但必须至少有一个明确观测，且所有已观测币种一致，避免把「未读到」或混合币种推断成 USD。
  const currency = pricedCurrencies.length > 0 && uniqueCurrencies.size === 1 ? pricedCurrencies[0] : null;
  const market = marketplace === "amazon.com" && deliveryRegionMarket === "US" ? "US" : null;
  return {
    marketplace,
    market,
    currency,
    deliveryRegion: signals.deliveryRegion,
    deliveryRegionMarket,
    language: signals.language,
  };
}

function detectPageStatus(bodySample: string, cardCount: number): CollectionPageStatus {
  if (/captcha|robot check|enter the characters you see|type the characters you see|验证码|机器人/i.test(bodySample)) {
    return "captcha";
  }
  if (/sign in to continue|login to continue|please sign in|登录后继续/i.test(bodySample)) return "login_wall";
  if (/sorry[, ]+something went wrong|service unavailable|internal server error|页面出错/i.test(bodySample)) {
    return "error_page";
  }
  if (/no results for|did not match any products|no exact matches|没有找到结果|无结果/i.test(bodySample)) {
    return "ok";
  }
  return cardCount > 0 ? "ok" : "unknown_page";
}

function firstCardText(card: HTMLElement, selectors: readonly string[], maxLength: number): string | null {
  for (const selector of selectors) {
    const node = card.querySelector(selector);
    const text = sanitizeCollectorText(node?.textContent, maxLength);
    if (text) return text;
  }
  return null;
}

function parseCardCount(value: string | null): number | null {
  if (!value) return null;
  const match = /([0-9][0-9,]*(?:\.[0-9]+)?)(?:\s*[kK])?/.exec(value);
  if (!match) return null;
  const suffixK = /[0-9]\s*[kK]\b/.test(value);
  const parsed = Number(match[1].replace(/,/g, "")) * (suffixK ? 1000 : 1);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseCoupon(value: string | null): AmazonCouponObservation | null {
  if (!value) return null;
  const amountMatch = /(?:US\$|\$)\s*([0-9]+(?:\.[0-9]{1,2})?)/.exec(value);
  const percentMatch = /([0-9]+(?:\.[0-9]+)?)\s*%/.exec(value);
  return {
    text: value,
    amount: amountMatch ? Number(amountMatch[1]) : null,
    percent: percentMatch ? Number(percentMatch[1]) : null,
    currency: amountMatch ? "USD" : null,
  };
}

function badgeState(card: HTMLElement, selectors: readonly string[], pattern: RegExp): boolean | null {
  for (const selector of selectors) {
    if (card.querySelector(selector)) return true;
  }
  const text = sanitizeCollectorText(card.textContent, 500) ?? "";
  return pattern.test(text) ? true : null;
}

export function extractSponsoredPlacementDiagnostic(
  card: HTMLElement,
  asin: string | null,
): AmazonSponsoredPlacementDiagnostic {
  const knownMarkers = [
    {
      selector: '[aria-label="Sponsored"], [aria-label^="Sponsored"]',
      selectorCategory: "aria_label_sponsored" as const,
    },
    {
      selector: ".puis-sponsored-label-text",
      selectorCategory: "sponsored_label_class" as const,
    },
    {
      selector: '[data-component-type="s-sponsored-label-marker"]',
      selectorCategory: "sponsored_component_marker" as const,
    },
  ];
  for (const knownMarker of knownMarkers) {
    const marker = card.querySelector(knownMarker.selector);
    if (!marker) continue;
    return {
      schemaVersion: "amazon-sponsored-placement-diagnostic.v1",
      state: true,
      markerSource: "known_dom_selector",
      selectorCategory: knownMarker.selectorCategory,
      reasonCode: "sponsored_marker_present",
      matchedText: sanitizeCollectorText(marker.getAttribute?.("aria-label") ?? marker.textContent, 80),
    };
  }

  const visibleText = sanitizeCollectorText(card.innerText || card.textContent, 500) ?? "";
  const ambiguousAdText = visibleText.match(/\b(?:sponsored|promoted|advertisement|ad)\b|广告|推广/i)?.[0] ?? null;
  if (ambiguousAdText) {
    return {
      schemaVersion: "amazon-sponsored-placement-diagnostic.v1",
      state: null,
      markerSource: "visible_text",
      selectorCategory: "ambiguous_ad_text",
      reasonCode: "ambiguous_ad_text_without_known_marker",
      matchedText: sanitizeCollectorText(ambiguousAdText, 40),
    };
  }

  const knownOrganicStructure = asin !== null
    && (card.querySelector("h2 a span") !== null || card.querySelector("h2 span") !== null)
    && (card.querySelector(".a-price .a-offscreen") !== null || card.querySelector("img.s-image") !== null);
  if (knownOrganicStructure) {
    return {
      schemaVersion: "amazon-sponsored-placement-diagnostic.v1",
      state: false,
      markerSource: "known_card_structure",
      selectorCategory: "standard_search_result_card",
      reasonCode: "known_organic_structure",
      matchedText: null,
    };
  }
  return {
    schemaVersion: "amazon-sponsored-placement-diagnostic.v1",
    state: null,
    markerSource: "none",
    selectorCategory: "unrecognized_card_structure",
    reasonCode: "insufficient_sponsored_evidence",
    matchedText: null,
  };
}

export function extractAmazonSearchPage(root: Document, options: AmazonCollectorOptions): AmazonSearchPageExtraction {
  if (!options.query.trim()) throw new Error("COLLECTOR_QUERY_REQUIRED");
  if (!Number.isInteger(options.page) || options.page < 1 || options.page > 2) throw new Error("COLLECTOR_PAGE_OUT_OF_RANGE");
  if (!Number.isInteger(options.maxAppearances) || options.maxAppearances < 1 || options.maxAppearances > 60) {
    throw new Error("COLLECTOR_SAMPLE_BUDGET_INVALID");
  }

  const bodySample = sanitizeCollectorText(root.body?.innerText, 4000) ?? "";
  const allCards = Array.from(root.querySelectorAll<HTMLElement>('[data-component-type="s-search-result"]'));
  const pageStatus = detectPageStatus(bodySample, allCards.length);
  let naturalRank = 0;
  const observations = allCards.slice(0, options.maxAppearances).map((card, index) => {
    const rawAsin = sanitizeCollectorText(card.getAttribute("data-asin"), 20);
    const asin = rawAsin && /^[A-Z0-9]{10}$/i.test(rawAsin) ? rawAsin.toUpperCase() : null;
    const priceText = sanitizeCollectorText(card.querySelector(".a-price .a-offscreen")?.textContent, 60);
    const ratingText = sanitizeCollectorText(card.querySelector(".a-icon-alt")?.textContent, 80);
    const reviewNode = card.querySelector('a[href*="customerReviews"] span, a[href*="#customerReviews"] span');
    const imageNode = card.querySelector("img.s-image");
    const sponsoredDiagnostic = extractSponsoredPlacementDiagnostic(card, asin);
    const sponsored = sponsoredDiagnostic.state;
    const titleNode = card.querySelector("h2 a span") ?? card.querySelector("h2 span");
    const observedProductUrl = extractObservedAmazonProductUrl(card, asin, options.pageUrl ?? "https://www.amazon.com/");
    // Amazon's current cards do not expose a stable brand-only node.  The
    // former generic .a-row selector can contain Prime/inline script text;
    // keep this field missing rather than persisting page chrome as a brand.
    const brand = null;
    const couponText = firstCardText(card, [
      ".s-coupon-unclipped",
      ".couponBadge",
      "[data-cy='coupon']",
    ], 160);
    const boughtPastMonthText = firstCardText(card, [
      "[data-cy='reviews-block']",
      ".a-size-base.a-color-secondary",
    ], 120);
    const coupon = parseCoupon(couponText);
    const boughtMatch = boughtPastMonthText
      ? /([0-9][0-9,.]*\s*[kK]?\+?)\s+bought\s+in\s+past\s+month/i.exec(boughtPastMonthText)
      : null;
    const rank = sponsored === false ? ++naturalRank : null;
    const fieldMissingReasons: Record<string, string> = {
      brand: "not_exposed_on_search_card",
      ...(sponsored === null ? { sponsored: "not_determined" } : {}),
      ...(priceText ? {} : { price: "not_visible" }),
      ...(ratingText ? {} : { rating: "not_visible" }),
      ...(reviewNode ? {} : { reviewCount: "not_visible" }),
      ...(imageNode ? {} : { imageUrl: "not_visible" }),
    };
    return {
      appearanceKey: `canary-p${options.page}-${String(index + 1).padStart(2, "0")}`,
      page: options.page,
      position: index + 1,
      sponsored,
      sponsoredDiagnostic,
      asin,
      naturalRank: rank,
      sponsoredFlag: sponsored,
      identityMissingReason: asin ? null : "asin_not_found",
      title: sanitizeCollectorText(titleNode?.textContent, 300),
      priceText,
      priceCurrency: detectPriceCurrency(priceText),
      ratingText,
      reviewCountText: sanitizeCollectorText(reviewNode?.textContent, 60),
      brand,
      coupon,
      bestSellerBadge: badgeState(card, [".a-badge-label", "[data-cy='best-seller-badge']"], /#1\s*Best Seller|Best Seller/i),
      amazonChoiceBadge: badgeState(card, ["[data-cy='amazon-choice-badge']", "[aria-label*='Amazon Choice']"], /Amazon'?s Choice/i),
      boughtPastMonth: parseCardCount(boughtMatch?.[1] ?? null),
      ...(observedProductUrl ? { observedProductUrl } : {}),
      productUrl: asin ? buildCanonicalAmazonProductUrl(asin) : null,
      imageUrl: sanitizeCollectorText(imageNode?.getAttribute("src"), 2048),
      capturedAt: options.capturedAt,
      fieldMissingReasons,
    };
  });

  return {
    schemaVersion: "amazon-search-page-extraction.v2" as const,
    requested: { ...options.requested },
    observed: { ...options.observed },
    query: options.query.trim(),
    page: options.page,
    capturedAt: options.capturedAt,
    pageStatus,
    blocked: pageStatus !== "ok",
    keyContainerFound: allCards.length > 0,
    rawCardCount: allCards.length,
    sampledObservationIds: observations.map((item) => item.appearanceKey),
    diagnosticVisiblePriceNodeCount: root.querySelectorAll(".a-price .a-offscreen").length,
    observations,
  };
}

/**
 * 浏览器端表达式（P1-A）：改用 self-contained 字符串工件（search-page-expression-source.ts），
 * 不再 fn.toString() 序列化模块函数（生产 minify 会重命名标识符导致 ReferenceError）。
 */
export { buildAmazonSearchPageExtractionExpression, buildAmazonPageContextExpression } from "@/tools/collectors/amazon/search-page-expression-source";
export type { AmazonSearchExpressionOptions } from "@/tools/collectors/amazon/search-page-expression-source";
