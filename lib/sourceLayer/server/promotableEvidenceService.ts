import "server-only";

import { PRODUCT_BATCH_MAX_ITEMS, type SellerSpriteEvidenceStatus } from "@/lib/productBatchContract";
import type { AccessContext } from "@/lib/server/accessPassword";
import { getProductBatchStore } from "@/lib/server/productBatchStoreResolver";
import { hashJson, requireIdempotencyKey, withV5Receipt, V5CoreError } from "@/lib/server/v5CoreCommon";
import { adaptEvidenceToProductFact } from "@/lib/sourceLayer/fact/productFactAdapter";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import { createEvidenceStore, type EvidenceSubjectRecord } from "@/lib/sourceLayer/server/evidenceStore";
import type { CaptureEvidenceRecord } from "@/lib/sourceLayer/sourceAdapter";
import { isFixtureEvidenceSubject } from "@/lib/sourceLayer/server/fixtureRegistry";
import { recordCaptureApiDiagnostic } from "@/lib/sourceLayer/server/diagnosticService";

function promotionEvidenceStatus(fact: ProductFact, evidence: CaptureEvidenceRecord): SellerSpriteEvidenceStatus {
  const comparison = [fact.basic.price, fact.basic.rating, fact.basic.reviewCount];
  return comparison.every((field) => field.value !== null && field.metricNature === "snapshot")
    && [evidence.pkg.fieldStates.price, evidence.pkg.fieldStates.rating, evidence.pkg.fieldStates.reviewCount]
      .every((field) => field.status === "confirmed" && field.metricNature === "snapshot")
    ? "sufficient_for_comparison" : "limited_evidence";
}

const OWNER = "owner:v1";
const SHA256 = /^[a-f0-9]{64}$/u;

export type PromotableEvidencePreview = {
  subjectKey: string;
  asin: string;
  marketplace: string;
  title: string;
  image: string | null;
  price: { amount: number; currency: string } | null;
  capturedAt: string;
  evidenceVersion: number;
  contentHash: string;
  evidenceRef: string;
  factBuildable: true;
  hasConflict: boolean;
  estimatedFieldSummary: string[];
  alreadyReferenced: boolean;
  batchContext: string[];
};

type ResolvedEvidence = {
  subject: EvidenceSubjectRecord;
  evidence: CaptureEvidenceRecord;
  productFact: ProductFact;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function fieldIsEstimated(fact: ProductFact, group: "basic" | "market", field: string): boolean {
  const value = asRecord(asRecord(fact[group])?.[field]);
  return value?.metricNature === "estimate";
}

function hasFieldConflict(evidence: CaptureEvidenceRecord): boolean {
  const states = asRecord(evidence.pkg.fieldStates);
  return Boolean(states && Object.values(states).some((state) => asRecord(state)?.status === "conflict"));
}

function isBuildable(evidence: CaptureEvidenceRecord, fact: ProductFact): boolean {
  const binding = evidence.pkg.sourceProof.entityBinding;
  const asin = fact.basic.asin.value;
  const title = fact.basic.title.value;
  return evidence.version >= 1
    && evidence.subjectKey === evidence.pkg.subjectKey
    && evidence.validation.verdict === "passed"
    && evidence.validation.readyForResearch
    && binding?.bound === true
    && binding.expectedAsin === asin
    && binding.observedAsin === asin
    && typeof asin === "string"
    && /^[A-Z0-9]{10}$/u.test(asin)
    && typeof title === "string"
    && title.trim().length >= 2
    && SHA256.test(evidence.contentHash)
    && evidence.factAuthority === "evidence_only";
}

function resolveLatestValid(subject: EvidenceSubjectRecord): ResolvedEvidence | null {
  const versions = [...subject.versions].sort((a, b) => b.version - a.version);
  for (const evidence of versions) {
    try {
      const productFact = adaptEvidenceToProductFact({ evidence });
      if (!isBuildable(evidence, productFact)) continue;
      if (isFixtureEvidenceSubject({ subjectKey: subject.subjectKey, asin: productFact.basic.asin.value, evidence })) continue;
      return { subject, evidence, productFact };
    } catch {
      // A malformed version is not allowed to make an older valid version
      // disappear; the resolver continues to the latest valid immutable one.
    }
  }
  return null;
}

async function referencedSubjects(context: AccessContext): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const store = getProductBatchStore(context);
  for (const batch of await store.listBatches()) {
    if (batch.batchStatus === "archived") continue;
    for (const item of await store.getBatchItems(batch.id)) {
      const existing = result.get(item.productKey) ?? [];
      existing.push(batch.id);
      result.set(item.productKey, existing);
    }
  }
  return result;
}

