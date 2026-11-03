/**
 * Product Development V1 — Phase 1：MarketScan 正式契约的运行时校验。
 *
 * 只做「结构 + 版本 + 边界」校验，不做业务判断、不推断缺失值。
 * 反序列化边界（数据库 / API）必须经过本模块，绝不直接信任 JSON。
 */

import {
  MARKET_METRICS_SCHEMA,
  MARKET_METRICS_VERSION,
  MARKET_SCAN_SAMPLE_SCHEMA,
  MARKET_SCAN_SCHEMA,
  MARKET_SCAN_IMAGE_REF_SCHEMA,
  MARKET_SCAN_SOURCE_TYPES,
  MARKET_METRIC_STATUSES,
  NICHE_DEFINITION_KINDS,
  type MarketFactFieldV1,
  type MarketFactValueV1,
  type MarketFactValuesV1,
  type MarketScanImageRefV1,
  type MarketMetricsV1,
  type MarketScanSampleSnapshotV1,
  type MarketScanSourceType,
  type NicheDefinitionKind,
  type NicheDefinitionV1,
  type SampleDefinitionV1,
} from "@/lib/marketScan/types";
import { factValuesFingerprintOf } from "@/lib/marketScan/metrics";

/** MarketScan 是 Owner 正式业务对象；固定服务器归属，不引入新的 RBAC。 */
export const MARKET_SCAN_OWNER_SCOPE = "owner:v1" as const;

export const MARKET_SCAN_MAX_SAMPLE_ITEMS = 500;
export const MARKET_SCAN_MAX_SCAN_NAME_LENGTH = 200;
export const MARKET_SCAN_MAX_MARKETPLACE_LENGTH = 16;
export const MARKET_SCAN_MAX_NOTES_LENGTH = 2000;

export const MARKET_SCAN_JSON_LIMITS = {
  nicheDefinitionJson: 64 * 1024,
  sampleDefinitionJson: 64 * 1024,
  sampleSnapshotJson: 4 * 1024 * 1024,
  metricsJson: 4 * 1024 * 1024,
} as const;

export type MarketScanJsonField = keyof typeof MARKET_SCAN_JSON_LIMITS;

export type MarketScanContractErrorCode =
  | "market_scan_invalid"
  | "market_scan_json_invalid"
  | "market_scan_json_too_large"
  | "market_scan_sample_hash_mismatch"
  | "market_scan_metrics_version_mismatch";

export class MarketScanContractError extends Error {
  constructor(
    public readonly code: MarketScanContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MarketScanContractError";
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const METRICS_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SOURCE_TYPES = new Set<string>(MARKET_SCAN_SOURCE_TYPES);
const NICHE_KINDS = new Set<string>(NICHE_DEFINITION_KINDS);
const METRIC_STATUSES = new Set<string>(MARKET_METRIC_STATUSES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: MarketScanContractErrorCode, message: string): never {
  throw new MarketScanContractError(code, message);
}

function boundedText(
  value: unknown,
  maxLength: number,
  code: MarketScanContractErrorCode = "market_scan_invalid",
  label = "文本",
): string {
  if (typeof value !== "string") fail(code, `${label}必须是字符串。`);
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > maxLength) fail(code, `${label}长度不合法。`);
  return normalized;
}

function nullableBoundedText(value: unknown, maxLength: number, label: string): string | null {
  if (value === null || value === undefined) return null;
  return boundedText(value, maxLength, "market_scan_invalid", label);
}

export function assertMarketScanHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("market_scan_invalid", `${label}必须是 64 位小写十六进制 SHA-256。`);
  }
  return value;
}

export function assertMetricsVersion(value: unknown): string {
  if (typeof value !== "string" || !METRICS_VERSION_PATTERN.test(value)) {
    fail("market_scan_invalid", "metricsVersion 不合法。");
  }
  return value;
}

export function assertScanName(value: unknown): string {
  return boundedText(value, MARKET_SCAN_MAX_SCAN_NAME_LENGTH, "market_scan_invalid", "扫描名称");
}

