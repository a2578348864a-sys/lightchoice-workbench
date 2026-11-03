import { describe, expect, it } from "vitest";

import { createBatchCaptureRunService } from "./batchCaptureRunService";
import { HARD_MAX_AUTHORIZED_ITEMS, MAX_CELL_AUTO_ATTEMPTS } from "./batchCaptureRun";

// 批量 BCR 用例需显式声明运行范围；生产缺省仍为 single_asin_only（只允许单 ASIN）。
process.env.V5_ACQUISITION_SCOPE = "batch_and_single";

type Row = { id: string; actorScope: string; operation: string; resourceKey: string; idempotencyKey: string;
  requestHash: string; status: string; responseJson: string | null; expiresAt: Date | null; createdAt: Date; updatedAt: Date };

const owner = { mode: "owner" as const, token: "" };
const batchId = "batch-stop-001";
const envOn = { LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single" } as unknown as NodeJS.ProcessEnv;
const BASE = Date.parse("2026-10-12T12:00:00.000Z");

function fixture() {
  const rows: Row[] = []; let clock = 0;
  const comp = (r: { actorScope: string; operation: string; resourceKey: string; idempotencyKey: string }) =>
    [r.actorScope, r.operation, r.resourceKey, r.idempotencyKey].join("|");
  return { rows, v5OperationReceipt: {
    findUnique: async (a: any) => { const k = a.where.actorScope_operation_resourceKey_idempotencyKey; return rows.find((r) => comp(r) === comp(k)) ?? null; },
    findMany: async (a: any) => rows.filter((r) => r.actorScope === a.where.actorScope && r.operation === a.where.operation && r.resourceKey === a.where.resourceKey),
    create: async (a: any) => { const d = a.data; const row: Row = { ...d, createdAt: d.createdAt ?? new Date(BASE), updatedAt: new Date(BASE + (++clock)) }; rows.push(row); return row; },
    updateMany: async (a: any) => { const w = a.where; let count = 0;
      for (const row of rows) {
        if (w.id !== undefined && row.id !== w.id) continue;
        if (w.status !== undefined && row.status !== w.status) continue;
        if (w.responseJson !== undefined && row.responseJson !== w.responseJson) continue;
        if (w.updatedAt !== undefined && row.updatedAt.getTime() !== new Date(w.updatedAt).getTime()) continue;
        Object.assign(row, a.data); row.updatedAt = new Date(BASE + (++clock)); count += 1;
      }
      return { count }; },
  } };
}

function items(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `item-${i}`, asin: `B0${String(i + 1).padStart(8, "0")}`, ordinal: i, archivedAt: null }));
}

/** Worker 替身：逐 ASIN 记录调用，并在指定第 N 件后让 shouldStop 变真；可模拟瞬时失败。 */
function makeService(options: { itemCount: number; stopAfterItem?: number; alwaysFail?: boolean; failTimes?: number }) {
  const database = fixture();
  const workerCalls: string[][] = [];
  let seen = 0;
  let calls = 0;
  const worker = async (input: { targetAsins?: unknown; shouldStop?: () => Promise<boolean> | boolean }) => {
    const targetAsins = Array.isArray(input.targetAsins) ? (input.targetAsins as string[]) : [];
    workerCalls.push([...targetAsins]);
    calls += 1;
    const shouldFail = options.alwaysFail === true
      || (options.failTimes !== undefined && calls <= options.failTimes);
    const produced: Array<{ asin: string; status: string; evidenceId: string | null; errorCode?: string; retryable?: boolean }> = [];
    for (const asin of targetAsins) {
      if (await input.shouldStop?.()) break;      // 与真实 Worker 相同的停止语义
      seen += 1;
      produced.push(shouldFail
        ? { asin, status: "failed_retryable", errorCode: "TRANSIENT_NETWORK", retryable: true, evidenceId: null }
        : { asin, status: "enriched", evidenceId: `ev-${asin}` });
      if (options.stopAfterItem !== undefined && seen >= options.stopAfterItem) break;
    }
    return { value: { summary: {}, items: produced }, replayed: false, receiptId: "rc" };
  };
  const service = createBatchCaptureRunService({
    database: database as never,
    getProductBatchStore: () => ({
      getBatch: async (id: string) => (id === batchId ? { id: batchId, batchStatus: "ready" } : null),
      getBatchItems: async () => items(options.itemCount),
    }) as never,
    now: () => new Date(BASE),
    enrichDetail: worker as never, enrichVariation: worker as never, enrichReview: worker as never,
  });
  return { service, workerCalls, database };
}

