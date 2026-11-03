/**
 * Product Source Layer V1.2 — Capture Package Schema（Phase 2）
 *
 * 第一性原理：
 * - 采集数据 ≠ 商品事实。Capture Package 只是「一次采集的完整证据快照」；
 * - 它必须自证来源（sourceType / sourceUrl / capturedAt / captureMethod / operator）；
 * - 它必须自证质量（每字段 confirmed / estimated / missing / conflict）；
 * - 它必须自带风险（riskFlags）；
 * - 它永远不能直接进入 AI 结论，必须先经 Validator 与人工确认。
 *
 * 纯模块：无 IO / 无 DB / 无随机。
 */
import {
  CAPTURE_FIELD_KEYS,
  SOURCE_LAYER_SCHEMA_VERSION,
  type CaptureFieldKey,
} from "@/lib/sourceLayer/expiration";
import { createSourceLayerError, type SourceLayerError } from "@/lib/sourceLayer/errorCodes";

export { CAPTURE_FIELD_KEYS, SOURCE_LAYER_SCHEMA_VERSION };
export type { CaptureFieldKey };

/** 字段状态：V1.2 强制四态。 */
export const FIELD_STATUSES = ["confirmed", "estimated", "missing", "conflict"] as const;
export type FieldStatus = (typeof FIELD_STATUSES)[number];

/**
 * 指标性质与字段状态分离：`status` 表示当前校验结论，`metricNature`
 * 表示来源本身是页面快照、估算、系统计算还是未知。两者不能互相替代。
 * 其中 `snapshot` 才有机会在可信来源上成为 confirmed。
 */
export const METRIC_NATURES = ["snapshot", "estimate", "derived", "unknown"] as const;
export type MetricNature = (typeof METRIC_NATURES)[number];

/** 来源类型：每种都对应一个 Source Adapter；新增来源只能新增 Adapter。 */
export const SOURCE_TYPES = [
  "amazon_dom",
  "sellersprite_plugin",
  "sellersprite_xlsx",
  "sellersprite_api",
  "keepa_export",
  "manual_entry",
  "excel_upload",
  "public_api",
  "browser_agent",
] as const;
export type CaptureSourceType = (typeof SOURCE_TYPES)[number];

/**
 * 来源可信度分级（由来源类型确定性映射，不允许调用方自由声明）。
 * - trusted：平台/供应商正式导出或用户手工录入，字段可核验；
 * - estimated_only：第三方估算来源，只能产出 estimated 字段；
 * - untrusted：不被允许的来源，fail-closed 阻断。
 */
export const SOURCE_TRUST_LEVELS = ["trusted", "estimated_only", "untrusted"] as const;
export type SourceTrustLevel = (typeof SOURCE_TRUST_LEVELS)[number];

export const CAPTURE_METHODS = [
  "xlsx_export",
  "api_response",
  "manual_form",
  "browser_dom",
  "open_data",
] as const;
export type CaptureMethod = (typeof CAPTURE_METHODS)[number];

/** 字段值的来源方式：区分「页面实测」「供应商导出」「人工录入」「模型估算」。 */
export const FIELD_VALUE_ORIGINS = [
  "page_measured",
  "provider_export",
  "human_manual",
  "derived",
  "model_estimated",
] as const;
export type FieldValueOrigin = (typeof FIELD_VALUE_ORIGINS)[number];

/** 风险标记（封闭枚举；未知风险必须新增枚举值而不是自由字符串）。 */
export const RISK_FLAGS = [
  "price_volatile",
  "rating_low",
  "review_count_low",
  "bsr_weak",
  "image_missing",
  "image_single",
  "title_too_short",
  "keyword_missing",
  "identity_unverified",
  "provider_estimate_only",
  "source_expired",
  "field_conflict",
  "captcha_detected",
  "login_required",
  "page_structure_changed",
] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];

export type CaptureField = {
  status: FieldStatus;
  /** Legacy CapturePackage 仍可读取；新建包总是显式写入。 */
  metricNature?: MetricNature;
  valueOrigin: FieldValueOrigin;
  /** 0..1；estimated/derived 必须显式给出，confirmed 通常为 1。 */
  confidence: number;
  /** 该字段在来源侧的原始引用（列名 / 选择器 / 路径），用于 Replay 复盘。 */
  sourceRef: string;
  /** conflict 状态下并列的其他候选值（禁止静默取一个）。 */
  conflictWith?: Array<{ value: string; sourceRef: string }>;
};

export type CaptureFields = {
  asin: string | null;
  title: string | null;
  brand: string | null;
  images: string[];
  price: { amount: number; currency: string } | null;
  rating: number | null;
  reviewCount: number | null;
  bsr: { rank: number; category: string | null } | null;
  subCategoryBsr: number | null;
  estimatedMonthlySales: number | null;
  estimatedMonthlyRevenueUsd: number | null;
  keywords: string[];
};

export type BoughtPastMonthEstimate = {
  rawText: string;
  lowerBound: number | null;
  upperBound: number | null;
  qualifier: "exact" | "at_least" | "range" | "approximate" | "unknown";
  metricNature: "estimate";
};

export type BoughtPastMonthValue = BoughtPastMonthEstimate | number;

export type AmazonDetailRegisteredFieldEvidence = {
  canonicalField: string;
  priority: "P0" | "P1" | "P2" | "BLOCKED";
  fieldNature: "DIRECT_FACT" | "DERIVED_FACT" | "ESTIMATED_METRIC" | "CONDITIONAL_FACT" | "BLOCKED";
  status: "observed" | "derived" | "missing" | "ambiguous" | "invalid" | "blocked";
  value: unknown;
  reason: string | null;
  sourceTrace: {
    ruleId: string;
    registryVersion: string;
    region: string;
    selector: string | null;
    label: string | null;
    ruleVersion: string | null;
    resolverVersion?: string | null;
    /** Present for price candidates; unknown is deliberately distinct from an absent control. */
    semanticRole?: string | null;
    purchaseContext?: "one_time" | "subscribe_save" | "unknown" | "not_applicable" | null;
    selected?: boolean | null;
  };
  /** Bounded raw and canonical candidates retained for deterministic Title/Price audit. */
  candidateDiagnostics?: readonly AmazonDetailFieldCandidateDiagnostic[];
  /** If nonzero, extraction failed closed because more raw candidates existed than could be retained. */
  candidateDiagnosticsTruncatedCount?: number;
};

export const AMAZON_DETAIL_FIELD_RESOLVER_VERSION = "amazon-detail-field-resolver.v1" as const;
export const AMAZON_DETAIL_CANDIDATE_DIAGNOSTIC_LIMIT = 40 as const;

export type AmazonDetailFieldCandidateDiagnostic = {
  readonly rawValue: string | null;
  readonly canonicalValue: unknown | null;
  readonly status: "accepted" | "rejected";
  readonly reason: string;
  readonly sourceTrace: AmazonDetailRegisteredFieldEvidence["sourceTrace"];
};

/** V2 extractor output retained verbatim as bounded provenance inside the same Evidence. */
export type AmazonDetailCaptureEvidence = {
  schemaVersion: "amazon-detail-registered-fields.v1";
  extractorVersion: "amazon-detail-extractor.v2";
  fieldRegistryVersion: "amazon-detail-field-registry.v1";
  primaryBsrProjectionVersion: "primary-bsr.v1";
  resolverVersion?: typeof AMAZON_DETAIL_FIELD_RESOLVER_VERSION;
  registeredFields: Record<string, AmazonDetailRegisteredFieldEvidence>;
};

const MAX_AMAZON_DETAIL_EVIDENCE_CHARS = 80_000;

/**
 * CapturePackage 的可选事实扩展。
 * 旧 CapturePackage 没有该字段时仍可读取；新采集的详情规格保留在同一份
 * Evidence 中。扩展只做结构归一，不做单位换算、推测或默认补全。
 */
