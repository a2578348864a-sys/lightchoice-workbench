/**
 * Product Development V1 — Phase 1：MarketScan 服务。
 *
 * 流程（唯一写操作是最后一步，且是单行写入，天然原子）：
 *
 * ```
 * Owner 校验
 *   → 读取【已经存在】的 Evidence（只读，不采集、不写证据）
 *   → adaptEvidenceToProductFact（既有纯函数）
 *   → 样本快照 + 事实版本锁定（重复 ASIN 冲突 fail-closed）
 *   → 计算确定性指标（纯函数）
 *   → 一次写入 MarketScan
 * ```
 *
 * 硬边界（本文件不得出现）：
 * 调用 AI / TypeSafe / Lark、创建 OpportunityCandidate、创建 Task、运行 Research、
 * 修改 Evidence、修改 ProductFact、修改 ProductBatch、发起任何外部请求。
 * MarketScan 是业务研究对象，不是来源类型：不得新增 `sourceType = market_scan`。
 */

import type { AccessContext } from "@/lib/server/accessPassword";
import { MIN_VALID_SAMPLE_COUNT, MARKET_SAMPLE_POLICY_VERSION, resolveValidMarketProductSet } from "@/lib/marketScan/marketSamplePolicy";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import { getProductBatchStore } from "@/lib/server/productBatchStoreResolver";
import { productBatchSourceTypeFromSnapshot } from "@/lib/productBatchContract";
import {
  MARKET_SCAN_OWNER_SCOPE,
  MarketScanContractError,
  buildNicheDefinitionV1,
  buildSampleDefinitionV1,
  type MarketScanContractErrorCode,
} from "@/lib/marketScan/contract";
import {
  MarketScanSampleError,
  buildSampleSnapshot,
  computeMarketMetricsV1,
  factValuesFingerprintOf,
  productFactFingerprintOf,
} from "@/lib/marketScan/metrics";
import {
  isEligibleMarketScanProjection,
  projectProductFactsFromEvidence,
  toMarketScanSampleInput,
  type MarketScanProductFactProjection,
  type MarketScanEvidenceBinding,
} from "@/lib/marketScan/productFactSource";
import {
  MARKET_METRICS_VERSION,
  MARKET_SCAN_SAMPLE_SCHEMA,
  type MarketScanMetricsInputV1,
  type MarketScanSampleInputV1,
  type MarketScanSampleSnapshotV1,
  type MarketScanSourceType,
  type NicheDefinitionKind,
} from "@/lib/marketScan/types";
import {
  createMarketScanRepository,
  type MarketScanRecordView,
  type MarketScanRepository,
} from "@/lib/server/marketScanRepository";

export const MARKET_SCAN_API_SCHEMA = "market-scan-api.v1" as const;

/** 单次扫描的服务端硬上限（与数据库 check 约束一致）。 */
export const MARKET_SCAN_MAX_SAMPLE_ITEMS = 500;
/** Phase 1 单次创建允许接受的样本上限（真实 SellerSprite 批次 50～100 条足够）。 */
export const MARKET_SCAN_CREATE_SAMPLE_LIMIT = 200;

type ProductBatchScope = {
  readonly evidenceStatuses: Readonly<Record<string, string>>;
  readonly subjectKeys: readonly string[];
  readonly sourceRecordRefs: Readonly<Record<string, string>>;
  readonly evidenceBindings: Readonly<Record<string, MarketScanEvidenceBinding>>;
};

export type MarketScanServiceErrorCode =
  | "market_scan_owner_only"
  | "market_scan_source_empty"
  | "market_scan_sample_too_large"
  | "market_scan_not_found"
  | "market_scan_invalid_request"
  | "market_scan_failed"
  | "market_sample_insufficient"
  | "market_sample_bypass_reason_required";

export class MarketScanServiceError extends Error {
  constructor(
    public readonly code: MarketScanServiceErrorCode,
    message: string,
    /** 由 API 层映射为 HTTP 状态码；服务层不做 HTTP 判断。 */
    public readonly httpStatus: number,
    /** 契约层的原始错误码（若有），便于前端区分冲突类型。 */
    public readonly detailCode?: MarketScanContractErrorCode | MarketScanSampleError["code"],
  ) {
    super(message);
    this.name = "MarketScanServiceError";
  }
}

