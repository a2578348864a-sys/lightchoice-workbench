import "server-only";

import type { AccessContext } from "@/lib/server/accessPassword";
import { prisma } from "@/lib/server/db";
import { productBatchSourceTypeFromSnapshot } from "@/lib/productBatchContract";
import { extractProductBatchFactFields } from "@/lib/sourceLayer/server/sourceLayerService";
import {
  assertExpectedVersion,
  assertExpectedVersionMatches,
  actorScopeOf,
  V5CoreError,
  withV5Receipt,
  parseJsonRecord,
  resourceVersion,
} from "@/lib/server/v5CoreCommon";
import {
  reconcileSourceBatchItemCounts,
  sourceBatchQualityPresentation,
} from "@/lib/sourceBatchReconciliation";
import { resolveValidMarketProductSet, type MarketProductCandidate } from "@/lib/marketScan/marketSamplePolicy";
import { resolveProductPresentationIdentity } from "@/lib/product/productPresentationIdentity";
import { readProductBatchItemPresentation } from "@/lib/productBatchPresentation";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { sourceLayerOperator } from "@/lib/sourceLayer/server/sourceLayerService";
import { parseV3ModuleEvidence, V3_MODULE_IDS, type V3ModuleId } from "@/lib/sourceLayer/v3ModuleEvidence";
import { V3_MODULE_REGISTRY } from "@/lib/sourceLayer/v3ModuleRegistry";
import {
  projectV3ModuleStatus,
  projectV3ModuleFailure,
  projectOrchestratorReceiptStatus,
  readProductBatchDetailEnrichment,
  countReviewEvidence,
  type ProductModuleStatus,
} from "@/lib/sourceLayer/moduleStatusPresentation";

type SourceModuleCoverage = {
  module: V3ModuleId;
  label: string;
  status: ProductModuleStatus;
  capturedAt: string | null;
  evidenceId: string | null;
  contentHash: string | null;
  limitations: string[];
  evidenceOnly: boolean | null;
  errorCode: string | null;
  retryable: boolean | null;
  latestAttempt: {
    receiptId: string;
    traceId: string | null;
    status: string;
    message: string;
    errorCode: string | null;
    attemptedAt: string;
  } | null;
};

