/**
 * Product Development V1 — Phase 1：MarketScan 纯函数层（无 IO / 无 Prisma / 无网络 / 无 AI）。
 *
 * 本文件由 Agent C 按下方已冻结契约实现。所有导出的行为必须确定性：
 * 相同输入严格得到相同输出，且不依赖系统时间、随机数、环境变量或文件系统。
 *
 * 实现层面的固定选择（均由契约允许，并在测试中锁定）：
 * - 负数值（price / sales / revenue / rating / reviewCount / bsr）在物理上不可能，
 *   一律按 missing 处理并写入 `notes`，绝不参与统计。
 * - `NaN` / `Infinity` 按 missing 处理，结果中不出现任何非有限数。
 * - 数值求和一律先升序排序再累加，保证浮点结果与输入顺序无关。
 * - 无时区偏移的 ISO 日期按 UTC 解释，保证结果与运行环境时区无关。
 * - `dedupeOf` 只记录一个 hash：多条重复同时被丢弃时取被丢弃 hash 的字典序最小者。
 * - 样本条目自带 `factValues`（事实值快照）：调用方提供时原样冻结进快照，
 *   指标计算也优先使用它，缺失时才从 `ProductFact` 现场投影。
 * - `factValuesFingerprint` = hash(subjectKey + factValues)：只凭快照自身即可重算。
 * - 本文件**不 import** `productFactSource`（那条链路会引入 Prisma / evidenceStore），
 *   因此本地实现了等价的 `projectMarketFactValuesV1`，保持纯函数层不依赖 IO。
 */

import { createHash } from "node:crypto";
import { resolveDeterministicMarketSamples } from "@/lib/marketScan/marketSampleValidity";
import { MARKET_SAMPLE_POLICY_VERSION } from "@/lib/marketScan/marketSamplePolicy";

import type { FactField, ProductFact, ProductPrice } from "@/lib/sourceLayer/fact/types";
import { isValidMarketMoneyValue } from "@/lib/marketScan/money";
import {
  MARKET_METRICS_SCHEMA,
  MARKET_METRICS_VERSION,
  MARKET_SCAN_IMAGE_REF_SCHEMA,
  MARKET_SCAN_SAMPLE_SCHEMA,
  type MarketConcentrationV1,
  type MarketFactFieldV1,
  type MarketFactValueSourceV1,
  type MarketFactValueV1,
  type MarketFactValuesV1,
  type MarketFieldCoverage,
  type MarketFieldCoverageV1,
  type MarketMetric,
  type MarketMetricStatus,
  type MarketMetricsV1,
  type MarketScanImageRefV1,
  type MarketNumericDistributionV1,
  type MarketScanMetricsInputV1,
  type MarketScanSampleInputV1,
  type MarketScanSampleItemDraftV1,
  type MarketScanSampleItemV1,
  type MarketScanSampleSnapshotV1,
  type NicheDefinitionV1,
  type SampleDefinitionV1,
} from "@/lib/marketScan/types";

/* 稳定序列化与哈希 ─────────────────────────────────────────────── */

/** 对对象键排序的稳定 JSON 序列化；`undefined` 键被剔除。数组顺序保留语义。 */
export function stableStringify(value: unknown): string {
  return stringifyValue(value, new Set<object>());
}

function stringifyValue(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      // JSON.stringify 语义：NaN / Infinity → "null"
      return JSON.stringify(value) ?? "null";
    case "undefined":
    case "function":
    case "symbol":
      // 对象键已在上面被剔除；只剩数组元素与顶层，按 JSON.stringify 语义退化为 null。
      return "null";
    case "bigint":
      throw new TypeError("stableStringify: BigInt is not supported");
    default:
      break;
  }

  const candidate = value as { toJSON?: unknown };
  if (typeof candidate.toJSON === "function") {
    return stringifyValue((candidate.toJSON as () => unknown).call(value), seen);
  }

  if (seen.has(value as object)) {
    throw new TypeError("stableStringify: circular reference detected");
  }
  seen.add(value as object);

  let serialized: string;
  if (Array.isArray(value)) {
    serialized = `[${value.map((entry) => stringifyValue(entry, seen)).join(",")}]`;
  } else {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareStrings);
    serialized = `{${keys
      .map((key) => `${JSON.stringify(key)}:${stringifyValue(record[key], seen)}`)
      .join(",")}}`;
  }

  seen.delete(value as object);
  return serialized;
}

/** SHA-256 十六进制（64 位小写）。同一 `stableStringify` 输入必须得到同一结果。 */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/* 事实指纹与版本锁定 ───────────────────────────────────────────── */

/** 单条 ProductFact 的内容指纹；只覆盖事实内容，不含 evidenceVersion / candidateId 等编组元数据。 */
export function productFactFingerprintOf(
  input: Pick<MarketScanSampleInputV1, "productFact" | "subjectKey">,
): string {
  // 只包 fact 本体：同一份事实无论挂在哪次编组（subjectKey / evidenceVersion / candidateId）
  // 下，fingerprint 必须相同。
  return sha256Hex(stableStringify({ productFact: input.productFact }));
}

/** 单条样本条目的内容指纹；覆盖版本锁定字段。 */
export function sampleItemHashOf(item: MarketScanSampleItemDraftV1): string {
  return sha256Hex(stableStringify(item));
}

/**
 * 快照事实值自证指纹；输入为 subjectKey + 已冻结事实值。
 *
 * 与 `productFactFingerprintOf` 不同：它只依赖快照自身携带的内容
 * （`subjectKey` + `factValues`），因此可以在任何时候只凭已落库的快照重算，
 * 用来证明快照事实没有被篡改或截断。
 */
export function factValuesFingerprintOf(input: {
  readonly subjectKey: string;
  readonly factValues: MarketFactValuesV1;
}): string {
  return sha256Hex(
    stableStringify({ subjectKey: input.subjectKey, factValues: input.factValues }),
  );
}

/**
 * 样本快照 hash，必须可重算。输入为 canonical nicheDefinition + canonical
 * sampleDefinition + 排序后的样本条目 + metricsVersion，缺一不可。
 * MarketScan ID 可以不同，但相同输入的 sampleHash 必须相同。
 */
export function computeSampleHash(input: {
  nicheDefinition: NicheDefinitionV1;
  sampleDefinition: SampleDefinitionV1;
  items: readonly MarketScanSampleItemV1[];
  metricsVersion: string;
}): string {
  const items = [...input.items].sort(compareSampleItems);
  return sha256Hex(
    stableStringify({
      nicheDefinition: input.nicheDefinition,
      sampleDefinition: input.sampleDefinition,
      items,
      metricsVersion: input.metricsVersion,
    }),
  );
}

/* 样本编组 ─────────────────────────────────────────────────────── */