export function assertMarketplace(value: unknown): string {
  const text = boundedText(
    value,
    MARKET_SCAN_MAX_MARKETPLACE_LENGTH,
    "market_scan_invalid",
    "市场站点",
  );
  return text.toUpperCase();
}

export function assertSampleCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1
    || (value as number) > MARKET_SCAN_MAX_SAMPLE_ITEMS) {
    fail("market_scan_invalid", "样本数超出允许范围。");
  }
  return value as number;
}

export function assertJsonFieldWithinLimit(field: MarketScanJsonField, json: string): string {
  const limit = MARKET_SCAN_JSON_LIMITS[field];
  if (Buffer.byteLength(json, "utf8") > limit) {
    fail("market_scan_json_too_large", `${field} 超出大小上限。`);
  }
  return json;
}

/* ── Niche Definition ────────────────────────────────────────────── */

export function parseNicheDefinitionV1(value: unknown): NicheDefinitionV1 {
  if (!isRecord(value)) fail("market_scan_json_invalid", "nicheDefinition 必须是对象。");
  if (value.schemaVersion !== MARKET_SCAN_SAMPLE_SCHEMA) {
    fail("market_scan_json_invalid", "nicheDefinition.schemaVersion 不受支持。");
  }
  if (typeof value.kind !== "string" || !NICHE_KINDS.has(value.kind)) {
    fail("market_scan_json_invalid", "nicheDefinition.kind 不受支持。");
  }
  const parameters: Record<string, string | number | boolean | null> = {};
  if (value.parameters !== undefined && value.parameters !== null) {
    if (!isRecord(value.parameters)) {
      fail("market_scan_json_invalid", "nicheDefinition.parameters 必须是对象。");
    }
    for (const [key, raw] of Object.entries(value.parameters)) {
      if (raw === null || typeof raw === "string" || typeof raw === "boolean") {
        parameters[key] = raw;
      } else if (typeof raw === "number" && Number.isFinite(raw)) {
        parameters[key] = raw;
      } else {
        fail("market_scan_json_invalid", "nicheDefinition.parameters 只允许标量。");
      }
    }
  }
  return {
    schemaVersion: MARKET_SCAN_SAMPLE_SCHEMA,
    kind: value.kind as NicheDefinitionKind,
    label: boundedText(value.label, 200, "market_scan_json_invalid", "nicheDefinition.label"),
    notes: nullableBoundedText(value.notes, MARKET_SCAN_MAX_NOTES_LENGTH, "nicheDefinition.notes"),
    parameters,
  };
}

export function buildNicheDefinitionV1(input: {
  kind: NicheDefinitionKind;
  label: string;
  notes?: string | null;
  parameters?: Readonly<Record<string, string | number | boolean | null>> | null;
}): NicheDefinitionV1 {
  return parseNicheDefinitionV1({
    schemaVersion: MARKET_SCAN_SAMPLE_SCHEMA,
    kind: input.kind,
    label: input.label,
    notes: input.notes ?? null,
    parameters: input.parameters ?? {},
  });
}

/* ── Sample Definition ───────────────────────────────────────────── */

