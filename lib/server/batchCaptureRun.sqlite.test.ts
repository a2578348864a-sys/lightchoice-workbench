import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { replayAllCheckedInMigrations } from "@/lib/marketScan/__fixtures__/migrationReplay";
import { createBatchCaptureRunService } from "@/lib/server/batchCaptureRunService";
import type { BatchCaptureRun } from "@/lib/server/batchCaptureRun";

// 批量 BCR 用例需显式声明运行范围；生产缺省仍为 single_asin_only（只允许单 ASIN）。
process.env.V5_ACQUISITION_SCOPE = "batch_and_single";

let root = "";
let databasePath = "";
let first: PrismaClient;
let second: PrismaClient;

function databaseUrl(path: string): string {
  return `file:${path.replaceAll("\\", "/")}`;
}

const owner = { mode: "owner" as const, token: "" };
const batchId = "batch-sqlite-01";
const envOn = { LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single" } as unknown as NodeJS.ProcessEnv;

function batchItems(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    asin: `B0${String(index + 1).padStart(8, "0")}`,
    archivedAt: null,
  }));
}

function fakeStore(count: number) {
  return {
    getBatch: async (id: string) => (id === batchId ? { id: batchId, batchStatus: "ready", query: "demo" } : null),
    getBatchItems: async () => batchItems(count),
  };
}

type WorkerCall = { module: string; asin: string };

function successWorker(module: string, record: WorkerCall[]) {
  return async (input: { targetAsins?: unknown }) => {
    const targetAsins = Array.isArray(input.targetAsins) ? (input.targetAsins as string[]) : [];
    return {
      value: {
        summary: {},
        items: targetAsins.map((asin) => {
          record.push({ module, asin });
          return { asin, status: "enriched", evidenceId: `ev-${module}-${asin}`, errorCode: null };
        }),
      },
      replayed: false,
      receiptId: `rc-${module}`,
    };
  };
}

function makeService(client: PrismaClient, options: {
  items: number;
  now?: () => Date;
  record?: WorkerCall[];
  detailWorker?: (input: { targetAsins?: unknown }) => Promise<unknown>;
}) {
  const record = options.record ?? [];
  return createBatchCaptureRunService({
    database: client as never,
    getProductBatchStore: () => fakeStore(options.items) as never,
    now: options.now,
    enrichDetail: (options.detailWorker ?? successWorker("amazon_detail", record)) as never,
    enrichVariation: successWorker("variation", record) as never,
    enrichReview: successWorker("review_voc", record) as never,
  });
}

