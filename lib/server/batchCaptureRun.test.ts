import { describe, expect, it, vi } from "vitest";

import { createBatchCaptureRunService } from "./batchCaptureRunService";
import { isResearchConsumable } from "./batchCaptureRunService";
import { projectBatchCaptureRunSearchEvidence } from "./batchCaptureRunService";
import { deriveBatchCaptureRunStatus } from "./batchCaptureRun";
import type { BatchCaptureRun, BatchCaptureCell } from "./batchCaptureRun";

// 批量 BCR 用例需显式声明运行范围；生产缺省仍为 single_asin_only（只允许单 ASIN）。
process.env.V5_ACQUISITION_SCOPE = "batch_and_single";

type Row = {
  id: string;
  actorScope: string;
  operation: string;
  resourceKey: string;
  idempotencyKey: string;
  requestHash: string;
  status: string;
  responseJson: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const owner = { mode: "owner" as const, token: "" };
const batchId = "batch-capture-001";
const BASE = Date.parse("2026-10-12T12:00:00.000Z");

/** 忠实模拟 Prisma 复合唯一键 + @updatedAt + updateMany 条件更新的内存库。 */
function fixtureDatabase() {
  const rows: Row[] = [];
  let clock = 0;
  const composite = (row: { actorScope: string; operation: string; resourceKey: string; idempotencyKey: string }) =>
    [row.actorScope, row.operation, row.resourceKey, row.idempotencyKey].join("|");

  return {
    rows,
    v5OperationReceipt: {
      findUnique: async (args: { where: { actorScope_operation_resourceKey_idempotencyKey: { actorScope: string; operation: string; resourceKey: string; idempotencyKey: string } } }) => {
        const k = args.where.actorScope_operation_resourceKey_idempotencyKey;
        return rows.find((row) => composite(row) === composite(k)) ?? null;
      },
      findMany: async (args: { where: { actorScope: string; operation: string; resourceKey: string } }) => {
        const w = args.where;
        return rows.filter((row) =>
          row.actorScope === w.actorScope && row.operation === w.operation && row.resourceKey === w.resourceKey);
      },
      create: async (args: { data: Row }) => {
        const d = args.data;
        if (rows.some((row) => composite(row) === composite(d))) throw new Error("UNIQUE_COMPOSITE");
        if (rows.some((row) => row.id === d.id)) throw new Error("UNIQUE_ID");
        const row: Row = { ...d, createdAt: d.createdAt ?? new Date(BASE), updatedAt: new Date(BASE + (++clock)) };
        rows.push(row);
        return row;
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const w = args.where;
        let count = 0;
        for (const row of rows) {
          if (w.id !== undefined && row.id !== w.id) continue;
          if (w.actorScope !== undefined && row.actorScope !== w.actorScope) continue;
          if (w.operation !== undefined && row.operation !== w.operation) continue;
          if (w.resourceKey !== undefined && row.resourceKey !== w.resourceKey) continue;
          if (w.idempotencyKey !== undefined && row.idempotencyKey !== w.idempotencyKey) continue;
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

function baseBatch() {
  return { id: batchId, batchStatus: "ready", query: "demo" };
}

function baseItems(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    asin: `B0${String(index + 1).padStart(8, "0")}`,
    archivedAt: null,
  }));
}

type EnrichMode = "succeed" | "first_five_only" | "zero_fields" | "human" | "mismatch" | "empty";

function makeService(options?: {
  items?: number;
  mode?: EnrichMode;
  reviewResult?: { status: string; evidenceId?: string | null; errorCode?: string | null; retryable?: boolean };
  onWorkerCall?: (module: string, targetAsins: string[]) => void;
  sessionReadiness?: () => Promise<{ ok: boolean; sessionReady: boolean; message?: string; errorCode?: string | null }>;
}) {
  const database = fixtureDatabase();
  const itemCount = options?.items ?? 60;
  const mode = options?.mode ?? "succeed";
  const processed = new Map<string, Set<string>>();
  const calls: Array<{ module: string; targetAsins: string[] }> = [];

  const store = {
    getBatch: vi.fn(async (id: string) => (id === batchId ? baseBatch() : null)),
    getBatchItems: vi.fn(async () => baseItems(itemCount)),
  };

  async function enrich(module: string, input: { limit?: unknown; targetAsins?: unknown }) {
    const targetAsins = Array.isArray(input.targetAsins) ? (input.targetAsins as string[]) : [];
    calls.push({ module, targetAsins });
    options?.onWorkerCall?.(module, targetAsins);
    const seen = processed.get(module) ?? new Set<string>();
    processed.set(module, seen);
    const accepted: string[] = [];
    for (const asin of targetAsins) {
      if (mode === "first_five_only" && seen.size >= 5) break;
      seen.add(asin);
      accepted.push(asin);
    }
    if (mode === "empty") return { value: { summary: {}, items: [] }, replayed: false, receiptId: `rc-${module}` };
    const items = accepted.map((asin) => {
      if (module === "review_voc" && options?.reviewResult) {
        return {
          asin,
          ...options.reviewResult,
          evidenceId: options.reviewResult.evidenceId ?? null,
          errorCode: options.reviewResult.errorCode ?? null,
        };
      }
      if (mode === "zero_fields") return { asin, status: "captured_partial", evidenceId: null, errorCode: null };
      if (mode === "human") return { asin, status: "failed_human", evidenceId: null, errorCode: "CAPTCHA_DETECTED" };
      return { asin, status: "enriched", evidenceId: `ev-${module}-${asin}`, errorCode: null };
    });
    if (mode === "mismatch") {
      // 模块返回与待处理 ASIN 不一致：额外返回一个未请求的 ASIN。
      items.push({ asin: "B999999999", status: "enriched", evidenceId: "ev-bogus", errorCode: null });
    }
    const summary = {
      total: items.length,
      processed: items.length,
      captured: items.filter((item) => item.status === "enriched").length,
      enriched: items.filter((item) => item.status === "enriched").length,
    };
    return { value: { summary, items }, replayed: false, receiptId: `rc-${module}` };
  }

  const service = createBatchCaptureRunService({
    database: database as never,
    getProductBatchStore: () => store as never,
    now: () => new Date(BASE),
    enrichDetail: (async (input: { limit: unknown; targetAsins: unknown }) => enrich("amazon_detail", input)) as never,
    enrichVariation: (async (input: { limit: unknown; targetAsins: unknown }) => enrich("variation", input)) as never,
    enrichReview: (async (input: { limit: unknown; targetAsins: unknown }) => enrich("review_voc", input)) as never,
    ...(options?.sessionReadiness ? { checkSessionReadiness: options.sessionReadiness as never } : {}),
  });

  return { service, store, database, calls };
}

const envOn = { LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single" } as unknown as NodeJS.ProcessEnv;
const envOff = { LOCAL_ACQUISITION_ENABLED: "false" } as unknown as NodeJS.ProcessEnv;

function detailCells(run: BatchCaptureRun): BatchCaptureCell[] {
  return run.cells.filter((cell) => cell.module === "amazon_detail");
}

async function applyReviewReceipt(result: NonNullable<Parameters<typeof makeService>[0]>["reviewResult"]) {
  const { service } = makeService({ items: 1, reviewResult: result });
  await service.start({
    context: owner,
    batchId,
    maxItemsPerAdvance: 1,
    authorizedItemLimit: 1,
    allowedModules: ["review_voc"],
  });
  const run = await service.advance({ context: owner, batchId, maxItemsPerAdvance: 1, env: envOn });
  const cell = run.cells.find((entry) => entry.module === "review_voc");
  expect(cell).toBeDefined();
  return { run, cell: cell as BatchCaptureCell };
}

describe("P0 batch capture run corrections", () => {
  it("1) 60 items budget 5: first slice does not complete; drive continues until all processed", async () => {
    const { service } = makeService({ items: 60 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 60 });
    const first = await service.advance({ context: owner, batchId, maxItemsPerAdvance: 5, env: envOn });
    expect(first.progress.pendingCells).toBeGreaterThan(0);
    expect(first.status).not.toBe("COMPLETED");
    const driven = await service.drive({ context: owner, batchId, env: envOn, maxSlices: 100 });
    // Reverse ASIN is present in the automatic module contract but remains safely disabled
    // unless its dedicated feature flag is explicitly enabled, so the full run is partial.
    expect(driven.status).toBe("PARTIAL");
    expect(driven.progress.pendingCells).toBe(0);
    expect(driven.progress.uniqueItemsVisited).toBe(60);
    expect(driven.progress.terminalCells).toBe(driven.progress.totalCells);
    expect(driven.progress.totalCells).toBe(60 * 8);
  });

  it("2) first 5 succeed, 55 remaining: status must not be COMPLETED", async () => {
    const { service } = makeService({ items: 60, mode: "first_five_only" });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 60 });
    const run = await service.drive({ context: owner, batchId, env: envOn, maxSlices: 5 });
    expect(run.progress.uniqueItemsVisited).toBeLessThan(60);
    expect(run.status).not.toBe("COMPLETED");
  });

  it("3) three auto modules on same products: unique product progress is not 15", async () => {
    const { service } = makeService({ items: 5 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    const run = await service.drive({ context: owner, batchId, env: envOn, maxSlices: 10 });
    expect(run.progress.uniqueItemsVisited).toBe(5);
    expect(run.progress.totalCells).toBe(5 * 8);
    const autoCells = run.cells.filter((cell) => ["amazon_detail", "variation", "review_voc"].includes(cell.module));
    expect(autoCells.every((cell) => cell.status === "succeeded")).toBe(true);
  });

  it("4) all zero valid fields: must not mark full success", async () => {
    const { service } = makeService({ items: 5, mode: "zero_fields" });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    const run = await service.drive({ context: owner, batchId, env: envOn, maxSlices: 10 });
    expect(run.status).not.toBe("COMPLETED");
    expect(run.progress.validEvidenceCells).toBe(0);
    expect(run.progress.researchConsumableCells).toBe(0);
  });

  it("5) two advances do not double-claim or double-count terminal cells", async () => {
    const { service } = makeService({ items: 10 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 10 });
    const a = await service.advance({ context: owner, batchId, env: envOn });
    const terminalAfterFirst = a.progress.terminalCells;
    const b = await service.advance({ context: owner, batchId, env: envOn });
    expect(b.version).toBeGreaterThan(a.version);
    expect(b.progress.terminalCells).toBeLessThanOrEqual(b.progress.totalCells);
    expect(b.progress.terminalCells).toBeGreaterThanOrEqual(terminalAfterFirst);
    expect(b.progress.uniqueItemsVisited).toBeLessThanOrEqual(10);
    const asins = new Set(detailCells(b).filter((cell) => cell.status === "succeeded").map((cell) => cell.asin));
    expect(asins.size).toBeLessThanOrEqual(10);
  });

  it("6) pause during RUNNING: later advance cannot overwrite PAUSED with stale result", async () => {
    const { service } = makeService({ items: 20 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 20 });
    await service.advance({ context: owner, batchId, env: envOn });
    await service.control({ context: owner, batchId, action: "pause" });
    await expect(service.advance({ context: owner, batchId, env: envOn })).rejects.toMatchObject({
      code: "BATCH_CAPTURE_RUN_PAUSED",
    });
    const run = await service.getRun(batchId);
    expect(run?.status).toBe("PAUSED");
    await service.control({ context: owner, batchId, action: "cancel" });
    await expect(service.advance({ context: owner, batchId, env: envOn })).rejects.toMatchObject({
      code: "BATCH_CAPTURE_RUN_CANCELLED",
    });
  });

  it("7) interrupt and resume from checkpoint without redoing completed cells", async () => {
    const { service } = makeService({ items: 20 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 20 });
    const first = await service.advance({ context: owner, batchId, env: envOn });
    const detailDone = detailCells(first).filter((cell) => cell.status === "succeeded").length;
    expect(detailDone).toBe(5);

    const reloaded = await service.getRun(batchId);
    expect(reloaded?.version).toBe(first.version);
    expect(detailCells(reloaded as BatchCaptureRun).filter((cell) => cell.status === "succeeded").length).toBe(detailDone);

    const next = await service.advance({ context: owner, batchId, env: envOn });
    const succeededAfter = detailCells(next).filter((cell) => cell.status === "succeeded").length;
    expect(succeededAfter).toBe(10);
    expect(next.progress.totalCells).toBe(20 * 8);
  });

  it("8) runGeneration increments keep old generation independently readable", async () => {
    const { service } = makeService({ items: 5 });
    const first = await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    expect(first.run.runGeneration).toBe(1);
    await service.control({ context: owner, batchId, action: "cancel" });
    const second = await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    expect(second.created).toBe(true);
    expect(second.run.runGeneration).toBe(2);
    expect(second.run.supersededRunId).toBe(first.run.runId);
    expect(second.run.runId).not.toBe(first.run.runId);

    const runs = await service.listRuns({ context: owner, batchId });
    expect(runs.map((run) => run.runGeneration)).toEqual([1, 2]);
    const old = runs.find((run) => run.runGeneration === 1);
    expect(old?.runId).toBe(first.run.runId);
    expect(old?.status).toBe("CANCELLED");
  });

  it("9) authorized budget 5 cannot be raised to 30 by later advance", async () => {
    const { service } = makeService({ items: 60 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    const run = await service.advance({ context: owner, batchId, maxItemsPerAdvance: 30, env: envOn });
    expect(detailCells(run).filter((cell) => cell.status === "succeeded").length).toBeLessThanOrEqual(5);
    expect(run.maxItemsPerAdvance).toBe(5);
  });

  it("10) only authorized batch is executed; no historical job side effects", async () => {
    const { service, store } = makeService({ items: 5 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    await service.drive({ context: owner, batchId, env: envOn, maxSlices: 10 });
    expect(store.getBatch).toHaveBeenCalledWith(batchId);
    expect(store.getBatchItems).toHaveBeenCalledWith(batchId);
    expect(new Set(store.getBatch.mock.calls.map((call) => call[0] as string))).toEqual(new Set([batchId]));
  });

  it("11) search-style partial: start failure is surfaced, run absent is not COMPLETED", async () => {
    const database = fixtureDatabase();
    const service = createBatchCaptureRunService({
      database: database as never,
      getProductBatchStore: () => ({
        getBatch: async () => ({ ...baseBatch(), batchStatus: "invalid" }),
        getBatchItems: async () => baseItems(5),
      }) as never,
      enrichDetail: async () => ({ value: { summary: {}, items: [] }, replayed: false, receiptId: "x" }) as never,
      enrichVariation: async () => ({ value: { summary: {}, items: [] }, replayed: false, receiptId: "x" }) as never,
      enrichReview: async () => ({ value: { summary: {}, items: [] }, replayed: false, receiptId: "x" }) as never,
    });
    await expect(service.start({ context: owner, batchId, authorizedItemLimit: 5 })).rejects.toMatchObject({ code: "BATCH_NOT_READY" });
    expect(await service.getRun(batchId)).toBeNull();
  });

  it("12) human gate fails closed and does not auto-retry", async () => {
    const { service } = makeService({ items: 20, mode: "human" });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    const run = await service.drive({ context: owner, batchId, env: envOn, maxSlices: 20 });
    // D2-1H：人工门禁收尾 = HUMAN_REQUIRED（不是笼统的「已暂停」）
    expect(run.status).toBe("HUMAN_REQUIRED");
    expect(run.lastMessage).toContain("需要人工处理");
    expect(run.cells.some((cell) => cell.status === "blocked_human")).toBe(true);
    const blockedBefore = run.cells.filter((cell) => cell.status === "blocked_human").length;
    // 执行器再次驱动是空操作：不自动重试、不重复采集，恢复必须经「继续」显式进行
    const again = await service.advance({ context: owner, batchId, env: envOn });
    expect(again.status).toBe("HUMAN_REQUIRED");
    expect(again.cells.filter((cell) => cell.status === "blocked_human").length).toBe(blockedBefore);
  });

  it.each(["complete", "succeeded"] as const)("maps %s Review/VOC receipt to succeeded only when no human gate is present", async (status) => {
    const { cell } = await applyReviewReceipt({ status, evidenceId: `ev-review-${status}` });
    expect(cell).toMatchObject({
      status: "succeeded",
      evidenceId: `ev-review-${status}`,
      sourceVerified: true,
      fieldComplete: true,
      researchConsumable: true,
    });
  });

  it.each(["partial", "no_data_with_evidence"] as const)("keeps %s as partial and non-consumable", async (status) => {
    const { cell } = await applyReviewReceipt({ status, evidenceId: "ev-review-limited" });
    expect(cell).toMatchObject({
      status: "partial",
      evidenceId: "ev-review-limited",
      fieldComplete: false,
      researchConsumable: false,
    });
  });

  it("prioritizes HUMAN_GATE_PAUSE over evidenceId and preserves the blocking reference", async () => {
    const { run, cell } = await applyReviewReceipt({
      status: "blocked_with_evidence",
      evidenceId: "ev-review-human-gate",
      errorCode: "HUMAN_GATE_PAUSE",
      retryable: true,
    });
    expect(cell).toMatchObject({
      status: "blocked_human",
      evidenceId: "ev-review-human-gate",
      lastErrorCode: "HUMAN_GATE_PAUSE",
      sourceVerified: false,
      fieldComplete: false,
      researchConsumable: false,
    });
    expect(run.status).toBe("HUMAN_REQUIRED");
    expect(run.progress.validEvidenceCells).toBe(0);
    expect(run.progress.researchConsumableCells).toBe(0);
  });

  it.each(["CAPTCHA_DETECTED", "LOGIN_REQUIRED"] as const)("human error %s overrides a nominal success receipt", async (errorCode) => {
    const { cell } = await applyReviewReceipt({
      status: "complete",
      evidenceId: `ev-review-${errorCode.toLowerCase()}`,
      errorCode,
    });
    expect(cell).toMatchObject({
      status: "blocked_human",
      evidenceId: `ev-review-${errorCode.toLowerCase()}`,
      sourceVerified: false,
      fieldComplete: false,
      researchConsumable: false,
    });
  });

  it("keeps non-human blocked evidence failed and retains its evidence reference", async () => {
    const { run, cell } = await applyReviewReceipt({
      status: "blocked_with_evidence",
      evidenceId: "ev-review-blocked",
      errorCode: "ASIN_PAGE_ANCHOR_MISMATCH",
      retryable: false,
    });
    expect(cell).toMatchObject({
      status: "failed_permanent",
      evidenceId: "ev-review-blocked",
      sourceVerified: false,
      fieldComplete: false,
      researchConsumable: false,
    });
    expect(run.progress.validEvidenceCells).toBe(0);
  });

  it("preserves retryability for blocked evidence without treating it as valid content", async () => {
    const { cell } = await applyReviewReceipt({
      status: "blocked_with_evidence",
      evidenceId: "ev-review-retryable-block",
      errorCode: "AMAZON_PAGE_CHANGED",
      retryable: true,
    });
    expect(cell).toMatchObject({
      status: "failed_retryable",
      evidenceId: "ev-review-retryable-block",
      sourceVerified: false,
      fieldComplete: false,
      researchConsumable: false,
    });
  });

  it("fails closed on an unknown status even when the worker includes an Evidence ID", async () => {
    const { run, cell } = await applyReviewReceipt({
      status: "future_worker_state",
      evidenceId: "ev-review-unknown",
    });
    expect(cell).toMatchObject({
      status: "failed_permanent",
      evidenceId: "ev-review-unknown",
      sourceVerified: false,
      fieldComplete: false,
      researchConsumable: false,
    });
    expect(run.progress.validEvidenceCells).toBe(0);
    expect(run.progress.researchConsumableCells).toBe(0);
  });

  it("advance rejects when local acquisition disabled", async () => {
    const { service } = makeService({ items: 5 });
    await service.start({ context: owner, batchId, authorizedItemLimit: 5 });
    await expect(service.advance({ context: owner, batchId, env: envOff })).rejects.toMatchObject({
      code: "LOCAL_ENVIRONMENT_REQUIRED",
    });
  });

  it("advance with local acquisition disabled has no side effects (no worker call, no persistence)", async () => {
    const { service, database, calls } = makeService({ items: 5 });
    await service.start({ context: owner, batchId, authorizedItemLimit: 5 });
    // 关闭态必须在获取租约与写入之前就拒绝：快照全部回执行，断言前后完全一致。
    const before = JSON.stringify(database.rows);
    await expect(service.advance({ context: owner, batchId, env: envOff })).rejects.toMatchObject({
      code: "LOCAL_ENVIRONMENT_REQUIRED",
      status: 409,
    });
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(database.rows)).toEqual(before);
  });

  it("lease blocks concurrent advance from another holder", async () => {
    const { service, database } = makeService({ items: 30 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    const run = await service.getRun(batchId);
    expect(run).not.toBeNull();
    const leased: BatchCaptureRun = {
      ...(run as BatchCaptureRun),
      status: "RUNNING",
      leaseOwner: "other-driver",
      leaseExpiresAt: new Date(BASE + 60_000).toISOString(),
    };
    const row = database.rows[0] as Row;
    row.responseJson = JSON.stringify(leased);
    row.status = leased.status;
    await expect(
      service.advance({ context: owner, batchId, env: envOn, leaseOwner: "drive-B" }),
    ).rejects.toMatchObject({ code: "BATCH_CAPTURE_JOB_BUSY" });
  });

  it("acceptance 7) worker returns an ASIN that was not requested: result is rejected", async () => {
    const { service } = makeService({ items: 3, mode: "mismatch" });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 3, authorizedItemLimit: 3 });
    const run = await service.advance({ context: owner, batchId, env: envOn });
    // 未请求的 B999999999 绝不进入任何单元格。
    expect(run.cells.some((cell) => cell.asin === "B999999999")).toBe(false);
    expect(run.progress.validEvidenceCells).toBe(3 * 3);
  });

  it("acceptance 8a) empty result only marks the ASINs actually requested", async () => {
    const { service } = makeService({ items: 5, mode: "empty" });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 5 });
    const run = await service.advance({ context: owner, batchId, env: envOn });
    const detail = detailCells(run);
    const retryable = detail.filter((cell) => cell.status === "failed_retryable");
    expect(retryable.length).toBe(5);
    expect(detail.filter((cell) => cell.status === "pending").length).toBe(0);
    expect(retryable.every((cell) => cell.lastErrorCode === "ENRICH_EMPTY_RESULT")).toBe(true);
    expect(run.status).toBe("PARTIAL");
  });

  it("acceptance 8b) bounded retry requires explicit authorization", async () => {
    const { service } = makeService({ items: 2, mode: "empty" });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 2, authorizedItemLimit: 2 });
    const first = await service.advance({ context: owner, batchId, env: envOn });
    expect(first.cells.filter((cell) => cell.module === "amazon_detail" && cell.status === "failed_retryable").length).toBe(2);
    expect(first.status).toBe("PARTIAL");
    // 未授权：failed_retryable 视为终态，不再执行（终态运行 advance 为幂等 no-op）。
    const noRetry = await service.advance({ context: owner, batchId, env: envOn });
    expect(noRetry.advances).toBe(first.advances);
    expect(detailCells(noRetry).every((cell) => cell.attempts === 1)).toBe(true);
    // 显式授权重试：重置为 pending 后再次执行。
    const authorized = await service.control({ context: owner, batchId, action: "retry" });
    expect(authorized.retryAuthorized).toBe(true);
    expect(detailCells(authorized).every((cell) => cell.status === "pending")).toBe(true);
    const retried = await service.advance({ context: owner, batchId, env: envOn, allowRetry: true });
    expect(detailCells(retried).every((cell) => cell.attempts === 2)).toBe(true);
  });

  it("acceptance 10) four non-automated modules remain visible as source_limited gaps", async () => {
    const { service } = makeService({ items: 4 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 4, authorizedItemLimit: 4 });
    const run = await service.drive({ context: owner, batchId, env: envOn, maxSlices: 10 });
    const modules = run.moduleOutcomes.map((outcome) => outcome.module);
    expect(modules).toContain("sellersprite_product_market");
    expect(modules).toContain("reverse_asin");
    expect(modules).toContain("keyword_mining_trend");
    expect(modules).toContain("historical_trend");
    for (const moduleId of ["sellersprite_product_market", "reverse_asin", "keyword_mining_trend", "historical_trend"]) {
      const outcome = run.moduleOutcomes.find((entry) => entry.module === moduleId);
      expect(outcome?.dataQuality).toBe("source_limited");
      expect(outcome?.completed).toBe(false);
      expect(outcome?.itemsSourceLimited).toBe(4);
      expect(outcome?.errorCode).toBe("SOURCE_INPUT_REQUIRED");
    }
  });

  it("acceptance 10b) search-phase evidence binds to the matrix without claiming research consumption", async () => {
    const { service } = makeService({ items: 2 });
    await service.start({
      context: owner,
      batchId,
      maxItemsPerAdvance: 2,
      authorizedItemLimit: 2,
      searchEvidence: [{ asin: "B000000001", evidenceRef: "amazon:US:B000000001:v3" }],
    });
    const run = await service.getRun(batchId);
    const searchCell = run?.cells.find((cell) => cell.module === "amazon_search_market" && cell.asin === "B000000001");
    expect(searchCell?.status).toBe("succeeded");
    expect(searchCell?.evidenceId).toBe("amazon:US:B000000001:v3");
    expect(searchCell?.sourceVerified).toBe(true);
    expect(searchCell?.fieldComplete).toBe(false);
    expect(searchCell?.researchConsumable).toBe(false);
  });

  it("moduleOutcomes 含搜索阶段模块：cells 有 amazon_search_market 时不得只投影 7 个", async () => {
    const { service } = makeService({ items: 3 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 3, authorizedItemLimit: 3 });
    const run = await service.getRun(batchId);
    expect(run?.allowedModules).toHaveLength(7);
    expect(run?.allowedModules).not.toContain("amazon_search_market");
    const modules = run?.moduleOutcomes.map((o) => o.module) ?? [];
    expect(modules).toHaveLength(8);
    expect(modules).toContain("amazon_search_market");
    const search = run?.moduleOutcomes.find((o) => o.module === "amazon_search_market");
    expect(search?.itemsTotal).toBe(3);
    expect(search?.handling).toBe("done");
  });

  it("导航预算上限与计划同口径：30 件 = 30×4+计划搜索页1 = 121，不得出现 122", async () => {
    const { service } = makeService({ items: 30 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 5, authorizedItemLimit: 30 });
    const run = await service.getRun(batchId);
    expect(run?.navigationBudget.limit).toBe(121);
    expect(run?.navigationBudget.used).toBeGreaterThanOrEqual(0);
    expect(run?.navigationBudget.limit).toBeGreaterThanOrEqual(
      (run?.navigationBudget.used ?? 0) + (run?.navigationBudget.reserved ?? 0),
    );
  });

  it("projectBatchCaptureRunSearchEvidence：回执缺 evidenceId 时只读回绑，不伪造其他模块", async () => {
    const { service } = makeService({ items: 2 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 2, authorizedItemLimit: 2 });
    const run = await service.getRun(batchId);
    if (!run) throw new Error("run_missing");
    const searchCells = run.cells.filter((c) => c.module === "amazon_search_market");
    const missing = searchCells.filter((c) => !c.evidenceId);
    const byAsin = new Map(missing.map((c) => [c.asin, `ev-bind-${c.asin}`]));
    const projected = projectBatchCaptureRunSearchEvidence(run, byAsin);
    const after = projected.cells.filter((c) => c.module === "amazon_search_market");
    expect(after.every((c) => c.evidenceId)).toBe(true);
    const searchOutcome = projected.moduleOutcomes.find((o) => o.module === "amazon_search_market");
    expect(searchOutcome?.validEvidenceCount).toBe(2);
    // 非搜索模块不被改动
    const detailBefore = run.cells.filter((c) => c.module === "amazon_detail");
    const detailAfter = projected.cells.filter((c) => c.module === "amazon_detail");
    expect(detailAfter).toEqual(detailBefore);
  });

  it("research consumable requires verified source + complete fields + downstream contract", () => {
    expect(isResearchConsumable({ status: "succeeded", sourceVerified: true, fieldComplete: true, module: "amazon_detail" })).toBe(true);
    expect(isResearchConsumable({ status: "succeeded", sourceVerified: false, fieldComplete: true, module: "amazon_detail" })).toBe(false);
    expect(isResearchConsumable({ status: "partial", sourceVerified: true, fieldComplete: false, module: "amazon_detail" })).toBe(false);
    expect(isResearchConsumable({ status: "succeeded", sourceVerified: true, fieldComplete: true, module: "amazon_search_market" })).toBe(false);
  });
});

describe("batch capture expansion control lease", () => {
  it("blocks expansion while the Run is active and blocks resume while expansion is reserved", async () => {
    const activeFixture = makeService({ items: 2 });
    await activeFixture.service.start({
      context: owner,
      batchId,
      maxItemsPerAdvance: 2,
      authorizedItemLimit: 2,
      allowedModules: ["amazon_detail"],
    });
    await activeFixture.service.control({ context: owner, batchId, action: "resume" });
    await expect(activeFixture.service.reserveExpansion({
      context: owner,
      batchId,
      authorizationId: "auth_expansion_active01",
    })).rejects.toMatchObject({ code: "BATCH_CAPTURE_RUN_STILL_ACTIVE" });

    const humanFixture = makeService({ items: 2, mode: "human" });
    const initial = await humanFixture.service.start({
      context: owner,
      batchId,
      maxItemsPerAdvance: 2,
      authorizedItemLimit: 2,
      allowedModules: ["amazon_detail"],
    });
    const human = await humanFixture.service.advance({ context: owner, batchId, env: envOn, maxItemsPerAdvance: 2 });
    expect(human.status).toBe("HUMAN_REQUIRED");
    const oldCells = human.cells.map((cell) => ({ ...cell }));
    await humanFixture.service.reserveExpansion({
      context: owner,
      batchId,
      authorizationId: "auth_expansion_human01",
    });
    await expect(humanFixture.service.control({ context: owner, batchId, action: "resume" }))
      .rejects.toMatchObject({ code: "BATCH_CAPTURE_EXPANSION_BUSY" });

    humanFixture.store.getBatchItems.mockResolvedValue([
      ...baseItems(2),
      { id: "item-2", asin: "B000000003", archivedAt: null },
    ]);
    const expansion = await humanFixture.service.startExpansion({
      context: owner,
      batchId,
      authorizationId: "auth_expansion_human01",
      targetTotal: 3,
      authorizedSearchItemLimit: 1,
      previousSearchNavigationUsed: 1,
      expansionSearchNavigationUsed: 1,
      newlyCapturedAsins: ["B000000003"],
      searchEvidence: [{ asin: "B000000003", evidenceRef: "search-evidence-3" }],
    });

    expect(expansion.created).toBe(true);
    expect(expansion.run.runId).not.toBe(initial.run.runId);
    expect(expansion.run.runGeneration).toBe(initial.run.runGeneration + 1);
    expect(expansion.run.status).toBe("HUMAN_REQUIRED");
    expect(expansion.run.authorizedItemLimit).toBe(3);
    expect(expansion.run.cells.slice(0, oldCells.length)).toEqual(oldCells);
    expect(expansion.run.cells.filter((cell) => cell.asin === "B000000003"))
      .toMatchObject([
        { module: "amazon_search_market", status: "succeeded", evidenceId: "search-evidence-3", sourceVerified: true },
        { module: "amazon_detail", status: "pending" },
      ]);
    expect(expansion.run.authorizationLedger?.at(-1)).toMatchObject({
      kind: "expansion",
      authorizationId: "auth_expansion_human01",
      targetTotal: 3,
      authorizedSearchItemLimit: 1,
      authorizedAsins: ["B000000003"],
      newlySearchedItemCount: 1,
      searchNavigationUsed: 1,
    });
    const archived = humanFixture.database.rows.find((row) => row.id === initial.run.runId);
    const archivedRun = JSON.parse(archived!.responseJson as string) as BatchCaptureRun;
    expect(archivedRun.authorizedItemLimit).toBe(2);
    expect(archivedRun.cells).toEqual(oldCells);
    expect(archivedRun.expansionLock).toBeNull();
  });

  it("refuses an expansion generation that would exceed the cumulative ten-page search cap", async () => {
    const fixture = makeService({ items: 1, mode: "succeed" });
    await fixture.service.start({
      context: owner,
      batchId,
      authorizedItemLimit: 1,
      allowedModules: ["amazon_detail"],
    });
    await fixture.service.advance({ context: owner, batchId, env: envOn, maxItemsPerAdvance: 1 });
    await fixture.service.reserveExpansion({
      context: owner,
      batchId,
      authorizationId: "auth_expansion_pagecap1",
    });
    fixture.store.getBatchItems.mockResolvedValue([
      ...baseItems(1),
      { id: "item-1", asin: "B000000002", archivedAt: null },
    ]);

    await expect(fixture.service.startExpansion({
      context: owner,
      batchId,
      authorizationId: "auth_expansion_pagecap1",
      targetTotal: 2,
      authorizedSearchItemLimit: 1,
      previousSearchNavigationUsed: 10,
      expansionSearchNavigationUsed: 1,
      newlyCapturedAsins: ["B000000002"],
      searchEvidence: [{ asin: "B000000002", evidenceRef: "search-evidence-2" }],
    })).rejects.toMatchObject({ code: "CAPTURE_EXPANSION_SEARCH_BUDGET_EXCEEDED" });
  });
});

describe("D2-1H: human units dominate run status; resume re-checks before running", () => {
  const MODULES = ["amazon_detail", "variation", "review_voc"];

  function unit(asin: string, module: string, status: BatchCaptureCell["status"], lastErrorCode: string | null = null): BatchCaptureCell {
    return {
      asin, module, status, attempts: 1, evidenceId: null, lastErrorCode,
      updatedAt: new Date(BASE).toISOString(),
      sourceVerified: false, fieldComplete: false, researchConsumable: false,
    };
  }

  it("derive: blocked_human forces HUMAN_REQUIRED even with pending units remaining (0fc13639 shape)", () => {
    const cells: BatchCaptureCell[] = [];
    for (const asin of ["B000000001", "B000000002", "B000000003"]) {
      cells.push(unit(asin, "amazon_detail", "succeeded"));
      cells.push(unit(asin, "variation", "succeeded"));
      cells.push(unit(asin, "review_voc", "blocked_human", "CAPTCHA_DETECTED"));
    }
    for (const asin of ["B000000004", "B000000005"]) {
      cells.push(unit(asin, "review_voc", "pending"));
    }
    expect(deriveBatchCaptureRunStatus({ modules: MODULES, cells })).toBe("HUMAN_REQUIRED");
  });

  it("derive: pending-only after first visit stays RUNNING; unvisited stays WAITING", () => {
    const visited: BatchCaptureCell[] = [unit("B000000001", "amazon_detail", "succeeded"), unit("B000000001", "review_voc", "pending")];
    expect(deriveBatchCaptureRunStatus({ modules: MODULES, cells: visited })).toBe("RUNNING");
    const fresh: BatchCaptureCell[] = [unit("B000000001", "review_voc", "pending")];
    expect(deriveBatchCaptureRunStatus({ modules: MODULES, cells: fresh })).toBe("WAITING");
  });

  it("resume: blocked_human → BATCH_CAPTURE_HUMAN_REQUIRED, stuck status self-heals to HUMAN_REQUIRED", async () => {
    const { service, database } = makeService({ items: 2, mode: "human" });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 2, authorizedItemLimit: 2 });
    await service.advance({ context: owner, batchId, maxItemsPerAdvance: 2, env: envOn });

    // 复刻正式 run 0fc13639 的历史坏状态：cells 有 blocked_human，但 persisted status=RUNNING
    const row = database.rows.find((entry) => entry.resourceKey === batchId);
    expect(row).toBeDefined();
    const persisted = JSON.parse(row!.responseJson as string) as BatchCaptureRun;
    row!.status = "RUNNING";
    row!.responseJson = JSON.stringify({ ...persisted, status: "RUNNING" });

    await expect(service.control({ context: owner, batchId, action: "resume" }))
      .rejects.toMatchObject({ code: "BATCH_CAPTURE_HUMAN_REQUIRED" });

    const healed = await service.getRun(batchId);
    expect(healed?.status).toBe("HUMAN_REQUIRED");
    expect(healed?.lastMessage).toContain("重新校准");
    expect(healed?.cells.filter((cell) => cell.status === "blocked_human").length).toBeGreaterThan(0);
  });

  it("resume: without human units proceeds to RUNNING with re-drive notice", async () => {
    const { service } = makeService({ items: 2 });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 2, authorizedItemLimit: 2 });
    await service.control({ context: owner, batchId, action: "pause" });
    const resumed = await service.control({ context: owner, batchId, action: "resume" });
    expect(resumed.status).toBe("RUNNING");
    expect(resumed.lastMessage).toContain("执行器将重新检查");
  });

  it("resume: human units + login env still blocked → 拒绝并说明真实原因，人工单元不被重置", async () => {
    const { service, database, calls } = makeService({
      items: 2,
      mode: "human",
      sessionReadiness: async () => ({
        ok: false,
        sessionReady: false,
        message: "网络预检未通过：当前出口非美国（CN）。",
        errorCode: "NON_US_EXIT",
      }),
    });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 2, authorizedItemLimit: 2 });
    await service.advance({ context: owner, batchId, maxItemsPerAdvance: 2, env: envOn });

    const row = database.rows.find((entry) => entry.resourceKey === batchId);
    const persisted = JSON.parse(row!.responseJson as string) as BatchCaptureRun;
    row!.status = "RUNNING";
    row!.responseJson = JSON.stringify({ ...persisted, status: "RUNNING" });

    await expect(service.control({ context: owner, batchId, action: "resume" }))
      .rejects.toThrow(/出口非美国/);
    const after = await service.getRun(batchId);
    expect(after?.status).toBe("HUMAN_REQUIRED");
    expect(after?.lastMessage).toContain("重新校准");
    expect(calls.map((call) => call.module)).toEqual(["amazon_detail"]);
    expect(after?.cells.filter((cell) => cell.status === "blocked_human").length).toBe(2);
    expect(after?.cells.filter((cell) => cell.status === "pending").length).toBe(4);
  });

  it("resume: human units + login env recovered → 合法重置人工单元并继续，已完成单元不动", async () => {
    const { service, database, calls } = makeService({
      items: 2,
      sessionReadiness: async () => ({ ok: true, sessionReady: true }),
    });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 2, authorizedItemLimit: 2 });
    await service.advance({ context: owner, batchId, maxItemsPerAdvance: 2, env: envOn });

    // 复刻人工门槛：仅 review_voc 单元被标记 blocked_human，其余 succeeded
    const row = database.rows.find((entry) => entry.resourceKey === batchId);
    const persisted = JSON.parse(row!.responseJson as string) as BatchCaptureRun;
    row!.status = "RUNNING";
    row!.responseJson = JSON.stringify({
      ...persisted,
      status: "RUNNING",
      cells: persisted.cells.map((cell) => cell.module === "review_voc"
        ? { ...cell, status: "blocked_human", lastErrorCode: "HUMAN_GATE_PAUSE" }
        : cell),
    } as BatchCaptureRun);

    const resumed = await service.control({ context: owner, batchId, action: "resume" });
    expect(resumed.status).toBe("RUNNING");
    expect(resumed.lastMessage).toContain("登录环境已恢复");
    const reviewCells = resumed.cells.filter((cell) => cell.module === "review_voc");
    expect(reviewCells.every((cell) => cell.status === "pending")).toBe(true);
    expect(reviewCells.every((cell) => cell.lastErrorCode === null)).toBe(true);
    const detail = resumed.cells.filter((cell) => cell.module === "amazon_detail");
    expect(detail.every((cell) => cell.status === "succeeded")).toBe(true);
    expect(detail.every((cell) => typeof cell.evidenceId === "string" && cell.evidenceId.length > 0)).toBe(true);

    // 恢复驱动只推进剩余单元，不重复采集已完成模块
    const driven = await service.drive({ context: owner, batchId, env: envOn, maxSlices: 10 });
    expect(driven.cells.filter((cell) => cell.module === "review_voc").every((cell) => cell.status === "succeeded")).toBe(true);
    const reviewCalls = calls.filter((entry) => entry.module === "review_voc");
    expect(reviewCalls.length).toBeGreaterThan(0);
    expect(reviewCalls.every((entry) => entry.targetAsins.length === 2)).toBe(true);
    const detailCalls = calls.filter((entry) => entry.module === "amazon_detail");
    expect(detailCalls.every((entry) => entry.targetAsins.length === 0 || entry.targetAsins.length === 2)).toBe(true);
  });

  it("getRun: 执行器已退出的卡死 RUNNING 会被自愈并落库（不再留下 RUNNING+无执行器）", async () => {
    const { service, database } = makeService({ items: 2, mode: "human" });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 2, authorizedItemLimit: 2 });
    await service.advance({ context: owner, batchId, maxItemsPerAdvance: 2, env: envOn });

    // 复刻历史坏状态：cells 有 blocked_human，但 persisted status=RUNNING，且执行器已退出
    const row = database.rows.find((entry) => entry.resourceKey === batchId);
    const persisted = JSON.parse(row!.responseJson as string) as BatchCaptureRun;
    row!.status = "RUNNING";
    row!.responseJson = JSON.stringify({
      ...persisted,
      status: "RUNNING",
      leaseOwner: null,
      leaseExpiresAt: null,
      executionEpoch: persisted.acknowledgedEpoch,
    });

    const healed = await service.getRun(batchId);
    expect(healed?.status).toBe("HUMAN_REQUIRED");
    expect(healed?.lastMessage).toContain("执行器已退出");
    expect(healed?.version).toBe(persisted.version + 1);

    // 关键：状态已落库，避免「读取显示 PARTIAL、写入仍是 RUNNING」的读写不一致
    const persistedNow = JSON.parse(row!.responseJson as string) as BatchCaptureRun;
    expect(persistedNow.status).toBe("HUMAN_REQUIRED");
    expect(persistedNow.version).toBe(healed?.version);

    // 幂等：再读一次不再产生新写入
    const again = await service.getRun(batchId);
    expect(again?.status).toBe("HUMAN_REQUIRED");
    expect(again?.version).toBe(healed?.version);
  });

  it("getRun: 仍持有有效租约时只投影不写库（活跃执行器不会被误判为已退出）", async () => {
    const { service, database } = makeService({ items: 2, mode: "human" });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 2, authorizedItemLimit: 2 });
    await service.advance({ context: owner, batchId, maxItemsPerAdvance: 2, env: envOn });

    const row = database.rows.find((entry) => entry.resourceKey === batchId);
    const persisted = JSON.parse(row!.responseJson as string) as BatchCaptureRun;
    row!.status = "RUNNING";
    row!.responseJson = JSON.stringify({
      ...persisted,
      status: "RUNNING",
      leaseOwner: "drive-live",
      leaseExpiresAt: new Date(Date.parse("2026-10-12T12:00:00.000Z") + 120_000).toISOString(),
      executionEpoch: persisted.acknowledgedEpoch + 1,
      acknowledgedEpoch: persisted.acknowledgedEpoch,
    });

    const projected = await service.getRun(batchId);
    expect(projected?.status).toBe("HUMAN_REQUIRED");
    expect(projected?.lastMessage).toContain("本次读取未改写任务记录");

    const onDisk = JSON.parse(row!.responseJson as string) as BatchCaptureRun;
    expect(onDisk.status).toBe("RUNNING");
    expect(onDisk.version).toBe(persisted.version);
  });

  it("getRun: CANCELLED is never overwritten by read-path self-heal", async () => {
    const { service } = makeService({ items: 2, mode: "human" });
    await service.start({ context: owner, batchId, maxItemsPerAdvance: 2, authorizedItemLimit: 2 });
    await service.advance({ context: owner, batchId, maxItemsPerAdvance: 2, env: envOn });
    await service.control({ context: owner, batchId, action: "cancel" });

    const cancelled = await service.getRun(batchId);
    expect(cancelled?.status).toBe("CANCELLED");
    expect(cancelled?.cells.filter((cell) => cell.status === "blocked_human").length).toBeGreaterThan(0);
    // 再读一次：中止态绝不被读路径推成 HUMAN_REQUIRED / RUNNING
    const again = await service.getRun(batchId);
    expect(again?.status).toBe("CANCELLED");
    expect(again?.version).toBe(cancelled?.version);
  });
});
