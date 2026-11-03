import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACTIVE_PRODUCTION_MARKET_SCREENING_REGISTRATION_ID,
} from "@/lib/marketScreeningProductionRegistry";
import {
  ProductBatchRepositoryError,
  createProductBatchRepository,
} from "@/lib/server/productBatchRepository";


import { replayAllCheckedInMigrations } from "@/lib/marketScan/__fixtures__/migrationReplay";

const HASH = "a".repeat(64);

let testRoot: string;
let client: PrismaClient;
let repository: ReturnType<typeof createProductBatchRepository>;

function createInput() {
  return {
    batchName: "Closet organizers",
    marketplace: "US",
    currency: "USD",
    reportType: "search_results" as const,
    query: "closet organizer",
    category: null,
    priceMinCents: 1500,
    priceMaxCents: 4500,
    briefHash: HASH,
    sourceFileName: "seller-sprite.xlsx",
    sourceFileSha256: "b".repeat(64),
    sellerSpriteDisclaimerVersion: "sellersprite-v1-frozen.2026-07-27",
  };
}

function readyInput(acceptedCount = 2) {
  return {
    normalizedBusinessHash: "c".repeat(64),
    snapshotHash: "d".repeat(64),
    manifestHash: "e".repeat(64),
    itemCount: acceptedCount,
    acceptedCount,
    quarantinedCount: 0,
    dataQualityStatus: "passed" as const,
    importedAt: new Date("2026-07-28T00:00:00.000Z"),
    sellerSpriteDisclaimerVersion: "sellersprite-v1-frozen.2026-07-27",
    normalizedSnapshotJson: JSON.stringify({
      schemaVersion: "sellersprite-market-snapshot.v3",
    }),
    manifestJson: JSON.stringify({
      schemaVersion: "sellersprite-local-preview-manifest.v3",
    }),
    qualitySummaryJson: "{}",
    errorJson: null,
  };
}

function items() {
  return [
    {
      productKey: "asin:B000000001",
      ordinal: 0,
      asin: "B000000001",
      parentAsin: null,
      itemIdentityHash: "1".repeat(64),
      itemHash: "2".repeat(64),
      evidenceHash: "3".repeat(64),
      normalizedProductJson: '{"name":"Item 1"}',
      occurrenceProjectionJson: "{}",
      familyProjectionJson: "{}",
      rankingJson: "{}",
      provisionalDisposition: "provisional_score_only" as const,
      researchPriority: "priority_1" as const,
      evidenceStatus: "sufficient_for_comparison" as const,
      promotionEligible: false as const,
      imageSnapshotJson: '{"status":"not_cached"}',
    },
    {
      productKey: "asin:B000000002",
      ordinal: 1,
      asin: "B000000002",
      parentAsin: null,
      itemIdentityHash: "4".repeat(64),
      itemHash: "5".repeat(64),
      evidenceHash: "6".repeat(64),
      normalizedProductJson: '{"name":"Item 2"}',
      occurrenceProjectionJson: "{}",
      familyProjectionJson: "{}",
      rankingJson: "{}",
      provisionalDisposition: "insufficient_required_signals" as const,
      researchPriority: "unranked_insufficient_evidence" as const,
      evidenceStatus: "insufficient_evidence" as const,
      promotionEligible: false as const,
      imageSnapshotJson: '{"status":"not_cached"}',
    },
  ];
}

async function createReadyBatch() {
  const created = await repository.createProcessingBatch(createInput());
  await repository.replaceOrInsertBatchItemsDuringProcessing(created.batch.id, items());
  return repository.markBatchReady(created.batch.id, readyInput());
}

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "product-batch-repository-"));
  const databasePath = join(testRoot, "test.db");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  replayAllCheckedInMigrations(database);
  database.close();
  client = new PrismaClient({
    datasources: {
      db: { url: `file:${databasePath.replaceAll("\\", "/")}` },
    },
  });
  repository = createProductBatchRepository(client);
});

afterEach(async () => {
  await client.$disconnect();
  rmSync(testRoot, { recursive: true, force: true });
});

describe("ProductBatch repository Owner boundary", () => {
  it("always writes the fixed server Owner even when an extra client field is supplied", async () => {
    const untrustedInput = {
      ...createInput(),
      ownerSubject: "owner:other",
    };
    const result = await repository.createProcessingBatch(untrustedInput);
    expect(result.batch.ownerSubject).toBe("owner:v1");
  });

  it("hides another Owner's batch from get and list", async () => {
    await client.$executeRawUnsafe(`
      INSERT INTO "ProductBatch" (
        "id", "ownerSubject", "batchName", "marketplace", "currency",
        "reportType", "briefHash", "sourceFileName", "sourceFileSha256",
        "qualitySummaryJson", "dedupeKey"
      ) VALUES (
        'other-batch', 'owner:other', 'Other', 'US', 'USD',
        'search_results', '${HASH}', 'other.xlsx', '${HASH}', '{}', 'other'
      )
    `);

    expect(await repository.getBatchByIdForOwner("other-batch")).toBeNull();
    expect(await repository.listBatchesForOwner()).toEqual([]);
  });
});