export class MarketScanSampleError extends Error {
  constructor(
    public readonly code:
      | "sample_empty"
      | "sample_invalid"
      | "sample_asin_conflict"
      | "sample_subject_conflict",
    message: string,
  ) {
    super(message);
    this.name = "MarketScanSampleError";
  }
}

type SampleDraftEntry = {
  readonly draft: MarketScanSampleItemDraftV1;
  readonly itemHash: string;
};

/**
 * 由已标准化的 `ProductFact` 编组出样本快照。规则：
 *
 * 1. 输入为空 → `sample_empty`（不允许创建空样本 MarketScan）。
 * 2. 缺少 ASIN / subjectKey / sourceProof.contentHash 的条目 → `sample_invalid`。
 * 3. 同一 subjectKey 但 ASIN 不同 → `sample_subject_conflict`。
 * 4. 同一 ASIN、同一 `productFactFingerprint` → 允许 deterministic dedupe：
 *    保留 evidenceVersion 更小者；相同则保留 `sourceProofHash` 字典序更小者；
 *    再相同则保留 `evidenceId` 字典序更小者。被丢弃条目的 key 写入保留条目的 `dedupeOf`。
 * 5. 同一 ASIN、**不同** `productFactFingerprint` → 必须 FAIL CLOSED：抛 `sample_asin_conflict`，
 *    绝不静默选一个版本。调用方必须显式选择版本。
 * 6. 输出条目按 `asin` 升序、再按 `productFactFingerprint` 升序稳定排序。
 * 7. `itemCount` 为去重后的条目数；`metricsVersion` 与 `sampleHash` 一并写入快照。
 */
export function buildSampleSnapshot(input: {
  nicheDefinition: NicheDefinitionV1;
  sampleDefinition: SampleDefinitionV1;
  sample: readonly MarketScanSampleInputV1[];
  metricsVersion: string;
}): MarketScanSampleSnapshotV1 {
  if (input.sample.length === 0) {
    throw new MarketScanSampleError(
      "sample_empty",
      "market scan sample is empty: at least one ProductFact is required",
    );
  }

  const entries = input.sample.map((sampleInput, index) => buildSampleDraftEntry(sampleInput, index));

  // 规则 3：同一 subjectKey 必须始终指向同一个 ASIN。
  const asinBySubject = new Map<string, string>();
  for (const entry of entries) {
    const { subjectKey, asin } = entry.draft;
    const known = asinBySubject.get(subjectKey);
    if (known === undefined) {
      asinBySubject.set(subjectKey, asin);
    } else if (known !== asin) {
      throw new MarketScanSampleError(
        "sample_subject_conflict",
        `subjectKey "${subjectKey}" maps to multiple ASINs ("${known}" vs "${asin}"); the sample cannot be built deterministically`,
      );
    }
  }

  // 规则 5：同一 ASIN 出现多份不同事实 → FAIL CLOSED，绝不静默选一版。
  const fingerprintsByAsin = new Map<string, Set<string>>();
  for (const entry of entries) {
    const { asin, productFactFingerprint } = entry.draft;
    const known = fingerprintsByAsin.get(asin);
    if (known === undefined) {
      fingerprintsByAsin.set(asin, new Set([productFactFingerprint]));
    } else {
      known.add(productFactFingerprint);
    }
  }
  for (const [asin, fingerprints] of fingerprintsByAsin) {
    if (fingerprints.size > 1) {
      const sorted = [...fingerprints].sort(compareStrings);
      throw new MarketScanSampleError(
        "sample_asin_conflict",
        `ASIN "${asin}" has ${sorted.length} different product fact fingerprints (${sorted.join(", ")}); the caller must pick one fact version explicitly`,
      );
    }
  }

  // 规则 4：同 ASIN + 同 fingerprint → deterministic dedupe。
  const groupsByAsin = new Map<string, Map<string, SampleDraftEntry[]>>();
  for (const entry of entries) {
    const { asin, productFactFingerprint } = entry.draft;
    let groups = groupsByAsin.get(asin);
    if (groups === undefined) {
      groups = new Map<string, SampleDraftEntry[]>();
      groupsByAsin.set(asin, groups);
    }
    const bucket = groups.get(productFactFingerprint);
    if (bucket === undefined) {
      groups.set(productFactFingerprint, [entry]);
    } else {
      bucket.push(entry);
    }
  }

  const items: MarketScanSampleItemV1[] = [];
  for (const groups of groupsByAsin.values()) {
    for (const bucket of groups.values()) {
      const ordered = [...bucket].sort(compareDraftEntries);
      const winner = ordered[0];
      const discardedHashes = ordered
        .slice(1)
        .map((entry) => entry.itemHash)
        .sort(compareStrings);
      items.push({
        ...winner.draft,
        // 契约只留一个 hash 位：多条重复同时被丢弃时取字典序最小者，保证确定性。
        dedupeOf: discardedHashes.length === 0 ? null : discardedHashes[0],
      });
    }
  }

  // 规则 6：输出稳定排序。
  items.sort(compareSampleItems);

  return {
    schemaVersion: MARKET_SCAN_SAMPLE_SCHEMA,
    metricsVersion: input.metricsVersion,
    itemCount: items.length,
    sampleHash: computeSampleHash({
      nicheDefinition: input.nicheDefinition,
      sampleDefinition: input.sampleDefinition,
      items,
      metricsVersion: input.metricsVersion,
    }),
    items,
  };
}