type AmazonSearchSalesSignal = {
  value: number | null;
  lowerBound: number | null;
  upperBound: number | null;
  qualifier: string | null;
  rawText: string | null;
  capturedAt: string;
  evidenceId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function amazonSearchSalesSignal(value: unknown, capturedAt: string, evidenceId: string): AmazonSearchSalesSignal | null {
  if (typeof value === "number") {
    const parsed = finiteNumber(value);
    return parsed === null ? null : { value: parsed, lowerBound: null, upperBound: null, qualifier: null, rawText: null, capturedAt, evidenceId };
  }
  if (!isRecord(value)) return null;
  const lowerBound = finiteNumber(value.lowerBound);
  const upperBound = finiteNumber(value.upperBound);
  const exactValue = finiteNumber(value.value);
  if (exactValue === null && lowerBound === null && upperBound === null) return null;
  return {
    value: exactValue,
    lowerBound,
    upperBound,
    qualifier: typeof value.qualifier === "string" ? value.qualifier : null,
    rawText: typeof value.rawText === "string" ? value.rawText : null,
    capturedAt,
    evidenceId,
  };
}

async function moduleEvidenceByItem(
  context: AccessContext,
  batchId: string,
  items: readonly { productKey: string; normalizedProductJson: string; asin: string | null }[],
) {
  const store = createEvidenceStore(sourceLayerOperator(context));
  const receiptRows = await prisma.v5OperationReceipt.findMany({
    where: {
      actorScope: actorScopeOf(context),
      operation: "source-layer:capture-capability-orchestrator:v2",
      resourceKey: { startsWith: `${batchId}:` },
      status: "succeeded",
    },
    orderBy: { updatedAt: "desc" },
    take: 1000,
    select: { id: true, resourceKey: true, responseJson: true, updatedAt: true },
  });
  const latestAttemptByModuleAndAsin = new Map<string, SourceModuleCoverage["latestAttempt"]>();
  for (const receipt of receiptRows) {
    if (!receipt.responseJson) continue;
    let response: unknown;
    try { response = JSON.parse(receipt.responseJson) as unknown; } catch { continue; }
    if (!isRecord(response) || !Array.isArray(response.modules)) continue;
    for (const moduleResult of response.modules) {
      if (!isRecord(moduleResult) || typeof moduleResult.module !== "string") continue;
      const resultItems = Array.isArray(moduleResult.items) ? moduleResult.items : [];
      if (resultItems.length === 0) {
        const key = `${moduleResult.module}:*`;
        if (!latestAttemptByModuleAndAsin.has(key)) {
          latestAttemptByModuleAndAsin.set(key, {
            receiptId: receipt.id,
            traceId: typeof moduleResult.traceId === "string" ? moduleResult.traceId : null,
            status: typeof moduleResult.status === "string" ? moduleResult.status : "unknown",
            message: typeof moduleResult.message === "string" ? moduleResult.message : "模块请求已记录。",
            errorCode: typeof moduleResult.errorCode === "string" ? moduleResult.errorCode : null,
            attemptedAt: receipt.updatedAt.toISOString(),
          });
        }
        continue;
      }
      for (const resultItem of resultItems) {
        if (!isRecord(resultItem)) continue;
        const asin = typeof resultItem.asin === "string" ? resultItem.asin.trim().toUpperCase() : "*";
        const key = `${moduleResult.module}:${asin || "*"}`;
        if (latestAttemptByModuleAndAsin.has(key)) continue;
        latestAttemptByModuleAndAsin.set(key, {
          receiptId: receipt.id,
          traceId: typeof resultItem.traceId === "string" ? resultItem.traceId : typeof moduleResult.traceId === "string" ? moduleResult.traceId : null,
          status: typeof resultItem.status === "string" ? resultItem.status : typeof moduleResult.status === "string" ? moduleResult.status : "unknown",
          message: typeof resultItem.message === "string" ? resultItem.message : typeof moduleResult.message === "string" ? moduleResult.message : "模块请求已记录。",
          errorCode: typeof resultItem.errorCode === "string" ? resultItem.errorCode : typeof moduleResult.errorCode === "string" ? moduleResult.errorCode : null,
          attemptedAt: receipt.updatedAt.toISOString(),
        });
      }
    }
  }
  return Promise.all(items.map(async (item) => {
    const subject = await store.getSubject(item.productKey);
    const detailEnrichment = readProductBatchDetailEnrichment(item.normalizedProductJson);
    const candidates = (subject?.attachments ?? []).flatMap((attachment) => {
      const evidence = parseV3ModuleEvidence(attachment.payload);
      return evidence ? [{ attachment, evidence }] : [];
    });
    const latestByModule = new Map<V3ModuleId, (typeof candidates)[number]>();
    for (const candidate of candidates) {
      const existing = latestByModule.get(candidate.evidence.module);
      if (!existing || candidate.evidence.capturedAt > existing.evidence.capturedAt) {
        latestByModule.set(candidate.evidence.module, candidate);
      }
    }
    const moduleCoverage: SourceModuleCoverage[] = V3_MODULE_IDS.map((module) => {
      const candidate = latestByModule.get(module);
      const registry = V3_MODULE_REGISTRY.find((entry) => entry.id === module);
      const failure = projectV3ModuleFailure({
        data: candidate?.evidence.data,
        limitations: candidate?.evidence.limitations,
      });
      const asin = item.asin?.trim().toUpperCase() ?? "";
      const latestAttempt = latestAttemptByModuleAndAsin.get(`${module}:${asin}`)
        ?? latestAttemptByModuleAndAsin.get(`${module}:*`)
        ?? null;
      const evidenceStatus = candidate
        ? projectV3ModuleStatus({
            status: candidate.evidence.status,
            outcome: failure.outcome,
            errorCode: failure.errorCode,
            detailEnrichmentStatus: module === "amazon_detail" ? detailEnrichment?.status : null,
            reviewEvidence: module === "review_voc" ? countReviewEvidence(candidate.evidence.data) : null,
          })
        : projectOrchestratorReceiptStatus(latestAttempt?.status, latestAttempt?.errorCode) ?? "NOT_COLLECTED";
      const attemptCode = latestAttempt?.errorCode?.toUpperCase() ?? "";
      const attemptLimitation = /CAPTCHA/u.test(attemptCode) ? ["captcha_requires_human"]
        : /LOGIN_REQUIRED|SIGN_IN_REQUIRED|AUTH_REQUIRED/u.test(attemptCode) ? ["login_required"]
          : /EXTENSION_REQUIRED|EXTENSION_NOT_FOUND/u.test(attemptCode) ? ["sellersprite_extension_required"]
            : /PLAN_LIMITED|PLAN_LIMITATION/u.test(attemptCode) ? ["provider_plan_limited"]
              : /BROWSER_USE_CONNECTION_UNAVAILABLE|BROWSER_USE_REMOTE_DEBUGGING/u.test(attemptCode) ? ["browser_use_connection_unavailable"]
                : /MODULE_SOURCE_INPUT_REQUIRED|TREND_EXPORT_REQUIRED/u.test(attemptCode) ? ["module_source_input_required"]
                  : /HUMAN_GATE_PAUSE/u.test(attemptCode) ? ["not_attempted_after_human_gate"]
                    : latestAttempt?.status === "failed_retryable" ? ["capture_attempt_failed"] : [];
      return {
        module,
        label: registry?.label ?? module,
        status: evidenceStatus,
        capturedAt: candidate?.evidence.capturedAt ?? null,
        evidenceId: candidate?.attachment.attachmentId ?? null,
        contentHash: candidate?.attachment.contentHash ?? null,
        limitations: candidate ? failure.limitations : attemptLimitation,
        evidenceOnly: candidate?.evidence.evidenceOnly ?? null,
        errorCode: candidate ? failure.errorCode : latestAttempt?.errorCode ?? failure.errorCode,
        retryable: candidate ? failure.retryable : latestAttempt?.status === "failed_retryable" ? true : false,
        latestAttempt,
      };
    });
    const searchCandidate = latestByModule.get("amazon_search_market");
    const searchData = searchCandidate?.evidence.data ?? {};
    const observedProduct = isRecord(searchData.observedProduct) ? searchData.observedProduct : {};
    const searchObservation = isRecord(observedProduct.searchObservation) ? observedProduct.searchObservation : {};
    const rawSalesSignal = observedProduct.boughtPastMonth ?? searchObservation.boughtPastMonth;
    const salesSignal = searchCandidate
      ? amazonSearchSalesSignal(rawSalesSignal, searchCandidate.evidence.capturedAt, searchCandidate.attachment.attachmentId)
      : null;
    return { moduleCoverage, amazonSalesSignal: salesSignal };
  }));
}

const OWNER = "owner:v1";

type DependencySummary = {
  referenced: boolean;
  candidateIds: string[];
  marketScanIds: string[];
  taskIds: string[];
  evidenceRefCount: number;
  deleteBlockedBy: string[];
};

function requireOwner(context: AccessContext) {
  if (context.mode !== "owner") throw new V5CoreError("FORBIDDEN", "当前主体不允许访问正式来源数据。", 403);
}

function asVersion(date: Date) {
  return resourceVersion(date);
}

async function tasksForCandidates(candidateIds: readonly string[]): Promise<string[]> {
  if (!candidateIds.length) return [];
  const tasks = await prisma.viralAnalysisRecord.findMany({
    where: { type: "workflow" },
    select: { id: true, resultJson: true },
  });
  return tasks.filter((task) => {
    const result = parseJsonRecord(task.resultJson);
    const candidateId = result.candidateToTask && typeof result.candidateToTask === "object"
      ? (result.candidateToTask as Record<string, unknown>).candidateId
      : undefined;
    return typeof candidateId === "string" && candidateIds.includes(candidateId);
  }).map((task) => task.id);
}

async function scanRefsForItem(item: { id: string; productKey: string; asin: string | null; evidenceHash: string }): Promise<string[]> {
  const scans = await prisma.marketScan.findMany({
    where: { ownerScope: OWNER },
    select: { id: true, sampleSnapshotJson: true },
  });
  const matches: string[] = [];
  for (const scan of scans) {
    const snapshot = parseJsonRecord(scan.sampleSnapshotJson);
    const items = Array.isArray(snapshot.items) ? snapshot.items : [];
    const found = items.some((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      const value = raw as Record<string, unknown>;
      return value.subjectKey === item.productKey
        || (item.asin !== null && value.asin === item.asin)
        || value.sourceProofHash === item.evidenceHash;
    });
    if (found) matches.push(scan.id);
  }
  return matches;
}

async function itemDependencies(item: {
  id: string;
  productKey: string;
  asin: string | null;
  evidenceHash: string;
}): Promise<DependencySummary> {
  const candidates = await prisma.opportunityCandidate.findMany({
    where: { originProductBatchItemId: item.id },
    select: { id: true },
  });
  const candidateIds = candidates.map((candidate) => candidate.id);
  const marketScanIds = await scanRefsForItem(item);
  const taskIds = await tasksForCandidates(candidateIds);
  const deleteBlockedBy = [
    ...(candidateIds.length ? ["candidate_origin"] : []),
    ...(marketScanIds.length ? ["market_sample"] : []),
    ...(taskIds.length ? ["task_reference"] : []),
  ];
  return {
    referenced: deleteBlockedBy.length > 0,
    candidateIds,
    marketScanIds,
    taskIds,
    evidenceRefCount: item.evidenceHash ? 1 : 0,
    deleteBlockedBy,
  };
}

async function batchDependencies(batchId: string) {
  const items = await prisma.productBatchItem.findMany({ where: { batchId }, select: {
    id: true, productKey: true, asin: true, evidenceHash: true,
  } });
  const summaries = await Promise.all(items.map(itemDependencies));
  const candidateIds = [...new Set(summaries.flatMap((item) => item.candidateIds))];
  const marketScanIds = [...new Set(summaries.flatMap((item) => item.marketScanIds))];
  const taskIds = [...new Set(summaries.flatMap((item) => item.taskIds))];
  const selection = await prisma.productDiscoverySelection.findFirst({ where: { ownerSubject: OWNER, activeProductBatchId: batchId } });
  return {
    referenced: Boolean(selection) || candidateIds.length > 0 || marketScanIds.length > 0 || taskIds.length > 0,
    candidateIds,
    marketScanIds,
    taskIds,
    evidenceRefCount: summaries.reduce((sum, item) => sum + item.evidenceRefCount, 0),
    deleteBlockedBy: [
      ...(selection ? ["active_selection"] : []),
      ...(candidateIds.length ? ["candidate_origin"] : []),
      ...(marketScanIds.length ? ["market_sample"] : []),
      ...(taskIds.length ? ["task_reference"] : []),
    ],
  } satisfies DependencySummary;
}

/** 读取 providerMetrics 中已解析的数值型指标（与 productBatchPresentation.resolvedMetric 同口径），缺数据返回 null。 */
function resolvedProviderMetricNumber(product: Record<string, unknown>, field: string): number | null {
  const metrics = product.providerMetrics;
  if (typeof metrics !== "object" || metrics === null || Array.isArray(metrics)) return null;
  const metric = (metrics as Record<string, unknown>)[field];
  if (typeof metric !== "object" || metric === null || Array.isArray(metric)) return null;
  const record = metric as Record<string, unknown>;
  if (record.status !== "resolved") return null;
  return typeof record.normalized === "number" && Number.isFinite(record.normalized) ? record.normalized : null;
}

function itemView(item: {
  id: string; batchId: string; productKey: string; ordinal: number; asin: string | null; parentAsin: string | null;
  itemIdentityHash: string; itemHash: string; evidenceHash: string; normalizedProductJson: string;
  occurrenceProjectionJson: string; familyProjectionJson: string; rankingJson: string;
  provisionalDisposition: string; researchPriority: string; promotionEligible: boolean;
  imageSnapshotJson: string; evidenceStatus: string; archivedAt: Date | null; createdAt: Date; updatedAt?: Date;
}, deps: DependencySummary, parentArchivedAt: Date | null) {
  const product = parseJsonRecord(item.normalizedProductJson);
  const fieldCoverage = typeof product.fieldCoverage === "object" && product.fieldCoverage !== null
    ? product.fieldCoverage
    : (() => {
        const metrics = product.providerMetrics;
        if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return {};
        return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [
          key,
          value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).status === "string"
            ? (value as Record<string, unknown>).status
            : "unknown",
        ]));
      })();
  const facts = extractProductBatchFactFields(item.normalizedProductJson);
  const comparisonFacts = parseJsonRecord(JSON.stringify(product.comparisonFacts ?? {}));
  const projection = (field: string, fallback: number | null, providerKey: string) => {
    const sourceField = comparisonFacts[field] ?? product[field];
    const record = sourceField && typeof sourceField === "object" && !Array.isArray(sourceField)
      ? sourceField as Record<string, unknown> : {};
    const metrics = product.providerMetrics && typeof product.providerMetrics === "object"
      ? product.providerMetrics as Record<string, unknown> : {};
    const provider = metrics[providerKey] && typeof metrics[providerKey] === "object"
      ? metrics[providerKey] as Record<string, unknown> : {};
    const amount = record.value && typeof record.value === "object" && !Array.isArray(record.value)
      ? record.value as Record<string, unknown> : {};
    const value = typeof record.value === "number" ? record.value : typeof amount.amount === "number" ? amount.amount : fallback;
    if (value === null) return null;
    const metricNature = record.metricNature ?? provider.metricNature ?? "unknown";
    const status = metricNature === "estimate" || metricNature === "derived" ? "estimated"
      : record.status === "confirmed" || (metricNature === "snapshot" && provider.applicability === "available") ? "confirmed"
        : typeof record.status === "string" ? record.status : "unknown";
    return { value, status, metricNature, ...(field === "price" ? { currency: typeof amount.currency === "string" ? amount.currency : "USD" } : {}) };
  };
  const title = facts.title ?? (typeof product.title === "string" && product.title.trim() ? product.title.trim() : null);
  const rawPrice = product.price;
  const priceVal = facts.price !== null
    ? facts.price
    : typeof rawPrice === "number"
      ? rawPrice
      : rawPrice && typeof rawPrice === "object" && typeof (rawPrice as Record<string, unknown>).value === "number"
        ? (rawPrice as Record<string, unknown>).value as number
        : null;
  const rawRating = product.rating;
  const ratingVal = facts.rating !== null
    ? facts.rating
    : typeof rawRating === "number"
      ? rawRating
      : rawRating && typeof rawRating === "object" && typeof (rawRating as Record<string, unknown>).value === "number"
        ? (rawRating as Record<string, unknown>).value as number
        : null;
  const rawReviewCount = product.reviewCount;
  const reviewCountVal = facts.reviewCount !== null
    ? facts.reviewCount
    : typeof rawReviewCount === "number"
      ? rawReviewCount
      : rawReviewCount && typeof rawReviewCount === "object" && typeof (rawReviewCount as Record<string, unknown>).value === "number"
        ? (rawReviewCount as Record<string, unknown>).value as number
        : null;
  const rawImage = typeof product.image === "string" && product.image.trim()
    ? product.image.trim()
    : typeof product.imageUrl === "string" && product.imageUrl.trim()
      ? product.imageUrl.trim()
      : null;
  const image = rawImage;
  // 图片来源诚实性：只有存在权威图片字段（真实 URL）时才允许渲染真实图片；
  // 缺失时 UI 必须显示统一占位图，禁止把占位当真实商品图。
  const imageStatus = rawImage ? "AUTHORITATIVE_IMAGE_AVAILABLE" as const : "AUTHORITATIVE_IMAGE_MISSING" as const;
  const brand = facts.brand ?? (typeof product.brand === "string" ? product.brand : null);
  const category = typeof product.category === "string" && product.category.trim() ? product.category.trim() : null;
  // 批次引用中的顶层 bsr（providerMetrics 缺省时的回退）。只做形状校验与取整，不换算、不补值。
  const rawTopLevelBsr = product.bsr;
  const topLevelBsr = rawTopLevelBsr && typeof rawTopLevelBsr === "object" && !Array.isArray(rawTopLevelBsr)
    ? (() => {
        const record = rawTopLevelBsr as Record<string, unknown>;
        const rank = typeof record.rank === "number" && Number.isFinite(record.rank) ? Math.round(record.rank) : null;
        if (rank === null) return null;
        const bsrCategory = typeof record.category === "string" && record.category.trim() ? record.category.trim() : null;
        return { rank, category: bsrCategory };
      })()
    : null;
  // 展示层中文身份：只读已有字段推导，不写回任何事实源。
  const presentation = resolveProductPresentationIdentity({
    title,
    brand,
    category,
    asin: item.asin,
  });
  // 详情补齐状态（presentation-only）：读条目 normalizedProductJson 的 enrichment 块
  // （Detail Enrichment Worker 写入），只透出状态供 UI 诚实展示，不推导、不补值。
  const enrichmentRecord = product.enrichment && typeof product.enrichment === "object" && !Array.isArray(product.enrichment)
    ? product.enrichment as Record<string, unknown>
    : null;
  const enrichmentStatus = enrichmentRecord
    && (enrichmentRecord.status === "enriched" || enrichmentRecord.status === "captured_partial")
    ? enrichmentRecord.status
    : null;
  const enrichmentCaptureOrigin = enrichmentRecord?.captureOrigin === "CAPTURED_NOW" || enrichmentRecord?.captureOrigin === "REUSED_VALID_EVIDENCE"
    ? enrichmentRecord.captureOrigin
    : null;
