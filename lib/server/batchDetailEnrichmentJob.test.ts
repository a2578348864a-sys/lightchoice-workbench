import { describe, expect, it } from "vitest";

import {
  MAX_DETAIL_ITEMS_PER_RUN,
  deriveBatchDetailJobProgress,
  hasAmazonSearchDetailEnrichmentIntent,
  AMAZON_SEARCH_DETAIL_ENRICHMENT_INTENT_VERSION,
  selectNextBatchDetailItems,
  type PersistedBatchDetailJob,
} from "@/lib/server/batchDetailEnrichmentJob";

function jobWithItems(items: PersistedBatchDetailJob["items"]): PersistedBatchDetailJob {
  return {
    schemaVersion: "amazon-batch-detail-job.v1",
    jobId: "job-1",
    batchId: "batch-000001",
    status: "PENDING",
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    attemptCount: 0,
    lastErrorCode: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    nextRunAt: null,
    traceIds: [],
    items,
  };
}

function item(asin: string, overrides: Partial<PersistedBatchDetailJob["items"][number]> = {}) {
  return {
    itemId: `item-${asin}`,
    asin,
    status: "PENDING" as const,
    attemptCount: 0,
    nextAttemptAt: null,
    lastErrorCode: null,
    evidenceId: null,
    evidenceVersion: null,
    captureOrigin: null,
    traceId: null,
    runReceiptId: null,
    ...overrides,
  };
}

describe("Amazon batch detail job progress", () => {
  it("only treats explicitly marked new Amazon search batches as recoverable auto-enqueue intents", () => {
    expect(hasAmazonSearchDetailEnrichmentIntent({
      batchStatus: "ready",
      normalizedSnapshotJson: JSON.stringify({
        sourceType: "amazon_search_capture",
        detailEnrichmentIntent: {
          schemaVersion: AMAZON_SEARCH_DETAIL_ENRICHMENT_INTENT_VERSION,
          autoEnqueue: true,
        },
      }),
    })).toBe(true);
    expect(hasAmazonSearchDetailEnrichmentIntent({
      batchStatus: "ready",
      normalizedSnapshotJson: JSON.stringify({ sourceType: "amazon_search_capture" }),
    })).toBe(false);
    expect(hasAmazonSearchDetailEnrichmentIntent({
      batchStatus: "blocked",
      normalizedSnapshotJson: JSON.stringify({
        sourceType: "amazon_search_capture",
        detailEnrichmentIntent: {
          schemaVersion: AMAZON_SEARCH_DETAIL_ENRICHMENT_INTENT_VERSION,
          autoEnqueue: true,
        },
      }),
    })).toBe(false);
  });

  it("limits one scheduler run to 30 items", () => {
    const job = jobWithItems(Array.from({ length: 60 }, (_, index) => item(`B${String(index).padStart(9, "0")}`)));

    expect(MAX_DETAIL_ITEMS_PER_RUN).toBe(30);
    expect(selectNextBatchDetailItems(job, new Date("2026-10-08T00:00:00.000Z"), 60)).toHaveLength(30);
  });

  it("moves past retryable failures to process remaining pending items first", () => {
    const job = jobWithItems([
      item("B000000001", { status: "FAILED_RETRYABLE", attemptCount: 1, nextAttemptAt: "2026-10-09T00:00:00.000Z" }),
      item("B000000002", { status: "FAILED_RETRYABLE", attemptCount: 1, nextAttemptAt: "2026-10-08T00:00:00.000Z" }),
      item("B000000003"),
    ]);

    expect(selectNextBatchDetailItems(job, new Date("2026-10-08T12:00:00.000Z"), 1).map((entry) => entry.asin))
      .toEqual(["B000000003"]);
  });

  it("does not retry exhausted, permanent, human-required, or already enriched items automatically", () => {
    const job = jobWithItems([
      item("B000000001", { status: "FAILED_RETRYABLE", attemptCount: 3, nextAttemptAt: null }),
      item("B000000002", { status: "FAILED_PERMANENT" }),
      item("B000000003", { status: "HUMAN_REQUIRED" }),
      item("B000000004", { status: "ENRICHED" }),
      item("B000000005", { status: "CAPTURED_PARTIAL" }),
    ]);

    expect(selectNextBatchDetailItems(job, new Date("2026-10-08T12:00:00.000Z"), 30)).toEqual([]);
  });

  it("derives counts from persisted item states without treating evidence fields as complete facts", () => {
    const job = jobWithItems([
      item("B000000001", { status: "ENRICHED", captureOrigin: "CAPTURED_NOW" }),
      item("B000000002", { status: "CAPTURED_PARTIAL", captureOrigin: "REUSED_VALID_EVIDENCE" }),
      item("B000000003", { status: "FAILED_RETRYABLE" }),
      item("B000000004", { status: "FAILED_PERMANENT" }),
      item("B000000005", { status: "HUMAN_REQUIRED" }),
      item("B000000006", { status: "PENDING" }),
    ]);

    expect(deriveBatchDetailJobProgress(job)).toMatchObject({
      total: 6,
      processed: 5,
      enriched: 1,
      partial: 1,
      failedRetryable: 1,
      failedPermanent: 1,
      humanRequired: 1,
      pending: 1,
      reusedEvidence: 1,
      newlyCaptured: 1,
    });
  });
});
