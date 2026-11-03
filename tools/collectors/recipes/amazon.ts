import type { SourceLayerErrorCode } from "@/lib/sourceLayer/errorCodes";
import type {
  BoughtPastMonthValue,
  CaptureEntityBindingProof,
} from "@/lib/sourceLayer/capturePackage";
import type { AmazonDetailPageExtraction } from "@/tools/collectors/amazon/detail-page-extract";
import {
  type AmazonDetailPageExtractionV2,
} from "@/tools/collectors/amazon/detail-page-extract-v2";
import { AMAZON_DETAIL_PRIMARY_BSR_RULE_VERSION } from "@/tools/collectors/amazon/detail-page-field-registry";
import type { AmazonCollectorOptions } from "@/tools/collectors/amazon/extract-search-page";
import { parseObservedCountText } from "@/tools/collectors/amazon/observed-count";

type CapturePageContext = {
  pageClass: string;
  allowFields: boolean;
  errorCode?: SourceLayerErrorCode | null;
  reason?: string | null;
  subjectKey?: string | null;
  marketplace?: string | null;
  entityBinding?: CaptureEntityBindingProof | null;
};

export type AmazonDetailCapturePayload = {
  asin: string;
  title: string | null;
  productUrl: string;
  images?: string[];
  price: number | null;
  currency: "USD";
  rating: number | null;
  reviewCount: number | null;
  bsrRank: number | null;
  bsrCategory: string | null;
  brand?: string | null;
  bulletPoints?: string[] | null;
  launchedDate?: string | null;
  packageWeight?: { value: number; unit: "kg" | "lb" | "oz" | "g" } | null;
  packageDimensions?: { length: number; width: number; height: number; unit: "cm" | "in" } | null;
  itemWeight?: { value: number; unit: "kg" | "lb" | "oz" | "g" } | null;
  itemDimensions?: { length: number; width: number; height: number; unit: "cm" | "in" } | null;
  bsrRanks?: Array<{ rank: number; category: string }> | null;
  subCategoryBsr?: number | null;
  amazonDetail?: {
    schemaVersion: "amazon-detail-registered-fields.v1";
    extractorVersion: "amazon-detail-extractor.v2";
    fieldRegistryVersion: "amazon-detail-field-registry.v1";
    primaryBsrProjectionVersion: "primary-bsr.v1";
    registeredFields: AmazonDetailPageExtractionV2["registeredFields"];
  };
  categoryPath?: string[] | null;
  parentAsin?: string | null;
  material?: string | null;
  includedComponents?: string[] | null;
  galleryImageUrls?: string[] | null;
  listPrice?: { amount: number; currency: string } | null;
  coupon?: { text: string | null; amount: number | null; percent: number | null; currency: string | null } | null;
  seller?: string | null;
  shipsFrom?: string | null;
  fulfillment?: string | null;
  buyBox?: { seller: string | null; price: { amount: number; currency: string } | null } | null;
  ratingDistribution?: Record<string, number> | null;
  boughtPastMonth?: BoughtPastMonthValue | null;
  variations?: string[] | null;
};

export type AmazonDetailCapturePlan =
  | {
    ok: true;
    subjectKey: string;
    sourceUrl: string;
    payload: AmazonDetailCapturePayload;
    pageContext: CapturePageContext;
  }
  | {
    ok: false;
    subjectKey: string | null;
    sourceUrl: string | null;
    payload: { asin?: string };
    pageContext: CapturePageContext;
    errorCode: SourceLayerErrorCode;
    reason: string;
  };

const ASIN = /^[A-Z0-9]{10}$/;

function amazonUrlForAsin(value: string, asin: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || (url.hostname !== "amazon.com" && !url.hostname.endsWith(".amazon.com"))) return false;
    return /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i.exec(url.pathname)?.[1]?.toUpperCase() === asin;
  } catch {
    return false;
  }
}

function bindingFor(input: {
  expectedAsin: string | null;
  observedAsin: string | null;
  urlAsin: string | null;
  urlMarketplace: string | null;
  bound: boolean;
}): CaptureEntityBindingProof {
  return {
    expectedAsin: input.expectedAsin,
    observedAsin: input.observedAsin,
    expectedMarketplace: "US",
    observedMarketplace: input.urlMarketplace,
    urlAsin: input.urlAsin,
    urlMarketplace: input.urlMarketplace,
    bound: input.bound,
  };
}