export type CreateMarketScanInput = {
  readonly context: AccessContext;
  readonly scanName: string;
  readonly marketplace: string;
  readonly nicheKind: NicheDefinitionKind;
  readonly nicheLabel: string;
  readonly nicheNotes?: string | null;
  readonly nicheParameters?: Readonly<Record<string, string | number | boolean | null>> | null;
  /** 只接受证据库中已存在的 subjectKey；缺省代表该主体下全部已入库证据。 */
  readonly subjectKeys?: readonly string[] | null;
  /** 显式指定每个 subjectKey 的 Evidence 版本；缺省取最新版本。 */
  readonly evidenceVersions?: Readonly<Record<string, number>> | null;
  readonly sourceTypes?: readonly MarketScanSourceType[] | null;
  readonly productBatchId?: string | null;
  readonly requestedLimit?: number | null;
  /** 调用方记录的真实观测时刻（例如批次 importedAt）；缺失时会如实标注为未知。 */
  readonly observedAt?: string | null;
  readonly now?: Date;
  readonly insufficientSampleReason?: string | null;
};

/** Owner 边界：MarketScan 是 Owner 正式业务对象，访客不参与。 */
export function assertMarketScanOwner(context: AccessContext): void {
  if (context.mode !== "owner") {
    throw new MarketScanServiceError(
      "market_scan_owner_only",
      "市场扫描目前只对 Owner 开放。",
      403,
    );
  }
}

function operatorOf(context: AccessContext): string {
  return context.mode === "owner" ? MARKET_SCAN_OWNER_SCOPE : `visitor:${context.demoAccessId}`;
}

function assertIsoOrNull(value: string | null | undefined, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new MarketScanServiceError(
      "market_scan_invalid_request",
      `${label} 必须是合法的 ISO 时间。`,
      400,
    );
  }
  return new Date(value).toISOString();
}

function referenceDateOf(now: Date): string {
  if (Number.isNaN(now.getTime())) {
    throw new MarketScanServiceError("market_scan_invalid_request", "扫描时间不合法。", 400);
  }
  return now.toISOString();
}

/**
 * ProductBatch → Evidence 的只读 provenance resolver。
 *
 * ProductBatchItem.productKey 是批次持久化时的 authoritative subjectKey，
 * sourceRecordRef 是 ProductBatch → Evidence bridge 写入 Evidence 的 item id。
 * 两者同时限定，避免同一 ASIN 后续被其它批次/来源更新后污染历史批次扫描。
 */
