import "server-only";

import { randomUUID } from "node:crypto";
import type { AccessContext } from "@/lib/server/accessPassword";
import type { ProductBatchItemView, ProductBatchStore } from "@/lib/productBatchStore";
import { V5CoreError, requireIdempotencyKey, withV5Receipt } from "@/lib/server/v5CoreCommon";
import { getProductBatchStore } from "@/lib/server/productBatchStoreResolver";
import { collectAmazonReviewsWithPlaywright, type AmazonReviewBrowserCollectionResult } from "@/lib/server/captureRecipeBrowser";
import { logAgentEvent } from "@/lib/server/agentEventLogger";
import { captureEvidenceAttachmentThroughGateway } from "@/lib/sourceLayer/server/captureGateway";
import { createEvidenceStore, type EvidenceSubjectRecord } from "@/lib/sourceLayer/server/evidenceStore";
import { captureV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import { MAX_REVIEW_FRESH_SESSION_ATTEMPTS } from "@/lib/server/reviewFreshSessionRetry";

const OPERATION = "source-layer:batch-review-voc-enrich:v1";
const MAX_ITEMS_PER_RUN = 30;
const COLLECTOR_ASIN_LIMIT = 3;
const MODULE = "review_voc" as const;
const EVIDENCE_VERSION = "capture-system-v3-module-evidence.v1";

export type BatchReviewVocStatus =
  | "complete"
  | "no_data_with_evidence"
  | "blocked_with_evidence"
  | "failed_human"
  | "failed_retryable"
  | "failed_permanent"
  | "skipped_existing"
  | "not_attempted";

export type BatchReviewVocItemResult = {
  itemId: string;
  asin: string;
  status: BatchReviewVocStatus;
  retryable: boolean;
  reviewCount: number;
  evidenceId: string | null;
  evidenceVersion: string | null;
  contentHash: string | null;
  traceId: string;
  errorCode: string | null;
  limitation: string | null;
};

export type BatchReviewVocRunResult = {
  summary: {
    requested: number;
    processed: number;
    complete: number;
    noDataWithEvidence: number;
    blockedWithEvidence: number;
    failedHuman: number;
    failedRetryable: number;
    failedPermanent: number;
    skippedExisting: number;
    humanAborted: boolean;
  };
  items: BatchReviewVocItemResult[];
};

type ReviewCollection = AmazonReviewBrowserCollectionResult;

export type BatchReviewVocDeps = {
  /**
   * 受控停止检查：由 BatchCaptureRun 注入。
   * 返回 true 表示当前运行已暂停/中止或导航预算耗尽 —— Worker 必须立即停止领取新工作，
   * 不再发起新的页面导航；已写入的 Evidence 保持原样。
   */
  shouldStop?(): Promise<boolean> | boolean;
  getStore(context: AccessContext): Pick<ProductBatchStore, "getBatch" | "getBatchItems">;
  getSubject(subjectKey: string): Promise<EvidenceSubjectRecord | null>;
  collect(input: {
    context: AccessContext;
    asins: ReadonlyArray<{ asin: string; role: "current_candidate" }>;
    freshSessionAttemptsRemainingByAsin: Readonly<Record<string, number>>;
    traceId: string;
  }): Promise<ReviewCollection>;
  saveReviews(input: {
    context: AccessContext;
    subjectKey: string;
    asin: string;
    capturedAt: string;
    traceId: string;
    reviews: Array<Record<string, unknown>>;
  }): Promise<{ evidenceId: string; contentHash: string }>;
  saveModule(input: {
    context: AccessContext;
    subjectKey: string;
    asin: string;
    capturedAt: string;
    traceId: string;
    provider: string;
    sourceUrl: string | null;
    outcome: "COMPLETE" | "NO_DATA_WITH_EVIDENCE" | "BLOCKED_WITH_EVIDENCE" | "FAILED_HUMAN" | "FAILED_RETRYABLE" | "FAILED_PERMANENT";
    status: "AVAILABLE_WITH_LIMITATION" | "BLOCKED_WITH_EVIDENCE" | "HUMAN_ACTION_REQUIRED";
    limitation: string;
    errorCode: string | null;
    retryable: boolean;
    reviews: Array<Record<string, unknown>>;
    captureDiagnostics: Record<string, unknown> | null;
  }): Promise<{ evidenceId: string; contentHash: string }>;
  logEvent(input: { runId: string; batchId: string; item: BatchReviewVocItemResult }): Promise<void>;
  now(): Date;
};

function defaultDeps(): BatchReviewVocDeps {
  const store = createEvidenceStore("owner:v1");
  return {
    getStore: (context) => getProductBatchStore(context),
    getSubject: (subjectKey) => store.getSubject(subjectKey),
    collect: (input) => collectAmazonReviewsWithPlaywright(input),
    saveReviews: async (input) => {
      const result = await captureEvidenceAttachmentThroughGateway({
        context: input.context,
        subjectKey: input.subjectKey,
        source: "amazon_dom",
        kind: "review_evidence",
        sourceFingerprint: `review:${input.asin}:${input.capturedAt}`,
        sourceUrl: typeof input.reviews[0]?.sourceUrl === "string" ? input.reviews[0].sourceUrl : null,
        capturedAt: new Date(input.capturedAt),
        traceId: input.traceId,
        payload: { schema: "review-evidence-attachment.v1", asin: input.asin, reviews: input.reviews },
      });
      return { evidenceId: result.attachment.attachmentId, contentHash: result.attachment.contentHash };
    },
    saveModule: async (input) => {
      const sourceUrl = input.sourceUrl;
      const result = await captureV3ModuleEvidence({
        context: input.context,
        sourceType: "amazon_dom",
        sourceFingerprint: `review-voc:${input.asin}:${input.capturedAt}`,
        moduleEvidence: {
          module: MODULE,
          subjectKey: input.subjectKey,
          marketplace: "US",
          capturedAt: input.capturedAt,
          provider: input.provider,
          sourceSurface: "Amazon public Top Reviews DOM",
          sourceUrl,
          acquisitionMode: "DOM_DIRECT",
          metricNature: "source_observed",
          status: input.status,
          limitations: [input.limitation],
          identity: { asin: input.asin },
          data: {
            outcome: input.outcome,
            traceId: input.traceId,
            reviewCount: input.reviews.length,
            reviews: input.reviews,
            captureDiagnostics: input.captureDiagnostics,
            error: input.errorCode ? { code: input.errorCode, retryable: input.retryable } : null,
          },
          evidenceOnly: true,
        },
      });
      return { evidenceId: result.attachment.attachmentId, contentHash: result.attachment.contentHash };
    },
    logEvent: async ({ runId, batchId, item }) => {
      try {
        await logAgentEvent({
          taskId: null,
          runId,
          module: "batch_review_voc_enrichment",
          event: `item_${item.status}`,
          level: item.status.startsWith("failed") || item.status === "blocked_with_evidence" ? "warn" : "info",
          message: `批次 ${batchId} 商品 ${item.asin} 的 Review/VOC 模块状态：${item.status}。`,
          metadata: item,
        });
      } catch {
        // Agent event is diagnostic only; EvidenceStore is the module state source.
      }
    },
    now: () => new Date(),
  };
}

function normalizeBatchId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{10,64}$/u.test(value.trim())) {
    throw new V5CoreError("BATCH_ID_INVALID", "batchId 必须是有效的批次 ID。", 400);
  }
  return value.trim();
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_ITEMS_PER_RUN) {
    throw new V5CoreError("REVIEW_VOC_LIMIT_INVALID", `limit 必须是 1-${MAX_ITEMS_PER_RUN} 的整数。`, 400);
  }
  return value;
}

