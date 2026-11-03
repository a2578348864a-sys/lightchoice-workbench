import { describe, expect, it } from "vitest";

import {
  bindSellerSpriteCaptureSnapshot,
  claimSellerSpriteCaptureJob,
  claimSellerSpriteSourceRecheck,
  cancelSellerSpriteCaptureJob,
  createSellerSpriteCaptureJob,
  pauseSellerSpriteCaptureJob,
  recordSellerSpriteCaptureProgress,
  resumeSellerSpriteCaptureJob,
  retrySellerSpriteCaptureJob,
  setSellerSpriteCaptureWindowBudget,
  type SellerSpriteCaptureJob,
} from "@/lib/server/sellerSpriteCaptureJob";

const NOW = new Date("2026-10-08T10:00:00.000Z");

function newJob(): SellerSpriteCaptureJob {
  return createSellerSpriteCaptureJob({
    module: "reverse_asin",
    marketplace: "US",
    query: { targetAsin: "B01L9X99GC" },
    accessScope: "owner",
  }, NOW);
}

describe("SellerSprite durable capture job contract", () => {
  it("persists long official subject URLs while retaining the ordinary query field bound", () => {
    const sourceUrl = `https://www.sellersprite.com/v3/competitor-lookup?asins=B01ACUA8HC&filters=${"a".repeat(200)}`;
    const input = { module: "sellersprite_product_market" as const, marketplace: "US" as const, accessScope: "owner", query: { kind: "single_subject_current_page", sourceUrl } };
    expect(createSellerSpriteCaptureJob(input).query.sourceUrl).toBe(sourceUrl);
    expect(() => createSellerSpriteCaptureJob({ ...input, query: { category: "a".repeat(161) } })).toThrow("SELLERSPRITE_CAPTURE_JOB_INPUT_INVALID");
    expect(() => createSellerSpriteCaptureJob({ ...input, query: { ...input.query, sourceUrl: "a".repeat(4097) } })).toThrow("SELLERSPRITE_CAPTURE_JOB_INPUT_INVALID");
  });
  it("only an explicit one-window recheck claims a source-limited job and preserves its checkpoint", () => {
    const blocked: SellerSpriteCaptureJob = { ...newJob(), status: "PARTIAL", limitationReason: "source_limit_declared", lastErrorCode: "PLAN_LIMIT", evidenceRefs: ["existing-evidence"] };
    expect(retrySellerSpriteCaptureJob(blocked, NOW)).toBeNull();
    const claim = claimSellerSpriteSourceRecheck(blocked, "user-recheck", NOW)!;
    expect(claim.job).toMatchObject({ status: "RUNNING", windowBudget: 1, limitationReason: "source_limit_declared", evidenceRefs: ["existing-evidence"] });
    expect(claim.job.sourceRechecks).toEqual([{ at: NOW.toISOString(), attemptGeneration: 0, status: "PARTIAL", limitationReason: "source_limit_declared", lastErrorCode: "PLAN_LIMIT" }]);
    expect(claimSellerSpriteSourceRecheck(claim.job, "second-click", NOW)).toBeNull();
    expect(claimSellerSpriteSourceRecheck(newJob(), "worker", NOW)).toBeNull();
    expect(blocked.status).toBe("PARTIAL");
  });
  it("binds a stable query fingerprint to module, query and access scope", () => {
    const first = newJob();
    const same = createSellerSpriteCaptureJob({
      module: "reverse_asin", marketplace: "US", query: { targetAsin: "B01L9X99GC" }, accessScope: "owner",
    }, NOW);
    const otherScope = createSellerSpriteCaptureJob({
      module: "reverse_asin", marketplace: "US", query: { targetAsin: "B01L9X99GC" }, accessScope: "demo:other",
    }, NOW);
    expect(first.queryFingerprint).toBe(same.queryFingerprint);
    expect(first.queryFingerprint).not.toBe(otherScope.queryFingerprint);
  });

  it("fences stale workers and persists deduplicated row keys and evidence refs", () => {
    const pending = newJob();
    const claim = claimSellerSpriteCaptureJob(pending, "worker-1", NOW, 30_000);
    expect(claim?.job.status).toBe("RUNNING");
    expect(claim?.fence).toBe(1);
    expect(recordSellerSpriteCaptureProgress(claim!.job, {
      worker: "worker-1", fence: 1, now: new Date(NOW.getTime() + 1),
      rowKeys: ["keyword:desk lamp", "keyword:desk lamp"],
      structuredValidRowKeys: ["keyword:desk lamp"], persistedRowKeys: ["keyword:desk lamp"], evidenceRefs: ["ev-1"],
      cursor: { page: 1, scrollY: 800 },
      counters: { capturedUniqueRows: 1, structuredValidRows: 1, persistedEvidenceRows: 1 },
    })?.rowKeys).toEqual(["keyword:desk lamp"]);
    expect(recordSellerSpriteCaptureProgress(claim!.job, {
      worker: "worker-0", fence: 0, now: new Date(NOW.getTime() + 1), rowKeys: ["keyword:other"],
      evidenceRefs: [], cursor: { page: 1, scrollY: 900 },
      counters: { capturedUniqueRows: 1, structuredValidRows: 1, persistedEvidenceRows: 1 },
    })).toBeNull();
  });

  it("keeps repeated row keys idempotent within one capture generation", () => {
    const claim = claimSellerSpriteCaptureJob(newJob(), "worker-1", NOW, 30_000)!;
    const first = recordSellerSpriteCaptureProgress(claim.job, {
      worker: "worker-1", fence: claim.fence, now: new Date(NOW.getTime() + 1),
      rowKeys: ["keyword:desk lamp"], structuredValidRowKeys: ["keyword:desk lamp"], evidenceRefs: [],
      cursor: { page: 1, scrollY: 500 }, counters: { capturedUniqueRows: 1, structuredValidRows: 1 },
    });
    expect(first).not.toBeNull();
    const repeated = recordSellerSpriteCaptureProgress(first!, {
      worker: "worker-1", fence: claim.fence, now: new Date(NOW.getTime() + 2),
      rowKeys: ["keyword:desk lamp"], structuredValidRowKeys: ["keyword:desk lamp"], evidenceRefs: [],
      cursor: { page: 1, scrollY: 500 }, counters: { capturedUniqueRows: 1, structuredValidRows: 1 },
    });

    expect(repeated?.structuredValidRowKeys).toEqual(["keyword:desk lamp"]);
    expect(repeated?.counters.structuredValidRows).toBe(1);
  });

  it("does not claim an unexpired lease and grants a new fence after expiry", () => {
    const first = claimSellerSpriteCaptureJob(newJob(), "worker-1", NOW, 1_000)!;
    expect(claimSellerSpriteCaptureJob(first.job, "worker-2", new Date(NOW.getTime() + 999), 1_000)).toBeNull();
    const reclaimed = claimSellerSpriteCaptureJob(first.job, "worker-2", new Date(NOW.getTime() + 1_000), 1_000);
    expect(reclaimed?.fence).toBe(2);
    expect(reclaimed?.job.attemptGeneration).toBe(2);
  });

  it("separates capture generation from worker retries and resets only when the visible snapshot changes", () => {
    const claimed = claimSellerSpriteCaptureJob(newJob(), "worker-1", NOW, 1_000)!;
    const firstSnapshot = bindSellerSpriteCaptureSnapshot(claimed.job, {
      worker: "worker-1", fence: claimed.fence, now: new Date(NOW.getTime() + 1),
      snapshotFingerprint: "a".repeat(64), reportedTotalRows: 10, accessibleRows: null, unavailableRows: null,
    })!;
    const captured = recordSellerSpriteCaptureProgress(firstSnapshot, {
      worker: "worker-1", fence: claimed.fence, now: new Date(NOW.getTime() + 2),
      rowKeys: ["generation:1:keyword-row"], structuredValidRowKeys: ["generation:1:keyword-row"],
      persistedRowKeys: ["generation:1:keyword-row"], evidenceRefs: ["attachment:first"],
      cursor: { page: 1, scrollY: 600, scrollTarget: "table" },
      counters: { capturedUniqueRows: 1, structuredValidRows: 1, persistedEvidenceRows: 1 },
      diagnostics: { actualVisibleRows: 20, windowsProcessed: 1 },
    })!;
    const recovered = claimSellerSpriteCaptureJob(captured, "worker-2", new Date(NOW.getTime() + 120_003), 1_000)!;
    expect(recovered.job.attemptGeneration).toBe(2);
    expect(recovered.job.captureGeneration).toBe(1);
    expect(recovered.job.cursor).toEqual({ page: 1, scrollY: 600, scrollTarget: "table" });
    expect(recovered.job.rowKeys).toEqual(["generation:1:keyword-row"]);
    expect(recovered.job.persistedRowKeys).toEqual(["generation:1:keyword-row"]);

    const changed = bindSellerSpriteCaptureSnapshot(recovered.job, {
      worker: "worker-2", fence: recovered.fence, now: new Date(NOW.getTime() + 120_004),
      snapshotFingerprint: "b".repeat(64), reportedTotalRows: 11, accessibleRows: null, unavailableRows: null,
    })!;
    expect(changed.captureGeneration).toBe(2);
    expect(changed.cursor).toBeNull();
    expect(changed.rowKeys).toEqual([]);
    expect(changed.persistedRowKeys).toEqual([]);
    expect(changed.evidenceRefs).toEqual(["attachment:first"]);
    expect(changed.counters).toMatchObject({ reportedTotalRows: 11, capturedUniqueRows: 0, persistedEvidenceRows: 0 });

    const rotated = bindSellerSpriteCaptureSnapshot(changed, {
      worker: "worker-2", fence: recovered.fence, now: new Date(NOW.getTime() + 120_005),
      snapshotFingerprint: "b".repeat(64), reportedTotalRows: 11, accessibleRows: null, unavailableRows: null,
      forceNewGeneration: true,
    })!;
    expect(rotated.captureGeneration).toBe(3);
    expect(rotated.snapshotFingerprint).toBe("b".repeat(64));
    expect(rotated.rowKeys).toEqual([]);
  });

  it("refreshes only coverage numbers when the same visible snapshot rebinds, never resetting counters or cursor", () => {
    const claimed = claimSellerSpriteCaptureJob(newJob(), "worker-1", NOW, 1_000)!;
    const bound = bindSellerSpriteCaptureSnapshot(claimed.job, {
      worker: "worker-1", fence: claimed.fence, now: new Date(NOW.getTime() + 1),
      snapshotFingerprint: "a".repeat(64), reportedTotalRows: 10, accessibleRows: null, unavailableRows: null,
    })!;
    const captured = recordSellerSpriteCaptureProgress(bound, {
      worker: "worker-1", fence: claimed.fence, now: new Date(NOW.getTime() + 2),
      rowKeys: ["generation:1:keyword-row"], structuredValidRowKeys: ["generation:1:keyword-row"],
      persistedRowKeys: ["generation:1:keyword-row"], evidenceRefs: ["attachment:first"],
      cursor: { page: 1, scrollY: 600, scrollTarget: "table" },
      counters: { capturedUniqueRows: 1, structuredValidRows: 1, persistedEvidenceRows: 1 },
      diagnostics: { actualVisibleRows: 20, windowsProcessed: 1 },
    })!;
    // 同一快照重复绑定（页面解析出的总量/可访问数字变化）只允许刷新覆盖数字：
    // 旧实现返回 null → 采集器抛 SELLERSPRITE_CAPTURE_SNAPSHOT_BINDING_FAILED；
    // 或被误重置 → 已保存的行显示成被清空。
    const rebound = bindSellerSpriteCaptureSnapshot(captured, {
      worker: "worker-1", fence: claimed.fence, now: new Date(NOW.getTime() + 3),
      snapshotFingerprint: "a".repeat(64), reportedTotalRows: 12, accessibleRows: 9, unavailableRows: 3,
    })!;
    expect(rebound.captureGeneration).toBe(1);
    expect(rebound.snapshotFingerprint).toBe("a".repeat(64));
    expect(rebound.cursor).toEqual({ page: 1, scrollY: 600, scrollTarget: "table" });
    expect(rebound.rowKeys).toEqual(["generation:1:keyword-row"]);
    expect(rebound.persistedRowKeys).toEqual(["generation:1:keyword-row"]);
    expect(rebound.evidenceRefs).toEqual(["attachment:first"]);
    expect(rebound.counters).toMatchObject({
      reportedTotalRows: 12, accessibleRows: 9, unavailableRows: 3,
      capturedUniqueRows: 1, structuredValidRows: 1, persistedEvidenceRows: 1,
    });
    // 覆盖数字完全一致时幂等返回同一状态。
    expect(bindSellerSpriteCaptureSnapshot(rebound, {
      worker: "worker-1", fence: claimed.fence, now: new Date(NOW.getTime() + 4),
      snapshotFingerprint: "a".repeat(64), reportedTotalRows: 12, accessibleRows: 9, unavailableRows: 3,
    })).toEqual(rebound);
  });

  it("rejects invalid coverage counts before binding a new visible snapshot", () => {
    const claimed = claimSellerSpriteCaptureJob(newJob(), "worker-1", NOW, 1_000)!;
    const base = {
      worker: "worker-1",
      fence: claimed.fence,
      now: new Date(NOW.getTime() + 1),
      snapshotFingerprint: "a".repeat(64),
    };
    const invalidCoverage = [
      { reportedTotalRows: -1, accessibleRows: null, unavailableRows: null },
      { reportedTotalRows: 1.5, accessibleRows: null, unavailableRows: null },
      { reportedTotalRows: Number.MAX_SAFE_INTEGER + 1, accessibleRows: null, unavailableRows: null },
      { reportedTotalRows: Number.NaN, accessibleRows: null, unavailableRows: null },
      { reportedTotalRows: 10, accessibleRows: -1, unavailableRows: null },
      { reportedTotalRows: 10, accessibleRows: 11, unavailableRows: null },
      { reportedTotalRows: 10, accessibleRows: null, unavailableRows: 11 },
      { reportedTotalRows: 10, accessibleRows: 7, unavailableRows: 4 },
    ];

    for (const counters of invalidCoverage) {
      expect(bindSellerSpriteCaptureSnapshot(claimed.job, { ...base, ...counters })).toBeNull();
    }
  });

  it("rejects unavailable counts outside the reported scope when saving progress", () => {
    const claimed = claimSellerSpriteCaptureJob(newJob(), "worker-1", NOW, 1_000)!;
    const bound = bindSellerSpriteCaptureSnapshot(claimed.job, {
      worker: "worker-1", fence: claimed.fence, now: new Date(NOW.getTime() + 1),
      snapshotFingerprint: "b".repeat(64), reportedTotalRows: 10, accessibleRows: null, unavailableRows: null,
    })!;

    expect(recordSellerSpriteCaptureProgress(bound, {
      worker: "worker-1", fence: claimed.fence, now: new Date(NOW.getTime() + 2),
      rowKeys: [], evidenceRefs: [], cursor: null,
      counters: { unavailableRows: 11 },
    })).toBeNull();
  });

  it("pauses before another claim and resumes with a fresh attempt generation", () => {
    const claimed = claimSellerSpriteCaptureJob(newJob(), "worker-1", NOW, 1_000)!;
    const paused = pauseSellerSpriteCaptureJob(claimed.job, new Date(NOW.getTime() + 1), "owner");
    expect(paused?.status).toBe("PAUSED");
    expect(claimSellerSpriteCaptureJob(paused!, "worker-2", new Date(NOW.getTime() + 2), 1_000)).toBeNull();
    const resumed = resumeSellerSpriteCaptureJob(paused!, new Date(NOW.getTime() + 3), "owner");
    expect(resumed?.status).toBe("PENDING");
    expect(resumed?.attemptGeneration).toBe(2);
    expect(resumed?.rowKeys).toEqual([]);
  });

  it("does not retry or resume a task whose visible page declared a plan limit", () => {
    const limited = { ...newJob(), status: "PARTIAL" as const, limitationReason: "source_limit_declared" as const };
    expect(retrySellerSpriteCaptureJob(limited, new Date(NOW.getTime() + 1))).toBeNull();
    expect(resumeSellerSpriteCaptureJob({ ...limited, status: "PAUSED" }, new Date(NOW.getTime() + 1), "owner")).toBeNull();
  });

  it("persists a bounded per-attempt window budget and allows pausing/cancelling between windows", () => {
    const claimed = claimSellerSpriteCaptureJob(newJob(), "worker-1", NOW, 1_000)!;
    expect(setSellerSpriteCaptureWindowBudget(claimed.job, 2, new Date(NOW.getTime() + 1))).toBeNull();
    const partial = recordSellerSpriteCaptureProgress(claimed.job, {
      worker: "worker-1", fence: claimed.fence, now: new Date(NOW.getTime() + 1),
      rowKeys: ["generation:1:keyword-row"], structuredValidRowKeys: ["generation:1:keyword-row"],
      persistedRowKeys: ["generation:1:keyword-row"], evidenceRefs: ["attachment:window-1"],
      cursor: { page: 1, scrollY: 600, scrollTarget: "table" },
      counters: { capturedUniqueRows: 1, structuredValidRows: 1, persistedEvidenceRows: 1 },
      status: "PARTIAL", limitationReason: "budget_stop",
    })!;
    const budget = setSellerSpriteCaptureWindowBudget(partial, 2, new Date(NOW.getTime() + 2));
    expect(budget?.windowBudget).toBe(2);
    expect(budget?.cursor).toEqual(partial.cursor);
    expect(setSellerSpriteCaptureWindowBudget(partial, 21, new Date(NOW.getTime() + 2))).toBeNull();
    const paused = pauseSellerSpriteCaptureJob(budget!, new Date(NOW.getTime() + 3), "owner");
    expect(paused?.status).toBe("PAUSED");
    expect(paused?.windowBudget).toBe(2);
    expect(cancelSellerSpriteCaptureJob(partial, new Date(NOW.getTime() + 4), "owner")?.status).toBe("CANCELLED");
  });

  it("rejects inconsistent seven-counter snapshots and cursor regression", () => {
    const claimed = claimSellerSpriteCaptureJob(newJob(), "worker-1", NOW, 1_000)!.job;
    const progress = recordSellerSpriteCaptureProgress(claimed, {
      worker: "worker-1", fence: 1, now: new Date(NOW.getTime() + 1),
      rowKeys: ["k1"], structuredValidRowKeys: ["k1"], persistedRowKeys: ["k1"], evidenceRefs: ["ev1"], cursor: { page: 2, scrollY: 0 },
      counters: {
        reportedTotalRows: 1, accessibleRows: 1, capturedUniqueRows: 1,
        structuredValidRows: 1, persistedEvidenceRows: 1, unavailableRows: 0,
      },
    });
    expect(progress?.counters.reportedTotalRows).toBe(1);
    expect(recordSellerSpriteCaptureProgress(progress!, {
      worker: "worker-1", fence: 1, now: new Date(NOW.getTime() + 2), rowKeys: [], evidenceRefs: [],
      cursor: { page: 1, scrollY: 0 },
      counters: { capturedUniqueRows: 1, structuredValidRows: 1, persistedEvidenceRows: 1 },
    })).toBeNull();
    expect(recordSellerSpriteCaptureProgress(claimed, {
      worker: "worker-1", fence: 1, now: new Date(NOW.getTime() + 1), rowKeys: ["k1"], evidenceRefs: [],
      cursor: { page: 1, scrollY: 0 },
      counters: { capturedUniqueRows: 1, structuredValidRows: 2, persistedEvidenceRows: 3 },
    })).toBeNull();
  });

  it("cancels without allowing a late worker save and retries a partial checkpoint in a new generation", () => {
    const claimed = claimSellerSpriteCaptureJob(newJob(), "worker-1", NOW, 1_000)!.job;
    const partial = recordSellerSpriteCaptureProgress(claimed, {
      worker: "worker-1", fence: 1, now: new Date(NOW.getTime() + 1),
      rowKeys: ["keyword:desk lamp"], structuredValidRowKeys: ["keyword:desk lamp"], evidenceRefs: ["attachment:1"], cursor: { page: 1, scrollY: 500 },
      counters: { capturedUniqueRows: 1, structuredValidRows: 1, persistedEvidenceRows: 0 }, status: "PARTIAL",
    })!;
    const retry = retrySellerSpriteCaptureJob(partial, new Date(NOW.getTime() + 2));
    expect(retry?.attemptGeneration).toBe(2);
    expect(retry?.rowKeys).toEqual(partial.rowKeys);
    const nextClaim = claimSellerSpriteCaptureJob(retry!, "worker-2", new Date(NOW.getTime() + 3), 1_000)!;
    expect(nextClaim.fence).toBe(2);
    const cancelled = cancelSellerSpriteCaptureJob(nextClaim.job, new Date(NOW.getTime() + 4), "owner")!;
    expect(cancelled.status).toBe("CANCELLED");
    expect(recordSellerSpriteCaptureProgress(cancelled, {
      worker: "worker-2", fence: nextClaim.fence, now: new Date(NOW.getTime() + 5), rowKeys: [], evidenceRefs: [],
      cursor: { page: 1, scrollY: 700 }, counters: {},
    })).toBeNull();
  });
});
