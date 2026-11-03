import type {
  AmazonDetailCaptureEvidence,
  BoughtPastMonthValue,
} from "@/lib/sourceLayer/capturePackage";

/**
 * Source Layer V3 Product Fact 最小契约。
 *
 * ProductFact 是 Capture / Evidence 的结构化投影，不是商业结论，也不是
 * 人工确认事实。所有字段都保留来源、采集时间和原始证据指纹；缺失值使用
 * `value: null` + `status: "missing"` 表达，绝不由本层猜测或补全。
 */

export const PRODUCT_FACT_SCHEMA = "product-fact.v3" as const;

export const PRODUCT_FACT_SOURCES = [
  "amazon_dom",
  "sellersprite_plugin",
  "sellersprite_xlsx",
  "keepa_export",
  "manual",
] as const;

export type ProductFactSource = (typeof PRODUCT_FACT_SOURCES)[number];

export const FACT_FIELD_STATUSES = ["present", "missing"] as const;
export type FactFieldStatus = (typeof FACT_FIELD_STATUSES)[number];

export const FACT_METRIC_NATURES = ["snapshot", "estimate", "derived", "unknown"] as const;
export type FactMetricNature = (typeof FACT_METRIC_NATURES)[number];

export type FactField<T> = {
  readonly value: T | null;
  readonly status: FactFieldStatus;
  /** Legacy ProductFact fixtures remain readable; adapters emit this field explicitly. */
  readonly metricNature?: FactMetricNature;
  readonly source: ProductFactSource;
  readonly confidence: number;
  readonly capturedAt: string | null;
  /** 对应 Evidence 内容指纹；缺失字段也指向同一份原始证据。 */
  readonly rawProofHash: string | null;
  /** Optional field-scoped immutable evidence links; absent for legacy single-evidence projections. */
  readonly evidenceRefs?: readonly FactFieldEvidenceRef[];
};

export type FactFieldEvidenceRef = {
  readonly refId: string;
  readonly source: ProductFactSource;
  readonly captureId: string;
  readonly evidenceId: string;
  readonly subjectKey: string;
  readonly capturedAt: string;
  readonly contentHash: string;
  readonly sourceUrl: string | null;
};

export type SourceProof = {
  readonly source: ProductFactSource;
  readonly captureId: string;
  readonly evidenceId: string;
  readonly subjectKey: string;
  readonly capturedAt: string;
  readonly contentHash: string;
  readonly sourceUrl: string | null;
  readonly operator: string;
  /** 与 CapturePackage sourceMethod 对齐，保留页面人工取证/XLSX provenance。 */
  readonly sourceMethod?: string | null;
  readonly entityBinding?: {
    readonly bound: boolean;
    readonly expectedAsin: string | null;
    readonly observedAsin: string | null;
    readonly expectedMarketplace: string;
    readonly observedMarketplace: string | null;
    readonly urlAsin: string | null;
    readonly urlMarketplace: string | null;
  };
};

export type ProductPrice = {
  readonly amount: number;
  readonly currency: string;
};

export type ProductPackageWeight = {
  readonly value: number;
  readonly unit: "kg" | "lb" | "oz" | "g";
};

export type ProductPackageDimensions = {
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly unit: "cm" | "in";
};

/** Amazon 页面上的单品尺寸有时只明确给出长×宽；它不能代替包装尺寸。 */
export type ProductItemDimensions = {
  readonly length: number;
  readonly width: number;
  readonly height?: number;
  readonly unit: "cm" | "in";
};

export type ProductFactBasic = {
  readonly asin: FactField<string>;
  readonly title: FactField<string>;
  /** 主图：沿用旧 CapturePackage 的第一张 images 记录，不改变旧字段。 */
  readonly image: FactField<string>;
  readonly brand: FactField<string>;
  readonly category: FactField<string>;
  readonly price: FactField<ProductPrice>;
  readonly rating: FactField<number>;
  readonly reviewCount: FactField<number>;
  readonly bulletPoints: FactField<readonly string[]>;
};

