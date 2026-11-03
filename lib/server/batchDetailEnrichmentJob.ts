import type { ProductBatchItemView, ProductBatchView } from "@/lib/productBatchStore";
import { readProductBatchDetailEnrichment } from "@/lib/sourceLayer/moduleStatusPresentation";

export const BATCH_DETAIL_JOB_SCHEMA_VERSION = "amazon-batch-detail-job.v1" as const;
export const AMAZON_SEARCH_DETAIL_ENRICHMENT_INTENT_VERSION = "amazon-search-detail-enrichment-intent.v1" as const;
export const MAX_DETAIL_ITEMS_PER_RUN = 30;
export const MAX_DETAIL_ITEM_AUTO_ATTEMPTS = 3;

export function hasAmazonSearchDetailEnrichmentIntent(batch: Pick<ProductBatchView, "normalizedSnapshotJson" | "batchStatus">): boolean {
  if (batch.batchStatus !== "ready" || !batch.normalizedSnapshotJson) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(batch.normalizedSnapshotJson) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(parsed) || parsed.sourceType !== "amazon_search_capture" || !isRecord(parsed.detailEnrichmentIntent)) return false;
  return parsed.detailEnrichmentIntent.schemaVersion === AMAZON_SEARCH_DETAIL_ENRICHMENT_INTENT_VERSION
    && parsed.detailEnrichmentIntent.autoEnqueue === true;
}

export type BatchDetailEnrichmentJobStatus =
  | "PENDING"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type BatchDetailEnrichmentJobItemStatus =
  | "PENDING"
  | "RUNNING"
  | "ENRICHED"
  | "CAPTURED_PARTIAL"
  | "FAILED_RETRYABLE"
  | "FAILED_PERMANENT"
  | "HUMAN_REQUIRED";

export type PersistedBatchDetailJobItem = {
  itemId: string;
  asin: string;
  status: BatchDetailEnrichmentJobItemStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  evidenceId: string | null;
  evidenceVersion: number | null;
  captureOrigin: "CAPTURED_NOW" | "REUSED_VALID_EVIDENCE" | null;
  traceId: string | null;
  runReceiptId: string | null;
};

export type PersistedBatchDetailJob = {
  schemaVersion: typeof BATCH_DETAIL_JOB_SCHEMA_VERSION;
  jobId: string;
  batchId: string;
  status: BatchDetailEnrichmentJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  attemptCount: number;
  lastErrorCode: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  nextRunAt: string | null;
  traceIds: string[];
  items: PersistedBatchDetailJobItem[];
};

export type BatchDetailJobProgress = {
  status: BatchDetailEnrichmentJobStatus;
  total: number;
  processed: number;
  enriched: number;
  partial: number;
  failedRetryable: number;
  failedPermanent: number;
  humanRequired: number;
  pending: number;
  running: number;
  reusedEvidence: number;
  newlyCaptured: number;
};

export function retryDelayMs(attemptCount: number): number {
  const normalizedAttempt = Number.isSafeInteger(attemptCount) ? Math.max(1, attemptCount) : 1;
  return Math.min(10 * 60_000, 30_000 * 2 ** (normalizedAttempt - 1));
}

export function createInitialBatchDetailJobItems(items: readonly ProductBatchItemView[]): PersistedBatchDetailJobItem[] {
  return items
    .filter((item) => !item.archivedAt && typeof item.asin === "string" && /^[A-Z0-9]{10}$/iu.test(item.asin.trim()))
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((item): PersistedBatchDetailJobItem => {
      const enrichment = readProductBatchDetailEnrichment(item.normalizedProductJson);
      return {
        itemId: item.id,
        asin: item.asin!.trim().toUpperCase(),
        status: enrichment?.status === "enriched" ? "ENRICHED" : enrichment?.status === "captured_partial" ? "CAPTURED_PARTIAL" : "PENDING",
        attemptCount: 0,
        nextAttemptAt: null,
        lastErrorCode: null,
        evidenceId: enrichment?.evidenceId ?? null,
        evidenceVersion: enrichment?.evidenceVersion ?? null,
        captureOrigin: enrichment?.captureOrigin ?? null,
        traceId: null,
        runReceiptId: null,
      };
    });
}

export function selectNextBatchDetailItems(
  job: PersistedBatchDetailJob,
  now: Date,
  limit = MAX_DETAIL_ITEMS_PER_RUN,
): PersistedBatchDetailJobItem[] {
  if (!Number.isSafeInteger(limit) || limit < 1) return [];
  const boundedLimit = Math.min(MAX_DETAIL_ITEMS_PER_RUN, limit);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return [];
  const pending = job.items.filter((item) => item.status === "PENDING");
  const dueRetries = job.items.filter((item) => (
    item.status === "FAILED_RETRYABLE"
    && item.attemptCount < MAX_DETAIL_ITEM_AUTO_ATTEMPTS
    && (item.nextAttemptAt === null || Date.parse(item.nextAttemptAt) <= nowMs)
  ));
  return [...pending, ...dueRetries].slice(0, boundedLimit);
}