/** 校验并投影一条样本条目；任何事实版本锁定字段缺失都 FAIL CLOSED。 */
function buildSampleDraftEntry(
  input: MarketScanSampleInputV1,
  index: number,
): SampleDraftEntry {
  const productFact: ProductFact | undefined = input.productFact;

  // 契约：调用方提供 `factValues`（已冻结的事实值快照）时以它为准，
  // 缺失才从 `ProductFact` 现场投影；两者由服务层保证描述同一份事实。
  const factValues = input.factValues ?? projectMarketFactValuesV1(productFact);

  const asin = normalizeAsin(factValues.asin);
  if (asin === "") {
    throw new MarketScanSampleError(
      "sample_invalid",
      `sample[${index}] has no usable ASIN (factValues.asin and basic.asin.value are both empty); a non-empty ASIN is required`,
    );
  }

  const subjectKey = typeof input.subjectKey === "string" ? input.subjectKey : "";
  if (subjectKey.trim() === "") {
    throw new MarketScanSampleError(
      "sample_invalid",
      `sample[${index}] (${asin}) has an empty subjectKey`,
    );
  }

  const sourceProof = productFact?.sourceProof;
  const sourceProofHash = typeof sourceProof?.contentHash === "string" ? sourceProof.contentHash : "";
  if (!CONTENT_HASH_PATTERN.test(sourceProofHash)) {
    throw new MarketScanSampleError(
      "sample_invalid",
      `sample[${index}] (${asin}) has an invalid sourceProof.contentHash; 64 lowercase hex characters are required`,
    );
  }

  const evidenceId = input.evidenceId ?? sourceProof?.evidenceId ?? null;
  if (typeof evidenceId !== "string" || evidenceId.trim() === "") {
    throw new MarketScanSampleError(
      "sample_invalid",
      `sample[${index}] (${asin}) has no evidenceId (neither the input nor sourceProof provides one)`,
    );
  }

  const capturedAt = input.capturedAt ?? sourceProof?.capturedAt ?? null;
  if (typeof capturedAt !== "string" || capturedAt.trim() === "") {
    throw new MarketScanSampleError(
      "sample_invalid",
      `sample[${index}] (${asin}) has no capturedAt (neither the input nor sourceProof provides one)`,
    );
  }

  const evidenceVersion =
    typeof input.evidenceVersion === "number" && Number.isFinite(input.evidenceVersion)
      ? input.evidenceVersion
      : 1;

  const imageRef = marketScanImageRefOf({
    productFact,
    subjectKey,
    evidenceId,
    evidenceVersion,
  });

  const draft: MarketScanSampleItemDraftV1 = {
    asin,
    subjectKey,
    candidateId: input.candidateId ?? null,
    productFactFingerprint: productFactFingerprintOf({ productFact, subjectKey }),
    // 事实值自证指纹：只凭快照自身就能重算，证明快照事实未被篡改 / 截断。
    factValuesFingerprint: factValuesFingerprintOf({ subjectKey, factValues }),
    sourceProofHash,
    evidenceId,
    evidenceVersion,
    capturedAt,
    sourceType: sourceProof.source,
    sampleValidityPolicyVersion: MARKET_SAMPLE_POLICY_VERSION,
    evidenceStatus: input.evidenceStatus ?? "sufficient_for_comparison",
    parentAsin: productFact.extended?.parentAsin?.status === "present" ? productFact.extended.parentAsin.value : null,
    // 事实值快照与「事实定位符」一起冻结：证据库 prune 掉旧版本后，
    // 已完成的扫描仍能自证当时用的是哪些事实值（复制证据，不是修改事实层）。
    factValues,
    ...(imageRef ? { imageRef } : {}),
  };

  return { draft, itemHash: sampleItemHashOf(draft) };
}

/* ── 事实值投影（与 productFactSource.marketFactValuesOf 语义一致） ── */

/** 只把 `status === "present"` 且非 null 的字段标记为 present，缺失保持 missing。 */
function factValueOf<T>(field: FactField<T> | undefined | null): MarketFactValueV1<T> {
  return field !== undefined && field !== null && field.status === "present" && field.value !== null
    ? { presence: "present", value: field.value }
    : { presence: "missing" };
}

/**
 * 第三方估算字段：SellerSprite 的月销量 / 月销售额永远是第三方估算，
 * 任何链路都不允许把它当作实测事实。按字段语义硬编码，不按 confidence 推断。
 */
const PROVIDER_ESTIMATE_FACT_FIELDS = new Set([
  "monthlySalesEstimate",
  "monthlyRevenueEstimate",
]);

function factFieldOf<T>(
  name: string,
  field: FactField<T> | undefined | null,
): MarketFactFieldV1<T> {
  const valueSource: MarketFactValueSourceV1 = PROVIDER_ESTIMATE_FACT_FIELDS.has(name)
    ? "PROVIDER_ESTIMATE"
    : "FACT";
  const value = name === "price" || name === "monthlyRevenueEstimate"
    ? moneyFactValueOf(field)
    : factValueOf(field);
  return { ...value, valueSource };
}

function moneyFactValueOf<T>(field: FactField<T> | undefined | null): MarketFactValueV1<T> {
  if (field === undefined || field === null || field.status !== "present") {
    return { presence: "missing" };
  }
  return isValidMarketMoneyValue(field.value)
    ? { presence: "present", value: field.value as T }
    : { presence: "missing" };
}

/**
 * 把 `ProductFact` 裁剪成指标真正消费的字段子集。
 *
 * 与 `lib/marketScan/productFactSource.ts` 的 `marketFactValuesOf` 语义一致；
 * 此处**刻意重复实现**，因为那条链路会 import evidenceStore / Prisma，
 * 而本文件必须保持「纯函数、无 IO」的边界。生产链路总是提供 `factValues`，
 * 本函数只作为直接调用本模块时的兜底投影。
 */
export function projectMarketFactValuesV1(productFact: ProductFact): MarketFactValuesV1 {
  const basic = productFact?.basic;
  const market = productFact?.market;
  const asinField = basic?.asin;
  const asin =
    asinField !== undefined && asinField.status === "present" && typeof asinField.value === "string"
      ? asinField.value.trim().toUpperCase()
      : "";

  return {
    asin,
    title: factValueOf(basic?.title),
    brand: factValueOf(basic?.brand),
    category: factValueOf(basic?.category),
    price: factFieldOf("price", basic?.price),
    rating: factValueOf(basic?.rating),
    reviewCount: factValueOf(basic?.reviewCount),
    bsr: factValueOf(market?.bsr),
    monthlySalesEstimate: factFieldOf("monthlySalesEstimate", market?.monthlySalesEstimate),
    monthlyRevenueEstimate: factFieldOf(
      "monthlyRevenueEstimate",
      market?.monthlyRevenueEstimate,
    ),
    launchedDate: factValueOf(market?.launchedDate),
  };
}

const EXTERNAL_IMAGE_URL_PATTERN = /^https:\/\/\S+$/iu;
const INLINE_IMAGE_DATA_URL_PATTERN = /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+=*$/iu;

/**
 * 将 ProductFact 的主图裁剪成不会膨胀 MarketScan 快照的引用。
 *
 * 真实 ProductBatch 目前可能把图片作为 Evidence 内的 Base64 Data URL 保存。
 * 这种值只能通过 Evidence 的 subject/version 定位符引用；只有原本就是公网
 * HTTPS URL 时才直接保存 URL。任何其它形式都保持缺失，绝不把未知内容写入快照。
 */
export function marketScanImageRefOf(input: {
  readonly productFact: ProductFact | undefined;
  readonly subjectKey: string;
  readonly evidenceId: string;
  readonly evidenceVersion: number;
}): MarketScanImageRefV1 | undefined {
  const image = input.productFact?.basic.image;
  if (image?.status !== "present" || typeof image.value !== "string") return undefined;
  const value = image.value.trim();
  if (!value) return undefined;
  if (value.length <= 2048 && EXTERNAL_IMAGE_URL_PATTERN.test(value)) {
    return {
      schemaVersion: MARKET_SCAN_IMAGE_REF_SCHEMA,
      kind: "external_url",
      url: value,
    };
  }
  if (!INLINE_IMAGE_DATA_URL_PATTERN.test(value)
    || !input.subjectKey.trim()
    || !input.evidenceId.trim()
    || !Number.isSafeInteger(input.evidenceVersion)
    || input.evidenceVersion < 1) {
    return undefined;
  }
  return {
    schemaVersion: MARKET_SCAN_IMAGE_REF_SCHEMA,
    kind: "source_evidence",
    subjectKey: input.subjectKey,
    evidenceId: input.evidenceId,
    evidenceVersion: input.evidenceVersion,
  };
}