// G-03：字段级来源（只读透出）。enrichment.evidenceId 只是「最近一轮补齐」的证据，
  // 不代表历史字段来源；下游若要追溯某个字段实际来自哪个证据版本，必须读这里。
  // 解析规则与 ProductBatchDetailEnrichment 一致：任一条不完整即整条丢弃，不做推断。
  const enrichmentFieldProvenance = (() => {
    const block = enrichmentRecord?.fieldProvenance;
    if (!enrichmentRecord || typeof block !== "object" || block === null || Array.isArray(block)) return null;
    const entries = (block as Record<string, unknown>).entries;
    if (!Array.isArray(entries)) return null;
    const parsed = entries.flatMap((raw) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
      const entry = raw as Record<string, unknown>;
      if (typeof entry.field !== "string" || !entry.field.trim()) return [];
      if (typeof entry.evidenceId !== "string" || !entry.evidenceId.trim()) return [];
      if (typeof entry.evidenceVersion !== "number" || !Number.isInteger(entry.evidenceVersion) || entry.evidenceVersion < 1) return [];
      if (typeof entry.contentHash !== "string" || !/^[a-f0-9]{64}$/iu.test(entry.contentHash)) return [];
      if (typeof entry.capturedAt !== "string" || !Number.isFinite(Date.parse(entry.capturedAt))) return [];
      return [{
        field: entry.field,
        evidenceId: entry.evidenceId,
        evidenceVersion: entry.evidenceVersion,
        contentHash: entry.contentHash,
        capturedAt: entry.capturedAt,
      }];
    });
    return parsed.length > 0 ? parsed : null;
  })();
  // 复用旧版商品卡展示层（productBatchPresentation）：选品信号（正向/反向/缺失）与销量估算。
  const batchPresentation = readProductBatchItemPresentation({
    productKey: item.productKey,
    ordinal: item.ordinal,
    itemIdentityHash: item.itemIdentityHash,
    itemHash: item.itemHash,
    evidenceHash: item.evidenceHash,
    normalizedProductJson: item.normalizedProductJson,
    occurrenceProjectionJson: item.occurrenceProjectionJson,
    familyProjectionJson: item.familyProjectionJson,
    rankingJson: item.rankingJson,
    provisionalDisposition: item.provisionalDisposition,
    researchPriority: item.researchPriority,
    evidenceStatus: item.evidenceStatus,
    promotionEligible: item.promotionEligible,
    imageSnapshotJson: item.imageSnapshotJson,
    asin: item.asin,
    parentAsin: item.parentAsin,
    id: item.id,
    batchId: item.batchId,
    createdAt: item.createdAt.toISOString(),
    archivedAt: item.archivedAt?.toISOString() ?? null,
  });

  return {
    id: item.id,
    batchId: item.batchId,
    asin: item.asin ?? "",
    title,
    chineseTitle: presentation.chineseTitle,
    chineseTitleStatus: presentation.status,
    image,
    imageStatus,
    brand,
    category,
    chineseCategory: presentation.chineseCategory,
    bsr: facts.bsr ?? topLevelBsr,
    enrichmentStatus,
    enrichmentCaptureOrigin,
    ...(enrichmentFieldProvenance ? { enrichmentFieldProvenance } : {}),
    evidenceStatus: item.evidenceStatus,
    price: projection("price", priceVal, "price"),
    rating: projection("rating", ratingVal, "rating"),
    reviewCount: projection("reviewCount", reviewCountVal, "reviews"),
    /** SellerSprite 估算月销量（有则展示；缺失为 null，UI 显示「暂无数据」）。 */
    estimatedMonthlySales: resolvedProviderMetricNumber(product, "estimatedMonthlySales"),
    /** 选品信号：来自批次排序层的正向理由 / 反向信号 / 缺失信号（已映射为中文，无则为空数组）。 */
    positiveReasons: batchPresentation.positiveReasons,
    counterSignals: batchPresentation.counterSignals,
    missingSignals: batchPresentation.missingSignals,
    fieldCoverage,
    usageStatus: item.evidenceStatus === "sufficient_for_comparison" || item.evidenceStatus === "ready" ? "research_ready" : "needs_review",
    referencedBy: { candidateIds: deps.candidateIds, marketScanIds: deps.marketScanIds, taskIds: deps.taskIds },
    archivedAt: item.archivedAt?.toISOString() ?? null,
    evidenceRefs: item.evidenceHash ? [item.evidenceHash] : [],
    capturedAt: null,
    updatedAt: (item.updatedAt ?? new Date()).toISOString(),
    resourceVersion: asVersion(item.updatedAt ?? new Date()),
    visible: item.archivedAt === null && parentArchivedAt === null,
    hiddenByParent: parentArchivedAt !== null,
  };
}