export async function listPromotableEvidenceSubjects(
  context: AccessContext,
): Promise<{ subjects: PromotableEvidencePreview[]; count: number }> {
  if (context.mode !== "owner") throw new V5CoreError("FORBIDDEN", "当前主体不允许提档正式来源资产。", 403);
  const store = createEvidenceStore(OWNER);
  const referenced = await referencedSubjects(context);
  const entries = await store.listSubjects();
  const subjects: PromotableEvidencePreview[] = [];
  for (const entry of entries) {
    try {
      const subject = await store.getSubject(entry.subjectKey);
      if (!subject) continue;
      const resolved = resolveLatestValid(subject);
      if (!resolved) continue;
      const { evidence, productFact } = resolved;
      const asin = productFact.basic.asin.value;
      const title = productFact.basic.title.value;
      if (!asin || !title) continue;
      const productKey = `amazon:${evidence.pkg.marketplace}:${asin}`;
      const batchContext = referenced.get(productKey) ?? [];
      subjects.push({
        subjectKey: subject.subjectKey,
        asin,
        marketplace: evidence.pkg.marketplace,
        title,
        image: productFact.basic.image.value,
        price: productFact.basic.price.value,
        capturedAt: evidence.capturedAt,
        evidenceVersion: evidence.version,
        contentHash: evidence.contentHash,
        evidenceRef: `evidence:${evidence.evidenceId}`,
        factBuildable: true,
        hasConflict: hasFieldConflict(evidence),
        estimatedFieldSummary: [
          ...(fieldIsEstimated(productFact, "market", "monthlySalesEstimate") ? ["月销量估算"] : []),
          ...(fieldIsEstimated(productFact, "market", "monthlyRevenueEstimate") ? ["月销售额估算"] : []),
        ],
        alreadyReferenced: batchContext.length > 0,
        batchContext,
      });
    } catch {
      // Corrupt/empty subjects are excluded from a read-only preview.
    }
  }
  return { subjects, count: subjects.length };
}

function assertBinding(value: unknown): { subjectKey: string; evidenceVersion: number; contentHash: string } {
  const record = asRecord(value);
  const subjectKey = requiredText(record?.subjectKey);
  const evidenceVersion = record?.evidenceVersion;
  const contentHash = requiredText(record?.contentHash)?.toLowerCase();
  if (!subjectKey || typeof evidenceVersion !== "number" || !Number.isSafeInteger(evidenceVersion) || evidenceVersion < 1 || !contentHash || !SHA256.test(contentHash)) {
    throw new V5CoreError("PROMOTION_BINDING_INVALID", "提档请求缺少完整的证据版本绑定。", 400);
  }
  return { subjectKey, evidenceVersion: evidenceVersion as number, contentHash };
}

function factReference(input: ResolvedEvidence, batchId: string): string {
  const asin = input.productFact.basic.asin.value;
  const image = input.productFact.basic.image.value;
  const title = input.productFact.basic.title.value;
  const parentAsin = input.productFact.extended?.parentAsin.value ?? null;
  return JSON.stringify({
    schemaVersion: "evidence-store-product-reference.v1",
    subjectKey: input.subject.subjectKey,
    evidenceId: input.evidence.evidenceId,
    evidenceVersion: input.evidence.version,
    contentHash: input.evidence.contentHash,
    factSchema: "product-fact.v3",
    factBuildable: true,
    asin,
    parentAsin,
    marketplace: input.evidence.pkg.marketplace,
    title,
    image,
    capturedAt: input.evidence.capturedAt,
    comparisonFacts: {
      price: { ...input.productFact.basic.price, status: input.evidence.pkg.fieldStates.price.status },
      rating: { ...input.productFact.basic.rating, status: input.evidence.pkg.fieldStates.rating.status },
      reviewCount: { ...input.productFact.basic.reviewCount, status: input.evidence.pkg.fieldStates.reviewCount.status },
    },
    productBatchId: batchId,
    metricNature: "preserved_in_product_fact_projection",
  });
}

function imageSnapshot(fact: ProductFact): string {
  // Promotion never copies remote image bytes into the ProductBatch.
  return JSON.stringify({ version: "product-batch-image-snapshot.v1", status: "not_cached", reason: "not_available", capturedAt: fact.sourceProof.capturedAt });
}

