import "server-only";

import type { AccessContext } from "@/lib/server/accessPassword";
import type { ProductBatchItemInput, ProductBatchItemView, ProductBatchStore, ProductBatchView } from "@/lib/productBatchStore";
import { PRODUCT_BATCH_MAX_ITEMS } from "@/lib/productBatchContract";
import { HARD_MAX_AUTHORIZED_ITEMS } from "@/lib/sourceLayer/captureBudgetConstants";
import { AMAZON_SEARCH_DETAIL_ENRICHMENT_INTENT_VERSION } from "@/lib/server/batchDetailEnrichmentJob";
import { getProductBatchStore } from "@/lib/server/productBatchStoreResolver";
import { hashJson } from "@/lib/server/v5CoreCommon";
import { adaptEvidenceToProductFact } from "@/lib/sourceLayer/fact/productFactAdapter";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import { createEvidenceStore, type EvidenceSubjectRecord } from "@/lib/sourceLayer/server/evidenceStore";
import type { CaptureGatewayResult } from "@/lib/sourceLayer/server/captureGateway";
import type { CaptureEvidenceRecord } from "@/lib/sourceLayer/sourceAdapter";
import { sourceLayerOperator } from "@/lib/sourceLayer/server/sourceLayerService";
import type { AmazonSearchCapturePlan } from "@/tools/collectors/recipes/amazon";
import { recordCaptureApiDiagnostic } from "@/lib/sourceLayer/server/diagnosticService";
import {
  createProductBatchRepository,
  type ProductBatchItemRecord,
  type ProductBatchRecord,
} from "@/lib/server/productBatchRepository";

const SEARCH_BATCH_DISCLAIMER_VERSION = "amazon-search-capture-reference.v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ASIN_PATTERN = /^[A-Z0-9]{10}$/u;

type ResolvedCapture = {
  evidence: CaptureEvidenceRecord;
  fact: ProductFact;
  productKey: string;
  asin: string;
  title: string;
};

export type VerifiedSearchEvidence = {
  asin: string;
  evidenceId: string;
  evidenceVersion: number;
  contentHash: string;
};

export type AmazonSearchEvidenceCheckpointRef = {
  subjectKey: string;
  captureId: string;
  evidenceId: string;
  evidenceVersion: number;
  contentHash: string;
};

export type AmazonSearchProductBatchHandoffResult = {
  created: boolean;
  batchId: string | null;
  batchStatus: ProductBatchView["batchStatus"] | "not_created";
  itemCount: number;
  quarantinedCount: number;
  duplicateProductCount: number;
  rejectedProductFactCount: number;
};

export class AmazonSearchProductBatchHandoffError extends Error {
  constructor(message = "Amazon Search capture completed, but ProductBatch persistence failed.") {
    super(message);
    this.name = "AmazonSearchProductBatchHandoffError";
  }
}

export function isBoundSearchIdentity(fact: ProductFact, evidence: CaptureEvidenceRecord): boolean {
  const asin = fact.basic.asin.value?.trim().toUpperCase();
  const title = fact.basic.title.value?.trim();
  const proof = fact.sourceProof;
  const binding = proof.entityBinding;
  const subjectAsin = /^amazon:US:([A-Z0-9]{10})$/u.exec(evidence.subjectKey)?.[1] ?? null;

  return evidence.sourceType === "amazon_dom"
    && evidence.pkg.marketplace === "US"
    && proof.source === "amazon_dom"
    && proof.subjectKey === evidence.subjectKey
    && proof.captureId === evidence.captureId
    && proof.evidenceId === evidence.evidenceId
    && proof.capturedAt === evidence.capturedAt
    && proof.contentHash === evidence.contentHash
    && SHA256_PATTERN.test(evidence.contentHash)
    && asin !== undefined
    && ASIN_PATTERN.test(asin)
    && subjectAsin === asin
    && typeof title === "string"
    && title.length >= 2
    && binding?.bound === true
    && binding.expectedAsin === asin
    && binding.observedAsin === asin
    && binding.urlAsin === asin
    && binding.expectedMarketplace === "US"
    && binding.observedMarketplace === "US"
    && binding.urlMarketplace === "US";
}

async function resolvePersistedCapture(input: {
  capture: CaptureGatewayResult;
  fact: ProductFact;
  subjectRecord: (subjectKey: string) => Promise<EvidenceSubjectRecord | null>;
}): Promise<ResolvedCapture | null> {
  const proof = input.fact.sourceProof;
  const capturedItem = input.capture.capture.items.find((item) => (
    item.subjectKey === proof.subjectKey
    && item.captureId === proof.captureId
    && item.contentHash === proof.contentHash
  ));
  if (!capturedItem || !Number.isSafeInteger(capturedItem.version) || capturedItem.version < 1) return null;

  const subject = await input.subjectRecord(proof.subjectKey);
  if (!subject || subject.subjectKey !== proof.subjectKey) return null;
  const evidence = subject.versions.find((version) => (
    version.version === capturedItem.version
    && version.evidenceId === proof.evidenceId
    && version.captureId === proof.captureId
    && version.contentHash === proof.contentHash
  ));
  if (!evidence) return null;

  const fact = adaptEvidenceToProductFact({ evidence });
  if (!isBoundSearchIdentity(fact, evidence)) return null;
  const asin = fact.basic.asin.value!.trim().toUpperCase();
  const title = fact.basic.title.value!.trim();

  return {
    evidence,
    fact,
    productKey: `amazon:US:${asin}`,
    asin,
    title,
  };
}