function normalizeTargetAsin(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9]{10}$/u.test(value.trim())) {
    throw new V5CoreError("TARGET_ASIN_INVALID", "targetAsin 必须是 10 位字母数字 ASIN。", 400);
  }
  return value.trim().toUpperCase();
}

/** 显式目标 ASIN 集合（批量采集执行器用于「精确选择本轮商品」）。 */
function normalizeTargetAsins(value: unknown): ReadonlySet<string> | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new V5CoreError("TARGET_ASINS_INVALID", "targetAsins 必须是 ASIN 数组。", 400);
  }
  const set = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !/^[A-Za-z0-9]{10}$/u.test(entry.trim())) {
      throw new V5CoreError("TARGET_ASINS_INVALID", "targetAsins 含非法 ASIN。", 400);
    }
    set.add(entry.trim().toUpperCase());
  }
  return set;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchingReviewAttachments(subject: EvidenceSubjectRecord | null, asin: string) {
  return (subject?.attachments ?? []).filter((attachment) => {
    const payload = attachment.payload;
    return isRecord(payload) && payload.module === MODULE && isRecord(payload.identity) && payload.identity.asin === asin;
  }).sort((left, right) => String(right.capturedAt).localeCompare(String(left.capturedAt)));
}

function freshSessionAttemptsFromAttachment(attachment: ReturnType<typeof matchingReviewAttachments>[number]): number {
  const payload = attachment?.payload;
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  const diagnostics = data && isRecord(data.captureDiagnostics) ? data.captureDiagnostics : null;
  const persistedTotal = diagnostics?.freshSessionAttempts;
  const lastAttempt = diagnostics?.freshSessionAttempt;
  const attempts = Number.isSafeInteger(persistedTotal) && typeof persistedTotal === "number"
    ? persistedTotal
    : lastAttempt;
  return Number.isSafeInteger(attempts) && typeof attempts === "number"
    ? Math.min(MAX_REVIEW_FRESH_SESSION_ATTEMPTS, Math.max(0, attempts))
    : 0;
}