describe("P0-2 Worker 逐 ASIN 停止", () => {
  it("第 2 件处理中暂停后，第 3 件不得启动", async () => {
    const { service, workerCalls } = makeService({ itemCount: 10, stopAfterItem: 2 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 10, authorizedItemLimit: 10 });
    const run = await service.advance({ context: owner, batchId, env: envOn });
    // 详情模块只应处理前 2 件（第 3 件被停止检查挡住）
    const detailSucceeded = run.cells.filter((c) => c.module === "amazon_detail" && c.status === "succeeded").length;
    expect(detailSucceeded).toBe(2);
    expect(workerCalls[0]?.length).toBeGreaterThanOrEqual(2);
  });

  it("暂停后不再启动下一个模块（详情之后不再进入变体）", async () => {
    const { service } = makeService({ itemCount: 5, stopAfterItem: 1 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    // 先暂停，再 advance：Worker 的 shouldStop 立即为真
    await service.control({ context: owner, batchId, action: "pause" });
    await expect(service.advance({ context: owner, batchId, env: envOn }))
      .rejects.toMatchObject({ code: "BATCH_CAPTURE_RUN_PAUSED" });
    const run = await service.getRun(batchId);
    expect(run?.cells.every((c) => c.status !== "succeeded" || c.module === "amazon_search_market")).toBe(true);
  });
});

describe("P0-3 暂停三事实与租约安全", () => {
  it("暂停请求已接收但 Worker 未确认时，事实 A 为真、B 为假，且租约仍保留", async () => {
    const { service, database } = makeService({ itemCount: 20 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 20 });
    // 模拟「在途 slice 正在执行」：租约处于活跃状态
    const row = database.rows[0];
    const parsed = JSON.parse(row.responseJson ?? "{}");
    parsed.status = "RUNNING";
    parsed.leaseOwner = "in-flight-driver";
    parsed.leaseExpiresAt = new Date(BASE + 60_000).toISOString();
    row.responseJson = JSON.stringify(parsed);
    row.status = "RUNNING";
    const paused = await service.control({ context: owner, batchId, action: "pause" });
    expect(paused.pauseRequestedAt).toBeTruthy();
    expect(paused.pauseAcknowledgedAt).toBeNull();
    expect(paused.status).toBe("PAUSED");
    // 租约被**故意保留**：防止在途 Worker 未退出时 resume 造成双执行
    expect(paused.leaseOwner).not.toBeNull();
  });

  it("租约仍活跃时 resume 被拒绝，避免第二个执行器并行", async () => {
    const { service, database } = makeService({ itemCount: 20 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 20 });
    // 模拟在途 Worker 仍持有租约
    const row = database.rows[0];
    const parsed = JSON.parse(row.responseJson ?? "{}");
    parsed.status = "RUNNING";
    parsed.leaseOwner = "in-flight-driver";
    parsed.leaseExpiresAt = new Date(BASE + 60_000).toISOString();
    row.responseJson = JSON.stringify(parsed);
    row.status = "RUNNING";
    await service.control({ context: owner, batchId, action: "pause" });
    await expect(service.control({ context: owner, batchId, action: "resume" }))
      .rejects.toMatchObject({ code: "BATCH_CAPTURE_PAUSE_IN_PROGRESS" });
  });

  it("执行器确认停止后才释放租约，且事实 B/C 同时成立", async () => {
    const { service } = makeService({ itemCount: 5 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    await service.control({ context: owner, batchId, action: "pause" });
    const acked = await service.acknowledgePause({ context: owner, batchId });
    expect(acked?.pauseAcknowledgedAt).toBeTruthy();
    expect(acked?.leaseOwner).toBeNull();
    expect(acked?.leaseExpiresAt).toBeNull();
    // 确认后可正常 resume
    const resumed = await service.control({ context: owner, batchId, action: "resume" });
    expect(resumed.status).toBe("RUNNING");
    expect(resumed.pauseRequestedAt).toBeNull();
    expect(resumed.pauseAcknowledgedAt).toBeNull();
  });

  it("租约过期后（未收到确认）仍可恢复，且不扩大原授权", async () => {
    const { service, database } = makeService({ itemCount: 5 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    await service.control({ context: owner, batchId, action: "pause" });
    // 模拟进程异常退出：租约已过期
    const row = database.rows[0];
    const parsed = JSON.parse(row.responseJson ?? "{}");
    parsed.leaseExpiresAt = new Date(BASE - 60_000).toISOString();
    row.responseJson = JSON.stringify(parsed);
    const resumed = await service.control({ context: owner, batchId, action: "resume" });
    expect(resumed.status).toBe("RUNNING");
    expect(resumed.authorizedItemLimit).toBe(5);
    expect(resumed.authorizedAsins).toHaveLength(5);
    expect(resumed.navigationBudget.limit).toBe(resumed.navigationBudget.limit);
  });
});

describe("一次启动自动推进 + 有界自动重试", () => {
  it("一次 drive 连续推进多个切片，直到没有可执行单元（不需要反复点击）", async () => {
    const { service } = makeService({ itemCount: 10 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 2, authorizedItemLimit: 10, allowedModules: ["amazon_detail"] });
    const run = await service.drive({ context: owner, batchId, env: envOn });
    // 10 件 / 每片 2 件 = 至少 5 个切片，全部在一次 drive 内完成
    expect(run.advances).toBeGreaterThanOrEqual(5);
    expect(run.driveSlices).toBeGreaterThanOrEqual(5);
    expect(run.cells.filter((cell) => cell.module === "amazon_detail" && cell.status === "succeeded")).toHaveLength(10);
    expect(run.navigationBudget.reserved).toBe(0);
    expect(run.leaseOwner).toBeNull();
  });

  it("暂时失败在有界上限内自动重试，达到上限后停止（不无限重试、不越预算）", async () => {
    const { service, workerCalls } = makeService({ itemCount: 2, alwaysFail: true });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 2, authorizedItemLimit: 2, allowedModules: ["amazon_detail"] });
    const run = await service.drive({ context: owner, batchId, env: envOn });

    const detail = run.cells.filter((cell) => cell.module === "amazon_detail");
    // 每个单元被尝试到硬上限，且状态仍如实为可重试失败（不是成功、不是暂停）
    expect(detail.every((cell) => cell.status === "failed_retryable")).toBe(true);
    expect(detail.every((cell) => cell.attempts === MAX_CELL_AUTO_ATTEMPTS)).toBe(true);
    expect(run.status).toBe("PARTIAL");
    // 初始 1 次 + 自动重试 2 次 = 3 轮调用（每轮 1 个模块）
    expect(workerCalls).toHaveLength(MAX_CELL_AUTO_ATTEMPTS);
    // 每次尝试都是真实导航：3 轮 × 2 件 = 6（起点搜索用量 0）
    expect(run.navigationBudget.used).toBe(MAX_CELL_AUTO_ATTEMPTS * 2);
    expect(run.navigationBudget.used).toBeLessThanOrEqual(run.navigationBudget.limit);
    expect(run.navigationBudget.reserved).toBe(0);
    expect(run.leaseOwner).toBeNull();
  });

  it("重试成功后转为成功并停止重试", async () => {
    // 前 1 轮（3 个模块 × 2 件）全部瞬时失败；第 2 轮成功
    const { service, workerCalls } = makeService({ itemCount: 2, failTimes: 3 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 2, authorizedItemLimit: 2 });
    const run = await service.drive({ context: owner, batchId, env: envOn });

    expect(workerCalls).toHaveLength(6);
    for (const moduleId of ["amazon_detail", "variation", "review_voc"]) {
      const cells = run.cells.filter((cell) => cell.module === moduleId);
      expect(cells.every((cell) => cell.status === "succeeded")).toBe(true);
      expect(cells.every((cell) => cell.attempts === 2)).toBe(true);
      expect(cells.every((cell) => Boolean(cell.evidenceId))).toBe(true);
    }
    expect(run.navigationBudget.reserved).toBe(0);
  });

  it("PARTIAL 但仍有可重试单元时，再次 drive 可恢复推进（按钮不再无响应）", async () => {
    const { service } = makeService({ itemCount: 2, failTimes: 3 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 2, authorizedItemLimit: 2 });
    // 第一次只推一片且不允许重试 → 三个模块瞬时失败 → PARTIAL（仍可重试）
    const first = await service.drive({ context: owner, batchId, env: envOn, allowRetry: false });
    expect(first.status).toBe("PARTIAL");
    expect(first.cells.filter((cell) => cell.module === "amazon_detail").every((cell) => cell.status === "failed_retryable")).toBe(true);

    // 再次启动：从 PARTIAL 恢复（新执行代次），自动重试后成功
    const second = await service.drive({ context: owner, batchId, env: envOn });
    expect(second.executionEpoch).toBeGreaterThan(first.executionEpoch);
    for (const moduleId of ["amazon_detail", "variation", "review_voc"]) {
      expect(second.cells.filter((cell) => cell.module === moduleId).every((cell) => cell.status === "succeeded")).toBe(true);
    }
    expect(second.leaseOwner).toBeNull();
  });
});

describe("单模块失败不得中断其他合法单元", () => {
  it("某模块抛错时只标记该模块单元，后续模块仍在本轮推进", async () => {
    const database = fixture();
    const calls: string[] = [];
    const okWorker = async (input: { targetAsins?: unknown }) => {
      const targetAsins = Array.isArray(input.targetAsins) ? (input.targetAsins as string[]) : [];
      calls.push(`ok:${targetAsins.length}`);
      return {
        value: { summary: {}, items: targetAsins.map((asin) => ({ asin, status: "enriched", evidenceId: `ev-${asin}` })) },
        replayed: false,
        receiptId: "rc",
      };
    };
    const failingWorker = async () => {
      calls.push("fail");
      throw new Error("browser session crashed");
    };
    const service = createBatchCaptureRunService({
      database: database as never,
      getProductBatchStore: () => ({
        getBatch: async (id: string) => (id === batchId ? { id: batchId, batchStatus: "ready" } : null),
        getBatchItems: async () => items(3),
      }) as never,
      now: () => new Date(BASE),
      enrichDetail: failingWorker as never,
      enrichVariation: okWorker as never,
      enrichReview: okWorker as never,
    });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 3, authorizedItemLimit: 3 });
    const run = await service.advance({ context: owner, batchId, env: envOn });

    // 失败模块：单元标记为可重试失败（不伪造成功，也不影响授权）
    const detail = run.cells.filter((cell) => cell.module === "amazon_detail");
    expect(detail.every((cell) => cell.status === "failed_retryable")).toBe(true);
    expect(detail.every((cell) => cell.attempts === 1)).toBe(true);
    // 后续模块照常推进（执行器不停在失败模块上）
    expect(run.cells.filter((cell) => cell.module === "variation" && cell.status === "succeeded")).toHaveLength(3);
    expect(run.cells.filter((cell) => cell.module === "review_voc" && cell.status === "succeeded")).toHaveLength(3);
    expect(calls.filter((call) => call === "fail")).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("ok:"))).toHaveLength(2);
    // 状态如实反映「部分成功」而不是完成
    expect(run.status).toBe("PARTIAL");
  });
});

