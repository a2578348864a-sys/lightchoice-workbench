import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { describeBatchCaptureRun } from "@/lib/sourceLayer/batchCaptureRunPresentation";
import { createBatchCaptureRunService } from "./batchCaptureRunService";
import {
  sellerSpriteKeywordMiningQuerySubjectKey,
  sellerSpriteProductMarketQuerySubjectKey,
  sellerSpriteQueryFingerprint,
} from "./sellerSpriteVisibleQuery";

// 批量 BCR 用例需显式声明运行范围；生产缺省仍为 single_asin_only（只允许单 ASIN）。
process.env.V5_ACQUISITION_SCOPE = "batch_and_single";

const owner = { mode: "owner" as const, token: "" };
const batchId = "batch-capture-product-market";
const asin = "B000000001";
const enabledEnv = { NODE_ENV: "test", LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single", SELLERSPRITE_PRODUCT_MARKET_BCR_ENABLED: "true" } as NodeJS.ProcessEnv;

type ReceiptRow = {
  id: string; actorScope: string; operation: string; resourceKey: string; idempotencyKey: string;
  requestHash: string; status: string; responseJson: string | null; expiresAt: Date | null; createdAt: Date; updatedAt: Date;
};

function fakeDatabase() {
  const rows: ReceiptRow[] = [];
  const keyOf = (row: Pick<ReceiptRow, "actorScope" | "operation" | "resourceKey" | "idempotencyKey">) =>
    `${row.actorScope}|${row.operation}|${row.resourceKey}|${row.idempotencyKey}`;
  return {
    rows,
    v5OperationReceipt: {
      findUnique: async (args: { where: { actorScope_operation_resourceKey_idempotencyKey: ReceiptRow } }) => {
        const key = keyOf(args.where.actorScope_operation_resourceKey_idempotencyKey);
        return rows.find((row) => keyOf(row) === key) ?? null;
      },
      findMany: async (args: { where: Pick<ReceiptRow, "actorScope" | "operation" | "resourceKey"> }) =>
        rows.filter((row) => row.actorScope === args.where.actorScope && row.operation === args.where.operation && row.resourceKey === args.where.resourceKey),
      create: async (args: { data: ReceiptRow }) => {
        rows.push({ ...args.data, updatedAt: new Date(args.data.updatedAt ?? Date.now()) });
        return rows.at(-1) as ReceiptRow;
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Partial<ReceiptRow> }) => {
        const row = rows.find((candidate) => candidate.id === args.where.id
          && candidate.status === args.where.status
          && candidate.responseJson === args.where.responseJson
          && candidate.updatedAt.getTime() === new Date(args.where.updatedAt as string | Date).getTime());
        if (!row) return { count: 0 };
        Object.assign(row, args.data, { updatedAt: new Date() });
        return { count: 1 };
      },
    },
  };
}

function createService(input: {
  preflight?: (args: { context: typeof owner; authorizedAsins: readonly string[] }) => Promise<{
    ready: boolean;
    evidenceByAsin: ReadonlyMap<string, { evidenceId: string; version: number; contentHash: string }>;
    missingAsins: readonly string[];
  }>;
  runProductMarketQuery?: (args: { context: typeof owner; query: { category: string; filters: Record<string, string> }; authorizedAsins: readonly string[] }) => Promise<never>;
  runKeywordMiningQuery?: (args: { context: typeof owner; query: { seedKeyword: string; conditions: Record<string, string> } }) => Promise<never>;
  onWorkerCall?: (module: string, asins: string[]) => void;
  order?: string[];
}) {
  const database = fakeDatabase();
  const batchStore = {
    getBatch: async (id: string) => id === batchId ? { id, batchStatus: "ready", query: "silicone baking mat" } : null,
    getBatchItems: async () => [{ id: "item-01", asin, archivedAt: null, ordinal: 1 }],
  };
  const service = createBatchCaptureRunService({
    database: database as never,
    getProductBatchStore: () => batchStore as never,
    now: () => new Date("2026-10-13T00:00:00.000Z"),
    preflightProductMarket: (async (args: { context: typeof owner; authorizedAsins: readonly string[] }) => {
      input.order?.push("base-evidence-preflight");
      return input.preflight ? input.preflight(args) : { ready: true, evidenceByAsin: new Map(), missingAsins: [] };
    }) as never,
    runProductMarketQuery: (async (args: { context: typeof owner; query: { category: string; filters: Record<string, string> }; authorizedAsins: readonly string[] }) => {
      input.order?.push("sellersprite-query");
      return input.runProductMarketQuery ? input.runProductMarketQuery(args) : ({} as never);
    }) as never,
    runKeywordMiningQuery: (async (args: { context: typeof owner; query: { seedKeyword: string; conditions: Record<string, string> } }) => {
      input.order?.push("keyword-mining-query");
      return input.runKeywordMiningQuery ? input.runKeywordMiningQuery(args) : ({} as never);
    }) as never,
    enrichDetail: (async (args: { targetAsins: unknown }) => {
      input.order?.push("amazon-detail");
      const targetAsins = args.targetAsins as string[];
      input.onWorkerCall?.("amazon_detail", targetAsins);
      return {
        value: { items: targetAsins.map((targetAsin) => ({ asin: targetAsin, status: "succeeded", evidenceId: `amazon-evidence-${targetAsin}` })) },
        replayed: false,
        receiptId: "mock-detail-receipt",
      } as never;
    }) as never,
    onWorkerCall: input.onWorkerCall,
  });
  return { service, database };
}