function priorFreshSessionAttempts(attachments: ReturnType<typeof matchingReviewAttachments>): number {
  return attachments.reduce((maximum, attachment) => Math.max(maximum, freshSessionAttemptsFromAttachment(attachment)), 0);
}

function matchingReviewEvidence(subject: EvidenceSubjectRecord | null, asin: string) {
  const latest = matchingReviewAttachments(subject, asin)[0];
  if (latest) {
    const payload = latest.payload;
    const error = isRecord(payload) && isRecord(payload.data) && isRecord(payload.data.error) ? payload.data.error : null;
    const diagnostics = isRecord(payload) && isRecord(payload.data) && isRecord(payload.data.captureDiagnostics)
      ? payload.data.captureDiagnostics
      : null;
    if (diagnostics?.bindingReason === "page_asin_anchor_mismatch"
      && diagnostics?.identityCheckVersion !== "review-page-identity.v2") return null;
    if (error?.retryable === true || error?.code === "REVIEW_EXTRACTION_EMPTY") return null;
  }
  return latest ?? null;
}

function normalizeReview(item: ReviewCollection["items"][number]): Record<string, unknown> {
  return {
    asin: item.asin,
    rating: item.rating,
    reviewDate: item.date,
    title: item.title,
    reviewText: item.reviewText,
    verifiedPurchase: item.verifiedPurchase,
    sourceUrl: item.sourceUrl,
    bindingNote: item.bindingNote,
    evidenceLevel: "REVIEW_SNIPPET_PARTIAL",
    completeness: "partial",
    sourceType: "browser",
    bindingKind: "browser_verified",
  };
}

function retryableCode(code: string | null): boolean {
  return code === "PLAYWRIGHT_BROWSER_FAILED" || code === "TIMEOUT" || code === "NETWORK_ERROR" || code === "REVIEW_SOURCE_UNAVAILABLE" || code === "REVIEW_EXTRACTION_EMPTY" || code === "AMAZON_PAGE_CHANGED";
}

function pageErrorForAsin(capture: ReviewCollection, asin: string) {
  return capture.pageResults.find((page) => page.asin === asin) ?? null;
}

