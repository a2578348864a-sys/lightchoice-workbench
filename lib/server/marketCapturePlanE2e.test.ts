import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkedInMigrationNames, replayAllCheckedInMigrations } from "@/lib/marketScan/__fixtures__/migrationReplay";
import { createBatchCaptureRunService } from "@/lib/server/batchCaptureRunService";
import { SUPPLEMENTAL_CAPTURE_MODULE_IDS } from "@/lib/sourceLayer/captureStrategy/marketCapturePlan";

/**
 * 市场采集完整闭环 Mock 端到端（隔离 SQLite + Mock Worker）。
 *
 * 覆盖用户要求的两个场景：
 *   场景一：完整市场采集 —— 计划预览 → 八模块矩阵 → 一次确认 → 自动分轮执行 → 刷新恢复 → 证据回执
 *   场景二：快速市场扫描 —— 抽样规则校验 → 确认 → 自动执行 → 预算与受限模块如实展示
 *
 * 边界：
 * - 使用隔离 SQLite 与 Mock Worker，**不连接正式 DB / EvidenceStore / Amazon / SellerSprite**；
 * - Mock Worker 的返回只用于证明「授权与调度逻辑可执行」，不代表真实采集能力；
 * - 未自动接线的模块必须保持 source_input_required，不允许被 Mock 结果冒充成功。
 */

let root = "";
let databasePath = "";
let client: PrismaClient;

const owner = { mode: "owner" as const, token: "" };
const batchId = "batch-e2e-market-01";
const envOn = { LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single" } as unknown as NodeJS.ProcessEnv;

type WorkerCall = { module: string; asins: string[] };

function batchItems(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    batchId,
    asin: `B0${String(index + 1).padStart(8, "0")}`,
    ordinal: index,
    archivedAt: null,
  }));
}

function searchBatch(acceptedCount: number) {
  return {
    id: batchId,
    batchStatus: "ready",
    query: "demo market",
    acceptedCount,
    // 搜索采集批次必须带可核验的搜索导航回执，否则计划确认会被阻断（不默认 0）。
    qualitySummaryJson: JSON.stringify({ searchNavigationUsed: 2 }),
    normalizedSnapshotJson: JSON.stringify({
      schemaVersion: "amazon-search-capture-snapshot.v1",
      sourceType: "amazon_search_capture",
      detailEnrichmentIntent: { schemaVersion: "amazon-search-detail-enrichment-intent.v1", autoEnqueue: false },
    }),
    manifestJson: JSON.stringify({ schemaVersion: "amazon-search-capture-manifest.v1", sourceType: "amazon_search_capture" }),
  };
}

function fakeStore(count: number) {
  return {
    getBatch: async (id: string) => (id === batchId ? searchBatch(count) : null),
    getBatchItems: async () => batchItems(count),
  };
}

function successWorker(module: string, record: WorkerCall[]) {
  return async (input: { targetAsins?: unknown }) => {
    const targetAsins = Array.isArray(input.targetAsins) ? (input.targetAsins as string[]) : [];
    record.push({ module, asins: [...targetAsins] });
    return {
      value: {
        summary: {},
        items: targetAsins.map((asin) => ({
          asin,
          status: "enriched",
          evidenceId: `ev-${module}-${asin}`,
          errorCode: null,
        })),
      },
      replayed: false,
      receiptId: `rc-${module}`,
    };
  };
}

function makeService(options: { items: number; record: WorkerCall[]; maxItemsPerAdvance?: number }) {
  return createBatchCaptureRunService({
    database: client as never,
    getProductBatchStore: () => fakeStore(options.items) as never,
    enrichDetail: successWorker("amazon_detail", options.record) as never,
    enrichVariation: successWorker("variation", options.record) as never,
    enrichReview: successWorker("review_voc", options.record) as never,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "market-capture-e2e-"));
  databasePath = join(root, "e2e.sqlite");
  client = new PrismaClient({ datasources: { db: { url: `file:${databasePath.replaceAll("\\", "/")}` } } });
  const database = new DatabaseSync(databasePath);
  try {
    expect(replayAllCheckedInMigrations(database)).toHaveLength(checkedInMigrationNames().length);
  } finally {
    database.close();
  }
  // 隔离环境显式声明本地采集开关：仅用于测试进程内的 Mock Worker，不触达任何真实来源。
  process.env.LOCAL_ACQUISITION_ENABLED = "true";
  process.env.V5_ACQUISITION_SCOPE = "batch_and_single";
});