/* 指标引擎 ─────────────────────────────────────────────────────── */

/**
 * 确定性市场统计。要求：
 * - 纯函数：无 Prisma / 无网络 / 无 AI / 无副作用 / 不读系统时间（参考时间由入参注入）。
 * - 缺失一律 `missing`，**绝不当 0**；来源不提供该字段时 `NOT_AVAILABLE`。
 * - 每个指标返回统一结构 `{ status, value, sampleSize, missingCount, calculationVersion }`。
 * - 分位数定义固定：排序后 `position = (n - 1) * p`，线性插值。
 */
export function computeMarketMetricsV1(input: MarketScanMetricsInputV1): MarketMetricsV1 {
  const metricsVersion = input.metricsVersion ?? MARKET_METRICS_VERSION;
  const sampleCount = input.sample.length;

  /**
   * 样本快照 hash 只能由调用方提供：`MarketScanMetricsInputV1` 里没有 nicheDefinition /
   * sampleDefinition，本函数无法重算 `computeSampleHash(...)`。这里做前向兼容读取：
   * 调用方注入合法的 64 位小写十六进制 `sampleHash` 时直接采用；没有就返回空串并写入 notes，
   * **绝不臆造一个看起来合法的 hash**（宁可在持久化层 fail-closed）。
   */
  const injectedSampleHash = readInjectedSampleHash(input);

  const readStats: ReadStats = { negativeValues: 0, fingerprintFailures: 0 };
  const rawReadings = input.sample.map((entry) => readSample(entry, readStats));
  const marketplace = input.marketplace ?? input.sample[0]?.subjectKey.split(":")[1] ?? "";
  const validSet = resolveDeterministicMarketSamples({ marketplace, items: input.sample.map((entry, index) => ({
    id: String(index), ordinal: index, asin: rawReadings[index]?.asin, subjectKey: entry.subjectKey,
    marketplace, factValues: entry.factValues ?? projectMarketFactValuesV1(entry.productFact),
    evidenceId: entry.evidenceId ?? entry.productFact?.sourceProof?.evidenceId,
    evidenceVersion: entry.evidenceVersion ?? 1, sourceProofHash: entry.productFact?.sourceProof?.contentHash,
    capturedAt: entry.capturedAt ?? entry.productFact?.sourceProof?.capturedAt, evidenceStatus: entry.evidenceStatus,
    parentAsin: entry.productFact?.extended?.parentAsin?.status === "present" ? entry.productFact.extended.parentAsin.value : null,
    integrityValid: rawReadings[index]?.asin !== null && entry.productFact?.subjectKey === entry.subjectKey
      && entry.productFact?.sourceProof?.subjectKey === entry.subjectKey
      && (!entry.evidenceId || entry.evidenceId === entry.productFact?.sourceProof?.evidenceId),
  })) });
  const validIndexes = new Set(validSet.validItemIds);
  const validSampleCount = validSet.validCount;
  const readings = rawReadings.map((reading, index) => validIndexes.has(String(index)) ? reading : EMPTY_READINGS);

  /* ── 字段取值（缺失一律 null，绝不补 0） ─────────────────────── */

  const priceValues = numbersOf(readings, (reading) => reading.price);
  const salesValues = numbersOf(readings, (reading) => reading.sales);
  const revenueValues = numbersOf(readings, (reading) => reading.revenue);
  const ratingValues = numbersOf(readings, (reading) => reading.rating);
  const reviewValues = numbersOf(readings, (reading) => reading.reviewCount);
  const bsrValues = numbersOf(readings, (reading) => reading.bsr);

  const brandReadings = readings.filter((reading) => reading.brand !== null);
  const launchedDateReadings = readings.filter((reading) => reading.launchedDate !== null);

  const fieldCoverage: MarketFieldCoverageV1 = {
    price: coverageOf(priceValues.length, sampleCount),
    sales: coverageOf(salesValues.length, sampleCount),
    revenue: coverageOf(revenueValues.length, sampleCount),
    brand: coverageOf(brandReadings.length, sampleCount),
    rating: coverageOf(ratingValues.length, sampleCount),
    reviewCount: coverageOf(reviewValues.length, sampleCount),
    bsr: coverageOf(bsrValues.length, sampleCount),
    launchedDate: coverageOf(launchedDateReadings.length, sampleCount),
  };

  /* ── price ──────────────────────────────────────────────────── */

  const priceMissing = sampleCount - priceValues.length;
  const price: MarketMetric<MarketNumericDistributionV1> =
    priceValues.length === 0
      ? notAvailable<MarketNumericDistributionV1>(0, sampleCount, metricsVersion)
      : present<MarketNumericDistributionV1>(
          distributionOf(priceValues, priceMissing),
          priceValues.length,
          priceMissing,
          metricsVersion,
        );

  /* ── sales（只用真实 monthlySalesEstimate） ─────────────────── */

  const salesMissing = sampleCount - salesValues.length;
  let sales: MarketMetricsV1["sales"];
  if (salesValues.length === 0) {
    sales = notAvailable<NonNullable<MarketMetricsV1["sales"]["value"]>>(
      0,
      sampleCount,
      metricsVersion,
    );
  } else {
    const distribution = distributionOf(salesValues, salesMissing);
    sales = present<NonNullable<MarketMetricsV1["sales"]["value"]>>(
      {
        total: sumOfSorted(salesValues),
        mean: distribution.mean,
        median: distribution.median,
        p25: distribution.p25,
        p75: distribution.p75,
        min: distribution.min,
        max: distribution.max,
        distribution,
      },
      salesValues.length,
      salesMissing,
      metricsVersion,
    );
  }

  /* ── revenue（只用真实 monthlyRevenueEstimate） ─────────────── */

  type RevenueValue = NonNullable<MarketMetricsV1["revenue"]["value"]>;

  const revenueMissing = sampleCount - revenueValues.length;
  let revenue: MarketMetricsV1["revenue"];
  let derivedRevenueFromPriceTimesSales: number | null = null;
  if (revenueValues.length > 0) {
    const distribution = distributionOf(revenueValues, revenueMissing);
    revenue = present<RevenueValue>(
      {
        currency: dominantCurrency(readings),
        total: sumOfSorted(revenueValues),
        mean: distribution.mean,
        median: distribution.median,
        p25: distribution.p25,
        p75: distribution.p75,
        distribution,
        derivedFromPriceTimesSales: null,
        derivedFromSourceFacts: false,
      },
      revenueValues.length,
      revenueMissing,
      metricsVersion,
    );
  } else {
    // 完全没有来源 revenue 事实时，允许给出**显式派生**值作参考；
    // 但派生值不是来源事实，因此 status 仍是 NOT_AVAILABLE、value 仍是 null。
    const derivedProducts: number[] = [];
    for (const reading of readings) {
      if (reading.price !== null && reading.sales !== null) {
        derivedProducts.push(reading.price * reading.sales);
      }
    }
    if (derivedProducts.length === 0) {
      revenue = notAvailable<RevenueValue>(0, sampleCount, metricsVersion);
    } else {
      derivedProducts.sort(compareNumberAsc);
      derivedRevenueFromPriceTimesSales = sumOfSorted(derivedProducts);
      revenue = notAvailable<RevenueValue>(
        derivedProducts.length,
        sampleCount - derivedProducts.length,
        metricsVersion,
      );
    }
  }

  /* ── 销量集中度 ─────────────────────────────────────────────── */

  const salesPoints: ConcentrationPoint[] = [];
  const knownSalesByAsin = new Map<string, number>();
  for (const reading of readings) {
    if (reading.asin === null || reading.sales === null) continue;
    salesPoints.push({ key: reading.asin, value: reading.sales });
    knownSalesByAsin.set(reading.asin, reading.sales);
  }

  const salesConcentration = {
    cr3: concentrationOf(salesPoints, 3, sampleCount, salesPoints.length, metricsVersion),
    cr5: concentrationOf(salesPoints, 5, sampleCount, salesPoints.length, metricsVersion),
    cr10: concentrationOf(salesPoints, 10, sampleCount, salesPoints.length, metricsVersion),
  };

  /* ── 品牌集中度（品牌缺失商品不得归入兜底品牌） ─────────────── */

  const brandSales = new Map<string, number[]>();
  let brandSalesSampleCount = 0;
  for (const reading of readings) {
    if (reading.asin === null || reading.brand === null || reading.sales === null) continue;
    brandSalesSampleCount += 1;
    const bucket = brandSales.get(reading.brand);
    if (bucket === undefined) {
      brandSales.set(reading.brand, [reading.sales]);
    } else {
      bucket.push(reading.sales);
    }
  }
  const brandPoints: ConcentrationPoint[] = [...brandSales.entries()]
    .map(([brand, values]) => ({ key: brand, value: sumOfSorted([...values].sort(compareNumberAsc)) }))
    .sort(comparePointsByKey);

  const brandSalesMissing = sampleCount - brandSalesSampleCount;
  const uniqueBrandCount =
    brandReadings.length === 0
      ? notAvailable<number>(0, sampleCount, metricsVersion)
      : present<number>(
          new Set(brandReadings.map((reading) => reading.brand)).size,
          brandReadings.length,
          sampleCount - brandReadings.length,
          metricsVersion,
        );

  const brandConcentration: MarketMetricsV1["brandConcentration"] = {
    brandCr3: concentrationOf(brandPoints, 3, sampleCount, brandSalesSampleCount, metricsVersion),
    brandCr5: concentrationOf(brandPoints, 5, sampleCount, brandSalesSampleCount, metricsVersion),
    uniqueBrandCount,
    missingBrandCount: sampleCount - brandReadings.length,
  };

  /* ── rating ─────────────────────────────────────────────────── */

  const ratingMissing = sampleCount - ratingValues.length;
  const rating: MarketMetricsV1["rating"] =
    ratingValues.length === 0
      ? {
          averageRating: notAvailable<number>(0, sampleCount, metricsVersion),
          medianRating: notAvailable<number>(0, sampleCount, metricsVersion),
        }
      : {
          averageRating: present<number>(
            meanOfSorted(ratingValues),
            ratingValues.length,
            ratingMissing,
            metricsVersion,
          ),
          medianRating: present<number>(
            quantile(ratingValues, 0.5),
            ratingValues.length,
            ratingMissing,
            metricsVersion,
          ),
        };

  /* ── reviews ────────────────────────────────────────────────── */

  const reviewMissing = sampleCount - reviewValues.length;
  const reviewRanked: ReviewPoint[] = [];
  for (const reading of readings) {
    if (reading.asin === null || reading.reviewCount === null) continue;
    reviewRanked.push({ key: reading.asin, value: reading.reviewCount });
  }
  reviewRanked.sort(comparePointsByValueDescThenKeyAsc);

  type TopReviewValue = NonNullable<MarketMetricsV1["reviews"]["topReviewThreshold"]["value"]>;
  const knownSalesTotal = sumOfSorted(salesValues);
  let topReviewThreshold: MarketMetric<TopReviewValue>;
  if (reviewRanked.length === 0) {
    topReviewThreshold = notAvailable<TopReviewValue>(0, sampleCount, metricsVersion);
  } else {
    const topN = Math.max(1, Math.ceil(sampleCount * TOP_REVIEW_SHARE));
    const head = reviewRanked.slice(0, topN);
    let thresholdReviewCount = head[0].value;
    const headSales: number[] = [];
    for (const point of head) {
      if (point.value < thresholdReviewCount) thresholdReviewCount = point.value;
      const sales = knownSalesByAsin.get(point.key);
      if (sales !== undefined) headSales.push(sales);
    }
    headSales.sort(compareNumberAsc);
    topReviewThreshold = present<TopReviewValue>(
      {
        topN,
        definition: TOP_REVIEW_DEFINITION,
        thresholdReviewCount,
        headSampleCount: head.length,
        headSalesShare: knownSalesTotal === 0 ? null : sumOfSorted(headSales) / knownSalesTotal,
      },
      reviewRanked.length,
      reviewMissing,
      metricsVersion,
    );
  }

  const reviews: MarketMetricsV1["reviews"] =
    reviewValues.length === 0
      ? {
          averageReviewCount: notAvailable<number>(0, sampleCount, metricsVersion),
          medianReviewCount: notAvailable<number>(0, sampleCount, metricsVersion),
          topReviewThreshold,
        }
      : {
          averageReviewCount: present<number>(
            meanOfSorted(reviewValues),
            reviewValues.length,
            reviewMissing,
            metricsVersion,
          ),
          medianReviewCount: present<number>(
            quantile(reviewValues, 0.5),
            reviewValues.length,
            reviewMissing,
            metricsVersion,
          ),
          topReviewThreshold,
        };

  /* ── newEntrants（只信 launchedDate） ──────────────────────── */

  const referenceMs = parseIsoInstantMs(input.referenceDate);
  const launchedPoints: LaunchedPoint[] = [];
  for (const reading of readings) {
    if (reading.asin === null || reading.launchedAtMs === null) continue;
    launchedPoints.push({ atMs: reading.launchedAtMs, sales: reading.sales });
  }

  let newEntrants: MarketMetricsV1["newEntrants"];
  if (referenceMs === null || launchedPoints.length === 0) {
    newEntrants = {
      referenceDate: input.referenceDate,
      newProductCount30d: notAvailable<number>(0, sampleCount, metricsVersion),
      newProductCount90d: notAvailable<number>(0, sampleCount, metricsVersion),
      newProductShare90d: notAvailable<number>(0, sampleCount, metricsVersion),
      newProductSalesShare90d: notAvailable<number>(0, sampleCount, metricsVersion),
    };
  } else {
    const launchedMissing = sampleCount - launchedPoints.length;
    const within30d = launchedPoints.filter((point) => {
      const days = (referenceMs - point.atMs) / DAY_MS;
      return days >= 0 && days <= 30;
    });
    const within90d = launchedPoints.filter((point) => {
      const days = (referenceMs - point.atMs) / DAY_MS;
      return days >= 0 && days <= 90;
    });
    const newProductSales: number[] = [];
    for (const point of within90d) {
      if (point.sales !== null) newProductSales.push(point.sales);
    }
    newProductSales.sort(compareNumberAsc);

    const salesShareMissing = sampleCount - salesValues.length;
    const newProductSalesShare =
      newProductSales.length === 0 || knownSalesTotal === 0
        ? null
        : sumOfSorted(newProductSales) / knownSalesTotal;

    newEntrants = {
      referenceDate: input.referenceDate,
      newProductCount30d: present<number>(
        within30d.length,
        launchedPoints.length,
        launchedMissing,
        metricsVersion,
      ),
      newProductCount90d: present<number>(
        within90d.length,
        launchedPoints.length,
        launchedMissing,
        metricsVersion,
      ),
      newProductShare90d: present<number>(
        within90d.length / launchedPoints.length,
        launchedPoints.length,
        launchedMissing,
        metricsVersion,
      ),
      newProductSalesShare90d:
        newProductSalesShare === null
          ? notAvailable<number>(salesValues.length, salesShareMissing, metricsVersion)
          : present<number>(
              newProductSalesShare,
              salesValues.length,
              salesShareMissing,
              metricsVersion,
            ),
    };
  }

  /* ── notes（只写事实，不做业务结论） ───────────────────────── */

  // 调用方补充的说明在前（样本来源、批次名等上下文），引擎自己的说明在后；
  // 引擎只追加、绝不覆盖自己的告警。
  const notes: string[] = [...callerNotesOf(input)];
  const salesConcentrationMissing = sampleCount - salesPoints.length;
  if (salesConcentrationMissing > 0) {
    notes.push(
      `sales concentration only covers known sales: ${salesConcentrationMissing} of ${sampleCount} sample items have no sales estimate`,
    );
  }
  if (brandSalesMissing - salesConcentrationMissing > 0) {
    notes.push(
      `brand concentration only covers items with a present brand and a known sales estimate: ${brandSalesMissing} of ${sampleCount} sample items are excluded from brand share`,
    );
  }
  if (revenue.status !== "PRESENT" && derivedRevenueFromPriceTimesSales !== null) {
    notes.push(
      `revenue is NOT_AVAILABLE: no source monthlyRevenueEstimate fact; derivedFromPriceTimesSales=${derivedRevenueFromPriceTimesSales} is DERIVED from price × sales (not a source fact) and is therefore not returned as a value`,
    );
  }
  if (launchedPoints.length === 0) {
    notes.push(
      "new entrant metrics are NOT_AVAILABLE: the current sources do not provide a trustworthy market.launchedDate",
    );
  }
  if (referenceMs === null) {
    notes.push(
      `new entrant metrics are NOT_AVAILABLE: referenceDate "${input.referenceDate}" is not a parseable ISO date`,
    );
  }
  if (readStats.negativeValues > 0) {
    notes.push(
      `${readStats.negativeValues} numeric fact field(s) hold negative values (impossible for price / sales / revenue / rating / reviewCount / bsr) and are treated as missing`,
    );
  }
  if (readStats.fingerprintFailures > 0) {
    notes.push(
      `${readStats.fingerprintFailures} sample item(s) could not be fingerprinted and are excluded from every statistic (still counted in sampleCount)`,
    );
  }
  if (injectedSampleHash === null) {
    notes.push(
      "metrics.sampleHash is unavailable: the caller did not supply the sample snapshot hash, and the metrics input carries no nicheDefinition / sampleDefinition to recompute it; persistence requires metrics.sampleHash === sampleSnapshot.sampleHash",
    );
  }

  return {
    schemaVersion: MARKET_METRICS_SCHEMA,
    metricsVersion,
    sampleHash: injectedSampleHash ?? "",
    sampleCount,
    validSampleCount,
    fieldCoverage,
    price,
    sales,
    revenue,
    salesConcentration,
    brandConcentration,
    rating,
    reviews,
    newEntrants,
    evidenceWindow: evidenceWindowOf(input),
    notes,
  };
}