export type CapturePackageExtensions = {
  bulletPoints?: string[] | null;
  launchedDate?: string | null;
  /** SellerSprite XLSX 的原始上架日期别名；与 launchedDate 语义相同但保留来源命名。 */
  dateFirstAvailable?: string | null;
  buyboxSeller?: string | null;
  fulfillmentType?: string | null;
  packageWeight?: { value: number; unit: "kg" | "lb" | "oz" | "g" } | null;
  packageDimensions?: { length: number; width: number; height: number; unit: "cm" | "in" } | null;
  itemWeight?: { value: number; unit: "kg" | "lb" | "oz" | "g" } | null;
  itemDimensions?: { length: number; width: number; height: number; unit: "cm" | "in" } | null;
  fbaFee?: { amount: number; currency: string } | null;
  /** SellerSprite provider estimate；不要与 Amazon 一手确认事实混用。 */
  estimatedFbaFee?: { amount: number; currency: string } | null;
  estimatedGrossMargin?: number | null;
  listingQualityScore?: number | null;
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
  /** Numeric legacy Search snapshots remain readable; Detail V2 writes the structured estimate. */
  boughtPastMonth?: BoughtPastMonthValue | null;
  bsrRanks?: Array<{ rank: number; category: string }> | null;
  amazonDetail?: AmazonDetailCaptureEvidence;
  variations?: string[] | null;
  /** 只标记来源方式，不改变旧 captureMethod。 */
  sourceMethod?: string | null;
  /** 扩展字段仍沿用三层语义，避免把 provider estimate 当成 snapshot。 */
  fieldMetadata?: Partial<Record<string, {
    metricNature: MetricNature;
    valueOrigin: FieldValueOrigin;
    confidence: number;
    sourceRef: string;
  }>>;
  /** SellerSprite 原始导表行，属于同一份 Evidence，不是第二事实库。 */
  sellerSpriteRaw?: {
    schemaVersion: "sellersprite-xlsx-raw.v1";
    sourceType: "sellersprite_xlsx";
    sourceFileSha256: string | null;
    rows: Array<{
      rowNumber: number;
      columns: Record<string, string | null>;
      extraRaw: Record<string, string | null>;
      extraRawMetricNature: Record<string, MetricNature>;
    }>;
  };
  /** V5.1 Capture Deep Expansion: 变体销售拆解与属性 */
  childSales?: number | null;
  childRevenue?: number | null;
  currentAsinSalesShare?: number | null;
  isDominantVariation?: boolean | null;
  isMinorVariation?: boolean | null;
  sellerLocation?: string | null;
  dealBadge?: string | null;
  /** V5.1 Capture Deep Expansion: 市场集中度与自营霸盘率 */
  brandCr5Share?: number | null;
  amazon1pShare?: number | null;
  sellerMarketShare?: number | null;
  sellerOriginDomesticRatio?: number | null;
  /** V5.1 Capture Deep Expansion: 时序指标 (Keepa 导出) */
  timeSeriesMetrics?: {
    price90dMin: number | null;
    price90dAvg: number | null;
    price360dMin: number | null;
    bsr90dAvg: number | null;
    bsrDrops90d: number | null;
    buyBoxAmazonSharePercent: number | null;
    dealCount90d: number | null;
  } | null;
  /** Keepa 原始导出存根 */
  keepaRaw?: {
    schemaVersion: "keepa-export-raw.v1";
    sourceFileSha256: string | null;
    rows: Array<Record<string, string | null>>;
  };
};

/**
 * ProductBatch 的已校验图片快照允许最大 2 MiB；对应 Data URL 约 2.8M 字符。
 * 图片不能复用普通文本字段的 1000 字符上限，否则会把合法图片静默截断。
 */
export const MAX_INLINE_IMAGE_DATA_URL_LENGTH = 2_800_000;

/** 每个字段必须显式带状态；类型层面强制完整覆盖，避免漏标。 */
export type CaptureFieldStates = Record<CaptureFieldKey, CaptureField>;

export type CaptureSourceProof = {
  sourceType: CaptureSourceType;
  sourceUrl: string | null;
  capturedAt: string;
  captureMethod: CaptureMethod;
  operator: string;
  /** 来源文件/批次指纹（如 XLSX SHA-256），用于 Replay 与去重。 */
  sourceFingerprint: string | null;
  /** 单条记录在来源中的稳定标识（如行号 / 行哈希）。 */
  sourceRecordRef: string | null;
  /** 来源语义标签：用于区分 SellerSprite 页面可见 DOM、人工取证与官方 XLSX。 */
  sourceMethod?:
    | "amazon_dom_observed"
    | "sellersprite_page_visible_dom"
    | "sellersprite_page_manual_tsv"
    | "sellersprite_official_xlsx"
    | "manual"
    | string;
  /**
   * 商品实体绑定证明。旧 CapturePackage 没有该字段时保持可读，但新
   * Amazon/SellerSprite 采集不得用默认域名伪造证明。
   */
  entityBinding?: CaptureEntityBindingProof;
};

export type CaptureEntityBindingProof = {
  expectedAsin: string | null;
  observedAsin: string | null;
  expectedMarketplace: string;
  observedMarketplace: string | null;
  urlAsin: string | null;
  urlMarketplace: string | null;
  bound: boolean;
};

/** Capture Replay：出问题时能回答「为什么这个字段错误」。 */
export type CaptureReplay = {
  url: string | null;
  capturedAt: string;
  /** 页面/文件摘要，绝不保存完整正文或凭据。 */
  pageDigest: string;
  warnings: string[];
};

export type CapturePackage = {
  schemaVersion: typeof SOURCE_LAYER_SCHEMA_VERSION;
  /** 采集包自身 id（服务端生成，稳定可追溯）。 */
  captureId: string;
  /** 商品身份键（marketplace:ASIN 或手动输入键），同一商品多次采集共享。 */
  subjectKey: string;
  version: number;
  marketplace: string;
  fields: CaptureFields;
  /** 旧包可缺省；新采集的详情规格保留在同一份 Evidence 中。 */
  extensions?: CapturePackageExtensions;
  fieldStates: CaptureFieldStates;
  sourceProof: CaptureSourceProof;
  riskFlags: RiskFlag[];
  replay: CaptureReplay;
};

/** Adapter 产出的候选值：带原始引用与来源方式，但尚未定状态。 */
export type CaptureFieldDraft<T> = {
  value: T;
  valueOrigin: FieldValueOrigin;
  metricNature?: MetricNature;
  sourceRef: string;
  confidence?: number;
};

export type CapturePackageDraft = {
  subjectKey: string;
  marketplace: string;
  fields: {
    asin: CaptureFieldDraft<string | null>;
    title: CaptureFieldDraft<string | null>;
    brand?: CaptureFieldDraft<string | null>;
    images: CaptureFieldDraft<string[]>;
    price: CaptureFieldDraft<{ amount: number; currency: string } | null>;
    rating: CaptureFieldDraft<number | null>;
    reviewCount: CaptureFieldDraft<number | null>;
    bsr: CaptureFieldDraft<{ rank: number; category: string | null } | null>;
    subCategoryBsr?: CaptureFieldDraft<number | null>;
    estimatedMonthlySales?: CaptureFieldDraft<number | null>;
    estimatedMonthlyRevenueUsd?: CaptureFieldDraft<number | null>;
    keywords: CaptureFieldDraft<string[]>;
  };
  extensions?: CapturePackageExtensions;
  sourceProof: CaptureSourceProof;
  replay: CaptureReplay;
};

const SOURCE_TYPE_TRUST: Readonly<Record<CaptureSourceType, SourceTrustLevel>> = Object.freeze({
  amazon_dom: "trusted",
  // Plugin / XLSX / API 使用相同字段级信任契约；估算指标仍由 metricNature 限制。
  sellersprite_plugin: "trusted",
  sellersprite_xlsx: "trusted",
  sellersprite_api: "trusted",
  keepa_export: "trusted",
  manual_entry: "trusted",
  excel_upload: "trusted",
  public_api: "trusted",
  browser_agent: "estimated_only",
});