async function resolveProductBatchScope(
  context: AccessContext,
  productBatchId: string,
  marketplace: string,
  requestedSubjectKeys?: readonly string[] | null,
): Promise<ProductBatchScope> {
  const store = getProductBatchStore(context);
  const batch = await store.getBatch(productBatchId);
  if (!batch || batch.batchStatus !== "ready" || batch.archivedAt != null) {
    throw new MarketScanServiceError(
      "market_scan_source_empty",
      "指定的 ProductBatch 不存在或尚未 ready，无法建立可信样本范围。",
      422,
    );
  }
  if (batch.marketplace.trim().toUpperCase() !== marketplace) {
    throw new MarketScanServiceError(
      "market_scan_invalid_request",
      "ProductBatch 的 marketplace 与扫描 marketplace 不一致。",
      422,
    );
  }

  const allItems = await store.getBatchItems(batch.id);
  const requested = requestedSubjectKeys && requestedSubjectKeys.length > 0
    ? new Set(requestedSubjectKeys)
    : null;
  const validSet = resolveValidMarketProductSet({ items: allItems.map((item) => ({ ...item, archivedAt: item.archivedAt ? new Date(item.archivedAt) : null })), batchMarketplace: marketplace });
  const validIds = new Set(validSet.validItemIds);
  const items = allItems.filter((item) => validIds.has(item.id) && (!requested || requested.has(item.productKey)));
  const subjectKeys: string[] = [];
  const sourceRecordRefs: Record<string, string> = {};
  const evidenceStatuses: Record<string, string> = {};
  const evidenceBindings: Record<string, MarketScanEvidenceBinding> = {};
  const batchSourceType = productBatchSourceTypeFromSnapshot(batch.normalizedSnapshotJson);
  // 版本族接受集合：additive 扩展不升版本号，但历史数据集里已存在 v2 记录
  //（amazon-search-product-reference.v2 = v1 + image/imageUrl/imageAvailability）。
  // 只按「版本族」校验，避免对已有 v2 批次建立市场研究时误判 422。
  const referenceSchemaFamily = batchSourceType === "amazon_search_capture"
    ? new Set(["amazon-search-product-reference.v1", "amazon-search-product-reference.v2"])
    : batchSourceType === "evidence_store_reference" ? new Set(["evidence-store-product-reference.v1"]) : null;
  for (const item of items) {
    const subjectKey = typeof item.productKey === "string" ? item.productKey.trim() : "";
    const sourceRecordRef = typeof item.id === "string" ? item.id.trim() : "";
    if (!subjectKey || !sourceRecordRef) {
      throw new MarketScanServiceError(
        "market_scan_source_empty",
        "ProductBatchItem 缺少 authoritative subjectKey 或 item id，已拒绝编组。",
        422,
      );
    }
    if (sourceRecordRefs[subjectKey] !== undefined || evidenceBindings[subjectKey] !== undefined) {
      throw new MarketScanServiceError(
        "market_scan_source_empty",
        "ProductBatch 内存在重复 subjectKey，无法建立确定的 Evidence provenance。",
        422,
      );
    }
    subjectKeys.push(subjectKey);
    evidenceStatuses[subjectKey] = item.evidenceStatus;
    if (referenceSchemaFamily) {
      let reference: Record<string, unknown>;
      try { reference = JSON.parse(item.normalizedProductJson) as Record<string, unknown>; }
      catch { throw new MarketScanServiceError("market_scan_source_empty", "商品条目的证据引用已损坏，请重新核验来源。", 422); }
      if (!reference || !referenceSchemaFamily.has(String(reference.schemaVersion)) || reference.subjectKey !== subjectKey
        || !Number.isSafeInteger(reference.evidenceVersion) || (reference.evidenceVersion as number) < 1
        || typeof reference.evidenceId !== "string" || !reference.evidenceId.startsWith("ev-")
        || typeof reference.contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(reference.contentHash)
        || reference.contentHash !== item.evidenceHash) {
        throw new MarketScanServiceError("market_scan_source_empty", "商品条目的证据版本绑定不完整，已拒绝创建市场扫描。", 422);
      }
      evidenceBindings[subjectKey] = { evidenceVersion: reference.evidenceVersion as number,
        evidenceId: reference.evidenceId, contentHash: reference.contentHash };
    } else {
      sourceRecordRefs[subjectKey] = sourceRecordRef;
    }
  }
  if (subjectKeys.length === 0) {
    throw new MarketScanServiceError(
      "market_scan_source_empty",
      "指定的 ProductBatch 没有可用于扫描的商品条目。",
      422,
    );
  }
  return { subjectKeys, sourceRecordRefs, evidenceBindings, evidenceStatuses };
}

/**
 * 事实自证：快照里冻结的 `productFactFingerprint` 必须等于「从当时的 ProductFact
 * 重算出来的指纹」。不相等说明样本快照与事实层脱节，必须 fail-closed。
 */
function assertSnapshotFingerprintsMatch(
  snapshot: MarketScanSampleSnapshotV1,
  projections: readonly MarketScanProductFactProjection[],
): void {
  const bySubjectKey = new Map(
    projections.map((projection) => [projection.subjectKey, projection]),
  );
  for (const item of snapshot.items) {
    const projection = bySubjectKey.get(item.subjectKey);
    if (!projection) {
      throw new MarketScanServiceError(
        "market_scan_failed",
        `样本 ${item.asin} 缺少对应的 ProductFact 投影，无法证明事实版本。`,
        500,
      );
    }
    /** 编组时该 ProductFact 的内容指纹（由 ProductFact 计算，用于绑定事实版本）。 */
    const recomputedFingerprint = productFactFingerprintOf({
      subjectKey: item.subjectKey,
      productFact: projection.productFact,
    });
    if (!recomputedFingerprint) {
      throw new MarketScanServiceError(
        "market_scan_failed",
        `样本 ${item.asin} 的事实指纹无法计算。`,
        500,
      );
    }
    // 冻结的事实值必须与快照里的自证指纹一致（重算即为校验）。
    if (item.factValuesFingerprint !== factValuesFingerprintOf({
      subjectKey: item.subjectKey,
      factValues: item.factValues,
    })) {
      throw new MarketScanServiceError(
        "market_scan_failed",
        `样本 ${item.asin} 的事实值指纹与快照不一致。`,
        500,
      );
    }
    // 编组时的 ProductFact 指纹必须与快照记录一致，否则样本已与事实层脱节。
    if (item.productFactFingerprint !== recomputedFingerprint) {
      throw new MarketScanServiceError(
        "market_scan_failed",
        `样本 ${item.asin} 的 ProductFact 指纹与快照不一致。`,
        500,
      );
    }
  }
}