function moduleOutcome(input: { capture: ReviewCollection; page: ReviewCollection["pageResults"][number] | null; reviews: Array<Record<string, unknown>> }) {
  const page = input.page;
  if (page?.diagnostics?.bindingReason === "page_asin_anchor_mismatch") {
    return { outcome: "FAILED_PERMANENT" as const, status: "BLOCKED_WITH_EVIDENCE" as const, code: "ASIN_PAGE_ANCHOR_MISMATCH", retryable: false, limitation: "page_asin_anchor_mismatch" };
  }
  if (page?.status === "not_attempted_human_gate") {
    return { outcome: "BLOCKED_WITH_EVIDENCE" as const, status: "BLOCKED_WITH_EVIDENCE" as const, code: "HUMAN_GATE_PAUSE", retryable: true, limitation: "not_attempted_after_human_gate" };
  }
  if (page?.status === "login_required") return { outcome: "FAILED_HUMAN" as const, status: "HUMAN_ACTION_REQUIRED" as const, code: "LOGIN_REQUIRED", retryable: false, limitation: "login_required" };
  if (page?.status === "captcha_required") return { outcome: "FAILED_HUMAN" as const, status: "HUMAN_ACTION_REQUIRED" as const, code: "CAPTCHA_DETECTED", retryable: false, limitation: "captcha_requires_human" };
  if (page?.status === "page_changed") return { outcome: "FAILED_RETRYABLE" as const, status: "BLOCKED_WITH_EVIDENCE" as const, code: "AMAZON_PAGE_CHANGED", retryable: true, limitation: "amazon_home_session_not_ready" };
  if (page?.status === "confirmed_no_reviews") return { outcome: "NO_DATA_WITH_EVIDENCE" as const, status: "AVAILABLE_WITH_LIMITATION" as const, code: null, retryable: false, limitation: "confirmed_no_public_reviews" };
  if (input.reviews.length > 0) return { outcome: "COMPLETE" as const, status: "AVAILABLE_WITH_LIMITATION" as const, code: null, retryable: false, limitation: "public_top_reviews_only" };
  const code = page?.status === "extraction_empty" ? "REVIEW_EXTRACTION_EMPTY" : input.capture.errorCode ?? "REVIEW_SOURCE_UNAVAILABLE";
  if (code === "ASIN_INVALID" || code === "ASIN_NOT_FOUND" || code === "CONTENT_DELETED") {
    return { outcome: "FAILED_PERMANENT" as const, status: "BLOCKED_WITH_EVIDENCE" as const, code, retryable: false, limitation: code.toLowerCase() };
  }
  return {
    outcome: retryableCode(code) ? "FAILED_RETRYABLE" as const : "BLOCKED_WITH_EVIDENCE" as const,
    status: "BLOCKED_WITH_EVIDENCE" as const,
    code,
    retryable: retryableCode(code),
    limitation: page?.status ? `review_page_${page.status.toLowerCase()}` : code.toLowerCase(),
  };
}

function existingResult(item: ProductBatchItemView, asin: string, attachment: NonNullable<ReturnType<typeof matchingReviewEvidence>>, traceId: string): BatchReviewVocItemResult {
  const payload = attachment.payload as Record<string, unknown>;
  const data = isRecord(payload.data) ? payload.data : {};
  return {
    itemId: item.id,
    asin,
    status: "skipped_existing",
    retryable: false,
    reviewCount: typeof data.reviewCount === "number" ? data.reviewCount : 0,
    evidenceId: attachment.attachmentId,
    evidenceVersion: EVIDENCE_VERSION,
    contentHash: attachment.contentHash,
    traceId: typeof data.traceId === "string" ? data.traceId : traceId,
    errorCode: null,
    limitation: Array.isArray(payload.limitations) && typeof payload.limitations[0] === "string" ? payload.limitations[0] : null,
  };
}

