import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkedInMigrationNames, replayAllCheckedInMigrations } from "@/lib/marketScan/__fixtures__/migrationReplay";
import { createBatchDetailEnrichmentJobRepository } from "@/lib/server/batchDetailEnrichmentJobRepository";
import {
  createBatchDetailEnrichmentScheduler,
  reconcileMarkedAmazonSearchBatchJobs,
  type BatchDetailWorkerResult,
  type BatchDetailSchedulerDiagnostic,
} from "@/lib/server/batchDetailEnrichmentScheduler";
import type { PersistedBatchDetailJobItem } from "@/lib/server/batchDetailEnrichmentJob";
import { AMAZON_SEARCH_DETAIL_ENRICHMENT_INTENT_VERSION, MAX_DETAIL_ITEM_AUTO_ATTEMPTS, deriveBatchDetailJobProgress } from "@/lib/server/batchDetailEnrichmentJob";
import type { ProductBatchStore, ProductBatchView } from "@/lib/productBatchStore";

let root = "";
let databasePath = "";
let first: PrismaClient;
let second: PrismaClient;

function databaseUrl(path: string): string {
  return `file:${path.replaceAll("\\", "/")}`;
}

function item(asin = "B000000001"): PersistedBatchDetailJobItem {
  return {
    itemId: `item-${asin}`,
    asin,
    status: "PENDING",
    attemptCount: 0,
    nextAttemptAt: null,
    lastErrorCode: null,
    evidenceId: null,
    evidenceVersion: null,
    captureOrigin: null,
    traceId: null,
    runReceiptId: null,
  };
}

function success(asin: string): BatchDetailWorkerResult {
  return {
    item: { itemId: `item-${asin}`, asin, status: "enriched", captured: true, durationMs: 1,
      errorCode: null, evidenceId: `fixture-${asin}`, evidenceVersion: 2, captureOrigin: "CAPTURED_NOW" },
    traceId: "fixture-trace", runReceiptId: "fixture-receipt",
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amazon-detail-job-test-"));
  databasePath = join(root, "job.sqlite");
  first = new PrismaClient({ datasources: { db: { url: databaseUrl(databasePath) } } });
  second = new PrismaClient({ datasources: { db: { url: databaseUrl(databasePath) } } });
  const database = new DatabaseSync(databasePath);
  try {
    expect(replayAllCheckedInMigrations(database)).toHaveLength(checkedInMigrationNames().length);
  } finally {
    database.close();
  }
});