async function findItem(itemId: string) {
  const item = await prisma.productBatchItem.findUnique({ where: { id: itemId }, include: { batch: true } });
  if (!item || item.batch.ownerSubject !== OWNER) throw new V5CoreError("SOURCE_ITEM_NOT_FOUND", "来源条目不存在。", 404);
  return item;
}

async function findBatch(batchId: string) {
  const batch = await prisma.productBatch.findUnique({ where: { id: batchId } });
  if (!batch || batch.ownerSubject !== OWNER) throw new V5CoreError("SOURCE_BATCH_NOT_FOUND", "来源批次不存在。", 404);
  return batch;
}

async function buildScanByBatchIdMap() {
  const unarchivedScans = await prisma.marketScan.findMany({
    where: { ownerScope: OWNER, archivedAt: null },
    select: { id: true, scanName: true, sampleDefinitionJson: true, sampleSnapshotJson: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });

  const scanByBatchId = new Map<string, { id: string; scanName: string; sampleCount: number }>();
  for (const scan of unarchivedScans) {
    const def = parseJsonRecord(scan.sampleDefinitionJson);
    const bId = typeof def.productBatchId === "string" && def.productBatchId ? def.productBatchId : null;
    if (bId && !scanByBatchId.has(bId)) {
      let count = 0;
      try {
        const snap = parseJsonRecord(scan.sampleSnapshotJson);
        count = Array.isArray(snap.items) ? snap.items.length : 0;
      } catch {
        count = 0;
      }
      scanByBatchId.set(bId, { id: scan.id, scanName: scan.scanName, sampleCount: count });
    }
  }
  return scanByBatchId;
}

function computeBatchStats(
  batch: {
    id: string;
    marketplace?: string | null;
    itemCount: number | null;
    acceptedCount: number | null;
    quarantinedCount?: number | null;
    dataQualityStatus: string | null;
  },
  items: Array<{
    id: string; batchId: string; evidenceStatus: string; archivedAt: Date | null;
    productKey?: string; ordinal?: number; asin?: string | null; parentAsin?: string | null;
    familyProjectionJson?: string | null;
  }>,
  scanByBatchId: Map<string, { id: string; scanName: string; sampleCount: number }>,
) {
  const activeItems = items.filter((it) => it.batchId === batch.id);
  const dedupeCandidates: MarketProductCandidate[] = activeItems.map((it, index) => ({
    id: it.id,
    productKey: it.productKey ?? "",
    ordinal: typeof it.ordinal === "number" ? it.ordinal : index,
    asin: it.asin ?? null,
    parentAsin: it.parentAsin ?? null,
    familyProjectionJson: it.familyProjectionJson ?? "",
    evidenceStatus: it.evidenceStatus,
    // 归档条目交给 resolver 以 ARCHIVED_ITEM 显式排除，避免「可见性」与「有效性」两套口径再次分叉。
    archivedAt: it.archivedAt,
  }));

  // VALID_PRODUCT_SET 唯一权威 resolver：前后端共用，UI 不再自行实现有效性算法。
  const validProductSet = resolveValidMarketProductSet({
    items: dedupeCandidates,
    batchMarketplace: batch.marketplace ?? null,
    declaredItemCount: batch.itemCount ?? null,
  });

  const validSampleCount = validProductSet.validCount;
  const unverifiedItemsCount = validProductSet.pendingReviewCount;
  const excludedCount = validProductSet.excludedCount;

  const rawCount = Math.max(batch.itemCount ?? 0, activeItems.length);
  const detailCount = activeItems.length;

  const reconciliation = reconcileSourceBatchItemCounts(
    batch.acceptedCount ?? batch.itemCount,
    detailCount,
  );
  const discrepancy = reconciliation.difference ?? 0;
  const unverifiedCount = Math.max(unverifiedItemsCount, discrepancy);

  const qualityPresentation = sourceBatchQualityPresentation(batch.dataQualityStatus, {
    itemCount: rawCount,
    reconciliation,
  });

  const marketScan = scanByBatchId.get(batch.id) ?? null;

  return {
    rawCount,
    validSampleCount,
    validProductSet: {
      ...validProductSet,
      // UI 只消费该判定，不再自行比较阈值，确保前后端同源。
      isSufficient: validSampleCount >= validProductSet.minimumRequired,
    },
    unverifiedCount,
    excludedCount,
    detailCount,
    reconciliation,
    qualityPresentation,
    marketScan,
  };
}

export async function listSourceBatches(input: { context: AccessContext; include?: string; limit?: number }) {
  requireOwner(input.context);
  const include = input.include ?? "active";
  if (!["active", "archived", "all"].includes(include)) throw new V5CoreError("INVALID_FILTER", "include 参数无效。", 400);
  const where = include === "active" ? { ownerSubject: OWNER, archivedAt: null }
    : include === "archived" ? { ownerSubject: OWNER, archivedAt: { not: null } }
      : { ownerSubject: OWNER };
  const batches = await prisma.productBatch.findMany({ where, orderBy: { updatedAt: "desc" }, take: Math.min(input.limit ?? 50, 100) });
  const batchIds = batches.map((batch) => batch.id);
  const itemsByBatch = batchIds.length
    ? await prisma.productBatchItem.findMany({
        where: { batchId: { in: batchIds } },
        select: {
          id: true, batchId: true, evidenceStatus: true, archivedAt: true,
          productKey: true, ordinal: true, asin: true, parentAsin: true, familyProjectionJson: true,
        },
      })
    : [];
  const scanByBatchId = await buildScanByBatchIdMap();

  return {
    items: batches.map((batch) => {
      const stats = computeBatchStats(batch, itemsByBatch, scanByBatchId);
      return {
        id: batch.id, batchName: batch.batchName, marketplace: batch.marketplace, currency: batch.currency,
        batchStatus: batch.batchStatus, archivedAt: batch.archivedAt?.toISOString() ?? null,
        sourceType: productBatchSourceTypeFromSnapshot(batch.normalizedSnapshotJson),
        itemCount: stats.rawCount, acceptedCount: batch.acceptedCount ?? stats.validSampleCount,
        quarantinedCount: batch.quarantinedCount ?? stats.excludedCount, dataQualityStatus: batch.dataQualityStatus,
        createdAt: batch.createdAt.toISOString(), updatedAt: batch.updatedAt.toISOString(),
        resourceVersion: asVersion(batch.updatedAt),
        ...stats,
      };
    }),
    nextCursor: null,
  };
}

export async function getSourceBatch(input: { context: AccessContext; batchId: string; include?: string }) {
  requireOwner(input.context);
  const batch = await findBatch(input.batchId);
  const items = await prisma.productBatchItem.findMany({ where: { batchId: batch.id }, orderBy: { ordinal: "asc" } });
  const dependencies = await Promise.all(items.map(itemDependencies));
  const moduleEvidence = await moduleEvidenceByItem(input.context, batch.id, items);
  const scanByBatchId = await buildScanByBatchIdMap();
  const stats = computeBatchStats(batch, items, scanByBatchId);
  return {
    batch: {
      id: batch.id, batchName: batch.batchName, marketplace: batch.marketplace, currency: batch.currency,
      batchStatus: batch.batchStatus, archivedAt: batch.archivedAt?.toISOString() ?? null,
      sourceType: productBatchSourceTypeFromSnapshot(batch.normalizedSnapshotJson),
      itemCount: stats.rawCount, acceptedCount: batch.acceptedCount ?? stats.validSampleCount,
      dataQualityStatus: batch.dataQualityStatus, resourceVersion: asVersion(batch.updatedAt),
      createdAt: batch.createdAt.toISOString(), updatedAt: batch.updatedAt.toISOString(),
      ...stats,
    },
    items: items.map((item, index) => ({
      ...itemView(item, dependencies[index], batch.archivedAt),
      ...moduleEvidence[index],
    })),
    dependencySummary: await batchDependencies(batch.id),
  };
}

export async function sourceItemAction(input: {
  context: AccessContext; itemId: string; action: "archive" | "restore" | "delete"; expectedVersion: unknown;
  idempotencyKey: string; reason?: string;
}) {
  requireOwner(input.context);
  const expectedVersion = assertExpectedVersion(input.expectedVersion);
  const receipt = await withV5Receipt({
    context: input.context, operation: `source-item:${input.action}`, resourceKey: input.itemId,
    idempotencyKey: input.idempotencyKey, requestBody: { action: input.action, expectedVersion, reason: input.reason ?? null },
    execute: async () => {
      const item = await findItem(input.itemId);
      assertExpectedVersionMatches(expectedVersion, item.updatedAt);
      const deps = await itemDependencies(item);
      if (input.action === "delete") {
        if (deps.deleteBlockedBy.length) throw new V5CoreError("DELETE_DEPENDENCY_BLOCKED", "该来源条目仍被业务对象引用，只能归档。", 409, false, true, { dependencySummary: deps });
        await prisma.productBatchItem.delete({ where: { id: item.id } });
        return { item: { id: item.id, batchId: item.batchId }, outcome: "deleted", dependencySummary: deps };
      }
      if (input.action === "restore" && item.archivedAt === null) throw new V5CoreError("NOT_ARCHIVED", "来源条目当前未归档。", 409, false, true);
      const archivedAt = input.action === "archive" ? new Date() : null;
      const updated = await prisma.productBatchItem.update({ where: { id: item.id }, data: { archivedAt } });
      const nextDeps = await itemDependencies(updated);
      const parent = await prisma.productBatch.findUniqueOrThrow({ where: { id: item.batchId }, select: { archivedAt: true } });
      return { item: itemView(updated, nextDeps, parent.archivedAt), outcome: input.action === "archive" ? "archived" : "restored", dependencySummary: { ...nextDeps, deleteBlockedBy: [] } };
    },
  });
  return { ...receipt.value, replayed: receipt.replayed };
}

export async function sourceBatchAction(input: {
  context: AccessContext; batchId: string; action: "archive" | "restore" | "delete"; expectedVersion: unknown;
  idempotencyKey: string; reason?: string;
}) {
  requireOwner(input.context);
  const expectedVersion = assertExpectedVersion(input.expectedVersion);
  const receipt = await withV5Receipt({
    context: input.context, operation: `source-batch:${input.action}`, resourceKey: input.batchId,
    idempotencyKey: input.idempotencyKey, requestBody: { action: input.action, expectedVersion, reason: input.reason ?? null },
    execute: async () => {
      const batch = await findBatch(input.batchId);
      assertExpectedVersionMatches(expectedVersion, batch.updatedAt);
      const deps = await batchDependencies(batch.id);
      if (input.action === "delete") {
        if (deps.deleteBlockedBy.length) throw new V5CoreError("DELETE_DEPENDENCY_BLOCKED", "该来源批次仍被业务对象引用，只能归档。", 409, false, true, { dependencySummary: deps });
        await prisma.$transaction([
          prisma.productBatchItem.deleteMany({ where: { batchId: batch.id } }),
          prisma.productBatch.delete({ where: { id: batch.id } }),
        ]);
        return { batch: { id: batch.id }, outcome: "deleted", dependencySummary: deps };
      }
      if (input.action === "restore" && batch.archivedAt === null) throw new V5CoreError("NOT_ARCHIVED", "来源批次当前未归档。", 409, false, true);
      const updated = await prisma.productBatch.update({ where: { id: batch.id }, data: { archivedAt: input.action === "archive" ? new Date() : null,
        ...(input.action === "restore" && batch.batchStatus === "archived" ? { batchStatus: "ready" } : {}) } });
      return {
        batch: { id: updated.id, batchStatus: updated.batchStatus, archivedAt: updated.archivedAt?.toISOString() ?? null, resourceVersion: asVersion(updated.updatedAt) },
        outcome: input.action === "archive" ? "archived" : "restored",
        dependencySummary: { ...deps, deleteBlockedBy: [] },
      };
    },
  });
  return { ...receipt.value, replayed: receipt.replayed };
}

export async function sourceBulkAction(input: {
  context: AccessContext; resource: "source_item" | "source_batch"; action: "archive" | "restore" | "delete";
  items: Array<{ id: string; expectedVersion: unknown }>; idempotencyKey: string;
}) {
  requireOwner(input.context);
  if (!input.items.length || input.items.length > 100) throw new V5CoreError(input.items.length > 100 ? "BULK_ACTION_TOO_LARGE" : "BULK_ACTION_INVALID", "批量操作数量无效。", 400);
  const receipt = await withV5Receipt({
    context: input.context, operation: `${input.resource}:bulk:${input.action}`, resourceKey: input.items.map((item) => item.id).sort().join(","),
    idempotencyKey: input.idempotencyKey, requestBody: { resource: input.resource, action: input.action, items: input.items },
    execute: async () => {
      const results: Array<Record<string, unknown>> = [];
      for (const item of input.items) {
        try {
          const result = input.resource === "source_item"
            ? await sourceItemAction({ context: input.context, itemId: item.id, action: input.action, expectedVersion: item.expectedVersion, idempotencyKey: `${input.idempotencyKey}:${item.id}` })
            : await sourceBatchAction({ context: input.context, batchId: item.id, action: input.action, expectedVersion: item.expectedVersion, idempotencyKey: `${input.idempotencyKey}:${item.id}` });
          const resource = "item" in result ? result.item : result.batch;
          results.push({ id: item.id, outcome: result.outcome, code: null, currentVersion: (resource as Record<string, unknown>).resourceVersion ?? null });
        } catch (error) {
          const v5 = error instanceof V5CoreError ? error : new V5CoreError("INTERNAL_ERROR", "项目操作失败。", 500);
          results.push({ id: item.id, outcome: "failed", code: v5.code, currentVersion: null });
        }
      }
      return { resource: input.resource, action: input.action, total: results.length, succeeded: results.filter((item) => item.outcome !== "failed").length, failed: results.filter((item) => item.outcome === "failed").length, results };
    },
  });
  return { ...receipt.value, replayed: receipt.replayed };
}

export function sourceActorScope(context: AccessContext) {
  return actorScopeOf(context);
}