/**
 * 由**已冻结的样本快照**重建指标输入。
 *
 * 事实值直接取快照里的 `factValues`（版本锁定的自证部分）；
 * `productFact` 仅作为事实层引用一并带入，缺失时交给引擎 fail-closed，
 * 绝不在这里补一个看起来合法的事实。
 */
function metricsInputFromSnapshot(
  snapshot: MarketScanSampleSnapshotV1,
  factsBySubjectKey: ReadonlyMap<string, ProductFact>,
): MarketScanSampleInputV1[] {
  return snapshot.items.map((item) => ({
    subjectKey: item.subjectKey,
    productFact: factsBySubjectKey.get(item.subjectKey) ?? ({} as ProductFact),
    factValues: item.factValues,
    evidenceVersion: item.evidenceVersion,
    evidenceId: item.evidenceId,
    capturedAt: item.capturedAt,
    candidateId: item.candidateId,
    evidenceStatus: item.evidenceStatus,
  }));
}

export type PreparedMarketScanSample = {
  readonly marketplace: string;
  readonly referenceDate: string;
  readonly nicheDefinition: ReturnType<typeof buildNicheDefinitionV1>;
  readonly sampleDefinition: ReturnType<typeof buildSampleDefinitionV1>;
  readonly sampleSnapshot: MarketScanSampleSnapshotV1;
  readonly metrics: ReturnType<typeof computeMarketMetricsV1>;
  readonly skippedWithoutAsin: number;
  readonly productBatchScope: ProductBatchScope | null;
  readonly projections: readonly MarketScanProductFactProjection[];
  readonly eligible: readonly MarketScanProductFactProjection[];
};

/**
 * 只读准备阶段：执行到「样本快照 + 指标已计算」为止，不写库。
 * 创建（createMarketScan）与创建前预检（preview）必须共用本函数，
 * 保证「预检展示的最终可冻结样本数」与「实际创建时的权威口径」完全一致（D0-004）。
 */
