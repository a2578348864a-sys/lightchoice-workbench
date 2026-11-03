import { describe, expect, it, vi } from "vitest";

import { createBatchCaptureRunService } from "./batchCaptureRunService";
import { sellerSpriteQueryFingerprint } from "./sellerSpriteVisibleQuery";

// 批量 BCR 用例需显式声明运行范围；生产缺省仍为 single_asin_only（只允许单 ASIN）。
process.env.V5_ACQUISITION_SCOPE = "batch_and_single";

const owner = { mode: "owner" as const, token: "" };
const batchId = "batch-reverse-asin-001";
const ASIN = "B000000001";
const BASE = Date.parse("2026-10-13T00:00:00.000Z");
const enabledEnv = { NODE_ENV: "test", LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single", SELLERSPRITE_REVERSE_ASIN_BCR_ENABLED: "true" } as NodeJS.ProcessEnv;

type Row = {
  id: string; actorScope: string; operation: string; resourceKey: string; idempotencyKey: string;
  requestHash: string; status: string; responseJson: string | null; expiresAt: Date | null; createdAt: Date; updatedAt: Date;
};

function fixtureDatabase() {
  const rows: Row[] = [];
  let clock = 0;
  const composite = (row: Pick<Row, "actorScope" | "operation" | "resourceKey" | "idempotencyKey">) =>
    `${row.actorScope}|${row.operation}|${row.resourceKey}|${row.idempotencyKey}`;
  return {
    rows,
    v5OperationReceipt: {
      findUnique: async (args: { where: { actorScope_operation_resourceKey_idempotencyKey: Row } }) => {
        const key = composite(args.where.actorScope_operation_resourceKey_idempotencyKey);
        return rows.find((row) => composite(row) === key) ?? null;
      },
      findMany: async (args: { where: Pick<Row, "actorScope" | "operation" | "resourceKey"> }) => rows.filter((row) =>
        row.actorScope === args.where.actorScope && row.operation === args.where.operation && row.resourceKey === args.where.resourceKey),
      create: async (args: { data: Row }) => {
        const row = { ...args.data, updatedAt: new Date(BASE + (++clock)) };
        rows.push(row);
        return row;
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const row = rows.find((candidate) => candidate.id === args.where.id
          && candidate.status === args.where.status
          && candidate.responseJson === args.where.responseJson
          && candidate.updatedAt.getTime() === new Date(args.where.updatedAt as string | Date).getTime());
        if (!row) return { count: 0 };
        Object.assign(row, args.data, { updatedAt: new Date(BASE + (++clock)) });
        return { count: 1 };
      },
    },
  };
}

function makeService(input: {
  runReverseAsin?: (args: { targetAsins: string[]; idempotencyKey: string; shouldStop: () => Promise<boolean> }) => Promise<unknown>;
  enrichDetail?: (args: { targetAsins: string[] }) => Promise<unknown>;
  onWorkerCall?: (module: string, asins: string[]) => void;
}) {
  const database = fixtureDatabase();
  const service = createBatchCaptureRunService({
    database: database as never,
    getProductBatchStore: () => ({
      getBatch: async (id: string) => id === batchId ? { id, batchStatus: "ready", query: "silicone baking mat" } : null,
      getBatchItems: async () => [{ id: "item-01", asin: ASIN, archivedAt: null, ordinal: 1 }],
    }) as never,
    now: () => new Date(BASE),
    runReverseAsin: input.runReverseAsin as never,
    enrichDetail: input.enrichDetail as never,
    onWorkerCall: input.onWorkerCall,
  });
  return { service, database };
}

function verifiedItem(asin = ASIN) {
  const queryInput = { module: "reverse_asin" as const, targetAsin: asin, marketplace: "US" as const };
  return {
    asin,
    status: "captured_partial",
    evidenceId: `attachment-${asin}`,
    sourceEvidenceRef: {
      subjectKey: `amazon:US:${asin}`,
      baseEvidenceId: `base-${asin}`,
      baseEvidenceVersion: 1,
      baseEvidenceContentHash: "a".repeat(64),
      attachmentId: `attachment-${asin}`,
      attachmentContentHash: "b".repeat(64),
      module: "reverse_asin",
      sourceType: "sellersprite_plugin",
      queryFingerprint: sellerSpriteQueryFingerprint(queryInput, "bcr"),
      captureJobFingerprint: "c".repeat(64),
    },
  };
}

describe("BatchCaptureRun Reverse ASIN Mock integration", () => {
  it("dispatches one authorized ASIN, verifies the source reference, and keeps partial evidence non-consumable", async () => {
    const calls: Array<{ module: string; asins: string[]; idempotencyKey: string }> = [];
    const runReverseAsin = vi.fn(async (args: { targetAsins: string[]; idempotencyKey: string }) => {
      calls.push({ module: "reverse_asin", asins: [...args.targetAsins], idempotencyKey: args.idempotencyKey });
      return { value: { items: args.targetAsins.map((asin) => verifiedItem(asin)) }, replayed: false, receiptId: args.idempotencyKey };
    });
    const { service } = makeService({ runReverseAsin, onWorkerCall: (module, asins) => calls.push({ module, asins, idempotencyKey: "" }) });
    await service.start({ context: owner, batchId, allowedModules: ["reverse_asin"], authorizedItemLimit: 1 });

    const run = await service.advance({ context: owner, batchId, maxItemsPerAdvance: 1, env: enabledEnv, idempotencyKey: "same-advance-request" });
    const cell = run.cells.find((entry) => entry.module === "reverse_asin" && entry.asin === ASIN);
    expect(runReverseAsin).toHaveBeenCalledTimes(1);
    expect(runReverseAsin.mock.calls[0]?.[0].targetAsins).toEqual([ASIN]);
    expect(runReverseAsin.mock.calls[0]?.[0].idempotencyKey).toBe("same-advance-request:reverse_asin");
    expect(cell).toMatchObject({
      status: "partial",
      evidenceId: `attachment-${ASIN}`,
      sourceVerified: true,
      fieldComplete: false,
      researchConsumable: false,
    });
    expect(run.navigationBudget).toMatchObject({ used: 1, reserved: 0 });

    const replay = await service.advance({ context: owner, batchId, maxItemsPerAdvance: 1, env: enabledEnv, idempotencyKey: "same-advance-request" });
    expect(runReverseAsin).toHaveBeenCalledTimes(1);
    expect(replay.cells.find((entry) => entry.module === "reverse_asin" && entry.asin === ASIN)?.attempts).toBe(1);
  });

  it("keeps reverse execution disabled by default and reserves no navigation", async () => {
    const runReverseAsin = vi.fn();
    const { service } = makeService({ runReverseAsin });
    await service.start({ context: owner, batchId, allowedModules: ["reverse_asin"], authorizedItemLimit: 1 });
    const run = await service.advance({
      context: owner,
      batchId,
      maxItemsPerAdvance: 1,
      env: { NODE_ENV: "test", LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single" } as NodeJS.ProcessEnv,
    });
    expect(runReverseAsin).not.toHaveBeenCalled();
    expect(run.cells.find((entry) => entry.module === "reverse_asin" && entry.asin === ASIN)).toMatchObject({
      status: "source_input_required",
      lastErrorCode: "SELLERSPRITE_REVERSE_ASIN_BCR_DISABLED",
      sourceVerified: false,
      researchConsumable: false,
    });
    expect(run.navigationBudget).toMatchObject({ used: 0, reserved: 0 });
  });

  it("does not trust a non-empty evidenceId without the full reverse-ASIN source reference", async () => {
    const runReverseAsin = async (args: { targetAsins: string[] }) => ({
      value: { items: args.targetAsins.map((asin) => ({ asin, status: "captured_partial", evidenceId: "forged-evidence-id" })) },
      replayed: false,
      receiptId: "mock",
    });
    const { service } = makeService({ runReverseAsin });
    await service.start({ context: owner, batchId, allowedModules: ["reverse_asin"], authorizedItemLimit: 1 });
    const run = await service.advance({ context: owner, batchId, maxItemsPerAdvance: 1, env: enabledEnv });
    expect(run.cells.find((entry) => entry.module === "reverse_asin" && entry.asin === ASIN)).toMatchObject({
      status: "failed_permanent",
      evidenceId: "forged-evidence-id",
      sourceVerified: false,
      fieldComplete: false,
      researchConsumable: false,
      lastErrorCode: "SELLERSPRITE_REVERSE_ASIN_EVIDENCE_IDENTITY_INVALID",
    });
  });

  it.each(["SELLERSPRITE_LOGIN_REQUIRED", "SELLERSPRITE_CAPTCHA_REQUIRED", "SELLERSPRITE_STOP_REQUIRED"])(
    "marks the batch HUMAN_REQUIRED for human gate %s even if a worker reports an evidence id",
    async (errorCode) => {
      const runReverseAsin = async (args: { targetAsins: string[] }) => ({
        value: { items: args.targetAsins.map((asin) => ({ asin, status: "failed_human", evidenceId: "blocked-ref", errorCode })) },
        replayed: false,
        receiptId: "mock",
      });
      const { service } = makeService({ runReverseAsin });
      await service.start({ context: owner, batchId, allowedModules: ["reverse_asin"], authorizedItemLimit: 1 });
      const run = await service.advance({ context: owner, batchId, maxItemsPerAdvance: 1, env: enabledEnv });
      expect(run.status).toBe("HUMAN_REQUIRED");
      expect(run.cells.find((entry) => entry.module === "reverse_asin" && entry.asin === ASIN)).toMatchObject({
        status: "blocked_human",
        evidenceId: "blocked-ref",
        sourceVerified: false,
        fieldComplete: false,
        researchConsumable: false,
        lastErrorCode: errorCode,
      });
    },
  );

  it.each(["pause", "cancel"] as const)("stops after a %s request without starting a later module or overwriting it", async (action) => {
    let service: ReturnType<typeof createBatchCaptureRunService>;
    const calls: string[] = [];
    const runReverseAsin = async (args: { shouldStop: () => Promise<boolean> }) => {
      calls.push("reverse_asin");
      await service.control({ context: owner, batchId, action });
      expect(await args.shouldStop()).toBe(true);
      return { value: { items: [] }, replayed: false, receiptId: "mock", stopped: true };
    };
    const detailWorker = vi.fn(async () => { calls.push("amazon_detail"); return { value: { items: [] } }; });
    const created = makeService({ runReverseAsin, enrichDetail: detailWorker });
    service = created.service;
    await service.start({ context: owner, batchId, allowedModules: ["reverse_asin", "amazon_detail"], authorizedItemLimit: 1 });
    const run = await service.advance({ context: owner, batchId, maxItemsPerAdvance: 1, env: enabledEnv });
    expect(calls).toEqual(["reverse_asin"]);
    expect(detailWorker).not.toHaveBeenCalled();
    expect(run.status).toBe(action === "pause" ? "PAUSED" : "CANCELLED");
    if (action === "pause") expect(run.pauseAcknowledgedAt).not.toBeNull();
    expect(run.navigationBudget.reserved).toBe(0);
  });
});