/* ── 内部常量 ─────────────────────────────────────────────────── */

/** `sourceProof.contentHash` 必须是 64 位小写十六进制。 */
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

const DAY_MS = 86_400_000;

/** Top review 定义：按 reviewCount 降序取前 20%（向上取整，至少 1 条）。 */
const TOP_REVIEW_SHARE = 0.2;
const TOP_REVIEW_DEFINITION = "top 20% by reviewCount desc, asin asc";

/**
 * 严格 ISO-8601 解析。无时区偏移的时间按 UTC 解释（保证与运行环境时区无关），
 * 非法日期（如 2024-02-30）返回 null。
 */
const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*(Z|z|[+-]\d{2}:?\d{2})?)?$/;

/* ── 内部类型与工具 ───────────────────────────────────────────── */

type SampleReadings = {
  readonly asin: string | null;
  readonly price: number | null;
  readonly sales: number | null;
  readonly revenue: number | null;
  readonly revenueCurrency: string | null;
  readonly brand: string | null;
  readonly rating: number | null;
  readonly reviewCount: number | null;
  readonly bsr: number | null;
  readonly launchedDate: string | null;
  readonly launchedAtMs: number | null;
};

type ReadStats = {
  negativeValues: number;
  fingerprintFailures: number;
};

type AmountReading = {
  readonly amount: number;
  readonly currency: string | null;
};