function errorForPageStatus(status: AmazonDetailPageExtraction["pageStatus"]): SourceLayerErrorCode {
  switch (status) {
    case "captcha": return "CAPTCHA_DETECTED";
    case "login_wall": return "LOGIN_REQUIRED";
    case "automation_blocked": return "AUTOMATION_BLOCKED";
    case "error_page":
    case "unknown_page":
      return "PAGE_CHANGED";
    case "ok":
      return "INTERNAL_UNEXPECTED";
  }
}

function valueOf<T>(field: { value: string | number | null; status: "correct" | "unknown" }): T | null {
  return field.status === "correct" ? field.value as T : null;
}

function isV2Extraction(value: AmazonDetailPageExtraction | AmazonDetailPageExtractionV2): value is AmazonDetailPageExtractionV2 {
  return "registeredFields" in value && value.extractorVersion === "amazon-detail-extractor.v2";
}

function registeredValue<T>(extraction: AmazonDetailPageExtractionV2, canonicalField: string): T | null {
  const field = extraction.registeredFields[canonicalField];
  if (!field || (field.status !== "observed" && field.status !== "derived")) return null;
  return field.value as T;
}

function detailDimensions(value: unknown): { length: number; width: number; height: number; unit: "cm" | "in" } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const observed = value as { dimensions?: unknown; unit?: unknown };
  if (!Array.isArray(observed.dimensions) || observed.dimensions.length !== 3
    || observed.dimensions.some((item) => typeof item !== "number" || !Number.isFinite(item) || item < 0)
    || (observed.unit !== "cm" && observed.unit !== "in")) return null;
  return {
    length: observed.dimensions[0] as number,
    width: observed.dimensions[1] as number,
    height: observed.dimensions[2] as number,
    unit: observed.unit,
  };
}

function detailWeight(value: unknown): { value: number; unit: "kg" | "lb" | "oz" | "g" } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const observed = value as { amount?: unknown; unit?: unknown };
  if (typeof observed.amount !== "number" || !Number.isFinite(observed.amount) || observed.amount < 0
    || !["kg", "lb", "oz", "g"].includes(String(observed.unit))) return null;
  return { value: observed.amount, unit: observed.unit as "kg" | "lb" | "oz" | "g" };
}

/**
 * 把 Amazon 详情页提取结果转换成 Gateway 输入计划。
 * 这里是确定性结构映射：实体绑定或页面状态不满足时只生成零字段门禁计划。
 */
