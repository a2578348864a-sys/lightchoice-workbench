/**
 * Product Source Layer V1.2 — Evidence 生命周期（Phase 2 / 六、版本与生命周期）
 *
 * 两部分职责：
 * 1. Evidence Version：同一商品多次采集必须递增版本，禁止覆盖历史；
 * 2. Evidence Expiration：不同字段不同有效期，过期标记 EXPIRED 并重新采集。
 *
 * 纯函数：无 IO / 无随机。时间必须由调用方注入（now），便于测试与回放。
 */

export const SOURCE_LAYER_SCHEMA_VERSION = "source-capture-package.v1" as const;

/** 采集包字段全集（与 Capture Package 的 fields 键一一对应）。 */
export const CAPTURE_FIELD_KEYS = [
  "asin",
  "title",
  "brand",
  "images",
  "price",
  "rating",
  "reviewCount",
  "bsr",
  "subCategoryBsr",
  "estimatedMonthlySales",
  "estimatedMonthlyRevenueUsd",
  "keywords",
] as const;

export type CaptureFieldKey = (typeof CAPTURE_FIELD_KEYS)[number];

/**
 * 字段有效期策略（毫秒）。
 * 依据「字段变质速度」而非统一 TTL：价格/排名变化最快，图片最稳定。
 * 策略可被调用方按需覆盖，但默认值必须显式写在代码里而不是散落各处。
 */
export const FIELD_TTL_MS: Readonly<Record<CaptureFieldKey, number>> = Object.freeze({
  /** 价格：短周期（48 小时） */
  price: 48 * 60 * 60 * 1000,
  /** BSR 排名：约 3 天 */
  bsr: 3 * 24 * 60 * 60 * 1000,
  subCategoryBsr: 3 * 24 * 60 * 60 * 1000,
  /** 评分与评论数：7 天 */
  rating: 7 * 24 * 60 * 60 * 1000,
  reviewCount: 7 * 24 * 60 * 60 * 1000,
  /** 预估月销量与销售额：30 天 */
  estimatedMonthlySales: 30 * 24 * 60 * 60 * 1000,
  estimatedMonthlyRevenueUsd: 30 * 24 * 60 * 60 * 1000,
  /** 关键词集合：14 天 */
  keywords: 14 * 24 * 60 * 60 * 1000,
  /** 标题与品牌：长周期 */
  title: 30 * 24 * 60 * 60 * 1000,
  brand: Number.MAX_SAFE_INTEGER,
  /** 图片：长周期（90 天） */
  images: 90 * 24 * 60 * 60 * 1000,
  /** ASIN 身份：不随采集时间变质（视为长期有效） */
  asin: Number.MAX_SAFE_INTEGER,
});

export type FieldExpirationPolicy = Readonly<Partial<Record<CaptureFieldKey, number>>>;

export type FieldExpirationState = "valid" | "expired" | "not_applicable";

export type FieldExpiration = {
  field: CaptureFieldKey;
  state: FieldExpirationState;
  ttlMs: number;
  ageMs: number | null;
  expiresAt: string | null;
};

export function resolveFieldTtlMs(
  field: CaptureFieldKey,
  policy?: FieldExpirationPolicy | null,
): number {
  const override = policy?.[field];
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return FIELD_TTL_MS[field];
}

/**
 * 计算单个字段的有效期状态。
 * capturedAt 不合法 → ageMs = null（由 Validator 以 INVALID_FORMAT 阻断，
 * 此处不猜测、不默认通过）。
 */
export function evaluateFieldExpiration(input: {
  field: CaptureFieldKey;
  capturedAt: string;
  /** 该字段是否在本次采集包中有值；无值字段不参与过期判定。 */
  present: boolean;
  now: Date | number | string;
  policy?: FieldExpirationPolicy | null;
}): FieldExpiration {
  const ttlMs = resolveFieldTtlMs(input.field, input.policy);
  if (!input.present) {
    return { field: input.field, state: "not_applicable", ttlMs, ageMs: null, expiresAt: null };
  }
  const capturedMs = Date.parse(input.capturedAt);
  const nowMs = input.now instanceof Date
    ? input.now.getTime()
    : typeof input.now === "number"
      ? input.now
      : Date.parse(input.now);
  if (!Number.isFinite(capturedMs) || !Number.isFinite(nowMs)) {
    return { field: input.field, state: "not_applicable", ttlMs, ageMs: null, expiresAt: null };
  }
  const ageMs = Math.max(0, nowMs - capturedMs);
  const expiresAtMs = capturedMs + ttlMs;
  return {
    field: input.field,
    state: ttlMs === Number.MAX_SAFE_INTEGER || ageMs <= ttlMs ? "valid" : "expired",
    ttlMs,
    ageMs,
    expiresAt: ttlMs === Number.MAX_SAFE_INTEGER
      ? null
      : new Date(Math.min(expiresAtMs, 8_640_000_000_000_000)).toISOString(),
  };
}

/** 版本分配：同一商品（subjectKey）多次采集必须严格递增，历史版本永不覆盖。 */
export const MAX_EVIDENCE_VERSIONS_PER_SUBJECT = 20;

export type EvidenceVersionAssignment = {
  /** 新采集包的版本号（从 1 开始） */
  version: number;
  /** 被保留在历史中的旧版本号 */
  retainedVersions: number[];
  /** 因超过保留上限而被淘汰的版本号（只淘汰最旧的，且必须显式返回便于审计） */
  prunedVersions: number[];
};

export function assignEvidenceVersion(existingVersions: readonly number[]): EvidenceVersionAssignment {
  const unique = [...new Set(existingVersions.filter((value) => Number.isSafeInteger(value) && value > 0))]
    .sort((left, right) => left - right);
  const version = unique.length === 0 ? 1 : unique[unique.length - 1] + 1;
  // 新版本占用 1 个槽位，历史保留 MAX-1 个。
  const keepHistory = MAX_EVIDENCE_VERSIONS_PER_SUBJECT - 1;
  const retainedVersions = unique.slice(Math.max(0, unique.length - keepHistory));
  const retainedSet = new Set(retainedVersions);
  const prunedVersions = unique.filter((value) => !retainedSet.has(value));
  return { version, retainedVersions, prunedVersions };
}
