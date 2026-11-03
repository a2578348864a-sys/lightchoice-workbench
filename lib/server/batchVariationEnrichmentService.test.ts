import { describe, expect, it, vi } from "vitest";
import { runVariationEnrichment, type BatchVariationDeps } from "@/lib/server/batchVariationEnrichmentService";
import type { AccessContext } from "@/lib/server/accessPassword";
import type { ProductBatchItemView, ProductBatchStore } from "@/lib/productBatchStore";
import { SOURCE_EVIDENCE_ATTACHMENT_SCHEMA } from "@/lib/sourceLayer/evidenceAttachment";
import type { EvidenceSubjectRecord } from "@/lib/sourceLayer/server/evidenceStore";
import { buildV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import type { AmazonVariationPageCapture, RawVariationPage } from "@/tools/collectors/amazon/variation-page-extract";

const OWNER = { mode: "owner", token: "" } as AccessContext;
const BATCH_ID = "variation-batch-0001";
const ASINS = ["B0AAAA0001", "B0BBBB0002", "B0CCCC0003", "B0DDDD0004", "B0EEEE0005"];

function item(asin: string, ordinal: number): ProductBatchItemView {
  return {
    id: `item-${ordinal}`,
    batchId: BATCH_ID,
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

function capture(asin: string, status: AmazonVariationPageCapture["status"]): AmazonVariationPageCapture {
  const parentAsin = status === "COMPLETE" || status === "CAPTURED_PARTIAL" ? "B0PARENT001" : null;
  const variants = status === "COMPLETE" ? [{ asin, options: [{ dimensionKey: "size", label: "Size", value: "Large" }] }] : [];
  return {
    status,
    parentAsin,
    currentAsin: asin,
    dimensions: status === "COMPLETE" ? [{ key: "size", label: "Size", options: ["Large"] }] : [],
    variantAsins: status === "COMPLETE" ? [asin] : [],
    variants,
    sourceUrl: `https://www.amazon.com/dp/${asin}`,
    capturedAt: "2026-10-07T07:00:00.000Z",
    identityProof: { urlAsin: asin, pageAsin: asin, productContainerFound: true, bound: true },
    diagnostics: {
      variationRootFound: status === "COMPLETE",
      jsonStateFound: status === "COMPLETE",
      mappedVariantCount: variants.length,
      labeledDimensionCount: status === "COMPLETE" ? 1 : 0,
      domDimensionCount: 0,
      authoritativeDimensionOrder: false,
      authoritativeDimensionOrderSource: null,
      jsonScriptsMatched: status === "COMPLETE" ? 1 : 0,
      jsonFieldsParsed: [],
      everyMappedVariantHasDimensions: status === "COMPLETE",
      currentVariantMapped: status === "COMPLETE",
      asinMapKeys: [],
      valueMapKeys: [],
      valueMapLengths: {},
    },
  };
}

function pageResult(
  asin: string,
  status: AmazonVariationPageCapture["status"],
  persisted = true,
  rawVariationSignals?: RawVariationPage,
) {
  return {
    asin,
    capture: capture(asin, status),
    rawVariationSignals,
    evidenceId: persisted ? `evidence-${asin}` : null,
    contentHash: persisted ? "a".repeat(64) : null,
    errorCode: status === "HUMAN_REQUIRED" ? "CAPTCHA_REQUIRED" : null,
    consoleErrors: 0,
    pageErrors: 0,
    elapsedMs: 15,
  };
}

function attachment(asin: string, outcome: string, options: { retryable?: boolean; capturedAt?: string } = {}) {
  const capturedAt = options.capturedAt ?? "2026-10-06T00:00:00.000Z";
  const parentAsin = outcome === "COMPLETE" ? "B0PARENT01" : null;
  const complete = outcome === "COMPLETE";
  const human = outcome === "FAILED_HUMAN";
  const retryable = options.retryable === true || outcome === "FAILED_RETRYABLE";
  const variantAsins = complete ? [asin, "B0PEER0001"] : [asin];
  const limitations = complete ? [] : [human ? "variation_requires_human" : retryable ? "variation_page_identity_not_bound" : "no_variation_with_evidence"];
  const payload = buildV3ModuleEvidence({
    module: "variation",
    subjectKey: `amazon:US:${asin}`,
    marketplace: "US",
    capturedAt,
    provider: "Amazon",
    sourceSurface: "Amazon product detail variation JSON and DOM",
    sourceUrl: `https://www.amazon.com/dp/${asin}`,
    acquisitionMode: "DOM_DIRECT",
    metricNature: "source_observed",
    status: complete ? "VALIDATED_AVAILABLE" : human ? "HUMAN_ACTION_REQUIRED" : retryable ? "BLOCKED_WITH_EVIDENCE" : "AVAILABLE_WITH_LIMITATION",
    limitations,
    identity: { asin, ...(parentAsin ? { parentAsin } : {}) },
    data: {
      outcome,
      variationStatus: complete ? "COMPLETE" : human ? "HUMAN_REQUIRED" : retryable ? "PAGE_CHANGED" : "NO_VARIATION_WITH_EVIDENCE",
      traceId: "previous-trace",
      currentAsin: asin,
      variantAsins,
      variants: variantAsins.map((variantAsin) => ({
        asin: variantAsin,
        options: complete ? [{ dimensionKey: "size", label: "Size", value: variantAsin === asin ? "Large" : "Small" }] : [],
      })),
      parentAsin,
      identityProof: {
        urlAsin: asin,
        pageAsin: asin,
        productContainerFound: true,
        bound: complete,
      },
      error: human || retryable ? { code: human ? "HUMAN_ACTION_REQUIRED" : "OLD_RETRY", retryable } : null,
    },
    evidenceOnly: true,
  });
  return {
    schemaVersion: SOURCE_EVIDENCE_ATTACHMENT_SCHEMA,
    attachmentId: `existing-${asin}-${outcome}`,
    subjectKey: `amazon:US:${asin}`,
    kind: "v3_variation_v1",
    sourceType: "amazon_dom",
    contentHash: "b".repeat(64),
    capturedAt,
    sourceUrl: `https://www.amazon.com/dp/${asin}`,
    sourceFingerprint: `variation:${asin}:${capturedAt}`,
    payload: payload as unknown as Record<string, unknown>,
  };
}

function withExistingData(attachmentRecord: Record<string, unknown>, changes: Record<string, unknown>) {
  const payload = attachmentRecord.payload as Record<string, unknown>;
  const data = payload.data as Record<string, unknown>;
  return { ...attachmentRecord, payload: { ...payload, data: { ...data, ...changes } } };
}

function makeDeps(options: {
  items: ProductBatchItemView[];
  collections: Array<Awaited<ReturnType<BatchVariationDeps["collect"]>>>;
  existing?: Record<string, Array<Record<string, unknown>>>;
}) {
  const attachmentsByAsin = new Map<string, Array<Record<string, unknown>>>(
    Object.entries(options.existing ?? {}).map(([asin, entries]) => [asin, [...entries]]),
  );
  let collectionIndex = 0;
  const collect = vi.fn<BatchVariationDeps["collect"]>(async () => options.collections[collectionIndex++]!);
  const saveModule = vi.fn<BatchVariationDeps["saveModule"]>(async (input) => {
    const entry = {
      attachmentId: `saved-${input.asin}-${attachmentsByAsin.get(input.asin)?.length ?? 0}`,
      contentHash: "c".repeat(64),
      capturedAt: input.capturedAt,
      payload: {
        module: "variation",
        identity: { asin: input.asin, ...(input.capture?.parentAsin ? { parentAsin: input.capture.parentAsin } : {}) },
        limitations: [input.limitation],
        data: {
          outcome: input.outcome,
          traceId: input.traceId,
          variantAsins: input.capture?.variantAsins ?? [],
          parentAsin: input.capture?.parentAsin ?? null,
          error: { code: input.errorCode, retryable: input.retryable },
        },
      },
    };
    attachmentsByAsin.set(input.asin, [...(attachmentsByAsin.get(input.asin) ?? []), entry]);
    return { evidenceId: entry.attachmentId, contentHash: entry.contentHash };
  });
  const deps: BatchVariationDeps = {
    getStore: () => ({
      getBatch: async () => ({ id: BATCH_ID, batchStatus: "ready" }),
      getBatchItems: async () => options.items,
    } as unknown as Pick<ProductBatchStore, "getBatch" | "getBatchItems">),
    getSubject: async (subjectKey) => {
      const asin = subjectKey.split(":").at(-1) ?? "";
      return { subjectKey, versions: [], attachments: attachmentsByAsin.get(asin) ?? [] } as unknown as EvidenceSubjectRecord;
    },
    collect,
    saveModule,
    logEvent: vi.fn(async () => undefined),
    now: () => new Date("2026-10-07T07:00:00.000Z"),
  };
  return { deps, collect, saveModule };
}

describe("ProductBatch Variation enrichment", () => {
  it("persists complete, partial, no-variation and human-gate states without treating unvisited ASINs as failed", async () => {
    const deps = makeDeps({
      items: ASINS.map(item),
      collections: [{
        status: "human_required",
        results: [
          pageResult(ASINS[0]!, "COMPLETE"),
          pageResult(ASINS[1]!, "CAPTURED_PARTIAL"),
          pageResult(ASINS[2]!, "NO_VARIATION_WITH_EVIDENCE"),
          pageResult(ASINS[3]!, "HUMAN_REQUIRED"),
          pageResult(ASINS[4]!, "NOT_ATTEMPTED", false),
        ],
        errorCode: "CAPTCHA_REQUIRED",
        humanAborted: true,
        consoleErrors: 0,
        pageErrors: 0,
        browser: null,
      }],
    });

    const result = await runVariationEnrichment({ context: OWNER, batchId: BATCH_ID, limit: 5, deps: deps.deps });

    expect(deps.collect).toHaveBeenCalledTimes(1);
    expect(deps.collect.mock.calls[0]?.[0].asins).toEqual(ASINS.map((asin) => ({ asin })));
    expect(result.items.map((entry) => entry.status)).toEqual([
      "complete", "captured_partial", "no_data_with_evidence", "failed_human", "not_attempted",
    ]);
    expect(result.summary).toMatchObject({ processed: 4, complete: 1, capturedPartial: 1, noDataWithEvidence: 1, failedHuman: 1, notAttempted: 1, humanAborted: true });
    expect(deps.saveModule).not.toHaveBeenCalled();
  });

  it("prioritizes never-attempted items before retryable evidence and skips terminal evidence", async () => {
    const retryAsin = ASINS[0]!;
    const terminalAsin = ASINS[1]!;
    const newAsin = ASINS[2]!;
    const deps = makeDeps({
      items: [item(retryAsin, 0), item(terminalAsin, 1), item(newAsin, 2)],
      existing: {
        [retryAsin]: [attachment(retryAsin, "FAILED_RETRYABLE", { retryable: true })],
        [terminalAsin]: [attachment(terminalAsin, "COMPLETE")],
      },
      collections: [{
        status: "captured", results: [pageResult(newAsin, "COMPLETE"), pageResult(retryAsin, "CAPTURED_PARTIAL")],
        errorCode: null, humanAborted: false, consoleErrors: 0, pageErrors: 0, browser: null,
      }],
    });

    const result = await runVariationEnrichment({ context: OWNER, batchId: BATCH_ID, limit: 2, deps: deps.deps });

    expect(deps.collect.mock.calls[0]?.[0].asins).toEqual([{ asin: newAsin }, { asin: retryAsin }]);
    expect(result.items.find((entry) => entry.asin === terminalAsin)?.status).toBe("skipped_existing");
    expect(result.summary).toMatchObject({ processed: 2, complete: 1, capturedPartial: 1, skippedExisting: 1 });
  });

  it("recollects latest variation evidence with unknown outcomes or mismatched page identity", async () => {
    const unknownAsin = ASINS[0]!;
    const identityConflictAsin = ASINS[1]!;
    const deps = makeDeps({
      items: [item(unknownAsin, 0), item(identityConflictAsin, 1)],
      existing: {
        [unknownAsin]: [attachment(unknownAsin, "UNKNOWN_OUTCOME")],
        [identityConflictAsin]: [withExistingData(attachment(identityConflictAsin, "COMPLETE"), { currentAsin: ASINS[2] })],
      },
      collections: [{
        status: "captured",
        results: [pageResult(unknownAsin, "COMPLETE"), pageResult(identityConflictAsin, "COMPLETE")],
        errorCode: null, humanAborted: false, consoleErrors: 0, pageErrors: 0, browser: null,
      }],
    });

    const result = await runVariationEnrichment({ context: OWNER, batchId: BATCH_ID, limit: 2, deps: deps.deps });

    expect(deps.collect.mock.calls[0]?.[0].asins).toEqual([{ asin: unknownAsin }, { asin: identityConflictAsin }]);
    expect(result.items.map((entry) => entry.status)).toEqual(["complete", "complete"]);
    expect(result.summary.skippedExisting).toBe(0);
  });

  it("recollects only the requested ASIN and can explicitly refresh terminal evidence", async () => {
    const selectedAsin = ASINS[1]!;
    const otherAsin = ASINS[2]!;
    const deps = makeDeps({
      items: [item(ASINS[0]!, 0), item(selectedAsin, 1), item(otherAsin, 2)],
      existing: { [selectedAsin]: [attachment(selectedAsin, "COMPLETE")] },
      collections: [{
        status: "captured", results: [pageResult(selectedAsin, "CAPTURED_PARTIAL")],
        errorCode: null, humanAborted: false, consoleErrors: 0, pageErrors: 0, browser: null,
      }],
    });

    const result = await runVariationEnrichment({
      context: OWNER, batchId: BATCH_ID, limit: 1, targetAsin: selectedAsin, forceRecapture: true, deps: deps.deps,
    });

    expect(deps.collect).toHaveBeenCalledTimes(1);
    expect(deps.collect.mock.calls[0]?.[0].asins).toEqual([{ asin: selectedAsin }]);
    expect(result.items.map((entry) => entry.asin)).toEqual([selectedAsin]);
    expect(result.items[0]?.status).toBe("captured_partial");
  });

  it("writes retryable EvidenceStore outcomes for setup failures that return no page result", async () => {
    const deps = makeDeps({
      items: [item(ASINS[0]!, 0), item(ASINS[1]!, 1)],
      collections: [{ status: "unavailable", results: [], errorCode: "BROWSER_NOT_FOUND", humanAborted: false, consoleErrors: 0, pageErrors: 0, browser: null }],
    });

    const result = await runVariationEnrichment({ context: OWNER, batchId: BATCH_ID, limit: 2, deps: deps.deps });

    expect(deps.saveModule).toHaveBeenCalledTimes(2);
    expect(result.items.map((entry) => entry.status)).toEqual(["failed_retryable", "failed_retryable"]);
    expect(result.items.every((entry) => entry.evidenceId !== null && entry.contentHash === "c".repeat(64))).toBe(true);
    expect(result.summary.failedRetryable).toBe(2);
  });

  it("preserves bounded source signals when the collector Evidence write needs the service fallback", async () => {
    const asin = ASINS[0]!;
    const rawVariationSignals: RawVariationPage = {
      dimensionToAsinMap: { "0_18": asin },
      dimensionValuesDisplayData: { [asin]: ["18 Ounces", "Navy"] },
      variationDisplayLabels: { size_name: "Size", color_name: "Color" },
    };
    const deps = makeDeps({
      items: [item(asin, 0)],
      collections: [{
        status: "captured", results: [pageResult(asin, "CAPTURED_PARTIAL", false, rawVariationSignals)],
        errorCode: null, humanAborted: false, consoleErrors: 0, pageErrors: 0, browser: null,
      }],
    });

    const result = await runVariationEnrichment({ context: OWNER, batchId: BATCH_ID, limit: 1, deps: deps.deps });

    expect(deps.saveModule).toHaveBeenCalledWith(expect.objectContaining({ rawVariationSignals }));
    expect(result.items[0]?.status).toBe("captured_partial");
  });

  it("does not persist fake per-ASIN failures when the session hits a human gate before any page is visited", async () => {
    const deps = makeDeps({
      items: [item(ASINS[0]!, 0), item(ASINS[1]!, 1)],
      collections: [{
        status: "human_required", results: [], errorCode: "CAPTCHA_REQUIRED", humanAborted: true,
        consoleErrors: 0, pageErrors: 0, browser: null,
      }],
    });

    const result = await runVariationEnrichment({ context: OWNER, batchId: BATCH_ID, limit: 2, deps: deps.deps });

    expect(deps.saveModule).not.toHaveBeenCalled();
    expect(result.items.map((entry) => entry.status)).toEqual(["not_attempted", "not_attempted"]);
    expect(result.items.every((entry) => entry.evidenceId === null && entry.contentHash === null)).toBe(true);
    expect(result.summary).toMatchObject({ processed: 0, notAttempted: 2, failedHuman: 0, humanAborted: true });
  });

  it("stops after a human gate and lists untouched later items as not attempted", async () => {
    const items = ASINS.concat(["B0FFFF0006", "B011111111"] as const).map(item);
    const deps = makeDeps({
      items,
      collections: [{
        status: "human_required",
        results: [
          pageResult(ASINS[0]!, "HUMAN_REQUIRED"),
          pageResult(ASINS[1]!, "NOT_ATTEMPTED", false),
          pageResult(ASINS[2]!, "NOT_ATTEMPTED", false),
          pageResult(ASINS[3]!, "NOT_ATTEMPTED", false),
          pageResult(ASINS[4]!, "NOT_ATTEMPTED", false),
        ],
        errorCode: "LOGIN_REQUIRED", humanAborted: true, consoleErrors: 0, pageErrors: 0, browser: null,
      }],
    });

    const result = await runVariationEnrichment({ context: OWNER, batchId: BATCH_ID, limit: 7, deps: deps.deps });

    expect(deps.collect).toHaveBeenCalledTimes(1);
    expect(result.summary).toMatchObject({ processed: 1, failedHuman: 1, notAttempted: 6, humanAborted: true });
    expect(result.items.filter((entry) => entry.status === "not_attempted")).toHaveLength(6);
    expect(result.items.filter((entry) => entry.status === "not_attempted").every((entry) => entry.evidenceId === null)).toBe(true);
  });
});