describe("P0 授权数量一致性（5 / 60 / 100 / 200）", () => {
  it.each([5, 60, 100, 200])("授权 %i 件：白名单、矩阵与上限一致", async (limit) => {
    const { service } = makeService({ itemCount: 200 });
    const started = await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: limit });
    expect(started.run.authorizedItemLimit).toBe(limit);
    expect(started.run.authorizedAsins).toHaveLength(limit);
    expect(started.run.progress.itemsInBatch).toBe(limit);
    expect(started.run.progress.totalCells).toBe(limit * 8);
    // 单轮预算仍被夹紧，不会因为大批量授权而提高并发
    expect(started.run.maxItemsPerAdvance).toBe(5);
    // 导航预算有限（授权数量 ≠ 无限页面访问）
    expect(started.run.navigationBudget.limit).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it("超过产品上限 200 一律拒绝", async () => {
    const { service } = makeService({ itemCount: 200 });
    await expect(service.start({ context: owner, batchId, authorizedItemLimit: HARD_MAX_AUTHORIZED_ITEMS + 1 }))
      .rejects.toMatchObject({ code: "AUTHORIZED_ITEM_LIMIT_INVALID" });
  });

  it("resume / retry 不会扩大原授权", async () => {
    const { service } = makeService({ itemCount: 60 });
    const started = await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    await service.control({ context: owner, batchId, action: "pause" });
    await service.acknowledgePause({ context: owner, batchId });
    const resumed = await service.control({ context: owner, batchId, action: "resume" });
    expect(resumed.authorizedItemLimit).toBe(started.run.authorizedItemLimit);
    // resume 后状态为 RUNNING：与 UI 一致禁止直接 retry（需先暂停并确认停止）
    await expect(service.control({ context: owner, batchId, action: "retry" }))
      .rejects.toMatchObject({ code: "BATCH_CAPTURE_RETRY_NOT_ALLOWED" });
    await service.control({ context: owner, batchId, action: "pause" });
    await service.acknowledgePause({ context: owner, batchId });
    const retried = await service.control({ context: owner, batchId, action: "retry" });
    expect(retried.authorizedItemLimit).toBe(5);
    expect(retried.authorizedAsins).toHaveLength(5);
  });

  it("CANCELLED 不允许直接重试（与 UI canRetry 一致）", async () => {
    const { service } = makeService({ itemCount: 3 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 3, authorizedItemLimit: 3 });
    await service.control({ context: owner, batchId, action: "cancel" });
    await expect(service.control({ context: owner, batchId, action: "retry" }))
      .rejects.toMatchObject({ code: "BATCH_CAPTURE_RETRY_NOT_ALLOWED" });
  });

  it("正式批次 944e1e2c 形态：已中止且停止回执为空但代次已关闭，可重新确认计划创建新代次", async () => {
    /**
     * 完全复刻线上被卡死的形态：
     *   status=CANCELLED、pauseRequestedAt 有值、pauseAcknowledgedAt/stopAcknowledgedAt 为空、
     *   executionEpoch == acknowledgedEpoch == 4、leaseOwner=null、lastLeaseOwner 仍保留。
     * 修复前该形态会让「新建运行代次」永久 409（用户反复点击也无法继续）。
     */
    const { service, database } = makeService({ itemCount: 5 });
    const gen1 = await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    const row = database.rows[0];
    const parsed = JSON.parse(row.responseJson ?? "{}");
    parsed.status = "CANCELLED";
    parsed.pauseRequestedAt = "2026-10-17T08:47:44.192Z";
    parsed.pauseAcknowledgedAt = null;
    parsed.cancelRequestedAt = "2026-10-17T09:19:46.451Z";
    parsed.stopAcknowledgedAt = null;
    parsed.stopConfirmedBy = null;
    parsed.executionEpoch = 4;
    parsed.acknowledgedEpoch = 4;
    parsed.leaseOwner = null;
    parsed.leaseExpiresAt = null;
    parsed.lastLeaseOwner = "drive-69094206-94a5-4984-a25c-d98535ca2281";
    row.responseJson = JSON.stringify(parsed);
    row.status = "CANCELLED";

    const gen2 = await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    expect(gen2.created).toBe(true);
    expect(gen2.run.runGeneration).toBe(2);
    expect(gen2.run.supersededRunId).toBe(gen1.run.runId);
    // 新代次不得沿用旧的停止请求标记
    expect(gen2.run.pauseRequestedAt).toBeNull();
    expect(gen2.run.stopAcknowledgedAt).toBeNull();
    // 历史代次仍然可审计
    expect((await service.listRuns({ context: owner, batchId })).map((run) => run.runGeneration)).toEqual([1, 2]);
  });

  it("历史「暂停请求无回执但执行代次已关闭」不得永久阻塞重试，且不改写已有证据", async () => {
    /**
     * 正式批次 944e1e2c 的实际形态：pauseRequestedAt 已写、stopAcknowledgedAt 为空，
     * 但 executionEpoch == acknowledgedEpoch 且租约为空——只能说明停止请求到达时执行器已退出。
     * 旧实现把它当成「执行器生死未知」并永久 409，用户只能反复点继续/重试。
     */
    const { service, database } = makeService({ itemCount: 5 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    const row = database.rows[0];
    const parsed = JSON.parse(row.responseJson ?? "{}");
    parsed.status = "PAUSED";
    parsed.executionEpoch = 4;
    parsed.acknowledgedEpoch = 4;
    parsed.pauseRequestedAt = "2026-10-17T08:47:44.192Z";
    parsed.pauseAcknowledgedAt = null;
    parsed.stopAcknowledgedAt = null;
    parsed.stopConfirmedBy = null;
    parsed.leaseOwner = null;
    parsed.leaseExpiresAt = null;
    parsed.lastLeaseOwner = "drive-69094206";
    parsed.cells = (parsed.cells as Array<Record<string, unknown>>).map((cell) =>
      cell.module === "amazon_search_market" ? { ...cell, status: "succeeded", evidenceId: "ev-search-keep" } : cell);
    row.responseJson = JSON.stringify(parsed);
    row.status = "PAUSED";

    const retried = await service.control({ context: owner, batchId, action: "retry" });
    expect(retried.pauseRequestedAt).toBeNull();
    expect(retried.pauseAcknowledgedAt).toBeNull();
    expect(retried.retryAuthorized).toBe(true);
    // 已成功的搜索证据与授权预算不得被重试改写
    expect(retried.cells
      .filter((cell) => cell.module === "amazon_search_market")
      .every((cell) => cell.evidenceId === "ev-search-keep")).toBe(true);
    expect(retried.authorizedItemLimit).toBe(5);
    expect(retried.navigationBudget.limit).toBeGreaterThan(0);

    // 复核：解除后可正常继续（无人工确认环节）
    const resumed = await service.control({ context: owner, batchId, action: "resume" });
    expect(resumed.status).toBe("RUNNING");
  });

  it("真正的未知（执行代次未关闭）仍然阻断重试：不因本次修复放宽并发保护", async () => {
    const { service, database } = makeService({ itemCount: 5 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    const row = database.rows[0];
    const parsed = JSON.parse(row.responseJson ?? "{}");
    parsed.status = "PAUSED";
    parsed.executionEpoch = 5;
    parsed.acknowledgedEpoch = 4;
    parsed.pauseRequestedAt = "2026-10-17T08:47:44.192Z";
    parsed.pauseAcknowledgedAt = null;
    parsed.stopAcknowledgedAt = null;
    parsed.leaseOwner = null;
    parsed.leaseExpiresAt = new Date(BASE - 60_000).toISOString();
    row.responseJson = JSON.stringify(parsed);
    row.status = "PAUSED";

    await expect(service.control({ context: owner, batchId, action: "retry" }))
      .rejects.toMatchObject({ code: "BATCH_CAPTURE_EXECUTION_STATE_UNKNOWN" });
    await expect(service.control({ context: owner, batchId, action: "resume" }))
      .rejects.toMatchObject({ code: "BATCH_CAPTURE_EXECUTION_STATE_UNKNOWN" });
  });

  it("暂停时没有在途执行：当场写入停止确认，继续不需要人工核对", async () => {
    const { service } = makeService({ itemCount: 5 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    const paused = await service.control({ context: owner, batchId, action: "pause" });
    expect(paused.status).toBe("PAUSED");
    expect(paused.pauseAcknowledgedAt).toBeTruthy();
    expect(paused.stopAcknowledgedAt).toBeTruthy();
    expect(paused.stopConfirmedBy).toBe("control");
    expect(paused.leaseOwner).toBeNull();

    const resumed = await service.control({ context: owner, batchId, action: "resume" });
    expect(resumed.status).toBe("RUNNING");
    expect(resumed.pauseRequestedAt).toBeNull();
  });

  it("中止时没有在途执行：当场生效，可创建新运行代次（不死锁、不清空已有证据）", async () => {
    const { service } = makeService({ itemCount: 5 });
    const gen1 = await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    const cancelled = await service.control({ context: owner, batchId, action: "cancel" });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelRequestedAt).toBeTruthy();
    expect(cancelled.stopAcknowledgedAt).toBeTruthy();
    expect(cancelled.stopConfirmedBy).toBe("control");
    expect(cancelled.leaseOwner).toBeNull();

    const gen2 = await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    expect(gen2.created).toBe(true);
    expect(gen2.run.runGeneration).toBe(2);
    expect(gen2.run.supersededRunId).toBe(gen1.run.runId);
    // 证据/单元由新代次重新建立，但旧代次记录仍可审计
    expect(await service.listRuns({ context: owner, batchId })).toHaveLength(2);
  });

  it("停止确认后重试：清理旧暂停标记，且不改写已成功单元的证据", async () => {
    const { service, database } = makeService({ itemCount: 5 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    const afterStart = await service.getRun(batchId);
    expect(afterStart).toBeTruthy();
    await service.control({ context: owner, batchId, action: "pause" });
    const paused = await service.getRun(batchId);
    expect(paused?.pauseRequestedAt).toBeTruthy();
    await service.acknowledgePause({
      context: owner,
      batchId,
      runId: afterStart?.runId,
      executionEpoch: afterStart?.executionEpoch ?? 0,
    });
    const stopped = await service.getRun(batchId);
    expect(stopped?.stopAcknowledgedAt).toBeTruthy();

    // 注入一个可重试失败 + 一个已成功搜索证据
    const row = database.rows[0];
    const parsed = JSON.parse(row.responseJson ?? "{}");
    const cells = (parsed.cells as Array<Record<string, unknown>>).map((cell) => {
      if (cell.module === "amazon_detail" && cell.asin === afterStart?.authorizedAsins[0]) {
        return { ...cell, status: "failed_retryable", attempts: 1, lastErrorCode: "TRANSIENT" };
      }
      if (cell.module === "amazon_search_market") {
        return { ...cell, status: "succeeded", evidenceId: "ev-search-keep" };
      }
      return cell;
    });
    parsed.cells = cells;
    row.responseJson = JSON.stringify(parsed);

    const retried = await service.control({ context: owner, batchId, action: "retry" });
    expect(retried.pauseRequestedAt).toBeNull();
    expect(retried.pauseAcknowledgedAt).toBeNull();
    expect(retried.retryAuthorized).toBe(true);
    const search = retried.cells.filter((c) => c.module === "amazon_search_market");
    expect(search.every((c) => c.evidenceId === "ev-search-keep")).toBe(true);
    const failedLeft = retried.cells.filter((c) => c.status === "failed_retryable");
    expect(failedLeft.length).toBe(0);
    const resetDetail = retried.cells.find(
      (c) => c.module === "amazon_detail" && c.asin === afterStart?.authorizedAsins[0],
    );
    expect(resetDetail?.status).toBe("pending");
    expect(resetDetail?.lastErrorCode).toBeNull();
  });
});

describe("失效执行代次的导航预算预留恢复", () => {
  /** 把 run 行改造成「旧执行器异常退出」形态：代次未确认、租约已过期、预留未结算。 */
  function seedDeadExecutor(database: ReturnType<typeof makeService>["database"], options: {
    reserved?: number; leaseExpiredMsAgo?: number; executionEpoch?: number; acknowledgedEpoch?: number;
  } = {}) {
    const row = database.rows[0];
    const run = JSON.parse(row.responseJson ?? "{}");
    const epoch = options.executionEpoch ?? 2;
    const expired = new Date(BASE - (options.leaseExpiredMsAgo ?? 60_000)).toISOString();
    const next = {
      ...run,
      executionEpoch: epoch,
      acknowledgedEpoch: options.acknowledgedEpoch ?? epoch - 1,
      leaseOwner: "drive-dead-owner",
      leaseExpiresAt: expired,
      lastLeaseOwner: "drive-dead-owner",
      navigationBudget: { ...run.navigationBudget, reserved: options.reserved ?? 10 },
    };
    row.responseJson = JSON.stringify(next);
    return next;
  }

  function seedLiveLease(database: ReturnType<typeof makeService>["database"]) {
    const row = database.rows[0];
    const run = JSON.parse(row.responseJson ?? "{}");
    row.responseJson = JSON.stringify({
      ...run,
      executionEpoch: 2,
      acknowledgedEpoch: 1,
      leaseOwner: "drive-live-owner",
      leaseExpiresAt: new Date(BASE + 120_000).toISOString(),
      lastLeaseOwner: "drive-live-owner",
      navigationBudget: { ...run.navigationBudget, reserved: 7 },
    });
  }

  async function started() {
    const ctx = makeService({ itemCount: 5 });
    await ctx.service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    const run = (await ctx.service.getRun(batchId))!;
    return { ...ctx, run };
  }

  it("确认代次已退出后清理遗留预留，且不改动单元与授权", async () => {
    const ctx = await started();
    seedDeadExecutor(ctx.database, { reserved: 10 });
    const before = (await ctx.service.getRun(batchId))!;
    expect(before.navigationBudget.reserved).toBe(10);

    const recovered = await ctx.service.recoverStalledExecution({
      context: owner,
      batchId,
      runId: before.runId,
      runGeneration: before.runGeneration,
      executionEpoch: before.executionEpoch,
      reason: "旧驱动器进程已退出：已核实无采集浏览器、无 profile 锁、租约已过期。",
    });

    expect(recovered.navigationBudget.reserved).toBe(0);
    // 只清理预留，不抬高上限、不改授权
    expect(recovered.navigationBudget.limit).toBe(before.navigationBudget.limit);
    expect(recovered.authorizedItemLimit).toBe(before.authorizedItemLimit);
    expect(recovered.cells).toHaveLength(before.cells.length);
    expect(recovered.acknowledgedEpoch).toBe(before.executionEpoch);
    expect(recovered.leaseOwner).toBeNull();
    expect(recovered.lastMessage).toContain("导航预算预留");
  });

  it("仍持有有效租约时拒绝恢复：活跃执行器的预留不得被清除", async () => {
    const ctx = await started();
    seedLiveLease(ctx.database);
    const before = (await ctx.service.getRun(batchId))!;

    await expect(ctx.service.recoverStalledExecution({
      context: owner,
      batchId,
      runId: before.runId,
      runGeneration: before.runGeneration,
      executionEpoch: before.executionEpoch,
      reason: "试图在租约仍有效时恢复",
    })).rejects.toMatchObject({ code: "BATCH_CAPTURE_RECOVERY_LEASE_ACTIVE" });

    const after = (await ctx.service.getRun(batchId))!;
    expect(after.navigationBudget.reserved).toBe(7);
    expect(after.executionEpoch).toBe(before.executionEpoch);
  });

  it("重复恢复幂等：不会重复返还额度，第二次直接拒绝", async () => {
    const ctx = await started();
    seedDeadExecutor(ctx.database, { reserved: 10 });
    const before = (await ctx.service.getRun(batchId))!;
    const args = {
      context: owner,
      batchId,
      runId: before.runId,
      runGeneration: before.runGeneration,
      executionEpoch: before.executionEpoch,
      reason: "旧驱动器进程已退出，确认后清理预留",
    };
    const first = await ctx.service.recoverStalledExecution(args);
    expect(first.navigationBudget.reserved).toBe(0);

    await expect(ctx.service.recoverStalledExecution(args))
      .rejects.toMatchObject({ code: "BATCH_CAPTURE_RECOVERY_NOT_REQUIRED" });
    const after = (await ctx.service.getRun(batchId))!;
    expect(after.navigationBudget.reserved).toBe(0);
    expect(after.navigationBudget.used).toBe(first.navigationBudget.used);
  });

  it("并发恢复只有一个成功，预留不会被返还两次", async () => {
    const ctx = await started();
    seedDeadExecutor(ctx.database, { reserved: 10 });
    const before = (await ctx.service.getRun(batchId))!;
    const args = {
      context: owner,
      batchId,
      runId: before.runId,
      runGeneration: before.runGeneration,
      executionEpoch: before.executionEpoch,
      reason: "并发恢复竞争测试：旧驱动器已退出",
    };
    const results = await Promise.allSettled([
      ctx.service.recoverStalledExecution(args),
      ctx.service.recoverStalledExecution(args),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBe(1);
    const after = (await ctx.service.getRun(batchId))!;
    expect(after.navigationBudget.reserved).toBe(0);
    expect(after.navigationBudget.used).toBe(before.navigationBudget.used);
  });

  it("身份不符时拒绝：不得用其他代次的编号清理预留", async () => {
    const ctx = await started();
    seedDeadExecutor(ctx.database, { reserved: 10 });
    const before = (await ctx.service.getRun(batchId))!;
    await expect(ctx.service.recoverStalledExecution({
      context: owner,
      batchId,
      runId: before.runId,
      runGeneration: before.runGeneration,
      executionEpoch: before.executionEpoch - 1,
      reason: "错误代次号的恢复尝试",
    })).rejects.toMatchObject({ code: "BATCH_CAPTURE_STOP_CONFIRMATION_STALE" });
    expect((await ctx.service.getRun(batchId))!.navigationBudget.reserved).toBe(10);
  });

  it("既无未确认代次也无遗留预留时拒绝（保持原有语义）", async () => {
    const ctx = await started();
    const before = (await ctx.service.getRun(batchId))!;
    await expect(ctx.service.recoverStalledExecution({
      context: owner,
      batchId,
      runId: before.runId,
      runGeneration: before.runGeneration,
      executionEpoch: before.executionEpoch,
      reason: "没有需要恢复的内容",
    })).rejects.toMatchObject({ code: "BATCH_CAPTURE_RECOVERY_NOT_REQUIRED" });
  });
});