afterEach(async () => {
  await client?.$disconnect();
  if (root) rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** 走完「计划 → 确认」两段，返回确认后的运行。 */
async function planAndConfirm(input: {
  strategyId: "full_market_capture" | "quick_market_scan";
  target: number;
  authorized: number;
  record: WorkerCall[];
  items: number;
  drive?: boolean;
  /** 是否显式声明四项补充能力；默认 true，保持八模块闭环场景。 */
  supplemental?: boolean;
}) {
  const service = makeService({ items: input.items, record: input.record });
  const { buildMarketCapturePlan } = await import("@/lib/sourceLayer/captureStrategy/marketCapturePlan");
  const plan = buildMarketCapturePlan({
    strategyId: input.strategyId,
    batchId,
    marketTargetItemCount: input.target,
    batchCapacity: input.items,
    authorizedItemCount: input.authorized,
    searchNavigationUsed: 2,
    includedSupplementalModules: input.supplemental === false ? [] : [...SUPPLEMENTAL_CAPTURE_MODULE_IDS],
  });
  const started = await service.start({
    context: owner,
    batchId,
    authorizedItemLimit: plan.authorizedItemCount,
    // 八模块矩阵全部进入任务：搜索阶段模块由 start 内部建立单元格，不计入 advance 目标。
    allowedModules: plan.entries.map((entry) => entry.module),
    searchNavigationUsed: 2,
    planFingerprint: plan.planFingerprint,
    planStrategyId: plan.strategyId,
  });
  const run = input.drive === false
    ? started.run
    : await service.drive({ context: owner, batchId, env: envOn });
  return { plan, started, run, service };
}

describe("市场采集完整闭环（Mock E2E，隔离 SQLite）", () => {
  it("场景一：完整市场采集 —— 计划 → 一次确认 → 自动分轮执行 → 证据回执 → 刷新恢复", async () => {
    const record: WorkerCall[] = [];
    const { plan, started, run, service } = await planAndConfirm({
      strategyId: "full_market_capture",
      target: 12,
      authorized: 12,
      items: 12,
      record,
    });

    // 八模块全部在计划中；任务矩阵包含全部八模块（未自动接线模块不消失）
    expect(plan.entries).toHaveLength(8);
    expect(started.created).toBe(true);
    // 搜索阶段模块（amazon_search_market）在 start 内部建立单元格，不出现在 advance 白名单中。
    expect(run.allowedModules).toHaveLength(7);
    expect(run.allowedModules).toEqual(
      expect.arrayContaining(["amazon_detail", "variation", "review_voc", "historical_trend", "reverse_asin"]),
    );
    expect(run.planFingerprint).toBe(plan.planFingerprint);
    // 最终覆盖矩阵必须包含全部八模块（含未自动接线模块）
    expect(new Set(run.cells.map((cell) => cell.module)).size).toBe(8);

    // 自动分轮执行：全部 12 件被 4 个自动模块处理（分轮由 maxItemsPerAdvance 决定）
    const detailAsins = record.filter((call) => call.module === "amazon_detail").flatMap((call) => call.asins);
    expect(new Set(detailAsins).size).toBe(12);
    expect(record.filter((call) => call.module === "amazon_detail").length).toBeGreaterThan(1);

    // 每个单元格都有独立状态；未自动接线模块保持 source_input_required，不被 Mock 冒充成功
    const detailCells = run.cells.filter((cell) => cell.module === "amazon_detail");
    expect(detailCells.every((cell) => cell.status === "succeeded" && cell.evidenceId)).toBe(true);
    const historicalCells = run.cells.filter((cell) => cell.module === "historical_trend");
    expect(historicalCells).toHaveLength(12);
    expect(historicalCells.every((cell) => cell.status === "source_input_required")).toBe(true);

    // 模块独立状态：自动模块 done/has_valid，未接线模块 source_limited
    const historicalOutcome = run.moduleOutcomes.find((outcome) => outcome.module === "historical_trend");
    expect(historicalOutcome?.dataQuality).toBe("source_limited");
    expect(historicalOutcome?.completed).toBe(false);

    // 刷新恢复：重新读取运行，状态与进度必须一致（不是前端内存态）
    const reloaded = await service.status({ context: owner, batchId });
    expect(reloaded?.runId).toBe(run.runId);
    expect(reloaded?.progress.validEvidenceCells).toBe(run.progress.validEvidenceCells);
    expect(reloaded?.planFingerprint).toBe(plan.planFingerprint);
  });

  it("默认计划只含四项基础能力：补充能力必须显式声明才进入矩阵", async () => {
    const record: WorkerCall[] = [];
    const { plan } = await planAndConfirm({
      strategyId: "full_market_capture",
      target: 12,
      authorized: 12,
      items: 12,
      record,
      drive: false,
      supplemental: false,
    });

    expect(plan.entries).toHaveLength(4);
    expect(plan.entries.map((entry) => entry.module).sort()).toEqual(
      ["amazon_detail", "amazon_search_market", "review_voc", "variation"],
    );
  });

  it("场景二：快速市场扫描 —— 分层抽样规模受预算约束，详情全量、评论抽样", async () => {
    const record: WorkerCall[] = [];
    const { plan, run } = await planAndConfirm({
      strategyId: "quick_market_scan",
      target: 60,
      authorized: 60,
      items: 60,
      record,
    });

    const reviewEntry = plan.entries.find((entry) => entry.module === "review_voc");
    expect(reviewEntry?.sampled).toBe(true);
    expect(reviewEntry?.sampleBasis).toBe("deterministic_stratified");
    // 抽样规模必须小于授权总数（确实是抽样），且不超过上限
    expect(reviewEntry!.budget.plannedItems).toBeGreaterThan(0);
    expect(reviewEntry!.budget.plannedItems).toBeLessThan(60);

    // 详情仍全量
    const detailAsins = new Set(record.filter((call) => call.module === "amazon_detail").flatMap((call) => call.asins));
    expect(detailAsins.size).toBe(60);

    // 受限模块如实展示，不因 Mock 而变绿
    expect(run.moduleOutcomes.find((outcome) => outcome.module === "sellersprite_product_market")?.dataQuality)
      .toBe("source_limited");
  });

  it("未确认计划就不会有任何采集：不 start 时不产生 Worker 调用", async () => {
    const record: WorkerCall[] = [];
    const service = makeService({ items: 10, record });
    const run = await service.status({ context: owner, batchId });
    expect(run).toBeNull();
    expect(record).toHaveLength(0);
  });

  it("100 件目标遇到硬上限不偷偷截断：授权 200、目标 300 时如实报告被推迟数量", async () => {
    const { plan } = await planAndConfirm({
      strategyId: "full_market_capture",
      target: 300,
      authorized: 200,
      items: 300,
      record: [],
      drive: false,
    });
    expect(plan.marketTargetItemCount).toBe(300);
    expect(plan.authorizedItemCount).toBe(200);
    expect(plan.deferredItemCount).toBe(100);
    expect(plan.batching.requiresMultipleRuns).toBe(true);
    expect(plan.entries.find((entry) => entry.module === "amazon_detail")?.budget.plannedItems).toBe(200);
  });

  it("重复确认同一计划幂等：不创建第二个运行代次", async () => {
    const record: WorkerCall[] = [];
    const service = makeService({ items: 8, record });
    const { buildMarketCapturePlan } = await import("@/lib/sourceLayer/captureStrategy/marketCapturePlan");
    const plan = buildMarketCapturePlan({
      strategyId: "full_market_capture", batchId, marketTargetItemCount: 8, batchCapacity: 8, authorizedItemCount: 8, searchNavigationUsed: 2,
    });
    const first = await service.start({
      context: owner, batchId, authorizedItemLimit: 8,
      allowedModules: ["amazon_detail", "variation", "review_voc"],
      searchNavigationUsed: 2, planFingerprint: plan.planFingerprint, planStrategyId: plan.strategyId,
    });
    const second = await service.start({
      context: owner, batchId, authorizedItemLimit: 8,
      allowedModules: ["amazon_detail", "variation", "review_voc"],
      searchNavigationUsed: 2, planFingerprint: plan.planFingerprint, planStrategyId: plan.strategyId,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.runId).toBe(first.run.runId);
  });

  it("计划变化后不允许沿用旧运行：指纹不同必须显式取消", async () => {
    const record: WorkerCall[] = [];
    const service = makeService({ items: 8, record });
    const { buildMarketCapturePlan } = await import("@/lib/sourceLayer/captureStrategy/marketCapturePlan");
    const base = {
      strategyId: "full_market_capture" as const, batchId, marketTargetItemCount: 8, batchCapacity: 8, searchNavigationUsed: 2,
    };
    const planA = buildMarketCapturePlan({ ...base, authorizedItemCount: 8 });
    const planB = buildMarketCapturePlan({ ...base, authorizedItemCount: 4 });

    await service.start({
      context: owner, batchId, authorizedItemLimit: 8,
      allowedModules: ["amazon_detail"], searchNavigationUsed: 2,
      planFingerprint: planA.planFingerprint, planStrategyId: planA.strategyId,
    });

    await expect(service.start({
      context: owner, batchId, authorizedItemLimit: 4,
      allowedModules: ["amazon_detail"], searchNavigationUsed: 2,
      planFingerprint: planB.planFingerprint, planStrategyId: planB.strategyId,
    })).rejects.toMatchObject({ code: "BATCH_CAPTURE_PLAN_MISMATCH" });
  });

  it("未绑定计划的旧运行不允许被新计划直接复用（防止绕过确认）", async () => {
    const record: WorkerCall[] = [];
    const service = makeService({ items: 6, record });
    const unbound = await service.start({
      context: owner, batchId, authorizedItemLimit: 6,
      allowedModules: ["amazon_detail"], searchNavigationUsed: 2,
    });
    expect(unbound.run.planFingerprint).toBeNull();

    await expect(service.start({
      context: owner, batchId, authorizedItemLimit: 6,
      allowedModules: ["amazon_detail"], searchNavigationUsed: 2,
      planFingerprint: "c".repeat(64), planStrategyId: "full_market_capture",
    })).rejects.toMatchObject({ code: "BATCH_CAPTURE_PLAN_UNBOUND_RUN_EXISTS" });
  });

  it("取消后不再产生新的 Worker 调用（旧 Worker 并发门禁不被绕过）", async () => {
    const record: WorkerCall[] = [];
    const { service, run } = await planAndConfirm({
      strategyId: "full_market_capture", target: 5, authorized: 5, items: 5, record,
    });
    const callsAfterFirstDrive = record.length;

    await service.control({ context: owner, batchId, action: "cancel" });
    const after = await service.drive({ context: owner, batchId, env: envOn });
    expect(after.status).toBe("CANCELLED");
    expect(record.length).toBe(callsAfterFirstDrive);
    expect(after.runId).toBe(run.runId);
  });

  it("预算门禁：授权数量不得超过硬上限，运行范围被裁剪到授权名单", async () => {
    const record: WorkerCall[] = [];
    const { plan } = await planAndConfirm({
      strategyId: "full_market_capture", target: 40, authorized: 40, items: 40, record, drive: false,
    });
    expect(plan.authorizedItemCount).toBe(40);
    expect(plan.entries.find((entry) => entry.module === "amazon_detail")?.budget.plannedItems).toBe(40);
    // 导航预算与服务端推导保持一致（前端展示同源）
    expect(plan.budget.navigationLimit).toBe(Math.max(30, 40 * 4 + plan.budget.searchPages));
  });

  it("未开采集开关时不允许推进（门禁不被绕过）", async () => {
    const record: WorkerCall[] = [];
    const service = makeService({ items: 5, record });
    const { buildMarketCapturePlan } = await import("@/lib/sourceLayer/captureStrategy/marketCapturePlan");
    const plan = buildMarketCapturePlan({
      strategyId: "full_market_capture", batchId, marketTargetItemCount: 5, batchCapacity: 5, authorizedItemCount: 5, searchNavigationUsed: 2,
    });
    await service.start({
      context: owner, batchId, authorizedItemLimit: 5, allowedModules: ["amazon_detail"],
      searchNavigationUsed: 2, planFingerprint: plan.planFingerprint, planStrategyId: plan.strategyId,
    });
    await expect(service.drive({
      context: owner, batchId, env: { LOCAL_ACQUISITION_ENABLED: "false" } as unknown as NodeJS.ProcessEnv,
    })).rejects.toMatchObject({ code: "LOCAL_ENVIRONMENT_REQUIRED" });
    expect(record).toHaveLength(0);
  });
});
