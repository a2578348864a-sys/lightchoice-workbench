import { describe, expect, it, vi } from "vitest";
import { runReviewVoc, type BatchReviewVocDeps } from "@/lib/server/batchReviewVocEnrichmentService";
import type { AccessContext } from "@/lib/server/accessPassword";
import type { ProductBatchItemView, ProductBatchStore } from "@/lib/productBatchStore";
import type { EvidenceSubjectRecord } from "@/lib/sourceLayer/server/evidenceStore";

const OWNER = { mode: "owner", token: "" } as AccessContext;

function item(asin: string, ordinal: number): ProductBatchItemView {
  return {
    id: `item-${ordinal}`,
    batchId: "batch-review-voc-0001",
    productKey: `amazon:US:${asin}`,
    ordinal,
    asin,
    parentAsin: null,
    itemIdentityHash: "1".repeat(64),
    itemHash: "2".repeat(64),
    evidenceHash: "3".repeat(64),
    normalizedProductJson: JSON.stringify({ asin }),
    occurrenceProjectionJson: "{}",
    familyProjectionJson: "{}",
    rankingJson: "{}",
    provisionalDisposition: "insufficient_required_signals",
    researchPriority: "unranked_insufficient_evidence",
    evidenceStatus: "limited_evidence",
    promotionEligible: false,
    imageSnapshotJson: "{}",
    archivedAt: null,
    createdAt: "2026-10-07T00:00:00.000Z",
  };
}

function makeDeps(options: {
  items: ProductBatchItemView[];
  capture: Awaited<ReturnType<BatchReviewVocDeps["collect"]>>;
  existing?: Record<string, Array<Record<string, unknown>>>;
}) {
  const attachmentsByAsin = new Map<string, Array<Record<string, unknown>>>(
    Object.entries(options.existing ?? {}).map(([asin, attachments]) => [asin, [...attachments]]),
  );
  const collect = vi.fn<BatchReviewVocDeps["collect"]>(async (_input) => options.capture);
  const saveReviews = vi.fn(async ({ asin }: Parameters<BatchReviewVocDeps["saveReviews"]>[0]) => ({ evidenceId: `review-${asin}`, contentHash: "a".repeat(64) }));
  const saveModule = vi.fn(async (input: Parameters<BatchReviewVocDeps["saveModule"]>[0]) => {
    const attachment = {
      attachmentId: `module-${input.asin}-${attachmentsByAsin.get(input.asin)?.length ?? 0}`,
      contentHash: "b".repeat(64),
      capturedAt: input.capturedAt,
      payload: {
        module: "review_voc",
        identity: { asin: input.asin },
        limitations: [input.limitation],
        data: {
          outcome: input.outcome,
          traceId: input.traceId,
          reviewCount: input.reviews.length,
          captureDiagnostics: input.captureDiagnostics,
          error: input.errorCode ? { code: input.errorCode, retryable: input.retryable } : null,
        },
      },
    };
    attachmentsByAsin.set(input.asin, [...(attachmentsByAsin.get(input.asin) ?? []), attachment]);
    return { evidenceId: attachment.attachmentId, contentHash: attachment.contentHash };
  });
  const deps: BatchReviewVocDeps = {
    getStore: () => ({
      getBatch: async () => ({ id: "batch-review-voc-0001", batchStatus: "ready" }),
      getBatchItems: async () => options.items,
    } as unknown as Pick<ProductBatchStore, "getBatch" | "getBatchItems">),
    getSubject: async (subjectKey) => {
      const asin = subjectKey.split(":").at(-1) ?? "";
      const attachments = attachmentsByAsin.get(asin) ?? [];
      return { subjectKey, versions: [], attachments } as unknown as EvidenceSubjectRecord;
    },
    collect,
    saveReviews,
    saveModule,
    logEvent: vi.fn(async () => undefined),
    now: () => new Date("2026-10-07T07:00:00.000Z"),
  };
  return { deps, collect, saveReviews, saveModule };
}

const firstAsin = "B0AAAA0001";
const humanAsin = "B0BBBB0002";
const skippedAsin = "B0CCCC0003";