export function parseSampleDefinitionV1(value: unknown): SampleDefinitionV1 {
  if (!isRecord(value)) fail("market_scan_json_invalid", "sampleDefinition 必须是对象。");
  if (value.schemaVersion !== MARKET_SCAN_SAMPLE_SCHEMA) {
    fail("market_scan_json_invalid", "sampleDefinition.schemaVersion 不受支持。");
  }
  const origin = value.origin;
  if (origin !== "existing_product_batch_evidence" && origin !== "existing_evidence") {
    fail("market_scan_json_invalid", "sampleDefinition.origin 不受支持。");
  }
  const sourceTypes: MarketScanSourceType[] = [];
  if (value.sourceTypes !== undefined && value.sourceTypes !== null) {
    if (!Array.isArray(value.sourceTypes)) {
      fail("market_scan_json_invalid", "sampleDefinition.sourceTypes 必须是数组。");
    }
    for (const item of value.sourceTypes) {
      if (typeof item !== "string" || !SOURCE_TYPES.has(item)) {
        fail("market_scan_json_invalid", "sampleDefinition.sourceTypes 含不支持的来源。");
      }
      if (!sourceTypes.includes(item as MarketScanSourceType)) {
        sourceTypes.push(item as MarketScanSourceType);
      }
    }
  }
  const requestedLimit = value.requestedLimit;
  if (requestedLimit !== null && requestedLimit !== undefined) {
    if (!Number.isSafeInteger(requestedLimit) || (requestedLimit as number) < 1
      || (requestedLimit as number) > MARKET_SCAN_MAX_SAMPLE_ITEMS) {
      fail("market_scan_json_invalid", "sampleDefinition.requestedLimit 不合法。");
    }
  }
  return {
    schemaVersion: MARKET_SCAN_SAMPLE_SCHEMA,
    origin,
    marketplace: boundedText(
      value.marketplace,
      MARKET_SCAN_MAX_MARKETPLACE_LENGTH,
      "market_scan_json_invalid",
      "sampleDefinition.marketplace",
    ).toUpperCase(),
    sourceTypes,
    productBatchId: nullableBoundedText(value.productBatchId, 128, "sampleDefinition.productBatchId"),
    requestedLimit: typeof requestedLimit === "number" ? requestedLimit : null,
    ...(typeof value.marketSamplePolicyVersion === "string" ? { marketSamplePolicyVersion: boundedText(value.marketSamplePolicyVersion, 100, "market_scan_json_invalid", "marketSamplePolicyVersion") } : {}),
    ...(value.insufficientSampleBypass === undefined ? {} : { insufficientSampleBypass: parseInsufficientSampleBypass(value.insufficientSampleBypass) }),
  };
}

function parseInsufficientSampleBypass(value: unknown): NonNullable<SampleDefinitionV1["insufficientSampleBypass"]> {
  if (!isRecord(value) || value.enabledByEnvironment !== true || typeof value.recordedAt !== "string" || !Number.isFinite(Date.parse(value.recordedAt)) || !Number.isSafeInteger(value.validSampleCount) || Number(value.validSampleCount) < 0) fail("market_scan_json_invalid", "insufficientSampleBypass 不合法。");
  return { enabledByEnvironment: true, reason: boundedText(value.reason, 1000, "market_scan_json_invalid", "insufficientSampleBypass.reason"), recordedAt: value.recordedAt as string, validSampleCount: value.validSampleCount as number };
}

export function buildSampleDefinitionV1(input: {
  origin: SampleDefinitionV1["origin"];
  marketplace: string;
  sourceTypes?: readonly MarketScanSourceType[] | null;
  productBatchId?: string | null;
  requestedLimit?: number | null;
}): SampleDefinitionV1 {
  return parseSampleDefinitionV1({
    schemaVersion: MARKET_SCAN_SAMPLE_SCHEMA,
    origin: input.origin,
    marketplace: input.marketplace,
    sourceTypes: input.sourceTypes ?? [],
    productBatchId: input.productBatchId ?? null,
    requestedLimit: input.requestedLimit ?? null,
  });
}

/* ── Sample Snapshot ─────────────────────────────────────────────── */

/**
 * 解析并校验事实值快照。
 *
 * 为什么必须严格校验：快照是扫描结果的**事实自证**载体。允许把它读成任意形状，
 * 就等于允许历史扫描的事实被悄悄改写。这里 fail-closed，不做任何宽容兼容。
 */
