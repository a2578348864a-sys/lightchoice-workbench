/**
 * Product Development V1 — Phase 1：只读 ProductFact projection adapter。
 *
 * 职责边界（刻意保持很薄）：
 *
 * ```
 * 已存在的 Evidence（证据库中的历史版本）
 *   → adaptEvidenceToProductFact（既有事实适配器，本阶段不改）
 *   → ProductFact[]  +  版本锁定元数据
 * ```
 *
 * 硬约束：
 * - **只读**。本模块不写证据、不写批次、不创建 Candidate、不创建 Task、不跑 Research、
 *   不调用 AI、不访问网络。MarketScan 创建因此没有任何事实层副作用。
 * - **source-agnostic**。输入是证据库里已经存在的 `CaptureEvidenceRecord`，
 *   不导入任何具体来源的 parser、字段名或表结构。
 * - 不做「顺手采集」。采集属于 Capture Gateway；本模块只消费已经落库的 Evidence。
 */

import { evaluateMarketSampleValidity } from "@/lib/marketScan/marketSampleValidity";
import { adaptEvidenceToProductFact } from "@/lib/sourceLayer/fact/productFactAdapter";
import type { FactField, ProductFact } from "@/lib/sourceLayer/fact/types";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import type { CaptureEvidenceRecord } from "@/lib/sourceLayer/sourceAdapter";
import type {
  MarketFactFieldV1,
  MarketFactValueSourceV1,
  MarketFactValueV1,
  MarketFactValuesV1,
  MarketScanSampleInputV1,
  MarketScanSourceType,
} from "@/lib/marketScan/types";
import { isValidMarketMoneyValue } from "@/lib/marketScan/money";

export type MarketScanProductFactProjection = {
  readonly subjectKey: string;
  readonly asin: string | null;
  readonly displayTitle: string | null;
  readonly marketplace: string;
  readonly sourceType: MarketScanSourceType;
  /** 命中的 Evidence 版本号。 */
  readonly evidenceVersion: number;
  readonly evidenceId: string;
  readonly capturedAt: string;
  /** 证据包内容指纹（= ProductFact.sourceProof.contentHash）。 */
  readonly sourceProofHash: string;
  readonly validationVerdict: CaptureEvidenceRecord["validation"]["verdict"];
  readonly productFact: ProductFact;
};

export type MarketScanEvidenceBinding = {
  readonly evidenceVersion: number;
  readonly evidenceId: string;
  readonly contentHash: string;
};

export type MarketScanProjectionQuery = {
  /** 证据库归属主体（由服务层从访问上下文解析，绝不来自请求体）。 */
  readonly operator: string;
  /** 只取这些 subjectKey；缺省取该主体下全部。 */
  readonly subjectKeys?: readonly string[];
  /** 每个 subjectKey 取哪一版 Evidence；缺省取最新版本。 */
  readonly evidenceVersions?: Readonly<Record<string, number>>;
  /** 只接受该 authoritative marketplace 的 Evidence 版本。 */
  readonly marketplace?: string | null;
  /** 只接受 ProductFact.sourceProof.source 属于这些来源的 Evidence。 */
  readonly sourceTypes?: readonly MarketScanSourceType[] | null;
  /** ProductBatch 只读范围：subjectKey 必须命中对应 Evidence 的 sourceRecordRef。 */
  readonly sourceRecordRefs?: Readonly<Record<string, string>>;
  /** 已保存的 Evidence 引用必须逐项命中版本、ID 和内容哈希，不能回落到最新版本。 */
  readonly evidenceBindings?: Readonly<Record<string, MarketScanEvidenceBinding>>;
  /** 样本上限（服务端硬上限由调用方施加）。 */
  readonly limit?: number | null;
};

const ASIN_SUBJECT_PREFIX = "amazon";
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

/** `amazon:US:B0XXXXXXXX` → `B0XXXXXXXX`；不符合既有主体键约定的返回 null。 */
export function asinFromSubjectKey(subjectKey: string): string | null {
  const parts = subjectKey.split(":");
  if (parts.length !== 3) return null;
  const [prefix, marketplace, asin] = parts;
  if (prefix !== ASIN_SUBJECT_PREFIX) return null;
  if (!marketplace || marketplace.length > 16) return null;
  const normalized = asin.toUpperCase();
  return ASIN_PATTERN.test(normalized) ? normalized : null;
}

