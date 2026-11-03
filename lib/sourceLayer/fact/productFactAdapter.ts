import type { CaptureEvidenceRecord } from "@/lib/sourceLayer/sourceAdapter";
import {
  metricNatureFromCaptureField,
  type CaptureSourceType,
} from "@/lib/sourceLayer/capturePackage";
import { scoreKeywordRelevance } from "@/lib/research/researchInputQuality";
import {
  PRODUCT_FACT_SCHEMA,
  type FactField,
  type ProductFact,
  type ProductFactExtensions,
  type ProductFactExtended,
  type ProductFactKeyword,
  type ProductFactKeywordEvidenceInput,
  type ProductFactKeywordRow,
  type ProductFactSource,
  type ProductPrice,
  type SourceProof,
  type ProductFactTimeSeries,
  type ProductFactTimeSeriesMetrics,
  type ProductFactVariationAnalysis,
  type ProductFactVariationMetrics,
  type ProductFactMarketConcentration,
  type ProductFactConcentrationMetrics,
} from "@/lib/sourceLayer/fact/types";

/** G2-B：只取前 3 大核心出单词（计划书 §G2 要求）。 */
export const TOP_KEYWORD_LIMIT = 3;
/** SellerSprite 估算列的固定置信度（计划书 §G2.5：estimate → confidence 0.9）。 */
export const KEYWORD_ESTIMATE_CONFIDENCE = 0.9;
/** 关键词报表的列级来源引用；后续若新增列，追加同形常量而不改语义。 */
export const KEYWORD_SOURCE_REF_MONTHLY_SEARCHES = "sellersprite.keyword.monthlySearches";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 与 locale 无关的稳定文本比较（禁止 localeCompare：会随环境影响排序）。 */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * G2-B：把**已持久化**的关键词附件 payload 解析成 ProductFact 投影入参。
 *
 * - 只接受既有契约 `seller-sprite-keyword-attachment.v1`；不匹配一律返回 null；
 * - 只读 `monthlySearches` 列的 `normalized` 数值，不做单位换算、不做插值；
 * - 本函数不访问 EvidenceStore / 数据库，纯函数，便于单测。
 */
export function keywordEvidenceInputFromAttachment(
  payload: unknown,
  evidenceRef: string | null,
): ProductFactKeywordEvidenceInput | null {
  if (!isRecord(payload)) return null;
  if (payload.schema !== "seller-sprite-keyword-attachment.v1") return null;
  const evidence = isRecord(payload.evidence) ? payload.evidence : null;
  if (!evidence) return null;
  const rawRows = Array.isArray(evidence.rows) ? evidence.rows : [];
  const rows: ProductFactKeywordRow[] = [];
  for (const raw of rawRows) {
    if (!isRecord(raw)) continue;
    const keyword = typeof raw.keyword === "string" ? raw.keyword.trim() : "";
    if (!keyword) continue;
    const fields = isRecord(raw.fields) ? raw.fields : {};
    const column = isRecord(fields.monthlySearches) ? fields.monthlySearches : null;
    const normalized = column?.normalized;
    const monthlySearches =
      typeof normalized === "number" && Number.isFinite(normalized) ? normalized : null;
    rows.push({
      keyword,
      monthlySearches,
      rowNumber: typeof raw.rowNumber === "number" ? raw.rowNumber : null,
    });
  }
  if (rows.length === 0) return null;
  return {
    rows,
    evidenceRef,
    capturedAt: typeof evidence.capturedAt === "string" ? evidence.capturedAt : null,
    sourceMethod:
      typeof evidence.sourceMethod === "string"
        ? evidence.sourceMethod
        : typeof payload.sourceMethod === "string"
        ? payload.sourceMethod
        : null,
  };
}

/**
 * G2-B：确定性选出 top-3 关键词。
 *
 * 复用既有纯打分函数 `scoreKeywordRelevance`（不新增选词算法），但**自建全序**：
 * `score desc → monthlySearches desc → keyword 码点升序 → rowNumber 升序`。
 * 因此**输入顺序变化不改变输出**（并列时不会因"先遇到谁"而漂移）。
 * 无任何 `score > 0` 的词时返回空数组（fail-closed，绝不造词）。
 */