export function parseMarketFactValuesV1(value: unknown, label: string): MarketFactValuesV1 {
  if (!isRecord(value)) fail("market_scan_json_invalid", `${label} 必须是对象。`);
  if (typeof value.asin !== "string" || !/^[A-Z0-9]{10}$/u.test(value.asin)) {
    fail("market_scan_json_invalid", `${label}.asin 不合法。`);
  }

  const plain = (raw: unknown, fieldLabel: string): MarketFactValueV1<unknown> => {
    if (!isRecord(raw)) fail("market_scan_json_invalid", `${fieldLabel} 必须是对象。`);
    if (raw.presence === "missing") {
      if ("value" in raw && raw.value !== undefined) {
        fail("market_scan_json_invalid", `${fieldLabel} 标记 missing 却带 value。`);
      }
      return { presence: "missing" };
    }
    if (raw.presence !== "present") {
      fail("market_scan_json_invalid", `${fieldLabel}.presence 不合法。`);
    }
    if (!("value" in raw) || raw.value === null || raw.value === undefined) {
      fail("market_scan_json_invalid", `${fieldLabel} 标记 present 却缺少 value。`);
    }
    return { presence: "present", value: raw.value };
  };

  const sourced = (raw: unknown, fieldLabel: string): MarketFactFieldV1<unknown> => {
    if (!isRecord(raw)) fail("market_scan_json_invalid", `${fieldLabel} 必须是对象。`);
    const source = raw.valueSource;
    if (source !== "FACT" && source !== "PROVIDER_ESTIMATE" && source !== "DERIVED") {
      fail("market_scan_json_invalid", `${fieldLabel}.valueSource 不合法。`);
    }
    return { ...plain(raw, fieldLabel), valueSource: source };
  };

  const text = (raw: unknown, fieldLabel: string) => {
    const parsed = plain(raw, fieldLabel);
    if (parsed.presence === "present") {
      if (typeof parsed.value !== "string" || !parsed.value.trim()) {
        fail("market_scan_json_invalid", `${fieldLabel} 的文本值不合法。`);
      }
      return { presence: "present" as const, value: parsed.value as string };
    }
    return { presence: "missing" as const };
  };

  const number = (raw: unknown, fieldLabel: string) => {
    const parsed = plain(raw, fieldLabel);
    if (parsed.presence === "present") {
      if (typeof parsed.value !== "number" || !Number.isFinite(parsed.value)) {
        fail("market_scan_json_invalid", `${fieldLabel} 的数值不合法。`);
      }
      return { presence: "present" as const, value: parsed.value as number };
    }
    return { presence: "missing" as const };
  };

  const money = (raw: unknown, fieldLabel: string) => {
    const parsed = sourced(raw, fieldLabel);
    if (parsed.presence === "present") {
      const amount = (parsed.value as { amount?: unknown }).amount;
      const currency = (parsed.value as { currency?: unknown }).currency;
      if (typeof amount !== "number" || !Number.isFinite(amount)
        || typeof currency !== "string" || !/^[A-Z]{3}$/u.test(currency)) {
        fail("market_scan_json_invalid", `${fieldLabel} 的金额值不合法。`);
      }
      return {
        presence: "present" as const,
        value: { amount, currency },
        valueSource: parsed.valueSource,
      };
    }
    return { presence: "missing" as const, valueSource: parsed.valueSource };
  };

  // 第三方估算是来源语义的一部分：不许在快照里被改写成 FACT。
  const sales = sourced(value.monthlySalesEstimate, `${label}.monthlySalesEstimate`);
  if (sales.valueSource !== "PROVIDER_ESTIMATE") {
    fail("market_scan_json_invalid", `${label}.monthlySalesEstimate 必须标注为第三方估算。`);
  }
  const revenue = money(value.monthlyRevenueEstimate, `${label}.monthlyRevenueEstimate`);
  if (revenue.valueSource !== "PROVIDER_ESTIMATE") {
    fail("market_scan_json_invalid", `${label}.monthlyRevenueEstimate 必须标注为第三方估算。`);
  }
  const salesNumber = number(value.monthlySalesEstimate, `${label}.monthlySalesEstimate`);

  return {
    asin: value.asin,
    title: text(value.title, `${label}.title`),
    brand: text(value.brand, `${label}.brand`),
    category: text(value.category, `${label}.category`),
    price: money(value.price, `${label}.price`),
    rating: number(value.rating, `${label}.rating`),
    reviewCount: number(value.reviewCount, `${label}.reviewCount`),
    bsr: number(value.bsr, `${label}.bsr`),
    monthlySalesEstimate: {
      ...salesNumber,
      valueSource: sales.valueSource,
    },
    monthlyRevenueEstimate: revenue,
    launchedDate: text(value.launchedDate, `${label}.launchedDate`),
  };
}

