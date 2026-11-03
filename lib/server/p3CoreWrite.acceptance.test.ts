import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { replayAllCheckedInMigrations } from "@/lib/marketScan/__fixtures__/migrationReplay";

const state = vi.hoisted(() => ({ client: null as PrismaClient | null, collect: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ prisma: new Proxy({}, { get(_target, key) {
  if (!state.client) throw new Error("disposable_database_not_ready");
  const value = Reflect.get(state.client, key);
  return typeof value === "function" ? value.bind(state.client) : value;
} }) }));
// Only external browser acquisition is replaced by an offline Gateway result.
vi.mock("@/lib/server/captureRecipeBrowser", () => ({
  collectAmazonSearchWithPlaywright: state.collect,
  collectAmazonDetailWithPlaywright: state.collect,
}));
import { captureThroughGateway, captureAndHandoffSellerSpritePlugin } from "@/lib/sourceLayer/server/captureGateway";
import { sellerSpriteImportRowFromPreview } from "./sellerSpriteImportContract";
import { captureContentHashOf } from "@/lib/sourceLayer/sourceAdapter";
import { validateCapturePackage } from "@/lib/sourceLayer/validator";
import { createAmazonSearchProductBatch } from "./amazonSearchProductBatchHandoff";
import { promoteEvidence } from "@/lib/sourceLayer/server/promotableEvidenceService";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { getProductBatchStore } from "./productBatchStoreResolver";
import * as storeResolver from "./productBatchStoreResolver";
import { getSourceBatch } from "./v5SourceLifecycleService";
import { POST as searchApi } from "@/app/api/source-layer/collect/amazon-search/route";
import { POST as marketApi } from "@/app/api/market-analysis/route";
import { POST as quickAsinApi } from "@/app/api/quick-asin/route";
import { createTaskResultJsonMutator } from "./taskResultJsonMutation";
import { handoffMarketToResearch, saveMarketGate, saveMarketRepresentatives } from "./v5MarketService";
import type { TaskResultJsonDatabase } from "./taskResultJsonMutation";

