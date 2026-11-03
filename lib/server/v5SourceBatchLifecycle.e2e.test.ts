import { replayAllCheckedInMigrations } from "@/lib/marketScan/__fixtures__/migrationReplay";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * V5 Source Batch 生命周期真实 SQLite e2e（前端收口轮定向测试）。
 *
 * 目的：钉住本轮补齐的「批次级 归档 / 恢复 / 受控删除 / 批量」能力，确认：
 *   1. canonical 服务实现与前端调用形态一致（expectedVersion / results 结构）；
 *   2. 删除受依赖保护，被引用批次只能归档，且底层不可变证据不受影响；
 *   3. CAS 版本冲突被如实抛出，不被静默吞掉。
 *
 * 隔离方式：用真实 prisma migration SQL 在临时目录建独立 SQLite，
 * 动态 import 服务（避免污染真实 dev.db）。
 */

let root = "";
let databasePath = "";
let prisma: any;
let service: {
  listSourceBatches: (input: unknown) => Promise<{ items: Array<Record<string, unknown>> }>;
  getSourceBatch: (input: unknown) => Promise<Record<string, unknown>>;
  sourceBatchAction: (input: unknown) => Promise<Record<string, unknown>>;
  sourceBulkAction: (input: unknown) => Promise<Record<string, unknown>>;
};

const OWNER_CONTEXT = { mode: "owner", token: "owner_test_token" };

function createMigratedDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), "v5-source-batch-"));
  const file = join(dir, "test.db");
  const db = new DatabaseSync(file);
  replayAllCheckedInMigrations(db);
  db.close();
  return file;
}

async function createBatch(label: string) {
  return prisma.productBatch.create({
    data: {
      ownerSubject: "owner:v1",
      batchName: `批次-${label}`,
      marketplace: "US",
      currency: "USD",
      reportType: "search_results",
      briefHash: `${label}-brief`.padEnd(64, "0"),
      sourceFileName: `${label}.xlsx`,
      sourceFileSha256: `${label}-sha`.padEnd(64, "0"),
      dedupeKey: `dedupe-${label}`,
      itemCount: 1,
      acceptedCount: 1,
      quarantinedCount: 0,
      dataQualityStatus: "pending",
      batchStatus: "processing",
    },
  });
}

async function createItem(batchId: string, ordinal: number, label: string) {
  return prisma.productBatchItem.create({
    data: {
      batchId,
      ordinal,
      productKey: `pk-${label}`,
      asin: `B0${label.toUpperCase()}`.slice(0, 10),
      itemIdentityHash: `identity-${label}`.padEnd(64, "0"),
      itemHash: `item-${label}`.padEnd(64, "0"),
      evidenceHash: `evidence-${label}`.padEnd(64, "0"),
      normalizedProductJson: JSON.stringify({ fieldCoverage: { price: "confirmed" } }),
      occurrenceProjectionJson: "{}",
      familyProjectionJson: "{}",
      rankingJson: "{}",
      provisionalDisposition: "provisional_score_only",
      researchPriority: "priority_1",
      evidenceStatus: "sufficient_for_comparison",
    },
  });
}

function versionOf(batch: { updatedAt: Date }): string {
  return batch.updatedAt.toISOString();
}

beforeAll(async () => {
  databasePath = createMigratedDatabase();
  root = databasePath.replace(/[\\/][^\\/]+$/, "");
  process.env.DATABASE_URL = `file:${databasePath.replaceAll("\\", "/")}`;
  prisma = (await import("@/lib/server/db")).prisma;
  service = (await import("@/lib/server/v5SourceLifecycleService")) as unknown as typeof service;
});

