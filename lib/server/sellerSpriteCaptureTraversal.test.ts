import { describe, expect, it } from "vitest";

import { decideSellerSpriteCaptureTraversal } from "@/lib/server/sellerSpriteCaptureTraversal";

const base = {
  page: 1,
  scrollY: 0,
  scrollTarget: "table" as const,
  clientHeight: 600,
  scrollHeight: 1_800,
  hasNextPage: false,
  nextPageDisabled: false,
  sourceLimitDeclared: false,
  reportedTotalRows: 120,
};

describe("SellerSprite visible capture traversal", () => {
  it("continues through a real scroll range even when this window adds no new row keys", () => {
    expect(decideSellerSpriteCaptureTraversal({
      state: base,
      capturedUniqueRows: 20,
      windowsProcessed: 2,
      maxWindows: 8,
    })).toEqual({ action: "scroll", limitationReason: "unknown" });
  });

  it("uses an explicit next page after a document-scroll window adds no unique rows", () => {
    expect(decideSellerSpriteCaptureTraversal({
      state: { ...base, scrollTarget: "document", hasNextPage: true },
      capturedUniqueRows: 50,
      newUniqueRowsInWindow: 0,
      windowsProcessed: 2,
      maxWindows: 8,
    })).toEqual({ action: "next_page", limitationReason: "unknown" });
  });

  it("keeps traversing an internal virtual table before changing pages", () => {
    expect(decideSellerSpriteCaptureTraversal({
      state: { ...base, hasNextPage: true },
      capturedUniqueRows: 50,
      newUniqueRowsInWindow: 0,
      windowsProcessed: 2,
      maxWindows: 8,
    })).toEqual({ action: "scroll", limitationReason: "unknown" });
  });

  it("treats an explicit visible next-page control as the continuation cursor", () => {
    expect(decideSellerSpriteCaptureTraversal({
      state: { ...base, scrollTarget: null, hasNextPage: true },
      capturedUniqueRows: 20,
      windowsProcessed: 1,
      maxWindows: 8,
    })).toEqual({ action: "next_page", limitationReason: "unknown" });
  });

  it("stops partial at a declared plan gate without estimating accessible rows", () => {
    expect(decideSellerSpriteCaptureTraversal({
      state: { ...base, sourceLimitDeclared: true, scrollHeight: 600 },
      capturedUniqueRows: 20,
      windowsProcessed: 1,
      maxWindows: 8,
    })).toEqual({ action: "stop", status: "PARTIAL", limitationReason: "source_limit_declared" });
  });

  it("does not treat the current scroll range as the source end while reported rows remain uncaptured", () => {
    expect(decideSellerSpriteCaptureTraversal({
      state: { ...base, scrollY: 1_200 },
      capturedUniqueRows: 20,
      windowsProcessed: 3,
      maxWindows: 8,
    })).toEqual({ action: "stop", status: "PARTIAL", limitationReason: "unknown" });

    expect(decideSellerSpriteCaptureTraversal({
      state: { ...base, scrollY: 1_200, nextPageDisabled: true },
      capturedUniqueRows: 20,
      windowsProcessed: 3,
      maxWindows: 8,
    })).toEqual({ action: "stop", status: "PARTIAL", limitationReason: "unknown" });

    expect(decideSellerSpriteCaptureTraversal({
      state: { ...base, scrollY: 1_200, nextPageDisabled: true },
      capturedUniqueRows: 120,
      windowsProcessed: 3,
      maxWindows: 8,
    })).toEqual({ action: "complete", limitationReason: "query_finished" });

    expect(decideSellerSpriteCaptureTraversal({
      state: { ...base, scrollTarget: null },
      capturedUniqueRows: 20,
      windowsProcessed: 1,
      maxWindows: 8,
    })).toEqual({ action: "stop", status: "PARTIAL", limitationReason: "unknown" });
  });

  it("does not infer a source terminal from a matching reported count without a visible terminal signal", () => {
    expect(decideSellerSpriteCaptureTraversal({
      state: {
        ...base,
        scrollTarget: null,
        hasNextPage: false,
        nextPageDisabled: false,
        reportedTotalRows: 20,
      },
      capturedUniqueRows: 20,
      windowsProcessed: 1,
      maxWindows: 8,
    })).toEqual({ action: "stop", status: "PARTIAL", limitationReason: "unknown" });
  });

  it("marks a finite-window cutoff as budget partial, not query completion", () => {
    expect(decideSellerSpriteCaptureTraversal({
      state: base,
      capturedUniqueRows: 20,
      windowsProcessed: 8,
      maxWindows: 8,
    })).toEqual({ action: "stop", status: "PARTIAL", limitationReason: "budget_stop" });
  });

  it("accepts a visible source terminal on the final budgeted window", () => {
    expect(decideSellerSpriteCaptureTraversal({
      state: {
        ...base,
        scrollTarget: null,
        nextPageDisabled: true,
        reportedTotalRows: 1,
      },
      capturedUniqueRows: 1,
      windowsProcessed: 1,
      maxWindows: 1,
    })).toEqual({ action: "complete", limitationReason: "query_finished" });

    expect(decideSellerSpriteCaptureTraversal({
      state: {
        ...base,
        scrollTarget: null,
        hasNextPage: true,
        nextPageDisabled: false,
      },
      capturedUniqueRows: 50,
      windowsProcessed: 1,
      maxWindows: 1,
    })).toEqual({ action: "stop", status: "PARTIAL", limitationReason: "budget_stop" });
  });
});