export type ProductFactMarket = {
  readonly bsr: FactField<number>;
  readonly monthlySalesEstimate: FactField<number>;
  readonly monthlyRevenueEstimate: FactField<ProductPrice>;
  readonly launchedDate: FactField<string>;
  /** SellerSprite 详情/导表中的小类排名与销售状态快照。 */
  readonly subCategoryBsr?: FactField<number>;
  readonly dateFirstAvailable?: FactField<string>;
  readonly buyboxSeller?: FactField<string>;
  readonly fulfillmentType?: FactField<string>;
  /** 数值单位为百分比点，例如 35.5 表示 35.5%。来源仍是 estimate。 */
  readonly estimatedGrossMargin?: FactField<number>;
  readonly listingQualityScore?: FactField<number>;
};

export type ProductFactProfit = {
  readonly packageWeight: FactField<ProductPackageWeight>;
  readonly packageDimensions: FactField<ProductPackageDimensions>;
  readonly fbaFee: FactField<ProductPrice>;
  readonly itemWeight?: FactField<ProductPackageWeight>;
  readonly itemDimensions?: FactField<ProductItemDimensions>;
};

export type ProductFactRawRow = {
  readonly rowNumber: number;
  readonly columns: Readonly<Record<string, string | null>>;
  readonly extraRaw: Readonly<Record<string, string | null>>;
  readonly extraRawMetricNature: Readonly<Record<string, FactMetricNature>>;
};

/** 原始 provider 导表快照；它属于 Evidence/ProductFact 投影，不是第二事实库。 */
export type ProductFactRawData = {
  readonly schemaVersion: "sellersprite-xlsx-raw.v1";
  readonly sourceType: "sellersprite_xlsx";
  readonly sourceFileSha256: string | null;
  readonly rows: ReadonlyArray<ProductFactRawRow>;
};

export type ProductFactCoupon = {
  readonly text: string | null;
  readonly amount: number | null;
  readonly percent: number | null;
  readonly currency: string | null;
};

/**
 * G2-B：SellerSprite 关键词证据的**事实投影**条目。
 *
 * - `monthlySearches` 是第三方估算（SellerSprite 导表 `月搜索量` 列），性质**锁定为
 *   `estimate`**，不得升格为实测事实；
 * - `evidenceRef` 指向承载该关键词报表的 EvidenceStore 附件（`kind = "keyword_evidence"`）；
 * - 关键词**只来自已持久化证据**，本层不做 AI 生成、不做 AI 排序。
 */
export type ProductFactKeyword = {
  readonly keyword: string;
  /** 单位：次/月。缺失时为 null（不猜、不补）。 */
  readonly monthlySearches: number | null;
  /** 固定为 estimate：第三方估算，绝不等同 Amazon 实测。 */
  readonly metricNature: "estimate";
  readonly confidence: number;
  /** 列级来源引用，例如 `sellersprite.keyword.monthlySearches`。 */
  readonly sourceRef: string;
  /** 该报表所在的 EvidenceStore 附件引用；无附件时为 null。 */
  readonly evidenceRef: string | null;
};

/** Adapter 入参：由调用方从已持久化的关键词附件解析而来（本层不访问 store）。 */
export type ProductFactKeywordRow = {
  readonly keyword: string;
  readonly monthlySearches: number | null;
  readonly rowNumber: number | null;
};

export type ProductFactKeywordEvidenceInput = {
  readonly rows: readonly ProductFactKeywordRow[];
  /** 承载该报表的 Evidence 附件引用。 */
  readonly evidenceRef: string | null;
  readonly capturedAt: string | null;
  /** 来源方法，例如 `sellersprite_official_xlsx`。 */
  readonly sourceMethod: string | null;
};

export type ProductFactKeywordFacts = {
  readonly topKeywords: FactField<readonly ProductFactKeyword[]>;
};

/** V2 详情页高价值事实扩展；全部为可缺省字段，不破坏 V3 最小分组。 */
export type ProductFactExtended = {  readonly categoryPath: FactField<readonly string[]>;
  readonly parentAsin: FactField<string>;
  readonly material: FactField<string>;
  readonly includedComponents: FactField<readonly string[]>;
  readonly galleryImageUrls: FactField<readonly string[]>;
  readonly listPrice: FactField<ProductPrice>;
  readonly coupon: FactField<ProductFactCoupon>;
  readonly seller: FactField<string>;
  readonly shipsFrom: FactField<string>;
  readonly fulfillment: FactField<string>;
  readonly buyBox: FactField<{ seller: string | null; price: ProductPrice | null }>;
  readonly ratingDistribution: FactField<Readonly<Record<string, number>>>;
  readonly boughtPastMonth: FactField<BoughtPastMonthValue>;
  readonly variations: FactField<readonly string[]>;
  readonly bsrRanks?: FactField<readonly { rank: number; category: string }[]>;
  readonly itemWeight?: FactField<ProductPackageWeight>;
  readonly itemDimensions?: FactField<ProductItemDimensions>;
  /** Same-subject, identity-bound variation observations; never contains sales metrics. */
  readonly variationStructure?: ProductFactVariationStructure;
  readonly amazonDetail?: FactField<AmazonDetailCaptureEvidence>;
};