/** `MarketFactValueV1` / `MarketFactFieldV1` 的结构化读取视图。 */
type FactPresenceLike = {
  readonly presence?: unknown;
  readonly value?: unknown;
};

type ConcentrationPoint = {
  readonly key: string;
  readonly value: number;
};

type ReviewPoint = ConcentrationPoint;

type LaunchedPoint = {
  readonly atMs: number;
  readonly sales: number | null;
};

const EMPTY_READINGS: SampleReadings = {
  asin: null,
  price: null,
  sales: null,
  revenue: null,
  revenueCurrency: null,
  brand: null,
  rating: null,
  reviewCount: null,
  bsr: null,
  launchedDate: null,
  launchedAtMs: null,
};

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareNumberAsc(left: number, right: number): number {
  return left - right;
}

function comparePointsByKey(left: ConcentrationPoint, right: ConcentrationPoint): number {
  return compareStrings(left.key, right.key);
}

function comparePointsByValueDescThenKeyAsc(
  left: ConcentrationPoint,
  right: ConcentrationPoint,
): number {
  return right.value - left.value || compareStrings(left.key, right.key);
}

function normalizeAsin(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toUpperCase();
}

/** 数值升序副本；后续求和一律基于它，保证浮点结果与输入顺序无关。 */
function numbersOf<T>(items: readonly T[], pick: (item: T) => number | null): number[] {
  const values: number[] = [];
  for (const item of items) {
    const value = pick(item);
    if (value !== null) values.push(value);
  }
  values.sort(compareNumberAsc);
  return values;
}