describe("BatchCaptureRun SellerSprite Product Market query unit", () => {
  it("runs one query-level Mock result without completing any ASIN×module Product Market cell", async () => {
    const calls: Array<{ module: string; asins: string[] }> = [];
    const queryInput = { module: "sellersprite_product_market" as const, category: "Kitchen & Dining", marketplace: "US" as const, filters: {} };
    const querySubjectKey = sellerSpriteProductMarketQuerySubjectKey(queryInput);
    const { service } = createService({
      onWorkerCall: (module, asins) => calls.push({ module, asins }),
      runProductMarketQuery: async () => ({
        status: "captured",
        navigationPerformed: true,
        querySubjectKey,
        evidenceAttachmentId: "v3-market-query-attachment-01",
        evidenceContentHash: "a".repeat(64),
        rowsObserved: 2,
        productAssociations: [{
          asin,
          rowKey: `asin:${createHash("sha256").update(asin).digest("hex")}`,
          rowContentHash: "b".repeat(64),
          baseEvidenceId: "base-evidence-01",
          baseEvidenceVersion: 1,
          baseEvidenceContentHash: "c".repeat(64),
        }],
        errorCode: null,
      } as never),
    });

    const started = await service.start({ context: owner, batchId, allowedModules: ["amazon_detail", "sellersprite_product_market"], authorizedItemLimit: 1 });
    const prepared = await service.prepareProductMarketQuery({ context: owner, batchId, query: { category: "Kitchen & Dining" } });
    expect(prepared.productMarketQueries).toHaveLength(1);
    const queryId = prepared.productMarketQueries[0]?.queryId;
    expect(calls).toHaveLength(0);
    const result = await service.advance({ context: owner, batchId, maxItemsPerAdvance: 1, env: enabledEnv });

    expect(result.productMarketQueries).toMatchObject([{
      querySubjectKey,
      category: "Kitchen & Dining",
      status: "captured",
      evidenceAttachmentId: "v3-market-query-attachment-01",
      evidenceContentHash: "a".repeat(64),
      rowsObserved: 2,
      productAssociations: [{ asin, baseEvidenceId: "base-evidence-01", baseEvidenceVersion: 1 }],
    }]);
    expect(result.cells.find((cell) => cell.module === "sellersprite_product_market" && cell.asin === asin)).toMatchObject({
      status: "source_input_required", evidenceId: null, sourceVerified: false, fieldComplete: false, researchConsumable: false,
    });
    expect(result.navigationBudget).toMatchObject({ used: 2, reserved: 0 });
    const view = describeBatchCaptureRun({ run: result });
    expect(view.productMarketQueries[0]?.status).toBe("captured");
    expect(view.moduleMatrix.find((row) => row.module === "sellersprite_product_market")).toMatchObject({
      wiring: "not_wired", itemsSucceeded: 0, validEvidenceCount: 0, itemsSourceLimited: 1,
    });
    expect(calls.filter((call) => call.module === "sellersprite_product_market")).toHaveLength(1);
    expect(calls.find((call) => call.module === "sellersprite_product_market")?.asins).toEqual([]);

    const sameQuery = await service.prepareProductMarketQuery({ context: owner, batchId, query: { category: "Kitchen & Dining" } });
    expect(sameQuery.productMarketQueries).toHaveLength(1);
    expect(sameQuery.productMarketQueries[0]?.queryId).toBe(queryId);
  });

  it("checks base Evidence before browser workers and blocks the SellerSprite query when it is missing", async () => {
    const order: string[] = [];
    const sellerSprite = vi.fn(async () => ({} as never));
    const { service } = createService({
      order,
      preflight: async () => ({ ready: false, evidenceByAsin: new Map(), missingAsins: [asin] }),
      runProductMarketQuery: sellerSprite as never,
    });
    await service.start({ context: owner, batchId, allowedModules: ["amazon_detail", "sellersprite_product_market"], authorizedItemLimit: 1 });
    await service.prepareProductMarketQuery({ context: owner, batchId, query: { category: "Kitchen" } });
    const result = await service.advance({ context: owner, batchId, maxItemsPerAdvance: 1, env: enabledEnv });

    expect(order[0]).toBe("base-evidence-preflight");
    expect(order).not.toContain("sellersprite-query");
    expect(sellerSprite).not.toHaveBeenCalled();
    expect(result.productMarketQueries[0]).toMatchObject({ status: "blocked", errorCode: "SELLERSPRITE_PRODUCT_MARKET_BASE_EVIDENCE_MISSING" });
    expect(result.cells.find((cell) => cell.module === "sellersprite_product_market" && cell.asin === asin)).toMatchObject({
      status: "source_input_required", evidenceId: null, researchConsumable: false,
    });
  });
});