export type ProductFactVariationStructure = {
  readonly schemaVersion: "product-fact-variation-structure.v1";
  readonly subjectKey: string;
  readonly subjectAsin: string;
  readonly outcome: "complete" | "partial" | "no_variation_with_evidence";
  readonly completeness: "complete" | "partial" | "none";
  readonly parentAsin: string | null;
  readonly memberAsins: readonly string[];
  readonly members: readonly {
    readonly asin: string;
    readonly options: readonly { readonly dimensionKey: string; readonly label: string | null; readonly value: string }[];
  }[];
  readonly relations: readonly {
    readonly fromAsin: string;
    readonly toAsin: string;
    readonly relation: "parent" | "child" | "peer";
  }[];
  readonly evidenceRefs: readonly FactFieldEvidenceRef[];
  readonly limitation: string | null;
};

export type ProductFactSourceConflict = {
  readonly field: string;
  readonly code: "SOURCE_CONFLICT_UNRESOLVED";
  readonly resolved: false;
  readonly candidates: readonly {
    readonly source: ProductFactSource;
    readonly value: unknown;
    readonly capturedAt: string | null;
    readonly evidenceRefs: readonly FactFieldEvidenceRef[];
  }[];
};

/** V5.1 Capture Deep Expansion: 时序指标 (Keepa 等来源) */
export interface ProductFactTimeSeriesMetrics {
  readonly price90dMin: number | null;
  readonly price90dAvg: number | null;
  readonly price360dMin: number | null;
  readonly bsr90dAvg: number | null;
  readonly bsrDrops90d: number | null;
  readonly buyBoxAmazonSharePercent: number | null;
  readonly dealCount90d: number | null;
}

export type ProductFactTimeSeries = {
  readonly price90dMin: FactField<number>;
  readonly price90dAvg: FactField<number>;
  readonly price360dMin: FactField<number>;
  readonly bsr90dAvg: FactField<number>;
  readonly bsrDrops90d: FactField<number>;
  readonly buyBoxAmazonSharePercent: FactField<number>;
  readonly dealCount90d: FactField<number>;
};

/** V5.1 Capture Deep Expansion: 变体销售拆解 (SellerSprite US Sheet 等来源) */
export interface ProductFactVariationMetrics {
  readonly childSales: number | null;
  readonly parentTotalSales: number | null;
  readonly currentAsinSalesShare: number | null; // 0..1
  readonly isDominantVariation: boolean | null;   // salesShare >= 0.5
  readonly isMinorVariation: boolean | null;      // salesShare < 0.1
}

export type ProductFactVariationAnalysis = {
  readonly childSales: FactField<number>;
  readonly parentTotalSales: FactField<number>;
  readonly currentAsinSalesShare: FactField<number>;
  readonly isDominantVariation: FactField<boolean>;
  readonly isMinorVariation: FactField<boolean>;
};

/** V5.1 Capture Deep Expansion: 市场集中度与自营霸盘率 (SellerSprite Brands/Sellers Sheet 等来源) */
export interface ProductFactConcentrationMetrics {
  readonly brandCr5Share: number | null;         // 0..1 (Sheet Brands 前5名之和)
  readonly amazon1pShare: number | null;         // 0..1 (Sheet Sellers Amazon份额)
  readonly sellerMarketShare: number | null;     // 0..1 (当前卖家份额)
  readonly sellerOriginDomesticRatio: number | null; // 0..1 (中国卖家占比)
}

export type ProductFactMarketConcentration = {
  readonly brandCr5Share: FactField<number>;
  readonly amazon1pShare: FactField<number>;
  readonly sellerMarketShare: FactField<number>;
  readonly sellerOriginDomesticRatio: FactField<number>;
};

/**
 * V3 Phase 1 仅覆盖 Basic / Market / Profit 三个事实块。
 * `basic` / `market` / `profit` 是本阶段的稳定分组名，后续扩展不得改变
 * 旧 CapturePackage 的字段语义。
 */
