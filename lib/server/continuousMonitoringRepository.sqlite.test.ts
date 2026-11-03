import { DatabaseSync } from "node:sqlite";
import { checkedInMigrationNames, replayAllCheckedInMigrations } from "@/lib/marketScan/__fixtures__/migrationReplay";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_MONITORING_POLICY } from "@/lib/server/continuousMonitoringContract";
import type { MonitoringEvidenceReference } from "@/lib/server/continuousMonitoringDiff";
import { createMonitoringRepository, type MonitoringWatchTarget } from "@/lib/server/continuousMonitoringRepository";

let root = "";
let databasePath = "";
let first: PrismaClient;
let second: PrismaClient;

function databaseUrl(path: string): string {
  return `file:${path.replaceAll("\\", "/")}`;
}

function makeWatch(id = "watch-one", nextRunAt = "2026-09-28T01:00:00.000Z"): MonitoringWatchTarget {
  return {
    id,
    subjectKey: "amazon:US:B0113UZJE2",
    captureModule: "amazon_detail",
    enabled: true,
    schedule: "daily@09:00",
    timezone: "Asia/Shanghai",
    policy: DEFAULT_MONITORING_POLICY,
    lastRunAt: null,
    lastMeaningfulChangeAt: null,
    nextRunAt,
    activeRunId: null,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
}

const reference: MonitoringEvidenceReference = {
  subjectKey: "amazon:US:B0113UZJE2",
  module: "amazon_detail",
  attachmentId: "att-0123456789abcdef01234567",
  contentHash: "a".repeat(64),
  capturedAt: "2026-09-27T01:00:00.000Z",
  sourceType: "amazon_dom",
  provider: "Amazon",
  acquisitionMode: "DOM_DIRECT",
  metricNature: "source_observed",
  rawArtifactId: "raw-0123456789abcdef01234567",
  rawArtifactHash: "b".repeat(64),
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "continuous-monitoring-test-"));
  databasePath = join(root, "monitoring.sqlite");
  first = new PrismaClient({ datasources: { db: { url: databaseUrl(databasePath) } } });
  second = new PrismaClient({ datasources: { db: { url: databaseUrl(databasePath) } } });
  const database = new DatabaseSync(databasePath);
  try { expect(replayAllCheckedInMigrations(database)).toHaveLength(checkedInMigrationNames().length); } finally { database.close(); }

});