describe("Amazon Search batch additive expansion", () => {
  it("appends only new ASIN rows, preserves old evidence rows, and deduplicates repeated ASINs", async () => {
    const created = await repository.createProcessingBatch({
      ...createInput(),
      sourceFileName: "amazon-search-capture.json",
    });
    const existingItems = items();
    await repository.replaceOrInsertBatchItemsDuringProcessing(created.batch.id, existingItems);
    const ready = await repository.markBatchReady(created.batch.id, {
      ...readyInput(2),
      normalizedSnapshotJson: JSON.stringify({
        schemaVersion: "amazon-search-capture-snapshot.v1",
        sourceType: "amazon_search_capture",
        evidenceReferences: [{ evidenceId: "old-evidence" }],
      }),
      manifestJson: JSON.stringify({
        schemaVersion: "amazon-search-capture-manifest.v1",
        sourceType: "amazon_search_capture",
        evidenceReferences: [{ evidenceId: "old-evidence" }],
      }),
    });
    const oldRows = await repository.getBatchItemsForOwner(ready.id);
    const added = {
      ...existingItems[0]!,
      productKey: "amazon:US:B000000003",
      asin: "B000000003",
      ordinal: 2,
      itemIdentityHash: "7".repeat(64),
      itemHash: "8".repeat(64),
      evidenceHash: "9".repeat(64),
      normalizedProductJson: JSON.stringify({ asin: "B000000003", evidenceId: "new-evidence" }),
    };
    const extensionMetadata = {
      ...readyInput(3),
      sourceFileSha256: "f".repeat(64),
      normalizedSnapshotJson: JSON.stringify({
        schemaVersion: "amazon-search-capture-snapshot.v1",
        sourceType: "amazon_search_capture",
        evidenceReferences: [{ evidenceId: "old-evidence" }],
        extensions: [{ authorizationId: "auth_0123456789ab", evidenceReferences: [{ evidenceId: "new-evidence" }] }],
      }),
      manifestJson: JSON.stringify({
        schemaVersion: "amazon-search-capture-manifest.v1",
        sourceType: "amazon_search_capture",
        evidenceReferences: [{ evidenceId: "old-evidence" }],
        extensions: [{ authorizationId: "auth_0123456789ab", evidenceReferences: [{ evidenceId: "new-evidence" }] }],
      }),
      qualitySummaryJson: JSON.stringify({ searchNavigationUsed: 2 }),
      expectedUpdatedAt: ready.updatedAt,
    };

    const first = await repository.appendItemsToReadyBatch(ready.id, [added], extensionMetadata);
    expect(first.insertedCount).toBe(1);
    expect(first.duplicateCount).toBe(0);
    expect(first.batch.itemCount).toBe(3);
    const afterFirst = await repository.getBatchItemsForOwner(ready.id);
    expect(afterFirst.slice(0, 2).map(({ id, normalizedProductJson, evidenceHash }) => ({ id, normalizedProductJson, evidenceHash })))
      .toEqual(oldRows.map(({ id, normalizedProductJson, evidenceHash }) => ({ id, normalizedProductJson, evidenceHash })));
    expect(afterFirst[2]?.asin).toBe("B000000003");

    const second = await repository.appendItemsToReadyBatch(ready.id, [added], {
      ...extensionMetadata,
      expectedUpdatedAt: first.batch.updatedAt,
    });
    expect(second.insertedCount).toBe(0);
    expect(second.duplicateCount).toBe(1);
    expect((await repository.getBatchItemsForOwner(ready.id))).toHaveLength(3);
  });
});

