import { describe, expect, it } from "vitest";

import { deriveMarketCaptureExpansionCounts } from "@/lib/sourceLayer/captureStrategy/marketCaptureExpansion";

const completedRun = {
  runId: "run-expanded-source-001",
  runGeneration: 1,
  version: 3,
  status: "COMPLETED" as const,
  executionEpoch: 1,
  acknowledgedEpoch: 1,
  leaseOwner: null,
  leaseExpiresAt: null,
};

function asins(count: number, start = 1): string[] {
  return Array.from({ length: count }, (_, index) => `B${String(index + start).padStart(9, "0")}`);
}

describe("market capture expansion counts", () => {
  it("plans 5 → 30 as 25 new search results on the next page", () => {
    const preview = deriveMarketCaptureExpansionCounts({
      currentAsins: asins(5),
      authorizedAsins: asins(5),
      targetTotal: 30,
      searchNavigationUsed: 1,
      validEvidenceCount: 5,
      detailCompletedAsins: asins(3),
      run: completedRun,
    });

    expect(preview).toMatchObject({
      currentItemCount: 5,
      currentAuthorizedItemCount: 5,
      targetTotal: 30,
      maxAdditionalSearchCount: 25,
      plannedAdditionalAuthorizationCount: 25,
      searchStartPage: 2,
      searchPageCount: 1,
      canConfirm: true,
      validEvidenceCount: 5,
      detailCompletedCount: 3,
    });
  });

  it("continues from the next unused page after a partial source result", () => {
    const preview = deriveMarketCaptureExpansionCounts({
      currentAsins: asins(23),
      authorizedAsins: asins(23),
      targetTotal: 30,
      searchNavigationUsed: 2,
      validEvidenceCount: 22,
      detailCompletedAsins: asins(7),
      run: { ...completedRun, runGeneration: 2 },
    });

    expect(preview).toMatchObject({
      currentItemCount: 23,
      maxAdditionalSearchCount: 7,
      plannedAdditionalAuthorizationCount: 7,
      searchStartPage: 3,
      searchPageCount: 1,
      canConfirm: true,
    });
  });

  it("blocks active executors and keeps human-required work eligible only after exit acknowledgment", () => {
    const active = deriveMarketCaptureExpansionCounts({
      currentAsins: asins(5),
      authorizedAsins: asins(5),
      targetTotal: 30,
      searchNavigationUsed: 1,
      validEvidenceCount: 5,
      detailCompletedAsins: [],
      run: { ...completedRun, status: "RUNNING", acknowledgedEpoch: 0 },
    });
    expect(active.blocker).toBe("run_still_running");

    const humanPending = deriveMarketCaptureExpansionCounts({
      currentAsins: asins(5),
      authorizedAsins: asins(5),
      targetTotal: 30,
      searchNavigationUsed: 1,
      validEvidenceCount: 5,
      detailCompletedAsins: [],
      run: { ...completedRun, status: "HUMAN_REQUIRED" },
    });
    expect(humanPending.canConfirm).toBe(true);
  });
});