export type ProductFact = {
  readonly schema: typeof PRODUCT_FACT_SCHEMA;
  readonly subjectKey: string;
  readonly sourceProof: SourceProof;
  /** Explicitly unresolved observations retained for audit; values stay unavailable to calculations. */
  readonly sourceConflicts?: readonly ProductFactSourceConflict[];
  /** Backward-compatible detail-field recovery contract; it never mutates the source Evidence. */
  readonly amazonDetailHistory?: import("@/lib/sourceLayer/amazonDetailFieldHistory").AmazonDetailHistoryProjection;
  readonly basic: ProductFactBasic;
  readonly market: ProductFactMarket;
  readonly profit: ProductFactProfit;
  /** 可选扩展层；旧 ProductFact 没有该字段时仍是合法 V3。 */
  readonly extended?: ProductFactExtended;
  /** G2-B：SellerSprite 关键词证据投影（estimate）。缺省时该分组不存在，读取方须容忍。 */
  readonly keywordEvidence?: ProductFactKeywordFacts;
  readonly providerRawData?: ProductFactRawData;
  /** V5.1 Capture Deep Expansion 增量分组 (完全可选，向后兼容) */
  readonly timeSeries?: ProductFactTimeSeries;
  readonly variationAnalysis?: ProductFactVariationAnalysis;
  readonly concentration?: ProductFactMarketConcentration;
};

/**
 * Adapter 可接收的来源扩展字段。它们只允许来自同一份 Capture payload，
 * 不允许在适配过程中通过 AI、默认值或商业规则生成。
 */
export type ProductFactExtensions = {
  readonly bulletPoints?: readonly string[] | null;
  readonly launchedDate?: string | null;
  readonly dateFirstAvailable?: string | null;
  readonly buyboxSeller?: string | null;
  readonly fulfillmentType?: string | null;
  readonly packageWeight?: ProductPackageWeight | null;
  readonly packageDimensions?: ProductPackageDimensions | null;
  readonly itemWeight?: ProductPackageWeight | null;
  readonly itemDimensions?: ProductItemDimensions | null;
  readonly fbaFee?: ProductPrice | null;
  readonly categoryPath?: readonly string[] | null;
  readonly parentAsin?: string | null;
  readonly material?: string | null;
  readonly includedComponents?: readonly string[] | null;
  readonly galleryImageUrls?: readonly string[] | null;
  readonly listPrice?: ProductPrice | null;
  readonly coupon?: ProductFactCoupon | null;
  readonly seller?: string | null;
  readonly shipsFrom?: string | null;
  readonly fulfillment?: string | null;
  readonly buyBox?: { seller: string | null; price: ProductPrice | null } | null;
  readonly ratingDistribution?: Readonly<Record<string, number>> | null;
  readonly boughtPastMonth?: BoughtPastMonthValue | null;
  readonly variations?: readonly string[] | null;
  readonly bsrRanks?: readonly { rank: number; category: string }[] | null;
  readonly amazonDetail?: AmazonDetailCaptureEvidence;
  readonly sourceMethod?: string | null;
  readonly estimatedFbaFee?: ProductPrice | null;
  readonly estimatedGrossMargin?: number | null;
  readonly listingQualityScore?: number | null;
  /** G2-B：已持久化的 SellerSprite 关键词报表（含 `monthlySearches`）。 */
  readonly keywordEvidence?: ProductFactKeywordEvidenceInput | null;
  readonly fieldMetadata?: Partial<Record<string, {
    metricNature: FactMetricNature;
    confidence: number;
    sourceRef: string;
  }>>;
  readonly sellerSpriteRaw?: ProductFactRawData;
  /** V5.1 Capture Deep Expansion 扩展输入 */
  readonly timeSeriesMetrics?: ProductFactTimeSeriesMetrics | null;
  readonly childSales?: number | null;
  readonly childRevenue?: number | null;
  readonly currentAsinSalesShare?: number | null;
  readonly isDominantVariation?: boolean | null;
  readonly isMinorVariation?: boolean | null;
  readonly brandCr5Share?: number | null;
  readonly amazon1pShare?: number | null;
  readonly sellerMarketShare?: number | null;
  readonly sellerOriginDomesticRatio?: number | null;
  readonly sellerLocation?: string | null;
  readonly dealBadge?: string | null;
};