function sumOfSorted(sortedValues: readonly number[]): number {
  let total = 0;
  for (const value of sortedValues) total += value;
  return total;
}

function meanOfSorted(sortedValues: readonly number[]): number {
  return sumOfSorted(sortedValues) / sortedValues.length;
}

/** 分位数：`position = (n - 1) * p`，向下取整索引 lo，线性插值。 */
function quantile(sortedValues: readonly number[], p: number): number {
  const count = sortedValues.length;
  const position = (count - 1) * p;
  const lo = Math.floor(position);
  const hi = Math.min(lo + 1, count - 1);
  const low = sortedValues[lo];
  const high = sortedValues[hi];
  return low + (high - low) * (position - lo);
}

function distributionOf(
  sortedValues: readonly number[],
  missingCount: number,
): MarketNumericDistributionV1 {
  return {
    min: sortedValues[0],
    max: sortedValues[sortedValues.length - 1],
    mean: meanOfSorted(sortedValues),
    median: quantile(sortedValues, 0.5),
    p25: quantile(sortedValues, 0.25),
    p75: quantile(sortedValues, 0.75),
    sampleSize: sortedValues.length,
    missingCount,
  };
}

function coverageOf(presentCount: number, sampleCount: number): MarketFieldCoverage {
  return {
    presentCount,
    missingCount: sampleCount - presentCount,
    coverageRatio: sampleCount === 0 ? 0 : presentCount / sampleCount,
  };
}

function metricOf<T>(
  status: MarketMetricStatus,
  value: T | null,
  sampleSize: number,
  missingCount: number,
  calculationVersion: string,
): MarketMetric<T> {
  if (status === "PRESENT") {
    if (value === null) {
      throw new Error("market metric invariant violated: PRESENT requires a non-null value");
    }
    return { status, value, sampleSize, missingCount, calculationVersion };
  }
  // 非 PRESENT 一律 value = null：禁止用 0 顶替缺失。
  return { status, value: null, sampleSize, missingCount, calculationVersion };
}

function present<T>(
  value: T,
  sampleSize: number,
  missingCount: number,
  calculationVersion: string,
): MarketMetric<T> {
  return metricOf("PRESENT", value, sampleSize, missingCount, calculationVersion);
}

function notAvailable<T>(
  sampleSize: number,
  missingCount: number,
  calculationVersion: string,
): MarketMetric<T> {
  return metricOf<T>("NOT_AVAILABLE", null, sampleSize, missingCount, calculationVersion);
}

function concentrationOf(
  points: readonly ConcentrationPoint[],
  topN: number,
  sampleCount: number,
  usedSampleCount: number,
  calculationVersion: string,
): MarketMetric<MarketConcentrationV1> {
  const missingCount = sampleCount - usedSampleCount;
  if (usedSampleCount === 0 || points.length === 0) {
    return notAvailable<MarketConcentrationV1>(0, sampleCount, calculationVersion);
  }
  if (usedSampleCount < topN) {
    // 已知销量样本不足，无法表达 Top N：value 必须为 null。
    return metricOf<MarketConcentrationV1>(
      "INSUFFICIENT_DATA",
      null,
      usedSampleCount,
      missingCount,
      calculationVersion,
    );
  }

  const denominator = sumOfSorted(points.map((point) => point.value).sort(compareNumberAsc));
  const ranked = [...points].sort(comparePointsByValueDescThenKeyAsc);
  const head = ranked.slice(0, topN);
  const topNEntries = head.map((point, index) => ({
    rank: index + 1,
    key: point.key,
    value: point.value,
    share: denominator === 0 ? 0 : point.value / denominator,
  }));
  const ratio =
    denominator === 0
      ? null
      : sumOfSorted(topNEntries.map((entry) => entry.value).sort(compareNumberAsc)) / denominator;

  return present<MarketConcentrationV1>(
    { denominator, usedSampleCount, missingCount, topN: topNEntries, ratio },
    usedSampleCount,
    missingCount,
    calculationVersion,
  );
}

/** 读取 `{ presence, value }` 结构的事实值；非 present 或无值一律 null。 */
function presentValueOf(field: FactPresenceLike | null | undefined): unknown {
  if (field === null || field === undefined || field.presence !== "present") return null;
  const value = field.value;
  return value === undefined || value === null ? null : value;
}

function readNumber(field: FactPresenceLike | null | undefined, stats: ReadStats): number | null {
  const value = presentValueOf(field);
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) {
    // 契约允许的选择：负值物理上不可能 → 按 missing 处理（并在 notes 中说明）。
    stats.negativeValues += 1;
    return null;
  }
  return value;
}

function readAmount(field: FactPresenceLike | null | undefined, stats: ReadStats): AmountReading | null {
  const value = presentValueOf(field);
  if (!isValidMarketMoneyValue(value)) return null;
  if (value.amount < 0) {
    stats.negativeValues += 1;
    return null;
  }
  return { amount: value.amount, currency: value.currency };
}

