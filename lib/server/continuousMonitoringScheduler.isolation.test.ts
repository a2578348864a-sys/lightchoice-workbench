import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkedInMigrationNames, replayAllCheckedInMigrations } from "@/lib/marketScan/__fixtures__/migrationReplay";
import { DEFAULT_MONITORING_POLICY } from "@/lib/server/continuousMonitoringContract";
import type { MonitoringCaptureOutcome, MonitoringEvidenceReference } from "@/lib/server/continuousMonitoringDiff";
import { createMonitoringRepository, type MonitoringWatchTarget } from "@/lib/server/continuousMonitoringRepository";
import {
  continuousMonitoringSchedulerConfigEnabled,
  createContinuousMonitoringScheduler,
} from "@/lib/server/continuousMonitoringScheduler";
import { runMonitoringTarget } from "@/lib/server/continuousMonitoringService";
import type { V3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";

/**
 * 持续监控自动调度的隔离验证。
 *
 * 约束：
 * - 独立临时 SQLite 副本，不连正式库、不连正式 EvidenceStore；
 * - 模拟时钟（now 注入），不等待真实时间；
 * - 采集用安全替身（不发起任何 Amazon 请求）；
 * - 只验证调度行为本身，不改任何生产配置。
 */

const ASIN = "B0DKNN9WCX";
const SUBJECT_KEY = `amazon:US:${ASIN}`;
const CAPTURED_AT = "2026-11-02T01:00:00.000Z";

let root = "";
let databasePath = "";
let prisma: PrismaClient;

function databaseUrl(path: string): string {
  return `file:${path.replaceAll("\\", "/")}`;
}

function makeWatch(overrides: Partial<MonitoringWatchTarget> = {}): MonitoringWatchTarget {
  return {
    id: "watch-one",
    subjectKey: SUBJECT_KEY,
    captureModule: "amazon_detail",
    enabled: true,
    schedule: "daily@09:00",
    timezone: "Asia/Shanghai",
    policy: DEFAULT_MONITORING_POLICY,
    lastRunAt: null,
    lastMeaningfulChangeAt: null,
    nextRunAt: "2026-11-02T01:00:00.000Z",
    activeRunId: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function evidenceRef(overrides: Partial<MonitoringEvidenceReference> = {}): MonitoringEvidenceReference {
  return {
    subjectKey: SUBJECT_KEY,
    module: "amazon_detail",
    attachmentId: "att-0123456789abcdef01234567",
    contentHash: "a".repeat(64),
    capturedAt: CAPTURED_AT,
    sourceType: "amazon_dom",
    provider: "Amazon",
    acquisitionMode: "DOM_DIRECT",
    metricNature: "source_observed",
    rawArtifactId: "raw-0123456789abcdef01234567",
    rawArtifactHash: "b".repeat(64),
    ...overrides,
  };
}

function stubEvidence(values: { price: number; rating: number; reviewCount: number }, reference: MonitoringEvidenceReference): V3ModuleEvidence {
  const field = (name: string, value: unknown) => ({
    canonicalField: name,
    priority: "P0",
    fieldNature: "DIRECT_FACT",
    status: "observed",
    reason: null,
    value,
    sourceTrace: { ruleId: name, registryVersion: "amazon-detail-field-registry.v1", region: "primary_product_title", label: null },
  });
  return {
    schemaVersion: "capture-system-v3-module-evidence.v1",
    module: "amazon_detail",
    subjectKey: reference.subjectKey,
    marketplace: "US",
    capturedAt: reference.capturedAt,
    provider: reference.provider,
    sourceSurface: "amazon_dom",
    sourceUrl: `https://www.amazon.com/dp/${ASIN}`,
    providerUpdatedAt: null,
    freshness: { capturedAt: reference.capturedAt, observedAt: reference.capturedAt, ageSeconds: 0, status: "fresh" },
    acquisitionMode: reference.acquisitionMode,
    metricNature: reference.metricNature,
    status: "VALIDATED_AVAILABLE",
    limitations: [],
    identity: { asin: ASIN },
    data: {
      registeredFields: {
        price: field("price", { amount: values.price, currency: "USD" }),
        rating: field("rating", values.rating),
        reviewCount: field("reviewCount", values.reviewCount),
      },
    },
    evidenceOnly: true,
  } as unknown as V3ModuleEvidence;
}

/** 安全采集替身：记录调用次数并返回构造好的快照，绝不发起网络请求。 */
function captureStub(calls: string[], values = { price: 29.99, rating: 4.5, reviewCount: 856 }) {
  return async (watch: MonitoringWatchTarget): Promise<MonitoringCaptureOutcome> => {
    calls.push(watch.id);
    const reference = evidenceRef({ capturedAt: CAPTURED_AT });
    return {
      status: "CAPTURED",
      snapshot: {
        sourceType: "amazon_dom",
        evidence: stubEvidence(values, reference),
        evidenceRef: reference,
      },
    };
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "monitoring-scheduler-isolation-"));
  databasePath = join(root, "monitoring.sqlite");
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl(databasePath) } } });
  const database = new DatabaseSync(databasePath);
  try {
    expect(replayAllCheckedInMigrations(database)).toHaveLength(checkedInMigrationNames().length);
  } finally {
    database.close();
  }
});