export async function runReviewVoc(input: {
  context: AccessContext;
  batchId: string;
  limit: number;
  targetAsin?: string | null;
  targetAsins?: ReadonlySet<string> | null;
  forceRecapture?: boolean;
  deps: BatchReviewVocDeps;
}): Promise<BatchReviewVocRunResult> {
  const { context, batchId, limit, targetAsin = null, targetAsins = null, forceRecapture = false, deps } = input;
  const store = deps.getStore(context);
  const batch = await store.getBatch(batchId);
  if (!batch) throw new V5CoreError("BATCH_NOT_FOUND", "批次不存在。", 404);
  if (batch.batchStatus === "archived") throw new V5CoreError("BATCH_ARCHIVED", "批次已归档，不能补齐。", 409);
  if (batch.batchStatus === "blocked") throw new V5CoreError("BATCH_BLOCKED", "批次处于 blocked 状态，不能补齐。", 409);
  if (batch.batchStatus !== "ready") throw new V5CoreError("BATCH_NOT_READY", "批次尚未就绪，不能补齐。", 409, true);

  const items = (await store.getBatchItems(batchId))
    .filter((item) => !item.archivedAt && typeof item.asin === "string" && /^[A-Za-z0-9]{10}$/u.test(item.asin.trim()))
    .filter((item) => !targetAsin || item.asin?.trim().toUpperCase() === targetAsin)
    .filter((item) => !targetAsins || targetAsins.has((item.asin ?? "").trim().toUpperCase()))
    .sort((a, b) => a.ordinal - b.ordinal);
  if (targetAsin && items.length === 0) {
    throw new V5CoreError("ITEM_NOT_IN_BATCH", "目标 ASIN 不属于此商品批次。", 404);
  }
  const results: BatchReviewVocItemResult[] = [];
  const runId = `batch-review-voc-${randomUUID()}`;
  const newPending: ProductBatchItemView[] = [];
  const retryablePending: ProductBatchItemView[] = [];
  const priorFreshSessionAttemptsByAsin = new Map<string, number>();
  for (const item of items) {
    // 逐 ASIN 停止检查：暂停/中止后不再开始下一件商品。
    if (await deps.shouldStop?.()) break;
    const asin = (item.asin as string).trim().toUpperCase();
    const subject = await deps.getSubject(`amazon:US:${asin}`);
    const reviewAttachments = matchingReviewAttachments(subject, asin);
    priorFreshSessionAttemptsByAsin.set(asin, priorFreshSessionAttempts(reviewAttachments));
    const hadPriorEvidence = (subject?.attachments ?? []).some((attachment) => {
      const payload = attachment.payload;
      return isRecord(payload) && payload.module === MODULE && isRecord(payload.identity) && payload.identity.asin === asin;
    });
    const evidence = matchingReviewEvidence(subject, asin);
    if (evidence && !forceRecapture) {
      const result = existingResult(item, asin, evidence, runId);
      results.push(result);
      await deps.logEvent({ runId, batchId, item: result });
      continue;
    }
    (hadPriorEvidence && !forceRecapture ? retryablePending : newPending).push(item);
  }

  // First attempts always take priority over retries so repeated transient
  // failures in the first part of a batch cannot starve later ASINs.
  const pending = [...newPending, ...retryablePending];
  let humanAborted = false;
  let processed = 0;
  for (let offset = 0; offset < pending.length && processed < limit; offset += COLLECTOR_ASIN_LIMIT) {
    const group = pending.slice(offset, Math.min(offset + COLLECTOR_ASIN_LIMIT, pending.length, offset + (limit - processed)));
    if (group.length === 0) break;
    const asins = group.map((item) => (item.asin as string).trim().toUpperCase());
    const traceId = `${runId}:${randomUUID()}`;
    const freshSessionAttemptsRemainingByAsin = Object.fromEntries(asins.map((asin) => [
      asin,
      MAX_REVIEW_FRESH_SESSION_ATTEMPTS - (priorFreshSessionAttemptsByAsin.get(asin) ?? 0),
    ]));
    // 分组导航前停止检查：暂停后不再发起下一组页面导航。
    if (await deps.shouldStop?.()) break;
    let capture: ReviewCollection;
    try {
      capture = await deps.collect({
        context,
        traceId,
        asins: asins.map((asin) => ({ asin, role: "current_candidate" as const })),
        freshSessionAttemptsRemainingByAsin,
      });
    } catch {
      capture = {
        status: "failed", items: [], pageResults: [], errorCode: "PLAYWRIGHT_BROWSER_FAILED",
        errorMessage: "Playwright 评论采集异常；详情由本地 trace 追踪。", consoleErrors: 0, pageErrors: 0, browser: null,
      };
    }

    for (const item of group) {
      const asin = (item.asin as string).trim().toUpperCase();
      const page = pageErrorForAsin(capture, asin);
      const previousFreshSessionAttempts = priorFreshSessionAttemptsByAsin.get(asin) ?? 0;
      const diagnostics = page?.diagnostics ? page.diagnostics as unknown as Record<string, unknown> : null;
      const capturedFreshSessionAttempts = diagnostics?.freshSessionAttempts;
      const freshSessionAttempts = Number.isSafeInteger(capturedFreshSessionAttempts) && typeof capturedFreshSessionAttempts === "number"
        ? Math.min(MAX_REVIEW_FRESH_SESSION_ATTEMPTS, Math.max(previousFreshSessionAttempts, capturedFreshSessionAttempts))
        : previousFreshSessionAttempts;
      const captureDiagnostics = diagnostics || previousFreshSessionAttempts > 0
        ? {
          ...diagnostics,
          freshSessionAttempts,
          freshSessionAttemptsRemaining: MAX_REVIEW_FRESH_SESSION_ATTEMPTS - freshSessionAttempts,
          freshSessionBudgetExhausted: freshSessionAttempts >= MAX_REVIEW_FRESH_SESSION_ATTEMPTS,
        }
        : null;
      const reviews = capture.items.filter((review) => review.asin === asin).map(normalizeReview);
      const gate = moduleOutcome({ capture, page, reviews });
      const capturedAt = deps.now().toISOString();
      let reviewEvidence: { evidenceId: string; contentHash: string } | null = null;
      let moduleEvidence: { evidenceId: string; contentHash: string } | null = null;
      try {
        if (reviews.length > 0) {
          reviewEvidence = await deps.saveReviews({ context, subjectKey: `amazon:US:${asin}`, asin, capturedAt, traceId, reviews });
        }
        moduleEvidence = await deps.saveModule({
          context,
          subjectKey: `amazon:US:${asin}`,
          asin,
          capturedAt,
          traceId,
          provider: "Amazon",
          sourceUrl: page?.finalUrl ?? (typeof reviews[0]?.sourceUrl === "string" ? reviews[0].sourceUrl : null),
          outcome: gate.outcome,
          status: gate.status,
          limitation: gate.limitation,
          errorCode: gate.code,
          retryable: gate.retryable,
          reviews,
          captureDiagnostics,
        });
      } catch {
        moduleEvidence = null;
      }
      const status: BatchReviewVocStatus = !moduleEvidence
        ? "failed_retryable"
        : gate.outcome === "COMPLETE" ? "complete"
          : gate.outcome === "NO_DATA_WITH_EVIDENCE" ? "no_data_with_evidence"
            : gate.outcome === "FAILED_HUMAN" ? "failed_human"
              : gate.outcome === "FAILED_RETRYABLE" ? "failed_retryable"
                : gate.outcome === "FAILED_PERMANENT" ? "failed_permanent" : "blocked_with_evidence";
      const result: BatchReviewVocItemResult = {
        itemId: item.id,
        asin,
        status,
        retryable: !moduleEvidence || gate.retryable,
        reviewCount: reviews.length,
        evidenceId: moduleEvidence?.evidenceId ?? reviewEvidence?.evidenceId ?? null,
        evidenceVersion: moduleEvidence ? EVIDENCE_VERSION : null,
        contentHash: moduleEvidence?.contentHash ?? reviewEvidence?.contentHash ?? null,
        traceId,
        errorCode: gate.code,
        limitation: gate.limitation,
      };
      results.push(result);
      processed += 1;
      await deps.logEvent({ runId, batchId, item: result });
      if (gate.outcome === "FAILED_HUMAN") humanAborted = true;
    }
    if (humanAborted) break;
  }

  const summary = {
    requested: Math.min(limit, items.length),
    processed,
    complete: results.filter((item) => item.status === "complete").length,
    noDataWithEvidence: results.filter((item) => item.status === "no_data_with_evidence").length,
    blockedWithEvidence: results.filter((item) => item.status === "blocked_with_evidence").length,
    failedHuman: results.filter((item) => item.status === "failed_human").length,
    failedRetryable: results.filter((item) => item.status === "failed_retryable").length,
    failedPermanent: results.filter((item) => item.status === "failed_permanent").length,
    skippedExisting: results.filter((item) => item.status === "skipped_existing").length,
    humanAborted,
  };
  return { summary, items: results };
}

