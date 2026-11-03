import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replayAllCheckedInMigrations } from "@/lib/marketScan/__fixtures__/migrationReplay";
const state = vi.hoisted(() => ({ client: null as PrismaClient | null }));
vi.mock("@/lib/server/db", () => ({ prisma: new Proxy({}, { get(_target, key) {
  if (!state.client) throw new Error("disposable_database_not_ready");
  const value = Reflect.get(state.client, key);
  return typeof value === "function" ? value.bind(state.client) : value;
} }) }));
import { captureFromProductBatch } from "@/lib/sourceLayer/server/sourceLayerService";
import { createMarketAnalysis } from "@/lib/server/v5MarketService";
import { seedP4ReadPath } from "@/lib/server/__fixtures__/p4ReadPathFixture";
import { seedP5MarketBatch } from "@/lib/server/__fixtures__/p5MarketFixture";
import { addManualCustomerVoice, importCustomerVoiceFile, listCustomerVoiceForResearchTask } from "@/lib/server/customerVoiceService";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { getResearchDetail } from "@/lib/server/v5ResearchService";
import { buildResearchInputBundle } from "@/lib/server/research/researchInputBundle";
import { createMarketScan } from "@/lib/server/marketScanService";
import { createMarketOpportunityRepository } from "@/lib/server/marketOpportunityRepository";
import { readRepresentativeView, saveRepresentativeSelections, startRepresentativeResearch } from "@/lib/server/marketOpportunityRepresentativeService";
import type { RepresentativeSelection } from "@/lib/marketOpportunity/representatives";
import { seedAcceptanceImports } from "@/lib/server/__fixtures__/p8AcceptanceImports";
import { getSourceBatch } from "@/lib/server/v5SourceLifecycleService";
import { SELLERSPRITE_PRODUCT_BATCH_DISCLAIMER_VERSION } from "@/lib/server/productBatchImportService";
const context = { mode: "owner", token: "" } as const;
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "v5-p8-services-"));
  const path = join(root, "fixture.db"), database = new DatabaseSync(path);
  try { replayAllCheckedInMigrations(database); } finally { database.close(); }
  state.client = new PrismaClient({ datasources: { db: { url: "file:" + path.replaceAll("\\", "/") } } });
  vi.stubEnv("SOURCE_LAYER_STORE_DIR", join(root, "evidence"));
  vi.stubEnv("V5_MARKET_ALLOW_INSUFFICIENT_SAMPLE", "false");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external_network_forbidden"); }));
});
afterEach(async () => {
  await state.client?.$disconnect(); state.client = null;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
describe("P8 CustomerVoice real evidence gateway and research readback", () => {
  it("manual VOC persists raw provenance, deduplicates and changes evidence without changing ProductFact or final choice", async () => {
    const seed = await seedP4ReadPath(state.client!);
    const before = await getResearchDetail({ context, taskId: seed.briefTaskId });
    expect(before.reportStale).toBe(false);
    const bundleBefore = await buildResearchInputBundle({ context, taskId: seed.briefTaskId });
    const subjectKey = "amazon:US:" + seed.asin;
    const versions = (await createEvidenceStore("owner:v1").getSubject(subjectKey))!.versions;
    const input = { context, taskId: seed.briefTaskId, observations: [{ text: "离线人工反馈：杯盖密封需要验证", rating: 2, externalContentId: "offline-voice-1" }] };
    const saved = await addManualCustomerVoice(input);
    expect(saved).toMatchObject({ added: 1, duplicate: 0, subjectKey });
    expect(saved.rawArtifactHash).toMatch(/^[a-f0-9]{64}$/u);
    const duplicate = await addManualCustomerVoice(input);
    expect(duplicate).toMatchObject({ added: 0, duplicate: 1, attachmentId: null });
    const view = await listCustomerVoiceForResearchTask({ context, taskId: seed.briefTaskId });
    expect(view.count).toBe(1); expect(view.evidenceRefs).toHaveLength(1);
    expect(view.observations[0]).toMatchObject({ source: "manual_voc", identityMatch: "UNRESOLVED", provenance: { provider: "manual_import", accessBasis: "user_supplied_text" } });
    const after = await getResearchDetail({ context, taskId: seed.briefTaskId });
    expect(after.factHash).toBe(before.factHash);
    // The report's stored binding is immutable; current evidence is read separately.
    expect(after.evidenceHash).toBe(before.evidenceHash);
    const bundleAfter = await buildResearchInputBundle({ context, taskId: seed.briefTaskId });
    expect(bundleAfter.sourceEvidenceRefs).not.toEqual(bundleBefore.sourceEvidenceRefs);
    expect(after.reportStale).toBe(true);
    expect(after.myChoice).toEqual(before.myChoice);
    expect((await createEvidenceStore("owner:v1").getSubject(subjectKey))!.versions).toEqual(versions);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("JSON file import reads real bytes and immutable attachments; malformed/empty inputs leave evidence untouched", async () => {
    const seed = await seedP4ReadPath(state.client!);
    const bytes = new TextEncoder().encode(JSON.stringify([{ asin: seed.asin, reviewText: "离线文件反馈：包装应加强", reviewId: "offline-file-1", rating: 3 }]));
    const saved = await importCustomerVoiceFile({ context, taskId: "p4-task-0", fileName: "offline.json", bytes });
    expect(saved).toMatchObject({ acceptedRows: 1, added: 1 });
    const read = await listCustomerVoiceForResearchTask({ context, taskId: "p4-task-0" });
    expect(read.count).toBe(1); expect(read.observations[0].text).toContain("包装应加强");
    await expect(importCustomerVoiceFile({ context, taskId: "p4-task-0", fileName: "empty.json", bytes: new Uint8Array() })).rejects.toMatchObject({ code: "CUSTOMER_VOICE_FILE_SIZE_INVALID", status: 413 });
    await expect(addManualCustomerVoice({ context, taskId: "p4-task-0", observations: [{ text: "invalid", rating: 9 }] })).rejects.toMatchObject({ code: "CUSTOMER_VOICE_MANUAL_ITEM_INVALID", status: 400 });
    expect(await listCustomerVoiceForResearchTask({ context, taskId: "p4-task-0" })).toEqual(read);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("missing task is a typed failure and cannot create evidence", async () => {
    await expect(addManualCustomerVoice({ context, taskId: "missing-task", observations: [{ text: "offline" }] })).rejects.toMatchObject({ code: "task_not_found" });
    expect(await state.client!.viralAnalysisRecord.count()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
async function opportunity() {
  const seed = await seedP5MarketBatch(state.client!, 30);
  const scan = await createMarketScan({ context, scanName: "P8 真实代表商品服务验证", marketplace: "US", nicheKind: "keyword", nicheLabel: "water bottle", productBatchId: seed.batchId });
  const repository = createMarketOpportunityRepository();
  const record = await repository.create({ name: "P8 opportunity", latestMarketScanId: scan.id });
  const sample = scan.sampleSnapshot.items[0];
  const selection: RepresentativeSelection = { productFactSubjectKey: sample.subjectKey, asin: sample.asin, candidateId: null,
    roleTags: ["HIGH_RATING"], selectedBy: "Owner", selectedAt: "2026-10-01T00:00:00.000Z", note: "核实高评分样本" };
  return { record, repository, selection, sample };
}
describe("P8 market opportunity representative real Prisma/CAS", () => {
  it("real scan -> save -> read; rejects foreign identity and empty selection without changing revision", async () => {
    const { record, selection } = await opportunity();
    const saved = await saveRepresentativeSelections({ context, opportunityId: record.id, expectedRevision: 0, selections: [selection] });
    expect(saved).toMatchObject({ revision: 1, selectedCount: 1, sampleCount: 30 });
    expect(saved.samples[0]).toMatchObject({ selected: true, title: "离线验证水杯 1", price: { amount: 24.75, currency: "USD" } });
    await expect(saveRepresentativeSelections({ context, opportunityId: record.id, expectedRevision: 1, selections: [{ ...selection, asin: "B999999999", productFactSubjectKey: "amazon:US:B999999999" }] })).rejects.toMatchObject({ code: "representative_invalid", status: 422 });
    await expect(saveRepresentativeSelections({ context, opportunityId: record.id, expectedRevision: 1, selections: [] })).rejects.toMatchObject({ code: "representative_invalid", status: 422 });
    expect(await readRepresentativeView(record.id)).toEqual(saved);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("simultaneous saves at one real revision have one winner; stale retry preserves its exact selection", async () => {
    const { record, selection, repository } = await opportunity();
    const results = await Promise.allSettled(["first", "second"].map((note) => saveRepresentativeSelections({ context, opportunityId: record.id, expectedRevision: 0, selections: [{ ...selection, note }] })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ code: "market_opportunity_conflict" });
    const winner = await repository.getById(record.id);
    expect(winner!.representativeSet.revision).toBe(1);
    await expect(saveRepresentativeSelections({ context, opportunityId: record.id, expectedRevision: 0, selections: [selection] })).rejects.toMatchObject({ code: "market_opportunity_conflict" });
    expect((await repository.getById(record.id))!.representativeSet).toEqual(winner!.representativeSet);
  });
  it("legacy research start is retired (410) even with a bridged representative; read view guard stays real", async () => {
    const { record, selection } = await opportunity();
    await saveRepresentativeSelections({ context, opportunityId: record.id, expectedRevision: 0, selections: [selection] });
    // 2026-11-02：旧 02→03 交接入口已退役。即使代表品已桥接，也必须 410 拒绝且不创建研究任务；
    // 正式入口是 handoffMarketToResearch（PROCEED + 快照哈希 + readiness + 代表品 + 幂等）。
    await expect(startRepresentativeResearch({ context, opportunityId: record.id, subjectKey: selection.productFactSubjectKey })).rejects.toMatchObject({ code: "legacy_research_handoff_retired", status: 410 });
    await expect(readRepresentativeView("missing-opportunity")).rejects.toMatchObject({ code: "opportunity_not_found", status: 404 });
    expect(await state.client!.viralAnalysisRecord.count()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
describe("P8 acceptance seed and imported projection round trip", () => {
  it("actual XLSX importer owns readiness, disclaimer and every hash; stored rich projections agree with Source DTO", async () => {
    const seed = await seedAcceptanceImports(state.client!);
    expect(seed).toMatchObject({ importSource: "REAL_SELLERSPRITE_IMPORT_SERVICE", synthetic: true, externalAcquisition: 0 });
    expect(seed.itemIds).toHaveLength(31); expect(seed.cleanupBatches).toHaveLength(3);
    const batch = await state.client!.productBatch.findUniqueOrThrow({ where: { id: seed.batchId } });
    expect(batch).toMatchObject({ batchStatus: "ready", itemCount: 31, acceptedCount: 31, sellerSpriteDisclaimerVersion: SELLERSPRITE_PRODUCT_BATCH_DISCLAIMER_VERSION });
    for (const hash of [batch.normalizedBusinessHash, batch.snapshotHash, batch.manifestHash, batch.sourceFileSha256]) expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(new Set([batch.normalizedBusinessHash, batch.snapshotHash, batch.manifestHash, batch.sourceFileSha256]).size).toBeGreaterThan(1);
    const raw = await state.client!.productBatchItem.findUniqueOrThrow({ where: { id: seed.itemIds[0] } });
    for (const json of [raw.normalizedProductJson, raw.occurrenceProjectionJson, raw.familyProjectionJson, raw.rankingJson]) {
      expect(Object.keys(JSON.parse(json)).length).toBeGreaterThan(0);
    }
    const view = await getSourceBatch({ context, batchId: seed.batchId });
    expect(view.items).toHaveLength(31);
    const item = view.items.find((item) => item.id === raw.id)!;
    expect(item).toMatchObject({ asin: "B0SRC00001", title: "离线竹木厨房样本 1", visible: true,
      price: { value: 24.99, status: "unknown", metricNature: "unknown" } });
    const normalized = JSON.parse(raw.normalizedProductJson);
    expect(normalized.providerMetrics.price.nature).toBe("snapshot");
    // Legacy importer uses `nature`; the Source DTO currently preserves its value with unknown confidence.
    expect(item.price!.value).toBe(normalized.providerMetrics.price.normalized);
    expect((await state.client!.productDiscoverySelection.findUniqueOrThrow({ where: { ownerSubject: "owner:v1" } })).activeProductBatchId).toBe(seed.batchId);
    expect(fetch).not.toHaveBeenCalled();
  });
});


describe("P9 importer fixture reaches the actual Source-to-Market chain", () => {
  it("embedded fixture PNG is parsed and validated; all 31 identities remain bound and no external fetch occurs", async () => {
    const seed = await seedAcceptanceImports(state.client!, { includeFixtureImage: true });
    const captured = await captureFromProductBatch({ context, productBatchId: seed.batchId });
    expect(captured.items).toHaveLength(31); expect(captured.blockedCount).toBe(0); expect(captured.errors).toEqual([]);
    const scan = await createMarketAnalysis({ context, scanName: "P9 actual import journey", marketplace: "US", niche: {}, source: { productBatchId: seed.batchId, itemIds: seed.itemIds }, idempotencyKey: crypto.randomUUID() });
    expect(scan.sampleCount).toBe(31); expect(scan.marketGate.effectiveStatus).toBe("PENDING"); expect(scan.decisionReadiness.validSampleCount).toBe(31);
    expect(await state.client!.viralAnalysisRecord.count()).toBe(0); expect(fetch).not.toHaveBeenCalled();
    const storedScan = await state.client!.marketScan.findUniqueOrThrow({ where: { id: scan.id } });
    const frozen = JSON.parse(storedScan.sampleSnapshotJson) as import("@/lib/marketScan/types").MarketScanSampleSnapshotV1;
    expect(storedScan.sampleHash).toBe(scan.sampleHash);
    for (const sample of frozen.items) {
      expect(sample.evidenceVersion).toBe(1); expect(sample.subjectKey).toBe("amazon:US:" + sample.asin); expect(sample.sourceProofHash).toMatch(/^[a-f0-9]{64}$/u);
    }
  });
});