export function selectTopKeywords(input: {
  rows: readonly ProductFactKeywordRow[];
  productName: string;
  knownBrands: readonly string[];
  evidenceRef: string | null;
}): readonly ProductFactKeyword[] {
  const brands = [...input.knownBrands];
  const scored = input.rows
    .map((row) => ({ row, score: scoreKeywordRelevance(row.keyword, input.productName, brands) }))
    .filter((entry) => entry.score > 0);
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.row.monthlySearches ?? -1) - (a.row.monthlySearches ?? -1) ||
      compareText(a.row.keyword, b.row.keyword) ||
      (a.row.rowNumber ?? Number.MAX_SAFE_INTEGER) - (b.row.rowNumber ?? Number.MAX_SAFE_INTEGER),
  );
  return scored.slice(0, TOP_KEYWORD_LIMIT).map((entry) => ({
    keyword: entry.row.keyword,
    monthlySearches: entry.row.monthlySearches,
    metricNature: "estimate" as const,
    confidence: KEYWORD_ESTIMATE_CONFIDENCE,
    sourceRef: KEYWORD_SOURCE_REF_MONTHLY_SEARCHES,
    evidenceRef: input.evidenceRef,
  }));
}

export type ProductFactAdapterInput = {
  readonly evidence: CaptureEvidenceRecord;
  /** Gateway 传入的标准来源标识；不从标题、价格等字段推断。 */
  readonly source?: ProductFactSource;
  /** 同一 Capture payload 中可直接映射、但旧 CapturePackage 未建模的字段。 */
  readonly extensions?: ProductFactExtensions;
};

