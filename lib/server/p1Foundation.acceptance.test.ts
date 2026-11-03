import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replayAllCheckedInMigrations, createDbPushShapedRegressionDatabase } from "@/lib/marketScan/__fixtures__/migrationReplay";

const state = vi.hoisted(() => ({ client: null as PrismaClient | null }));
// Replace only the database connection. Guards, routes, repositories and transactions stay real.
vi.mock("@/lib/server/db", () => ({
  prisma: new Proxy({}, { get(_target, key) {
    if (!state.client) throw new Error("disposable_database_not_ready");
    const value = Reflect.get(state.client, key);
    return typeof value === "function" ? value.bind(state.client) : value;
  } }),
}));
import { createProductBatchRepository } from "./productBatchRepository";
import { POST as sourceAction } from "@/app/api/source/batches/[batchId]/[action]/route";
import { GET as sourceList } from "@/app/api/source/batches/route";
import { PATCH as legacyAction } from "@/app/api/product-batches/[id]/route";
import { POST as importBatch, GET as batchList } from "@/app/api/product-batches/route";
import { SELLERSPRITE_SANITIZED_ROWS } from "@/lib/upstream/sellersprite/fixtures/search-export.sanitized.v1";
import { createSellerSpritePreviewTestWorkbook } from "@/tools/upstream/sellersprite-preview/test-fixtures";

