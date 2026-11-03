import { describe, expect, it } from "vitest";

import { createBatchCaptureRunService } from "./batchCaptureRunService";
import {
  HARD_MAX_AUTHORIZED_ITEMS,
  DEFAULT_AUTHORIZED_ITEMS,
  AUTO_CAPTURE_MODULE_COUNT,
  deriveSearchPages,
} from "./batchCaptureRun";

// 批量 BCR 用例需显式声明运行范围；生产缺省仍为 single_asin_only（只允许单 ASIN）。
process.env.V5_ACQUISITION_SCOPE = "batch_and_single";

type Row = {
  id: string; actorScope: string; operation: string; resourceKey: string; idempotencyKey: string;
  requestHash: string; status: string; responseJson: string | null; expiresAt: Date | null;
  createdAt: Date; updatedAt: Date;
};

const owner = { mode: "owner" as const, token: "" };
const batchId = "batch-budget-001";
const envOn = { LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single" } as unknown as NodeJS.ProcessEnv;
const BASE = Date.parse("2026-10-12T12:00:00.000Z");

function fixtureDatabase() {
  const rows: Row[] = [];
  let clock = 0;
  const composite = (r: { actorScope: string; operation: string; resourceKey: string; idempotencyKey: string }) =>
    [r.actorScope, r.operation, r.resourceKey, r.idempotencyKey].join("|");
  return {
    rows,
    v5OperationReceipt: {
      findUnique: async (args: { where: { actorScope_operation_resourceKey_idempotencyKey: { actorScope: string; operation: string; resourceKey: string; idempotencyKey: string } } }) => {
        const k = args.where.actorScope_operation_resourceKey_idempotencyKey;
        return rows.find((r) => composite(r) === composite(k)) ?? null;
      },
      findMany: async (args: { where: { actorScope: string; operation: string; resourceKey: string } }) =>
        rows.filter((r) => r.actorScope === args.where.actorScope && r.operation === args.where.operation && r.resourceKey === args.where.resourceKey),
      create: async (args: { data: Row }) => {
        const d = args.data;
        if (rows.some((r) => composite(r) === composite(d))) throw new Error("UNIQUE_COMPOSITE");
        if (rows.some((r) => r.id === d.id)) throw new Error("UNIQUE_ID");
        const row: Row = { ...d, createdAt: d.createdAt ?? new Date(BASE), updatedAt: new Date(BASE + (++clock)) };
        rows.push(row);
        return row;
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const w = args.where;
        let count = 0;
        for (const row of rows) {
          if (w.id !== undefined && row.id !== w.id) continue;
          if (w.status !== undefined && row.status !== w.status) continue;
          if (w.responseJson !== undefined && row.responseJson !== w.responseJson) continue;
          if (w.updatedAt !== undefined && row.updatedAt.getTime() !== new Date(w.updatedAt as string | Date).getTime()) continue;
          Object.assign(row, args.data);
          row.updatedAt = new Date(BASE + (++clock));
          count += 1;
        }
        return { count };
      },
    },
  };
}

function items(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`, asin: `B0${String(i + 1).padStart(8, "0")}`, ordinal: i, archivedAt: null,
  }));
}

function makeService(itemCount: number, options: { workerStatus?: string } = {}) {
  const database = fixtureDatabase();
  const calls: Array<{ module: string; targetAsins: string[] }> = [];
  // 允许测试模拟「扩充后批次商品数变化」与 worker 返回的单元状态（skipped_existing 等）。
  const itemCountRef = { value: itemCount };
  const worker = async (input: { targetAsins?: unknown }) => {
    const targetAsins = Array.isArray(input.targetAsins) ? (input.targetAsins as string[]) : [];
    return {
      value: {
        summary: {},
        items: targetAsins.map((asin) => ({
          asin,
          status: options.workerStatus ?? "enriched",
          evidenceId: `ev-${asin}`,
          errorCode: null,
        })),
      },
      replayed: false, receiptId: "rc",
    };
  };
  const service = createBatchCaptureRunService({
    database: database as never,
    getProductBatchStore: () => ({
      getBatch: async (id: string) => (id === batchId ? { id: batchId, batchStatus: "ready" } : null),
      getBatchItems: async () => items(itemCountRef.value),
    }) as never,
    now: () => new Date(BASE),
    onWorkerCall: (module, targetAsins) => calls.push({ module, targetAsins }),
    enrichDetail: worker as never, enrichVariation: worker as never, enrichReview: worker as never,
  });
  return { service, calls, database, itemCountRef };
}

describe("P0-1 采集预算硬门禁", () => {
  it("服务端拒绝未声明授权上限的启动请求（不默认 60 件）", async () => {
    const { service } = makeService(60);
    await expect(service.start({ context: owner, batchId, maxItemsPerAdvance: 5 }))
      .rejects.toMatchObject({ code: "AUTHORIZED_ITEM_LIMIT_REQUIRED" });
    expect(await service.getRun(batchId)).toBeNull();
  });

  it("非法授权上限（0 / 61 / 非整数）一律拒绝", async () => {
    const { service } = makeService(60);
    for (const bad of [0, HARD_MAX_AUTHORIZED_ITEMS + 1, 2.5, -1, 201]) {
      await expect(service.start({ context: owner, batchId, authorizedItemLimit: bad }))
        .rejects.toMatchObject({ code: "AUTHORIZED_ITEM_LIMIT_INVALID" });
    }
    expect(await service.getRun(batchId)).toBeNull();
  });

  it("60 件批次 + 授权 5 件：运行矩阵与白名单只覆盖 5 件", async () => {
    const { service } = makeService(60);
    const started = await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    expect(started.run.authorizedItemLimit).toBe(5);
    expect(started.run.authorizedAsins).toHaveLength(5);
    expect(started.run.progress.itemsInBatch).toBe(5);
    expect(started.run.progress.totalCells).toBe(5 * 8);
    // 未授权 ASIN 不得出现在矩阵中
    const matrixAsins = new Set(started.run.cells.map((c) => c.asin));
    for (const asin of started.run.authorizedAsins) expect(matrixAsins.has(asin)).toBe(true);
    expect(matrixAsins.size).toBe(5);
  });

  it("每轮预算被夹紧到授权上限，且不能被后续调用抬高", async () => {
    const { service } = makeService(60);
    const started = await service.start({ context: owner, batchId, maxItemsPerAdvance: 30, authorizedItemLimit: 5 });
    expect(started.run.maxItemsPerAdvance).toBe(5);
    const advanced = await service.advance({ context: owner, batchId, maxItemsPerAdvance: 30, env: envOn });
    expect(advanced.maxItemsPerAdvance).toBe(5);
    expect(advanced.authorizedItemLimit).toBe(5);
  });

  it("Worker 只会收到授权白名单内的 ASIN（60 候选 → 只处理 5 个）", async () => {
    const { service, calls } = makeService(60);
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    const run = await service.drive({ context: owner, batchId, env: envOn, maxSlices: 20 });
    const authorized = new Set(run.authorizedAsins);
    expect(authorized.size).toBe(5);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      for (const asin of call.targetAsins) expect(authorized.has(asin)).toBe(true);
      expect(call.targetAsins.length).toBeLessThanOrEqual(5);
    }
    const touched = new Set(run.cells.filter((c) => c.status === "succeeded").map((c) => c.asin));
    for (const asin of touched) expect(authorized.has(asin)).toBe(true);
  });

  it("安全默认值远小于上限", () => {
    expect(DEFAULT_AUTHORIZED_ITEMS).toBeLessThan(HARD_MAX_AUTHORIZED_ITEMS);
    expect(DEFAULT_AUTHORIZED_ITEMS).toBe(5);
    expect(HARD_MAX_AUTHORIZED_ITEMS).toBe(200);
  });
});

describe("P0-2 增量进度持久化", () => {
  it("后续模块抛错时，先前模块已完成的进度仍已持久化可见", async () => {
    const database = fixtureDatabase();
    const store = {
      getBatch: async (id: string) => (id === batchId ? { id: batchId, batchStatus: "ready" } : null),
      getBatchItems: async () => items(5),
    };
    const okWorker = async (input: { targetAsins?: unknown }) => {
      const targetAsins = Array.isArray(input.targetAsins) ? (input.targetAsins as string[]) : [];
      return { value: { summary: {}, items: targetAsins.map((a) => ({ asin: a, status: "enriched", evidenceId: `ev-${a}` })) }, replayed: false, receiptId: "rc" };
    };
    const service = createBatchCaptureRunService({
      database: database as never,
      getProductBatchStore: () => store as never,
      now: () => new Date(BASE),
      enrichDetail: okWorker as never,
      // 变体模块抛错：详情模块的结果必须已经落库
      enrichVariation: (async () => { throw Object.assign(new Error("boom"), { code: "MODULE_EXECUTION_FAILED" }); }) as never,
      enrichReview: okWorker as never,
    });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    await expect(service.advance({ context: owner, batchId, env: envOn })).resolves.toBeTruthy();
    const run = await service.getRun(batchId);
    const detailSucceeded = run?.cells.filter((c) => c.module === "amazon_detail" && c.status === "succeeded").length ?? 0;
    // 详情模块在变体抛错之前已完成 → 增量持久化使其可见
    expect(detailSucceeded).toBe(5);
    expect(run?.progress.validEvidenceCells).toBeGreaterThanOrEqual(5);
  });
});

describe("P0 导航预算硬门禁", () => {
  it("启动时按授权数量建立共享导航预算，并预扣搜索阶段已用额度", async () => {
    const { service } = makeService(60);
    const started = await service.start({
      context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5, searchNavigationUsed: 1,
    });
    // 5 件 × 3 自动模块 + 1 页搜索 = 16 → 低于安全下限 30，取下限
    expect(started.run.navigationBudget.limit).toBeGreaterThanOrEqual(30);
    expect(started.run.navigationBudget.used).toBe(1);
    expect(started.run.navigationBudget.reserved).toBe(0);
  });

  it("授权 200 件时导航预算仍然是有限上限（不等于无限页面访问）", async () => {
    const { service } = makeService(200);
    const started = await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 200 });
    // 200 件 × 4 个自动模块 + 7 页搜索（ceil(200/30)）= 807
    expect(started.run.navigationBudget.limit).toBe(200 * AUTO_CAPTURE_MODULE_COUNT + deriveSearchPages(200));
    expect(started.run.navigationBudget.limit).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it("额度耗尽时 fail-closed：不发起新导航、状态为 PARTIAL 并给出明确错误码", async () => {
    const { service, database, calls } = makeService(60);
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    // 人为把预算耗尽（模拟长期运行后的状态）
    const row = database.rows[0];
    const parsed = JSON.parse(row.responseJson ?? "{}");
    parsed.navigationBudget = { ...parsed.navigationBudget, used: parsed.navigationBudget.limit, reserved: 0 };
    row.responseJson = JSON.stringify(parsed);
    const before = calls.length;
    const run = await service.advance({ context: owner, batchId, env: envOn });
    expect(run.status).toBe("PARTIAL");
    expect(run.lastErrorCode).toBe("NAVIGATION_BUDGET_EXHAUSTED");
    // 未发起任何新的 Worker 调用
    expect(calls.length).toBe(before);
    expect(run.progress.pendingCells).toBeGreaterThan(0);
  });

  it("resume / retry 不会为已耗尽的运行增加新额度", async () => {
    const { service, database } = makeService(60);
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    const row = database.rows[0];
    const parsed = JSON.parse(row.responseJson ?? "{}");
    const limitBefore = parsed.navigationBudget.limit;
    parsed.navigationBudget = { ...parsed.navigationBudget, used: limitBefore, reserved: 0 };
    row.responseJson = JSON.stringify(parsed);
    await service.control({ context: owner, batchId, action: "resume" });
    const afterResume = await service.getRun(batchId);
    expect(afterResume?.navigationBudget.limit).toBe(limitBefore);
    // RUNNING 期间禁止 retry；暂停并确认停止后再重试，额度仍不得增加
    await service.control({ context: owner, batchId, action: "pause" });
    await service.acknowledgePause({ context: owner, batchId });
    await service.control({ context: owner, batchId, action: "retry" });
    const afterRetry = await service.getRun(batchId);
    expect(afterRetry?.navigationBudget.limit).toBe(limitBefore);
    expect(afterRetry?.navigationBudget.used).toBe(limitBefore);
  });

  it("正常执行后已用额度递增、预留归零，且不超过上限", async () => {
    const { service } = makeService(6);
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 6, searchNavigationUsed: 1 });
    const run = await service.drive({ context: owner, batchId, env: envOn, maxSlices: 5 });
    expect(run.navigationBudget.used).toBeGreaterThanOrEqual(1);
    expect(run.navigationBudget.reserved).toBe(0);
    expect(run.navigationBudget.used).toBeLessThanOrEqual(run.navigationBudget.limit);
    /**
     * 结算不虚增：实际消耗 = 搜索预扣 1 + 第一轮 3 个已启用自动模块 × 5 件 + 第二轮 3 × 1 件 = 19。
     * reverse_asin 在 envOn 下未启用（其单元为 source_input_required），不消耗导航额度；
     * 因此这里不能再用「恰好等于上限」作为不变量。
     */
    expect(run.navigationBudget.used).toBe(1 + 3 * 5 + 3 * 1);
    // 版本必须随每次 CAS 写入单调前进（预留/增量/结算/最终写回）
    expect(run.version).toBeGreaterThanOrEqual(4);
  });

  it("prepare*Query 不得抬高共享导航预算上限（无授权扩容）", async () => {
    const { service } = makeService(6);
    const started = await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 6 });
    const limitBefore = started.run.navigationBudget.limit;

    const afterProductMarket = await service.prepareProductMarketQuery({
      context: owner, batchId, query: { category: "Kitchen & Dining" },
    });
    expect(afterProductMarket.navigationBudget.limit).toBe(limitBefore);
    expect(afterProductMarket.productMarketQueries).toHaveLength(1);

    const afterKeyword = await service.prepareKeywordMiningQuery({
      context: owner, batchId, query: { seedKeyword: "silicone baking mat" },
    });
    expect(afterKeyword.navigationBudget.limit).toBe(limitBefore);
    expect(afterKeyword.keywordMiningQueries).toHaveLength(1);

    // 重复 prepare 幂等：不得通过反复调用累计扩容。
    const repeated = await service.prepareKeywordMiningQuery({
      context: owner, batchId, query: { seedKeyword: "silicone baking mat" },
    });
    expect(repeated.navigationBudget.limit).toBe(limitBefore);
  });

  it("查询级导航额度不足时在导航前阻断查询，且不消耗额外额度", async () => {
    const keywordEnvOn = {
      LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single",
      SELLERSPRITE_KEYWORD_MINING_BCR_ENABLED: "true",
    } as unknown as NodeJS.ProcessEnv;
    const { service, database, calls } = makeService(6);
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 6 });
    await service.prepareKeywordMiningQuery({
      context: owner, batchId, query: { seedKeyword: "silicone baking mat" },
    });
    // 人为把剩余额度压到 1：不足以覆盖 3 个自动模块 × 5 件 + 1 次查询导航。
    const row = database.rows[0];
    const parsed = JSON.parse(row.responseJson ?? "{}");
    parsed.navigationBudget = { ...parsed.navigationBudget, used: parsed.navigationBudget.limit - 1, reserved: 0 };
    row.responseJson = JSON.stringify(parsed);

    const run = await service.advance({ context: owner, batchId, env: keywordEnvOn });
    const query = run.keywordMiningQueries[0];
    expect(query.status).toBe("blocked");
    expect(query.errorCode).toBe("SELLERSPRITE_QUERY_NAVIGATION_BUDGET_INSUFFICIENT");
    // 查询导航没有被发起，也没有调用关键词 Worker。
    expect(calls.some((call) => call.module === "keyword_mining_trend")).toBe(false);
    expect(run.navigationBudget.reserved).toBe(0);
    expect(run.navigationBudget.used).toBeLessThanOrEqual(run.navigationBudget.limit);
    expect(run.navigationBudget.used).toBe(parsed.navigationBudget.limit);
  });
});

describe("P0 导航预算作用域：每代次一份、跳过不扣、超用不抬高上限", () => {
  it("跳过已有证据的单元（skipped_existing）不消耗导航预算", async () => {
    // 同一批「已完成模块」再被规划时，worker 只复用既有证据、不打开页面 → 不得计费。
    const { service } = makeService(5, { workerStatus: "skipped_existing" });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5, searchNavigationUsed: 1 });
    const run = await service.advance({ context: owner, batchId, env: envOn });
    // 3 个可用自动模块 × 5 件全部跳过：已用只保留搜索阶段的 1 次。
    expect(run.navigationBudget.used).toBe(1);
    expect(run.navigationBudget.reserved).toBe(0);
    const auto = run.cells.filter((cell) => cell.module !== "amazon_search_market" && cell.module !== "reverse_asin"
      && cell.module !== "keyword_mining_trend" && cell.module !== "sellersprite_product_market" && cell.module !== "historical_trend");
    expect(auto.every((cell) => cell.status === "skipped_existing")).toBe(true);
    expect(auto.every((cell) => Boolean(cell.evidenceId))).toBe(true);
  });

  it("同代次重复推进已终态单元：不再预留也不再消耗额度（重复执行幂等）", async () => {
    const { service } = makeService(5, { workerStatus: "skipped_existing" });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5, searchNavigationUsed: 1 });
    const first = await service.advance({ context: owner, batchId, env: envOn });
    const usedAfterFirst = first.navigationBudget.used;
    const second = await service.advance({ context: owner, batchId, env: envOn });
    expect(second.navigationBudget.used).toBe(usedAfterFirst);
    expect(second.navigationBudget.reserved).toBe(0);
    expect(second.advances).toBe(first.advances);
  });

  it("失败单元被重试时真实导航照常计费（回退额度不能用于掩盖真失败）", async () => {
    const { service } = makeService(5, { workerStatus: "failed_retryable" });
    await service.start({
      context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5,
      allowedModules: ["amazon_detail"], searchNavigationUsed: 1,
    });
    const first = await service.advance({ context: owner, batchId, env: envOn });
    expect(first.navigationBudget.used).toBe(1 + 5);
    expect(first.cells.filter((cell) => cell.module === "amazon_detail").every((cell) => cell.status === "failed_retryable")).toBe(true);

    await service.control({ context: owner, batchId, action: "retry" });
    const retried = await service.advance({ context: owner, batchId, env: envOn, allowRetry: true });
    expect(retried.navigationBudget.used).toBe(1 + 5 + 5);
    expect(retried.navigationBudget.reserved).toBe(0);
  });

  it("扩充代次的预算重新计算：used 只等于累计搜索用量，不继承上一代次的模块消耗", async () => {
    const { service, itemCountRef } = makeService(5);
    const initial = await service.start({
      context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5, searchNavigationUsed: 1,
    });
    const advanced = await service.advance({ context: owner, batchId, env: envOn });
    const previousUsed = advanced.navigationBudget.used;
    // 线上形态：上一代次已消耗大量模块导航；扩充代次不得把这些消耗再计一次。
    expect(previousUsed).toBe(1 + 3 * 5);

    itemCountRef.value = 10;
    await service.reserveExpansion({ context: owner, batchId, authorizationId: "auth-budget-expand-01" });
    const newAsins = items(10).slice(5).map((item) => item.asin);
    const expansion = await service.startExpansion({
      context: owner,
      batchId,
      authorizationId: "auth-budget-expand-01",
      targetTotal: 10,
      authorizedSearchItemLimit: 1,
      previousSearchNavigationUsed: 1,
      expansionSearchNavigationUsed: 1,
      newlyCapturedAsins: newAsins,
      searchEvidence: newAsins.map((asin) => ({ asin, evidenceRef: `search-ev-${asin}` })),
    });

    expect(expansion.created).toBe(true);
    // limit 按扩充后的授权数量重算（10 × 4 + 1 页 = 41），不是 max(旧 limit, 旧 used + 搜索)。
    expect(expansion.run.navigationBudget.limit).toBe(41);
    // used 起点 = 累计搜索阶段 1 + 1 = 2；旧代次的 16 次模块导航不累加。
    expect(expansion.run.navigationBudget.used).toBe(2);
    expect(expansion.run.navigationBudget.reserved).toBe(0);
    expect(expansion.run.navigationBudget.used).toBeLessThan(previousUsed);
    // 旧代次仍可审计，且其自身额度未被改写。
    const runs = await service.listRuns({ context: owner, batchId });
    expect(runs.map((run) => run.runGeneration)).toEqual([1, 2]);
    expect(runs[0]?.navigationBudget.used).toBe(previousUsed);
    expect(runs[0]?.navigationBudget.limit).toBe(initial.run.navigationBudget.limit);
  });

  it("used 已超出计划上限时不得抬高 limit，只能 fail-closed 阻断", async () => {
    const { service, database } = makeService(6);
    await service.start({
      context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 6,
      allowedModules: ["amazon_detail"], searchNavigationUsed: 1,
    });
    const row = database.rows[0];
    const parsed = JSON.parse(row.responseJson ?? "{}");
    const plannedLimit = parsed.navigationBudget.limit;
    // 模拟历史数据：已用量越过计划上限（旧实现会把 limit 悄悄抬到 used 以掩盖超用）。
    parsed.navigationBudget = { ...parsed.navigationBudget, used: plannedLimit + 5, reserved: 0 };
    row.responseJson = JSON.stringify(parsed);

    const readBack = await service.getRun(batchId);
    expect(readBack?.navigationBudget.limit).toBe(plannedLimit);

    const blocked = await service.advance({ context: owner, batchId, env: envOn });
    expect(blocked.status).toBe("PARTIAL");
    expect(blocked.lastErrorCode).toBe("NAVIGATION_BUDGET_EXHAUSTED");
    expect(blocked.navigationBudget.limit).toBe(plannedLimit);
    expect(blocked.navigationBudget.used).toBe(plannedLimit + 5);
    expect(blocked.navigationBudget.reserved).toBe(0);
  });
});

describe("导航预算追加授权（显式 / 有界 / 可审计）", () => {
  const authId = "topup-e2e-20261022-01";

  async function pausedService(itemCount = 30) {
    const ctx = makeService(itemCount);
    await ctx.service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 30 });
    // 无在途执行时 pause 当场生效 → 满足「非 RUNNING/WAITING 且无租约」的追加前置条件。
    await ctx.service.control({ context: owner, batchId, action: "pause" });
    return ctx;
  }

  it("执行中（WAITING / RUNNING）一律拒绝追加", async () => {
    const { service } = makeService(30);
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 30 });
    await expect(service.authorizeNavigationTopUp({
      context: owner, batchId, authorizationId: authId, amount: 21, purpose: "重试余量",
    })).rejects.toMatchObject({ code: "BATCH_CAPTURE_RUN_STILL_ACTIVE" });
  });

  it("追加成功后上限 = 推导上限 + 追加额度，并写入可审计台账", async () => {
    const { service } = await pausedService(30);
    const before = await service.getRun(batchId);
    const baseLimit = before!.navigationBudget.limit;

    const after = await service.authorizeNavigationTopUp({
      context: owner, batchId, authorizationId: authId, amount: 21, purpose: "补齐 21 个 pending 单元（重试无余量）",
    });
    expect(after.navigationBudget.grantedExtra).toBe(21);
    expect(after.navigationBudget.limit).toBe(baseLimit + 21);
    expect(after.navigationBudget.used).toBe(before!.navigationBudget.used);
    expect(after.navigationTopUps).toHaveLength(1);
    expect(after.navigationTopUps?.[0]).toMatchObject({
      authorizationId: authId, amount: 21, grantedLimitAfter: baseLimit + 21,
    });
    expect(after.navigationTopUps?.[0].purpose).toContain("pending");
    expect(after.lastMessage).toContain("+21");
  });

  it("同一授权编号幂等：重复提交不重复加额", async () => {
    const { service } = await pausedService(30);
    const first = await service.authorizeNavigationTopUp({
      context: owner, batchId, authorizationId: authId, amount: 21, purpose: "补齐 pending 单元",
    });
    const second = await service.authorizeNavigationTopUp({
      context: owner, batchId, authorizationId: authId, amount: 21, purpose: "补齐 pending 单元",
    });
    expect(second.navigationBudget.limit).toBe(first.navigationBudget.limit);
    expect(second.navigationTopUps).toHaveLength(1);
  });

  it("非法入参拒绝：编号格式 / 用途缺失 / 额度越界", async () => {
    const { service } = await pausedService(30);
    await expect(service.authorizeNavigationTopUp({
      context: owner, batchId, authorizationId: "short", amount: 10, purpose: "补齐 pending",
    })).rejects.toMatchObject({ code: "CAPTURE_BUDGET_TOPUP_AUTHORIZATION_ID_INVALID" });
    await expect(service.authorizeNavigationTopUp({
      context: owner, batchId, authorizationId: authId, amount: 10, purpose: "  ",
    })).rejects.toMatchObject({ code: "CAPTURE_BUDGET_TOPUP_PURPOSE_REQUIRED" });
    for (const bad of [0, -3, 2.5, 121]) {
      await expect(service.authorizeNavigationTopUp({
        context: owner, batchId, authorizationId: authId, amount: bad, purpose: "补齐 pending",
      })).rejects.toMatchObject({ code: "CAPTURE_BUDGET_TOPUP_AMOUNT_INVALID" });
    }
    expect((await service.getRun(batchId))!.navigationBudget.grantedExtra ?? 0).toBe(0);
  });

  it("追加不能突破双封顶：总额最多为推导上限的两倍", async () => {
    const { service } = await pausedService(30);
    const planned = (await service.getRun(batchId))!.navigationBudget.limit;
    let last = await service.authorizeNavigationTopUp({
      context: owner, batchId, authorizationId: "topup-cap-0001", amount: 120, purpose: "逼近上限",
    });
    expect(last.navigationBudget.limit).toBe(planned + 120);
    // 再追加 120：planned + 240 超过 planned × 2，被夹到两倍
    last = await service.authorizeNavigationTopUp({
      context: owner, batchId, authorizationId: "topup-cap-0002", amount: 120, purpose: "触达两倍上限",
    });
    expect(last.navigationBudget.limit).toBe(planned * 2);
    await expect(service.authorizeNavigationTopUp({
      context: owner, batchId, authorizationId: "topup-cap-0003", amount: 5, purpose: "越界尝试",
    })).rejects.toMatchObject({ code: "CAPTURE_BUDGET_TOPUP_AT_HARD_CAP" });
  });
});