async function currentRow(client: PrismaClient) {
  return client.v5OperationReceipt.findUnique({
    where: {
      actorScope_operation_resourceKey_idempotencyKey: {
        actorScope: "owner:v1",
        operation: "source-layer:batch-capture-run:v1",
        resourceKey: batchId,
        idempotencyKey: "batch-capture-run.v1",
      },
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "batch-capture-run-sqlite-"));
  databasePath = join(root, "run.sqlite");
  first = new PrismaClient({ datasources: { db: { url: databaseUrl(databasePath) } } });
  second = new PrismaClient({ datasources: { db: { url: databaseUrl(databasePath) } } });
  const database = new DatabaseSync(databasePath);
  try {
    // 迁移条数不再硬编码：以 prisma/migrations 下的目录数为准，避免每新增一个迁移就误报失败。
    const checkedInMigrations = readdirSync(join(process.cwd(), "prisma", "migrations"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).length;
    expect(replayAllCheckedInMigrations(database)).toHaveLength(checkedInMigrations);
  } finally {
    database.close();
  }
});

afterEach(async () => {
  await Promise.all([first?.$disconnect(), second?.$disconnect()]);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("BatchCaptureRun real SQLite concurrency and recovery", () => {
  it("acceptance 1) two drivers racing on the same batch: only one legal executor wins", async () => {
    const recordA: WorkerCall[] = [];
    const recordB: WorkerCall[] = [];
    let signalEntered!: () => void;
    let releaseWorker!: () => void;
    const workerEntered = new Promise<void>((resolveEntered) => { signalEntered = resolveEntered; });
    const workerGate = new Promise<void>((resolveGate) => { releaseWorker = resolveGate; });
    // 详情 Worker 阻塞：确保 A 在整个 B 尝试期间都持有租约（确定性竞争）。
    const slowDetailWorker = async (input: { targetAsins?: unknown }) => {
      signalEntered();
      await workerGate;
      const targetAsins = Array.isArray(input.targetAsins) ? (input.targetAsins as string[]) : [];
      return {
        value: {
          summary: {},
          items: targetAsins.map((asin) => {
            recordA.push({ module: "amazon_detail", asin });
            return { asin, status: "enriched", evidenceId: `ev-${asin}`, errorCode: null };
          }),
        },
        replayed: false,
        receiptId: "rc",
      };
    };
    const serviceA = makeService(first, { items: 30, record: recordA, detailWorker: slowDetailWorker });
    const serviceB = makeService(second, { items: 30, record: recordB });
    await serviceA.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });

    const aPromise = serviceA.advance({ context: owner, batchId, env: envOn, leaseOwner: "driver-A" });
    await workerEntered; // A 已取得租约并进入外部采集
    // B 在 A 仍持有租约期间尝试领取同一批次（A 阻塞在 Worker，直到 B 落定后才释放）。
    const [b] = await Promise.allSettled([
      serviceB.advance({ context: owner, batchId, env: envOn, leaseOwner: "driver-B" }),
    ]);
    releaseWorker();
    const [a] = await Promise.allSettled([aPromise]);

    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    const code = (b as PromiseRejectedResult).reason as { code?: string };
    expect(["BATCH_CAPTURE_JOB_BUSY", "BATCH_CAPTURE_CAS_CONFLICT"]).toContain(code.code);

    // 第二个驱动在租约阶段即被拒绝，从未触发外部采集。
    expect(recordB).toHaveLength(0);

    const run = await serviceA.getRun(batchId);
    expect(run?.cells.filter((cell) => cell.module === "amazon_detail" && cell.status === "succeeded").length).toBe(5);
    expect(run?.advances).toBe(1);
  });

  it("acceptance 2/3) pause during capture: the late Worker result must NOT overwrite PAUSED", async () => {
    const serviceA = makeService(first, { items: 10 });
    const serviceB = makeService(second, { items: 10 });
    await serviceA.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });

    let paused = false;
    const racingWorker = async (input: { targetAsins?: unknown }) => {
      if (!paused) {
        paused = true;
        // 外部采集进行中，用户暂停（真实第二个连接写入，版本前进）。
        await serviceB.control({ context: owner, batchId, action: "pause" });
      }
      const targetAsins = Array.isArray(input.targetAsins) ? (input.targetAsins as string[]) : [];
      return {
        value: { summary: {}, items: targetAsins.map((asin) => ({ asin, status: "enriched", evidenceId: `ev-${asin}`, errorCode: null })) },
        replayed: false,
        receiptId: "rc",
      };
    };
    const racing = makeService(first, { items: 10, detailWorker: racingWorker });

    await expect(racing.advance({ context: owner, batchId, env: envOn, leaseOwner: "driver-A" }))
      .rejects.toMatchObject({ code: "BATCH_CAPTURE_CAS_CONFLICT" });

    const run = await serviceA.getRun(batchId);
    expect(run?.status).toBe("PAUSED");
    expect(run?.cells.filter((cell) => cell.status === "succeeded" && cell.module !== "amazon_search_market").length).toBe(0);
  });

  it("acceptance 4) process exit after one item completes: the same run resumes without omission or duplication", async () => {
    const seedRecord: WorkerCall[] = [];
    const seed = makeService(first, { items: 60, record: seedRecord });
    await seed.start({ context: owner, batchId, maxItemsPerAdvance: 1, authorizedItemLimit: 60 });
    const afterOne = await seed.advance({ context: owner, batchId, env: envOn, leaseOwner: "crashed-process" });
    const succeededBefore = afterOne.cells
      .filter((cell) => cell.module === "amazon_detail" && cell.status === "succeeded")
      .map((cell) => cell.asin);
    expect(succeededBefore).toHaveLength(1);

    // 模拟进程在「某一商品完成后」异常退出：数据库中遗留一个未释放、仍有效的运行租约。
    const row = await currentRow(first);
    expect(row).not.toBeNull();
    const crashed: BatchCaptureRun = {
      ...(JSON.parse(row!.responseJson as string) as BatchCaptureRun),
      leaseOwner: "crashed-process",
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
    await first.v5OperationReceipt.updateMany({ where: { id: row!.id }, data: { responseJson: JSON.stringify(crashed) } });

    // 新进程在租约过期后接管「同一合法运行」（runId 不变），从持久化断点续跑。
    const recoverRecord: WorkerCall[] = [];
    const recovered = makeService(second, {
      items: 60, record: recoverRecord, now: () => new Date(Date.now() + 200_000),
    });
    const run = await recovered.drive({ context: owner, batchId, env: envOn, maxSlices: 100, leaseOwner: "restarted-process" });

    expect(run.runId).toBe(afterOne.runId);
    /**
     * reverse_asin 属于自动模块，但它的真实来源开关默认关闭（envOn 只开 LOCAL_ACQUISITION_ENABLED），
     * 因此其单元终态为 source_input_required → 整体 PARTIAL。
     * 这里断言的是「不会因为未授权的真实来源而伪造完成」，而不是掩盖缺口。
     */
    expect(run.status).toBe("PARTIAL");
    expect(run.cells.filter((cell) => cell.module === "reverse_asin").every((cell) => cell.status === "source_input_required")).toBe(true);
    expect(run.cells.filter((cell) => cell.module === "amazon_detail" && cell.status === "succeeded")).toHaveLength(60);
    expect(run.cells.filter((cell) => cell.module === "amazon_detail").every((cell) => cell.attempts === 1)).toBe(true);
    // 已完成的商品不再重复执行。
    expect(recoverRecord.some((call) => call.module === "amazon_detail" && call.asin === succeededBefore[0])).toBe(false);
  }, 60_000);

  it("acceptance 5) an older run generation is independently readable after a new generation starts", async () => {
    const service = makeService(first, { items: 4 });
    const gen1 = await service.start({ context: owner, batchId, maxItemsPerAdvance: 4, authorizedItemLimit: 4 });
    await service.control({ context: owner, batchId, action: "cancel" });
    const gen2 = await service.start({ context: owner, batchId, maxItemsPerAdvance: 4, authorizedItemLimit: 4 });
    expect(gen2.run.runGeneration).toBe(2);

    const runs = await service.listRuns({ context: owner, batchId });
    expect(runs.map((run) => run.runGeneration)).toEqual([1, 2]);

    const rows = await first.v5OperationReceipt.findMany({
      where: { operation: "source-layer:batch-capture-run:v1", resourceKey: batchId },
    });
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.idempotencyKey === `batch-capture-run.v1:run:${gen1.run.runId}`)).toBe(true);
    expect(rows.some((row) => row.idempotencyKey === "batch-capture-run.v1")).toBe(true);
  });

  it("acceptance 6) 60 items sharded with budget 5: no duplication and no omission", async () => {
    const record: WorkerCall[] = [];
    const service = makeService(first, { items: 60, record });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 60 });
    const run = await service.drive({ context: owner, batchId, env: envOn, maxSlices: 100 });

    // reverse_asin 的真实来源开关默认关闭 → 该模块整体 source_input_required，运行按 PARTIAL 收口。
    expect(run.status).toBe("PARTIAL");
    expect(run.cells.filter((cell) => cell.module === "reverse_asin").every((cell) => cell.status === "source_input_required")).toBe(true);
    expect(run.progress.itemsInBatch).toBe(60);
    expect(run.progress.uniqueItemsVisited).toBe(60);
    expect(run.progress.totalCells).toBe(60 * 8);

    const detailCells = run.cells.filter((cell) => cell.module === "amazon_detail");
    expect(detailCells).toHaveLength(60);
    expect(detailCells.every((cell) => cell.status === "succeeded" && cell.attempts === 1)).toBe(true);

    // 每个 ASIN 的每个模块只被真正请求一次（不重复、不遗漏）。
    const perKey = new Map<string, number>();
    for (const call of record) {
      const key = `${call.module}:${call.asin}`;
      perKey.set(key, (perKey.get(key) ?? 0) + 1);
    }
    expect(perKey.size).toBe(60 * 3);
    expect([...perKey.values()].every((count) => count === 1)).toBe(true);
  });
});