async function resolveBatchItemEvidence(input: {
  item: ProductBatchItemView | ProductBatchItemRecord;
  subjectRecord: (subjectKey: string) => Promise<EvidenceSubjectRecord | null>;
}): Promise<ResolvedCapture | null> {
  if (!input.item.asin) return null;
  let reference: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(input.item.normalizedProductJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    reference = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const asin = input.item.asin.trim().toUpperCase();
  const subjectKey = reference.subjectKey;
  const captureId = reference.captureId;
  const evidenceId = reference.evidenceId;
  const evidenceVersion = reference.evidenceVersion;
  const contentHash = reference.contentHash;
  if (reference.asin !== asin || subjectKey !== `amazon:US:${asin}`
    || typeof captureId !== "string" || !captureId.trim()
    || typeof evidenceId !== "string" || !evidenceId.trim()
    || typeof evidenceVersion !== "number" || !Number.isSafeInteger(evidenceVersion) || evidenceVersion < 1
    || typeof contentHash !== "string" || !SHA256_PATTERN.test(contentHash)
    || input.item.evidenceHash !== contentHash) return null;
  const subject = await input.subjectRecord(subjectKey);
  if (!subject || subject.subjectKey !== subjectKey || subject.integrityIssues?.length) return null;
  const evidence = subject.versions.find((version) => (
    version.version === evidenceVersion
    && version.evidenceId === evidenceId
    && version.captureId === captureId
    && version.contentHash === contentHash
  ));
  if (!evidence) return null;
  const fact = adaptEvidenceToProductFact({ evidence });
  if (!isBoundSearchIdentity(fact, evidence)) return null;
  return {
    evidence,
    fact,
    productKey: `amazon:US:${asin}`,
    asin,
    title: fact.basic.title.value!.trim(),
  };
}

/** 只读核验当前批次商品条目的来源 Evidence；不修改 EvidenceStore 或 ProductBatch。 */
export async function readVerifiedAmazonSearchEvidence(input: {
  context: AccessContext;
  items: readonly (ProductBatchItemView | ProductBatchItemRecord)[];
}): Promise<VerifiedSearchEvidence[]> {
  const evidenceStore = createEvidenceStore(sourceLayerOperator(input.context));
  const seen = new Set<string>();
  const references: VerifiedSearchEvidence[] = [];
  for (const item of input.items) {
    if (item.archivedAt || !item.asin) continue;
    const asin = item.asin.trim().toUpperCase();
    if (seen.has(asin)) continue;
    seen.add(asin);
    const resolved = await resolveBatchItemEvidence({ item, subjectRecord: (key) => evidenceStore.getSubject(key) });
    if (!resolved) continue;
    references.push({
      asin,
      evidenceId: resolved.evidence.evidenceId,
      evidenceVersion: resolved.evidence.version,
      contentHash: resolved.evidence.contentHash,
    });
  }
  return references;
}

function toBatchItem(input: {
  batchId: string;
  resolved: ResolvedCapture;
  ordinal: number;
}): ProductBatchItemInput {
  const { evidence, fact, productKey, asin, title } = input.resolved;
  // 图片来源诚实性：只能取证据包内已持久化的原始图片 URL（经 ProductFact 投影），
  // 禁止按 ASIN 拼接 CDN 地址，也禁止用第三方图或以假数据顶替。
  // 无图时显式写 AUTHORITATIVE_IMAGE_MISSING，由展示层统一显示占位。
  const image = fact.basic.image.value ?? null;
  // 纯 additive 扩展：保持 schemaVersion 不变（沿用 v1），消费端无需按版本分支。
  const reference = {
    schemaVersion: "amazon-search-product-reference.v1",
    marketplace: "US",
    asin,
    title,
    image,
    imageUrl: image,
    imageAvailability: image ? "AUTHORITATIVE_IMAGE_AVAILABLE" : "AUTHORITATIVE_IMAGE_MISSING",
    brand: fact.basic.brand.value ?? null,
    category: fact.basic.category.value ?? null,
    bsr: fact.market.bsr.value !== null
      ? { rank: fact.market.bsr.value, category: fact.basic.category.value ?? null }
      : null,
    subjectKey: evidence.subjectKey,
    captureId: evidence.captureId,
    evidenceId: evidence.evidenceId,
    evidenceVersion: evidence.version,
    contentHash: evidence.contentHash,
    capturedAt: evidence.capturedAt,
    sourceUrl: evidence.sourceUrl,
    comparisonFacts: {
      price: { ...fact.basic.price, status: evidence.pkg.fieldStates.price.status },
      rating: { ...fact.basic.rating, status: evidence.pkg.fieldStates.rating.status },
      reviewCount: { ...fact.basic.reviewCount, status: evidence.pkg.fieldStates.reviewCount.status },
    },
    productBatchId: input.batchId,
  };
  const parentAsin = fact.extended?.parentAsin.value ?? null;

  return {
    productKey,
    asin,
    parentAsin,
    ordinal: input.ordinal,
    itemIdentityHash: hashJson({ schemaVersion: "amazon-search-batch-item-identity.v1", productKey }),
    itemHash: hashJson({ schemaVersion: "amazon-search-product-reference.v1", reference }),
    evidenceHash: evidence.contentHash,
    normalizedProductJson: JSON.stringify(reference),
    occurrenceProjectionJson: JSON.stringify({
      schemaVersion: "amazon-search-capture-occurrence.v1",
      subjectKey: evidence.subjectKey,
      captureId: evidence.captureId,
      sourceUrl: evidence.sourceUrl,
    }),
    familyProjectionJson: JSON.stringify({
      schemaVersion: "amazon-search-capture-family.v1",
      subjectKey: evidence.subjectKey,
    }),
    rankingJson: JSON.stringify({
      schemaVersion: "amazon-search-capture-ranking.v1",
      source: "amazon_search_capture",
      ranked: false,
    }),
    provisionalDisposition: "insufficient_required_signals",
    researchPriority: "unranked_insufficient_evidence",
    evidenceStatus: "limited_evidence",
    promotionEligible: false,
    imageSnapshotJson: JSON.stringify({ status: "not_cached" }),
  };
}

export async function createAmazonSearchProductBatch(input: {
  context: AccessContext;
  query: string;
  traceId: string;
  plan: AmazonSearchCapturePlan | null;
  captures?: readonly CaptureGatewayResult[];
  /** Gateway references recovered from the persisted operation checkpoint; no source re-navigation is needed. */
  persistedEvidenceReferences?: readonly AmazonSearchEvidenceCheckpointRef[];
  /**
   * 搜索阶段真实发生的导航次数（每页一次）。持久化到批次质量摘要，
   * 作为后续 BatchCaptureRun 继承共享导航预算的**可信回执**；
   * 缺失时下游必须阻断，不得默认 0。
   */
  searchNavigationUsed?: number;
  now?: Date;
  /** Isolated verification can inject a temporary ProductBatchStore; production resolves the Owner store. */
  store?: ProductBatchStore;
}): Promise<AmazonSearchProductBatchHandoffResult> {
  const evidenceStore = createEvidenceStore(sourceLayerOperator(input.context));
  const resolvedByProductKey = new Map<string, ResolvedCapture>();
  const rejectionCounts: Record<string, number> = {};
  let productFactCount = 0;

  for (const capture of input.captures ?? []) {
    if (capture.source !== "amazon_dom") continue;
    for (const fact of capture.productFacts) {
      productFactCount += 1;
      const resolved = await resolvePersistedCapture({
        capture,
        fact,
        subjectRecord: (subjectKey) => evidenceStore.getSubject(subjectKey),
      });
      if (!resolved) {
        rejectionCounts.persisted_product_identity_unavailable = (rejectionCounts.persisted_product_identity_unavailable ?? 0) + 1;
        continue;
      }
      if (resolvedByProductKey.has(resolved.productKey)) {
        rejectionCounts.duplicate_product_identity = (rejectionCounts.duplicate_product_identity ?? 0) + 1;
      }
      // ProductBatchItem is unique by productKey; keep the latest persisted
      // Evidence version encountered in this Search capture, not a duplicate row.
      resolvedByProductKey.set(resolved.productKey, resolved);
    }
  }

  for (const reference of input.persistedEvidenceReferences ?? []) {
    productFactCount += 1;
    const asin = /^amazon:US:([A-Z0-9]{10})$/u.exec(reference.subjectKey)?.[1] ?? null;
    if (!asin || !SHA256_PATTERN.test(reference.contentHash)
      || !Number.isSafeInteger(reference.evidenceVersion) || reference.evidenceVersion < 1) {
      rejectionCounts.persisted_product_identity_unavailable = (rejectionCounts.persisted_product_identity_unavailable ?? 0) + 1;
      continue;
    }
    const subject = await evidenceStore.getSubject(reference.subjectKey);
    const evidence = subject?.versions.find((version) => (
      version.version === reference.evidenceVersion
      && version.evidenceId === reference.evidenceId
      && version.captureId === reference.captureId
      && version.contentHash === reference.contentHash
    ));
    if (!evidence || subject?.integrityIssues?.length) {
      rejectionCounts.persisted_product_identity_unavailable = (rejectionCounts.persisted_product_identity_unavailable ?? 0) + 1;
      continue;
    }
    const fact = adaptEvidenceToProductFact({ evidence });
    if (!isBoundSearchIdentity(fact, evidence)) {
      rejectionCounts.persisted_product_identity_unavailable = (rejectionCounts.persisted_product_identity_unavailable ?? 0) + 1;
      continue;
    }
    const resolved: ResolvedCapture = {
      evidence,
      fact,
      productKey: `amazon:US:${asin}`,
      asin,
      title: fact.basic.title.value!.trim(),
    };
    if (resolvedByProductKey.has(resolved.productKey)) {
      rejectionCounts.duplicate_product_identity = (rejectionCounts.duplicate_product_identity ?? 0) + 1;
    }
    resolvedByProductKey.set(resolved.productKey, resolved);
  }

  const resolvedItems = [...resolvedByProductKey.values()];
  const gatewayEvidenceCount = input.persistedEvidenceReferences?.length
    ?? (input.captures ?? []).reduce((sum, capture) => sum + capture.capture.items.length, 0);
  const totalObservationCount = Math.max(
    input.plan?.totalObservationCount ?? 0,
    gatewayEvidenceCount,
    resolvedItems.length,
  );
  if (!Number.isSafeInteger(totalObservationCount) || totalObservationCount > PRODUCT_BATCH_MAX_ITEMS) {
    throw new AmazonSearchProductBatchHandoffError("Amazon Search total observation budget exceeds 500.");
  }
  const quarantinedCount = totalObservationCount - resolvedItems.length;
  const duplicateProductCount = rejectionCounts.duplicate_product_identity ?? 0;
  const rejectedProductFactCount = Math.max(0, productFactCount - resolvedItems.length - duplicateProductCount);

  if (resolvedItems.length === 0) {
    return {
      created: false,
      batchId: null,
      batchStatus: "not_created",
      itemCount: 0,
      quarantinedCount,
      duplicateProductCount,
      rejectedProductFactCount,
    };
  }

  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new AmazonSearchProductBatchHandoffError("Amazon Search batch time is invalid.");
  const query = input.query.trim();
  const evidenceReferences = resolvedItems.map(({ evidence }) => ({
    subjectKey: evidence.subjectKey,
    captureId: evidence.captureId,
    evidenceId: evidence.evidenceId,
    evidenceVersion: evidence.version,
    contentHash: evidence.contentHash,
  })).sort((a, b) => a.subjectKey.localeCompare(b.subjectKey));
  const briefHash = hashJson({ schemaVersion: "amazon-search-capture-brief.v1", query, marketplace: "US" });
  const sourceFileSha256 = hashJson({
    schemaVersion: "amazon-search-capture-manifest.v1",
    evidenceReferences,
  });
  const qualitySummary = {
    schemaVersion: "amazon-search-capture-batch-quality.v1",
    traceId: input.traceId,
    observationCount: totalObservationCount,
    gatewayEvidenceCount,
    productFactProjectionCount: productFactCount,
    acceptedProductCount: resolvedItems.length,
    quarantinedObservationCount: quarantinedCount,
    duplicateProductCount,
    rejectedProductFactCount,
    rejectionCounts,
    // 搜索阶段导航回执：后续 BatchCaptureRun 用它把已发生的搜索导航计入同一共享预算。
    ...(typeof input.searchNavigationUsed === "number"
      && Number.isSafeInteger(input.searchNavigationUsed) && input.searchNavigationUsed >= 1
      ? { searchNavigationUsed: input.searchNavigationUsed }
      : {}),
  };
  const normalizedSnapshot = {
    schemaVersion: "amazon-search-capture-snapshot.v1",
    sourceType: "amazon_search_capture",
    traceId: input.traceId,
    /**
     * 采集计划待确认（DISABLED）：搜索只负责保存证据与建立批次，
     * **不再**埋下「自动入队详情补齐」的意图。
     *
     * 变更原因（P0）：autoEnqueue=true 会让旧 Detail Job 调度器周期扫描并自动补跑历史批次，
     * 与 BatchCaptureRun 形成双任务权威，并在用户未确认采集计划时就发起商品级导航。
     * 现在的正式流程是：Search → ProductBatch → MarketCapturePlan → 人工一次确认 → Capture Run。
     */
    detailEnrichmentIntent: {
      schemaVersion: AMAZON_SEARCH_DETAIL_ENRICHMENT_INTENT_VERSION,
      autoEnqueue: false,
    },
    evidenceReferences,
  };
  const manifest = {
    schemaVersion: "amazon-search-capture-manifest.v1",
    sourceType: "amazon_search_capture",
    reportType: "search_results",
    traceId: input.traceId,
    detailEnrichmentIntent: {
      schemaVersion: AMAZON_SEARCH_DETAIL_ENRICHMENT_INTENT_VERSION,
      autoEnqueue: false,
    },
    evidenceReferences,
  };
  const store = input.store ?? getProductBatchStore(input.context);
  const created = await store.createOrReuseProcessingBatch({
    batchName: `Amazon Search · ${query.slice(0, 100)} · ${now.toLocaleDateString("zh-CN")}`,
    marketplace: "US",
    currency: "USD",
    reportType: "search_results",
    query,
    category: null,
    priceMinCents: null,
    priceMaxCents: null,
    briefHash,
    sourceFileName: "amazon-search-capture.json",
    sourceFileSha256,
    sellerSpriteDisclaimerVersion: SEARCH_BATCH_DISCLAIMER_VERSION,
  });

  if (!created.created && (created.batch.batchStatus === "ready" || created.batch.batchStatus === "archived")) {
    const storedItems = await store.getBatchItems(created.batch.id);
    return {
      created: false,
      batchId: created.batch.id,
      batchStatus: created.batch.batchStatus,
      itemCount: storedItems.length,
      quarantinedCount,
      duplicateProductCount,
      rejectedProductFactCount,
    };
  }

  let processing = created.batch;
  if (processing.batchStatus === "blocked") processing = await store.retryBlocked(processing.id);
  if (processing.batchStatus !== "processing") {
    throw new AmazonSearchProductBatchHandoffError("Amazon Search ProductBatch is not in a writable state.");
  }

  try {
    const items = resolvedItems.map((resolved, ordinal) => toBatchItem({
      batchId: processing.id,
      resolved,
      ordinal,
    }));
    await store.saveBatchItems(processing.id, items);
    const batch = await store.markReady(processing.id, {
      normalizedBusinessHash: hashJson({ query, evidenceReferences }),
      snapshotHash: hashJson(normalizedSnapshot),
      manifestHash: hashJson(manifest),
      itemCount: resolvedItems.length + quarantinedCount,
      acceptedCount: resolvedItems.length,
      quarantinedCount,
      dataQualityStatus: quarantinedCount > 0 ? "passed_with_quarantine" : "passed",
      importedAt: now,
      sellerSpriteDisclaimerVersion: SEARCH_BATCH_DISCLAIMER_VERSION,
      normalizedSnapshotJson: JSON.stringify(normalizedSnapshot),
      manifestJson: JSON.stringify(manifest),
      qualitySummaryJson: JSON.stringify(qualitySummary),
      errorJson: quarantinedCount > 0
        ? JSON.stringify({
          schemaVersion: "amazon-search-capture-quarantine.v1",
          qualitySummary,
        })
        : null,
    });
    return {
      created: created.created,
      batchId: batch.id,
      batchStatus: batch.batchStatus,
      itemCount: items.length,
      quarantinedCount,
      duplicateProductCount,
      rejectedProductFactCount,
    };
  } catch {
    await store.markBlocked(processing.id, {
      errorJson: JSON.stringify({
        code: "amazon_search_product_batch_handoff_failed",
        traceId: input.traceId,
        batchId: processing.id,
      }),
      qualitySummaryJson: JSON.stringify(qualitySummary),
    }).catch(async () => {
      await recordCaptureApiDiagnostic({ context: input.context, traceId: input.traceId,
        subjectKey: resolvedItems[0]?.evidence.subjectKey ?? null, sourceType: "amazon_dom",
        status: "failed", eventType: "batch_mark_blocked_failed", errorCode: "PERSISTENCE_FAILED", reason: "ProductBatch handoff failed; marking blocked also failed.",
        evidenceRefs: [`batch:${processing.id}`],
      }).catch(() => undefined);
    });
    throw new AmazonSearchProductBatchHandoffError();
  }
}

function parseJsonRecord(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

function evidenceReferencesFromManifest(manifest: Record<string, unknown>): Record<string, unknown>[] {
  return arrayOfRecords(manifest.evidenceReferences);
}

/**
 * 将确认后的追加搜索结果并入同一个 ready ProductBatch。
 * 旧 ProductBatchItem 行、原 manifest.evidenceReferences 与 EvidenceStore 版本均不回写；
 * 扩充信息作为独立 append-only extension 元数据记录。
 */
export async function appendAmazonSearchProductBatch(input: {
  context: AccessContext;
  batchId: string;
  query: string;
  traceId: string;
  authorizationId: string;
  targetTotal: number;
  searchStartPage: number;
  searchNavigationUsed: number;
  plan: AmazonSearchCapturePlan | null;
  captures?: readonly CaptureGatewayResult[];
  persistedEvidenceReferences?: readonly AmazonSearchEvidenceCheckpointRef[];
  now?: Date;
  repository?: ReturnType<typeof createProductBatchRepository>;
}): Promise<{
  batch: ProductBatchRecord;
  addedCount: number;
  duplicateProductCount: number;
  rejectedProductFactCount: number;
  validEvidenceCount: number;
  newlyCapturedAsins: string[];
}> {
  const repository = input.repository ?? createProductBatchRepository();
  const batch = await repository.getBatchByIdForOwner(input.batchId);
  if (!batch || batch.batchStatus !== "ready" || batch.reportType !== "search_results") {
    throw new AmazonSearchProductBatchHandoffError("只能向当前 ready 搜索批次追加商品。");
  }
  let sourceType: string | null = null;
  try {
    sourceType = String(parseJsonRecord(batch.normalizedSnapshotJson).sourceType ?? "");
  } catch {
    sourceType = null;
  }
  if (sourceType !== "amazon_search_capture") {
    throw new AmazonSearchProductBatchHandoffError("当前批次不是 Amazon Search capture 批次，已拒绝追加。");
  }
  const batchItems = await repository.getBatchItemsForOwner(input.batchId);
  const currentAsins = new Set(batchItems
    .filter((item) => !item.archivedAt && item.asin)
    .map((item) => item.asin!.trim().toUpperCase()));
  const initialManifest = parseJsonRecord(batch.manifestJson);
  const initialExtensions = arrayOfRecords(initialManifest.extensions);
  const completedExtension = initialExtensions.find((entry) => entry.authorizationId === input.authorizationId);
  if (completedExtension) {
    const existingRefs = arrayOfRecords(completedExtension.evidenceReferences).map((reference) => ({
      subjectKey: reference.subjectKey,
      captureId: reference.captureId,
      evidenceId: reference.evidenceId,
      evidenceVersion: reference.evidenceVersion,
      contentHash: reference.contentHash,
    })).sort((a, b) => String(a.subjectKey).localeCompare(String(b.subjectKey)));
    const requestedRefs = input.persistedEvidenceReferences?.map((reference) => ({
      subjectKey: reference.subjectKey,
      captureId: reference.captureId,
      evidenceId: reference.evidenceId,
      evidenceVersion: reference.evidenceVersion,
      contentHash: reference.contentHash,
    })).sort((a, b) => a.subjectKey.localeCompare(b.subjectKey)) ?? [];
    const sameEvidence = requestedRefs.length === 0 || hashJson(existingRefs) === hashJson(requestedRefs);
    if (completedExtension.traceId !== input.traceId
      || completedExtension.searchStartPage !== input.searchStartPage
      || completedExtension.targetTotal !== input.targetTotal
      || completedExtension.searchNavigationUsed !== input.searchNavigationUsed
      || !sameEvidence) {
      throw new AmazonSearchProductBatchHandoffError("相同扩充授权编号已绑定到不同的搜索证据或预算。" );
    }
    return {
      batch,
      addedCount: typeof completedExtension.addedProductCount === "number" ? completedExtension.addedProductCount : 0,
      duplicateProductCount: typeof completedExtension.duplicateProductCount === "number" ? completedExtension.duplicateProductCount : 0,
      rejectedProductFactCount: typeof completedExtension.rejectedProductFactCount === "number" ? completedExtension.rejectedProductFactCount : 0,
      validEvidenceCount: (await readVerifiedAmazonSearchEvidence({ context: input.context, items: batchItems })).length,
      newlyCapturedAsins: Array.isArray(completedExtension.newlyCapturedAsins)
        ? completedExtension.newlyCapturedAsins.filter((value): value is string => typeof value === "string")
        : [],
    };
  }
  const evidenceStore = createEvidenceStore(sourceLayerOperator(input.context));
  const resolvedByProductKey = new Map<string, ResolvedCapture>();
  const rejectionCounts: Record<string, number> = {};
  let productFactCount = 0;

  for (const capture of input.captures ?? []) {
    if (capture.source !== "amazon_dom") continue;
    for (const fact of capture.productFacts) {
      productFactCount += 1;
      const resolved = await resolvePersistedCapture({
        capture,
        fact,
        subjectRecord: (subjectKey) => evidenceStore.getSubject(subjectKey),
      });
      if (!resolved) {
        rejectionCounts.persisted_product_identity_unavailable = (rejectionCounts.persisted_product_identity_unavailable ?? 0) + 1;
        continue;
      }
      if (currentAsins.has(resolved.asin)) {
        rejectionCounts.existing_asin = (rejectionCounts.existing_asin ?? 0) + 1;
        continue;
      }
      if (resolvedByProductKey.has(resolved.productKey)) {
        rejectionCounts.duplicate_product_identity = (rejectionCounts.duplicate_product_identity ?? 0) + 1;
      }
      resolvedByProductKey.set(resolved.productKey, resolved);
    }
  }

  for (const reference of input.persistedEvidenceReferences ?? []) {
    productFactCount += 1;
    const asin = /^amazon:US:([A-Z0-9]{10})$/u.exec(reference.subjectKey)?.[1] ?? null;
    if (!asin || !SHA256_PATTERN.test(reference.contentHash)
      || !Number.isSafeInteger(reference.evidenceVersion) || reference.evidenceVersion < 1) {
      rejectionCounts.persisted_product_identity_unavailable = (rejectionCounts.persisted_product_identity_unavailable ?? 0) + 1;
      continue;
    }
    const subject = await evidenceStore.getSubject(reference.subjectKey);
    const evidence = subject?.versions.find((version) => (
      version.version === reference.evidenceVersion
      && version.evidenceId === reference.evidenceId
      && version.captureId === reference.captureId
      && version.contentHash === reference.contentHash
    ));
    if (!evidence || subject?.integrityIssues?.length) {
      rejectionCounts.persisted_product_identity_unavailable = (rejectionCounts.persisted_product_identity_unavailable ?? 0) + 1;
      continue;
    }
    const fact = adaptEvidenceToProductFact({ evidence });
    if (!isBoundSearchIdentity(fact, evidence)) {
      rejectionCounts.persisted_product_identity_unavailable = (rejectionCounts.persisted_product_identity_unavailable ?? 0) + 1;
      continue;
    }
    const resolved: ResolvedCapture = {
      evidence,
      fact,
      productKey: `amazon:US:${asin}`,
      asin,
      title: fact.basic.title.value!.trim(),
    };
    if (currentAsins.has(resolved.asin)) {
      rejectionCounts.existing_asin = (rejectionCounts.existing_asin ?? 0) + 1;
      continue;
    }
    if (resolvedByProductKey.has(resolved.productKey)) {
      rejectionCounts.duplicate_product_identity = (rejectionCounts.duplicate_product_identity ?? 0) + 1;
    }
    resolvedByProductKey.set(resolved.productKey, resolved);
  }

  const resolvedItems = [...resolvedByProductKey.values()];
  if (!Number.isSafeInteger(input.targetTotal) || input.targetTotal < 1 || input.targetTotal > HARD_MAX_AUTHORIZED_ITEMS
    || currentAsins.size + resolvedItems.length > input.targetTotal) {
    throw new AmazonSearchProductBatchHandoffError("扩充结果超过服务端确认的目标总数；未写入批次。扩充计划必须刷新后重新确认。");
  }
  const duplicateProductCount = (rejectionCounts.duplicate_product_identity ?? 0) + (rejectionCounts.existing_asin ?? 0);
  const rejectedProductFactCount = Math.max(0, productFactCount - resolvedItems.length - duplicateProductCount);
  const gatewayEvidenceCount = input.persistedEvidenceReferences?.length
    ?? (input.captures ?? []).reduce((sum, capture) => sum + capture.capture.items.length, 0);
  const observationCount = Math.max(input.plan?.totalObservationCount ?? 0, gatewayEvidenceCount, resolvedItems.length);
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new AmazonSearchProductBatchHandoffError("扩充批次时间无效。");
  const query = input.query.trim();
  const extensionEvidenceReferences = resolvedItems.map(({ evidence }) => ({
    asin: /^amazon:US:([A-Z0-9]{10})$/u.exec(evidence.subjectKey)?.[1] ?? null,
    subjectKey: evidence.subjectKey,
    captureId: evidence.captureId,
    evidenceId: evidence.evidenceId,
    evidenceVersion: evidence.version,
    contentHash: evidence.contentHash,
  })).sort((a, b) => a.subjectKey.localeCompare(b.subjectKey));
  const newItems = resolvedItems.map((resolved, index) => toBatchItem({
    batchId: input.batchId,
    resolved,
    ordinal: batchItems.reduce((maximum, item) => Math.max(maximum, item.ordinal), -1) + index + 1,
  }));

  const previousManifest = parseJsonRecord(batch.manifestJson);
  const previousSnapshot = parseJsonRecord(batch.normalizedSnapshotJson);
  const previousQuality = parseJsonRecord(batch.qualitySummaryJson);
  const oldExtensions = arrayOfRecords(previousManifest.extensions);
  const extension = {
    schemaVersion: "amazon-search-capture-expansion.v1",
    authorizationId: input.authorizationId,
    targetTotal: input.targetTotal,
    searchStartPage: input.searchStartPage,
    searchNavigationUsed: input.searchNavigationUsed,
    query,
    traceId: input.traceId,
    observationCount,
    addedProductCount: resolvedItems.length,
    newlyCapturedAsins: resolvedItems.map((item) => item.asin),
    duplicateProductCount,
    rejectedProductFactCount,
    evidenceReferences: extensionEvidenceReferences,
    createdAt: now.toISOString(),
  };
  const extensions = [...oldExtensions, extension];
  const normalizedSnapshot = { ...previousSnapshot, extensions };
  const manifest = { ...previousManifest, extensions };
  const observationCountBefore = batch.itemCount ?? batch.acceptedCount ?? batchItems.length;
  const acceptedCountBefore = batch.acceptedCount ?? batchItems.length;
  const quarantineCountBefore = batch.quarantinedCount ?? Math.max(0, observationCountBefore - acceptedCountBefore);
  const acceptedCount = acceptedCountBefore + newItems.length;
  const quarantinedCount = quarantineCountBefore + Math.max(0, observationCount - newItems.length);
  const itemCount = acceptedCount + quarantinedCount;
  const searchNavigationBefore = typeof previousQuality.searchNavigationUsed === "number"
    && Number.isSafeInteger(previousQuality.searchNavigationUsed) && previousQuality.searchNavigationUsed >= 0
    ? previousQuality.searchNavigationUsed
    : null;
  if (searchNavigationBefore === null) {
    throw new AmazonSearchProductBatchHandoffError("批次搜索导航回执不可核验，已拒绝扩充。");
  }
  if (input.searchStartPage !== searchNavigationBefore + 1
    || input.searchNavigationUsed < 0 || searchNavigationBefore + input.searchNavigationUsed > 10) {
    throw new AmazonSearchProductBatchHandoffError("扩充搜索页码与批次持久化导航回执不一致。");
  }
  const qualitySummary = {
    ...previousQuality,
    schemaVersion: "amazon-search-capture-batch-quality.v1",
    observationCount: (typeof previousQuality.observationCount === "number" ? previousQuality.observationCount : observationCountBefore) + observationCount,
    gatewayEvidenceCount: (typeof previousQuality.gatewayEvidenceCount === "number" ? previousQuality.gatewayEvidenceCount : acceptedCountBefore) + gatewayEvidenceCount,
    productFactProjectionCount: (typeof previousQuality.productFactProjectionCount === "number" ? previousQuality.productFactProjectionCount : acceptedCountBefore) + productFactCount,
    acceptedProductCount: acceptedCount,
    quarantinedObservationCount: quarantinedCount,
    duplicateProductCount: (typeof previousQuality.duplicateProductCount === "number" ? previousQuality.duplicateProductCount : 0)
      + duplicateProductCount,
    rejectedProductFactCount: (typeof previousQuality.rejectedProductFactCount === "number" ? previousQuality.rejectedProductFactCount : 0)
      + extension.rejectedProductFactCount,
    rejectionCounts: {
      ...(previousQuality.rejectionCounts && typeof previousQuality.rejectionCounts === "object" && !Array.isArray(previousQuality.rejectionCounts)
        ? previousQuality.rejectionCounts as Record<string, number>
        : {}),
      ...Object.fromEntries(Object.entries(rejectionCounts).map(([key, count]) => [
        key,
        (typeof (previousQuality.rejectionCounts as Record<string, unknown> | undefined)?.[key] === "number"
          ? Number((previousQuality.rejectionCounts as Record<string, unknown>)[key]) : 0) + count,
      ])),
    },
    searchNavigationUsed: searchNavigationBefore + input.searchNavigationUsed,
    extensions,
  };
  const allEvidenceReferences = [
    ...evidenceReferencesFromManifest(previousManifest),
    ...extensions.flatMap((entry) => arrayOfRecords(entry.evidenceReferences)),
  ];
  const metadata = {
    sourceFileSha256: hashJson({ schemaVersion: "amazon-search-capture-reference-set.v1", references: allEvidenceReferences }),
    normalizedBusinessHash: hashJson({ previous: batch.normalizedBusinessHash, extension }),
    snapshotHash: hashJson(normalizedSnapshot),
    manifestHash: hashJson(manifest),
    itemCount,
    acceptedCount,
    quarantinedCount,
    dataQualityStatus: quarantinedCount > 0 ? "passed_with_quarantine" as const : "passed" as const,
    importedAt: now,
    sellerSpriteDisclaimerVersion: batch.sellerSpriteDisclaimerVersion ?? SEARCH_BATCH_DISCLAIMER_VERSION,
    normalizedSnapshotJson: JSON.stringify(normalizedSnapshot),
    manifestJson: JSON.stringify(manifest),
    qualitySummaryJson: JSON.stringify(qualitySummary),
    errorJson: quarantinedCount > 0 ? JSON.stringify({ schemaVersion: "amazon-search-capture-quarantine.v1", qualitySummary }) : null,
  };
  const appended = await repository.appendItemsToReadyBatch(input.batchId, newItems, {
    ...metadata,
    expectedUpdatedAt: batch.updatedAt,
  });
  const verified = await readVerifiedAmazonSearchEvidence({ context: input.context, items: await repository.getBatchItemsForOwner(input.batchId) });
  return {
    batch: appended.batch,
    addedCount: appended.insertedCount,
    duplicateProductCount: duplicateProductCount + appended.duplicateCount,
    rejectedProductFactCount: extension.rejectedProductFactCount,
    validEvidenceCount: verified.length,
    newlyCapturedAsins: resolvedItems.map((item) => item.asin),
  };
}