afterEach(async () => {
  await Promise.all([first?.$disconnect(), second?.$disconnect()]);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("Amazon batch detail job repository SQLite persistence", () => {
  it.each(["enriched", "captured_partial"] as const)("preserves skipped %s status and evidence provenance", async (status) => {
    const repository = createBatchDetailEnrichmentJobRepository(first);
    await repository.ensure({ batchId: "batch-skip-01", items: [item()] });
    const result = success(item().asin);
    result.item = { ...result.item!, status: "skipped_enriched", existingEnrichmentStatus: status, captured: false };
    await createBatchDetailEnrichmentScheduler({ repository, reconcileMarkedBatches: async () => 0, runAsin: async () => result }).runDueNow();
    expect((await repository.get("batch-skip-01"))?.items[0]).toMatchObject({
      status: status === "enriched" ? "ENRICHED" : "CAPTURED_PARTIAL",
      evidenceId: "fixture-B000000001", evidenceVersion: 2, captureOrigin: "CAPTURED_NOW",
    });
  });

  it.each(["null", "wrong_asin", "wrong_item", "invalid_contract", "missing_wrapper"])("bounds retries for %s Worker results", async (mode) => {
    let time = new Date();
    const repository = createBatchDetailEnrichmentJobRepository(first);
    await repository.ensure({ batchId: "batch-empty-01", items: [item()], now: time });
    let calls = 0;
    const scheduler = createBatchDetailEnrichmentScheduler({
      repository, reconcileMarkedBatches: async () => 0, now: () => time,
      runAsin: async ({ asin }) => {
        calls += 1;
        const result = success(asin);
        if (mode === "missing_wrapper") return undefined as unknown as BatchDetailWorkerResult;
        if (mode === "null") result.item = null;
        else if (mode === "wrong_asin") result.item!.asin = "B999999999";
        else if (mode === "wrong_item") result.item!.itemId = "another-item";
        else result.item = { asin } as NonNullable<BatchDetailWorkerResult["item"]>;
        return result;
      },
    });
    for (let attempt = 1; attempt <= MAX_DETAIL_ITEM_AUTO_ATTEMPTS; attempt += 1) {
      await scheduler.runDueNow();
      const persisted = (await repository.get("batch-empty-01"))!;
      expect(persisted.items[0]).toMatchObject({ attemptCount: attempt,
        status: attempt < MAX_DETAIL_ITEM_AUTO_ATTEMPTS ? "FAILED_RETRYABLE" : "FAILED_PERMANENT",
        lastErrorCode: "DETAIL_WORKER_RESULT_MISSING", evidenceId: null, evidenceVersion: null });
      if (attempt < MAX_DETAIL_ITEM_AUTO_ATTEMPTS) {
        expect(Date.parse(persisted.items[0]!.nextAttemptAt!) - time.getTime()).toBe(30_000 * 2 ** (attempt - 1));
        time = new Date(persisted.items[0]!.nextAttemptAt!);
      } else expect(persisted.items[0]?.nextAttemptAt).toBeNull();
    }
    await scheduler.runDueNow();
    expect(calls).toBe(MAX_DETAIL_ITEM_AUTO_ATTEMPTS);
    expect(deriveBatchDetailJobProgress((await repository.get("batch-empty-01"))!)).toMatchObject({ enriched: 0, partial: 0, failedPermanent: 1 });
  });

  it.each(["cas", "throw"])("stops after heartbeat %s failure without leaking a rejection or error payload", async (mode) => {
    const repository = createBatchDetailEnrichmentJobRepository(first);
    await repository.ensure({ batchId: "batch-heartbeat-01", items: [item(), item("B000000002")] });
    const diagnostics: BatchDetailSchedulerDiagnostic[] = [];
    let heartbeatFailed!: () => void;
    const failure = new Promise<void>((resolveFailure) => { heartbeatFailed = resolveFailure; });
    const guardedRepository = { ...repository, updateJob: async (...args: Parameters<typeof repository.updateJob>) => {
      const before = await repository.getById(args[0]);
      const next = before ? args[1](before) : null;
      if (next && before && next.leaseExpiresAt !== before.leaseExpiresAt) {
        if (mode === "throw") throw Object.assign(new Error("cookie=SECRET"), { code: "DATABASE_UNAVAILABLE" });
        return null;
      }
      return repository.updateJob(...args);
    } };
    const calls: string[] = [];
    const scheduler = createBatchDetailEnrichmentScheduler({ repository: guardedRepository,
      reconcileMarkedBatches: async () => 0, heartbeatMs: 5,
      onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); if (diagnostic.errorCode === "LEASE_LOST") heartbeatFailed(); },
      runAsin: async ({ asin }) => { calls.push(asin); await failure; return success(asin); },
    });
    await scheduler.runDueNow();
    expect(calls).toEqual([item().asin]);
    expect((await repository.get("batch-heartbeat-01"))?.items.map((entry) => entry.status)).toEqual(["RUNNING", "PENDING"]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ stage: "heartbeat", errorCode: "LEASE_LOST", jobId: expect.any(String), batchId: "batch-heartbeat-01", leaseOwner: expect.any(String) }));
    expect(JSON.stringify(diagnostics)).not.toContain("SECRET");
  });

  it("renews valid leases while a Worker is active and advances to the next ASIN", async () => {
    const repository = createBatchDetailEnrichmentJobRepository(first);
    await repository.ensure({ batchId: "batch-heartbeat-ok", items: [item(), item("B000000002")] });
    let renewals = 0;
    const diagnostics: BatchDetailSchedulerDiagnostic[] = [];
    const guardedRepository = { ...repository, updateJob: async (...args: Parameters<typeof repository.updateJob>) => {
      const before = await repository.getById(args[0]);
      const result = await repository.updateJob(...args);
      if (result && before && result.leaseExpiresAt && result.leaseExpiresAt !== before.leaseExpiresAt) renewals += 1;
      return result;
    } };
    const calls: string[] = [];
    await createBatchDetailEnrichmentScheduler({ repository: guardedRepository, reconcileMarkedBatches: async () => 0, heartbeatMs: 5,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      runAsin: async ({ asin }) => { calls.push(asin); await new Promise((done) => setTimeout(done, 35)); return success(asin); },
    }).runDueNow();
    expect(renewals).toBeGreaterThan(0);
    expect(calls).toEqual(["B000000001", "B000000002"]);
    expect((await repository.get("batch-heartbeat-ok"))?.status).toBe("COMPLETED");
    expect(diagnostics).toEqual([]);
  });

  it.each(["pause", "cancel"] as const)("%s fences a late Worker result and prevents the next ASIN", async (action) => {
    const repository = createBatchDetailEnrichmentJobRepository(first);
    const created = await repository.ensure({ batchId: "batch-control-01", items: [item(), item("B000000002")] });
    const calls: string[] = [];
    let formerOwner = "";
    await createBatchDetailEnrichmentScheduler({ repository, reconcileMarkedBatches: async () => 0, onDiagnostic: () => undefined,
      runAsin: async ({ asin }) => {
        calls.push(asin); formerOwner = (await repository.get(created.job.batchId))!.leaseOwner!;
        await repository[action](created.job.batchId); return success(asin);
      },
    }).runDueNow();
    expect(calls).toEqual(["B000000001"]);
    expect(await repository.get(created.job.batchId)).toMatchObject({ status: action === "pause" ? "PAUSED" : "CANCELLED", leaseOwner: null,
      items: [expect.objectContaining({ status: "FAILED_RETRYABLE" }), expect.objectContaining({ status: "PENDING" })] });
    expect(await repository.updateJob(created.job.jobId, (job) => ({ ...job, status: "COMPLETED" }), {
      leaseOwner: formerOwner, allowPausedLease: true, allowCancelledLease: true,
    })).toBeNull();
  });

  it("rejects an expired owner before reclaim and rejects stale writes after a new claim", async () => {
    const now = new Date(); const repository = createBatchDetailEnrichmentJobRepository(first);
    const created = await repository.ensure({ batchId: "batch-expiry-01", items: [item()], now });
    await repository.claim({ jobId: created.job.jobId, owner: "old", now, leaseMs: 60_000 });
    const expired = new Date(now.getTime() + 60_001);
    expect(await repository.updateJob(created.job.jobId, (job) => ({ ...job, status: "COMPLETED" }), { now: expired, leaseOwner: "old" })).toBeNull();
    const next = await createBatchDetailEnrichmentJobRepository(second).claim({ jobId: created.job.jobId, owner: "new", now: expired });
    expect(next?.leaseOwner).toBe("new");
    expect(await repository.updateJob(created.job.jobId, (job) => ({ ...job, status: "COMPLETED" }), { now: expired, leaseOwner: "old" })).toBeNull();
  });

  it("stops before saving or navigating another ASIN when the lease expires during a Worker", async () => {
    let time = new Date();
    const repository = createBatchDetailEnrichmentJobRepository(first);
    await repository.ensure({ batchId: "batch-expired-worker", items: [item(), item("B000000002")], now: time });
    const diagnostics: BatchDetailSchedulerDiagnostic[] = []; const calls: string[] = [];
    await createBatchDetailEnrichmentScheduler({ repository, now: () => time, reconcileMarkedBatches: async () => 0,
      onDiagnostic: (entry) => diagnostics.push(entry), runAsin: async ({ asin }) => {
        calls.push(asin); time = new Date(time.getTime() + 120_001); return success(asin);
      },
    }).runDueNow();
    expect(calls).toEqual(["B000000001"]);
    expect((await repository.get("batch-expired-worker"))?.items.map((entry) => entry.status)).toEqual(["RUNNING", "PENDING"]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ errorCode: "LEASE_LOST", stage: "save_result" }));
  });

  it("two schedulers sharing SQLite execute each completed ASIN only once", async () => {
    const repository = createBatchDetailEnrichmentJobRepository(first);
    await repository.ensure({ batchId: "batch-two-schedulers", items: [item(), item("B000000002")] });
    const calls: string[] = [];
    const create = (repo: typeof repository) => createBatchDetailEnrichmentScheduler({ repository: repo, reconcileMarkedBatches: async () => 0,
      runAsin: async ({ asin }) => { calls.push(asin); await new Promise((done) => setTimeout(done, 20)); return success(asin); },
    });
    await Promise.all([create(repository).runDueNow(), create(createBatchDetailEnrichmentJobRepository(second)).runDueNow()]);
    expect(calls).toEqual(["B000000001", "B000000002"]);
    expect((await repository.get("batch-two-schedulers"))?.status).toBe("COMPLETED");
  });

  it("does not overwrite a renewed lease when recovery encounters a CAS conflict", async () => {
    const now = new Date(); const repository = createBatchDetailEnrichmentJobRepository(first);
    const created = await repository.ensure({ batchId: "batch-reconcile-race", items: [item()], now });
    await repository.claim({ jobId: created.job.jobId, owner: "active", now, leaseMs: 60_000 });
    let raced = false;
    const racingRepository = createBatchDetailEnrichmentJobRepository({ v5OperationReceipt: {
      ...first.v5OperationReceipt,
      updateMany: async (args: Parameters<typeof first.v5OperationReceipt.updateMany>[0]) => {
        if (!raced) {
          raced = true;
          const heartbeatTime = new Date(now.getTime() + 59_999);
          await createBatchDetailEnrichmentJobRepository(second).updateJob(created.job.jobId,
            (job) => ({ ...job, leaseExpiresAt: new Date(now.getTime() + 180_000).toISOString() }), { now: heartbeatTime, leaseOwner: "active" });
        }
        return first.v5OperationReceipt.updateMany(args);
      },
    } } as unknown as Pick<PrismaClient, "v5OperationReceipt">);
    expect(await racingRepository.reconcileRestartedLeases(new Date(now.getTime() + 60_001))).toBe(0);
    expect(await repository.get(created.job.batchId)).toMatchObject({ status: "RUNNING", leaseOwner: "active", leaseExpiresAt: new Date(now.getTime() + 180_000).toISOString() });
  });

  it("logs scheduler database failures with stage and safe codes", async () => {
    const repository = createBatchDetailEnrichmentJobRepository(first);
    const diagnostics: BatchDetailSchedulerDiagnostic[] = [];
    await createBatchDetailEnrichmentScheduler({ repository: { ...repository, listDue: async () => { throw Object.assign(new Error("token=SECRET"), { code: "DATABASE_UNAVAILABLE" }); } },
      reconcileMarkedBatches: async () => 0, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    }).runDueNow();
    expect(diagnostics).toEqual([expect.objectContaining({ stage: "list_due", errorCode: "DATABASE_UNAVAILABLE", timestamp: expect.any(String) })]);
    expect(JSON.stringify(diagnostics)).not.toContain("SECRET");
  });
  it("persists one idempotent job across independent repository connections", async () => {
    const now = new Date();
    const firstRepository = createBatchDetailEnrichmentJobRepository(first);
    const secondRepository = createBatchDetailEnrichmentJobRepository(second);
    const created = await firstRepository.ensure({ batchId: "batch-persist-01", items: [item()], now });
    const replayed = await secondRepository.ensure({ batchId: "batch-persist-01", items: [item()], now });

    expect(created.created).toBe(true);
    expect(replayed).toMatchObject({ created: false, job: { jobId: created.job.jobId, status: "PENDING" } });
    expect(await secondRepository.get("batch-persist-01")).toMatchObject({ jobId: created.job.jobId, items: [item()] });
  });

  it("recovers only marked new Amazon batches and does not auto-enqueue historical batches", async () => {
    const repository = createBatchDetailEnrichmentJobRepository(first);
    const markedBatchId = "batch-auto-recovery-01";
    const historicalBatchId = "batch-historical-01";
    const markedBatch = {
      id: markedBatchId,
      batchStatus: "ready",
      acceptedCount: 1,
      normalizedSnapshotJson: JSON.stringify({
        schemaVersion: "amazon-search-capture-snapshot.v1",
        sourceType: "amazon_search_capture",
        detailEnrichmentIntent: {
          schemaVersion: AMAZON_SEARCH_DETAIL_ENRICHMENT_INTENT_VERSION,
          autoEnqueue: true,
        },
      }),
    } as ProductBatchView;
    const historicalBatch = {
      ...markedBatch,
      id: historicalBatchId,
      normalizedSnapshotJson: JSON.stringify({
        schemaVersion: "amazon-search-capture-snapshot.v1",
        sourceType: "amazon_search_capture",
      }),
    } as ProductBatchView;
    const productBatchItem = {
      id: "item-auto-recovery-01",
      batchId: markedBatchId,
      asin: "B000000001",
      ordinal: 0,
      archivedAt: null,
      normalizedProductJson: JSON.stringify({ marketplace: "US", asin: "B000000001" }),
    };
    const store = {
      listBatches: async () => [markedBatch, historicalBatch],
      getBatchItems: async () => [productBatchItem],
    } as unknown as Pick<ProductBatchStore, "listBatches" | "getBatchItems">;

    // P0 解耦后默认**不补跑**任何历史批次：自动补跑必须显式开启。
    expect(await reconcileMarkedAmazonSearchBatchJobs({ store, repository })).toBe(0);
    expect(await repository.get(markedBatchId)).toBeNull();
    expect(await repository.get(historicalBatchId)).toBeNull();

    // 显式开启兼容能力后，只恢复带 autoEnqueue 意图的新批次，历史无意图批次仍不补跑。
    expect(await reconcileMarkedAmazonSearchBatchJobs({
      store,
      repository,
      legacyAutoEnqueueAllowed: true,
    })).toBe(1);
    expect(await repository.get(markedBatchId)).toMatchObject({
      batchId: markedBatchId,
      status: "PENDING",
      items: [expect.objectContaining({ asin: "B000000001", status: "PENDING" })],
    });
    expect(await repository.get(historicalBatchId)).toBeNull();
    expect(await reconcileMarkedAmazonSearchBatchJobs({
      store,
      repository,
      legacyAutoEnqueueAllowed: true,
    })).toBe(0);
  });

  it("已有 BatchCaptureRun 的批次不会被旧 Detail Job 调度器补跑（双任务权威防护）", async () => {
    const repository = createBatchDetailEnrichmentJobRepository(first);
    const runOwnedBatchId = "batch-owned-by-run-01";
    const freeBatchId = "batch-no-run-01";
    const marked = (id: string) => ({
      id,
      batchStatus: "ready",
      acceptedCount: 1,
      normalizedSnapshotJson: JSON.stringify({
        schemaVersion: "amazon-search-capture-snapshot.v1",
        sourceType: "amazon_search_capture",
        detailEnrichmentIntent: {
          schemaVersion: AMAZON_SEARCH_DETAIL_ENRICHMENT_INTENT_VERSION,
          autoEnqueue: true,
        },
      }),
    } as ProductBatchView);
    const store = {
      listBatches: async () => [marked(runOwnedBatchId), marked(freeBatchId)],
      getBatchItems: async (batchId: string) => [{
        id: `item-${batchId}`,
        batchId,
        asin: "B000000002",
        ordinal: 0,
        archivedAt: null,
        normalizedProductJson: JSON.stringify({ marketplace: "US", asin: "B000000002" }),
      }],
    } as unknown as Pick<ProductBatchStore, "listBatches" | "getBatchItems">;

    const created = await reconcileMarkedAmazonSearchBatchJobs({
      store,
      repository,
      legacyAutoEnqueueAllowed: true,
      hasCaptureRun: async (batchId: string) => batchId === runOwnedBatchId,
    });

    // 只有未被 Capture Run 接管的批次会被建旧 Job。
    expect(created).toBe(1);
    expect(await repository.get(runOwnedBatchId)).toBeNull();
    expect(await repository.get(freeBatchId)).toMatchObject({ batchId: freeBatchId, status: "PENDING" });
  });

  it("uses compare-and-swap so two repository connections cannot claim one job", async () => {
    const now = new Date();
    const created = await createBatchDetailEnrichmentJobRepository(first).ensure({
      batchId: "batch-claim-01", items: [item()], now,
    });
    const [firstClaim, secondClaim] = await Promise.all([
      createBatchDetailEnrichmentJobRepository(first).claim({ jobId: created.job.jobId, owner: "worker-a", now }),
      createBatchDetailEnrichmentJobRepository(second).claim({ jobId: created.job.jobId, owner: "worker-b", now }),
    ]);

    expect([firstClaim, secondClaim].filter(Boolean)).toHaveLength(1);
    expect((await createBatchDetailEnrichmentJobRepository(second).get(created.job.batchId))?.leaseOwner)
      .toBe(firstClaim ? "worker-a" : "worker-b");
  });

  it("runs at most 30 ASINs per scheduler pass and continues after a permanent failure", async () => {
    const now = new Date();
    const repository = createBatchDetailEnrichmentJobRepository(first);
    const items = Array.from({ length: 61 }, (_, index) => item("B" + String(index).padStart(9, "0")));
    const created = await repository.ensure({ batchId: "batch-budget-01", items, now });
    let captureCalls = 0;
    const scheduler = createBatchDetailEnrichmentScheduler({
      repository,
      reconcileMarkedBatches: async () => 0,
      now: () => now,
      schedulePolling: false,
      runAsin: async ({ asin }) => {
        captureCalls += 1;
        const failed = asin === items[0]?.asin;
        return {
          item: {
            itemId: "item-" + asin, asin,
            status: failed ? "failed_permanent" : "enriched",
            captured: !failed, durationMs: 5, errorCode: failed ? "ASIN_NOT_FOUND" : null,
            evidenceId: failed ? null : "evidence-" + asin, evidenceVersion: failed ? null : 1,
            captureOrigin: failed ? null : "CAPTURED_NOW",
          },
          traceId: "trace-" + captureCalls,
          runReceiptId: "receipt-" + captureCalls,
        };
      },
    });

    await scheduler.runDueNow();
    expect(captureCalls).toBe(30);
    expect(await repository.get(created.job.batchId)).toMatchObject({
      status: "PENDING",
      items: expect.arrayContaining([
        expect.objectContaining({ asin: items[0]?.asin, status: "FAILED_PERMANENT" }),
        expect.objectContaining({ status: "ENRICHED" }),
      ]),
    });
    expect((await repository.get(created.job.batchId))?.items.filter((entry) => entry.status === "PENDING")).toHaveLength(31);

    await scheduler.runDueNow();
    expect(captureCalls).toBe(60);
    expect((await repository.get(created.job.batchId))?.items.filter((entry) => entry.status === "PENDING")).toHaveLength(1);

    await scheduler.runDueNow();
    const completed = await repository.get(created.job.batchId);
    expect(captureCalls).toBe(61);
    expect(completed?.status).toBe("FAILED");
    expect(completed?.items.filter((entry) => entry.status === "ENRICHED")).toHaveLength(60);
    expect(completed?.items.filter((entry) => entry.status === "FAILED_PERMANENT")).toHaveLength(1);
  });

  it("bounds automatic retry count and uses increasing backoff", async () => {
    let now = new Date();
    const repository = createBatchDetailEnrichmentJobRepository(first);
    const created = await repository.ensure({ batchId: "batch-retry-01", items: [item()], now });
    let captureCalls = 0;
    const scheduler = createBatchDetailEnrichmentScheduler({
      repository,
      reconcileMarkedBatches: async () => 0,
      now: () => now,
      schedulePolling: false,
      runAsin: async () => {
        captureCalls += 1;
        throw Object.assign(new Error("transient failure"), { code: "NETWORK_UNAVAILABLE" });
      },
    });

    await scheduler.runDueNow();
    const firstFailure = await repository.get(created.job.batchId);
    expect(firstFailure?.items[0]).toMatchObject({
      status: "FAILED_RETRYABLE",
      attemptCount: 1,
      lastErrorCode: "NETWORK_UNAVAILABLE",
      traceId: expect.stringMatching(/^batch-detail-attempt-/u),
    });
    expect(firstFailure?.traceIds).toContain(firstFailure?.items[0]?.traceId);
    expect(captureCalls).toBe(1);
    await scheduler.runDueNow();
    expect(captureCalls).toBe(1);

    now = new Date(now.getTime() + 30_001);
    await scheduler.runDueNow();
    expect((await repository.get(created.job.batchId))?.items[0]).toMatchObject({ status: "FAILED_RETRYABLE", attemptCount: 2 });
    now = new Date(now.getTime() + 60_001);
    await scheduler.runDueNow();
    expect((await repository.get(created.job.batchId))?.items[0]).toMatchObject({ status: "FAILED_PERMANENT", attemptCount: 3 });
    expect((await repository.get(created.job.batchId))?.status).toBe("FAILED");
    expect(captureCalls).toBe(3);
  });

  it.each(["CAPTCHA_DETECTED", "LOGIN_REQUIRED"])("pauses immediately on %s and leaves later ASINs untouched", async (code) => {
    const now = new Date();
    const repository = createBatchDetailEnrichmentJobRepository(first);
    const items = [item("B000000001"), item("B000000002")];
    const created = await repository.ensure({ batchId: "batch-human-01", items, now });
    const calls: string[] = [];
    const scheduler = createBatchDetailEnrichmentScheduler({
      repository,
      reconcileMarkedBatches: async () => 0,
      now: () => now,
      schedulePolling: false,
      runAsin: async ({ asin }) => {
        calls.push(asin);
        return {
          item: {
            itemId: "item-" + asin, asin, status: "failed_human", captured: false, durationMs: 10,
            errorCode: code, evidenceId: null, evidenceVersion: null,
          },
          traceId: "trace-human", runReceiptId: "receipt-human",
        };
      },
    });

    await scheduler.runDueNow();
    expect(calls).toEqual(["B000000001"]);
    expect(await repository.get(created.job.batchId)).toMatchObject({
      status: "PAUSED",
      lastErrorCode: code,
      items: [
        expect.objectContaining({ asin: "B000000001", status: "HUMAN_REQUIRED" }),
        expect.objectContaining({ asin: "B000000002", status: "PENDING" }),
      ],
    });
  });

  it("restores 60 mixed-result items after a real process exit and finishes with bounded retries", () => {
    const childCode = String.raw`
import Module from "node:module";
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request, ...args) {
  if (request === "server-only") return process.env.JOB_TEST_EMPTY_MODULE;
  if (["@/lib/server/db", "@/lib/server/batchDetailEnrichmentService", "@/lib/server/productBatchStoreResolver"].includes(request)) return process.env.JOB_TEST_DB_STUB;
  return originalResolveFilename.call(this, request, ...args);
};
const { PrismaClient } = await import("@prisma/client");
const unwrapModule = (loaded) => loaded.default ?? loaded;
const { createBatchDetailEnrichmentJobRepository } = unwrapModule(await import("@/lib/server/batchDetailEnrichmentJobRepository"));
const { createBatchDetailEnrichmentScheduler } = unwrapModule(await import("@/lib/server/batchDetailEnrichmentScheduler"));
const { deriveBatchDetailJobProgress } = unwrapModule(await import("@/lib/server/batchDetailEnrichmentJob"));
const client = new PrismaClient({ datasources: { db: { url: process.env.JOB_TEST_DATABASE_URL } } });
const baseRepository = createBatchDetailEnrichmentJobRepository(client);
let renewals = 0;
const repository = { ...baseRepository, updateJob: async (...args) => {
  const before = await baseRepository.getById(args[0]);
  const result = await baseRepository.updateJob(...args);
  if (before && result?.leaseExpiresAt && result.leaseExpiresAt !== before.leaseExpiresAt) renewals++;
  return result;
}};
const mode = process.env.JOB_TEST_MODE;
const batchId = "batch-mixed-process-01";
let time = new Date("2026-10-08T00:00:00Z");
const calls = [];
const diagnostics = [];
const items = Array.from({length:60}, (_, i) => ({ itemId:"item-"+i, asin:"B"+String(i).padStart(9,"0"), status:"PENDING", attemptCount:0,
  nextAttemptAt:null,lastErrorCode:null,evidenceId:null,evidenceVersion:null,captureOrigin:null,traceId:null,runReceiptId:null }));
try {
  if (mode === "seed") await repository.ensure({batchId,items,now:time});
  else {
    const before = await repository.get(batchId);
    if (before?.status !== "RUNNING" || before.items[12]?.status !== "RUNNING") throw new Error("interrupted state missing");
    if (before.items.filter(i => ["ENRICHED","CAPTURED_PARTIAL","FAILED_RETRYABLE","FAILED_PERMANENT"].includes(i.status)).length !== 12) throw new Error("committed first 12 missing");
    time = new Date(time.getTime()+180001);
  }
  const scheduler = createBatchDetailEnrichmentScheduler({repository, now:()=>time, reconcileMarkedBatches:async()=>0, schedulePolling:false, heartbeatMs:5,
    onDiagnostic: diagnostic => { diagnostics.push(diagnostic); },
    runAsin: async ({asin}) => {
      const index=Number(asin.slice(1));calls.push(index);
      if (mode === "seed" && calls.length === 1) { time=new Date(time.getTime()+1000); await new Promise(resolve=>setTimeout(resolve,25)); }
      if (mode === "seed" && calls.length === 13) {
        process.stdout.write(JSON.stringify({exitAt:13,renewals}));process.exit(0);
      }
      const group=index%5;
      return {item:group===3?null:{ itemId:"item-"+index,asin,status:group===0?"enriched":group===1?"captured_partial":group===2?"skipped_enriched":"failed_permanent",
        existingEnrichmentStatus:group===2?"captured_partial":undefined,captured:group<2,durationMs:1,errorCode:group===4?"ASIN_NOT_FOUND":null,
        evidenceId:group===4?null:"fixture-evidence-"+index,evidenceVersion:group===4?null:2,captureOrigin:group===2?"REUSED_VALID_EVIDENCE":group===4?null:"CAPTURED_NOW"},
        traceId:"fixture-trace-"+index,runReceiptId:"fixture-receipt-"+index};
    }});
  const perTick=[];
  for(let round=0;round<8;round++){
    const before=calls.length;await scheduler.runDueNow();perTick.push(calls.length-before);
    const job=await repository.get(batchId);
    if(["COMPLETED","FAILED"].includes(job.status))break;
    time=new Date(time.getTime()+600001);
  }
  const final=await repository.get(batchId);
  process.stdout.write(JSON.stringify({progress:deriveBatchDetailJobProgress(final),perTick,calls,diagnostics,
    attempts:final.items.map(i=>i.attemptCount),statuses:final.items.map(i=>i.status)}));
} finally { await client.$disconnect(); }
`;
    const emptyModulePath = join(root, "mixed-empty.cjs");
    const stubPath = join(root, "mixed-stub.cjs");
    writeFileSync(emptyModulePath, "module.exports = {};\n");
    writeFileSync(stubPath, "exports.prisma = {}; exports.enrichBatchWithAmazonDetail = () => { throw new Error('REAL_WORKER_FORBIDDEN'); }; exports.getProductBatchStore = () => { throw new Error('OFFICIAL_STORE_FORBIDDEN'); };\n");
    const run = (mode: string) => spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", childCode], {
      cwd: resolve("."), encoding: "utf8", windowsHide: true, timeout: 30_000,
      env: { ...process.env, DATABASE_URL: databaseUrl(databasePath), JOB_TEST_DATABASE_URL: databaseUrl(databasePath),
        JOB_TEST_MODE: mode, JOB_TEST_EMPTY_MODULE: emptyModulePath, JOB_TEST_DB_STUB: stubPath },
    });
    const seed = run("seed");
    expect(seed.status, seed.stderr || seed.error?.message).toBe(0);
    expect(JSON.parse(seed.stdout)).toMatchObject({ exitAt: 13 });
    expect(JSON.parse(seed.stdout).renewals).toBeGreaterThan(0);
    const restarted = run("recover");
    expect(restarted.status, restarted.stderr || restarted.error?.message).toBe(0);
    const result = JSON.parse(restarted.stdout);
    expect(result.progress).toMatchObject({ total: 60, status: "FAILED", processed: 60, enriched: 12, partial: 24, failedPermanent: 24, failedRetryable: 0, pending: 0, running: 0, reusedEvidence: 12, newlyCaptured: 24 });
    expect(result.perTick.every((count: number) => count <= 30)).toBe(true);
    // Previously committed success/partial/permanent items never run again;
    // the two missing-result items legitimately consume their remaining retries.
    expect(result.calls.filter((index: number) => index < 12).sort((a: number, b: number) => a - b)).toEqual([3, 3, 8, 8]);
    expect(result.attempts.every((count: number) => count <= MAX_DETAIL_ITEM_AUTO_ATTEMPTS)).toBe(true);
    expect(result.statuses).toHaveLength(60);
    expect(result.diagnostics).toEqual([]);
    expect(new Set(result.statuses)).toEqual(new Set(["ENRICHED", "CAPTURED_PARTIAL", "FAILED_PERMANENT"]));
  }, 30_000);

  it("recovers a leased item after one real Node process exits and a new process starts", () => {
    const childCode = String.raw`
import Module from "node:module";
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request, ...args) {
  if (request === "server-only") return process.env.JOB_TEST_EMPTY_MODULE;
  if (request === "@/lib/server/db") return process.env.JOB_TEST_DB_STUB;
  return originalResolveFilename.call(this, request, ...args);
};
const { PrismaClient } = await import("@prisma/client");
const loadedRepository = await import("@/lib/server/batchDetailEnrichmentJobRepository");
const { createBatchDetailEnrichmentJobRepository } = loadedRepository.default ?? loadedRepository;

const client = new PrismaClient({ datasources: { db: { url: process.env.JOB_TEST_DATABASE_URL } } });
const repository = createBatchDetailEnrichmentJobRepository(client);
const batchId = "batch-process-01";
const mode = process.env.JOB_TEST_MODE;
try {
  if (mode === "seed") {
    const now = new Date(Date.now() - 180_000);
    const ensured = await repository.ensure({
      batchId,
      now,
      items: [{
        itemId: "item-process-01", asin: "B000000001", status: "PENDING", attemptCount: 0,
        nextAttemptAt: null, lastErrorCode: null, evidenceId: null, evidenceVersion: null,
        captureOrigin: null, traceId: null, runReceiptId: null,
      }],
    });
    const claimed = await repository.claim({ jobId: ensured.job.jobId, owner: "exited-process", now, leaseMs: 60_000 });
    if (!claimed) throw new Error("seed claim failed");
    const runningItem = { ...claimed.items[0], status: "RUNNING", attemptCount: 1 };
    await repository.updateJob(claimed.jobId, (job) => ({
      ...job, items: job.items.map((entry) => entry.itemId === runningItem.itemId ? runningItem : entry),
    }), { now, leaseOwner: "exited-process" });
    process.stdout.write(JSON.stringify({ jobId: ensured.job.jobId }));
  } else if (mode === "recover") {
    const now = new Date();
    const before = await repository.get(batchId);
    if (!before || before.status !== "RUNNING" || before.items[0]?.status !== "RUNNING") {
      throw new Error("second process did not observe persisted running state");
    }
    const recoveredCount = await repository.reconcileRestartedLeases(now);
    const recovered = await repository.get(batchId);
    if (recoveredCount !== 1 || recovered?.status !== "PENDING" || recovered.items[0]?.status !== "FAILED_RETRYABLE") {
      throw new Error("expired lease was not recovered");
    }
    const claimed = await repository.claim({ jobId: recovered.jobId, owner: "restarted-process", now });
    if (!claimed || claimed.leaseOwner !== "restarted-process") throw new Error("restarted process could not claim recovered job");
    process.stdout.write(JSON.stringify({
      status: claimed.status,
      itemStatus: claimed.items[0]?.status,
      lastErrorCode: claimed.items[0]?.lastErrorCode,
      leaseOwner: claimed.leaseOwner,
    }));
  } else {
    throw new Error("unknown child mode");
  }
} finally {
  await client.$disconnect();
}
`;
    const emptyModulePath = join(root, "empty.cjs");
    const dbStubPath = join(root, "db.cjs");
    writeFileSync(emptyModulePath, "module.exports = {};\n");
    writeFileSync(dbStubPath, "exports.prisma = {};\n");

    const runProcess = (mode: "seed" | "recover") => spawnSync(process.execPath, [
      "--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", childCode,
    ], {
      cwd: resolve("."),
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl(databasePath),
        JOB_TEST_DATABASE_URL: databaseUrl(databasePath),
        JOB_TEST_MODE: mode,
        JOB_TEST_EMPTY_MODULE: emptyModulePath,
        JOB_TEST_DB_STUB: dbStubPath,
      },
      timeout: 30_000,
    });

    const seed = runProcess("seed");
    expect(seed.status, seed.stderr || seed.error?.message).toBe(0);
    expect(seed.signal).toBeNull();
    expect(JSON.parse(seed.stdout)).toMatchObject({ jobId: expect.any(String) });

    const restarted = runProcess("recover");
    expect(restarted.status, restarted.stderr || restarted.error?.message).toBe(0);
    expect(restarted.signal).toBeNull();
    expect(JSON.parse(restarted.stdout)).toMatchObject({
      status: "RUNNING",
      itemStatus: "FAILED_RETRYABLE",
      lastErrorCode: "WORKER_RESTARTED_DURING_ITEM",
      leaseOwner: "restarted-process",
    });
  });
});