export async function prepareMarketScanSample(input: CreateMarketScanInput): Promise<PreparedMarketScanSample> {
  assertMarketScanOwner(input.context);
  const operator = operatorOf(input.context);
  const now = input.now ?? new Date();
  const referenceDate = referenceDateOf(now);
  const observedAt = assertIsoOrNull(input.observedAt ?? null, "observedAt");
  const marketplace = input.marketplace.trim().toUpperCase() || "US";

  const requestedLimit = input.requestedLimit ?? MARKET_SCAN_CREATE_SAMPLE_LIMIT;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1
    || requestedLimit > MARKET_SCAN_MAX_SAMPLE_ITEMS) {
    throw new MarketScanServiceError(
      "market_scan_invalid_request",
      `样本上限必须是 1 到 ${MARKET_SCAN_MAX_SAMPLE_ITEMS} 之间的整数。`,
      400,
    );
  }
  if (input.subjectKeys && input.subjectKeys.length > MARKET_SCAN_MAX_SAMPLE_ITEMS) {
    throw new MarketScanServiceError(
      "market_scan_sample_too_large",
      `一次扫描最多 ${MARKET_SCAN_MAX_SAMPLE_ITEMS} 个样本。`,
      422,
    );
  }

  const productBatchScope = input.productBatchId
    ? await resolveProductBatchScope(input.context, input.productBatchId, marketplace, input.subjectKeys)
    : null;
  if (productBatchScope && input.subjectKeys) {
    const allowed = new Set(productBatchScope.subjectKeys);
    if (input.subjectKeys.some((subjectKey) => !allowed.has(subjectKey))) {
      throw new MarketScanServiceError(
        "market_scan_invalid_request",
        "subjectKeys 超出指定 ProductBatch 的 authoritative 范围。",
        422,
      );
    }
  }
  const scopedSubjectKeys = productBatchScope?.subjectKeys ?? input.subjectKeys ?? null;
  if (productBatchScope && input.evidenceVersions && Object.entries(productBatchScope.evidenceBindings)
    .some(([subjectKey, binding]) => input.evidenceVersions?.[subjectKey] !== undefined
      && input.evidenceVersions[subjectKey] !== binding.evidenceVersion)) {
    throw new MarketScanServiceError("market_scan_invalid_request", "请求的证据版本与来源批次锁定版本不一致。", 422);
  }
  const projections = await projectProductFactsFromEvidence({
    operator,
    ...(scopedSubjectKeys && scopedSubjectKeys.length > 0
      ? { subjectKeys: scopedSubjectKeys }
      : {}),
    ...(input.evidenceVersions ? { evidenceVersions: input.evidenceVersions } : {}),
    marketplace,
    ...(input.sourceTypes ? { sourceTypes: input.sourceTypes } : {}),
    ...(productBatchScope ? { sourceRecordRefs: productBatchScope.sourceRecordRefs,
      evidenceBindings: productBatchScope.evidenceBindings } : {}),
    limit: requestedLimit,
  });
  if (productBatchScope && Object.keys(productBatchScope.evidenceBindings).length > 0
    && projections.length !== Math.min(requestedLimit, productBatchScope.subjectKeys.length)) {
    throw new MarketScanServiceError("market_scan_source_empty", "来源批次引用的证据版本缺失或哈希不匹配，已拒绝回退到其它版本。", 422);
  }
  // 没有可用 ASIN 的证据无法成为样本：显式跳过并计数，绝不伪造身份。
  const eligible = projections.filter(isEligibleMarketScanProjection);
  const skippedWithoutAsin = projections.length - eligible.length;
  if (eligible.length === 0) {
    throw new MarketScanServiceError(
      "market_scan_source_empty",
      projections.length === 0
        ? "当前没有可用于扫描的来源证据。请先在「来源」页把商品批次接入来源证据，再创建市场扫描。"
        : "已入库的来源证据都没有可用 ASIN，无法组成市场扫描样本。",
      422,
    );
  }

  const nicheDefinition = buildNicheDefinitionV1({
    kind: input.nicheKind,
    label: input.nicheLabel,
    notes: input.nicheNotes ?? null,
    parameters: input.nicheParameters ?? {},
  });
  const sourceTypes = input.sourceTypes && input.sourceTypes.length > 0
    ? [...new Set(input.sourceTypes)]
    : [...new Set(eligible.map((projection) => projection.sourceType))];
  const sampleDefinition = buildSampleDefinitionV1({
    origin: input.productBatchId ? "existing_product_batch_evidence" : "existing_evidence",
    marketplace,
    sourceTypes,
    productBatchId: input.productBatchId ?? null,
    requestedLimit,
  });

  let sampleSnapshot: MarketScanSampleSnapshotV1;
  let metrics: ReturnType<typeof computeMarketMetricsV1>;
  try {
    // 先编组，再对**去重后的快照成员**计算指标：
    // 保证 metrics.sampleCount 与快照 itemCount 永远描述同一批样本。
    const factsBySubjectKey = new Map(
      eligible.map((projection) => [projection.subjectKey, projection.productFact]),
    );
    sampleSnapshot = buildSampleSnapshot({
      nicheDefinition,
      sampleDefinition,
      sample: toMarketScanSampleInput(eligible).map((entry) => ({ ...entry, evidenceStatus: productBatchScope?.evidenceStatuses[entry.subjectKey] ?? entry.evidenceStatus })),
      metricsVersion: MARKET_METRICS_VERSION,
    });
    // 事实自证：快照里冻结的 fingerprint 必须真的描述当时的 ProductFact。
    // 否则「事实版本锁定」只是自封的标签，无法证明扫描当时用的是什么。
    assertSnapshotFingerprintsMatch(sampleSnapshot, eligible);
    const metricsInput: MarketScanMetricsInputV1 = {
      sample: metricsInputFromSnapshot(sampleSnapshot, factsBySubjectKey),
      referenceDate,
      metricsVersion: MARKET_METRICS_VERSION,
      sampleHash: sampleSnapshot.sampleHash,
      marketplace,
      observedAt,
      extraNotes: [
        `sample origin: ${sampleDefinition.origin}`,
        `source types: ${sourceTypes.length > 0 ? sourceTypes.join(", ") : "unknown"}`,
        ...(skippedWithoutAsin > 0
          ? [`skipped ${skippedWithoutAsin} evidence record(s) without a usable ASIN`]
          : []),
      ],
    };
    metrics = computeMarketMetricsV1(metricsInput);
  } catch (error) {
    if (error instanceof MarketScanSampleError) {
      // 同 ASIN 不同 fingerprint：fail-closed，绝不静默选一个版本。
      throw new MarketScanServiceError(
        error.code === "sample_asin_conflict" || error.code === "sample_subject_conflict"
          ? "market_scan_invalid_request"
          : "market_scan_source_empty",
        error.message,
        error.code === "sample_asin_conflict" || error.code === "sample_subject_conflict" ? 409 : 422,
        error.code,
      );
    }
    if (error instanceof MarketScanContractError) {
      throw new MarketScanServiceError("market_scan_failed", error.message, 500, error.code);
    }
    throw error;
  }

  return {
    marketplace,
    referenceDate,
    nicheDefinition,
    sampleDefinition,
    sampleSnapshot,
    metrics,
    skippedWithoutAsin,
    productBatchScope,
    projections,
    eligible,
  };
}