describe("BatchCaptureRun SellerSprite Keyword Mining query unit", () => {
  it("stores a seedKeyword-level Mock receipt without projecting keyword rows to any ASIN cell", async () => {
    const calls: Array<{ module: string; asins: string[] }> = [];
    const queryInput = { module: "keyword_mining_trend" as const, seedKeyword: "silicone baking mat", marketplace: "US" as const, conditions: {} };
    const querySubjectKey = sellerSpriteKeywordMiningQuerySubjectKey(queryInput);
    const queryFingerprint = sellerSpriteQueryFingerprint(queryInput, "bcr");
    const runKeywordMiningQuery = vi.fn(async () => ({
      status: "captured",
      navigationPerformed: true,
      querySubjectKey,
      queryFingerprint,
      evidenceAttachmentId: "keyword-query-attachment-01",
      evidenceContentHash: "d".repeat(64),
      rowsObserved: 3,
      errorCode: null,
    } as never));
    const { service } = createService({
      onWorkerCall: (module, asins) => calls.push({ module, asins }),
      runKeywordMiningQuery: runKeywordMiningQuery as never,
    });
    await service.start({ context: owner, batchId, allowedModules: ["keyword_mining_trend"], authorizedItemLimit: 1 });
    const prepared = await service.prepareKeywordMiningQuery({ context: owner, batchId, query: { seedKeyword: "silicone baking mat" } });
    const queryId = prepared.keywordMiningQueries[0]?.queryId;
    expect(prepared.keywordMiningQueries[0]).toMatchObject({
      seedKeyword: "silicone baking mat", marketplace: "US", status: "pending", querySubjectKey, queryFingerprint,
    });
    const sameQuery = await service.prepareKeywordMiningQuery({ context: owner, batchId, query: { seedKeyword: " silicone baking mat " } });
    expect(sameQuery.keywordMiningQueries[0]?.queryId).toBe(queryId);

    const result = await service.advance({
      context: owner,
      batchId,
      maxItemsPerAdvance: 1,
      env: { NODE_ENV: "test", LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single", SELLERSPRITE_KEYWORD_MINING_BCR_ENABLED: "true" } as NodeJS.ProcessEnv,
    });
    expect(runKeywordMiningQuery).toHaveBeenCalledWith(expect.objectContaining({
      query: { seedKeyword: "silicone baking mat", conditions: {} },
    }));
    expect(result.keywordMiningQueries).toMatchObject([{
      queryId,
      seedKeyword: "silicone baking mat",
      querySubjectKey,
      queryFingerprint,
      status: "captured",
      evidenceAttachmentId: "keyword-query-attachment-01",
      evidenceContentHash: "d".repeat(64),
      rowsObserved: 3,
    }]);
    expect(result.keywordMiningQueries[0]).not.toHaveProperty("productAssociations");
    expect(result.cells.find((cell) => cell.module === "keyword_mining_trend" && cell.asin === asin)).toMatchObject({
      status: "source_input_required", evidenceId: null, sourceVerified: false, fieldComplete: false, researchConsumable: false,
    });
    expect(result.navigationBudget).toMatchObject({ used: 1, reserved: 0 });
    expect(calls).toEqual([{ module: "keyword_mining_trend", asins: [] }]);
  });

  it("blocks by default before the query worker and leaves the ASIN matrix untouched", async () => {
    const runKeywordMiningQuery = vi.fn();
    const { service } = createService({ runKeywordMiningQuery: runKeywordMiningQuery as never });
    await service.start({ context: owner, batchId, allowedModules: ["keyword_mining_trend"], authorizedItemLimit: 1 });
    await service.prepareKeywordMiningQuery({ context: owner, batchId, query: { seedKeyword: "silicone baking mat" } });
    const result = await service.advance({
      context: owner,
      batchId,
      maxItemsPerAdvance: 1,
      env: { NODE_ENV: "test", LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single" } as NodeJS.ProcessEnv,
    });
    expect(runKeywordMiningQuery).not.toHaveBeenCalled();
    expect(result.keywordMiningQueries[0]).toMatchObject({ status: "blocked", errorCode: "SELLERSPRITE_KEYWORD_MINING_BCR_DISABLED" });
    expect(result.navigationBudget).toMatchObject({ used: 0, reserved: 0 });
    expect(result.cells.find((cell) => cell.module === "keyword_mining_trend" && cell.asin === asin)?.status).toBe("source_input_required");
  });
});