/** 旧 CaptureSourceType → V3 ProductFact source 的兼容映射。 */
export function productFactSourceFromCaptureSource(
  sourceType: CaptureSourceType,
): ProductFactSource {
  switch (sourceType) {
    case "amazon_dom":
      return "amazon_dom";
    case "sellersprite_plugin":
      return "sellersprite_plugin";
    case "sellersprite_xlsx":
    case "sellersprite_api":
    case "excel_upload":
      return "sellersprite_xlsx";
    case "keepa_export":
      return "keepa_export";
    case "manual_entry":
      return "manual";
    default:
      throw new Error(`PRODUCT_FACT_SOURCE_UNSUPPORTED:${sourceType}`);
  }
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function field<T>(input: {
  value: T | null;
  source: ProductFactSource;
  confidence?: number | null;
  metricNature: ProductFact["basic"]["asin"]["metricNature"];
  capturedAt: string | null;
  rawProofHash: string | null;
}): FactField<T> {
  const present = isPresent(input.value);
  return {
    value: present ? input.value : null,
    status: present ? "present" : "missing",
    metricNature: present ? input.metricNature : "unknown",
    source: input.source,
    confidence: present ? clampConfidence(input.confidence ?? 0) : 0,
    capturedAt: input.capturedAt,
    rawProofHash: input.rawProofHash,
  };
}

function captureFieldConfidence(
  evidence: CaptureEvidenceRecord,
  key: keyof CaptureEvidenceRecord["pkg"]["fieldStates"],
): number {
  return evidence.pkg.fieldStates[key]?.confidence ?? 0;
}

function sourceProofOf(
  evidence: CaptureEvidenceRecord,
  source: ProductFactSource,
): SourceProof {
  return {
    source,
    captureId: evidence.captureId,
    evidenceId: evidence.evidenceId,
    subjectKey: evidence.subjectKey,
    capturedAt: evidence.capturedAt,
    contentHash: evidence.contentHash,
    sourceUrl: evidence.sourceUrl,
    operator: evidence.pkg.sourceProof.operator,
    ...(evidence.pkg.sourceProof.sourceMethod
      ? { sourceMethod: evidence.pkg.sourceProof.sourceMethod }
      : {}),
    ...(evidence.pkg.sourceProof.entityBinding
      ? { entityBinding: evidence.pkg.sourceProof.entityBinding }
      : {}),
  };
}

function priceOrNull(value: ProductPrice | null | undefined): ProductPrice | null {
  return value ?? null;
}

/**
 * 只做 Evidence/Capture → ProductFact 的结构映射。
 * 不做 AI 推测、数值补全、单位换算或商业结论。
 */
export function adaptEvidenceToProductFact(input: ProductFactAdapterInput): ProductFact {
  const { evidence } = input;
  const source = input.source ?? productFactSourceFromCaptureSource(evidence.sourceType);
  const pkg = evidence.pkg;
  const extensions = {
    ...(evidence.pkg.extensions ?? {}),
    ...(input.extensions ?? {}),
  };
  const capturedAt = evidence.capturedAt;
  const rawProofHash = evidence.contentHash;
  const proof = sourceProofOf(evidence, source);
  const metadataFor = (key: string) => (
    (evidence.pkg.extensions?.fieldMetadata?.[key] ?? input.extensions?.fieldMetadata?.[key])
  );
  const sourceField = <T>(
    value: T | null,
    key: keyof CaptureEvidenceRecord["pkg"]["fieldStates"],
  ): FactField<T> => field({
    value,
    source,
    confidence: captureFieldConfidence(evidence, key),
    // 名称已经声明估算语义，来源时点/人工录入不能将其变为snapshot或confirmed。
    metricNature: key === "estimatedMonthlySales" || key === "estimatedMonthlyRevenueUsd"
      ? "estimate" : metricNatureFromCaptureField(evidence.pkg.fieldStates[key]),
    capturedAt,
    rawProofHash,
  });
  const extensionField = <T>(
    value: T | null | undefined,
    options?: string | {
      key?: string;
      metricNature?: ProductFact["basic"]["asin"]["metricNature"];
    },
  ): FactField<T> => {
    const resolved = typeof options === "string" ? { key: options } : options;
    const metadata = resolved?.key ? metadataFor(resolved.key) : undefined;
    return field({
      value: value ?? null,
      source,
      confidence: isPresent(value) ? (metadata?.confidence ?? 1) : 0,
      metricNature: isPresent(value)
        ? (resolved?.metricNature ?? metadata?.metricNature ?? "snapshot")
        : "unknown",
      capturedAt,
      rawProofHash,
    });
  };
  const directExtensions = {
    ...(evidence.pkg.extensions ?? {}),
    ...(input.extensions ?? {}),
  };
  const estimatedFbaFee = directExtensions.estimatedFbaFee ?? directExtensions.fbaFee;
  const dateFirstAvailable = directExtensions.dateFirstAvailable ?? directExtensions.launchedDate;
  // G2-B：关键词证据投影。来源是**已持久化的 SellerSprite 关键词报表**（由调用方从
  // EvidenceStore 附件解析后传入）；缺省/无合格词时整个分组缺省，由读取方按 missing 处理。
  const keywordInput = directExtensions.keywordEvidence ?? null;
  const topKeywords =
    keywordInput && keywordInput.rows.length > 0
      ? selectTopKeywords({
          rows: keywordInput.rows,
          productName: pkg.fields.title ?? "",
          knownBrands: pkg.fields.brand ? [pkg.fields.brand] : [],
          evidenceRef: keywordInput.evidenceRef,
        })
      : [];

  const extended: ProductFactExtended = {
    categoryPath: extensionField(extensions.categoryPath),
    parentAsin: extensionField(extensions.parentAsin),
    material: extensionField(extensions.material),
    includedComponents: extensionField(extensions.includedComponents),
    galleryImageUrls: extensionField(extensions.galleryImageUrls),
    listPrice: extensionField(extensions.listPrice),
    coupon: extensionField(extensions.coupon),
    seller: extensionField(extensions.seller),
    shipsFrom: extensionField(extensions.shipsFrom),
    fulfillment: extensionField(extensions.fulfillment),
    buyBox: extensionField(extensions.buyBox),
    ratingDistribution: extensionField(extensions.ratingDistribution),
    boughtPastMonth: extensionField(extensions.boughtPastMonth, {
      metricNature: isPresent(extensions.boughtPastMonth) ? "estimate" : "unknown",
    }),
    variations: extensionField(extensions.variations),
    bsrRanks: extensionField(extensions.bsrRanks),
    itemWeight: extensionField(extensions.itemWeight),
    itemDimensions: extensionField(extensions.itemDimensions),
    amazonDetail: extensionField(extensions.amazonDetail),
  };

  const timeSeriesMetrics = directExtensions.timeSeriesMetrics;
  const timeSeries: ProductFactTimeSeries | undefined = timeSeriesMetrics
    ? {
        price90dMin: extensionField(timeSeriesMetrics.price90dMin, "price90dMin"),
        price90dAvg: extensionField(timeSeriesMetrics.price90dAvg, "price90dAvg"),
        price360dMin: extensionField(timeSeriesMetrics.price360dMin, "price360dMin"),
        bsr90dAvg: extensionField(timeSeriesMetrics.bsr90dAvg, "bsr90dAvg"),
        bsrDrops90d: extensionField(timeSeriesMetrics.bsrDrops90d, "bsrDrops90d"),
        buyBoxAmazonSharePercent: extensionField(
          timeSeriesMetrics.buyBoxAmazonSharePercent,
          "buyBoxAmazonSharePercent",
        ),
        dealCount90d: extensionField(timeSeriesMetrics.dealCount90d, "dealCount90d"),
      }
    : undefined;

  const hasVariationData =
    isPresent(directExtensions.childSales) ||
    isPresent(directExtensions.currentAsinSalesShare) ||
    isPresent(directExtensions.isDominantVariation) ||
    isPresent(directExtensions.isMinorVariation);
  const parentTotalSales =
    directExtensions.childSales != null &&
    directExtensions.currentAsinSalesShare != null &&
    directExtensions.currentAsinSalesShare > 0
      ? Math.round(directExtensions.childSales / directExtensions.currentAsinSalesShare)
      : null;
  const variationAnalysis: ProductFactVariationAnalysis | undefined = hasVariationData
    ? {
        childSales: extensionField(directExtensions.childSales, "childSales"),
        parentTotalSales: extensionField(parentTotalSales, "parentTotalSales"),
        currentAsinSalesShare: extensionField(
          directExtensions.currentAsinSalesShare,
          "currentAsinSalesShare",
        ),
        isDominantVariation: extensionField(
          directExtensions.isDominantVariation,
          { key: "isDominantVariation", metricNature: "derived" },
        ),
        isMinorVariation: extensionField(
          directExtensions.isMinorVariation,
          { key: "isMinorVariation", metricNature: "derived" },
        ),
      }
    : undefined;

  const hasConcentrationData =
    isPresent(directExtensions.brandCr5Share) ||
    isPresent(directExtensions.amazon1pShare) ||
    isPresent(directExtensions.sellerMarketShare) ||
    isPresent(directExtensions.sellerOriginDomesticRatio);
  const concentration: ProductFactMarketConcentration | undefined = hasConcentrationData
    ? {
        brandCr5Share: extensionField(directExtensions.brandCr5Share, {
          key: "brandCr5Share",
          metricNature: "derived",
        }),
        amazon1pShare: extensionField(directExtensions.amazon1pShare, {
          key: "amazon1pShare",
          metricNature: "derived",
        }),
        sellerMarketShare: extensionField(directExtensions.sellerMarketShare, {
          key: "sellerMarketShare",
          metricNature: "derived",
        }),
        sellerOriginDomesticRatio: extensionField(directExtensions.sellerOriginDomesticRatio, {
          key: "sellerOriginDomesticRatio",
          metricNature: "derived",
        }),
      }
    : undefined;

  return {
    schema: PRODUCT_FACT_SCHEMA,
    subjectKey: evidence.subjectKey,
    sourceProof: proof,
    basic: {
      asin: sourceField(pkg.fields.asin, "asin"),
      title: sourceField(pkg.fields.title, "title"),
      image: sourceField(pkg.fields.images[0] ?? null, "images"),
      brand: sourceField(pkg.fields.brand, "brand"),
      category: sourceField(pkg.fields.bsr?.category ?? null, "bsr"),
      price: sourceField(pkg.fields.price, "price"),
      rating: sourceField(pkg.fields.rating, "rating"),
      reviewCount: sourceField(pkg.fields.reviewCount, "reviewCount"),
      bulletPoints: extensionField(extensions.bulletPoints),
    },
    market: {
      bsr: sourceField(pkg.fields.bsr?.rank ?? null, "bsr"),
      monthlySalesEstimate: sourceField(
        pkg.fields.estimatedMonthlySales,
        "estimatedMonthlySales",
      ),
      monthlyRevenueEstimate: sourceField(
        pkg.fields.estimatedMonthlyRevenueUsd === null
          ? null
          : { amount: pkg.fields.estimatedMonthlyRevenueUsd, currency: "USD" },
        "estimatedMonthlyRevenueUsd",
      ),
      launchedDate: extensionField(directExtensions.launchedDate, "launchedDate"),
      subCategoryBsr: sourceField(pkg.fields.subCategoryBsr, "subCategoryBsr"),
      dateFirstAvailable: extensionField(dateFirstAvailable, "dateFirstAvailable"),
      buyboxSeller: extensionField(directExtensions.buyboxSeller, "buyboxSeller"),
      fulfillmentType: extensionField(directExtensions.fulfillmentType, "fulfillmentType"),
      estimatedGrossMargin: extensionField(
        directExtensions.estimatedGrossMargin,
        { key: "estimatedGrossMargin", metricNature: "estimate" },
      ),
      listingQualityScore: extensionField(
        directExtensions.listingQualityScore,
        { key: "listingQualityScore", metricNature: "derived" },
      ),
    },
    profit: {
      packageWeight: extensionField(directExtensions.packageWeight, "packageWeight"),
      packageDimensions: extensionField(directExtensions.packageDimensions, "packageDimensions"),
      fbaFee: extensionField(priceOrNull(estimatedFbaFee), directExtensions.estimatedFbaFee != null ? { key: "estimatedFbaFee", metricNature: "estimate" } : "estimatedFbaFee"),
      itemWeight: extensionField(directExtensions.itemWeight, "itemWeight"),
      itemDimensions: extensionField(directExtensions.itemDimensions, "itemDimensions"),
    },
    extended,
    ...(topKeywords.length > 0
      ? {
          keywordEvidence: {
            topKeywords: extensionField(topKeywords, {
              key: "keywordEvidence",
              metricNature: "estimate",
            }),
          },
        }
      : {}),
    ...(directExtensions.sellerSpriteRaw
      ? { providerRawData: directExtensions.sellerSpriteRaw }
      : {}),
    ...(timeSeries ? { timeSeries } : {}),
    ...(variationAnalysis ? { variationAnalysis } : {}),
    ...(concentration ? { concentration } : {}),
  };
}

/**
 * G2-B：把**已持久化**的关键词报表投影到既有 ProductFact 上。
 *
 * - 返回**新对象**，不修改入参（可安全用于只读回读链）；
 * - 无附件 / 无合格词时**原样返回**，绝不注入空分组或任何假数据；
 * - 字段形状与 `adaptEvidenceToProductFact` 内的 `extensionField` 完全一致
 *   （`metricNature: "estimate"`、`rawProofHash` 沿用该 ProductFact 的证据指纹），
 *   因此 Research 侧的四元组一致性校验不受影响。
 */
export function withKeywordEvidence(
  productFact: ProductFact,
  input: ProductFactKeywordEvidenceInput | null,
): ProductFact {
  if (!input || input.rows.length === 0) return productFact;
  const keywords = selectTopKeywords({
    rows: input.rows,
    productName: productFact.basic.title.value ?? "",
    knownBrands: productFact.basic.brand.value ? [productFact.basic.brand.value] : [],
    evidenceRef: input.evidenceRef,
  });
  if (keywords.length === 0) return productFact;
  return {
    ...productFact,
    keywordEvidence: {
      topKeywords: {
        value: keywords,
        status: "present",
        metricNature: "estimate",
        source: productFact.sourceProof.source,
        confidence: KEYWORD_ESTIMATE_CONFIDENCE,
        capturedAt: input.capturedAt ?? productFact.sourceProof.capturedAt,
        rawProofHash: productFact.sourceProof.contentHash,
      },
    },
  };
}

/**
 * V5.1 Capture Deep Expansion: Keepa 时序附件解析为时序指标。
 */
export function timeSeriesFromKeepaAttachment(
  payload: unknown,
): ProductFactTimeSeriesMetrics | null {
  if (!isRecord(payload) || payload.schema !== "keepa-timeseries-attachment.v1") return null;
  const metrics = isRecord(payload.metrics) ? payload.metrics : null;
  if (!metrics) return null;
  const numOrNull = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    price90dMin: numOrNull(metrics.price90dMin),
    price90dAvg: numOrNull(metrics.price90dAvg),
    price360dMin: numOrNull(metrics.price360dMin),
    bsr90dAvg: numOrNull(metrics.bsr90dAvg),
    bsrDrops90d: numOrNull(metrics.bsrDrops90d),
    buyBoxAmazonSharePercent: numOrNull(metrics.buyBoxAmazonSharePercent),
    dealCount90d: numOrNull(metrics.dealCount90d),
  };
}

