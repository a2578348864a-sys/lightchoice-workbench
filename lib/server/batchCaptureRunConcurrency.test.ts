import { describe, expect, it } from "vitest";

import { createBatchCaptureRunService } from "./batchCaptureRunService";

// 批量 BCR 用例需显式声明运行范围；生产缺省仍为 single_asin_only（只允许单 ASIN）。
process.env.V5_ACQUISITION_SCOPE = "batch_and_single";

type Row = {
  id: string; actorScope: string; operation: string; resourceKey: string; idempotencyKey: string;
  requestHash: string; status: string; responseJson: string | null; expiresAt: Date | null;
  createdAt: Date; updatedAt: Date;
};

const owner = { mode: "owner" as const, token: "" };
const batchId = "batch-concurrency-001";
const envOn = { LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single" } as unknown as NodeJS.ProcessEnv;
const queryEnvOn = {
  LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single",
  SELLERSPRITE_KEYWORD_MINING_BCR_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;
const BASE = Date.parse("2026-10-12T12:00:00.000Z");

function fixture() {
  const rows: Row[] = [];
  let clock = 0;
  const comp = (r: { actorScope: string; operation: string; resourceKey: string; idempotencyKey: string }) =>
    [r.actorScope, r.operation, r.resourceKey, r.idempotencyKey].join("|");
  return {
    rows,
    v5OperationReceipt: {
      // 读取返回**副本**：避免测试内存夹具的对象别名掩盖真实的 CAS 丢失更新
      // （真实 Prisma 每次查询都会反序列化成新对象）。
      findUnique: async (a: any) => {
        const k = a.where.actorScope_operation_resourceKey_idempotencyKey;
        const found = rows.find((r) => comp(r) === comp(k));
        return found ? { ...found } : null;
      },
      findMany: async (a: any) => rows
        .filter((r) => r.actorScope === a.where.actorScope
          && r.operation === a.where.operation && r.resourceKey === a.where.resourceKey)
        .map((r) => ({ ...r })),
      create: async (a: any) => {
        const d = a.data;
        const row: Row = { ...d, createdAt: d.createdAt ?? new Date(BASE), updatedAt: new Date(BASE + (++clock)) };
        rows.push(row);
        return row;
      },
      updateMany: async (a: any) => {
        const w = a.where;
        let count = 0;
        for (const row of rows) {
          if (w.id !== undefined && row.id !== w.id) continue;
          if (w.status !== undefined && row.status !== w.status) continue;
          if (w.responseJson !== undefined && row.responseJson !== w.responseJson) continue;
          if (w.updatedAt !== undefined && row.updatedAt.getTime() !== new Date(w.updatedAt).getTime()) continue;
          Object.assign(row, a.data);
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

function workerCallsOf() {
  const calls: string[] = [];
  const worker = async (input: { targetAsins?: unknown; shouldStop?: () => Promise<boolean> | boolean }) => {
    const targetAsins = Array.isArray(input.targetAsins) ? (input.targetAsins as string[]) : [];
    const produced: Array<{ asin: string; status: string; evidenceId: string }> = [];
    for (const asin of targetAsins) {
      if (await input.shouldStop?.()) break;
      produced.push({ asin, status: "enriched", evidenceId: `ev-${asin}` });
    }
    return { value: { summary: {}, items: produced }, replayed: false, receiptId: "rc" };
  };
  return { calls, worker };
}

function makeService(options: {
  itemCount: number;
  detailWorker?: (input: any) => Promise<unknown>;
  variationWorker?: (input: any) => Promise<unknown>;
  reviewWorker?: (input: any) => Promise<unknown>;
  runKeywordMiningQuery?: (input: any) => Promise<unknown>;
  onWorkerCall?: (moduleId: string) => void;
  onService?: (service: ReturnType<typeof createBatchCaptureRunService>) => void;
}) {
  const database = fixture();
  const { worker } = workerCallsOf();
  const service = createBatchCaptureRunService({
    database: database as never,
    getProductBatchStore: () => ({
      getBatch: async (id: string) => (id === batchId ? { id: batchId, batchStatus: "ready" } : null),
      getBatchItems: async () => items(options.itemCount),
    }) as never,
    now: () => new Date(BASE),
    enrichDetail: (options.detailWorker ?? worker) as never,
    enrichVariation: (options.variationWorker ?? worker) as never,
    enrichReview: (options.reviewWorker ?? worker) as never,
    ...(options.onWorkerCall ? { onWorkerCall: (moduleId: string) => options.onWorkerCall?.(moduleId) } : {}),
    ...(options.runKeywordMiningQuery ? { runKeywordMiningQuery: options.runKeywordMiningQuery as never } : {}),
  });
  options.onService?.(service);
  return { service, database };
}

/** 模拟「在途 Worker 仍持有运行租约」：同时开启一个未确认退出的执行代次。 */
function simulateInFlightWorker(database: ReturnType<typeof fixture>, ownerName = "in-flight-driver") {
  const row = database.rows[0];
  const parsed = JSON.parse(row.responseJson ?? "{}");
  parsed.status = "RUNNING";
  parsed.leaseOwner = ownerName;
  parsed.lastLeaseOwner = ownerName;
  parsed.leaseExpiresAt = new Date(BASE + 60_000).toISOString();
  // 授予租约即开启新执行代次；未确认退出前不得启动冲突执行。
  parsed.executionEpoch = (Number(parsed.acknowledgedEpoch) || 0) + 1;
  row.responseJson = JSON.stringify(parsed);
  row.status = "RUNNING";
  return { executionEpoch: parsed.executionEpoch as number, leaseOwner: ownerName };
}

function expireLease(database: ReturnType<typeof fixture>) {
  const row = database.rows[0];
  const parsed = JSON.parse(row.responseJson ?? "{}");
  parsed.leaseExpiresAt = new Date(BASE - 60_000).toISOString();
  row.responseJson = JSON.stringify(parsed);
}

describe("中止与旧 Worker 并发保护", () => {
  it("中止请求与 Worker 实际退出分开记录，且不清空运行租约", async () => {
    const { service, database } = makeService({ itemCount: 10 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 10 });
    simulateInFlightWorker(database);

    const cancelled = await service.control({ context: owner, batchId, action: "cancel" });
    expect(cancelled.status).toBe("CANCELLED");
    // 事实 A'：请求已接收
    expect(cancelled.cancelRequestedAt).toBeTruthy();
    // 事实 B'：尚未确认退出
    expect(cancelled.stopAcknowledgedAt).toBeNull();
    // 关键：不依靠清空 leaseOwner 宣称安全
    expect(cancelled.leaseOwner).toBe("in-flight-driver");
    expect(cancelled.leaseExpiresAt).not.toBeNull();
  });

  it("中止后立即新建 Run 被阻断（旧 Worker 尚未退出）", async () => {
    const { service, database } = makeService({ itemCount: 10 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 10 });
    simulateInFlightWorker(database);
    await service.control({ context: owner, batchId, action: "cancel" });

    await expect(service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 10 }))
      .rejects.toMatchObject({ code: "BATCH_CAPTURE_EXECUTION_STATE_UNKNOWN" });
    // 没有产生第二个代次
    expect(await service.listRuns({ context: owner, batchId })).toHaveLength(1);
  });

  it("旧 Worker 以完整身份确认退出后才允许新建 Run", async () => {
    const { service, database } = makeService({ itemCount: 10 });
    const gen1 = await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 10 });
    const inFlight = simulateInFlightWorker(database);
    await service.control({ context: owner, batchId, action: "cancel" });

    const acked = await service.acknowledgeStop({
      context: owner,
      batchId,
      runId: gen1.run.runId,
      executionEpoch: inFlight.executionEpoch,
      leaseOwner: inFlight.leaseOwner,
    });
    expect(acked?.stopAcknowledgedAt).toBeTruthy();
    expect(acked?.stopConfirmedBy).toBe("executor");
    expect(acked?.acknowledgedEpoch).toBe(inFlight.executionEpoch);
    expect(acked?.leaseOwner).toBeNull();
    expect(acked?.leaseExpiresAt).toBeNull();

    const gen2 = await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 10 });
    expect(gen2.created).toBe(true);
    expect(gen2.run.runGeneration).toBe(2);
    expect(gen2.run.supersededRunId).toBe(gen1.run.runId);
  });

  it("普通 API 调用不能伪造 Worker 退出证明（绑定不成立则不关闭执行代次）", async () => {
    const { service, database } = makeService({ itemCount: 10 });
    const gen1 = await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 10 });
    const inFlight = simulateInFlightWorker(database);
    await service.control({ context: owner, batchId, action: "cancel" });

    // 无绑定
    const unbound = await service.acknowledgeStop({ context: owner, batchId });
    expect(unbound?.acknowledgedEpoch).toBe(inFlight.executionEpoch - 1);
    // 错误租约令牌
    const wrongOwner = await service.acknowledgeStop({
      context: owner, batchId, runId: gen1.run.runId,
      executionEpoch: inFlight.executionEpoch, leaseOwner: "forged-owner",
    });
    expect(wrongOwner?.acknowledgedEpoch).toBe(inFlight.executionEpoch - 1);
    // 错误执行代次
    const wrongEpoch = await service.acknowledgeStop({
      context: owner, batchId, runId: gen1.run.runId,
      executionEpoch: inFlight.executionEpoch + 5, leaseOwner: inFlight.leaseOwner,
    });
    expect(wrongEpoch?.acknowledgedEpoch).toBe(inFlight.executionEpoch - 1);
    // 错误运行代次
    const wrongRunId = await service.acknowledgeStop({
      context: owner, batchId, runId: "11111111-2222-3333-4444-555555555555",
      executionEpoch: inFlight.executionEpoch, leaseOwner: inFlight.leaseOwner,
    });
    expect(wrongRunId?.acknowledgedEpoch).toBe(inFlight.executionEpoch - 1);

    // 阻塞仍然存在：伪造确认没有解除冲突保护
    await expect(service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 10 }))
      .rejects.toMatchObject({ code: "BATCH_CAPTURE_EXECUTION_STATE_UNKNOWN" });
  });

  it("租约超时但执行器生死未知：不得自动放行，必须人工确认恢复", async () => {
    const { service, database } = makeService({ itemCount: 10 });
    const gen1 = await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 10 });
    const inFlight = simulateInFlightWorker(database);
    const cancelled = await service.control({ context: owner, batchId, action: "cancel" });
    expireLease(database);

    // 关键修复：租约到期**不是**停止证明 → 仍然阻断新代次
    await expect(service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 10 }))
      .rejects.toMatchObject({ code: "BATCH_CAPTURE_EXECUTION_STATE_UNKNOWN" });
    // 未确认退出的状态可观察
    const stalled = await service.getRun(batchId);
    expect(stalled?.executionEpoch).toBe(inFlight.executionEpoch);
    expect(stalled?.acknowledgedEpoch).toBe(inFlight.executionEpoch - 1);

    // 身份不匹配的人工确认必须被拒绝（不能用于其他代次）
    await expect(service.recoverStalledExecution({
      context: owner, batchId, runId: cancelled.runId, runGeneration: 99,
      executionEpoch: inFlight.executionEpoch, reason: "核对旧采集进程已退出",
    })).rejects.toMatchObject({ code: "BATCH_CAPTURE_STOP_CONFIRMATION_STALE" });
    // 缺少核对原因必须被拒绝
    await expect(service.recoverStalledExecution({
      context: owner, batchId, runId: cancelled.runId, runGeneration: cancelled.runGeneration,
      executionEpoch: inFlight.executionEpoch, reason: "短",
    })).rejects.toMatchObject({ code: "BATCH_CAPTURE_RECOVERY_REASON_REQUIRED" });

    // 精确身份 + 明确原因的人工确认恢复
    const recovered = await service.recoverStalledExecution({
      context: owner, batchId, runId: cancelled.runId, runGeneration: cancelled.runGeneration,
      executionEpoch: inFlight.executionEpoch,
      reason: "已核对旧采集进程不再存活，浏览器会话已释放",
    });
    expect(recovered.acknowledgedEpoch).toBe(inFlight.executionEpoch);
    expect(recovered.stopConfirmedBy).toBe("operator");
    expect(recovered.stopRecoveryReason).toContain("旧采集进程");
    expect(recovered.leaseOwner).toBeNull();
    // 人工确认只关闭执行代次，不改动矩阵与预算
    expect(recovered.cells).toEqual(cancelled.cells);
    expect(recovered.navigationBudget).toEqual(cancelled.navigationBudget);

    const gen2 = await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 10 });
    expect(gen2.created).toBe(true);
    expect(gen2.run.supersededRunId).toBe(gen1.run.runId);
  });

  it("旧 Worker 未退出时 retry 同样被拒绝（统一执行代次保护）", async () => {
    const { service, database } = makeService({ itemCount: 10 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 10 });
    simulateInFlightWorker(database);
    await service.control({ context: owner, batchId, action: "pause" });

    await expect(service.control({ context: owner, batchId, action: "retry" }))
      .rejects.toMatchObject({ code: "BATCH_CAPTURE_EXECUTION_STATE_UNKNOWN" });
  });

  it("正常暂停仍保留租约，并在执行器以完整身份确认退出后才释放", async () => {
    const { service, database } = makeService({ itemCount: 10 });
    const gen1 = await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 10 });
    const inFlight = simulateInFlightWorker(database);

    const paused = await service.control({ context: owner, batchId, action: "pause" });
    expect(paused.status).toBe("PAUSED");
    expect(paused.pauseRequestedAt).toBeTruthy();
    expect(paused.stopAcknowledgedAt).toBeNull();
    expect(paused.leaseOwner).not.toBeNull();
    // 租约活跃时 resume 被拒绝（不回归）
    await expect(service.control({ context: owner, batchId, action: "resume" }))
      .rejects.toMatchObject({ code: "BATCH_CAPTURE_PAUSE_IN_PROGRESS" });

    const acked = await service.acknowledgePause({
      context: owner, batchId, runId: gen1.run.runId,
      executionEpoch: inFlight.executionEpoch, leaseOwner: inFlight.leaseOwner,
    });
    expect(acked?.pauseAcknowledgedAt).toBeTruthy();
    expect(acked?.stopAcknowledgedAt).toBeTruthy();
    expect(acked?.leaseOwner).toBeNull();

    // 确认退出后 resume 正常（不回归）
    const resumed = await service.control({ context: owner, batchId, action: "resume" });
    expect(resumed.status).toBe("RUNNING");
  });

  it("旧 Worker 的迟到结果不得覆盖已中止状态（CAS 保护）", async () => {
    let cancelledDuringWorker = false;
    let serviceRef: ReturnType<typeof createBatchCaptureRunService> | null = null;
    const detailWorker = async (input: { targetAsins?: unknown }) => {
      const targetAsins = Array.isArray(input.targetAsins) ? (input.targetAsins as string[]) : [];
      if (!cancelledDuringWorker) {
        cancelledDuringWorker = true;
        // 外部采集进行中，用户中止（并发写入推进版本号）。
        await serviceRef!.control({ context: owner, batchId, action: "cancel" });
      }
      return {
        value: { summary: {}, items: targetAsins.map((asin) => ({ asin, status: "enriched", evidenceId: `ev-${asin}`, errorCode: null })) },
        replayed: false,
        receiptId: "rc",
      };
    };
    const { service } = makeService({
      itemCount: 10,
      detailWorker: detailWorker as never,
      onService: (created) => { serviceRef = created; },
    });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 10 });

    await expect(service.advance({ context: owner, batchId, env: envOn, leaseOwner: "driver-A" }))
      .rejects.toMatchObject({ code: "BATCH_CAPTURE_CAS_CONFLICT" });

    const run = await service.getRun(batchId);
    expect(run?.status).toBe("CANCELLED");
    // 迟到的 Worker 结果没有写入任何成功单元
    expect(run?.cells.filter((cell) => cell.status === "succeeded" && cell.module !== "amazon_search_market")).toHaveLength(0);
  });

  it("片尾导航结算期间收到中止时保留 CANCELLED，且不推进下一件商品", async () => {
    let serviceRef: ReturnType<typeof createBatchCaptureRunService> | null = null;
    const modules: string[] = [];
    const { service, database } = makeService({
      itemCount: 2,
      onService: (created) => { serviceRef = created; },
      onWorkerCall: (moduleId) => modules.push(moduleId),
    });
    await service.start({
      context: owner, batchId, maxItemsPerAdvance: 1, authorizedItemLimit: 2,
      allowedModules: ["amazon_detail"],
    });

    const originalUpdateMany = database.v5OperationReceipt.updateMany;
    let injected = false;
    database.v5OperationReceipt.updateMany = async (args: any) => {
      const row = database.rows.find((candidate) => candidate.id === args.where.id);
      const before = row?.responseJson ? JSON.parse(row.responseJson) : null;
      const after = typeof args.data?.responseJson === "string" ? JSON.parse(args.data.responseJson) : null;
      const settlingReservedNavigation = before?.status === "RUNNING"
        && Number(before.navigationBudget?.reserved) > 0
        && Number(after?.navigationBudget?.reserved) === 0
        && Number(after?.navigationBudget?.used) > Number(before.navigationBudget?.used);
      if (!injected && settlingReservedNavigation) {
        injected = true;
        await serviceRef!.control({ context: owner, batchId, action: "cancel" });
      }
      return originalUpdateMany(args);
    };

    const run = await service.drive({ context: owner, batchId, env: envOn, leaseOwner: "driver-cancel-at-settle" });
    expect(injected).toBe(true);
    expect(run.status).toBe("CANCELLED");
    expect(modules).toEqual(["amazon_detail"]);
    expect(run.navigationBudget.reserved).toBe(0);
    expect(run.stopAcknowledgedAt).toBeTruthy();
  });

  it("自动重试切片仍持有同一执行权，竞争 drive 不会重复启动商品 Worker", async () => {
    let serviceRef: ReturnType<typeof createBatchCaptureRunService> | null = null;
    let calls = 0;
    let competingError: unknown;
    const detailWorker = async (input: { targetAsins?: unknown }) => {
      const targetAsins = Array.isArray(input.targetAsins) ? input.targetAsins as string[] : [];
      calls += 1;
      if (calls === 1) {
        return { value: { items: targetAsins.map((asin) => ({ asin, status: "failed_retryable", retryable: true, errorCode: "TRANSIENT_NETWORK" })) } };
      }
      if (calls === 2) {
        try {
          await serviceRef!.drive({ context: owner, batchId, env: envOn, leaseOwner: "competing-driver" });
        } catch (error) {
          competingError = error;
        }
      }
      return { value: { items: targetAsins.map((asin) => ({ asin, status: "enriched", evidenceId: `ev-${asin}` })) } };
    };
    const { service } = makeService({
      itemCount: 1,
      detailWorker,
      onService: (created) => { serviceRef = created; },
    });
    await service.start({
      context: owner, batchId, maxItemsPerAdvance: 1, authorizedItemLimit: 1,
      allowedModules: ["amazon_detail"],
    });

    const run = await service.drive({ context: owner, batchId, env: envOn, leaseOwner: "primary-driver" });
    expect(competingError).toMatchObject({ code: "BATCH_CAPTURE_JOB_BUSY" });
    expect(calls).toBe(2);
    expect(run.status).toBe("COMPLETED");
    expect(run.cells.filter((cell) => cell.module === "amazon_detail" && cell.status === "succeeded")).toHaveLength(1);
  });

  it("Detail 遇到验证码后不再启动 Variation 与 Review", async () => {
    const modules: string[] = [];
    const humanGateWorker = async (input: { targetAsins?: unknown }) => {
      const targetAsins = Array.isArray(input.targetAsins) ? input.targetAsins as string[] : [];
      return {
        value: { items: targetAsins.map((asin) => ({ asin, status: "failed_human", retryable: false, errorCode: "CAPTCHA_DETECTED" })) },
      };
    };
    const { service } = makeService({
      itemCount: 1,
      detailWorker: humanGateWorker,
      onWorkerCall: (moduleId) => modules.push(moduleId),
    });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 1, authorizedItemLimit: 1 });

    const run = await service.drive({ context: owner, batchId, env: envOn });
    expect(run.status).toBe("HUMAN_REQUIRED");
    expect(modules).toEqual(["amazon_detail"]);
    expect(run.cells.some((cell) => cell.status === "blocked_human" && cell.lastErrorCode === "CAPTCHA_DETECTED")).toBe(true);
  });

  it("查询级 Worker 收到与 ASIN Worker 相同的 shouldStop，并在中止后立即为真", async () => {
    let capturedShouldStop: (() => Promise<boolean>) | undefined;
    const keywordWorker = async (input: { shouldStop?: () => Promise<boolean> }) => {
      capturedShouldStop = input.shouldStop;
      return {
        status: "blocked",
        navigationPerformed: false,
        querySubjectKey: null,
        queryFingerprint: null,
        evidenceAttachmentId: null,
        evidenceContentHash: null,
        rowsObserved: 0,
        errorCode: "SELLERSPRITE_KEYWORD_MINING_BCR_DISABLED",
      };
    };
    const { service } = makeService({
      itemCount: 10,
      runKeywordMiningQuery: keywordWorker as never,
    });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 10 });
    await service.prepareKeywordMiningQuery({ context: owner, batchId, query: { seedKeyword: "silicone baking mat" } });

    const advanced = await service.advance({ context: owner, batchId, env: queryEnvOn, leaseOwner: "driver-A" });
    expect(advanced.keywordMiningQueries[0]?.status).toBe("blocked");
    expect(capturedShouldStop).toBeDefined();
    // advance 已释放本轮执行租约；迟到的 Worker 不能在退出后继续工作。
    expect(await capturedShouldStop!()).toBe(true);

    await service.control({ context: owner, batchId, action: "cancel" });
    expect(await capturedShouldStop!()).toBe(true);
  });

  it("已中止的运行不得再被 advance 推进", async () => {
    const { service, database } = makeService({ itemCount: 10 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 10 });
    simulateInFlightWorker(database);
    await service.control({ context: owner, batchId, action: "cancel" });
    expireLease(database);

    await expect(service.advance({ context: owner, batchId, env: envOn }))
      .rejects.toMatchObject({ code: "BATCH_CAPTURE_RUN_CANCELLED" });
  });
});
