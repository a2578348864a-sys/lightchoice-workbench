import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkedInMigrationNames, replayAllCheckedInMigrations } from "@/lib/marketScan/__fixtures__/migrationReplay";
import { createSellerSpriteCaptureJobRepository } from "@/lib/server/sellerSpriteCaptureJobRepository";

let root = "";
let first: PrismaClient;
let second: PrismaClient;

function databaseUrl(path: string): string {
  return "file:" + path.replaceAll("\\", "/");
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "sellersprite-job-test-"));
  const path = join(root, "job.sqlite");
  first = new PrismaClient({ datasources: { db: { url: databaseUrl(path) } } });
  second = new PrismaClient({ datasources: { db: { url: databaseUrl(path) } } });
  const database = new DatabaseSync(path);
  try {
    expect(replayAllCheckedInMigrations(database)).toHaveLength(checkedInMigrationNames().length);
  } finally {
    database.close();
  }
});

afterEach(async () => {
  await Promise.all([first?.$disconnect(), second?.$disconnect()]);
  if (!root) return;
  // Windows 下 Prisma 断开后句柄释放可能略滞后于 $disconnect，直接 unlink 会偶发 EBUSY。
  // 仅对清理做有界重试，不吞掉断言失败；残留临时目录不影响测试结论。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EBUSY" || attempt === 4) return;
      await new Promise((resolveTick) => setTimeout(resolveTick, 50));
    }
  }
});