const SUBJECT_KEY_PATTERN = /^[A-Za-z0-9:._|@%-]+$/u;
const EVIDENCE_ID_PATTERN = /^ev-[A-Za-z0-9_-]{1,156}$/u;
const EXTERNAL_IMAGE_URL_PATTERN = /^https:\/\/\S+$/iu;

/** 图片展示引用是可选字段；缺失代表该历史样本没有可解析的图片。 */
export function parseMarketScanImageRefV1(
  value: unknown,
  label = "imageRef",
): MarketScanImageRefV1 {
  if (!isRecord(value)) fail("market_scan_json_invalid", `${label} 必须是对象。`);
  if (value.schemaVersion !== MARKET_SCAN_IMAGE_REF_SCHEMA) {
    fail("market_scan_json_invalid", `${label}.schemaVersion 不受支持。`);
  }
  if (value.kind === "external_url") {
    if (typeof value.url !== "string"
      || value.url.length > 2048
      || !EXTERNAL_IMAGE_URL_PATTERN.test(value.url)) {
      fail("market_scan_json_invalid", `${label}.url 必须是短 HTTPS 图片 URL。`);
    }
    return {
      schemaVersion: MARKET_SCAN_IMAGE_REF_SCHEMA,
      kind: "external_url",
      url: value.url,
    };
  }
  if (value.kind === "source_evidence") {
    if (typeof value.subjectKey !== "string"
      || value.subjectKey.length > 160
      || !SUBJECT_KEY_PATTERN.test(value.subjectKey)) {
      fail("market_scan_json_invalid", `${label}.subjectKey 不合法。`);
    }
    if (typeof value.evidenceId !== "string" || !EVIDENCE_ID_PATTERN.test(value.evidenceId)) {
      fail("market_scan_json_invalid", `${label}.evidenceId 不合法。`);
    }
    if (!Number.isSafeInteger(value.evidenceVersion) || (value.evidenceVersion as number) < 1) {
      fail("market_scan_json_invalid", `${label}.evidenceVersion 不合法。`);
    }
    return {
      schemaVersion: MARKET_SCAN_IMAGE_REF_SCHEMA,
      kind: "source_evidence",
      subjectKey: value.subjectKey,
      evidenceId: value.evidenceId,
      evidenceVersion: value.evidenceVersion as number,
    };
  }
  fail("market_scan_json_invalid", `${label}.kind 不受支持。`);
}

