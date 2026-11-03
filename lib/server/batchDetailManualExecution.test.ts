import { describe, expect, it, vi } from "vitest";
import { createBatchDetailEnrichmentScheduler, runBatchDetailEnrichmentJobOnce } from "./batchDetailEnrichmentScheduler";
import type { BatchDetailEnrichmentJobRepository } from "./batchDetailEnrichmentJobRepository";
import type { PersistedBatchDetailJob } from "./batchDetailEnrichmentJob";

function fixture() {
  let job: PersistedBatchDetailJob = { schemaVersion: "amazon-batch-detail-job.v1", jobId: "job-one", batchId: "batch-one-001",
    status: "PENDING", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    attemptCount: 0, lastErrorCode: null, leaseOwner: null, leaseExpiresAt: null, nextRunAt: null, traceIds: [],
    items: ["B000000001", "B000000002"].map(asin => ({ itemId: asin, asin, status: "PENDING", attemptCount: 0,
      nextAttemptAt: null, lastErrorCode: null, evidenceId: null, evidenceVersion: null, captureOrigin: null, traceId: null, runReceiptId: null })) };
  const listDue = vi.fn(); const reconcile = vi.fn();
  const repository = {
    get: async (batchId: string) => batchId === job.batchId ? job : null,
    getById: async () => job,
    claim: async (input: { owner: string }) => {
      if (job.status !== "PENDING") return null;
      job = { ...job, status: "RUNNING", leaseOwner: input.owner, leaseExpiresAt: new Date(Date.now() + 120000).toISOString() };
      return job;
    },
    updateJob: async (_id: string, update: (current: PersistedBatchDetailJob) => PersistedBatchDetailJob | null, options: { leaseOwner?: string }) => {
      if (options?.leaseOwner && (job.leaseOwner !== options.leaseOwner || job.status !== "RUNNING")) return null;
      const next = update(job); if (next) job = next; return next;
    }, listDue, reconcileRestartedLeases: reconcile,
  } as unknown as BatchDetailEnrichmentJobRepository;
  return { repository, get: () => job, listDue, reconcile,
    pause: () => { job = { ...job, status: "PAUSED", leaseOwner: null, leaseExpiresAt: null }; } };
}
function success(asin: string) {
  return { item: { itemId: asin, asin, status: "enriched" as const, captured: true, durationMs: 1, errorCode: null,
    evidenceId: "fixture-proof", evidenceVersion: 1, captureOrigin: "CAPTURED_NOW" as const }, traceId: "fixture-trace", runReceiptId: "fixture-receipt" };
}

describe("manual one-item detail execution", () => {
  it("updates the same job and receipt without starting polling or touching other jobs", async () => {
    const state = fixture(); const runAsin = vi.fn(async ({ asin }: { asin: string }) => success(asin));
    const runner = createBatchDetailEnrichmentScheduler({ repository: state.repository, runAsin });
    const result = await runner.runOne("batch-one-001");
    expect(runAsin).toHaveBeenCalledTimes(1);
    expect(result.jobId).toBe("job-one");
    expect(result.items.map(item => item.status)).toEqual(["ENRICHED", "PENDING"]);
    expect(result.items[0].runReceiptId).toBe("fixture-receipt");
    expect(runner.getState().started).toBe(false);
    expect(state.listDue).not.toHaveBeenCalled(); expect(state.reconcile).not.toHaveBeenCalled();
  });
  it("rejects concurrent clicks and does not repeat the source attempt", async () => {
    const state = fixture(); let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const runAsin = vi.fn(async ({ asin }: { asin: string }) => { await wait; return success(asin); });
    const first = createBatchDetailEnrichmentScheduler({ repository: state.repository, runAsin }).runOne("batch-one-001");
    await vi.waitFor(() => expect(runAsin).toHaveBeenCalledTimes(1));
    await expect(createBatchDetailEnrichmentScheduler({ repository: state.repository, runAsin }).runOne("batch-one-001")).rejects.toMatchObject({ code: "DETAIL_JOB_BUSY" });
    release(); await first; expect(runAsin).toHaveBeenCalledTimes(1);
  });
  it("pauses on login/captcha and makes no automatic second attempt", async () => {
    const state = fixture(); const runAsin = vi.fn(async ({ asin }: { asin: string }) => ({ ...success(asin),
      item: { ...success(asin).item, status: "failed_human" as const, captured: false, errorCode: "CAPTCHA_DETECTED" } }));
    const result = await createBatchDetailEnrichmentScheduler({ repository: state.repository, runAsin }).runOne("batch-one-001");
    expect(result.status).toBe("PAUSED"); expect(result.items[1].attemptCount).toBe(0);
    expect(runAsin).toHaveBeenCalledTimes(1);
  });
  it("does not promote results after a concurrent pause loses the lease", async () => {
    const state = fixture();
    await createBatchDetailEnrichmentScheduler({ repository: state.repository, onDiagnostic: () => undefined,
      runAsin: async ({ asin }) => { state.pause(); return success(asin); } }).runOne("batch-one-001");
    expect(state.get().status).toBe("PAUSED"); expect(state.get().items[0].status).not.toBe("ENRICHED");
    expect(state.get().items[1].attemptCount).toBe(0);
  });
  it("checks the disabled switch before any repository or source operation", async () => {
    vi.stubEnv("LOCAL_ACQUISITION_ENABLED", "false");
    try {
      await expect(runBatchDetailEnrichmentJobOnce({ context: { mode: "owner", token: "" }, batchId: "batch-one-001" }))
        .rejects.toMatchObject({ code: "LOCAL_ENVIRONMENT_REQUIRED" });
    } finally { vi.unstubAllEnvs(); }
  });
});