const context = { mode: "owner", token: "" } as const;
const now = new Date("2026-10-01T01:00:00.000Z");
let root: string;
function request(path: string, body: unknown, key = "p3-fixture") {
  return new NextRequest("http://localhost:3011" + path, { method: "POST",
    headers: { host: "localhost:3011", origin: "http://localhost:3011", "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body) });
}
async function capture(asin = "B000000001", price = 25) {
  return captureThroughGateway({ context, source: "amazon_dom", now,
    subjectKey: "amazon:US:" + asin, marketplace: "US", sourceUrl: "https://www.amazon.com/dp/" + asin,
    payload: { asin, title: "P3 observed fixture product", productUrl: "https://www.amazon.com/dp/" + asin,
      images: ["https://m.media-amazon.com/images/I/fixture.jpg"], price, currency: "USD",
      rating: 4.6, reviewCount: 300, brand: "Fixture", bsrRank: 80, bsrCategory: "Home & Kitchen", keywords: ["fixture"] },
    pageContext: { pageClass: "amazon_search_normal", allowFields: true, entityBinding: {
      bound: true, expectedAsin: asin, observedAsin: asin, urlAsin: asin,
      expectedMarketplace: "US", observedMarketplace: "US", urlMarketplace: "US" } },
  });
}

// 离线模拟真实搜索采集器的合同：路由要求存在 plan 与已持久化的页级证据检查点，
// 缺一即 fail-closed（SEARCH_EVIDENCE_CHECKPOINT_MISSING）。检查点引用与
// captureRecipeBrowser 相同，取自 Gateway 返回的 productFacts.sourceProof，不做任何替代或拼接。
type GatewayCapture = Awaited<ReturnType<typeof capture>>;
function searchCollectorResult(query: string, captures: GatewayCapture[], traces: Array<{ traceId: string }> = []) {
  const evidenceReferences = captures.flatMap((captured) => captured.productFacts.flatMap((fact) => {
    const proof = fact.sourceProof;
    const item = captured.capture.items.find((candidate) => candidate.subjectKey === proof.subjectKey && candidate.captureId === proof.captureId);
    return item ? [{ subjectKey: proof.subjectKey, captureId: proof.captureId, evidenceId: proof.evidenceId, evidenceVersion: item.version, contentHash: proof.contentHash }] : [];
  }));
  return {
    status: "captured" as const,
    captures,
    plan: { schemaVersion: "amazon-search-capture-plan.v1" as const, query, pageCount: 1, totalObservationCount: captures.length, pageStatuses: ["normal"], emptyResultReason: null, observations: [] },
    pageCheckpoints: [{ page: 1, state: "evidence_persisted" as const, pageStatus: "normal", observationCount: captures.length, evidenceReferences }],
    navigationUsed: 1,
    traces,
    errorCode: null,
    errorMessage: null,
  };
}

describe("P3 real migration database write path", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "v5-p3-"));
    const path = join(root, "fixture.db");
    const db = new DatabaseSync(path);
    try { replayAllCheckedInMigrations(db); } finally { db.close(); }
    state.client = new PrismaClient({ datasources: { db: { url: "file:" + path.replaceAll("\\", "/") } } });
    vi.stubEnv("V5_MARKET_ALLOW_INSUFFICIENT_SAMPLE", "true");
    vi.stubEnv("SOURCE_LAYER_STORE_DIR", join(root, "evidence"));
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external_network_forbidden"); }));
    state.collect.mockReset();
  });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    await state.client?.$disconnect(); state.client = null;
    rmSync(root, { recursive: true, force: true });
  });
  it("fixture search -> EvidenceStore -> API batch -> ready -> real market API create; trace changes reuse one batch", async () => {
    const captured = await capture();
    state.collect.mockResolvedValue(searchCollectorResult("fixture product", [captured], [{ traceId: "fixture-search" }]));

    const response = await searchApi(request("/api/source-layer/collect/amazon-search", { query: "fixture product", authorizedItemLimit: 1 }));
    expect(response.status).toBe(201);
    const data = (await response.json()).data;
    expect(data.productBatchHandoff).toMatchObject({ batchStatus: "ready", itemCount: 1 });
    const again = await createAmazonSearchProductBatch({ context, query: "fixture product", traceId: "different-trace", plan: null, captures: [captured] });
    expect(again.batchId).toBe(data.productBatchHandoff.batchId);
    expect(await state.client!.productBatch.count()).toBe(1);
    const items = await state.client!.productBatchItem.findMany();
    expect(items[0]).toMatchObject({ evidenceStatus: "limited_evidence" });
    // 回归守卫：批量采集必须带图——reference 携带证据包内的原始图片 URL（禁止占位/按 ASIN 拼接），
    // 无图时必须显式写 AUTHORITATIVE_IMAGE_MISSING。品牌/类目/BSR 同样随批次落库。
    const capturedReference = JSON.parse(items[0].normalizedProductJson ?? "{}");
    expect(capturedReference.image).toBe("https://m.media-amazon.com/images/I/fixture.jpg");
    expect(capturedReference.imageUrl).toBe("https://m.media-amazon.com/images/I/fixture.jpg");
    expect(capturedReference.imageAvailability).toBe("AUTHORITATIVE_IMAGE_AVAILABLE");
    expect(capturedReference.brand).toBe("Fixture");
    expect(capturedReference.category).toBe("Home & Kitchen");
    expect(capturedReference.bsr).toMatchObject({ rank: 80, category: "Home & Kitchen" });
    const batch = await state.client!.productBatch.findFirstOrThrow();
    expect(JSON.parse(batch.normalizedSnapshotJson!).schemaVersion).toBe("amazon-search-capture-snapshot.v1");
    const market = await marketApi(request("/api/market-analysis", { scanName: "P3 market fixture", marketplace: "US",
      niche: { kind: "keyword", label: "fixture product" }, source: { insufficientSampleReason: "P3 disposable bridge verification", productBatchId: batch.id, itemIds: [items[0].id] } }, "market-create"));
    expect({ status: market.status, body: await market.json() }).toMatchObject({ status: 201 });
    expect(await state.client!.marketScan.count()).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("market creation reads the frozen capture version when newer evidence exists and rejects a corrupted binding", async () => {
    const captured = await capture();
    const handoff = await createAmazonSearchProductBatch({ context, query: "frozen", traceId: "frozen-v1", plan: null, captures: [captured] });
    await capture("B000000001", 99);
    const item = await state.client!.productBatchItem.findFirstOrThrow();
    const body = { scanName: "frozen market", marketplace: "US", source: { insufficientSampleReason: "P3 disposable bridge verification", productBatchId: handoff.batchId, itemIds: [item.id] } };
    const response = await marketApi(request("/api/market-analysis", body, "frozen-market"));
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    const sample = (await response.json()).data.sampleItems[0];
    expect(sample.evidenceVersion).toBe(1);
    expect(sample.factValues.price.value.amount).toBe(25);
    const reference = JSON.parse(item.normalizedProductJson);
    await state.client!.productBatchItem.update({ where: { id: item.id }, data: { normalizedProductJson: JSON.stringify({ ...reference, contentHash: "f".repeat(64) }) } });
    const denied = await marketApi(request("/api/market-analysis", body, "corrupt-binding"));
    expect(denied.status).toBe(422);
    expect((await denied.json()).error.code).toBe("MARKET_SCAN_SOURCE_EMPTY");
    expect(await state.client!.marketScan.count()).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("promotion post-write failures and three retries use one blocked batch, then recover to ready", async () => {
    const captured = await capture();
    const item = captured.capture.items[0];
    const subject = await createEvidenceStore("owner:v1").getSubject(item.subjectKey);
    const binding = { subjectKey: item.subjectKey, evidenceVersion: item.version, contentHash: subject!.versions[0].contentHash };
    const store = getProductBatchStore(context);
    vi.spyOn(storeResolver, "getProductBatchStore").mockReturnValue(store);
    const markReady = vi.spyOn(store, "markReady").mockRejectedValue(new Error("injected_post_write_failure"));
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(promoteEvidence({ context, bindings: [binding], confirmed: true, idempotencyKey: "promotion-" + attempt })).rejects.toThrow("injected_post_write_failure");
    }
    expect(await state.client!.productBatch.count()).toBe(1);
    expect((await state.client!.productBatch.findFirstOrThrow()).batchStatus).toBe("blocked");
    markReady.mockRestore();
    const promoted = await promoteEvidence({ context, bindings: [binding], confirmed: true, idempotencyKey: "promotion-recovery" });
    expect((await state.client!.productBatch.findUniqueOrThrow({ where: { id: promoted.value.batchId } })).batchStatus).toBe("ready");
    expect(await state.client!.productBatchItem.count()).toBe(1);
    expect(await state.client!.productBatch.count()).toBe(1);
    const persisted = await state.client!.productBatchItem.findFirstOrThrow();
    expect(JSON.parse(persisted.imageSnapshotJson!)).toEqual({
      version: "product-batch-image-snapshot.v1",
      status: "not_cached",
      reason: "not_available",
      capturedAt: now.toISOString(),
    });
    expect(persisted.promotionEligible).toBe(false);
    expect(JSON.parse(persisted.normalizedProductJson!)).toMatchObject({
      evidenceId: subject!.versions[0].evidenceId,
      evidenceVersion: subject!.versions[0].version,
      contentHash: subject!.versions[0].contentHash,
      capturedAt: subject!.versions[0].capturedAt,
    });

    const replay = await promoteEvidence({ context, bindings: [binding], confirmed: true, idempotencyKey: "promotion-recovery" });
    expect(replay.value.batchId).toBe(promoted.value.batchId);
    expect(await state.client!.productBatchItem.count()).toBe(1);
    await expect(promoteEvidence({ context, bindings: [{ ...binding, contentHash: "0".repeat(64) }], confirmed: true,
      idempotencyKey: "promotion-wrong-evidence" })).rejects.toThrow("来源证据已发生变化");
    await expect(promoteEvidence({ context, bindings: [{ subjectKey: binding.subjectKey, evidenceVersion: 1, contentHash: "bad" }], confirmed: true,
      idempotencyKey: "promotion-invalid-binding" })).rejects.toThrow("提档请求缺少完整的证据版本绑定");
    await expect(promoteEvidence({ context, bindings: [binding], confirmed: false,
      idempotencyKey: "promotion-not-confirmed" })).rejects.toThrow("请先确认要提档的商品");
  });
  it("accepts legacy v2 reference rows through the version family while unknown versions stay fail-closed", async () => {
    const context2 = context;
    const captured = await capture();
    const handoff = await createAmazonSearchProductBatch({ context: context2, query: "v2 family", traceId: "v2-family", plan: null, captures: [captured] });
    const item = await state.client!.productBatchItem.findFirstOrThrow({ where: { batchId: handoff.batchId! } });
    const reference = JSON.parse(item.normalizedProductJson) as Record<string, unknown>;
    // 历史数据集（round2-f8）里的 240 条记录就是 v2（= v1 + image/imageUrl/imageAvailability）。
    await state.client!.productBatchItem.update({ where: { id: item.id }, data: {
      normalizedProductJson: JSON.stringify({ ...reference, schemaVersion: "amazon-search-product-reference.v2" }) } });
    const accepted = await marketApi(request("/api/market-analysis", { scanName: "v2 family market", marketplace: "US",
      niche: { kind: "keyword", label: "v2 family" },
      source: { insufficientSampleReason: "P3 disposable bridge verification", productBatchId: handoff.batchId, itemIds: [item.id] } }, "v2-family"));
    expect(accepted.status, JSON.stringify(await accepted.clone().json())).toBe(201);

    // 版本族之外的 schema 仍然 fail-closed（不允许任意字符串混入）。
    const other = await createAmazonSearchProductBatch({ context: context2, query: "v9 family", traceId: "v9-family", plan: null, captures: [captured] });
    const otherItem = await state.client!.productBatchItem.findFirstOrThrow({ where: { batchId: other.batchId! } });
    const otherReference = JSON.parse(otherItem.normalizedProductJson) as Record<string, unknown>;
    await state.client!.productBatchItem.update({ where: { id: otherItem.id }, data: {
      normalizedProductJson: JSON.stringify({ ...otherReference, schemaVersion: "amazon-search-product-reference.v9" }) } });
    const denied = await marketApi(request("/api/market-analysis", { scanName: "v9 family market", marketplace: "US",
      niche: { kind: "keyword", label: "v9 family" },
      source: { insufficientSampleReason: "P3 disposable bridge verification", productBatchId: other.batchId, itemIds: [otherItem.id] } }, "v9-family"));
    expect(denied.status).toBe(422);
    expect((await denied.json()).error.code).toBe("MARKET_SCAN_SOURCE_EMPTY");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("source item projection preserves provider estimates and rejects cross-batch selected IDs with exact 422 code", async () => {
    const captured = await capture();
    const first = await createAmazonSearchProductBatch({ context, query: "first", traceId: "t1", plan: null, captures: [captured] });
    const second = await createAmazonSearchProductBatch({ context, query: "second", traceId: "t2", plan: null, captures: [captured] });
    const firstItem = await state.client!.productBatchItem.findFirstOrThrow({ where: { batchId: first.batchId! } });
    const secondItem = await state.client!.productBatchItem.findFirstOrThrow({ where: { batchId: second.batchId! } });
    // 展示层回归守卫：批次引用里的原始图片必须原样透出为权威图（非占位），BSR 走顶层回退。
    const freshView = await getSourceBatch({ context, batchId: first.batchId! });
    expect(freshView.items[0].image).toBe("https://m.media-amazon.com/images/I/fixture.jpg");
    expect(freshView.items[0].imageStatus).toBe("AUTHORITATIVE_IMAGE_AVAILABLE");
    expect(freshView.items[0].bsr).toMatchObject({ rank: 80, category: "Home & Kitchen" });
    await state.client!.productBatchItem.update({ where: { id: firstItem.id }, data: { normalizedProductJson: JSON.stringify({
      schemaVersion: "fixture-projection", providerMetrics: {
        price: { normalized: 25, applicability: "available", metricNature: "estimate" },
        rating: { normalized: 4.6, applicability: "available", metricNature: "estimate" },
        reviews: { normalized: 300, applicability: "available", metricNature: "estimate" } } }) } });
    const view = await getSourceBatch({ context, batchId: first.batchId! });
    expect(view.items[0].price).toMatchObject({ status: "estimated", metricNature: "estimate" });
    expect(view.items[0].rating).toMatchObject({ status: "estimated" });
    const denied = await marketApi(request("/api/market-analysis", { scanName: "mixed", marketplace: "US",
      source: { insufficientSampleReason: "P3 disposable bridge verification", productBatchId: first.batchId, itemIds: [firstItem.id, secondItem.id] } }, "mixed-items"));
    expect(denied.status).toBe(422);
    expect((await denied.json()).error.code).toBe("SOURCE_ITEMS_BATCH_MISMATCH");
    expect(await state.client!.marketScan.count()).toBe(0);
  });
  it("normalizes a selected plugin ASIN before source-row lookup and keeps the original row provenance", async () => {
    const row = sellerSpriteImportRowFromPreview({ rowHash: "b".repeat(64), rowNumber: 37,
      facts: { asin: " b000000001 ", title: "Plugin normalization fixture", amazonUrl: "https://www.amazon.com/dp/B000000001",
        imageUrl: "https://m.media-amazon.com/images/I/fixture.jpg", priceUsd: 25, rating: 4.6, reviewCount: 300, brand: "Fixture", category: "Home & Kitchen" },
      estimates: { searchRank: 80, estimatedMonthlySales: 123, estimatedMonthlyRevenueUsd: 3075 } });
    const result = await captureAndHandoffSellerSpritePlugin({ context, rows: [row], sourceFileSha256: "a".repeat(64), now });
    expect(result.handoff.summary.created).toHaveLength(1);
    const candidate = await state.client!.opportunityCandidate.findFirstOrThrow();
    const meta = JSON.parse(candidate.sourceMetaJson);
    expect(meta.identity.asin).toBe("B000000001");
    expect(meta.source.rowHash).toBe(row.rowHash);
    expect(meta.productFact.market.monthlySalesEstimate.metricNature).toBe("estimate");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("promotion retains estimated comparison nature and marks it limited, while an explicit blocked target can recover", async () => {
    const captured = await capture();
    const store = createEvidenceStore("owner:v1");
    const original = (await store.getSubject(captured.capture.items[0].subjectKey))!.versions[0];
    const pkg = { ...original.pkg, captureId: "p3-estimated-price", version: 2, fieldStates: {
      ...original.pkg.fieldStates, price: { ...original.pkg.fieldStates.price, status: "estimated" as const, metricNature: "estimate" as const, confidence: 0.8 } } };
    const report = validateCapturePackage(pkg, { now });
    expect(report.verdict).toBe("passed");
    const contentHash = captureContentHashOf(pkg);
    await store.appendEvidence({ evidence: { ...original, captureId: pkg.captureId, evidenceId: "ev-p3-estimated-price", pkg, contentHash,
      validation: { verdict: report.verdict, readyForResearch: report.readyForResearch, issueCodes: report.issues.map((issue) => issue.error.code), checkedAt: now.toISOString() } }, auditEntries: [], operator: "owner:v1", now });
    const binding = { subjectKey: original.subjectKey, evidenceVersion: 2, contentHash };
    const batches = getProductBatchStore(context);
    vi.spyOn(storeResolver, "getProductBatchStore").mockReturnValue(batches);
    const fail = vi.spyOn(batches, "markReady").mockRejectedValue(new Error("explicit_target_fixture_failure"));
    await expect(promoteEvidence({ context, bindings: [binding], confirmed: true, idempotencyKey: "limited-promote" })).rejects.toThrow();
    fail.mockRestore();
    const target = await state.client!.productBatch.findFirstOrThrow();
    await promoteEvidence({ context, targetBatchId: target.id, bindings: [binding], confirmed: true, idempotencyKey: "explicit-retry" });
    expect((await state.client!.productBatch.findFirstOrThrow()).batchStatus).toBe("ready");
    expect((await state.client!.productBatchItem.findFirstOrThrow()).evidenceStatus).toBe("limited_evidence");
    const view = await getSourceBatch({ context, batchId: target.id });
    expect(view.batch.sourceType).toBe("evidence_store_reference");
    expect(view.items[0].price).toMatchObject({ status: "estimated", metricNature: "estimate" });
    expect(await state.client!.productBatch.count()).toBe(1);
  });
  it("reuses candidates only within the same scan and marketplace; fact recovery sees committed rows and the frozen evidence", async () => {
    const captures = [];
    for (let index = 1; index <= 30; index++) captures.push(await capture("B" + String(index).padStart(9, "0")));
    const batch = await createAmazonSearchProductBatch({ context, query: "handoff scope", traceId: "scope", plan: null, captures });
    const scan = async (name: string) => {
      const response = await marketApi(request("/api/market-analysis", { scanName: name, marketplace: "US", source: { insufficientSampleReason: "P3 disposable bridge verification", productBatchId: batch.batchId } }, name));
      expect(response.status).toBe(201);
      const data = (await response.json()).data;
      const sample = data.sampleItems[0];
      const gate = await saveMarketGate({ context, scanId: data.id, expectedScanHash: data.sampleHash,
        expectedVersion: data.resourceVersion, status: "PROCEED", missingDataAcknowledged: true, reason: "P3 offline fixture scope verification", idempotencyKey: name + "-gate" });
      const selection = { marketSampleKey: sample.marketSampleKey, asin: sample.asin, subjectKey: sample.subjectKey, role: "benchmark", note: "Compare the existing evidence" };
      await saveMarketRepresentatives({ context, scanId: data.id, expectedScanHash: data.sampleHash,
        expectedVersion: gate.resourceVersion, items: [selection], idempotencyKey: name + "-representative" });
      return { context, scanId: data.id, expectedScanHash: data.sampleHash, selections: [selection] };
    };
    const firstScan = await scan("scope-first");
    const foreign = await state.client!.opportunityCandidate.create({ data: { name: "Foreign marketplace fixture",
      sourceMetaJson: JSON.stringify({ asin: "B000000001", marketplace: "CA", marketProvenance: { scanId: firstScan.scanId, marketSampleKey: firstScan.selections[0].marketSampleKey } }) } });
    await capture("B000000001", 99);
    const first = await handoffMarketToResearch({ ...firstScan, idempotencyKey: "scope-handoff-first" });
    expect(first.items[0]).toMatchObject({ candidateOutcome: "created", taskOutcome: "created", factRecovery: { status: "attached" } });
    expect(first.items[0].candidateId).not.toBe(foreign.id);
    const candidate = await state.client!.opportunityCandidate.findUniqueOrThrow({ where: { id: String(first.items[0].candidateId) } });
    const meta = JSON.parse(candidate.sourceMetaJson);
    expect(meta.productFactRecovery).toMatchObject({ strategy: "exact_binding", resolvedVersion: 1 });
    expect(meta.productFact.basic.price.value.amount).toBe(25);
    const task = await state.client!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: String(first.items[0].taskId) } });
    await state.client!.viralAnalysisRecord.update({ where: { id: task.id }, data: { resultJson: JSON.stringify({ ...JSON.parse(task.resultJson), keywordEvidence: { preserve: true } }) } });
    const replay = await handoffMarketToResearch({ ...firstScan, idempotencyKey: "scope-handoff-repeat" });
    expect(replay.items[0]).toMatchObject({ candidateId: candidate.id, taskId: task.id, candidateOutcome: "reused", taskOutcome: "reused" });
    expect(JSON.parse((await state.client!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: task.id } })).resultJson).keywordEvidence).toEqual({ preserve: true });
    const secondScan = await scan("scope-second");
    const second = await handoffMarketToResearch({ ...secondScan, idempotencyKey: "scope-handoff-second" });
    expect(second.items[0]).toMatchObject({ candidateOutcome: "created", taskOutcome: "created", factRecovery: { status: "attached" } });
    expect(second.items[0].candidateId).not.toBe(candidate.id);
    expect(second.items[0].taskId).not.toBe(task.id);
    expect(JSON.parse((await state.client!.opportunityCandidate.findUniqueOrThrow({ where: { id: candidate.id } })).sourceMetaJson).marketProvenance.scanId).toBe(firstScan.scanId);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("returns persisted capture data and records a blocked batch when search handoff fails after evidence success", async () => {
    const captured = await capture();
    state.collect.mockResolvedValue(searchCollectorResult("partial fixture", [captured]));
    const store = getProductBatchStore(context);
    vi.spyOn(storeResolver, "getProductBatchStore").mockReturnValue(store);
    vi.spyOn(store, "markReady").mockRejectedValue(new Error("injected_handoff_failure"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await searchApi(request("/api/source-layer/collect/amazon-search", { query: "partial fixture", authorizedItemLimit: 1 }));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, data: { status: "captured", partial: true }, error: { code: "PRODUCT_BATCH_HANDOFF_FAILED" } });
    expect(body.data.captures).toHaveLength(1);
    expect((await state.client!.productBatch.findFirstOrThrow()).batchStatus).toBe("blocked");
    expect((await createEvidenceStore("owner:v1").getSubject("amazon:US:B000000001"))!.versions).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("[source-layer/amazon-search]", expect.objectContaining({ code: "PRODUCT_BATCH_HANDOFF_FAILED", captured: true }));
  });
  it("records a diagnostic if marking a failed handoff blocked also fails", async () => {
    const captured = await capture();
    const store = getProductBatchStore(context);
    vi.spyOn(storeResolver, "getProductBatchStore").mockReturnValue(store);
    vi.spyOn(store, "markReady").mockRejectedValue(new Error("injected_ready_failure"));
    vi.spyOn(store, "markBlocked").mockRejectedValue(new Error("injected_blocked_failure"));
    await expect(createAmazonSearchProductBatch({ context, query: "diagnostic fixture", traceId: "double-write-fail", plan: null, captures: [captured] })).rejects.toThrow();
    const audit = await createEvidenceStore("owner:v1").getAudit("amazon:US:B000000001");
    expect(audit.find((entry) => entry.eventType === "batch_mark_blocked_failed")).toMatchObject({ errorCode: "PERSISTENCE_FAILED", severity: "error" });
    expect(await state.client!.productBatch.count()).toBe(1);
  });
  it.each(["CAPTCHA_DETECTED", "LOGIN_REQUIRED"])("quick ASIN preserves %s as nonretryable human action", async (code) => {
    state.collect.mockResolvedValue({ status: "human_required", errorCode: code, errorMessage: "请在本地浏览器处理" });
    const response = await quickAsinApi(request("/api/quick-asin", { asin: "B000000001" }, "quick-" + code));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({ code, retryable: false, details: { humanRequired: true } });
    expect(await state.client!.productBatch.count()).toBe(0);
  });
  it("simultaneous V5 Research and Market writes have one CAS winner and preserve unrelated namespaces", async () => {
    const task = await state.client!.viralAnalysisRecord.create({ data: {
      type: "workflow", title: "CAS fixture", platform: "fixture", source: "fixture", materialText: "Fixture", score: 0, level: "", oneLineSummary: "", resultJson: JSON.stringify({ v5Research: {}, keywordEvidence: { frozen: true } }) } });
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const database = { viralAnalysisRecord: {
      findUnique: (args: unknown) => (state.client!.viralAnalysisRecord.findUnique as (args: unknown) => Promise<unknown>)(args),
      updateMany: async (args: unknown) => { arrivals++; if (arrivals === 2) release(); await barrier;
        return (state.client!.viralAnalysisRecord.updateMany as (args: unknown) => Promise<{ count: number }>)(args); },
    } } satisfies TaskResultJsonDatabase;
    const mutate = createTaskResultJsonMutator({ ownerDatabase: database });
    const results = await Promise.allSettled([
      mutate({ context, taskId: task.id, writer: "v5-research", mutate: (current) => ({ result: { ...current, v5Research: { revision: 1 } }, value: null }) }),
      mutate({ context, taskId: task.id, writer: "market-research-handoff", mutate: (current) => ({ result: { ...current, marketProvenance: { scanId: "fixture" } }, value: null }) }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: "task_result_conflict" });
    const saved = await state.client!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: task.id } });
    expect(JSON.parse(saved.resultJson).keywordEvidence).toEqual({ frozen: true });
  });
});