const SOURCE_TYPE_METHODS: Readonly<Record<CaptureSourceType, CaptureMethod>> = Object.freeze({
  amazon_dom: "browser_dom",
  sellersprite_plugin: "browser_dom",
  sellersprite_xlsx: "xlsx_export",
  sellersprite_api: "api_response",
  keepa_export: "xlsx_export",
  manual_entry: "manual_form",
  excel_upload: "xlsx_export",
  public_api: "open_data",
  browser_agent: "browser_dom",
});

export function sourceTrustLevelOf(sourceType: CaptureSourceType): SourceTrustLevel {
  return SOURCE_TYPE_TRUST[sourceType] ?? "untrusted";
}

export function defaultCaptureMethodFor(sourceType: CaptureSourceType): CaptureMethod {
  return SOURCE_TYPE_METHODS[sourceType] ?? "manual_form";
}

/** 该来源是否允许产出 confirmed 字段（第三方估算来源只能 estimated）。 */
export function sourceAllowsConfirmed(sourceType: CaptureSourceType): boolean {
  return sourceTrustLevelOf(sourceType) === "trusted";
}

function confidenceOf(origin: FieldValueOrigin, declared: number | undefined): number {
  if (typeof declared === "number" && Number.isFinite(declared)) {
    return Math.min(1, Math.max(0, declared));
  }
  switch (origin) {
    case "page_measured":
    case "provider_export":
    case "human_manual":
      return 1;
    case "derived":
      return 0.8;
    case "model_estimated":
      return 0.4;
    default:
      return 0;
  }
}

function metricNatureOf(
  valueOrigin: FieldValueOrigin,
  declared: MetricNature | undefined,
): MetricNature {
  if (valueOrigin === "model_estimated") return "estimate";
  if (valueOrigin === "derived") return "derived";
  if (declared && METRIC_NATURES.includes(declared)) return declared;
  switch (valueOrigin) {
    case "page_measured":
    case "provider_export":
    case "human_manual":
      return "snapshot";
    default:
      return "unknown";
  }
}

export function metricNatureFromCaptureField(field: Pick<CaptureField, "metricNature" | "valueOrigin" | "status">): MetricNature {
  if (field.metricNature && METRIC_NATURES.includes(field.metricNature)) return field.metricNature;
  return metricNatureOf(field.valueOrigin, undefined);
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function fieldFromDraft(
  draft: CaptureFieldDraft<unknown>,
  sourceType: CaptureSourceType,
): CaptureField {
  if (isEmptyValue(draft.value)) {
    return {
      status: "missing",
      metricNature: "unknown",
      valueOrigin: draft.valueOrigin,
      confidence: 0,
      sourceRef: draft.sourceRef,
    };
  }
  const declaredConfidence = confidenceOf(draft.valueOrigin, draft.confidence);
  const metricNature = metricNatureOf(draft.valueOrigin, draft.metricNature);
  // 非可信来源即使有值也只能是 estimated；估算、derived、unknown 永远不能 confirmed。
  const status: FieldStatus = sourceAllowsConfirmed(sourceType)
    && metricNature === "snapshot"
    ? "confirmed"
    : "estimated";
  const confidence = status === "estimated" && draft.confidence === undefined
    ? Math.min(0.8, declaredConfidence) : declaredConfidence;
  return { status, metricNature, valueOrigin: draft.valueOrigin, confidence, sourceRef: draft.sourceRef };
}

function asinFromUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return /amazon\./i.test(url.hostname)
      ? (/(?:\/dp\/|\/gp\/product\/)([A-Za-z0-9]{10})(?:[/?]|$)/i.exec(url.pathname)?.[1]?.toUpperCase() ?? null)
      : null;
  } catch {
    return null;
  }
}

function marketplaceFromUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const host = new URL(value).hostname.toLowerCase();
    const suffixes: Array<[string, string]> = [
      ["amazon.com", "US"],
      ["amazon.co.uk", "UK"],
      ["amazon.ca", "CA"],
      ["amazon.de", "DE"],
      ["amazon.fr", "FR"],
      ["amazon.it", "IT"],
      ["amazon.es", "ES"],
      ["amazon.co.jp", "JP"],
      ["amazon.com.au", "AU"],
    ];
    return suffixes.find(([suffix]) => host === suffix || host.endsWith(`.${suffix}`))?.[1] ?? null;
  } catch {
    return null;
  }
}

function entityBindingFor(input: {
  asin: string | null;
  marketplace: string;
  sourceUrl: string | null;
}): CaptureEntityBindingProof {
  const expectedMarketplace = input.marketplace.trim().toUpperCase();
  const urlAsin = asinFromUrl(input.sourceUrl);
  const urlMarketplace = marketplaceFromUrl(input.sourceUrl);
  const observedAsin = input.asin;
  return {
    expectedAsin: input.asin,
    observedAsin,
    expectedMarketplace,
    observedMarketplace: urlMarketplace,
    urlAsin,
    urlMarketplace,
    bound: input.asin !== null
      && urlAsin === input.asin
      && urlMarketplace === expectedMarketplace,
  };
}

/**
 * 由 Adapter 草稿生成类型安全的 Capture Package。
 * 严格 fail-closed：结构不合法直接抛错，不产出「半个包」。
 */
export function buildCapturePackage(input: {
  captureId: string;
  version: number;
  draft: CapturePackageDraft;
}): CapturePackage {
  const { draft } = input;
  if (!input.captureId.trim()) throw new Error("CAPTURE_ID_REQUIRED");
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new Error("CAPTURE_VERSION_INVALID");
  }
  if (!draft.subjectKey.trim()) throw new Error("CAPTURE_SUBJECT_KEY_REQUIRED");
  if (!draft.marketplace.trim()) throw new Error("CAPTURE_MARKETPLACE_REQUIRED");
  if (!SOURCE_TYPES.includes(draft.sourceProof.sourceType)) {
    throw new Error("CAPTURE_SOURCE_TYPE_UNKNOWN");
  }
  if (sourceTrustLevelOf(draft.sourceProof.sourceType) === "untrusted") {
    throw new Error("CAPTURE_SOURCE_TYPE_UNTRUSTED");
  }

  const sourceType = draft.sourceProof.sourceType;
  const fields: CaptureFields = {
    asin: normalizeAsin(draft.fields.asin.value),
    title: normalizeText(draft.fields.title.value),
    brand: normalizeText(draft.fields.brand?.value ?? null),
    images: normalizeStringList(draft.fields.images.value, MAX_INLINE_IMAGE_DATA_URL_LENGTH),
    price: normalizePrice(draft.fields.price.value),
    rating: normalizeRating(draft.fields.rating.value),
    reviewCount: normalizeReviewCount(draft.fields.reviewCount.value),
    bsr: normalizeBsr(draft.fields.bsr.value),
    subCategoryBsr: normalizeReviewCount(draft.fields.subCategoryBsr?.value ?? null),
    estimatedMonthlySales: normalizeReviewCount(draft.fields.estimatedMonthlySales?.value ?? null),
    estimatedMonthlyRevenueUsd: normalizePriceAmount(draft.fields.estimatedMonthlyRevenueUsd?.value ?? null),
    keywords: normalizeStringList(draft.fields.keywords.value),
  };

  const fieldStates = Object.fromEntries(
    CAPTURE_FIELD_KEYS.map((key) => {
      const draftField = draft.fields[key] as CaptureFieldDraft<unknown> | undefined;
      const state = draftField
        ? fieldFromDraft(key === "estimatedMonthlySales" || key === "estimatedMonthlyRevenueUsd"
          ? { ...draftField, metricNature: "estimate" } : draftField, sourceType)
        : {
            status: "missing" as const,
            metricNature: "unknown" as const,
            valueOrigin: sourceType === "manual_entry" ? ("human_manual" as const) : ("provider_export" as const),
            confidence: 0,
            sourceRef: `default.${key}`,
          };
      // 归一化可能把非法值清成 null（如 rating=abc → null），状态必须跟随结果而不是草稿。
      const normalized = fields[key];
      if (isEmptyValue(normalized) && state.status !== "missing") {
        return [key, { ...state, status: "missing" as const, metricNature: "unknown" as const, confidence: 0 }];
      }
      // estimated 字段的置信度不允许被抬到 1（避免「估算冒充实测」）。
      if (state.status === "estimated" && state.valueOrigin === "model_estimated") {
        return [key, { ...state, confidence: Math.min(state.confidence, 0.4) }];
      }
      return [key, state];
    }),
  ) as CaptureFieldStates;

  return {
    schemaVersion: SOURCE_LAYER_SCHEMA_VERSION,
    captureId: input.captureId.trim(),
    subjectKey: draft.subjectKey.trim(),
    version: input.version,
    marketplace: draft.marketplace.trim().toUpperCase(),
    fields,
    extensions: normalizeExtensions(draft.extensions),
    fieldStates,
    sourceProof: {
      ...draft.sourceProof,
      sourceType,
      captureMethod: draft.sourceProof.captureMethod,
      capturedAt: draft.sourceProof.capturedAt,
      entityBinding: draft.sourceProof.entityBinding ?? entityBindingFor({
        asin: fields.asin,
        marketplace: draft.marketplace,
        sourceUrl: draft.sourceProof.sourceUrl,
      }),
    },
    riskFlags: [],
    replay: draft.replay,
  };
}