export async function enrichBatchWithReviewVoc(input: {
  context: AccessContext;
  batchId: unknown;
  limit: unknown;
  targetAsin?: unknown;
  targetAsins?: unknown;
  forceRecapture?: boolean;
  idempotencyKey: string;
  deps?: BatchReviewVocDeps;
  /** 受控停止检查（由 BatchCaptureRun 注入）；返回 true 时 Worker 立即停止领取新工作。 */
  shouldStop?: unknown;
}): Promise<{ value: BatchReviewVocRunResult; replayed: boolean; receiptId: string }> {
  if (input.context.mode !== "owner") throw new V5CoreError("FORBIDDEN", "当前主体不允许执行正式 Review/VOC 批次补齐。", 403);
  const batchId = normalizeBatchId(input.batchId);
  const limit = normalizeLimit(input.limit);
  const targetAsin = normalizeTargetAsin(input.targetAsin);
  const targetAsins = normalizeTargetAsins(input.targetAsins);
  const forceRecapture = input.forceRecapture === true;
  if (forceRecapture && !targetAsin) {
    throw new V5CoreError("TARGET_ASIN_REQUIRED", "强制重采 Review/VOC 时必须指定 targetAsin。", 400);
  }
  const baseDeps = input.deps ?? defaultDeps();
  const deps: BatchReviewVocDeps = typeof input.shouldStop === "function"
    ? { ...baseDeps, shouldStop: input.shouldStop as () => Promise<boolean> | boolean }
    : baseDeps;
  return withV5Receipt({
    context: input.context,
    operation: OPERATION,
    resourceKey: batchId,
    idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
    requestBody: { batchId, limit, targetAsin, targetAsins: targetAsins ? [...targetAsins].sort() : null, forceRecapture },
    execute: () => runReviewVoc({ context: input.context, batchId, limit, targetAsin, targetAsins, forceRecapture, deps }),
  });
}