/**
 * V5.1 Capture Deep Expansion: SellerSprite 市场集中度附件解析为集中度指标。
 */
export function concentrationFromMarketShareAttachment(
  payload: unknown,
): ProductFactConcentrationMetrics | null {
  if (!isRecord(payload) || payload.schema !== "sellersprite-market-share-attachment.v1") return null;
  const numOrNull = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    brandCr5Share: numOrNull(payload.brandCr5Share),
    amazon1pShare: numOrNull(payload.amazon1pShare),
    sellerMarketShare: numOrNull(payload.sellerMarketShare),
    sellerOriginDomesticRatio: numOrNull(payload.sellerOriginDomesticRatio),
  };
}

/**
 * V5.1 Capture Deep Expansion: 将时序指标投影到既有 ProductFact 上。
 */
export function withTimeSeries(
  productFact: ProductFact,
  metrics: ProductFactTimeSeriesMetrics | null,
): ProductFact {
  if (!metrics) return productFact;
  const source = productFact.sourceProof.source;
  const capturedAt = productFact.sourceProof.capturedAt;
  const rawProofHash = productFact.sourceProof.contentHash;
  const tsField = <T>(val: T | null): FactField<T> => field({
    value: val,
    source,
    confidence: isPresent(val) ? 1 : 0,
    metricNature: isPresent(val) ? "snapshot" : "unknown",
    capturedAt,
    rawProofHash,
  });

  return {
    ...productFact,
    timeSeries: {
      price90dMin: tsField(metrics.price90dMin),
      price90dAvg: tsField(metrics.price90dAvg),
      price360dMin: tsField(metrics.price360dMin),
      bsr90dAvg: tsField(metrics.bsr90dAvg),
      bsrDrops90d: tsField(metrics.bsrDrops90d),
      buyBoxAmazonSharePercent: tsField(metrics.buyBoxAmazonSharePercent),
      dealCount90d: tsField(metrics.dealCount90d),
    },
  };
}