/** 由字段状态确定性派生风险标记（不引入额外信息，只做映射）。 */
export function deriveRiskFlags(input: {
  fields: CaptureFields;
  fieldStates: CaptureFieldStates;
  sourceType: CaptureSourceType;
  errors?: readonly SourceLayerError[];
}): RiskFlag[] {
  const flags = new Set<RiskFlag>();
  const { fields, fieldStates } = input;

  // 缺失价格不是「波动」证据；风险标记不得把缺失伪装成观测结论。
  if (fields.price !== null && fieldStates.price.status === "estimated") flags.add("price_volatile");
  if (typeof fields.rating === "number" && fields.rating < 4) flags.add("rating_low");
  if (typeof fields.reviewCount === "number" && fields.reviewCount < 50) {
    flags.add("review_count_low");
  }
  if (fieldStates.bsr.status === "missing") flags.add("bsr_weak");
  if (fields.images.length === 0) flags.add("image_missing");
  else if (fields.images.length === 1) flags.add("image_single");
  if (typeof fields.title === "string" && fields.title.length < 20) flags.add("title_too_short");
  if (fields.keywords.length === 0) flags.add("keyword_missing");
  if (fields.asin === null) flags.add("identity_unverified");
  if (!sourceAllowsConfirmed(input.sourceType)) flags.add("provider_estimate_only");

  const conflictFields = CAPTURE_FIELD_KEYS.filter(
    (key) => fieldStates[key].status === "conflict",
  );
  if (conflictFields.length > 0) flags.add("field_conflict");

  for (const error of input.errors ?? []) {
    if (error.code === "SOURCE_EXPIRED") flags.add("source_expired");
    if (error.code === "FIELD_CONFLICT") flags.add("field_conflict");
    if (error.code === "CAPTCHA_DETECTED") flags.add("captcha_detected");
    if (error.code === "LOGIN_REQUIRED") flags.add("login_required");
    if (error.code === "PAGE_CHANGED" || error.code === "DOM_CHANGED") {
      flags.add("page_structure_changed");
    }
  }

  return [...flags].sort();
}

/* ── 归一化与校验收紧 ───────────────────────────────────────────── */

function normalizeText(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized.slice(0, 500) : null;
}

export function normalizeAsin(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(normalized) ? normalized : null;
}

function normalizeStringList(value: string[], maxItemLength = 1000): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized.slice(0, maxItemLength));
    if (out.length >= 30) break;
  }
  return out;
}

function normalizePrice(
  value: { amount: number; currency: string } | null,
): { amount: number; currency: string } | null {
  if (!value || typeof value.amount !== "number" || !Number.isFinite(value.amount)) return null;
  if (value.amount < 0 || value.amount > 1_000_000) return null;
  const currency = typeof value.currency === "string"
    ? value.currency.trim().toUpperCase().slice(0, 3)
    : "";
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  return { amount: Math.round(value.amount * 100) / 100, currency };
}

function normalizeRating(value: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 5) return null;
  return Math.round(value * 10) / 10;
}

function normalizeReviewCount(value: number | null): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  if (value < 0 || value > 1_000_000_000) return null;
  return value;
}

function normalizeBsr(
  value: { rank: number; category: string | null } | null,
): { rank: number; category: string | null } | null {
  if (!value || typeof value.rank !== "number" || !Number.isSafeInteger(value.rank)) return null;
  if (value.rank < 1 || value.rank > 1_000_000_000) return null;
  const category = typeof value.category === "string" && value.category.trim()
    ? value.category.trim().slice(0, 200)
    : null;
  return { rank: value.rank, category };
}

function normalizePriceAmount(value: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1_000_000_000) return null;
  return Math.round(value * 100) / 100;
}

function isBoughtPastMonthEstimate(value: unknown): value is BoughtPastMonthEstimate {
  if (!isRecord(value)) return false;
  const boundIsValid = (bound: unknown) => bound === null || (typeof bound === "number" && Number.isSafeInteger(bound) && bound >= 0);
  const lowerBound = value.lowerBound;
  const upperBound = value.upperBound;
  const validRange = value.qualifier !== "range"
    || (typeof lowerBound === "number" && typeof upperBound === "number" && upperBound >= lowerBound);
  return typeof value.rawText === "string"
    && value.rawText.trim().length > 0
    && value.rawText.length <= 160
    && boundIsValid(value.lowerBound)
    && boundIsValid(value.upperBound)
    && ["exact", "at_least", "range", "approximate", "unknown"].includes(String(value.qualifier))
    && value.metricNature === "estimate"
    && validRange
    && (value.qualifier !== "at_least" || (typeof lowerBound === "number" && upperBound === null));
}