function makeItem(input: { batchId: string; ordinal: number; resolved: ResolvedEvidence }) {
  const { evidence, productFact, subject } = input.resolved;
  const parentAsin = productFact.extended?.parentAsin.value ?? null;
  const productKey = `amazon:${evidence.pkg.marketplace}:${productFact.basic.asin.value}`;
  const reference = factReference(input.resolved, input.batchId);
  const itemHash = hashJson({ schemaVersion: "evidence-promotion-item.v1", reference });
  return {
    productKey,
    ordinal: input.ordinal,
    asin: productFact.basic.asin.value,
    parentAsin,
    itemIdentityHash: hashJson({ schemaVersion: "evidence-promotion-identity.v1", subjectKey: subject.subjectKey }),
    itemHash,
    evidenceHash: evidence.contentHash,
    normalizedProductJson: reference,
    occurrenceProjectionJson: JSON.stringify({ schemaVersion: "evidence-promotion-occurrence.v1", subjectKey: subject.subjectKey }),
    familyProjectionJson: JSON.stringify({ schemaVersion: "evidence-promotion-family.v1", parentAsin }),
    rankingJson: JSON.stringify({ schemaVersion: "evidence-promotion-ranking.v1", source: "EvidenceStore" }),
    provisionalDisposition: "provisional_score_only",
    researchPriority: "priority_1",
    evidenceStatus: promotionEvidenceStatus(productFact, evidence),
    promotionEligible: false as const,
    imageSnapshotJson: imageSnapshot(productFact),
  };
}