export function marketplaceFromSubjectKey(subjectKey: string): string | null {
  const parts = subjectKey.split(":");
  if (parts.length !== 3 || parts[0] !== ASIN_SUBJECT_PREFIX) return null;
  return parts[1] || null;
}

function pickVersion(
  record: { versions: readonly CaptureEvidenceRecord[] },
  evidenceVersion: number | undefined,
  sourceRecordRef: string | undefined,
  binding: MarketScanEvidenceBinding | undefined,
): CaptureEvidenceRecord | null {
  if (binding) {
    return record.versions.find((version) => version.version === binding.evidenceVersion
      && version.evidenceId === binding.evidenceId && version.contentHash === binding.contentHash) ?? null;
  }
  const versions = sourceRecordRef === undefined
    ? record.versions
    : record.versions.filter((version) => version.pkg.sourceProof.sourceRecordRef === sourceRecordRef);
  if (versions.length === 0) return null;
  if (evidenceVersion === undefined) {
    return [...versions].sort((left, right) => left.version - right.version).at(-1) ?? null;
  }
  return versions.find((version) => version.version === evidenceVersion) ?? null;
}

/**
 * 从既有证据库投影出标准化 `ProductFact` 及其版本锁定元数据。
 * 纯读：调用它不会改变任何持久化状态。
 */
export async function projectProductFactsFromEvidence(
  query: MarketScanProjectionQuery,
): Promise<MarketScanProductFactProjection[]> {
  const store = createEvidenceStore(query.operator);
  const index = await store.listSubjects();
  const wanted = query.subjectKeys && query.subjectKeys.length > 0
    ? new Set(query.subjectKeys)
    : null;
  const marketplace = typeof query.marketplace === "string" && query.marketplace.trim()
    ? query.marketplace.trim().toUpperCase()
    : null;
  const sourceTypes = new Set(query.sourceTypes ?? []);
  const limit = typeof query.limit === "number" ? Math.max(0, query.limit) : null;
  if (limit === 0) return [];
  const candidates = index
    .filter((entry) => (wanted ? wanted.has(entry.subjectKey) : true))
    .sort((left, right) => left.subjectKey.localeCompare(right.subjectKey));

  const projections: MarketScanProductFactProjection[] = [];
  for (const entry of candidates) {
    const record = await store.getSubject(entry.subjectKey);
    if (!record) continue;
    const evidence = pickVersion(
      record,
      query.evidenceVersions?.[entry.subjectKey],
      query.sourceRecordRefs?.[entry.subjectKey],
      query.evidenceBindings?.[entry.subjectKey],
    );
    // 版本不存在时保持缺失（fail-closed），不回落到其它版本。
    if (!evidence) continue;
    const productFact = adaptEvidenceToProductFact({ evidence });
    const sourceType = productFact.sourceProof.source;
    const evidenceMarketplace = evidence.pkg.marketplace.trim().toUpperCase();
    if (marketplace !== null && evidenceMarketplace !== marketplace) continue;
    if (sourceTypes.size > 0 && !sourceTypes.has(sourceType)) continue;
    projections.push({
      subjectKey: evidence.subjectKey,
      asin: asinFromSubjectKey(evidence.subjectKey),
      displayTitle: entry.displayTitle,
      marketplace: evidenceMarketplace || marketplaceFromSubjectKey(evidence.subjectKey) || "",
      sourceType,
      evidenceVersion: evidence.version,
      evidenceId: evidence.evidenceId,
      capturedAt: evidence.capturedAt,
      sourceProofHash: evidence.contentHash,
      validationVerdict: evidence.validation.verdict,
      productFact,
    });
    // limit 必须在 owner / version / marketplace / source / batch 过滤后生效。
    if (limit !== null && projections.length >= limit) break;
  }
  return projections;
}

/** 投影 → 指标引擎输入（只做字段搬运，不做任何推断）。 */
export function toMarketScanSampleInput(
  projections: readonly MarketScanProductFactProjection[],
): MarketScanSampleInputV1[] {
  return projections.map((projection) => ({
    subjectKey: projection.subjectKey,
    productFact: projection.productFact,
    factValues: marketFactValuesOf(projection.productFact),
    evidenceVersion: projection.evidenceVersion,
    evidenceId: projection.evidenceId,
    capturedAt: projection.capturedAt,
    candidateId: null,
    evidenceStatus: projection.validationVerdict === "passed" ? "sufficient_for_comparison" : projection.validationVerdict === "needs_review" ? "limited_evidence" : "blocked",
  }));
}