export function planAmazonDetailCapture(input: {
  extraction: AmazonDetailPageExtraction | AmazonDetailPageExtractionV2;
  pageUrl: string;
  imageUrls?: readonly string[];
  brand?: string | null;
  bulletPoints?: readonly string[] | null;
  launchedDate?: string | null;
  packageWeight?: AmazonDetailCapturePayload["packageWeight"];
  packageDimensions?: AmazonDetailCapturePayload["packageDimensions"];
  categoryPath?: AmazonDetailCapturePayload["categoryPath"];
  parentAsin?: AmazonDetailCapturePayload["parentAsin"];
  material?: AmazonDetailCapturePayload["material"];
  includedComponents?: AmazonDetailCapturePayload["includedComponents"];
  galleryImageUrls?: AmazonDetailCapturePayload["galleryImageUrls"];
  listPrice?: AmazonDetailCapturePayload["listPrice"];
  coupon?: AmazonDetailCapturePayload["coupon"];
  seller?: AmazonDetailCapturePayload["seller"];
  shipsFrom?: AmazonDetailCapturePayload["shipsFrom"];
  fulfillment?: AmazonDetailCapturePayload["fulfillment"];
  buyBox?: AmazonDetailCapturePayload["buyBox"];
  ratingDistribution?: AmazonDetailCapturePayload["ratingDistribution"];
  boughtPastMonth?: AmazonDetailCapturePayload["boughtPastMonth"];
  variations?: AmazonDetailCapturePayload["variations"];
}): AmazonDetailCapturePlan {
  const expectedAsin = input.extraction.expectedAsin;
  const subjectKey = expectedAsin && ASIN.test(expectedAsin) ? `amazon:US:${expectedAsin}` : null;
  const urlAsin = input.extraction.urlAsin;
  const sourceUrl = amazonUrlForAsin(input.pageUrl, expectedAsin ?? "") ? input.pageUrl : null;
  const entityBinding = bindingFor({
    expectedAsin,
    observedAsin: input.extraction.pageAsin,
    urlAsin,
    urlMarketplace: sourceUrl ? "US" : null,
    bound: input.extraction.entityBound && sourceUrl !== null,
  });
  const pageContextBase = {
    subjectKey,
    marketplace: "US",
    entityBinding,
  } satisfies Partial<CapturePageContext>;
  const v2Extraction = isV2Extraction(input.extraction) ? input.extraction : null;
  const primaryBsr = v2Extraction ? registeredValue<{ rank: number; category: string }>(v2Extraction, "primaryBsr") : null;
  const bsrRanks = v2Extraction ? registeredValue<Array<{ rank: number; category: string }>>(v2Extraction, "bsrRanks") : null;
  // 小类目 BSR 由 bsrRanks 确定性派生（见 detail-page-extract-v2.ts 的 deriveSubCategoryBsr）；
  // 页面没有报告小类目排名时为 null，不跨页拼值。
  const subCategoryBsr = v2Extraction ? registeredValue<{ rank: number; category: string }>(v2Extraction, "subCategoryBsr") : null;
  const packageWeight = v2Extraction
    ? detailWeight(registeredValue(v2Extraction, "packageWeight"))
    : input.packageWeight ?? null;
  const packageDimensions = v2Extraction
    ? detailDimensions(registeredValue(v2Extraction, "packageDimensions"))
    : input.packageDimensions ?? null;
  const itemWeight = v2Extraction ? detailWeight(registeredValue(v2Extraction, "itemWeight")) : null;
  const itemDimensions = v2Extraction ? detailDimensions(registeredValue(v2Extraction, "itemDimensions")) : null;
  const boughtPastMonth = v2Extraction
    ? registeredValue<BoughtPastMonthValue>(v2Extraction, "boughtPastMonth")
    : input.boughtPastMonth ?? null;
  const dateFirstAvailable = v2Extraction
    ? registeredValue<{ rawText: string }>(v2Extraction, "dateFirstAvailable")?.rawText ?? null
    : input.launchedDate ?? null;
  const amazonDetail = v2Extraction ? {
    schemaVersion: "amazon-detail-registered-fields.v1" as const,
    extractorVersion: v2Extraction.extractorVersion,
    fieldRegistryVersion: v2Extraction.fieldRegistryVersion,
    primaryBsrProjectionVersion: AMAZON_DETAIL_PRIMARY_BSR_RULE_VERSION,
    registeredFields: v2Extraction.registeredFields,
  } : undefined;

  if (
    input.extraction.pageStatus !== "ok"
    || !input.extraction.entityBound
    || !sourceUrl
    || !subjectKey
  ) {
    const errorCode = input.extraction.pageStatus === "ok" && !entityBinding.bound
      ? (urlAsin !== expectedAsin ? "ASIN_NOT_FOUND" : "MARKETPLACE_MISMATCH")
      : errorForPageStatus(input.extraction.pageStatus);
    return {
      ok: false,
      subjectKey,
      sourceUrl,
      payload: expectedAsin ? { asin: expectedAsin } : {},
      pageContext: {
        ...pageContextBase,
        pageClass: `amazon_${input.extraction.pageStatus}`,
        allowFields: false,
        errorCode,
        reason: input.extraction.fields.title.reason ?? "detail_capture_not_allowed",
      },
      errorCode,
      reason: input.extraction.fields.title.reason ?? "detail_capture_not_allowed",
    };
  }

  return {
    ok: true,
    subjectKey,
    sourceUrl,
    payload: {
      asin: expectedAsin as string,
      title: valueOf<string>(input.extraction.fields.title),
      productUrl: sourceUrl,
      images: v2Extraction
        ? [...new Set([
          ...(registeredValue<string>(v2Extraction, "mainImage") ? [registeredValue<string>(v2Extraction, "mainImage") as string] : []),
          ...(registeredValue<string[]>(v2Extraction, "galleryImages") ?? []),
        ])].slice(0, 20)
        : [...(input.imageUrls ?? [])],
      price: valueOf<number>(input.extraction.fields.price),
      currency: "USD",
      rating: valueOf<number>(input.extraction.fields.rating),
      reviewCount: valueOf<number>(input.extraction.fields.reviews),
      bsrRank: primaryBsr?.rank ?? valueOf<number>(input.extraction.fields.bsr),
      bsrCategory: primaryBsr?.category ?? null,
      brand: v2Extraction ? registeredValue<string>(v2Extraction, "brand") : input.brand ?? null,
      bulletPoints: v2Extraction ? registeredValue<string[]>(v2Extraction, "bulletPoints") : input.bulletPoints ? [...input.bulletPoints] : null,
      launchedDate: dateFirstAvailable,
      packageWeight,
      packageDimensions,
      itemWeight,
      itemDimensions,
      bsrRanks,
      subCategoryBsr: subCategoryBsr?.rank ?? null,
      ...(amazonDetail ? { amazonDetail } : {}),
      categoryPath: v2Extraction ? registeredValue<string[]>(v2Extraction, "categoryPath") : input.categoryPath ?? null,
      parentAsin: v2Extraction ? registeredValue<string>(v2Extraction, "parentAsin") : input.parentAsin ?? null,
      material: v2Extraction ? registeredValue<string>(v2Extraction, "material") : input.material ?? null,
      includedComponents: input.includedComponents ?? null,
      galleryImageUrls: v2Extraction ? registeredValue<string[]>(v2Extraction, "galleryImages") : input.galleryImageUrls ?? null,
      listPrice: v2Extraction ? registeredValue<{ amount: number; currency: string }>(v2Extraction, "listPrice") : input.listPrice ?? null,
      coupon: v2Extraction ? registeredValue<AmazonDetailCapturePayload["coupon"]>(v2Extraction, "coupon") : input.coupon ?? null,
      seller: v2Extraction ? registeredValue<string>(v2Extraction, "seller") : input.seller ?? null,
      shipsFrom: v2Extraction ? registeredValue<string>(v2Extraction, "shipsFrom") : input.shipsFrom ?? null,
      fulfillment: v2Extraction ? registeredValue<{ value: string }>(v2Extraction, "fulfillment")?.value ?? null : input.fulfillment ?? null,
      buyBox: v2Extraction ? (() => {
        const seller = registeredValue<string>(v2Extraction, "seller");
        const price = registeredValue<{ amount: number; currency: string }>(v2Extraction, "price");
        return seller || price ? { seller, price } : null;
      })() : input.buyBox ?? null,
      ratingDistribution: v2Extraction ? registeredValue<Record<string, number>>(v2Extraction, "ratingDistribution") : input.ratingDistribution ?? null,
      boughtPastMonth,
      variations: v2Extraction ? (registeredValue<Array<{ value: string }>>(v2Extraction, "variations") ?? []).map((variation) => variation.value) : input.variations ?? null,
    },
    pageContext: {
      ...pageContextBase,
      pageClass: "amazon_normal",
      allowFields: true,
      errorCode: null,
      reason: null,
    },
  };
}