describe("BatchCaptureRun CAS lost-update guard", () => {
  it("修复前形态（先读后无条件 upsert/update）会丢失更新：证明 CAS 修复的必要性", async () => {
    const where = {
      actorScope_operation_resourceKey_idempotencyKey: {
        actorScope: "owner:v1",
        operation: "source-layer:batch-capture-run:v1",
        resourceKey: "batch-before-01",
        idempotencyKey: "batch-capture-run.v1",
      },
    };
    await first.v5OperationReceipt.create({
      data: {
        id: "row-before-01",
        actorScope: "owner:v1",
        operation: "source-layer:batch-capture-run:v1",
        resourceKey: "batch-before-01",
        idempotencyKey: "batch-capture-run.v1",
        requestHash: "run:0",
        status: "RUNNING",
        responseJson: JSON.stringify({ version: 0 }),
        expiresAt: null,
      },
    });

    // 旧 persistCas 形态：先 findUnique 读版本，再无条件 upsert/update 写入。
    const snapshotA = await first.v5OperationReceipt.findUnique({ where });
    const snapshotB = await second.v5OperationReceipt.findUnique({ where });
    expect(JSON.parse(snapshotA!.responseJson as string).version).toBe(0);
    expect(JSON.parse(snapshotB!.responseJson as string).version).toBe(0);

    // 两个写者基于同一版本 0 各自"成功"写入 → 后写覆盖先写（丢失更新），且不报错。
    await first.v5OperationReceipt.update({ where, data: { responseJson: JSON.stringify({ version: 1, writer: "A" }) } });
    await second.v5OperationReceipt.update({ where, data: { responseJson: JSON.stringify({ version: 1, writer: "B" }) } });

    const finalRow = await first.v5OperationReceipt.findUnique({ where });
    expect(JSON.parse(finalRow!.responseJson as string).writer).toBe("B");
    // 版本没有前进到 2：两次「成功」写入被压成一次 → 旧实现无法阻止并发覆盖。
    expect(JSON.parse(finalRow!.responseJson as string).version).toBe(1);
  });

  it("a stale version write is rejected by the real database conditional update", async () => {
    const service = makeService(first, { items: 4 });
    const started = await service.start({ context: owner, batchId, maxItemsPerAdvance: 4, authorizedItemLimit: 4 });
    const row = await currentRow(first);
    expect(row).not.toBeNull();
    const run = JSON.parse(row!.responseJson as string) as BatchCaptureRun;
    const nextRun: BatchCaptureRun = { ...run, version: run.version + 1, status: "RUNNING" };

    const ok = await first.v5OperationReceipt.updateMany({
      where: { id: row!.id, status: row!.status, updatedAt: row!.updatedAt, responseJson: row!.responseJson },
      data: { status: nextRun.status, responseJson: JSON.stringify(nextRun) },
    });
    expect(ok.count).toBe(1);

    const stale = await second.v5OperationReceipt.updateMany({
      where: { id: row!.id, status: row!.status, updatedAt: row!.updatedAt, responseJson: row!.responseJson },
      data: { status: "COMPLETED", responseJson: JSON.stringify({ ...nextRun, status: "COMPLETED" }) },
    });
    expect(stale.count).toBe(0);

    const finalRun = await service.getRun(batchId);
    expect(finalRun?.status).toBe("RUNNING");
    expect(finalRun?.runId).toBe(started.run.runId);
  });
});