/**
 * 创建 MarketScan。
 *
 * 幂等性说明：同一输入重复创建会产生两条 MarketScan 记录（ID 不同），
 * 但 `sampleHash` 与 `metricsJson` 完全相同——这是刻意的：
 * MarketScan ID 可以不同，可重算的 hash 必须相同。
 */
export async function createMarketScan(
  input: CreateMarketScanInput,
  repository: MarketScanRepository = createMarketScanRepository(),
): Promise<MarketScanRecordView> {
  const prepared = await prepareMarketScanSample(input);
  const { metrics, referenceDate, sampleDefinition, nicheDefinition, sampleSnapshot, marketplace } = prepared;

  const insufficient = metrics.validSampleCount < MIN_VALID_SAMPLE_COUNT;
  const bypassEnabled = process.env.V5_MARKET_ALLOW_INSUFFICIENT_SAMPLE === "true";
  const bypassReason = input.insufficientSampleReason?.trim() ?? "";
  if (insufficient && !bypassEnabled) throw new MarketScanServiceError("market_sample_insufficient", `当前只有 ${metrics.validSampleCount} 个有效商品，至少需要 ${MIN_VALID_SAMPLE_COUNT} 个；请补充 ${MIN_VALID_SAMPLE_COUNT - metrics.validSampleCount} 个有效商品。`, 409);
  if (insufficient && (!bypassReason || bypassReason.length > 1000)) throw new MarketScanServiceError("market_sample_bypass_reason_required", "隔离验证旁路必须记录 1～1000 字符的理由。", 422);
  const auditedSampleDefinition = { ...sampleDefinition, marketSamplePolicyVersion: MARKET_SAMPLE_POLICY_VERSION,
    ...(insufficient ? { insufficientSampleBypass: { enabledByEnvironment: true as const, reason: bypassReason, recordedAt: referenceDate, validSampleCount: metrics.validSampleCount } } : {}) };

  // 唯一写操作：单行 insert，失败则整体不落库（不存在半写记录）。
  return repository.create({
    scanName: input.scanName,
    marketplace,
    nicheKind: nicheDefinition.kind,
    nicheDefinition,
    sampleDefinition: auditedSampleDefinition,
    sampleSnapshot,
    metrics,
  });
}

export async function getMarketScan(
  input: { readonly context: AccessContext; readonly id: string },
  repository: MarketScanRepository = createMarketScanRepository(),
): Promise<MarketScanRecordView | null> {
  assertMarketScanOwner(input.context);
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/u.test(id)) {
    throw new MarketScanServiceError("market_scan_invalid_request", "扫描 ID 不合法。", 400);
  }
  const record = await repository.getById(id);
  if (!record) {
    throw new MarketScanServiceError("market_scan_not_found", "没有找到该市场扫描。", 404);
  }
  return record;
}

export async function listMarketScans(
  input: { readonly context: AccessContext; readonly limit?: number | null },
  repository: MarketScanRepository = createMarketScanRepository(),
): Promise<MarketScanRecordView[]> {
  assertMarketScanOwner(input.context);
  return repository.list(input.limit ? { limit: input.limit } : {});
}

export { MARKET_SCAN_SAMPLE_SCHEMA };