function readText(field: FactPresenceLike | null | undefined): string | null {
  const value = presentValueOf(field);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function readSample(input: MarketScanSampleInputV1, stats: ReadStats): SampleReadings {
  const productFact: ProductFact | undefined = input.productFact;

  // 契约：调用方提供已冻结的 `factValues` 时必须直接使用它（历史扫描不随证据库漂移），
  // 缺失时才从 `ProductFact` 现场投影。
  const values: MarketFactValuesV1 | null =
    input.factValues ?? (productFact === undefined ? null : projectMarketFactValuesV1(productFact));
  if (values === null) return EMPTY_READINGS;

  const asin = normalizeAsin(values.asin);
  if (asin === "") return EMPTY_READINGS;

  try {
    productFactFingerprintOf({ productFact, subjectKey: input.subjectKey });
  } catch {
    stats.fingerprintFailures += 1;
    return EMPTY_READINGS;
  }

  const price = readAmount(values.price, stats);
  const revenue = readAmount(values.monthlyRevenueEstimate, stats);
  const launchedDate = readText(values.launchedDate);

  return {
    asin,
    price: price === null ? null : price.amount,
    sales: readNumber(values.monthlySalesEstimate, stats),
    revenue: revenue === null ? null : revenue.amount,
    revenueCurrency: revenue === null ? null : revenue.currency,
    brand: readText(values.brand),
    rating: readNumber(values.rating, stats),
    reviewCount: readNumber(values.reviewCount, stats),
    bsr: readNumber(values.bsr, stats),
    launchedDate,
    launchedAtMs: launchedDate === null ? null : parseIsoInstantMs(launchedDate),
  };
}

/** 出现次数最多的币种；并列时取字典序最小者；没有币种信息时 null（绝不臆造）。 */
function dominantCurrency(readings: readonly SampleReadings[]): string | null {
  const counts = new Map<string, number>();
  for (const reading of readings) {
    const currency = reading.revenueCurrency;
    if (currency === null) continue;
    counts.set(currency, (counts.get(currency) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [currency, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && currency < best)) {
      best = currency;
      bestCount = count;
    }
  }
  return best;
}

/** 调用方补充的说明：只保留非空字符串，顺序原样保留。 */
function callerNotesOf(input: MarketScanMetricsInputV1): string[] {
  const extra = input.extraNotes;
  if (!Array.isArray(extra)) return [];
  const notes: string[] = [];
  for (const note of extra) {
    if (typeof note === "string" && note.trim() !== "") notes.push(note);
  }
  return notes;
}

/**
 * 读取调用方注入的样本快照 hash。
 *
 * `MarketMetricsV1.sampleHash` 必填，且持久化层要求它等于 `sampleSnapshot.sampleHash`。
 * 指标引擎无法自行重算（输入里没有 nicheDefinition / sampleDefinition），
 * 因此由调用方通过 `MarketScanMetricsInputV1.sampleHash` 传入；
 * 未提供或格式非法时返回 null，引擎保持空串 + notes，绝不臆造。
 */
function readInjectedSampleHash(input: MarketScanMetricsInputV1): string | null {
  const candidate = input.sampleHash;
  return typeof candidate === "string" && CONTENT_HASH_PATTERN.test(candidate.trim())
    ? candidate.trim()
    : null;
}

/**
 * 样本所属市场站点：显式入参优先；否则按 subjectKey 的市场段推断。
 *
 * 推断采取 fail-closed：只有**全部可推断样本一致**时才采用该站点，
 * 混合站点一律 UNKNOWN —— 不拿出现次数最多的站点去代表整个样本（会误导 UI）。
 */
function marketplaceOf(input: MarketScanMetricsInputV1): string {
  const explicit = typeof input.marketplace === "string" ? input.marketplace.trim().toUpperCase() : "";
  if (explicit !== "") return explicit;

  const inferred = new Set<string>();
  for (const entry of input.sample) {
    const subjectKey = entry?.subjectKey;
    if (typeof subjectKey !== "string") continue;
    const segments = subjectKey.split(":");
    if (segments.length < 2) continue;
    const marketplace = segments[1]?.trim().toUpperCase() ?? "";
    if (!/^[A-Z]{2,8}$/.test(marketplace)) continue;
    inferred.add(marketplace);
  }

  if (inferred.size !== 1) return "UNKNOWN";
  return [...inferred][0];
}

/**
 * 观测窗口：如实记录「指标依据的证据是什么时候采集的」。
 *
 * - `recordedObservedAt` 只有调用方显式给出，或退化为最新 evidence capturedAt 时才有值；
 *   未知时保持 null（禁止用扫描创建时间冒充）。
 * - 无法解析的 capturedAt 不参与最早 / 最晚排序（不能可靠比较就不猜）。
 */
function evidenceWindowOf(input: MarketScanMetricsInputV1): MarketMetricsV1["evidenceWindow"] {
  const stamps: Array<{ readonly text: string; readonly ms: number }> = [];
  for (const entry of input.sample) {
    const candidates = [entry?.capturedAt, entry?.productFact?.sourceProof?.capturedAt];
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || candidate.trim() === "") continue;
      const text = candidate.trim();
      const ms = parseIsoInstantMs(text);
      if (ms === null) continue;
      stamps.push({ text, ms });
      break; // 每个样本只取最权威的一个 capturedAt（入参优先）
    }
  }

  let earliest: { readonly text: string; readonly ms: number } | null = null;
  let latest: { readonly text: string; readonly ms: number } | null = null;
  for (const stamp of stamps) {
    if (earliest === null || stamp.ms < earliest.ms
      || (stamp.ms === earliest.ms && stamp.text < earliest.text)) {
      earliest = stamp;
    }
    if (latest === null || stamp.ms > latest.ms
      || (stamp.ms === latest.ms && stamp.text > latest.text)) {
      latest = stamp;
    }
  }

  const observedAt =
    typeof input.observedAt === "string" && input.observedAt.trim() !== ""
      ? input.observedAt.trim()
      : null;
  const observedAtSource: MarketMetricsV1["evidenceWindow"]["observedAtSource"] =
    observedAt !== null ? "caller_recorded" : latest !== null ? "evidence_captured_at" : "unknown";

  return {
    earliestCapturedAt: earliest === null ? null : earliest.text,
    latestCapturedAt: latest === null ? null : latest.text,
    recordedObservedAt: observedAt ?? (latest === null ? null : latest.text),
    observedAtSource,
    marketplace: marketplaceOf(input),
  };
}

/** 严格解析为 UTC 毫秒时间戳；不可解析时返回 null（按 missing 计）。 */
function parseIsoInstantMs(value: string): number | null {
  const match = ISO_INSTANT_PATTERN.exec(value.trim());
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const millisecond = match[7] === undefined ? 0 : Number(match[7].padEnd(3, "0"));
  const zone = match[8];

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let instant = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  if (Number.isNaN(instant)) return null;

  // 拒绝被 Date.UTC 归一化的假日期（例如 2024-02-30）。
  const check = new Date(instant);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }

  if (zone !== undefined && zone !== "Z" && zone !== "z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const offsetHours = Number(digits.slice(0, 2));
    const offsetMinutes = Number(digits.slice(2, 4));
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    instant -= sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  }

  return instant;
}

function compareSampleItems(
  left: MarketScanSampleItemV1,
  right: MarketScanSampleItemV1,
): number {
  return (
    compareStrings(left.asin, right.asin) ||
    compareStrings(left.productFactFingerprint, right.productFactFingerprint)
  );
}

/** 去重时的确定性保留顺序：evidenceVersion → sourceProofHash → evidenceId → itemHash。 */
function compareDraftEntries(left: SampleDraftEntry, right: SampleDraftEntry): number {
  const byVersion = left.draft.evidenceVersion - right.draft.evidenceVersion;
  if (byVersion !== 0) return byVersion;
  return (
    compareStrings(left.draft.sourceProofHash, right.draft.sourceProofHash) ||
    compareStrings(left.draft.evidenceId, right.draft.evidenceId) ||
    compareStrings(left.itemHash, right.itemHash)
  );
}
