import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { checkedInMigrationNames, replayAllCheckedInMigrations } from "@/lib/marketScan/__fixtures__/migrationReplay";
const state = vi.hoisted(() => ({ client: null as PrismaClient | null }));
vi.mock("@/lib/server/db", () => ({ prisma: new Proxy({}, { get(_target, key) {
  if (!state.client) throw new Error("disposable_database_not_ready");
  const value = Reflect.get(state.client, key);
  return typeof value === "function" ? value.bind(state.client) : value;
} }) }));
import { seedP4ReadPath } from "@/lib/server/__fixtures__/p4ReadPathFixture";
import { POST as createMarket } from "@/app/api/market-analysis/route";
import { GET as readMarket } from "@/app/api/market-analysis/[scanId]/route";
import { GET as home } from "@/app/api/home/summary/route";
import { GET as research } from "@/app/api/research/route";
import { POST as briefWrite, GET as briefRead } from "@/app/api/research/[taskId]/product-brief/route";
import { GET as briefList } from "@/app/api/product-brief/route";
import { GET as readProductConcept } from "@/app/api/research/[taskId]/product-concept/route";
import { MarketSampleIdentity, MarketSamplePrice, MarketSampleRating } from "@/components/market-analysis/MarketSampleFacts";
import { projectWorkspaceCounts } from "@/lib/client/workflowCounts";
import { projectMarketSampleDisplayFacts } from "@/lib/marketScan/marketDisplayProjection";
import { researchDisplayIdentity } from "@/lib/product/researchDisplayIdentity";
import { buildResearchEngineInput } from "@/lib/server/research/researchInput";
import { buildResearchInputBundle } from "@/lib/server/research/researchInputBundle";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { getResearchDetail } from "@/lib/server/v5ResearchService";
import { generateProductConceptV5 } from "@/lib/server/productConceptV5Service";
import { GET as readVoice } from "@/app/api/research/[taskId]/customer-voice/route";
let root: string;
let seed: Awaited<ReturnType<typeof seedP4ReadPath>>;
function req(path: string, body?: unknown) {
  return new NextRequest("http://localhost:3011" + path, { method: body === undefined ? "GET" : "POST",
    headers: { host: "localhost:3011", origin: "http://localhost:3011", "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
describe("P4 full migration read contracts and real API write/read", () => {
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "v5-p4-"));
    const path = join(root, "fixture.db"), db = new DatabaseSync(path);
    try { expect(replayAllCheckedInMigrations(db)).toHaveLength(checkedInMigrationNames().length); } finally { db.close(); }
    state.client = new PrismaClient({ datasources: { db: { url: "file:" + path.replaceAll("\\", "/") } } });
    vi.stubEnv("V5_MARKET_ALLOW_INSUFFICIENT_SAMPLE", "true");
    vi.stubEnv("SOURCE_LAYER_STORE_DIR", join(root, "evidence"));
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external_network_forbidden"); }));
    seed = await seedP4ReadPath(state.client);
  });
  afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await state.client?.$disconnect(); state.client = null; rmSync(root, { recursive: true, force: true }); });
  it.each(["v1", "v2", "v3"])("%s exact binding reads the authoritative fact without changing Candidate or EvidenceStore", async (version) => {
    const before = await state.client!.opportunityCandidate.findUniqueOrThrow({ where: { id: "p4-candidate-0" } });
    const meta = JSON.parse(before.sourceMetaJson), proof = meta.productFact.sourceProof;
    meta.schema = "v5-market-candidate." + version;
    meta.sourceLayerCapture = { subjectKey: proof.subjectKey, evidenceId: proof.evidenceId, contentHash: proof.contentHash, version: 1 };
    if (version === "v3") meta.evidenceBinding = { subjectKey: proof.subjectKey, evidenceId: proof.evidenceId, captureId: proof.captureId, contentHash: proof.contentHash, evidenceVersion: 1, readiness: "READY" };
    const sourceMetaJson = JSON.stringify(meta);
    await state.client!.opportunityCandidate.update({ where: { id: before.id }, data: { sourceMetaJson } });
    const store = createEvidenceStore("owner:v1"), subject = await store.getSubject(proof.subjectKey);
    const bundle = await buildResearchInputBundle({ context: { mode: "owner", token: "" }, taskId: "p4-task-0", recordDiagnostic: false });
    expect(bundle.productFact).toEqual(meta.productFact);
    expect((await state.client!.opportunityCandidate.findUniqueOrThrow({ where: { id: before.id } })).sourceMetaJson).toBe(sourceMetaJson);
    expect(await store.getSubject(proof.subjectKey)).toEqual(subject);
  });
  it.each(["cache-tampered", "cache-missing", "binding-missing", "pending", "stale-version", "capture-mismatch"])("%s fails closed in engine and bundle, renders unknown facts, and performs no recovery", async (kind) => {
    const candidate = await state.client!.opportunityCandidate.findUniqueOrThrow({ where: { id: "p4-candidate-0" } });
    const meta = JSON.parse(candidate.sourceMetaJson), proof = meta.productFact.sourceProof;
    meta.schema = "v5-market-candidate.v3";
    meta.evidenceBinding = { subjectKey: proof.subjectKey, evidenceId: proof.evidenceId, captureId: proof.captureId, evidenceVersion: 1, contentHash: proof.contentHash, readiness: "READY" };
    if (kind === "cache-tampered") meta.productFact.basic.price.value.amount = 999;
    if (kind === "cache-missing") delete meta.productFact;
    if (kind === "binding-missing") { delete meta.evidenceBinding; meta.sourceLayerCapture = { version: 1, evidenceId: proof.evidenceId, contentHash: proof.contentHash }; }
    if (kind === "pending") meta.evidenceBinding.readiness = "PENDING_RECOVERY";
    if (kind === "stale-version") meta.evidenceBinding.evidenceVersion = 2;
    if (kind === "capture-mismatch") meta.evidenceBinding.captureId = "wrong-capture";
    const sourceMetaJson = JSON.stringify(meta);
    await state.client!.opportunityCandidate.update({ where: { id: candidate.id }, data: { sourceMetaJson } });
    const context = { mode: "owner", token: "" } as const;
    const code = kind === "cache-missing" ? "product_fact_missing" : "product_fact_invalid";
    await expect(buildResearchEngineInput({ context, taskId: "p4-task-0" })).rejects.toMatchObject({ code, status: 409 });
    await expect(buildResearchInputBundle({ context, taskId: "p4-task-0", recordDiagnostic: false })).rejects.toMatchObject({ code, status: 409 });
    const detail = await getResearchDetail({ context, taskId: "p4-task-0" });
    expect(detail.facts).toMatchObject({ price: null, brand: null });
    expect(detail.reportStale).toBe(true);
    const voice = await readVoice(req("/api/research/p4-task-0/customer-voice"), { params: Promise.resolve({ taskId: "p4-task-0" }) });
    expect(voice.status).toBe(409);
    expect((await voice.json()).error.code).toBe(code.toUpperCase());
    expect((await state.client!.opportunityCandidate.findUniqueOrThrow({ where: { id: candidate.id } })).sourceMetaJson).toBe(sourceMetaJson);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("Customer Voice GET reads the canonical projection without appending a Research handoff diagnostic", async () => {
    const store = createEvidenceStore("owner:v1");
    const subjectKey = `amazon:US:${seed.asin}`;
    const before = await store.getAudit(subjectKey);

    const response = await readVoice(req("/api/research/p4-task-0/customer-voice"), { params: Promise.resolve({ taskId: "p4-task-0" }) });

    expect(response.status).toBe(200);
    expect(await store.getAudit(subjectKey)).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("Product Concept GET verifies the current binding without appending a Research handoff diagnostic", async () => {
    const context = { mode: "owner", token: "" } as const;
    const store = createEvidenceStore("owner:v1");
    const subjectKey = `amazon:US:${seed.asin}`;
    await generateProductConceptV5({ context, taskId: "p4-task-0" });
    const before = await store.getAudit(subjectKey);

    const response = await readProductConcept(req("/api/research/p4-task-0/product-concept"), { params: Promise.resolve({ taskId: "p4-task-0" }) });

    expect(response.status).toBe(200);
    expect(await store.getAudit(subjectKey)).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("legacy root facts and snapshots cannot override a verified ProductFact", async () => {
    const task = await state.client!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: "p4-task-0" } });
    const data = JSON.parse(task.resultJson); data.facts = { price: 999, brand: "AI fabricated" };
    await state.client!.viralAnalysisRecord.update({ where: { id: task.id }, data: { resultJson: JSON.stringify(data) } });
    const detail = await getResearchDetail({ context: { mode: "owner", token: "" }, taskId: task.id });
    expect(detail.facts).toMatchObject({ price: seed.price, brand: "ClearTrail", currency: "USD" });
  });
  it("actual market create -> database -> scanView -> real table cells shows frozen title/price/rating", async () => {
    const response = await createMarket(req("/api/market-analysis", { scanName: "水杯赛道", marketplace: "US", source: { insufficientSampleReason: "P4 disposable projection verification", productBatchId: seed.batchId, itemIds: [seed.itemId] } }));
    expect(response.status).toBe(201);
    const created = (await response.json()).data;
    const reread = await readMarket(req("/api/market-analysis/" + created.id), { params: Promise.resolve({ scanId: created.id }) });
    expect(reread.status).toBe(200);
    const data = (await reread.json()).data, sample = data.sampleItems[0];
    expect(sample).toMatchObject({ title: seed.title, price: seed.price, priceCurrency: "USD", rating: seed.rating, reviewCount: seed.reviewCount });
    const stored = await state.client!.marketScan.findUniqueOrThrow({ where: { id: created.id } });
    expect(data.sampleSnapshot).toEqual(JSON.parse(stored.sampleSnapshotJson));
    const html = renderToStaticMarkup(createElement(Fragment, null,
      createElement(MarketSampleIdentity, { item: sample, marketplace: data.marketplace }),
      createElement(MarketSamplePrice, { item: sample }), createElement(MarketSampleRating, { item: sample })));
    for (const text of [seed.title, "$24.75", "4.3", "123 条评价"]) expect(html).toContain(text);
    const summary = (await (await home(req("/api/home/summary"))).json()).data;
    expect(summary.recentScans[0]).toMatchObject({ scanId: created.id, scanName: "水杯赛道", sampleCount: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("home/sidebar count and research tab data envelope agree with actual task stages", async () => {
    const summary = (await (await home(req("/api/home/summary"))).json()).data;
    const list = (await (await research(req("/api/research?view=all"))).json()).data;
    expect(list.counts.needs_decision).toBe(2);
    expect(projectWorkspaceCounts(summary).researchNeedsDecision).toBe(2);
    expect(summary.decisionQueue).toHaveLength(2);
    const display = list.items.find((item: { candidateId: string }) => item.candidateId === "p4-display-only");
    expect(display.brand).toBeNull();
    expect(display.displayOnlyIdentity).toMatchObject({ nature: "DISPLAY_ONLY", label: "非证据值", brand: "资料品牌", price: 99 });
  });
  it("malformed JSON is 400 INVALID_JSON; V5 auth origin code matches the origin gate", async () => {
    const bad = new NextRequest("http://localhost:3011/api/market-analysis", { method: "POST", headers: { host: "localhost:3011", origin: "http://localhost:3011", "content-type": "application/json" }, body: "{" });
    const response = await createMarket(bad);
    expect(response.status).toBe(400); expect((await response.json()).error.code).toBe("INVALID_JSON");
    const foreign = new NextRequest("http://localhost:3011/api/market-analysis", { method: "POST", headers: { host: "localhost:3011", origin: "https://foreign.invalid", "content-type": "application/json" }, body: "{}" });
    const denied = await createMarket(foreign);
    expect(denied.status).toBe(403); expect((await denied.json()).error.code).toBe("ORIGIN_NOT_ALLOWED");
  });
  it("legacy APPROVED fixture -> regenerate DRAFT preserves raw snapshots; real API rejects unknown fee approval", async () => {
    const params = { params: Promise.resolve({ taskId: seed.briefTaskId }) };
    const generate = await briefWrite(req("/brief", { action: "generate" }), params);
    expect(generate.status).toBe(201);
    const first = (await generate.json()).data.brief;
    const saved = await briefWrite(req("/brief", { action: "save", expectedRevision: first.revision, status: "APPROVED",
      targetPrice: 30, targetMarginPct: 25, referralFee: 4, logistics: 2, estimatedTax: 1, otherKnownCosts: 1 }), params);
    expect(saved.status).toBe(422);
    expect((await saved.json()).error.code).toBe("PRODUCT_BRIEF_NOT_READY");
    const ready = await briefWrite(req("/brief", { action: "save", expectedRevision: first.revision, status: "READY" }), params);
    expect(ready.status).toBe(200);
    const readyBrief = (await ready.json()).data.brief;
    const task = await state.client!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: seed.briefTaskId } });
    const existingRoot = JSON.parse(task.resultJson);
    const approved = { ...readyBrief, status: "APPROVED" }; // Historical fixture state, not an executed approval.
    existingRoot.productBrief = approved;
    await state.client!.viralAnalysisRecord.update({ where: { id: task.id }, data: { resultJson: JSON.stringify(existingRoot) } });
    // P3-02：已有 Brief 的重新生成必须先只读预览再携带版本与来源绑定确认，
    // 裸 generate 已被产品合同禁止（见 productBriefService.casAndPersistence.test.ts）。
    const preview = await briefWrite(req("/brief", { action: "preview" }), params);
    expect(preview.status).toBe(200);
    const previewData = (await preview.json()).data;
    expect(previewData.current.revision).toBe(approved.revision);
    const regenerated = await briefWrite(req("/brief", {
      action: "generate",
      previewRevision: previewData.current.revision,
      previewSourceBinding: previewData.next.sourceBinding,
    }), params);
    expect(regenerated.status).toBe(201);
    const read = (await (await briefRead(req("/brief"), params)).json()).data;
    expect(read.brief.status).toBe("DRAFT");
    expect(read.history).toEqual([first, approved]);
    const raw = JSON.parse((await state.client!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: seed.briefTaskId } })).resultJson);
    expect(raw.preserveUnknown).toEqual({ value: 41 });
    const list = (await (await briefList(req("/api/product-brief"))).json()).data;
    expect(list.items).toHaveLength(1);
  });
  it("concurrent Brief saves keep one revision, one history snapshot, and a public 409", async () => {
    const params = { params: Promise.resolve({ taskId: seed.briefTaskId }) };
    const created = (await (await briefWrite(req("/brief", { action: "generate" }), params)).json()).data.brief;
    const responses = await Promise.all([1, 2].map(() => briefWrite(req("/brief", { action: "save", expectedRevision: created.revision, status: "READY" }), params)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const rejected = responses.find((response) => response.status === 409)!;
    expect((await rejected.json()).error.code).toBe("PRODUCT_BRIEF_REVISION_STALE");
    const read = (await (await briefRead(req("/brief"), params)).json()).data;
    expect(read.brief.revision).toBe(created.revision + 1);
    expect(read.history).toEqual([created]);
  });
  it("invalid historical Brief blocks overwrite and preserves the exact original resultJson", async () => {
    const task = await state.client!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: seed.briefTaskId } });
    const raw = JSON.parse(task.resultJson); raw.productBriefHistory = [{ corrupted: true }];
    const corrupt = JSON.stringify(raw);
    await state.client!.viralAnalysisRecord.update({ where: { id: task.id }, data: { resultJson: corrupt } });
    const response = await briefWrite(req("/brief", { action: "generate" }), { params: Promise.resolve({ taskId: task.id }) });
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("PRODUCT_BRIEF_HISTORY_INVALID");
    expect((await state.client!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: task.id } })).resultJson).toBe(corrupt);
  });
  it("missing snapshot values stay unknown; zero is a real value; display fallback never overwrites facts", () => {
    expect(projectMarketSampleDisplayFacts({ price: { presence: "missing", value: { amount: 9, currency: "USD" } }, rating: { presence: "present", value: 0 } })).toMatchObject({ price: null, rating: 0, title: null });
    const facts = { brand: "事实品牌", price: 24.75, rating: null, reviewCount: null, mainCategory: null, imageUrl: null };
    expect(researchDisplayIdentity({ identity: { brand: "资料品牌", price: 99, rating: 4.9 } }, facts)).toMatchObject({ brand: null, price: null, rating: 4.9 });
    expect(facts.price).toBe(24.75);
  });
});
