import { describe, expect, it, vi } from "vitest";

import { createContinuousMonitoringScheduler } from "@/lib/server/continuousMonitoringScheduler";
import type { MonitoringRepository, MonitoringWatchTarget } from "@/lib/server/continuousMonitoringRepository";

function watch(id: string): MonitoringWatchTarget {
  return {
    id,
    subjectKey: `amazon:US:${id.padEnd(10, "0").slice(0, 10)}`,
    captureModule: "amazon_detail",
    enabled: true,
    schedule: "daily@09:00",
    timezone: "Asia/Shanghai",
    policy: { cooldownMinutes: 0, rules: [{ field: "reviewCount", comparison: "numeric_delta", absoluteThreshold: 1, relativeThreshold: null, enabled: true }] },
    lastRunAt: null,
    lastMeaningfulChangeAt: null,
    nextRunAt: "2026-09-27T00:00:00.000Z",
    activeRunId: null,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
}

function repository(overrides: Partial<MonitoringRepository> = {}): MonitoringRepository {
  return {
    createWatch: vi.fn(),
    getWatch: vi.fn(),
    listWatches: vi.fn(),
    updateWatch: vi.fn(),
    listDueWatches: vi.fn(async () => [watch("one"), watch("two")]),
    latestBaseline: vi.fn(),
    beginRun: vi.fn(),
    completeRun: vi.fn(),
    failRun: vi.fn(),
    listRuns: vi.fn(),
    getRun: vi.fn(),
    recoverInterruptedRuns: vi.fn(async () => 0),
    ...overrides,
  };
}

describe("continuous monitoring scheduler", () => {
  it("recovers interrupted runs, rehydrates all due enabled targets, and isolates a failed target", async () => {
    const db = repository();
    const runTarget = vi.fn(async (id: string) => {
      if (id === "one") throw new Error("private browser detail is not logged");
    });
    const scheduler = createContinuousMonitoringScheduler({
      repository: db,
      runTarget,
      schedulePolling: false,
      now: () => new Date("2026-09-27T01:00:00.000Z"),
    });

    await scheduler.runDueNow();

    expect(db.recoverInterruptedRuns).toHaveBeenCalledTimes(1);
    expect(db.listDueWatches).toHaveBeenCalledTimes(1);
    expect(runTarget.mock.calls.map(([id]) => id)).toEqual(["one", "two"]);
    expect(scheduler.getState().recoveryComplete).toBe(true);
  });

  it("does not re-run startup recovery after it has completed", async () => {
    const db = repository();
    const scheduler = createContinuousMonitoringScheduler({ repository: db, schedulePolling: false });
    await scheduler.runDueNow();
    await scheduler.runDueNow();
    expect(db.recoverInterruptedRuns).toHaveBeenCalledTimes(1);
    expect(db.listDueWatches).toHaveBeenCalledTimes(2);
  });

  it("coalesces overlapping timer ticks while a due query is still in flight", async () => {
    let release!: (targets: MonitoringWatchTarget[]) => void;
    const pending = new Promise<MonitoringWatchTarget[]>((resolve) => {
      release = resolve;
    });
    const db = repository({
      listDueWatches: vi.fn(async () => pending),
    });
    const scheduler = createContinuousMonitoringScheduler({ repository: db, schedulePolling: false });
    const firstTick = scheduler.runDueNow();
    await Promise.resolve();
    const secondTick = scheduler.runDueNow();
    expect(db.listDueWatches).toHaveBeenCalledTimes(1);
    release([]);
    await Promise.all([firstTick, secondTick]);
  });
});