describe("ProductBatch Review/VOC enrichment", () => {
  it("writes module evidence per ASIN, preserves a human gate, and records unattempted peers as retryable", async () => {
    const deps = makeDeps({
      items: [item(firstAsin, 0), item(humanAsin, 1), item(skippedAsin, 2)],
      capture: {
        status: "captured",
        items: [{
          asin: firstAsin,
          role: "current_candidate",
          rating: 5,
          date: "2026-10-01",
          title: "Good fit",
          reviewText: "Good fit and comfortable.",
          verifiedPurchase: true,
          sourceUrl: `https://www.amazon.com/dp/${firstAsin}`,
          bindingNote: "public top reviews",
        }],
        pageResults: [
          { asin: firstAsin, status: "ok", note: null, extractedCount: 1, finalUrl: `https://www.amazon.com/dp/${firstAsin}` },
          { asin: humanAsin, status: "captcha_required", note: "captcha", extractedCount: 0, finalUrl: `https://www.amazon.com/dp/${humanAsin}` },
          { asin: skippedAsin, status: "not_attempted_human_gate", note: "paused", extractedCount: 0 },
        ],
        errorCode: "CAPTCHA_DETECTED",
        errorMessage: "human gate",
        consoleErrors: 0,
        pageErrors: 0,
        browser: null,
      },
    });

    const result = await runReviewVoc({ context: OWNER, batchId: "batch-review-voc-0001", limit: 3, deps: deps.deps });

    expect(deps.collect).toHaveBeenCalledWith(expect.objectContaining({ asins: [
      { asin: firstAsin, role: "current_candidate" },
      { asin: humanAsin, role: "current_candidate" },
      { asin: skippedAsin, role: "current_candidate" },
    ] }));
    expect(deps.saveReviews).toHaveBeenCalledTimes(1);
    expect(deps.saveReviews.mock.calls[0]?.[0].reviews[0]).toMatchObject({ evidenceLevel: "REVIEW_SNIPPET_PARTIAL", completeness: "partial" });
    expect(deps.saveModule).toHaveBeenCalledTimes(3);
    expect(result.items.map((entry) => entry.status)).toEqual(["complete", "failed_human", "blocked_with_evidence"]);
    expect(result.items[1]).toMatchObject({ errorCode: "CAPTCHA_DETECTED", retryable: false });
    expect(result.items[2]).toMatchObject({ errorCode: "HUMAN_GATE_PAUSE", retryable: true });
    expect(result.summary.humanAborted).toBe(true);
  });

  it("skips terminal module evidence but retries evidence explicitly marked retryable", async () => {
    const doneAsin = firstAsin;
    const humanAsinPrior = humanAsin;
    const retryAsin = skippedAsin;
    const existing = (asin: string, retryable: boolean, outcome: string) => [{
      attachmentId: `prior-${asin}`,
      contentHash: "c".repeat(64),
      payload: {
        module: "review_voc",
        identity: { asin },
        limitations: ["prior"],
        data: { outcome, traceId: "prior-trace", reviewCount: 0, error: { code: "NETWORK_ERROR", retryable } },
      },
    }];
    const deps = makeDeps({
      items: [item(doneAsin, 0), item(humanAsinPrior, 1), item(retryAsin, 2)],
      existing: {
        [doneAsin]: existing(doneAsin, false, "COMPLETE"),
        [humanAsinPrior]: existing(humanAsinPrior, false, "FAILED_HUMAN"),
        [retryAsin]: existing(retryAsin, true, "FAILED_RETRYABLE"),
      },
      capture: {
        status: "captured",
        items: [],
        pageResults: [{ asin: retryAsin, status: "confirmed_no_reviews", note: "none", extractedCount: 0, finalUrl: `https://www.amazon.com/dp/${retryAsin}` }],
        errorCode: "REVIEW_SOURCE_UNAVAILABLE",
        errorMessage: "no public review",
        consoleErrors: 0,
        pageErrors: 0,
        browser: null,
      },
    });

    const result = await runReviewVoc({ context: OWNER, batchId: "batch-review-voc-0001", limit: 3, deps: deps.deps });

    expect(deps.collect).toHaveBeenCalledTimes(1);
    expect(deps.collect.mock.calls[0]?.[0].asins).toEqual([{ asin: retryAsin, role: "current_candidate" }]);
    expect(result.summary.skippedExisting).toBe(2);
    expect(result.items.find((entry) => entry.asin === retryAsin)?.status).toBe("no_data_with_evidence");
  });

  it("recollects one explicitly selected ASIN even when its prior module evidence was terminal", async () => {
    const selectedAsin = firstAsin;
    const otherAsin = humanAsin;
    const prior = {
      attachmentId: `prior-${selectedAsin}`,
      contentHash: "c".repeat(64),
      payload: {
        module: "review_voc",
        identity: { asin: selectedAsin },
        limitations: [],
        data: { outcome: "COMPLETE", traceId: "prior-trace", reviewCount: 1, error: null },
      },
    };
    const deps = makeDeps({
      items: [item(selectedAsin, 0), item(otherAsin, 1)],
      existing: { [selectedAsin]: [prior] },
      capture: {
        status: "captured",
        items: [{
          asin: selectedAsin, role: "current_candidate", rating: 5, date: "2026-10-01", title: "New review",
          reviewText: "A current public review snippet.", verifiedPurchase: true,
          sourceUrl: `https://www.amazon.com/dp/${selectedAsin}`, bindingNote: "public top reviews",
        }],
        pageResults: [{ asin: selectedAsin, status: "ok", note: null, extractedCount: 1, finalUrl: `https://www.amazon.com/dp/${selectedAsin}` }],
        errorCode: null, errorMessage: null, consoleErrors: 0, pageErrors: 0, browser: null,
      },
    });

    const result = await runReviewVoc({
      context: OWNER, batchId: "batch-review-voc-0001", limit: 1,
      targetAsin: selectedAsin, forceRecapture: true, deps: deps.deps,
    });

    expect(deps.collect).toHaveBeenCalledTimes(1);
    expect(deps.collect.mock.calls[0]?.[0].asins).toEqual([{ asin: selectedAsin, role: "current_candidate" }]);
    expect(result.items.map((entry) => entry.asin)).toEqual([selectedAsin]);
    expect(result.items[0]?.status).toBe("complete");
    expect(result.summary.skippedExisting).toBe(0);
  });

  it("passes only the remaining cumulative fresh-session budget for retryable evidence", async () => {
    const asin = firstAsin;
    const deps = makeDeps({
      items: [item(asin, 0)],
      existing: {
        [asin]: [{
          attachmentId: `prior-${asin}`,
          contentHash: "d".repeat(64),
          capturedAt: "2026-10-07T06:00:00.000Z",
          payload: {
            module: "review_voc",
            identity: { asin },
            data: {
              captureDiagnostics: { strategy: "fresh_context", freshSessionAttempts: 1 },
              error: { code: "REVIEW_EXTRACTION_EMPTY", retryable: true },
            },
          },
        }],
      },
      capture: {
        status: "failed",
        items: [],
        pageResults: [{ asin, status: "page_changed", note: "session not ready", extractedCount: 0 }],
        errorCode: "REVIEW_SOURCE_UNAVAILABLE",
        errorMessage: "session not ready",
        consoleErrors: 0,
        pageErrors: 0,
        browser: null,
      },
    });

    await runReviewVoc({ context: OWNER, batchId: "batch-review-voc-0001", limit: 1, deps: deps.deps });

    expect(deps.collect).toHaveBeenCalledWith(expect.objectContaining({
      freshSessionAttemptsRemainingByAsin: { [asin]: 2 },
    }));
  });

  it("keeps a forced recapture inside the exhausted fresh-session budget", async () => {
    const asin = firstAsin;
    const deps = makeDeps({
      items: [item(asin, 0)],
      existing: {
        [asin]: [{
          attachmentId: `prior-${asin}`,
          contentHash: "e".repeat(64),
          capturedAt: "2026-10-07T06:00:00.000Z",
          payload: {
            module: "review_voc",
            identity: { asin },
            data: {
              captureDiagnostics: { strategy: "fresh_context", freshSessionAttempts: 3 },
              error: { code: "REVIEW_EXTRACTION_EMPTY", retryable: true },
            },
          },
        }],
      },
      capture: {
        status: "failed",
        items: [],
        pageResults: [{ asin, status: "page_changed", note: "persistent session remains available", extractedCount: 0 }],
        errorCode: "REVIEW_SOURCE_UNAVAILABLE",
        errorMessage: "persistent session remains available",
        consoleErrors: 0,
        pageErrors: 0,
        browser: null,
      },
    });

    await runReviewVoc({
      context: OWNER,
      batchId: "batch-review-voc-0001",
      limit: 1,
      targetAsin: asin,
      forceRecapture: true,
      deps: deps.deps,
    });

    expect(deps.collect).toHaveBeenCalledWith(expect.objectContaining({
      asins: [{ asin, role: "current_candidate" }],
      freshSessionAttemptsRemainingByAsin: { [asin]: 0 },
    }));
    expect(deps.saveModule).toHaveBeenCalledWith(expect.objectContaining({
      captureDiagnostics: expect.objectContaining({
        freshSessionAttempts: 3,
        freshSessionAttemptsRemaining: 0,
        freshSessionBudgetExhausted: true,
      }),
    }));
  });

  it("keeps an empty review extraction retryable and stores only safe collector diagnostics", async () => {
    const asin = firstAsin;
    const deps = makeDeps({
      items: [item(asin, 0)],
      capture: {
        status: "failed",
        items: [],
        pageResults: [{
          asin,
          status: "extraction_empty",
          note: "review extraction incomplete",
          extractedCount: 0,
          finalUrl: `https://www.amazon.com/dp/${asin}`,
          diagnostics: {
            pageStatus: "ok",
            bindingReason: null,
            identityProof: { urlMatchesExpected: true, pageAnchorMatchesExpected: true, productContainerFound: true },
            readiness: { productTitlePresent: true, reviewNodeCount: 0, bodyNodeCount: 0, explicitNoReviews: false, elapsedMs: 8000, retryAttempt: 1, scrollTriggered: true },
          },
        }],
        errorCode: "REVIEW_SOURCE_UNAVAILABLE",
        errorMessage: "no public review snippet",
        consoleErrors: 0,
        pageErrors: 0,
        browser: null,
      },
    });

    const result = await runReviewVoc({ context: OWNER, batchId: "batch-review-voc-0001", limit: 1, deps: deps.deps });

    expect(result.items[0]).toMatchObject({ status: "failed_retryable", errorCode: "REVIEW_EXTRACTION_EMPTY", retryable: true });
    expect(deps.saveModule).toHaveBeenCalledWith(expect.objectContaining({
      captureDiagnostics: expect.objectContaining({
        pageStatus: "ok",
        identityProof: expect.objectContaining({ urlMatchesExpected: true }),
        readiness: expect.objectContaining({ reviewNodeCount: 0, explicitNoReviews: false }),
      }),
    }));
  });

  it("retries older extraction-empty evidence written before the retryability fix", async () => {
    const asin = firstAsin;
    const deps = makeDeps({
      items: [item(asin, 0)],
      existing: {
        [asin]: [{
          attachmentId: `prior-${asin}`,
          contentHash: "d".repeat(64),
          payload: {
            module: "review_voc",
            identity: { asin },
            limitations: ["review_page_extraction_empty"],
            data: { outcome: "BLOCKED_WITH_EVIDENCE", traceId: "prior-trace", reviewCount: 0, error: { code: "REVIEW_EXTRACTION_EMPTY", retryable: false } },
          },
        }],
      },
      capture: {
        status: "captured",
        items: [],
        pageResults: [{ asin, status: "confirmed_no_reviews", note: "none", extractedCount: 0 }],
        errorCode: "REVIEW_SOURCE_UNAVAILABLE",
        errorMessage: "no public review",
        consoleErrors: 0,
        pageErrors: 0,
        browser: null,
      },
    });

    const result = await runReviewVoc({ context: OWNER, batchId: "batch-review-voc-0001", limit: 1, deps: deps.deps });

    expect(deps.collect).toHaveBeenCalledTimes(1);
    expect(result.summary.skippedExisting).toBe(0);
    expect(result.items[0]?.status).toBe("no_data_with_evidence");
  });

  it("permanently blocks review attribution when the page ASIN anchor conflicts", async () => {
    const asin = firstAsin;
    const deps = makeDeps({
      items: [item(asin, 0)],
      capture: {
        status: "failed",
        items: [],
        pageResults: [{
          asin,
          status: "page_unknown",
          note: "identity conflict",
          extractedCount: 0,
          finalUrl: `https://www.amazon.com/dp/${asin}`,
          diagnostics: {
            pageStatus: "ok",
            bindingReason: "page_asin_anchor_mismatch",
            identityProof: { urlMatchesExpected: true, pageAnchorMatchesExpected: false, productContainerFound: true },
          },
        }],
        errorCode: "REVIEW_SOURCE_UNAVAILABLE",
        errorMessage: "review page identity conflict",
        consoleErrors: 0,
        pageErrors: 0,
        browser: null,
      },
    });

    const result = await runReviewVoc({ context: OWNER, batchId: "batch-review-voc-0001", limit: 1, deps: deps.deps });

    expect(result.items[0]).toMatchObject({ status: "failed_permanent", errorCode: "ASIN_PAGE_ANCHOR_MISMATCH", retryable: false });
  });

  it("revalidates legacy ASIN anchor mismatches once and then keeps the current strict result", async () => {
    const asin = firstAsin;
    const deps = makeDeps({
      items: [item(asin, 0)],
      existing: {
        [asin]: [{
          attachmentId: `legacy-${asin}`,
          contentHash: "f".repeat(64),
          capturedAt: "2026-10-06T07:00:00.000Z",
          payload: {
            module: "review_voc",
            identity: { asin },
            limitations: ["page_asin_anchor_mismatch"],
            data: {
              outcome: "FAILED_PERMANENT",
              traceId: "legacy-trace",
              reviewCount: 0,
              captureDiagnostics: { bindingReason: "page_asin_anchor_mismatch" },
              error: { code: "ASIN_PAGE_ANCHOR_MISMATCH", retryable: false },
            },
          },
        }],
      },
      capture: {
        status: "failed",
        items: [],
        pageResults: [{
          asin,
          status: "page_unknown",
          note: "current identity conflict",
          extractedCount: 0,
          diagnostics: {
            identityCheckVersion: "review-page-identity.v2",
            bindingReason: "page_asin_anchor_mismatch",
            identityProof: { urlMatchesExpected: true, pageAnchorMatchesExpected: false, productContainerFound: true },
          },
        }],
        errorCode: "REVIEW_SOURCE_UNAVAILABLE",
        errorMessage: "identity mismatch persists",
        consoleErrors: 0,
        pageErrors: 0,
        browser: null,
      },
    });

    const result = await runReviewVoc({ context: OWNER, batchId: "batch-review-voc-0001", limit: 1, deps: deps.deps });

    expect(deps.collect).toHaveBeenCalledTimes(1);
    expect(result.items[0]).toMatchObject({ status: "failed_permanent", errorCode: "ASIN_PAGE_ANCHOR_MISMATCH", retryable: false });
    const secondRun = await runReviewVoc({ context: OWNER, batchId: "batch-review-voc-0001", limit: 1, deps: deps.deps });
    expect(deps.collect).toHaveBeenCalledTimes(1);
    expect(secondRun.items[0]).toMatchObject({ status: "skipped_existing", retryable: false });
  });

  it("keeps a fresh Amazon homepage session change retryable", async () => {
    const asin = firstAsin;
    const deps = makeDeps({
      items: [item(asin, 0)],
      capture: {
        status: "failed",
        items: [],
        pageResults: [{ asin, status: "page_changed", note: "home markers unavailable", extractedCount: 0 }],
        errorCode: "REVIEW_SOURCE_UNAVAILABLE",
        errorMessage: "fresh session was not ready",
        consoleErrors: 0,
        pageErrors: 0,
        browser: null,
      },
    });

    const result = await runReviewVoc({ context: OWNER, batchId: "batch-review-voc-0001", limit: 1, deps: deps.deps });

    expect(result.items[0]).toMatchObject({ status: "failed_retryable", errorCode: "AMAZON_PAGE_CHANGED", retryable: true });
  });

  it("processes never-attempted ASINs before retryable evidence to prevent batch starvation", async () => {
    const retryAsin = firstAsin;
    const newAsin = humanAsin;
    const deps = makeDeps({
      items: [item(retryAsin, 0), item(newAsin, 1)],
      existing: {
        [retryAsin]: [{
          attachmentId: `prior-${retryAsin}`,
          contentHash: "e".repeat(64),
          payload: {
            module: "review_voc",
            identity: { asin: retryAsin },
            limitations: ["review_page_unknown_page"],
            data: { outcome: "FAILED_RETRYABLE", traceId: "prior-trace", reviewCount: 0, error: { code: "REVIEW_SOURCE_UNAVAILABLE", retryable: true } },
          },
        }],
      },
      capture: {
        status: "captured",
        items: [],
        pageResults: [{ asin: newAsin, status: "confirmed_no_reviews", note: "none", extractedCount: 0 }],
        errorCode: "REVIEW_SOURCE_UNAVAILABLE",
        errorMessage: "no public review",
        consoleErrors: 0,
        pageErrors: 0,
        browser: null,
      },
    });

    await runReviewVoc({ context: OWNER, batchId: "batch-review-voc-0001", limit: 1, deps: deps.deps });

    expect(deps.collect.mock.calls[0]?.[0].asins).toEqual([{ asin: newAsin, role: "current_candidate" }]);
  });
});