/**
 * 样本可用性判定：MarketScan 的样本身份是 ASIN。
 * 没有可用 ASIN 的证据不能被编组进样本（缺失就跳过并显式上报，绝不伪造身份）。
 */
export function isEligibleMarketScanProjection(
  projection: MarketScanProductFactProjection,
): boolean {
  return evaluateMarketSampleValidity({ asin: projection.asin, subjectKey: projection.subjectKey, marketplace: projection.marketplace,
    factValues: marketFactValuesOf(projection.productFact), evidenceId: projection.evidenceId, evidenceVersion: projection.evidenceVersion,
    sourceProofHash: projection.sourceProofHash, capturedAt: projection.capturedAt,
    integrityValid: projection.productFact.sourceProof.subjectKey === projection.subjectKey && projection.productFact.sourceProof.evidenceId === projection.evidenceId
      && projection.productFact.sourceProof.contentHash === projection.sourceProofHash,
    evidenceStatus: projection.validationVerdict === "passed" ? "sufficient_for_comparison" : projection.validationVerdict === "needs_review" ? "limited_evidence" : "blocked" }).valid;
}

/* ── 事实值快照（版本锁定的自证部分） ─────────────────────────────── */

function factValue<T>(field: FactField<T>): MarketFactValueV1<T> {
  if (field.status !== "present" || field.value === null || field.value === undefined) {
    return { presence: "missing" };
  }
  if (typeof field.value === "number" && !Number.isFinite(field.value)) {
    return { presence: "missing" };
  }
  if (typeof field.value === "string" && !field.value.trim()) {
    return { presence: "missing" };
  }
  return { presence: "present", value: field.value };
}

/**
 * 金额字段投影。
 *
 * 真实证据里存在 `{ amount: 0 }` 与 `{ currency: "USD" }`（金额键缺失）这类
 * 不完整金额结构：它们**不是**有效事实，`0` 也不能被当成「价格为 0」。
 * 这里 fail-closed 成 missing，绝不把非法结构写进快照的事实自证区。
 */
function moneyFactValue<T>(
  field: FactField<T>,
): MarketFactValueV1<T> {
  const value = field.value;
  if (field.status !== "present" || value === null || value === undefined) {
    return { presence: "missing" };
  }
  if (!isValidMarketMoneyValue(value)) {
    return { presence: "missing" };
  }
  return { presence: "present", value };
}

/**
 * 第三方估算字段的性质判定。
 *
 * 这里按**字段语义**硬编码，而不是按 `confidence` 推断：SellerSprite 的月销量 /
 * 月销售额永远是第三方估算，任何来源链路都不允许把它当作实测值。
 * 判定依据是既有适配器只在这两个字段上承载估算语义
 * （`ProductFactSource` 无法表达 metric nature，见 Phase 1 审计结论）。
 */
const PROVIDER_ESTIMATE_FIELDS = new Set(["monthlySalesEstimate", "monthlyRevenueEstimate"]);

function factField<T>(
  name: string,
  value: MarketFactValueV1<T>,
): MarketFactFieldV1<T> {
  const valueSource: MarketFactValueSourceV1 = PROVIDER_ESTIMATE_FIELDS.has(name)
    ? "PROVIDER_ESTIMATE"
    : "FACT";
  return { ...value, valueSource };
}

/**
 * 把 ProductFact 裁剪成指标真正消费的字段子集。
 * 只做投影：缺失保持缺失，不做单位换算、不补默认值、不派生。
 */
export function marketFactValuesOf(productFact: ProductFact): MarketFactValuesV1 {
  const asin = productFact.basic.asin.status === "present" && productFact.basic.asin.value
    ? productFact.basic.asin.value.trim().toUpperCase()
    : "";
  return {
    asin,
    title: factValue(productFact.basic.title),
    brand: factValue(productFact.basic.brand),
    category: factValue(productFact.basic.category),
    price: factField("price", moneyFactValue(productFact.basic.price)),
    rating: factValue(productFact.basic.rating),
    reviewCount: factValue(productFact.basic.reviewCount),
    bsr: factValue(productFact.market.bsr),
    monthlySalesEstimate: factField(
      "monthlySalesEstimate",
      factValue(productFact.market.monthlySalesEstimate),
    ),
    monthlyRevenueEstimate: factField(
      "monthlyRevenueEstimate",
      moneyFactValue(productFact.market.monthlyRevenueEstimate),
    ),
    launchedDate: factValue(productFact.market.launchedDate),
  };
}