describe("ProductBatch repository state and items", () => {
  it("persists items only during processing and freezes ready snapshots", async () => {
    const ready = await createReadyBatch();
    expect(ready.batchStatus).toBe("ready");
    await expect(repository.replaceOrInsertBatchItemsDuringProcessing(
      ready.id,
      items(),
    )).rejects.toBeInstanceOf(ProductBatchRepositoryError);
    await expect(repository.markBatchBlocked(ready.id, {
      errorJson: '{"code":"late"}',
      qualitySummaryJson: "{}",
    })).rejects.toBeInstanceOf(ProductBatchRepositoryError);
  });

  it("marks a processing batch blocked but will not archive it", async () => {
    const created = await repository.createProcessingBatch(createInput());
    const blocked = await repository.markBatchBlocked(created.batch.id, {
      errorJson: '{"code":"invalid_rows"}',
      qualitySummaryJson: '{"quarantined":1}',
    });
    expect(blocked.batchStatus).toBe("blocked");
    await expect(repository.archiveBatch(blocked.id))
      .rejects.toBeInstanceOf(ProductBatchRepositoryError);
  });

  it("reads persisted items and retries only a blocked batch", async () => {
    const created = await repository.createProcessingBatch(createInput());
    await repository.replaceOrInsertBatchItemsDuringProcessing(created.batch.id, items());
    expect(await repository.getBatchItemsForOwner(created.batch.id)).toHaveLength(2);
    const blocked = await repository.markBatchBlocked(created.batch.id, {
      errorJson: '{"code":"invalid_rows"}',
      qualitySummaryJson: '{"quarantined":1}',
    });
    const retried = await repository.retryBlockedBatch(blocked.id);
    expect(retried).toMatchObject({
      batchStatus: "processing",
      dataQualityStatus: "pending",
      errorJson: null,
    });
    await expect(repository.retryBlockedBatch(retried.id))
      .rejects.toBeInstanceOf(ProductBatchRepositoryError);
  });

  it("switches active Batch and legacy registration transactionally, then archives ready", async () => {
    const ready = await createReadyBatch();
    const activeBatch = await repository.setActiveBatch(ready.id);
    expect(activeBatch).toMatchObject({
      activeProductBatchId: ready.id,
      activeLegacyRegistrationId: null,
    });
    const legacy = await repository.setActiveLegacyRegistration(
      ACTIVE_PRODUCTION_MARKET_SCREENING_REGISTRATION_ID,
    );
    expect(legacy).toMatchObject({
      activeProductBatchId: null,
      activeLegacyRegistrationId: ACTIVE_PRODUCTION_MARKET_SCREENING_REGISTRATION_ID,
    });
    const archived = await repository.archiveBatch(ready.id);
    expect(archived.batchStatus).toBe("ready");
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect(await repository.listBatchesForOwner()).toEqual([]);
    await expect(repository.setActiveBatch(ready.id))
      .rejects.toBeInstanceOf(ProductBatchRepositoryError);
  });

  it("fails closed for a legacy registration absent from the frozen registry", async () => {
    await expect(repository.setActiveLegacyRegistration("missing-registration"))
      .rejects.toBeInstanceOf(ProductBatchRepositoryError);
    expect(await repository.getActiveSelection()).toBeNull();
  });

  it("cannot activate blocked or another Owner's batch", async () => {
    const created = await repository.createProcessingBatch(createInput());
    await repository.markBatchBlocked(created.batch.id, {
      errorJson: '{"code":"blocked"}',
      qualitySummaryJson: "{}",
    });
    await expect(repository.setActiveBatch(created.batch.id))
      .rejects.toBeInstanceOf(ProductBatchRepositoryError);
    await expect(repository.setActiveBatch("other-batch"))
      .rejects.toBeInstanceOf(ProductBatchRepositoryError);
  });

  it("deletes the active current batch atomically: clears selection binding, removes items and batch, keeps researched candidates", async () => {
    const ready = await createReadyBatch();
    await repository.setActiveBatch(ready.id);
    // 模拟一个已进入研究池的候选绑定到该批次 item（onDelete: Restrict）
    const itemId = (await repository.getBatchItemsForOwner(ready.id))[0].id;
    await client.$executeRawUnsafe(`
      INSERT INTO "OpportunityCandidate" (
        "id", "name", "rawInput", "link", "score", "source", "keyword",
        "riskLevel", "riskLabel", "summaryLabel", "status",
        "sourceMetaJson", "analysisJson", "convertedTaskId",
        "originProductBatchItemId"
      ) VALUES (
        'cand-researched', 'Researched item', '', NULL, 0, 'SellerSprite', '',
        '', '', '', 'pending', '{}', '{}', NULL,
        '${itemId}'
      )
    `);

    const result = await repository.deleteBatchForOwner(ready.id);
    expect(result).toEqual({ deleted: true });

    // 批次与条目已删除
    expect(await repository.getBatchByIdForOwner(ready.id)).toBeNull();
    expect(await repository.getBatchItemsForOwner(ready.id)).toEqual([]);
    // selection 绑定已解除（删除 selection 行 → 返回 null = 尚未选择）
    expect(await repository.getActiveSelection()).toBeNull();
    // 已进入研究池的候选保留（originProductBatchItemId 解除引用，候选记录仍在）
    const candidate = await client.$queryRawUnsafe(`
      SELECT "id" FROM "OpportunityCandidate" WHERE "id" = 'cand-researched'
    `);
    expect(candidate).toHaveLength(1);
    const candidateRef = await client.$queryRawUnsafe<Array<{ originProductBatchItemId: string | null }>>(`
      SELECT "originProductBatchItemId" FROM "OpportunityCandidate" WHERE "id" = 'cand-researched'
    `);
    expect(candidateRef[0].originProductBatchItemId).toBeNull();
  });
});

describe("ProductBatch repository concurrency", () => {
  it("returns one row for concurrent identical dedupe requests", async () => {
    const results = await Promise.all([
      repository.createProcessingBatch(createInput()),
      repository.createProcessingBatch(createInput()),
      repository.createProcessingBatch(createInput()),
    ]);
    expect(new Set(results.map((result) => result.batch.id)).size).toBe(1);
    const batches = await repository.listBatchesForOwner();
    expect(batches).toHaveLength(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });
});