export function parseMarketScanSampleSnapshotV1(value: unknown): MarketScanSampleSnapshotV1 {
  if (!isRecord(value)) fail("market_scan_json_invalid", "sampleSnapshot 必须是对象。");
  if (value.schemaVersion !== MARKET_SCAN_SAMPLE_SCHEMA) {
    fail("market_scan_json_invalid", "sampleSnapshot.schemaVersion 不受支持。");
  }
  assertMetricsVersion(value.metricsVersion);
  if (!Array.isArray(value.items)) {
    fail("market_scan_json_invalid", "sampleSnapshot.items 必须是数组。");
  }
  if (!Number.isSafeInteger(value.itemCount) || (value.itemCount as number) < 1) {
    fail("market_scan_json_invalid", "sampleSnapshot.itemCount 不合法。");
  }
  if (value.items.length !== value.itemCount) {
    fail("market_scan_json_invalid", "sampleSnapshot.itemCount 与 items 长度不一致。");
  }
  const rawItems = value.items;
  const items = rawItems.map((raw, index) => {
    if (!isRecord(raw)) fail("market_scan_json_invalid", "sampleSnapshot.items[] 必须是对象。");
    if (typeof raw.asin !== "string" || !/^[A-Z0-9]{10}$/u.test(raw.asin)) {
      fail("market_scan_json_invalid", "sampleSnapshot.items[].asin 不合法。");
    }
    if (typeof raw.subjectKey !== "string" || !raw.subjectKey.trim()) {
      fail("market_scan_json_invalid", "sampleSnapshot.items[].subjectKey 不合法。");
    }
    if (raw.candidateId !== null && typeof raw.candidateId !== "string") {
      fail("market_scan_json_invalid", "sampleSnapshot.items[].candidateId 不合法。");
    }
    if (typeof raw.sourceType !== "string" || !SOURCE_TYPES.has(raw.sourceType)) {
      fail("market_scan_json_invalid", "sampleSnapshot.items[].sourceType 不受支持。");
    }
    if (typeof raw.capturedAt !== "string" || Number.isNaN(Date.parse(raw.capturedAt))) {
      fail("market_scan_json_invalid", "sampleSnapshot.items[].capturedAt 不合法。");
    }
    if (!Number.isSafeInteger(raw.evidenceVersion) || (raw.evidenceVersion as number) < 1) {
      fail("market_scan_json_invalid", "sampleSnapshot.items[].evidenceVersion 不合法。");
    }
    if (raw.dedupeOf !== null && typeof raw.dedupeOf !== "string") {
      fail("market_scan_json_invalid", "sampleSnapshot.items[].dedupeOf 不合法。");
    }
    const factValues = parseMarketFactValuesV1(
      raw.factValues,
      `sampleSnapshot.items[${index}].factValues`,
    );
    if (factValues.asin !== raw.asin) {
      fail("market_scan_json_invalid", "sampleSnapshot.items[].factValues.asin 与条目不一致。");
    }
    const factValuesFingerprint = assertMarketScanHash(
      raw.factValuesFingerprint,
      "sampleSnapshot.items[].factValuesFingerprint",
    );
    // 自证：只凭已落库的快照即可重算并校验冻结的事实值未被篡改。
    if (factValuesFingerprint !== factValuesFingerprintOf({
      subjectKey: raw.subjectKey,
      factValues,
    })) {
      fail(
        "market_scan_json_invalid",
        "sampleSnapshot.items[].factValuesFingerprint 与冻结的事实值不一致。",
      );
    }
    const imageRef = raw.imageRef === undefined || raw.imageRef === null
      ? undefined
      : parseMarketScanImageRefV1(raw.imageRef, `sampleSnapshot.items[${index}].imageRef`);
    return {
      asin: raw.asin,
      subjectKey: raw.subjectKey,
      candidateId: (raw.candidateId ?? null) as string | null,
      productFactFingerprint: assertMarketScanHash(
        raw.productFactFingerprint,
        "sampleSnapshot.items[].productFactFingerprint",
      ),
      factValuesFingerprint,
      sourceProofHash: assertMarketScanHash(
        raw.sourceProofHash,
        "sampleSnapshot.items[].sourceProofHash",
      ),
      evidenceId: boundedText(
        raw.evidenceId,
        200,
        "market_scan_json_invalid",
        "sampleSnapshot.items[].evidenceId",
      ),
      evidenceVersion: raw.evidenceVersion as number,
      capturedAt: raw.capturedAt,
      sourceType: raw.sourceType as MarketScanSourceType,
      dedupeOf: (raw.dedupeOf ?? null) as string | null,
      ...(raw.sampleValidityPolicyVersion === undefined ? {} : { sampleValidityPolicyVersion: boundedText(raw.sampleValidityPolicyVersion, 100, "market_scan_json_invalid", "sampleValidityPolicyVersion") }),
      ...(raw.evidenceStatus === undefined ? {} : { evidenceStatus: boundedText(raw.evidenceStatus, 64, "market_scan_json_invalid", "evidenceStatus") }),
      ...(raw.parentAsin === undefined ? {} : { parentAsin: nullableBoundedText(raw.parentAsin, 10, "parentAsin") }),
      factValues,
      ...(imageRef ? { imageRef } : {}),
    };
  });
  return {
    schemaVersion: MARKET_SCAN_SAMPLE_SCHEMA,
    metricsVersion: value.metricsVersion as string,
    itemCount: value.itemCount as number,
    sampleHash: assertMarketScanHash(value.sampleHash, "sampleSnapshot.sampleHash"),
    items,
  };
}