afterAll(async () => {
  await prisma?.$disconnect?.();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("V5 Source Batch 生命周期（canonical 服务）", () => {
  it("listSourceBatches 返回 resourceVersion，供前端 safest 版本号使用", async () => {
    const batch = await createBatch("list");
    const result = await service.listSourceBatches({ context: OWNER_CONTEXT, include: "active" });
    const found = result.items.find((item) => item.id === batch.id);
    expect(found).toBeTruthy();
    expect(typeof found?.resourceVersion).toBe("string");
    expect(typeof found?.updatedAt).toBe("string");
    expect(found?.archivedAt).toBeNull();
  });

  it("批次归档 → 从 active 列表消失；恢复 → 重新出现", async () => {
    const batch = await createBatch("archive");

    const archived = await service.sourceBatchAction({
      context: OWNER_CONTEXT,
      batchId: batch.id,
      action: "archive",
      expectedVersion: versionOf(batch),
      idempotencyKey: `archive-${batch.id}`,
    });
    expect(archived.outcome).toBe("archived");

    const activeList = await service.listSourceBatches({ context: OWNER_CONTEXT, include: "active" });
    expect(activeList.items.some((item) => item.id === batch.id)).toBe(false);
    const archivedList = await service.listSourceBatches({ context: OWNER_CONTEXT, include: "archived" });
    expect(archivedList.items.some((item) => item.id === batch.id)).toBe(true);

    const refreshed = await prisma.productBatch.findUniqueOrThrow({ where: { id: batch.id } });
    const restored = await service.sourceBatchAction({
      context: OWNER_CONTEXT,
      batchId: batch.id,
      action: "restore",
      expectedVersion: versionOf(refreshed),
      idempotencyKey: `restore-${batch.id}`,
    });
    expect(restored.outcome).toBe("restored");

    const reactivated = await service.listSourceBatches({ context: OWNER_CONTEXT, include: "active" });
    expect(reactivated.items.some((item) => item.id === batch.id)).toBe(true);
  });

  it("未归档批次执行恢复 → NOT_ARCHIVED 如实报错", async () => {
    const batch = await createBatch("not-archived");
    await expect(
      service.sourceBatchAction({
        context: OWNER_CONTEXT,
        batchId: batch.id,
        action: "restore",
        expectedVersion: versionOf(batch),
        idempotencyKey: `restore-bad-${batch.id}`,
      })
    ).rejects.toMatchObject({ code: "NOT_ARCHIVED" });
  });

  it("被 discovery selection 引用的批次：删除被保护，只能归档，且错误带真实 dependencySummary", async () => {
    const batch = await createBatch("blocked");
    await createItem(batch.id, 0, "blocked");
    await prisma.productDiscoverySelection.create({
      data: { ownerSubject: "owner:v1", activeProductBatchId: batch.id },
    });

    let caught: unknown = null;
    try {
      await service.sourceBatchAction({
        context: OWNER_CONTEXT,
        batchId: batch.id,
        action: "delete",
        expectedVersion: versionOf(batch),
        idempotencyKey: `delete-blocked-${batch.id}`,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeTruthy();
    const err = caught as { code?: string; details?: { dependencySummary?: { deleteBlockedBy?: string[] } } };
    expect(err.code).toBe("DELETE_DEPENDENCY_BLOCKED");
    expect(err.details?.dependencySummary?.deleteBlockedBy).toContain("active_selection");

    // 仍可归档（dependency blocked → archive fallback）
    const refreshed = await prisma.productBatch.findUniqueOrThrow({ where: { id: batch.id } });
    const archived = await service.sourceBatchAction({
      context: OWNER_CONTEXT,
      batchId: batch.id,
      action: "archive",
      expectedVersion: versionOf(refreshed),
      idempotencyKey: `archive-blocked-${batch.id}`,
    });
    expect(archived.outcome).toBe("archived");

    // 批次行仍在（未被物理删除）
    expect(await prisma.productBatch.findUnique({ where: { id: batch.id } })).toBeTruthy();
    // 清理 selection，避免影响后续用例
    await prisma.productDiscoverySelection.deleteMany({ where: { activeProductBatchId: batch.id } });
  });

  it("无依赖批次：物理删除成功，仅删除本批次商品行（不可变证据不受影响）", async () => {
    const batch = await createBatch("delete-ok");
    await createItem(batch.id, 0, "deleteok1");
    await createItem(batch.id, 1, "deleteok2");

    const survivor = await createBatch("survivor");
    await createItem(survivor.id, 0, "survivor1");

    const result = await service.sourceBatchAction({
      context: OWNER_CONTEXT,
      batchId: batch.id,
      action: "delete",
      expectedVersion: versionOf(batch),
      idempotencyKey: `delete-${batch.id}`,
    });
    expect(result.outcome).toBe("deleted");

    expect(await prisma.productBatch.findUnique({ where: { id: batch.id } })).toBeNull();
    expect(await prisma.productBatchItem.count({ where: { batchId: batch.id } })).toBe(0);
    // 其他批次的商品行不受影响
    expect(await prisma.productBatchItem.count({ where: { batchId: survivor.id } })).toBe(1);
  });

  it("CAS 版本冲突：过期 expectedVersion 被如实拒绝", async () => {
    const batch = await createBatch("cas");
    await expect(
      service.sourceBatchAction({
        context: OWNER_CONTEXT,
        batchId: batch.id,
        action: "archive",
        expectedVersion: "1999-01-01T00:00:00.000Z",
        idempotencyKey: `cas-${batch.id}`,
      })
    ).rejects.toMatchObject({ code: "CAS_CONFLICT" });
  });

  it("批量归档 / 恢复 / 删除：逐项返回 outcome，且部分失败不静默", async () => {
    const a = await createBatch("bulk-a");
    const b = await createBatch("bulk-b");
    const blocked = await createBatch("bulk-blocked");
    await createItem(blocked.id, 0, "bulkblocked");
    await prisma.productDiscoverySelection.create({
      data: { ownerSubject: "owner:v1", activeProductBatchId: blocked.id },
    });

    // 批量归档：三批均成功
    const archiveResult = (await service.sourceBulkAction({
      context: OWNER_CONTEXT,
      resource: "source_batch",
      action: "archive",
      items: [
        { id: a.id, expectedVersion: versionOf(a) },
        { id: b.id, expectedVersion: versionOf(b) },
        { id: blocked.id, expectedVersion: versionOf(blocked) },
      ],
      idempotencyKey: `bulk-archive-${a.id}`,
    })) as { results: Array<{ id: string; outcome: string }>; succeeded: number; failed: number };

    expect(archiveResult.results).toHaveLength(3);
    expect(archiveResult.failed).toBe(0);
    expect(archiveResult.succeeded).toBe(3);
    expect(archiveResult.results.every((row) => row.outcome === "archived")).toBe(true);

    // 批量删除：被引用批次失败，其余成功
    const refreshedA = await prisma.productBatch.findUniqueOrThrow({ where: { id: a.id } });
    const refreshedB = await prisma.productBatch.findUniqueOrThrow({ where: { id: b.id } });
    const refreshedBlocked = await prisma.productBatch.findUniqueOrThrow({ where: { id: blocked.id } });

    const deleteResult = (await service.sourceBulkAction({
      context: OWNER_CONTEXT,
      resource: "source_batch",
      action: "delete",
      items: [
        { id: a.id, expectedVersion: versionOf(refreshedA) },
        { id: blocked.id, expectedVersion: versionOf(refreshedBlocked) },
      ],
      idempotencyKey: `bulk-delete-${a.id}`,
    })) as { results: Array<{ id: string; outcome: string; code?: string | null }>; succeeded: number; failed: number };

    const failedRow = deleteResult.results.find((row) => row.id === blocked.id);
    const okRow = deleteResult.results.find((row) => row.id === a.id);
    expect(okRow?.outcome).toBe("deleted");
    expect(failedRow?.outcome).toBe("failed");
    expect(failedRow?.code).toBe("DELETE_DEPENDENCY_BLOCKED");
    expect(deleteResult.succeeded).toBe(1);
    expect(deleteResult.failed).toBe(1);

    // 批量恢复：恢复 b
    const restoreResult = (await service.sourceBulkAction({
      context: OWNER_CONTEXT,
      resource: "source_batch",
      action: "restore",
      items: [{ id: b.id, expectedVersion: versionOf(refreshedB) }],
      idempotencyKey: `bulk-restore-${b.id}`,
    })) as { results: Array<{ id: string; outcome: string }> };
    expect(restoreResult.results[0]?.outcome).toBe("restored");

    await prisma.productDiscoverySelection.deleteMany({ where: { activeProductBatchId: blocked.id } });
  });

  it("来源商品批量删除逐项执行：依赖商品被保护，其他合法删除不回滚", async () => {
    const batch = await createBatch("item-bulk");
    const removable = await createItem(batch.id, 0, "itembulkremove");
    const referenced = await createItem(batch.id, 1, "itembulkref");
    await prisma.opportunityCandidate.create({
      data: {
        id: `candidate-${referenced.id}`,
        name: "引用来源商品的候选",
        originProductBatchItemId: referenced.id,
      },
    });

    const result = (await service.sourceBulkAction({
      context: OWNER_CONTEXT,
      resource: "source_item",
      action: "delete",
      items: [
        { id: removable.id, expectedVersion: removable.updatedAt.toISOString() },
        { id: referenced.id, expectedVersion: referenced.updatedAt.toISOString() },
      ],
      idempotencyKey: `item-bulk-delete-${batch.id}`,
    })) as { results: Array<{ id: string; outcome: string; code?: string | null }>; succeeded: number; failed: number };

    expect(result.results.find((row) => row.id === removable.id)?.outcome).toBe("deleted");
    expect(result.results.find((row) => row.id === referenced.id)).toMatchObject({ outcome: "failed", code: "DELETE_DEPENDENCY_BLOCKED" });
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(await prisma.productBatchItem.findUnique({ where: { id: removable.id } })).toBeNull();
    expect(await prisma.productBatchItem.findUnique({ where: { id: referenced.id } })).not.toBeNull();
  });

  it("getSourceBatch 暴露 dependencySummary，供前端判断可删除性", async () => {
    const batch = await createBatch("detail");
    await createItem(batch.id, 0, "detail");
    const detail = (await service.getSourceBatch({
      context: OWNER_CONTEXT,
      batchId: batch.id,
    })) as { dependencySummary: { deleteBlockedBy: string[] }; items: unknown[] };
    expect(Array.isArray(detail.items)).toBe(true);
    expect(Array.isArray(detail.dependencySummary.deleteBlockedBy)).toBe(true);
  });
});