/**
 * V5.1 Capture Deep Expansion: 将市场集中度指标投影到既有 ProductFact 上。
 */
export function withMarketConcentration(
  productFact: ProductFact,
  metrics: ProductFactConcentrationMetrics | null,
): ProductFact {
  if (!metrics) return productFact;
  const source = productFact.sourceProof.source;
  const capturedAt = productFact.sourceProof.capturedAt;
  const rawProofHash = productFact.sourceProof.contentHash;
  const cField = <T>(val: T | null): FactField<T> => field({
    value: val,
    source,
    confidence: isPresent(val) ? 1 : 0,
    metricNature: isPresent(val) ? "derived" : "unknown",
    capturedAt,
    rawProofHash,
  });

  return {
    ...productFact,
    concentration: {
      brandCr5Share: cField(metrics.brandCr5Share),
      amazon1pShare: cField(metrics.amazon1pShare),
      sellerMarketShare: cField(metrics.sellerMarketShare),
      sellerOriginDomesticRatio: cField(metrics.sellerOriginDomesticRatio),
    },
  };
}

/**
 * V5.1 Capture Deep Expansion: 将变体拆解指标投影到既有 ProductFact 上。
 */
export function withVariationAnalysis(
  productFact: ProductFact,
  metrics: ProductFactVariationMetrics | null,
): ProductFact {
  if (!metrics) return productFact;
  const source = productFact.sourceProof.source;
  const capturedAt = productFact.sourceProof.capturedAt;
  const rawProofHash = productFact.sourceProof.contentHash;
  const vField = <T>(val: T | null): FactField<T> => field({
    value: val,
    source,
    confidence: isPresent(val) ? 0.9 : 0,
    metricNature: isPresent(val) ? "derived" : "unknown",
    capturedAt,
    rawProofHash,
  });

  return {
    ...productFact,
    variationAnalysis: {
      childSales: vField(metrics.childSales),
      parentTotalSales: vField(metrics.parentTotalSales),
      currentAsinSalesShare: vField(metrics.currentAsinSalesShare),
      isDominantVariation: vField(metrics.isDominantVariation),
      isMinorVariation: vField(metrics.isMinorVariation),
    },
  };
}