describe("D2-1E blocked execution receipt（执行阻塞回执）", () => {
  it("把执行阻塞持久化为 run 级回执：状态/租约/单元矩阵不变，刷新后真实可读", async () => {
    const service = makeService(first, { items: 3 });
    const { run } = await service.start({ context: owner, batchId, maxItemsPerAdvance: 3, authorizedItemLimit: 3 });
    const cellsBefore = run.cells.map((cell) => `${cell.asin}:${cell.module}:${cell.status}`).join("|");

    const written = await service.noteExecutionBlocked({
      context: owner,
      batchId,
      runId: run.runId,
      code: "LOCAL_ENVIRONMENT_REQUIRED",
    });

    expect(written?.lastErrorCode).toBe("LOCAL_ENVIRONMENT_REQUIRED");
    // 未提供 message 时使用权威默认文案（原因 + 下一步）。
    expect(written?.lastMessage).toContain("本地采集未启用");
    expect(written?.lastMessage).toContain("启用本地采集后可继续执行");
    // 只写回执：不改状态、不碰租约、不动执行代次、不改授权。
    expect(written?.status).toBe("WAITING");
    expect(written?.leaseOwner).toBeNull();
    expect(written?.executionEpoch).toBe(0);
    expect(written?.authorizedItemLimit).toBe(3);
    expect(written?.version).toBe(run.version + 1);
    // 单元矩阵逐格不变（回执不得伪装成执行结果）。
    expect(written?.cells.map((cell) => `${cell.asin}:${cell.module}:${cell.status}`).join("|")).toBe(cellsBefore);

    // 刷新/重启后仍能读到原因（真持久化，不是内存态）。
    const fresh = await service.getRun(batchId);
    expect(fresh?.lastErrorCode).toBe("LOCAL_ENVIRONMENT_REQUIRED");
  });

  it("runId 不匹配或运行已到终态时拒绝写入（回执不得污染其他代次/终态）", async () => {
    const service = makeService(first, { items: 2 });
    const { run } = await service.start({ context: owner, batchId, maxItemsPerAdvance: 2, authorizedItemLimit: 2 });

    const mismatched = await service.noteExecutionBlocked({
      context: owner, batchId, runId: "other-run-id", code: "LOCAL_ENVIRONMENT_REQUIRED", message: "x",
    });
    expect(mismatched).toBeNull();
    expect((await service.getRun(batchId))?.lastErrorCode).toBeNull();

    await service.control({ context: owner, batchId, action: "cancel" });
    const onTerminal = await service.noteExecutionBlocked({
      context: owner, batchId, runId: run.runId, code: "LOCAL_ENVIRONMENT_REQUIRED", message: "x",
    });
    expect(onTerminal).toBeNull();
    const after = await service.getRun(batchId);
    expect(after?.status).toBe("CANCELLED");
    expect(after?.lastErrorCode).toBeNull();
  });
});