export type AmazonSearchCaptureObservation = {
  appearanceKey: string;
  page: number;
  position: number;
  sponsored: boolean | null;
  asin: string | null;
  /** Legacy offline fixtures may omit this; formal browser captures must provide it. */
  observedProductUrl?: string | null;
  productUrl: string | null;
  payload: Record<string, unknown> | null;
  sourceUrl: string | null;
  status: "ready" | "quarantined";
  reason: string | null;
};

export type AmazonSearchCapturePlan = {
  schemaVersion: "amazon-search-capture-plan.v1";
  query: string;
  pageCount: number;
  totalObservationCount: number;
  pageStatuses: string[];
  emptyResultReason: string | null;
  observations: AmazonSearchCaptureObservation[];
};

/**
 * 把最多两页、最多 20 条的搜索提取结果转换成有界 Capture 计划。
 * Sponsored 三态与 appearanceKey 原样保留；空结果只返回原因，不制造商品。
 */
export function planAmazonSearchCapture(input: {
  pages: ReadonlyArray<ReturnType<typeof import("@/tools/collectors/amazon/extract-search-page").extractAmazonSearchPage>>;
  maxAppearances?: number;
}): AmazonSearchCapturePlan {
  const sampleBudget = input.maxAppearances ?? 20;
  if (!Number.isInteger(sampleBudget) || sampleBudget < 1 || sampleBudget > 200) throw new Error("COLLECTOR_SAMPLE_BUDGET_INVALID");
  if (input.pages.length > 10) throw new Error("COLLECTOR_PAGE_BUDGET_EXCEEDED");
  const total = input.pages.reduce((sum, page) => sum + page.observations.length, 0);
  if (total > sampleBudget) throw new Error("COLLECTOR_SAMPLE_BUDGET_EXCEEDED");
  const first = input.pages[0];
  const observations: AmazonSearchCaptureObservation[] = input.pages.flatMap((page) => page.observations.map((item) => {
    const asin = item.asin;
    const productUrl = asin && item.observedProductUrl && amazonUrlForAsin(item.observedProductUrl, asin)
      ? item.observedProductUrl
      : null;
    const payload = asin && productUrl
      ? {
        asin,
        title: item.title,
        productUrl,
        images: item.imageUrl ? [item.imageUrl] : [],
        price: item.priceCurrency === "USD" ? parseSearchPrice(item.priceText) : null,
         currency: "USD",
         rating: parseSearchRating(item.ratingText),
         reviewCount: parseSearchCount(item.reviewCountText),
         bsrRank: null,
         bsrCategory: null,
         brand: item.brand,
         coupon: item.coupon ?? null,
         boughtPastMonth: item.boughtPastMonth ?? null,
         keywords: [page.query],
         searchObservation: {
          schemaVersion: "amazon-search-observation.v1",
          appearanceKey: item.appearanceKey,
          page: item.page,
          position: item.position,
           sponsored: item.sponsored,
           sponsoredFlag: item.sponsoredFlag ?? item.sponsored,
           naturalRank: item.naturalRank ?? null,
           bestSellerBadge: item.bestSellerBadge ?? null,
           amazonChoiceBadge: item.amazonChoiceBadge ?? null,
           boughtPastMonth: item.boughtPastMonth ?? null,
           query: page.query,
        },
      }
      : null;
    return {
      appearanceKey: item.appearanceKey,
      page: item.page,
      position: item.position,
      sponsored: item.sponsored,
      asin,
      productUrl,
      payload,
      sourceUrl: productUrl,
      status: payload ? "ready" : "quarantined",
      reason: payload ? null : item.identityMissingReason ?? (asin ? "product_url_not_observed" : "asin_not_found"),
    };
  }));
  return {
    schemaVersion: "amazon-search-capture-plan.v1",
    query: first?.query ?? "",
    pageCount: input.pages.length,
    totalObservationCount: total,
    pageStatuses: input.pages.map((page) => page.pageStatus),
    emptyResultReason: total === 0
      ? (first?.pageStatus === "ok" ? "no_result_cards" : `page_status_${first?.pageStatus ?? "unknown"}`)
      : null,
    observations,
  };
}

function parseSearchPrice(value: string | null): number | null {
  if (!value) return null;
  const match = /(?:US\$|\$)\s*([\d,]+(?:\.\d{1,2})?)/.exec(value);
  if (!match) return null;
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSearchRating(value: string | null): number | null {
  if (!value) return null;
  const match = /([0-9]+(?:\.[0-9]+)?)/.exec(value);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 5 ? parsed : null;
}

function parseSearchCount(value: string | null): number | null {
  // 搜索卡片会把千分位读数拆成多个文本节点（"27" + ",477"）。
  // 旧的正则只取第一段数字，把 27,477 读成 27；统一走 fail-closed 计数解析。
  return parseObservedCountText(value);
}