/* ── Metrics ─────────────────────────────────────────────────────── */

function assertMetricsNode(value: unknown, label: string, depth = 0): void {
  if (depth > 8) fail("market_scan_json_invalid", `${label} 嵌套过深。`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertMetricsNode(item, `${label}[${index}]`, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  const metricLike = typeof value.status === "string"
    && METRIC_STATUSES.has(value.status)
    && "value" in value
    && "sampleSize" in value
    && "missingCount" in value
    && "calculationVersion" in value;
  if (metricLike) {
    if (value.status === "PRESENT") {
      if (value.value === null) fail("market_scan_json_invalid", `${label} PRESENT 但 value 为 null。`);
    } else if (value.value !== null) {
      fail("market_scan_json_invalid", `${label} 非 PRESENT 却带 value。`);
    }
    if (!Number.isSafeInteger(value.sampleSize) || (value.sampleSize as number) < 0) {
      fail("market_scan_json_invalid", `${label}.sampleSize 不合法。`);
    }
    if (!Number.isSafeInteger(value.missingCount) || (value.missingCount as number) < 0) {
      fail("market_scan_json_invalid", `${label}.missingCount 不合法。`);
    }
    assertMetricsVersion(value.calculationVersion);
    if (value.value !== null) assertNoNonFiniteNumbers(value.value, label);
  }
  for (const [key, item] of Object.entries(value)) {
    if (metricLike && key === "value") continue;
    assertMetricsNode(item, `${label}.${key}`, depth + 1);
  }
}

/** 指标结果里不允许出现 NaN / Infinity —— 它们会让 JSON 变成 null 或非法值。 */
export function assertNoNonFiniteNumbers(value: unknown, label = "metrics"): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("market_scan_json_invalid", `${label} 含非有限数值。`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoNonFiniteNumbers(item, `${label}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertNoNonFiniteNumbers(item, `${label}.${key}`);
    }
  }
}

export function parseMarketMetricsV1(value: unknown): MarketMetricsV1 {
  if (!isRecord(value)) fail("market_scan_json_invalid", "metrics 必须是对象。");
  if (value.schemaVersion !== MARKET_METRICS_SCHEMA) {
    fail("market_scan_json_invalid", "metrics.schemaVersion 不受支持。");
  }
  assertMetricsVersion(value.metricsVersion);
  assertNoNonFiniteNumbers(value);
  assertMetricsNode(value, "metrics");
  return value as unknown as MarketMetricsV1;
}

/* ── 一致性与持久化守卫 ──────────────────────────────────────────── */

export function assertSnapshotMatchesMetrics(input: {
  snapshot: MarketScanSampleSnapshotV1;
  metrics: MarketMetricsV1;
}): void {
  if (input.snapshot.metricsVersion !== input.metrics.metricsVersion) {
    fail("market_scan_metrics_version_mismatch", "样本快照与指标结果的 metricsVersion 不一致。");
  }
  if (input.snapshot.itemCount !== input.metrics.sampleCount) {
    fail("market_scan_invalid", "样本快照条数与指标 sampleCount 不一致。");
  }
  if (input.snapshot.sampleHash !== input.metrics.sampleHash) {
    fail("market_scan_sample_hash_mismatch", "样本快照 hash 与指标结果不一致。");
  }
}

export { MARKET_SCAN_SCHEMA, MARKET_METRICS_VERSION };