afterEach(async () => {
  await Promise.all([first?.$disconnect(), second?.$disconnect()]);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("continuous monitoring SQLite repository", () => {
  it("persists the watch, schedule, policy, and run history across repository instances", async () => {
    const original = makeWatch();
    await createMonitoringRepository(first).createWatch(original);
    const fromSecondConnection = await createMonitoringRepository(second).getWatch(original.id);
    expect(fromSecondConnection).toMatchObject({
      subjectKey: original.subjectKey,
      schedule: original.schedule,
      timezone: original.timezone,
      policy: original.policy,
      nextRunAt: original.nextRunAt,
    });

    const started = await createMonitoringRepository(first).beginRun({
      watchTargetId: original.id,
      runId: "run-persisted",
      triggerType: "MANUAL",
      startedAt: "2026-09-27T01:00:00.000Z",
      nextRunAt: "2026-09-28T01:00:00.000Z",
    });
    expect(started.kind).toBe("STARTED");
    if (started.kind !== "STARTED") return;
    await createMonitoringRepository(first).completeRun({
      runId: started.run.id,
      watchTargetId: original.id,
      finishedAt: "2026-09-27T01:01:00.000Z",
      outcome: "BASELINE_ESTABLISHED",
      previousEvidenceRef: null,
      currentEvidenceRef: reference,
      changeSummary: { meaningfulChange: false, diffs: [] },
      aiExplanation: null,
      meaningfulChange: false,
    });
    const readback = await createMonitoringRepository(second).listRuns(original.id);
    expect(readback[0]).toMatchObject({
      id: "run-persisted",
      status: "SUCCEEDED",
      outcome: "BASELINE_ESTABLISHED",
      currentEvidenceRef: reference,
    });
    expect(await createMonitoringRepository(second).latestBaseline(original.id)).toEqual(reference);
  });

  it("atomically prevents manual/scheduled overlap across separate SQLite clients", async () => {
    // Both requests race after the schedule is due; otherwise the scheduled path can
    // legitimately return NOT_DUE before the competing transaction claims the watch.
    const original = makeWatch("watch-one", "2026-09-27T00:00:00.000Z");
    await createMonitoringRepository(first).createWatch(original);
    const results = await Promise.all([
      createMonitoringRepository(first).beginRun({
        watchTargetId: original.id,
        runId: "run-manual",
        triggerType: "MANUAL",
        startedAt: "2026-09-27T01:00:00.000Z",
        nextRunAt: "2026-09-28T01:00:00.000Z",
      }),
      createMonitoringRepository(second).beginRun({
        watchTargetId: original.id,
        runId: "run-scheduled",
        triggerType: "SCHEDULED",
        startedAt: "2026-09-27T01:00:01.000Z",
        nextRunAt: "2026-09-28T01:00:00.000Z",
      }),
    ]);
    expect(results.filter((result) => result.kind === "STARTED")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "OVERLAP")).toHaveLength(1);
    const runs = await createMonitoringRepository(first).listRuns(original.id);
    expect(runs.filter((run) => run.status === "RUNNING")).toHaveLength(1);
    expect(runs.filter((run) => run.status === "SKIPPED_OVERLAP")).toHaveLength(1);
  });

  it("rehydrates due schedules, persists disable changes, and prevents a disabled run", async () => {
    const original = makeWatch("watch-due", "2026-09-27T00:00:00.000Z");
    const repository = createMonitoringRepository(first);
    await repository.createWatch(original);
    expect(await createMonitoringRepository(second).listDueWatches(new Date("2026-09-27T00:01:00.000Z"))).toHaveLength(1);
    await repository.updateWatch(original.id, { enabled: false }, "2026-09-28T01:00:00.000Z");
    expect(await createMonitoringRepository(second).listDueWatches(new Date("2026-09-29T00:00:00.000Z"))).toHaveLength(0);
    const disabled = await repository.beginRun({
      watchTargetId: original.id,
      runId: "run-disabled",
      triggerType: "MANUAL",
      startedAt: "2026-09-27T01:00:00.000Z",
      nextRunAt: "2026-09-28T01:00:00.000Z",
    });
    expect(disabled.kind).toBe("DISABLED");
    if (disabled.kind === "DISABLED") expect(disabled.run.status).toBe("SKIPPED_DISABLED");
  });

  it("preserves run history by restricting physical watch deletion", async () => {
    const original = makeWatch("watch-history-protected");
    const repository = createMonitoringRepository(first);
    await repository.createWatch(original);
    const started = await repository.beginRun({
      watchTargetId: original.id,
      runId: "run-history-protected",
      triggerType: "MANUAL",
      startedAt: "2026-09-27T01:00:00.000Z",
      nextRunAt: "2026-09-28T01:00:00.000Z",
    });
    expect(started.kind).toBe("STARTED");
    if (started.kind !== "STARTED") return;
    await repository.completeRun({
      runId: started.run.id,
      watchTargetId: original.id,
      finishedAt: "2026-09-27T01:01:00.000Z",
      outcome: "BASELINE_ESTABLISHED",
      previousEvidenceRef: null,
      currentEvidenceRef: reference,
      changeSummary: { meaningfulChange: false, diffs: [] },
      aiExplanation: null,
      meaningfulChange: false,
    });

    await expect(first.$executeRawUnsafe('DELETE FROM "WatchTarget" WHERE "id" = ?', original.id)).rejects.toThrow();
    expect(await repository.getWatch(original.id)).not.toBeNull();
    expect(await repository.getRun("run-history-protected")).toMatchObject({ status: "SUCCEEDED" });
  });

  it("marks interrupted runs failed and releases their persisted lock on restart recovery", async () => {
    const original = makeWatch("watch-interrupted", "2026-09-27T00:00:00.000Z");
    const repository = createMonitoringRepository(first);
    await repository.createWatch(original);
    const started = await repository.beginRun({
      watchTargetId: original.id,
      runId: "run-interrupted",
      triggerType: "SCHEDULED",
      startedAt: "2026-09-27T01:00:00.000Z",
      nextRunAt: "2026-09-28T01:00:00.000Z",
    });
    expect(started.kind).toBe("STARTED");
    expect(await createMonitoringRepository(second).recoverInterruptedRuns("2026-09-27T02:00:00.000Z")).toBe(1);
    const recoveredWatch = await repository.getWatch(original.id);
    const recoveredRun = await repository.getRun("run-interrupted");
    expect(recoveredWatch?.activeRunId).toBeNull();
    expect(recoveredRun).toMatchObject({ status: "FAILED", outcome: "RUN_FAILED", errorCode: "APPLICATION_RESTARTED" });
  });
});