afterEach(async () => {
  await prisma?.$disconnect();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("持续监控自动调度（隔离环境）", () => {
  it("到期才执行：未到期的监控不会被采集", async () => {
    const repository = createMonitoringRepository(prisma);
    const calls: string[] = [];
    const clock = new Date("2026-11-02T00:30:00.000Z");
    await repository.createWatch(makeWatch({ nextRunAt: "2026-11-02T01:00:00.000Z" }));

    const scheduler = createContinuousMonitoringScheduler({
      repository,
      now: () => clock,
      schedulePolling: false,
      runTarget: (watchTargetId) => runMonitoringTarget({ watchTargetId, triggerType: "SCHEDULED" }, {
        repository,
        capture: captureStub(calls),
        explain: async () => ({ status: "UNAVAILABLE", code: "AI_EXPLANATION_DISABLED" }),
        loadSnapshot: async () => null,
        now: () => clock,
      }),
    });

    await scheduler.runDueNow();
    expect(calls).toEqual([]);

    clock.setTime(Date.parse("2026-11-02T01:00:00.000Z"));
    await scheduler.runDueNow();
    expect(calls).toEqual(["watch-one"]);
  });

  it("过期任务只补跑一次，不会按错过次数放大", async () => {
    const repository = createMonitoringRepository(prisma);
    const calls: string[] = [];
    const clock = new Date("2026-12-02T01:00:00.000Z");
    // 30 天前就该跑，但只应补跑一次
    await repository.createWatch(makeWatch({ nextRunAt: "2026-11-02T01:00:00.000Z" }));

    const scheduler = createContinuousMonitoringScheduler({
      repository,
      now: () => clock,
      schedulePolling: false,
      runTarget: (watchTargetId) => runMonitoringTarget({ watchTargetId, triggerType: "SCHEDULED" }, {
        repository,
        capture: captureStub(calls),
        explain: async () => ({ status: "UNAVAILABLE", code: "AI_EXPLANATION_DISABLED" }),
        loadSnapshot: async () => null,
        now: () => clock,
      }),
    });

    await scheduler.runDueNow();
    expect(calls).toHaveLength(1);

    // 下一次 tick：nextRunAt 已推进到下一个每日时刻，不再重复采集
    await scheduler.runDueNow();
    expect(calls).toHaveLength(1);

    const watch = await repository.getWatch("watch-one");
    expect(watch?.nextRunAt).toBe("2026-12-03T01:00:00.000Z");
  });

  it("手动检查已认领时，自动调度记为跳过，不会并发采集同一个商品", async () => {
    const repository = createMonitoringRepository(prisma);
    const calls: string[] = [];
    const clock = new Date("2026-11-02T01:00:00.000Z");
    await repository.createWatch(makeWatch());

    // 先用手动触发占住该监控（模拟用户点了「立即检查」）
    const manual = await runMonitoringTarget({ watchTargetId: "watch-one", triggerType: "MANUAL" }, {
      repository,
      capture: captureStub(calls),
      explain: async () => ({ status: "UNAVAILABLE", code: "AI_EXPLANATION_DISABLED" }),
      loadSnapshot: async () => null,
      now: () => clock,
    });
    expect(manual.status).toBe("STARTED");
    expect(calls).toEqual(["watch-one"]);

    const scheduler = createContinuousMonitoringScheduler({
      repository,
      now: () => clock,
      schedulePolling: false,
      runTarget: (watchTargetId) => runMonitoringTarget({ watchTargetId, triggerType: "SCHEDULED" }, {
        repository,
        capture: captureStub(calls),
        explain: async () => ({ status: "UNAVAILABLE", code: "AI_EXPLANATION_DISABLED" }),
        loadSnapshot: async () => null,
        now: () => clock,
      }),
    });

    await scheduler.runDueNow();
    // 没有第二次采集：并发被 DB 认领挡住
    expect(calls).toEqual(["watch-one"]);
  });

  it("采集失败会被如实记为失败，且不会自动停用监控、不会当次重试", async () => {
    const repository = createMonitoringRepository(prisma);
    const calls: string[] = [];
    const clock = new Date("2026-11-02T01:00:00.000Z");
    await repository.createWatch(makeWatch());

    const scheduler = createContinuousMonitoringScheduler({
      repository,
      now: () => clock,
      schedulePolling: false,
      runTarget: (watchTargetId) => runMonitoringTarget({ watchTargetId, triggerType: "SCHEDULED" }, {
        repository,
        capture: async (watch) => {
          calls.push(watch.id);
          return { status: "FAILED", errorCode: "LOCAL_ENVIRONMENT_REQUIRED" };
        },
        explain: async () => ({ status: "UNAVAILABLE", code: "AI_EXPLANATION_DISABLED" }),
        loadSnapshot: async () => null,
        now: () => clock,
      }),
    });

    await scheduler.runDueNow();
    expect(calls).toEqual(["watch-one"]);

    const runs = await repository.listRuns("watch-one", 10);
    const failed = runs.find((run) => run.status === "FAILED");
    expect(failed?.errorCode).toBe("LOCAL_ENVIRONMENT_REQUIRED");
    expect(failed?.outcome).toBe("RUN_FAILED");

    const watch = await repository.getWatch("watch-one");
    expect(watch?.enabled).toBe(true);
    expect(watch?.activeRunId).toBeNull();

    // 失败不会在同一次调度里被无限重试：只有下一个每日槽位才会再试
    await scheduler.runDueNow();
    expect(calls).toEqual(["watch-one"]);
  });

  it("进程重启后：遗留的运行被标记为中断，且监控可继续被调度", async () => {
    const repository = createMonitoringRepository(prisma);
    const clock = new Date("2026-11-02T01:00:00.000Z");
    await repository.createWatch(makeWatch());

    // 直接写一条「进程崩溃前遗留」的 RUNNING 记录
    await prisma.monitoringRun.create({
      data: {
        id: "run-stuck",
        watchTargetId: "watch-one",
        triggerType: "SCHEDULED",
        status: "RUNNING",
        outcome: null,
        startedAt: "2026-11-02T00:59:00.000Z",
        finishedAt: null,
        errorCode: null,
        errorMessage: null,
        previousEvidenceRefJson: null,
        currentEvidenceRefJson: null,
        changeSummaryJson: null,
        aiExplanationJson: null,
      },
    });

    const calls: string[] = [];
    const scheduler = createContinuousMonitoringScheduler({
      repository,
      now: () => clock,
      schedulePolling: false,
      runTarget: (watchTargetId) => runMonitoringTarget({ watchTargetId, triggerType: "SCHEDULED" }, {
        repository,
        capture: captureStub(calls),
        explain: async () => ({ status: "UNAVAILABLE", code: "AI_EXPLANATION_DISABLED" }),
        loadSnapshot: async () => null,
        now: () => clock,
      }),
    });

    await scheduler.runDueNow();
    expect(scheduler.getState().recoveryComplete).toBe(true);

    const stuck = await repository.getRun("run-stuck");
    expect(stuck?.status).toBe("FAILED");
    expect(stuck?.errorCode).toBe("APPLICATION_RESTARTED");

    const watch = await repository.getWatch("watch-one");
    expect(watch?.activeRunId).toBeNull();
  });

  it("退役后任何环境变量都不能重新启动调度器", () => {
    const asEnv = (value: Record<string, string>) => value as unknown as NodeJS.ProcessEnv;
    expect(continuousMonitoringSchedulerConfigEnabled(asEnv({}))).toBe(false);
    // V6 退役：历史 opt-in 开关保留兼容，但不再具备启动能力。
    expect(continuousMonitoringSchedulerConfigEnabled(asEnv({ V5_ENABLE_CONTINUOUS_MONITORING_SCHEDULER: "1" }))).toBe(false);
    expect(continuousMonitoringSchedulerConfigEnabled(asEnv({
      V5_ENABLE_CONTINUOUS_MONITORING_SCHEDULER: "1",
      V5_DISABLE_CONTINUOUS_MONITORING_SCHEDULER: "0",
    }))).toBe(false);
  });

  it("调度器可观测：最近一次调度的时间、结果与失败计数可读", async () => {
    const repository = createMonitoringRepository(prisma);
    const calls: string[] = [];
    const clock = new Date("2026-11-02T01:00:00.000Z");
    await repository.createWatch(makeWatch());

    const scheduler = createContinuousMonitoringScheduler({
      repository,
      now: () => clock,
      schedulePolling: false,
      runTarget: (watchTargetId) => runMonitoringTarget({ watchTargetId, triggerType: "SCHEDULED" }, {
        repository,
        capture: captureStub(calls),
        explain: async () => ({ status: "UNAVAILABLE", code: "AI_EXPLANATION_DISABLED" }),
        loadSnapshot: async () => null,
        now: () => clock,
      }),
    });

    expect(scheduler.getState().tick.lastTickAt).toBeNull();
    await scheduler.runDueNow();
    const state = scheduler.getState();
    expect(state.tick.lastTickAt).toBe("2026-11-02T01:00:00.000Z");
    expect(state.tick.lastTickStatus).toBe("ok");
    expect(state.tick.lastTickWatchCount).toBe(1);
    expect(state.tick.lastTickFailureCount).toBe(0);
    expect(state.tick.lastTickError).toBeNull();
  });
});
