import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessContext } from "@/lib/server/accessPassword";
import { createOwnerProductBatchStore } from "@/lib/server/ownerProductBatchStore";
import { createProductBatchRepository } from "@/lib/server/productBatchRepository";
import {
  appendAmazonSearchProductBatch,
  createAmazonSearchProductBatch,
  readVerifiedAmazonSearchEvidence,
  type VerifiedSearchEvidence,
} from "@/lib/server/amazonSearchProductBatchHandoff";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { captureThroughGateway } from "@/lib/sourceLayer/server/captureGateway";
import { replayAllCheckedInMigrations } from "@/lib/marketScan/__fixtures__/migrationReplay";
import type { AmazonSearchCapturePlan } from "@/tools/collectors/recipes/amazon";

const context: AccessContext = { mode: "owner", token: "" };
const capturedAt = new Date("2026-10-17T00:00:00.000Z");

let root: string;
let client: PrismaClient;
let repository: ReturnType<typeof createProductBatchRepository>;
let store: ReturnType<typeof createOwnerProductBatchStore>;

function asin(index: number): string {
  return `B0TEST${String(index).padStart(4, "0")}`;
}

async function captureSearchResult(index: number) {
  const itemAsin = asin(index);
  const binding = {
    expectedAsin: itemAsin,
    observedAsin: itemAsin,
    expectedMarketplace: "US",
    observedMarketplace: "US",
    urlAsin: itemAsin,
    urlMarketplace: "US",
    bound: true,
  };
  return captureThroughGateway({
    context,
    source: "amazon_dom",
    now: capturedAt,
    sourceUrl: `https://www.amazon.com/dp/${itemAsin}`,
    subjectKey: `amazon:US:${itemAsin}`,
    marketplace: "US",
    payload: {
      asin: itemAsin,
      title: `Isolated Amazon search product ${index}`,
      productUrl: `https://www.amazon.com/dp/${itemAsin}`,
      images: [`https://m.media-amazon.com/images/I/${index}.jpg`],
      price: 20 + index,
      currency: "USD",
      rating: 4.5,
      reviewCount: 100 + index,
      brand: "Isolated fixture",
    },
    pageContext: { pageClass: "amazon_search_normal", allowFields: true, entityBinding: binding },
  });
}

function searchPlan(query: string, totalObservationCount: number, pageCount: number): AmazonSearchCapturePlan {
  return {
    schemaVersion: "amazon-search-capture-plan.v1",
    query,
    pageCount,
    totalObservationCount,
    pageStatuses: Array.from({ length: pageCount }, () => "ok"),
    emptyResultReason: totalObservationCount === 0 ? "no_result_cards" : null,
    observations: [],
  };
}

function readReferences(value: string | null): Array<{ asin?: string; evidenceId?: string; contentHash?: string }> {
  const parsed = JSON.parse(value ?? "{}") as { evidenceReferences?: Array<{ asin?: string; evidenceId?: string; contentHash?: string }> };
  return parsed.evidenceReferences ?? [];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amazon-search-expansion-"));
  vi.stubEnv("SOURCE_LAYER_STORE_DIR", join(root, "evidence-store"));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external_network_forbidden_in_isolated_test"); }));
  const databasePath = join(root, "isolated.db");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  replayAllCheckedInMigrations(database);
  database.close();
  client = new PrismaClient({ datasources: { db: { url: `file:${databasePath.replaceAll("\\", "/")}` } } });
  repository = createProductBatchRepository(client);
  store = createOwnerProductBatchStore(repository);
});