function isBoundedJsonValue(value: unknown, state = { nodes: 0 }, depth = 0): boolean {
  state.nodes += 1;
  if (state.nodes > 2_000 || depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 4_096;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 120 && value.every((item) => isBoundedJsonValue(item, state, depth + 1));
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 40
    && entries.every(([key, item]) => key.length <= 100 && isBoundedJsonValue(item, state, depth + 1));
}

export function parseAmazonDetailCaptureEvidence(value: unknown): AmazonDetailCaptureEvidence | null {
  if (!isRecord(value)
    || value.schemaVersion !== "amazon-detail-registered-fields.v1"
    || value.extractorVersion !== "amazon-detail-extractor.v2"
    || value.fieldRegistryVersion !== "amazon-detail-field-registry.v1"
    || value.primaryBsrProjectionVersion !== "primary-bsr.v1"
    || (value.resolverVersion !== undefined && value.resolverVersion !== AMAZON_DETAIL_FIELD_RESOLVER_VERSION)
    || !isRecord(value.registeredFields)) return null;

  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length > MAX_AMAZON_DETAIL_EVIDENCE_CHARS) return null;
  const fields = value.registeredFields;
  const entries = Object.entries(fields);
  if (entries.length === 0 || entries.length > 60) return null;

  for (const [key, candidate] of entries) {
    if (!isRecord(candidate)
      || candidate.canonicalField !== key
      || !["P0", "P1", "P2", "BLOCKED"].includes(String(candidate.priority))
      || !["DIRECT_FACT", "DERIVED_FACT", "ESTIMATED_METRIC", "CONDITIONAL_FACT", "BLOCKED"].includes(String(candidate.fieldNature))
      || !["observed", "derived", "missing", "ambiguous", "invalid", "blocked"].includes(String(candidate.status))
      || (candidate.reason !== null && (typeof candidate.reason !== "string" || candidate.reason.length > 240))
      || !isRecord(candidate.sourceTrace)) return null;
    const sourceTrace = candidate.sourceTrace;
    if (typeof sourceTrace.ruleId !== "string" || sourceTrace.ruleId.length > 120
      || sourceTrace.registryVersion !== value.fieldRegistryVersion
      || typeof sourceTrace.region !== "string" || sourceTrace.region.length > 120
      || (sourceTrace.selector !== null && (typeof sourceTrace.selector !== "string" || sourceTrace.selector.length > 240))
      || (sourceTrace.label !== null && (typeof sourceTrace.label !== "string" || sourceTrace.label.length > 160))
      || (sourceTrace.ruleVersion !== null && (typeof sourceTrace.ruleVersion !== "string" || sourceTrace.ruleVersion.length > 100))) return null;
    if (sourceTrace.semanticRole !== undefined && sourceTrace.semanticRole !== null
      && (typeof sourceTrace.semanticRole !== "string" || sourceTrace.semanticRole.length > 80)) return null;
    if (sourceTrace.resolverVersion !== undefined && sourceTrace.resolverVersion !== null
      && (sourceTrace.resolverVersion !== AMAZON_DETAIL_FIELD_RESOLVER_VERSION || sourceTrace.resolverVersion !== value.resolverVersion)) return null;
    if (sourceTrace.purchaseContext !== undefined && sourceTrace.purchaseContext !== null
      && !["one_time", "subscribe_save", "unknown", "not_applicable"].includes(String(sourceTrace.purchaseContext))) return null;
    if (sourceTrace.selected !== undefined && sourceTrace.selected !== null && typeof sourceTrace.selected !== "boolean") return null;
    if (candidate.candidateDiagnostics !== undefined) {
      if (!Array.isArray(candidate.candidateDiagnostics) || candidate.candidateDiagnostics.length > AMAZON_DETAIL_CANDIDATE_DIAGNOSTIC_LIMIT) return null;
      for (const diagnostic of candidate.candidateDiagnostics) {
        if (!isRecord(diagnostic)
          || (diagnostic.rawValue !== null && (typeof diagnostic.rawValue !== "string" || diagnostic.rawValue.length > 500))
          || (diagnostic.status !== "accepted" && diagnostic.status !== "rejected")
          || typeof diagnostic.reason !== "string" || diagnostic.reason.length > 100
          || !isRecord(diagnostic.sourceTrace)
          || !isBoundedJsonValue(diagnostic.canonicalValue)) return null;
        const trace = diagnostic.sourceTrace;
        if (typeof trace.ruleId !== "string" || trace.ruleId !== key
          || trace.registryVersion !== value.fieldRegistryVersion
          || typeof trace.region !== "string" || trace.region.length > 120
          || typeof trace.selector !== "string" || !trace.selector.trim() || trace.selector.length > 240
          || (trace.label !== null && (typeof trace.label !== "string" || trace.label.length > 160))
          || (trace.ruleVersion !== null && (typeof trace.ruleVersion !== "string" || trace.ruleVersion.length > 100))
          || (trace.resolverVersion !== undefined && trace.resolverVersion !== value.resolverVersion)
          || (trace.semanticRole !== undefined && trace.semanticRole !== null && typeof trace.semanticRole !== "string")
          || (trace.purchaseContext !== undefined && trace.purchaseContext !== null
            && !["one_time", "subscribe_save", "unknown", "not_applicable"].includes(String(trace.purchaseContext)))
          || (trace.selected !== undefined && trace.selected !== null && typeof trace.selected !== "boolean")) return null;
      }
    }
    if (candidate.candidateDiagnosticsTruncatedCount !== undefined
      && (!Number.isSafeInteger(candidate.candidateDiagnosticsTruncatedCount)
        || Number(candidate.candidateDiagnosticsTruncatedCount) < 1
        || Number(candidate.candidateDiagnosticsTruncatedCount) > 800
        || candidate.status !== "ambiguous"
        || !Array.isArray(candidate.candidateDiagnostics)
        || candidate.candidateDiagnostics.length !== AMAZON_DETAIL_CANDIDATE_DIAGNOSTIC_LIMIT)) return null;
    if (candidate.fieldNature === "BLOCKED") {
      if (candidate.status !== "blocked" || candidate.value !== null) return null;
    } else if (candidate.status === "blocked") {
      return null;
    }
    if (!isBoundedJsonValue(candidate.value)) return null;
    if (key === "boughtPastMonth" && candidate.value !== null && !isBoughtPastMonthEstimate(candidate.value)) return null;
    if (key === "rawSpecifications" && candidate.value !== null) {
      if (!Array.isArray(candidate.value) || candidate.value.length > 40) return null;
      for (const row of candidate.value) {
        if (!isRecord(row)
          || typeof row.label !== "string"
          || typeof row.value !== "string"
          || (row.region !== undefined && typeof row.region !== "string")
          || (row.selector !== undefined && typeof row.selector !== "string")
          || (row.text !== undefined && typeof row.text !== "string")
          || row.label.length > 100
          || row.value.length > 300
          || (typeof row.text === "string" && row.text.length > 400)) return null;
      }
    }
  }

  for (const blockedField of ["fbaFee", "estimatedMonthlySales", "estimatedMonthlyRevenue"]) {
    const field = fields[blockedField];
    if (!isRecord(field) || field.fieldNature !== "BLOCKED" || field.status !== "blocked" || field.value !== null) return null;
  }
  return value as unknown as AmazonDetailCaptureEvidence;
}