describe("SellerSprite capture job SQLite receipt persistence", () => {
  it("recovers a non-zero cursor after the writer process exits", async () => {
    const input = {
      module: "reverse_asin" as const,
      marketplace: "US" as const,
      query: { subjectKey: "amazon:US:B01L9X99GC", targetAsin: "B01L9X99GC" },
      accessScope: "owner",
    };
    const dbPath = join(root, "job.sqlite");
    const workerNow = new Date("2026-10-10T04:00:00.000Z");
    const workerLeaseMs = 120_000;
    const childTest = fileURLToPath(new URL("./sellerSpriteCaptureJobRepository.process-boundary.test.ts", import.meta.url));
    const childEnv = { ...process.env };
    delete childEnv.VITEST_WORKER_ID;
    delete childEnv.VITEST_POOL_ID;
    Object.assign(childEnv, {
      SELLERSPRITE_CAPTURE_JOB_PROCESS_BOUNDARY: "1",
      SELLERSPRITE_CAPTURE_JOB_PROCESS_BOUNDARY_DB: dbPath,
      SELLERSPRITE_CAPTURE_JOB_PROCESS_BOUNDARY_NOW: workerNow.toISOString(),
      SELLERSPRITE_CAPTURE_JOB_PROCESS_BOUNDARY_LEASE_MS: String(workerLeaseMs),
    });

    // The isolated child Vitest process writes a RUNNING checkpoint and exits without pausing the Job.
    execFileSync(process.execPath, [
      join(process.cwd(), "node_modules", "vitest", "vitest.mjs"),
      "run",
      childTest,
      "--reporter=dot",
      "--silent",
    ], { cwd: process.cwd(), env: childEnv, encoding: "utf8", timeout: 60_000, windowsHide: true });

    await first.$disconnect();
    first = new PrismaClient({ datasources: { db: { url: databaseUrl(dbPath) } } });
    const repository = createSellerSpriteCaptureJobRepository(first);
    const recoveryAt = new Date(workerNow.getTime() + workerLeaseMs + 201);
    const resumable = await repository.listResumable(recoveryAt);
    expect(resumable).toHaveLength(1);
    expect(resumable[0]).toMatchObject({
      status: "RUNNING",
      cursor: { page: 3, scrollY: 720, scrollTarget: "table" },
      cursorWindowFingerprint: "9".repeat(64),
      rowKeys: ["generation:1:keyword-lamp", "generation:1:keyword-mug"],
      structuredValidRowKeys: ["generation:1:keyword-lamp", "generation:1:keyword-mug"],
      persistedRowKeys: ["generation:1:keyword-lamp", "generation:1:keyword-mug"],
      counters: { capturedUniqueRows: 2, structuredValidRows: 2, persistedEvidenceRows: 2 },
    });

    const recovered = await repository.claim(resumable[0].jobId, "recovered-after-process-exit", recoveryAt, workerLeaseMs);
    expect(recovered?.job).toMatchObject({
      status: "RUNNING",
      fence: 2,
      cursor: { page: 3, scrollY: 720, scrollTarget: "table" },
      rowKeys: ["generation:1:keyword-lamp", "generation:1:keyword-mug"],
      persistedRowKeys: ["generation:1:keyword-lamp", "generation:1:keyword-mug"],
    });
    expect((await repository.getByFingerprint(resumable[0].queryFingerprint))?.jobId).toBe(resumable[0].jobId);
  });

  it("survives repository recreation and fences concurrent workers", async () => {
    const input = {
      module: "reverse_asin" as const,
      marketplace: "US" as const,
      query: { subjectKey: "amazon:US:B01L9X99GC", targetAsin: "B01L9X99GC" },
      windowBudget: 2,
      accessScope: "owner",
    };
    const left = createSellerSpriteCaptureJobRepository(first);
    const right = createSellerSpriteCaptureJobRepository(second);
    const ensured = await left.ensure(input, new Date("2026-10-08T10:00:00.000Z"));
    expect((await right.ensure(input, new Date("2026-10-08T10:00:01.000Z"))).job.jobId).toBe(ensured.job.jobId);

    const claims = await Promise.all([
      left.claim(ensured.job.jobId, "worker-left", new Date("2026-10-08T10:01:00.000Z"), 5_000),
      right.claim(ensured.job.jobId, "worker-right", new Date("2026-10-08T10:01:00.000Z"), 5_000),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find((item) => item !== null)!;
    const bound = await left.bindSnapshot(ensured.job.jobId, claim.job.leaseOwner!, claim.fence, {
      snapshotFingerprint: "f".repeat(64), reportedTotalRows: 2, accessibleRows: null, unavailableRows: null,
    }, new Date("2026-10-08T10:01:00.500Z"));
    expect(bound).toMatchObject({ captureGeneration: 1, snapshotFingerprint: "f".repeat(64), counters: { reportedTotalRows: 2 } });
    const saved = await left.saveProgress(ensured.job.jobId, claim.job.leaseOwner!, claim.fence, {
      now: new Date("2026-10-08T10:01:01.000Z"),
      rowKeys: ["generation:1:keyword-lamp"],
      structuredValidRowKeys: ["generation:1:keyword-lamp"],
      persistedRowKeys: ["generation:1:keyword-lamp"],
      evidenceRefs: ["attachment:row-set-1", "raw-artifact:raw-1"],
      cursor: { page: 1, scrollY: 600, scrollTarget: "table" },
      cursorWindowFingerprint: "d".repeat(64),
      counters: { capturedUniqueRows: 1, structuredValidRows: 1, persistedEvidenceRows: 1 },
      diagnostics: { actualVisibleRows: 20, duplicatesRejected: 2, windowsProcessed: 1, cursorRestored: true },
      status: "PARTIAL",
      limitationReason: "unknown",
      lastErrorCode: "SINGLE_VISIBLE_SNAPSHOT_ONLY",
    });
    expect(saved?.status).toBe("PARTIAL");

    await second.$disconnect();
    second = new PrismaClient({ datasources: { db: { url: databaseUrl(join(root, "job.sqlite")) } } });
    const readback = await createSellerSpriteCaptureJobRepository(second).getByFingerprint(ensured.job.queryFingerprint);
    expect(readback).toMatchObject({
      jobId: ensured.job.jobId,
      status: "PARTIAL",
      windowBudget: 2,
      attemptGeneration: 1,
      fence: 1,
      captureGeneration: 1,
      snapshotFingerprint: "f".repeat(64),
      cursor: { page: 1, scrollY: 600, scrollTarget: "table" },
      cursorWindowFingerprint: "d".repeat(64),
      rowKeys: ["generation:1:keyword-lamp"],
      structuredValidRowKeys: ["generation:1:keyword-lamp"],
      persistedRowKeys: ["generation:1:keyword-lamp"],
      evidenceRefs: ["attachment:row-set-1", "raw-artifact:raw-1"],
      counters: { capturedUniqueRows: 1, structuredValidRows: 1, persistedEvidenceRows: 1 },
      diagnostics: { actualVisibleRows: 20, duplicatesRejected: 2, windowsProcessed: 1, cursorRestored: true },
    });
  });

  it("does not persist an invalid coverage snapshot", async () => {
    const input = {
      module: "reverse_asin" as const,
      marketplace: "US" as const,
      query: { subjectKey: "amazon:US:B01L9X99GC", targetAsin: "B01L9X99GC" },
      accessScope: "owner",
    };
    const repository = createSellerSpriteCaptureJobRepository(first);
    const ensured = await repository.ensure(input, new Date("2026-10-08T12:00:00.000Z"));
    const claim = await repository.claim(ensured.job.jobId, "invalid-coverage-worker", new Date("2026-10-08T12:00:01.000Z"));
    expect(claim).not.toBeNull();

    const bound = await repository.bindSnapshot(ensured.job.jobId, claim!.job.leaseOwner!, claim!.fence, {
      snapshotFingerprint: "e".repeat(64), reportedTotalRows: 10, accessibleRows: 8, unavailableRows: 3,
    }, new Date("2026-10-08T12:00:01.500Z"));

    expect(bound).toBeNull();
    expect(await repository.getById(ensured.job.jobId)).toMatchObject({
      status: "RUNNING",
      captureGeneration: 0,
      snapshotFingerprint: null,
      counters: {
        reportedTotalRows: null,
        accessibleRows: null,
        capturedUniqueRows: 0,
        structuredValidRows: 0,
        persistedEvidenceRows: 0,
        unavailableRows: null,
      },
    });
  });

  it("persists and restores a multi-thousand-row checkpoint larger than the former size limit", async () => {
    const input = {
      module: "keyword_mining_trend" as const,
      marketplace: "US" as const,
      query: { subjectKey: "amazon:US:B01L9X99GC", seedKeyword: "insulated bottle" },
      accessScope: "owner",
    };
    const repository = createSellerSpriteCaptureJobRepository(first);
    const ensured = await repository.ensure(input, new Date("2026-10-08T11:00:00.000Z"));
    const claim = await repository.claim(ensured.job.jobId, "large-checkpoint-worker", new Date("2026-10-08T11:00:01.000Z"));
    expect(claim).not.toBeNull();
    const bound = await repository.bindSnapshot(ensured.job.jobId, claim!.job.leaseOwner!, claim!.fence, {
      snapshotFingerprint: "c".repeat(64), reportedTotalRows: null, accessibleRows: null, unavailableRows: null,
    }, new Date("2026-10-08T11:00:01.500Z"));
    expect(bound?.captureGeneration).toBe(1);

    // Synthetic repository fixture: it exercises checkpoint serialization only, not Provider capture.
    const rowKeys = Array.from({ length: 8_000 }, (_, index) => `row:${String(index).padStart(5, "0")}:${"a".repeat(64)}`);
    const checkpointBytes = Buffer.byteLength(JSON.stringify({ rowKeys, valid: rowKeys, persisted: rowKeys }), "utf8");
    expect(checkpointBytes).toBeGreaterThan(512 * 1024);
    const evidenceRefs = Array.from({ length: 400 }, (_, index) => `window-attachment:${index}`);
    const saved = await repository.saveProgress(ensured.job.jobId, claim!.job.leaseOwner!, claim!.fence, {
      now: new Date("2026-10-08T11:00:02.000Z"),
      rowKeys,
      structuredValidRowKeys: rowKeys,
      persistedRowKeys: rowKeys,
      evidenceRefs,
      cursor: { page: 400, scrollY: 0, scrollTarget: "document" },
      counters: { capturedUniqueRows: rowKeys.length, structuredValidRows: rowKeys.length, persistedEvidenceRows: rowKeys.length },
      diagnostics: { actualVisibleRows: rowKeys.length, windowsProcessed: 400 },
      status: "RUNNING",
      limitationReason: "unknown",
    });
    expect(saved?.rowKeys).toHaveLength(8_000);
    expect(await repository.pause(ensured.job.jobId, "owner", new Date("2026-10-08T11:00:03.000Z"))).toMatchObject({ status: "PAUSED" });

    await first.$disconnect();
    first = new PrismaClient({ datasources: { db: { url: databaseUrl(join(root, "job.sqlite")) } } });
    const restoredRepository = createSellerSpriteCaptureJobRepository(first);
    const restored = await restoredRepository.getByFingerprint(ensured.job.queryFingerprint);
    expect(restored).toMatchObject({
      status: "PAUSED",
      captureGeneration: 1,
      rowKeys,
      structuredValidRowKeys: rowKeys,
      persistedRowKeys: rowKeys,
      evidenceRefs,
      cursor: { page: 400, scrollY: 0, scrollTarget: "document" },
      counters: { capturedUniqueRows: 8_000, structuredValidRows: 8_000, persistedEvidenceRows: 8_000 },
    });
    expect(await restoredRepository.resume(ensured.job.jobId, "owner", new Date("2026-10-08T11:00:04.000Z"))).toMatchObject({ status: "PENDING" });
    const resumed = await restoredRepository.claim(ensured.job.jobId, "recovered-worker", new Date("2026-10-08T11:00:05.000Z"));
    expect(resumed?.job).toMatchObject({
      status: "RUNNING",
      captureGeneration: 1,
      attemptGeneration: 2,
      rowKeys,
      persistedRowKeys: rowKeys,
      cursor: { page: 400, scrollY: 0, scrollTarget: "document" },
    });
  });
});