afterEach(async () => {
  await client.$disconnect();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("isolated Amazon Search batch expansion", () => {
  it("appends 18 of 25 authorized search results into the same batch without rewriting old Evidence", async () => {
    const originalCaptures = await Promise.all(Array.from({ length: 5 }, (_, index) => captureSearchResult(index + 1)));
    const initial = await createAmazonSearchProductBatch({
      context,
      query: "isolated query",
      traceId: "isolated-initial-search",
      plan: searchPlan("isolated query", 5, 1),
      captures: originalCaptures,
      searchNavigationUsed: 1,
      now: capturedAt,
      store,
    });
    expect(initial.batchStatus).toBe("ready");
    expect(initial.itemCount).toBe(5);
    const batchId = initial.batchId!;
    const oldBatch = await store.getBatch(batchId);
    const oldItems = await store.getBatchItems(batchId);
    const oldSnapshotReferences = readReferences(oldBatch?.normalizedSnapshotJson ?? null);
    const oldManifestReferences = readReferences(oldBatch?.manifestJson ?? null);
    const oldItemEvidence = oldItems.map((item) => ({
      id: item.id,
      asin: item.asin,
      itemHash: item.itemHash,
      evidenceHash: item.evidenceHash,
      normalizedProductJson: item.normalizedProductJson,
    }));
    const evidenceStore = createEvidenceStore("owner:v1");
    const evidenceBefore = await Promise.all(oldItems.map((item) => evidenceStore.getSubject(`amazon:US:${item.asin}`)));

    const newCaptures = await Promise.all(Array.from({ length: 18 }, (_, index) => captureSearchResult(index + 6)));
    const appended = await appendAmazonSearchProductBatch({
      context,
      batchId,
      query: "isolated query",
      traceId: "isolated-expansion-search",
      authorizationId: "auth_expansion_000001",
      targetTotal: 30,
      searchStartPage: 2,
      searchNavigationUsed: 1,
      plan: searchPlan("isolated query", 25, 1),
      // 重复的同一 Capture Gateway 回执用于验证服务端按 ASIN 幂等；不再次写 EvidenceStore。
      captures: [...newCaptures, newCaptures[0]!, originalCaptures[0]!],
      now: capturedAt,
      repository,
    });

    expect(appended.batch.id).toBe(batchId);
    expect(appended.addedCount).toBe(18);
    expect(appended.duplicateProductCount).toBe(2);
    expect(appended.validEvidenceCount).toBe(23);
    expect(new Set((await store.listBatches()).map((batch) => batch.id))).toEqual(new Set([batchId]));
    const manifest = JSON.parse(appended.batch.manifestJson ?? "{}") as { extensions?: Array<Record<string, unknown>> };
    const expansion = manifest.extensions?.find((entry) => entry.authorizationId === "auth_expansion_000001");
    const persistedEvidenceReferences = (expansion?.evidenceReferences as Array<Record<string, unknown>> | undefined)?.map((reference) => ({
      subjectKey: String(reference.subjectKey),
      captureId: String(reference.captureId),
      evidenceId: String(reference.evidenceId),
      evidenceVersion: Number(reference.evidenceVersion),
      contentHash: String(reference.contentHash),
    })) ?? [];
    const recoveredAppend = await appendAmazonSearchProductBatch({
      context,
      batchId,
      query: "isolated query",
      traceId: "isolated-expansion-search",
      authorizationId: "auth_expansion_000001",
      targetTotal: 30,
      searchStartPage: 2,
      searchNavigationUsed: 1,
      plan: null,
      captures: [],
      persistedEvidenceReferences,
      now: capturedAt,
      repository,
    });
    expect(recoveredAppend.addedCount).toBe(18);
    expect(recoveredAppend.duplicateProductCount).toBe(2);
    expect((await store.getBatch(batchId))?.qualitySummaryJson).toContain('"searchNavigationUsed":2');
    const finalItems = await store.getBatchItems(batchId);
    expect(new Set(finalItems.filter((item) => !item.archivedAt).map((item) => item.asin)).size).toBe(23);
    expect(finalItems.slice(0, oldItems.length).map((item) => ({
      id: item.id,
      asin: item.asin,
      itemHash: item.itemHash,
      evidenceHash: item.evidenceHash,
      normalizedProductJson: item.normalizedProductJson,
    }))).toEqual(oldItemEvidence);
    expect(readReferences(appended.batch.normalizedSnapshotJson)).toEqual(oldSnapshotReferences);
    expect(readReferences(appended.batch.manifestJson)).toEqual(oldManifestReferences);
    const evidenceAfter = await Promise.all(oldItems.map((item) => evidenceStore.getSubject(`amazon:US:${item.asin}`)));
    expect(evidenceAfter).toEqual(evidenceBefore);

    const quality = JSON.parse(appended.batch.qualitySummaryJson) as { searchNavigationUsed: number };
    expect(quality.searchNavigationUsed).toBe(2);
    const verified: VerifiedSearchEvidence[] = await readVerifiedAmazonSearchEvidence({ context, items: finalItems });
    expect(verified).toHaveLength(23);
    expect(fetch).not.toHaveBeenCalled();
  });
});