function normalizeExtensions(value: CapturePackageExtensions | undefined): CapturePackageExtensions | undefined {
  if (!value) return undefined;
  const out: CapturePackageExtensions = {};
  if (Array.isArray(value.bulletPoints)) {
    const bulletPoints = normalizeStringList(value.bulletPoints, 1000);
    out.bulletPoints = bulletPoints.length > 0 ? bulletPoints : null;
  } else if (value.bulletPoints === null) {
    out.bulletPoints = null;
  }
  if (typeof value.launchedDate === "string" && value.launchedDate.trim()) {
    out.launchedDate = value.launchedDate.trim().slice(0, 80);
  } else if (value.launchedDate === null) {
    out.launchedDate = null;
  }
  if (typeof value.dateFirstAvailable === "string" && value.dateFirstAvailable.trim()) {
    out.dateFirstAvailable = value.dateFirstAvailable.trim().slice(0, 80);
  } else if (value.dateFirstAvailable === null) {
    out.dateFirstAvailable = null;
  }
  for (const key of ["buyboxSeller", "fulfillmentType"] as const) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim()) {
      out[key] = raw.trim().slice(0, 500);
    } else if (raw === null) {
      out[key] = null;
    }
  }
  if (value.packageWeight && typeof value.packageWeight === "object") {
    const weight = value.packageWeight;
    if (Number.isFinite(weight.value) && weight.value >= 0 && ["kg", "lb", "oz", "g"].includes(weight.unit)) {
      out.packageWeight = { value: Math.round(weight.value * 1000) / 1000, unit: weight.unit };
    }
  } else if (value.packageWeight === null) {
    out.packageWeight = null;
  }
  if (value.packageDimensions && typeof value.packageDimensions === "object") {
    const dimensions = value.packageDimensions;
    if (
      Number.isFinite(dimensions.length)
      && Number.isFinite(dimensions.width)
      && Number.isFinite(dimensions.height)
      && dimensions.length >= 0
      && dimensions.width >= 0
      && dimensions.height >= 0
      && ["cm", "in"].includes(dimensions.unit)
    ) {
      out.packageDimensions = {
        length: Math.round(dimensions.length * 1000) / 1000,
        width: Math.round(dimensions.width * 1000) / 1000,
        height: Math.round(dimensions.height * 1000) / 1000,
        unit: dimensions.unit,
      };
    }
  } else if (value.packageDimensions === null) {
    out.packageDimensions = null;
  }
  if (value.itemWeight && typeof value.itemWeight === "object") {
    const weight = value.itemWeight;
    if (Number.isFinite(weight.value) && weight.value >= 0 && ["kg", "lb", "oz", "g"].includes(weight.unit)) {
      out.itemWeight = { value: Math.round(weight.value * 1000) / 1000, unit: weight.unit };
    }
  } else if (value.itemWeight === null) {
    out.itemWeight = null;
  }
  if (value.itemDimensions && typeof value.itemDimensions === "object") {
    const dimensions = value.itemDimensions;
    if (Number.isFinite(dimensions.length) && Number.isFinite(dimensions.width) && Number.isFinite(dimensions.height)
      && dimensions.length >= 0 && dimensions.width >= 0 && dimensions.height >= 0
      && ["cm", "in"].includes(dimensions.unit)) {
      out.itemDimensions = {
        length: Math.round(dimensions.length * 1000) / 1000,
        width: Math.round(dimensions.width * 1000) / 1000,
        height: Math.round(dimensions.height * 1000) / 1000,
        unit: dimensions.unit,
      };
    }
  } else if (value.itemDimensions === null) {
    out.itemDimensions = null;
  }
  if (value.fbaFee && typeof value.fbaFee === "object") {
    const fee = normalizePrice(value.fbaFee);
    if (fee) out.fbaFee = fee;
  } else if (value.fbaFee === null) {
    out.fbaFee = null;
  }
  const copyTextList = (key: "categoryPath" | "includedComponents" | "galleryImageUrls" | "variations") => {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      const list = normalizeStringList(candidate, 1000);
      out[key] = list.length > 0 ? list : null;
    } else if (candidate === null) {
      out[key] = null;
    }
  };
  copyTextList("categoryPath");
  copyTextList("includedComponents");
  copyTextList("galleryImageUrls");
  copyTextList("variations");
  const copyText = (key: "parentAsin" | "material" | "seller" | "shipsFrom" | "fulfillment") => {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) out[key] = candidate.trim().slice(0, 500);
    else if (candidate === null) out[key] = null;
  };
  copyText("parentAsin");
  copyText("material");
  copyText("seller");
  copyText("shipsFrom");
  copyText("fulfillment");
  if (value.listPrice && typeof value.listPrice === "object") {
    const listPrice = normalizePrice(value.listPrice);
    if (listPrice) out.listPrice = listPrice;
  } else if (value.listPrice === null) {
    out.listPrice = null;
  }
  if (value.coupon && typeof value.coupon === "object") {
    const coupon = value.coupon;
    const amount = typeof coupon.amount === "number" && Number.isFinite(coupon.amount) && coupon.amount >= 0
      ? Math.round(coupon.amount * 100) / 100
      : null;
    const percent = typeof coupon.percent === "number" && Number.isFinite(coupon.percent) && coupon.percent >= 0 && coupon.percent <= 100
      ? Math.round(coupon.percent * 100) / 100
      : null;
    const text = typeof coupon.text === "string" && coupon.text.trim() ? coupon.text.trim().slice(0, 300) : null;
    const currency = typeof coupon.currency === "string" && /^[A-Z]{3}$/i.test(coupon.currency.trim())
      ? coupon.currency.trim().toUpperCase()
      : null;
    out.coupon = { text, amount, percent, currency };
  } else if (value.coupon === null) {
    out.coupon = null;
  }
  if (value.buyBox && typeof value.buyBox === "object") {
    out.buyBox = {
      seller: typeof value.buyBox.seller === "string" && value.buyBox.seller.trim()
        ? value.buyBox.seller.trim().slice(0, 300)
        : null,
      price: value.buyBox.price && typeof value.buyBox.price === "object"
        ? normalizePrice(value.buyBox.price)
        : null,
    };
  } else if (value.buyBox === null) {
    out.buyBox = null;
  }
  if (value.ratingDistribution && typeof value.ratingDistribution === "object") {
    const distribution: Record<string, number> = {};
    for (const [key, candidate] of Object.entries(value.ratingDistribution)) {
      if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
        distribution[key.slice(0, 32)] = Math.round(candidate);
      }
    }
    out.ratingDistribution = Object.keys(distribution).length > 0 ? distribution : null;
  } else if (value.ratingDistribution === null) {
    out.ratingDistribution = null;
  }
  if (typeof value.boughtPastMonth === "number" && Number.isSafeInteger(value.boughtPastMonth) && value.boughtPastMonth >= 0) {
    out.boughtPastMonth = value.boughtPastMonth;
  } else if (isBoughtPastMonthEstimate(value.boughtPastMonth)) {
    out.boughtPastMonth = {
      rawText: value.boughtPastMonth.rawText.trim().slice(0, 160),
      lowerBound: value.boughtPastMonth.lowerBound,
      upperBound: value.boughtPastMonth.upperBound,
      qualifier: value.boughtPastMonth.qualifier,
      metricNature: "estimate",
    };
  } else if (value.boughtPastMonth === null) {
    out.boughtPastMonth = null;
  }
  if (Array.isArray(value.bsrRanks)) {
    out.bsrRanks = value.bsrRanks
      .filter((item) => Number.isSafeInteger(item.rank) && item.rank > 0 && typeof item.category === "string" && item.category.trim())
      .slice(0, 40)
      .map((item) => ({ rank: item.rank, category: item.category.trim().slice(0, 200) }));
  } else if (value.bsrRanks === null) {
    out.bsrRanks = null;
  }
  if (value.amazonDetail !== undefined) {
    const amazonDetail = parseAmazonDetailCaptureEvidence(value.amazonDetail);
    if (!amazonDetail) throw new Error("AMAZON_DETAIL_EVIDENCE_INVALID");
    out.amazonDetail = amazonDetail;
  }
  if (typeof value.sourceMethod === "string" && value.sourceMethod.trim()) {
    out.sourceMethod = value.sourceMethod.trim().slice(0, 96);
  } else if (value.sourceMethod === null) {
    out.sourceMethod = null;
  }
  if (value.estimatedFbaFee && typeof value.estimatedFbaFee === "object") {
    const fee = normalizePrice(value.estimatedFbaFee);
    if (fee) out.estimatedFbaFee = fee;
  } else if (value.estimatedFbaFee === null) {
    out.estimatedFbaFee = null;
  }
  for (const key of ["estimatedGrossMargin", "listingQualityScore"] as const) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1_000_000_000) {
      out[key] = Math.round(raw * 100) / 100;
    } else if (raw === null) {
      out[key] = null;
    }
  }
  if (isRecord(value.fieldMetadata)) {
    const metadata: NonNullable<CapturePackageExtensions["fieldMetadata"]> = {};
    for (const [key, raw] of Object.entries(value.fieldMetadata)) {
      if (!isRecord(raw)
        || !METRIC_NATURES.includes(raw.metricNature as MetricNature)
        || !FIELD_VALUE_ORIGINS.includes(raw.valueOrigin as FieldValueOrigin)
        || typeof raw.confidence !== "number"
        || !Number.isFinite(raw.confidence)
        || raw.confidence < 0
        || raw.confidence > 1
        || typeof raw.sourceRef !== "string") {
        continue;
      }
      metadata[key] = {
        metricNature: raw.metricNature as MetricNature,
        valueOrigin: raw.valueOrigin as FieldValueOrigin,
        confidence: raw.confidence,
        sourceRef: raw.sourceRef,
      };
    }
    if (Object.keys(metadata).length > 0) out.fieldMetadata = metadata;
  }
  if (isRecord(value.sellerSpriteRaw)
    && value.sellerSpriteRaw.schemaVersion === "sellersprite-xlsx-raw.v1"
    && value.sellerSpriteRaw.sourceType === "sellersprite_xlsx"
    && (value.sellerSpriteRaw.sourceFileSha256 === null
      || (typeof value.sellerSpriteRaw.sourceFileSha256 === "string"
        && /^[a-f0-9]{64}$/u.test(value.sellerSpriteRaw.sourceFileSha256)))
    && Array.isArray(value.sellerSpriteRaw.rows)) {
    const rows = value.sellerSpriteRaw.rows.flatMap((rawRow) => {
      if (!isRecord(rawRow)
        || !Number.isSafeInteger(rawRow.rowNumber)
        || (rawRow.rowNumber as number) < 1
        || !isRecord(rawRow.columns)
        || !isRecord(rawRow.extraRaw)
        || !isRecord(rawRow.extraRawMetricNature)) return [];
      const copyColumns = (raw: Record<string, unknown>): Record<string, string | null> | null => {
        const entries = Object.entries(raw);
        if (entries.some(([, item]) => item !== null && typeof item !== "string")) return null;
        return Object.fromEntries(entries.map(([key, item]) => [key, item as string | null]));
      };
      const columns = copyColumns(rawRow.columns);
      const extraRaw = copyColumns(rawRow.extraRaw);
      if (!columns || !extraRaw) return [];
      const extraRawMetricNature = Object.fromEntries(
        Object.entries(rawRow.extraRawMetricNature).filter(([, item]) => (
          METRIC_NATURES.includes(item as MetricNature)
        )),
      ) as Record<string, MetricNature>;
      return [{
        rowNumber: rawRow.rowNumber as number,
        columns,
        extraRaw,
        extraRawMetricNature,
      }];
    });
    out.sellerSpriteRaw = {
      schemaVersion: "sellersprite-xlsx-raw.v1",
      sourceType: "sellersprite_xlsx",
      sourceFileSha256: value.sellerSpriteRaw.sourceFileSha256 as string | null,
      rows,
    };
  }
  for (const key of ["childSales", "childRevenue", "currentAsinSalesShare", "brandCr5Share", "amazon1pShare", "sellerMarketShare", "sellerOriginDomesticRatio"] as const) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = raw;
    } else if (raw === null) {
      out[key] = null;
    }
  }
  for (const key of ["isDominantVariation", "isMinorVariation"] as const) {
    const raw = value[key];
    if (typeof raw === "boolean") {
      out[key] = raw;
    } else if (raw === null) {
      out[key] = null;
    }
  }
  for (const key of ["sellerLocation", "dealBadge"] as const) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim()) {
      out[key] = raw.trim().slice(0, 160);
    } else if (raw === null) {
      out[key] = null;
    }
  }
  if (isRecord(value.timeSeriesMetrics)) {
    const m = value.timeSeriesMetrics;
    const cleanNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    out.timeSeriesMetrics = {
      price90dMin: cleanNum(m.price90dMin),
      price90dAvg: cleanNum(m.price90dAvg),
      price360dMin: cleanNum(m.price360dMin),
      bsr90dAvg: cleanNum(m.bsr90dAvg),
      bsrDrops90d: cleanNum(m.bsrDrops90d),
      buyBoxAmazonSharePercent: cleanNum(m.buyBoxAmazonSharePercent),
      dealCount90d: cleanNum(m.dealCount90d),
    };
  } else if (value.timeSeriesMetrics === null) {
    out.timeSeriesMetrics = null;
  }
  if (isRecord(value.keepaRaw)
    && value.keepaRaw.schemaVersion === "keepa-export-raw.v1"
    && Array.isArray(value.keepaRaw.rows)) {
    out.keepaRaw = {
      schemaVersion: "keepa-export-raw.v1",
      sourceFileSha256: typeof value.keepaRaw.sourceFileSha256 === "string" ? value.keepaRaw.sourceFileSha256 : null,
      rows: value.keepaRaw.rows.filter(isRecord).map(r => Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, typeof v === "string" ? v : null]),
      )),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/* ── 运行时结构校验（跨进程边界必须重新校验，不信任反序列化结果） ── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCapturePackage(value: unknown): CapturePackage | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== SOURCE_LAYER_SCHEMA_VERSION) return null;
  if (typeof value.captureId !== "string" || !value.captureId.trim()) return null;
  if (typeof value.subjectKey !== "string" || !value.subjectKey.trim()) return null;
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) return null;
  if (typeof value.marketplace !== "string" || !value.marketplace.trim()) return null;
  if (!isRecord(value.fields) || !isRecord(value.fieldStates)) return null;
  if (!isRecord(value.sourceProof) || !isRecord(value.replay)) return null;
  if (!Array.isArray(value.riskFlags)) return null;

  const sourceProof = value.sourceProof;
  if (!SOURCE_TYPES.includes(sourceProof.sourceType as CaptureSourceType)) return null;
  if (!CAPTURE_METHODS.includes(sourceProof.captureMethod as CaptureMethod)) return null;
  if (typeof sourceProof.capturedAt !== "string"
    || !Number.isFinite(Date.parse(sourceProof.capturedAt))) return null;
  if (typeof sourceProof.operator !== "string" || !sourceProof.operator.trim()) return null;
  if (sourceProof.sourceMethod !== undefined
    && sourceProof.sourceMethod !== null
    && (typeof sourceProof.sourceMethod !== "string" || !sourceProof.sourceMethod.trim())) return null;

  const fieldStates = value.fieldStates as Record<string, unknown>;
  const resolvedFieldStates: Record<string, CaptureField> = {};
  for (const key of CAPTURE_FIELD_KEYS) {
    let state = fieldStates[key];
    if (!state) {
      // 向下兼容：旧版持久化未包含 P0 新字段时自动补齐缺失状态，不阻断旧数据读取
      if (
        key === "brand" ||
        key === "subCategoryBsr" ||
        key === "estimatedMonthlySales" ||
        key === "estimatedMonthlyRevenueUsd"
      ) {
        state = {
          status: "missing" as const,
          metricNature: "unknown" as const,
          valueOrigin: "provider_export" as const,
          confidence: 0,
          sourceRef: `legacy_default.${key}`,
        };
      } else {
        return null;
      }
    }
    if (!isRecord(state)) return null;
    if (!FIELD_STATUSES.includes(state.status as FieldStatus)) return null;
    if (state.metricNature !== undefined && !METRIC_NATURES.includes(state.metricNature as MetricNature)) return null;
    if (!FIELD_VALUE_ORIGINS.includes(state.valueOrigin as FieldValueOrigin)) return null;
    if (typeof state.confidence !== "number"
      || !Number.isFinite(state.confidence)
      || state.confidence < 0
      || state.confidence > 1) return null;
    if (typeof state.sourceRef !== "string") return null;
    resolvedFieldStates[key] = {
      ...(state as CaptureField),
      metricNature: METRIC_NATURES.includes(state.metricNature as MetricNature)
        ? state.metricNature as MetricNature
        : metricNatureOf(state.valueOrigin as FieldValueOrigin, undefined),
    };
  }
  if (value.riskFlags.some((flag) => !RISK_FLAGS.includes(flag as RiskFlag))) return null;

  const rawFields = value.fields as Record<string, unknown>;
  const resolvedFields: CaptureFields = {
    asin: (rawFields.asin as string | null) ?? null,
    title: (rawFields.title as string | null) ?? null,
    brand: (rawFields.brand as string | null) ?? null,
    images: Array.isArray(rawFields.images) ? (rawFields.images as string[]) : [],
    price: (rawFields.price as { amount: number; currency: string } | null) ?? null,
    rating: (rawFields.rating as number | null) ?? null,
    reviewCount: (rawFields.reviewCount as number | null) ?? null,
    bsr: (rawFields.bsr as { rank: number; category: string | null } | null) ?? null,
    subCategoryBsr: (rawFields.subCategoryBsr as number | null) ?? null,
    estimatedMonthlySales: (rawFields.estimatedMonthlySales as number | null) ?? null,
    estimatedMonthlyRevenueUsd: (rawFields.estimatedMonthlyRevenueUsd as number | null) ?? null,
    keywords: Array.isArray(rawFields.keywords) ? (rawFields.keywords as string[]) : [],
  };

  let extensions: CapturePackageExtensions | undefined;
  if (value.extensions !== undefined) {
    if (!isRecord(value.extensions)) return null;
    const rawExtensions = value.extensions as Record<string, unknown>;
    const bulletPoints = rawExtensions.bulletPoints;
    const launchedDate = rawExtensions.launchedDate;
    const packageWeight = rawExtensions.packageWeight;
    const packageDimensions = rawExtensions.packageDimensions;
    const itemWeight = rawExtensions.itemWeight;
    const itemDimensions = rawExtensions.itemDimensions;
    const fbaFee = rawExtensions.fbaFee;
    for (const key of ["categoryPath", "includedComponents", "galleryImageUrls", "variations"] as const) {
      const candidate = rawExtensions[key];
      if (candidate !== undefined && candidate !== null
        && (!Array.isArray(candidate) || candidate.some((item) => typeof item !== "string"))) return null;
    }
    for (const key of ["parentAsin", "material", "seller", "shipsFrom", "fulfillment", "sourceMethod"] as const) {
      const candidate = rawExtensions[key];
      if (candidate !== undefined && candidate !== null && typeof candidate !== "string") return null;
    }
    if (
      bulletPoints !== undefined
      && bulletPoints !== null
      && (!Array.isArray(bulletPoints) || bulletPoints.some((item) => typeof item !== "string"))
    ) return null;
    if (launchedDate !== undefined && launchedDate !== null && typeof launchedDate !== "string") return null;
    if (packageWeight !== undefined && packageWeight !== null) {
      if (!isRecord(packageWeight)
        || typeof packageWeight.value !== "number"
        || !Number.isFinite(packageWeight.value)
        || !["kg", "lb", "oz", "g"].includes(String(packageWeight.unit))) return null;
    }
    if (packageDimensions !== undefined && packageDimensions !== null) {
      if (!isRecord(packageDimensions)
        || typeof packageDimensions.length !== "number"
        || typeof packageDimensions.width !== "number"
        || typeof packageDimensions.height !== "number"
        || !Number.isFinite(packageDimensions.length)
        || !Number.isFinite(packageDimensions.width)
        || !Number.isFinite(packageDimensions.height)
        || !["cm", "in"].includes(String(packageDimensions.unit))) return null;
    }
    if (itemWeight !== undefined && itemWeight !== null) {
      if (!isRecord(itemWeight)
        || typeof itemWeight.value !== "number"
        || !Number.isFinite(itemWeight.value)
        || !["kg", "lb", "oz", "g"].includes(String(itemWeight.unit))) return null;
    }
    if (itemDimensions !== undefined && itemDimensions !== null) {
      if (!isRecord(itemDimensions)
        || typeof itemDimensions.length !== "number"
        || typeof itemDimensions.width !== "number"
        || typeof itemDimensions.height !== "number"
        || !Number.isFinite(itemDimensions.length)
        || !Number.isFinite(itemDimensions.width)
        || !Number.isFinite(itemDimensions.height)
        || !["cm", "in"].includes(String(itemDimensions.unit))) return null;
    }
    const bsrRanks = rawExtensions.bsrRanks;
    if (bsrRanks !== undefined && bsrRanks !== null) {
      if (!Array.isArray(bsrRanks) || bsrRanks.length > 40 || bsrRanks.some((item) => !isRecord(item)
        || !Number.isSafeInteger(item.rank) || (item.rank as number) < 1
        || typeof item.category !== "string" || !item.category.trim())) return null;
    }
    if (fbaFee !== undefined && fbaFee !== null) {
      if (!isRecord(fbaFee)
        || typeof fbaFee.amount !== "number"
        || !Number.isFinite(fbaFee.amount)
        || typeof fbaFee.currency !== "string") return null;
    }
    for (const key of ["listPrice", "buyBox"] as const) {
      const candidate = rawExtensions[key];
      if (candidate !== undefined && candidate !== null && !isRecord(candidate)) return null;
    }
    const coupon = rawExtensions.coupon;
    if (coupon !== undefined && coupon !== null) {
      if (!isRecord(coupon)
        || (coupon.text !== null && coupon.text !== undefined && typeof coupon.text !== "string")
        || (coupon.amount !== null && coupon.amount !== undefined && typeof coupon.amount !== "number")
        || (coupon.percent !== null && coupon.percent !== undefined && typeof coupon.percent !== "number")
        || (coupon.currency !== null && coupon.currency !== undefined && typeof coupon.currency !== "string")) return null;
    }
    const distribution = rawExtensions.ratingDistribution;
    if (distribution !== undefined && distribution !== null) {
      if (!isRecord(distribution)
        || Object.values(distribution).some((item) => typeof item !== "number" || !Number.isFinite(item))) return null;
    }
    const boughtPastMonth = rawExtensions.boughtPastMonth;
    if (boughtPastMonth !== undefined && boughtPastMonth !== null
      && !((typeof boughtPastMonth === "number" && Number.isSafeInteger(boughtPastMonth) && boughtPastMonth >= 0)
        || isBoughtPastMonthEstimate(boughtPastMonth))) return null;
    if (rawExtensions.amazonDetail !== undefined && !parseAmazonDetailCaptureEvidence(rawExtensions.amazonDetail)) return null;
    for (const key of ["estimatedFbaFee"] as const) {
      const fee = rawExtensions[key];
      if (fee !== undefined && fee !== null) {
        if (!isRecord(fee)
          || typeof fee.amount !== "number"
          || !Number.isFinite(fee.amount)
          || typeof fee.currency !== "string") return null;
      }
    }
    for (const key of ["buyboxSeller", "fulfillmentType", "dateFirstAvailable"] as const) {
      const text = rawExtensions[key];
      if (text !== undefined && text !== null && typeof text !== "string") return null;
    }
    for (const key of ["estimatedGrossMargin", "listingQualityScore"] as const) {
      const number = rawExtensions[key];
      if (number !== undefined && number !== null
        && (typeof number !== "number" || !Number.isFinite(number))) return null;
    }
    if (rawExtensions.fieldMetadata !== undefined) {
      if (!isRecord(rawExtensions.fieldMetadata)) return null;
      for (const metadata of Object.values(rawExtensions.fieldMetadata)) {
        if (!isRecord(metadata)
          || !METRIC_NATURES.includes(metadata.metricNature as MetricNature)
          || !FIELD_VALUE_ORIGINS.includes(metadata.valueOrigin as FieldValueOrigin)
          || typeof metadata.confidence !== "number"
          || !Number.isFinite(metadata.confidence)
          || metadata.confidence < 0
          || metadata.confidence > 1
          || typeof metadata.sourceRef !== "string") return null;
      }
    }
    if (rawExtensions.sellerSpriteRaw !== undefined) {
      const raw = rawExtensions.sellerSpriteRaw;
      if (!isRecord(raw)
        || raw.schemaVersion !== "sellersprite-xlsx-raw.v1"
        || raw.sourceType !== "sellersprite_xlsx"
        || (raw.sourceFileSha256 !== null
          && (typeof raw.sourceFileSha256 !== "string"
            || !/^[a-f0-9]{64}$/u.test(raw.sourceFileSha256)))
        || !Array.isArray(raw.rows)) return null;
      for (const row of raw.rows) {
        if (!isRecord(row)
          || !Number.isSafeInteger(row.rowNumber)
          || (row.rowNumber as number) < 1
          || !isRecord(row.columns)
          || !isRecord(row.extraRaw)
          || !isRecord(row.extraRawMetricNature)) return null;
        for (const columns of [row.columns, row.extraRaw]) {
          if (Object.values(columns).some((item) => item !== null && typeof item !== "string")) return null;
        }
        if (Object.values(row.extraRawMetricNature).some((item) => (
          !METRIC_NATURES.includes(item as MetricNature)
        ))) return null;
      }
    }
    extensions = rawExtensions as CapturePackageExtensions;
  }

  return {
    ...value,
    fields: resolvedFields,
    ...(extensions ? { extensions } : {}),
    fieldStates: resolvedFieldStates as CaptureFieldStates,
  } as unknown as CapturePackage;
}

export function capturePackageContractError(code: string): SourceLayerError {
  return createSourceLayerError("CONTRACT_INVALID", {
    detail: { contractCode: code },
  });
}