export async function promoteEvidence(input: {
  context: AccessContext;
  bindings: readonly unknown[];
  idempotencyKey: string;
  targetBatchId?: string | null;
  confirmed: boolean;
}) {
  if (input.context.mode !== "owner") throw new V5CoreError("FORBIDDEN", "当前主体不允许提档正式来源资产。", 403);
  if (!input.confirmed) throw new V5CoreError("PROMOTION_CONFIRM_REQUIRED", "请先确认要提档的商品。", 400);
  const bindings = input.bindings.map(assertBinding);
  const unique = new Map(bindings.map((item) => [item.subjectKey, item]));
  if (unique.size === 0 || unique.size > 100) throw new V5CoreError("PROMOTION_SELECTION_INVALID", "一次最多提档 100 个商品。", 400);
  const sortedBindings = [...unique.values()].sort((a, b) => a.subjectKey.localeCompare(b.subjectKey));
  const requestBody = { bindings: sortedBindings, targetBatchId: input.targetBatchId ?? null, confirmed: true };
  return withV5Receipt({
    context: input.context,
    operation: "source:evidence-promotion:v1",
    resourceKey: input.targetBatchId ?? `new:${hashJson(requestBody)}`,
    idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
    requestBody,
    execute: async () => {
      const evidenceStore = createEvidenceStore(OWNER);
      const resolved: ResolvedEvidence[] = [];
      for (const binding of unique.values()) {
        const subject = await evidenceStore.getSubject(binding.subjectKey);
        const current = subject ? resolveLatestValid(subject) : null;
        if (!current || current.evidence.version !== binding.evidenceVersion || current.evidence.contentHash !== binding.contentHash) {
          throw new V5CoreError("PROMOTION_PREVIEW_STALE", "来源证据已发生变化，请重新预览后再提档。", 409, true, true);
        }
        resolved.push(current);
      }
      const store = getProductBatchStore(input.context);
      let target = input.targetBatchId ? await store.getBatch(input.targetBatchId) : null;
      if (input.targetBatchId && !target) throw new V5CoreError("SOURCE_BATCH_NOT_FOUND", "目标商品批次不存在。", 404);
      const alreadyPresent = new Set<string>();
      if (target) {
        if (resolved.some((item) => item.evidence.pkg.marketplace !== target!.marketplace)) {
          throw new V5CoreError("PROMOTION_MARKETPLACE_MIXED", "证据站点与目标批次不一致，请分别提档。", 422);
        }
        if (target.batchStatus === "blocked" && target.archivedAt == null) target = await store.retryBlocked(target.id);
        for (const item of await store.getBatchItems(target.id)) alreadyPresent.add(item.productKey);
        if (target.batchStatus !== "processing" && resolved.some((item) => !alreadyPresent.has(`amazon:${item.evidence.pkg.marketplace}:${item.productFact.basic.asin.value}`))) {
          throw new V5CoreError("BATCH_IMMUTABLE", "已完成的商品批次不可追加新商品，请建立新的批次引用。", 409, true, true);
        }
      }
      let toCreate = resolved.filter((item) => !alreadyPresent.has(`amazon:${item.evidence.pkg.marketplace}:${item.productFact.basic.asin.value}`));
      if (target?.batchStatus === "processing" && toCreate.length === 0) toCreate = resolved;
      if (!target) {
        const marketplaces = [...new Set(resolved.map((item) => item.evidence.pkg.marketplace))];
        if (marketplaces.length !== 1) throw new V5CoreError("PROMOTION_MARKETPLACE_MIXED", "不同站点的商品证据请分别提档。", 422);
        const briefHash = hashJson({ schemaVersion: "evidence-promotion-brief.v1", marketplace: marketplaces[0], bindings: sortedBindings });
        const sourceFileSha256 = hashJson({ schemaVersion: "evidence-promotion-source.v1", bindings: sortedBindings });
        target = (await store.createOrReuseProcessingBatch({
          batchName: `EvidenceStore 已提档 · ${new Date().toLocaleDateString("zh-CN")}`,
          marketplace: marketplaces[0],
          currency: "USD",
          reportType: "search_results",
          query: "EvidenceStore promotion",
          category: null,
          priceMinCents: null,
          priceMaxCents: null,
          briefHash,
          sourceFileName: "evidence-store-promotion.json",
          sourceFileSha256,
          sellerSpriteDisclaimerVersion: "evidence-store-reference.v1",
        })).batch;
        for (const item of await store.getBatchItems(target.id)) alreadyPresent.add(item.productKey);
        if (target.batchStatus === "ready" || target.archivedAt != null) {
          toCreate = [];
        } else if (target.batchStatus === "blocked") {
          target = await store.retryBlocked(target.id);
          alreadyPresent.clear();
          toCreate = resolved;
        }
      }
      if (toCreate.length > 0) {
        try {
        const replacementKeys = new Set(toCreate.map((item) => `amazon:${item.evidence.pkg.marketplace}:${item.productFact.basic.asin.value}`));
        const existingItems = target.batchStatus === "processing"
          ? (await store.getBatchItems(target.id)).filter((item) => !replacementKeys.has(item.productKey)) : [];
        if (existingItems.length + toCreate.length > PRODUCT_BATCH_MAX_ITEMS) throw new V5CoreError("PROMOTION_ITEM_LIMIT_EXCEEDED", "目标批次的商品总数不能超过 500。", 422);
        await store.saveBatchItems(target.id, [
          ...existingItems.map((item) => ({ ...item })),
          ...toCreate.map((item, index) => makeItem({ batchId: target!.id, ordinal: existingItems.length + index, resolved: item })),
        ]);
        const persistedItems = await store.getBatchItems(target.id);
        const allReferences = persistedItems.map((item) => {
          const reference = asRecord(JSON.parse(item.normalizedProductJson));
          if (reference?.schemaVersion !== "evidence-store-product-reference.v1" || reference.subjectKey !== item.productKey
            || typeof reference.evidenceId !== "string") throw new V5CoreError("PROMOTION_BINDING_INVALID", "目标批次含不兼容的证据引用，不能标记 ready。", 422);
          return { ...assertBinding(reference), evidenceId: reference.evidenceId };
        }).sort((a, b) => a.subjectKey.localeCompare(b.subjectKey));
        const manifest = { schemaVersion: "evidence-store-promotion-manifest.v1", sourceType: "evidence_store_reference", bindings: allReferences, evidenceRefs: allReferences.map((item) => item.evidenceId) };
        const snapshot = { schemaVersion: "evidence-store-promotion-snapshot.v1", sourceType: "evidence_store_reference", bindings: allReferences, evidenceVersions: allReferences.map((item) => item.evidenceVersion) };
        await store.markReady(target.id, {
          normalizedBusinessHash: hashJson({ targetBatchId: target.id, bindings: allReferences }),
          snapshotHash: hashJson(snapshot),
          manifestHash: hashJson(manifest),
          itemCount: persistedItems.length,
          acceptedCount: persistedItems.length,
          quarantinedCount: 0,
          dataQualityStatus: "passed",
          importedAt: new Date(),
          sellerSpriteDisclaimerVersion: "evidence-store-reference.v1",
          normalizedSnapshotJson: JSON.stringify(snapshot),
          manifestJson: JSON.stringify(manifest),
          qualitySummaryJson: JSON.stringify({ schemaVersion: "evidence-promotion-quality.v1", factBuildable: true }),
          errorJson: null,
        });
        } catch (error) {
          await store.markBlocked(target.id, { errorJson: JSON.stringify({ code: "evidence_promotion_failed", batchId: target.id }),
            qualitySummaryJson: JSON.stringify({ schemaVersion: "evidence-promotion-quality.v1", failed: true }),
          }).catch(async () => {
            await recordCaptureApiDiagnostic({ context: input.context, traceId: input.idempotencyKey,
              sourceType: "evidence_store_reference", subjectKey: resolved[0]?.subject.subjectKey ?? null,
              status: "failed", eventType: "batch_mark_blocked_failed", errorCode: "PERSISTENCE_FAILED", reason: "Evidence promotion failed; marking blocked also failed.",
              evidenceRefs: [`batch:${target!.id}`],
            }).catch(() => undefined);
          });
          throw error;
        }
      }
      return {
        batchId: target.id,
        created: toCreate.map((item) => item.subject.subjectKey),
        alreadyPresent: resolved.filter((item) => alreadyPresent.has(`amazon:${item.evidence.pkg.marketplace}:${item.productFact.basic.asin.value}`)).map((item) => item.subject.subjectKey),
        skipped: [],
        failed: [],
        referencedSubjectKeys: resolved.map((item) => item.subject.subjectKey),
        createdByThisOperation: toCreate.length > 0,
      };
    },
  });
}