export function deriveBatchDetailJobProgress(job: PersistedBatchDetailJob): BatchDetailJobProgress {
  const counts = {
    enriched: 0,
    partial: 0,
    failedRetryable: 0,
    failedPermanent: 0,
    humanRequired: 0,
    pending: 0,
    running: 0,
    reusedEvidence: 0,
    newlyCaptured: 0,
  };
  for (const item of job.items) {
    switch (item.status) {
      case "ENRICHED": counts.enriched += 1; break;
      case "CAPTURED_PARTIAL": counts.partial += 1; break;
      case "FAILED_RETRYABLE": counts.failedRetryable += 1; break;
      case "FAILED_PERMANENT": counts.failedPermanent += 1; break;
      case "HUMAN_REQUIRED": counts.humanRequired += 1; break;
      case "RUNNING": counts.running += 1; break;
      case "PENDING": counts.pending += 1; break;
    }
    if (item.captureOrigin === "REUSED_VALID_EVIDENCE") counts.reusedEvidence += 1;
    if (item.captureOrigin === "CAPTURED_NOW") counts.newlyCaptured += 1;
  }
  return {
    status: job.status,
    total: job.items.length,
    processed: job.items.length - counts.pending - counts.running,
    ...counts,
  };
}

export function parsePersistedBatchDetailJob(value: unknown): PersistedBatchDetailJob | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return null;
    }
  }
  if (!isRecord(parsed)
    || parsed.schemaVersion !== BATCH_DETAIL_JOB_SCHEMA_VERSION
    || typeof parsed.jobId !== "string"
    || typeof parsed.batchId !== "string"
    || !isJobStatus(parsed.status)
    || typeof parsed.createdAt !== "string"
    || typeof parsed.updatedAt !== "string"
    || !Array.isArray(parsed.items)) return null;
  const items = parsed.items.flatMap((entry) => {
    if (!isRecord(entry)
      || typeof entry.itemId !== "string"
      || typeof entry.asin !== "string"
      || !/^[A-Z0-9]{10}$/iu.test(entry.asin)
      || !isJobItemStatus(entry.status)
      || !Number.isSafeInteger(entry.attemptCount)
      || (entry.attemptCount as number) < 0) return [];
    return [{
      itemId: entry.itemId,
      asin: entry.asin.toUpperCase(),
      status: entry.status,
      attemptCount: entry.attemptCount as number,
      nextAttemptAt: nullableText(entry.nextAttemptAt),
      lastErrorCode: nullableText(entry.lastErrorCode),
      evidenceId: nullableText(entry.evidenceId),
      evidenceVersion: typeof entry.evidenceVersion === "number" && Number.isSafeInteger(entry.evidenceVersion) && entry.evidenceVersion > 0 ? entry.evidenceVersion : null,
      captureOrigin: nullableCaptureOrigin(entry.captureOrigin),
      traceId: nullableText(entry.traceId),
      runReceiptId: nullableText(entry.runReceiptId),
    }];
  });
  if (items.length !== parsed.items.length || new Set(items.map((item) => item.asin)).size !== items.length) return null;
  return {
    schemaVersion: BATCH_DETAIL_JOB_SCHEMA_VERSION,
    jobId: parsed.jobId,
    batchId: parsed.batchId,
    status: parsed.status,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    startedAt: nullableText(parsed.startedAt),
    finishedAt: nullableText(parsed.finishedAt),
    attemptCount: typeof parsed.attemptCount === "number" && Number.isSafeInteger(parsed.attemptCount) && parsed.attemptCount >= 0 ? parsed.attemptCount : 0,
    lastErrorCode: nullableText(parsed.lastErrorCode),
    leaseOwner: nullableText(parsed.leaseOwner),
    leaseExpiresAt: nullableText(parsed.leaseExpiresAt),
    nextRunAt: nullableText(parsed.nextRunAt),
    traceIds: Array.isArray(parsed.traceIds) ? parsed.traceIds.filter((item): item is string => typeof item === "string").slice(-100) : [],
    items,
  };
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableCaptureOrigin(value: unknown): PersistedBatchDetailJobItem["captureOrigin"] {
  return value === "CAPTURED_NOW" || value === "REUSED_VALID_EVIDENCE" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJobStatus(value: unknown): value is BatchDetailEnrichmentJobStatus {
  return value === "PENDING" || value === "RUNNING" || value === "PAUSED"
    || value === "COMPLETED" || value === "FAILED" || value === "CANCELLED";
}

function isJobItemStatus(value: unknown): value is BatchDetailEnrichmentJobItemStatus {
  return value === "PENDING" || value === "RUNNING" || value === "ENRICHED" || value === "CAPTURED_PARTIAL"
    || value === "FAILED_RETRYABLE" || value === "FAILED_PERMANENT" || value === "HUMAN_REQUIRED";
}