let root: string;
const hash = "a".repeat(64);
function req(path: string, method = "GET", body?: unknown, host = "localhost:3011") {
  return new NextRequest("http://localhost:3011" + path, { method,
    headers: { host, origin: "http://localhost:3011", "content-type": "application/json", "Idempotency-Key": "fixture-" + Math.random() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

describe.each(["migrations", "db-push-shaped"] as const)("P1 real write/read on %s database", (shape) => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external_network_forbidden_in_acceptance"); }));
    root = mkdtempSync(join(tmpdir(), "v5-p1-dual-db-"));
    const path = join(root, "test.db");
    if (shape === "migrations") {
      const db = new DatabaseSync(path);
      try { replayAllCheckedInMigrations(db); } finally { db.close(); }
    } else createDbPushShapedRegressionDatabase(path);
    state.client = new PrismaClient({ datasources: { db: { url: "file:" + path.replaceAll("\\", "/") } } });
  });
  afterEach(async () => {
    await state.client?.$disconnect();
    state.client = null;
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  async function batch(dedupeKey = "fixture") {
    return state.client!.productBatch.create({ data: {
      ownerSubject: "owner:v1", batchName: "P1 fixture", marketplace: "US", currency: "USD",
      reportType: "search_results", briefHash: hash, sourceFileName: "fixture.xlsx",
      sourceFileSha256: hash, dedupeKey, batchStatus: "ready", dataQualityStatus: "passed",
      itemCount: 1, acceptedCount: 1, quarantinedCount: 0, sellerSpriteDisclaimerVersion: "fixture",
      normalizedBusinessHash: hash, snapshotHash: hash, manifestHash: hash,
      normalizedSnapshotJson: "{}", manifestJson: "{}", qualitySummaryJson: "{}", importedAt: new Date(),
    } });
  }
  it("legacy archive writes canonical archivedAt; active read hides it; V5 restore makes it usable", async () => {
    const created = await batch();
    const response = await legacyAction(req("/api/product-batches/" + created.id, "PATCH", { action: "archive" }),
      { params: Promise.resolve({ id: created.id }) });
    expect(response.status).toBe(200);
    const archived = await state.client!.productBatch.findUniqueOrThrow({ where: { id: created.id } });
    expect(archived.batchStatus).toBe("ready");
    expect(archived.archivedAt).toBeInstanceOf(Date);
    const repository = createProductBatchRepository(state.client!);
    expect(await repository.listBatchesForOwner()).toEqual([]);
    await expect(repository.setActiveBatch(created.id)).rejects.toMatchObject({ code: "batch_not_activatable" });
    const hidden = await sourceList(req("/api/source/batches?include=active"));
    expect(hidden.status).toBe(200);
    expect((await hidden.json()).data.items).toEqual([]);
    const restored = await sourceAction(req("/api/source/batches/" + created.id + "/restore", "POST",
      { expectedVersion: archived.updatedAt.toISOString() }), { params: Promise.resolve({ batchId: created.id, action: "restore" }) });
    expect(restored.status).toBe(200);
    const read = await sourceList(req("/api/source/batches?include=active"));
    expect((await read.json()).data.items).toEqual(expect.arrayContaining([expect.objectContaining({
      id: created.id, archivedAt: null, batchStatus: "ready" })]));
    expect((await repository.setActiveBatch(created.id)).activeProductBatchId).toBe(created.id);
  });
  it("route guard rejects rebinding Host before writes and restore enforces exact conflict code", async () => {
    const created = await batch();
    const forbidden = await sourceAction(req("/api/source/batches/" + created.id + "/archive", "POST",
      { expectedVersion: created.updatedAt.toISOString() }, "localhost.evil.example"),
      { params: Promise.resolve({ batchId: created.id, action: "archive" }) });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.code).toBe("ORIGIN_NOT_ALLOWED");
    expect((await state.client!.productBatch.findUniqueOrThrow({ where: { id: created.id } })).archivedAt).toBeNull();
    const conflict = await sourceAction(req("/api/source/batches/" + created.id + "/restore", "POST",
      { expectedVersion: created.updatedAt.toISOString() }), { params: Promise.resolve({ batchId: created.id, action: "restore" }) });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("NOT_ARCHIVED");
  });
  it("persists limited_evidence unchanged and rejects unknown vocabulary", async () => {
    const created = await batch();
    const item = await state.client!.productBatchItem.create({ data: {
      batchId: created.id, ordinal: 0, productKey: "amazon:US:B000000001", asin: "B000000001",
      itemIdentityHash: hash, itemHash: hash, evidenceHash: hash, normalizedProductJson: "{}",
      occurrenceProjectionJson: "{}", familyProjectionJson: "{}", rankingJson: "{}",
      provisionalDisposition: "provisional_score_only", researchPriority: "priority_1",
      evidenceStatus: "limited_evidence", promotionEligible: false, imageSnapshotJson: '{"status":"not_cached"}',
    } });
    const repository = createProductBatchRepository(state.client!);
    expect((await repository.getBatchItemsForOwner(created.id))[0]?.evidenceStatus).toBe("limited_evidence");
    // Canonical CHECK protection is tested on the migration DB; schema-shaped DB has no CHECK.
    if (shape === "migrations") {
      await expect(state.client!.productBatchItem.update({ where: { id: item.id },
        data: { evidenceStatus: "invented" } })).rejects.toThrow();
    } else {
      await state.client!.productBatchItem.update({ where: { id: item.id }, data: { evidenceStatus: "invented" } });
      await expect(repository.getBatchItemsForOwner(created.id)).rejects.toMatchObject({ code: "batch_item_evidence_invalid" });
    }
  });
  it("P2 explicitly persists updatedAt on both canonical and historical schema shapes", async () => {
    const repository = createProductBatchRepository(state.client!);
    const created = await repository.createProcessingBatch({ batchName: "Processing", marketplace: "US",
      currency: "USD", reportType: "search_results", briefHash: hash, sourceFileName: "fixture.xlsx",
      sourceFileSha256: hash, sellerSpriteDisclaimerVersion: "fixture",
      query: null, category: null, priceMinCents: null, priceMaxCents: null });
    const write = repository.replaceOrInsertBatchItemsDuringProcessing(created.batch.id, [{
      productKey: "asin:B000000001", ordinal: 0, asin: "B000000001", parentAsin: null,
      itemIdentityHash: hash, itemHash: hash, evidenceHash: hash, normalizedProductJson: "{}",
      occurrenceProjectionJson: "{}", familyProjectionJson: "{}", rankingJson: "{}",
      provisionalDisposition: "provisional_score_only", researchPriority: "priority_1",
      evidenceStatus: "limited_evidence", promotionEligible: false, imageSnapshotJson: '{"status":"not_cached"}',
    }]);
    await expect(write).resolves.toEqual({ insertedCount: 1 });
    const item = await state.client!.productBatchItem.findFirstOrThrow({ where: { batchId: created.batch.id } });
    expect(item.updatedAt.getTime()).toBe(item.createdAt.getTime());
  });
  function workbookRequest(rows = SELLERSPRITE_SANITIZED_ROWS.slice(0, 2).map((row) => ({ ...row, 商品主图: "" }))) {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(createSellerSpritePreviewTestWorkbook({ rows }))],
      { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "fixture.xlsx");
    form.set("reportType", "search_results");
    form.set("query", "closet organizer");
    form.set("category", "Home & Kitchen");
    return new NextRequest("http://localhost:3011/api/product-batches", { method: "POST", body: form,
      headers: { host: "localhost:3011", origin: "http://localhost:3011" } });
  }
  it("P2 import API completes real parsing -> item persistence -> markReady -> list read without network", async () => {
    const response = await importBatch(workbookRequest());
    expect(response.status).toBe(201);
    const body = await response.json();
    const persisted = await state.client!.productBatch.findUniqueOrThrow({ where: { id: body.data.batch.id } });
    expect(persisted).toMatchObject({ batchStatus: "ready", acceptedCount: 2, itemCount: 2 });
    expect(await state.client!.productBatchItem.count({ where: { batchId: persisted.id } })).toBe(2);
    const read = await batchList(req("/api/product-batches"));
    expect(read.status).toBe(200);
    expect((await read.json()).data.batches).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: persisted.id, batchStatus: "ready", itemCount: 2 })]));
    expect(fetch).not.toHaveBeenCalled();
  });
  it("P2 rejects a 501 observation budget before any batch, item, image or selection write", async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
      ...SELLERSPRITE_SANITIZED_ROWS[0], ASIN: index < 400 ? "B" + String(index).padStart(9, "0") : "invalid",
      商品主图: "",
    }));
    const response = await importBatch(workbookRequest(rows));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatchObject({
      code: "batch_item_limit_exceeded", message: expect.stringContaining("500") });
    expect(await state.client!.productBatch.count()).toBe(0);
    expect(await state.client!.productBatchItem.count()).toBe(0);
    expect(await state.client!.productDiscoverySelection.count()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("P2 removes a referenced item after atomically releasing the RESTRICT FK and preserves the candidate", async () => {
    const created = await batch();
    const item = await state.client!.productBatchItem.create({ data: {
      batchId: created.id, ordinal: 0, productKey: "amazon:US:B000000001", asin: "B000000001",
      itemIdentityHash: hash, itemHash: hash, evidenceHash: hash, normalizedProductJson: "{}",
      occurrenceProjectionJson: "{}", familyProjectionJson: "{}", rankingJson: "{}",
      provisionalDisposition: "provisional_score_only", researchPriority: "priority_1",
      evidenceStatus: "limited_evidence", imageSnapshotJson: '{"status":"not_cached"}',
    } });
    const candidate = await state.client!.opportunityCandidate.create({
      data: { name: "Referenced candidate", originProductBatchItemId: item.id } });
    const repository = createProductBatchRepository(state.client!);
    const other = await batch("other-batch");
    await expect(repository.removeBatchItemForOwner(other.id, item.id))
      .rejects.toMatchObject({ code: "batch_item_not_found" });
    await repository.setActiveBatch(created.id);
    await expect(repository.removeBatchItemForOwner(created.id, item.id))
      .rejects.toMatchObject({ code: "batch_is_active" });
    expect((await state.client!.opportunityCandidate.findUniqueOrThrow({ where: { id: candidate.id } }))
      .originProductBatchItemId).toBe(item.id);
    await repository.setActiveBatch(other.id);
    expect(await repository.removeBatchItemForOwner(created.id, item.id))
      .toEqual({ removed: true });
    expect(await state.client!.productBatchItem.findUnique({ where: { id: item.id } })).toBeNull();
    expect(await state.client!.opportunityCandidate.findUniqueOrThrow({ where: { id: candidate.id } }))
      .toMatchObject({ name: "Referenced candidate", originProductBatchItemId: null });
  });
  it("P2 interprets naive SQLite CURRENT_TIMESTAMP text as UTC", async () => {
    const created = await batch();
    await state.client!.$executeRawUnsafe('UPDATE "ProductBatch" SET "createdAt"=?, "updatedAt"=? WHERE "id"=?',
      "2026-10-01 00:00:00", "2026-10-01 01:02:03", created.id);
    const record = await createProductBatchRepository(state.client!).getBatchByIdForOwner(created.id);
    expect(record?.createdAt.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(record?.updatedAt.toISOString()).toBe("2026-10-01T01:02:03.000Z");
  });
});
