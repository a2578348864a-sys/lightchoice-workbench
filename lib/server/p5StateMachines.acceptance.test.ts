import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { checkedInMigrationNames, replayAllCheckedInMigrations } from "@/lib/marketScan/__fixtures__/migrationReplay";
const state = vi.hoisted(() => ({ client: null as PrismaClient | null }));
vi.mock("@/lib/server/db", () => ({ prisma: new Proxy({}, { get(_target, key) {
  if (!state.client) throw new Error("disposable_database_not_ready");
  const value = Reflect.get(state.client, key); return typeof value === "function" ? value.bind(state.client) : value;
} }) }));
import { seedP5MarketBatch } from "@/lib/server/__fixtures__/p5MarketFixture";
import { POST as createMarket } from "@/app/api/market-analysis/route";
import { GET as readMarket } from "@/app/api/market-analysis/[scanId]/route";
import { POST as action } from "@/app/api/market-analysis/[scanId]/[action]/route";
import { hashJson } from "@/lib/server/v5CanonicalHash";
import { writeMarketWorkflowMetadata, buildInitialMarketWorkflowMetadata } from "@/lib/marketWorkflow/metadata";
import { createMarketScan } from "@/lib/server/marketScanService";
import { previewMarketAnalysisSample } from "@/lib/server/v5MarketService";
import { MARKET_SAMPLE_POLICY_VERSION } from "@/lib/marketScan/marketSamplePolicy";
let root: string;
const context = { mode: "owner", token: "" } as const;
function req(path: string, body?: unknown) {
  return new NextRequest("http://localhost:3011" + path, { method: body === undefined ? "GET" : "POST",
    headers: { host: "localhost:3011", origin: "http://localhost:3011", "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function create(batchId: string, source: Record<string, unknown> = {}, scanName = "水杯市场") {
  return createMarket(req("/api/market-analysis", { scanName, marketplace: "US", source: { productBatchId: batchId, ...source } }));
}
async function read(id: string) { return (await (await readMarket(req("/api/market-analysis/" + id), { params: Promise.resolve({ scanId: id }) })).json()).data; }
async function act(scan: { id: string; sampleHash: string; resourceVersion: string }, name: string, data: Record<string, unknown>) {
  return action(req(`/api/market-analysis/${scan.id}/${name}`, { expectedScanHash: scan.sampleHash, expectedVersion: scan.resourceVersion, ...data }),
    { params: Promise.resolve({ scanId: scan.id, action: name }) });
}
async function smallScan(count: number) {
  const seed = await seedP5MarketBatch(state.client!, count);
  vi.stubEnv("V5_MARKET_ALLOW_INSUFFICIENT_SAMPLE", "true");
  const response = await create(seed.batchId, { insufficientSampleReason: "disposable negative-path verification" });
  expect(response.status).toBe(201);
  vi.stubEnv("V5_MARKET_ALLOW_INSUFFICIENT_SAMPLE", "false");
  return (await response.json()).data;
}
describe("P5 state machine full-migration API acceptance", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "v5-p5-")); const path = join(root, "fixture.db"), db = new DatabaseSync(path);
    try { expect(replayAllCheckedInMigrations(db)).toHaveLength(checkedInMigrationNames().length); } finally { db.close(); }
    state.client = new PrismaClient({ datasources: { db: { url: "file:" + path.replaceAll("\\", "/") } } });
    vi.stubEnv("SOURCE_LAYER_STORE_DIR", join(root, "evidence")); vi.stubEnv("V5_MARKET_ALLOW_INSUFFICIENT_SAMPLE", "false");
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external_network_forbidden"); }));
  });
  afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await state.client?.$disconnect(); state.client = null; rmSync(root, { recursive: true, force: true }); });
  it.each([1, 29])("%i products cannot bypass create, Proceed, representatives or handoff", async (count) => {
    const scan = await smallScan(count);
    const batchId = scan.sampleDefinition.productBatchId;
    for (const source of [{ allowInsufficientSample: true }, { insufficientSampleReason: "client reason" }]) {
      const denied = await create(batchId, source, "DEMO fixture TEST");
      expect(denied.status).toBe(409); expect((await denied.json()).error.code).toBe("MARKET_SAMPLE_INSUFFICIENT");
    }
    for (const [name, data] of [["market-gate", { status: "PROCEED", reason: "确认", missingDataAcknowledged: true }],
      ["representatives", { items: [{ marketSampleKey: scan.id + ":" + scan.sampleItems[0].asin, asin: scan.sampleItems[0].asin, subjectKey: scan.sampleItems[0].subjectKey, role: "benchmark", note: "选择理由" }] }],
      ["research-handoff", { selections: [{ marketSampleKey: scan.id + ":" + scan.sampleItems[0].asin, asin: scan.sampleItems[0].asin, subjectKey: scan.sampleItems[0].subjectKey }] }]] as const) {
      const response = await act(scan, name, data); expect(response.status).toBe(409);
      const body = await response.json(); expect(body.error.code).toBe("MARKET_SAMPLE_INSUFFICIENT");
      expect(body.error.message).toContain(String(30 - count));
    }
    expect(await state.client!.marketScan.count()).toBe(1);
    expect(await state.client!.opportunityCandidate.count()).toBe(0);
    expect(await state.client!.viralAnalysisRecord.count()).toBe(0);
  });

  it("D0-004 样本预检与实际创建同口径：30 过 / 29 拒，且预检只读", async () => {
    // 30 款：预检最终可冻结 = 30，创建成功，scan 指标同数。
    const seed30 = await seedP5MarketBatch(state.client!, 30);
    const preview30 = await previewMarketAnalysisSample({ context, productBatchId: seed30.batchId, marketplace: "US" });
    expect(preview30.sourceItemCount).toBeGreaterThanOrEqual(30);
    expect(preview30.preliminaryValidCount).toBe(30);
    expect(preview30.finalFreezableCount).toBe(30);
    expect(preview30.sufficient).toBe(true);
    expect(preview30.stages.every((stage) => stage.droppedCount >= 0)).toBe(true);
    const created = await create(seed30.batchId);
    expect(created.status).toBe(201);
    const scan = (await created.json()).data;
    expect(scan.decisionReadiness.validSampleCount).toBe(preview30.finalFreezableCount);

    // 29 款：预检提前给出不足门槛与排除口径，真实创建仍被 409 拒绝（门禁不放宽）。
    // offset 换一段 ASIN，避免与上一批 fixture 主体身份冲突。
    const seed29 = await seedP5MarketBatch(state.client!, 29, 500);
    const preview29 = await previewMarketAnalysisSample({ context, productBatchId: seed29.batchId, marketplace: "US" });
    expect(preview29.preliminaryValidCount).toBe(29);
    expect(preview29.finalFreezableCount).toBe(29);
    expect(preview29.sufficient).toBe(false);
    expect(preview29.minimumRequired).toBe(30);
    const denied = await create(seed29.batchId);
    expect(denied.status).toBe(409);
    expect((await denied.json()).error.code).toBe("MARKET_SAMPLE_INSUFFICIENT");

    // 预检是纯只读：除上面那次合法创建外，不产生额外 MarketScan。
    expect(await state.client!.marketScan.count()).toBe(1);
  });
  it("bypass needs environment and reason; low-level create has the same gate", async () => {
    const seed = await seedP5MarketBatch(state.client!, 1);
    vi.stubEnv("V5_MARKET_ALLOW_INSUFFICIENT_SAMPLE", "true");
    const denied = await create(seed.batchId, { allowInsufficientSample: true });
    expect(denied.status).toBe(422); expect((await denied.json()).error.code).toBe("MARKET_SAMPLE_BYPASS_REASON_REQUIRED");
    vi.stubEnv("V5_MARKET_ALLOW_INSUFFICIENT_SAMPLE", "false");
    await expect(createMarketScan({ context, scanName: "直接入口", marketplace: "US", nicheKind: "keyword", nicheLabel: "水杯", productBatchId: seed.batchId })).rejects.toMatchObject({ code: "market_sample_insufficient", httpStatus: 409 });
    expect(await state.client!.marketScan.count()).toBe(0);
  });
  it("30 valid limited-evidence products require missing acknowledgment then explicit human Proceed; preserve representatives across decisions", async () => {
    const seed = await seedP5MarketBatch(state.client!, 30);
    await state.client!.productBatchItem.updateMany({ where: { batchId: seed.batchId }, data: { evidenceStatus: "limited_evidence" } });
    const response = await create(seed.batchId); expect(response.status).toBe(201); let scan = (await response.json()).data;
    expect(scan.decisionReadiness).toMatchObject({ validSampleCount: 30, sampleSufficiency: "SAMPLE_SUFFICIENT", status: "READY_WITH_MISSING_DATA_CONFIRMATION" });
    expect(scan.marketGate.effectiveStatus).toBe("PENDING");
    expect(scan.sampleDefinition.marketSamplePolicyVersion).toBe(MARKET_SAMPLE_POLICY_VERSION);
    expect(scan.sampleSnapshot.items.every((item: { sampleValidityPolicyVersion: string }) => item.sampleValidityPolicyVersion === MARKET_SAMPLE_POLICY_VERSION)).toBe(true);
    const missingAck = await act(scan, "market-gate", { status: "PROCEED", reason: "选择", missingDataAcknowledged: false });
    expect(missingAck.status).toBe(409); expect((await missingAck.json()).error.code).toBe("MARKET_MISSING_DATA_ACK_REQUIRED");
    const pending = await act(scan, "market-gate", { status: "PENDING" }); expect(pending.status).toBe(422); expect((await pending.json()).error.code).toBe("MARKET_GATE_PENDING_FORBIDDEN");
    const proceed = await act(scan, "market-gate", { status: "PROCEED", reason: "已确认需求与集中度缺失", missingDataAcknowledged: true }); expect(proceed.status).toBe(200); scan = (await proceed.json()).data;
    const sample = scan.sampleItems[0], selected = { marketSampleKey: sample.marketSampleKey, asin: sample.asin, subjectKey: sample.subjectKey, role: "benchmark" };
    for (const note of [undefined, "", " ", "x".repeat(1001)]) {
      const denied = await act(scan, "representatives", { items: [{ ...selected, note }] }); expect(denied.status).toBe(422); expect((await denied.json()).error.code).toBe("REPRESENTATIVE_REASON_REQUIRED");
    }
    const saved = await act(scan, "representatives", { items: [{ ...selected, note: "观察到的价格和评价适合对比" }] }); expect(saved.status).toBe(200); scan = (await saved.json()).data;
    for (const status of ["VALIDATE_MORE", "PAUSE", "DROP", "PROCEED"] as const) {
      const next = await act(scan, "market-gate", { status, reason: "人工状态转移", missingDataAcknowledged: true }); expect(next.status).toBe(200); scan = (await next.json()).data;
      expect(scan.representatives.items[0].note).toBe("观察到的价格和评价适合对比");
      if (status !== "PROCEED") { const denied = await act(scan, "research-handoff", { selections: [selected] }); expect(denied.status).toBe(409); expect((await denied.json()).error.code).toBe("MARKET_GATE_REQUIRED"); }
    }
    const handed = await act(scan, "research-handoff", { selections: [selected] }); expect(handed.status).toBe(201);
    const item = (await handed.json()).data.items[0]; expect(item.taskId).toBeTruthy(); expect(item.marketProvenance.representativeNote).toBe("观察到的价格和评价适合对比");
    expect(await state.client!.opportunityCandidate.count()).toBe(1); expect(await state.client!.viralAnalysisRecord.count()).toBe(1);
  });
  it("concurrent decisions using one resourceVersion have one winner and one exact CAS conflict", async () => {
    const seed = await seedP5MarketBatch(state.client!, 30);
    const created = await create(seed.batchId); expect(created.status).toBe(201); const scan = (await created.json()).data;
    const responses = await Promise.all([act(scan, "market-gate", { status: "PAUSE", reason: "先暂停" }), act(scan, "market-gate", { status: "DROP", reason: "决定放弃" })]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(bodies[responses.findIndex((r) => r.status === 409)].error.code).toBe("CAS_CONFLICT");
    const winner = bodies[responses.findIndex((r) => r.status === 200)].data;
    expect((await read(scan.id)).marketGate.status).toBe(winner.marketGate.status);
  });
  it("covers all 16 explicit final-state transitions and rejects PENDING, missing reason and stale version", async () => {
    const seed = await seedP5MarketBatch(state.client!, 30);
    const created = await create(seed.batchId); expect(created.status).toBe(201); let scan = (await created.json()).data;
    const states = ["PROCEED", "VALIDATE_MORE", "PAUSE", "DROP"] as const;
    for (const from of states) {
      let response = await act(scan, "market-gate", { status: from, reason: "起始状态", missingDataAcknowledged: true });
      expect(response.status).toBe(200); scan = (await response.json()).data;
      for (const to of states) {
        const prior = scan;
        response = await act(scan, "market-gate", { status: to, reason: `人工 ${from} 到 ${to}`, missingDataAcknowledged: true });
        expect(response.status).toBe(200); scan = (await response.json()).data; expect(scan.marketGate.status).toBe(to);
        const stale = await act(prior, "market-gate", { status: "PAUSE", reason: "旧版本" });
        expect(stale.status).toBe(409); expect((await stale.json()).error.code).toBe("CAS_CONFLICT");
        const pending = await act(scan, "market-gate", { status: "PENDING" }); expect(pending.status).toBe(422);
        const missingReason = await act(scan, "market-gate", { status: to }); expect(missingReason.status).toBe(422);
        response = await act(scan, "market-gate", { status: from, reason: "恢复起始状态", missingDataAcknowledged: true });
        expect(response.status).toBe(200); scan = (await response.json()).data;
      }
    }
  });
  it("legacy metrics cannot fake sufficient sample; historical JSON stays unchanged and stale binding downgrades", async () => {
    let scan = await smallScan(1);
    const stored = await state.client!.marketScan.findUniqueOrThrow({ where: { id: scan.id } });
    const metrics = { ...JSON.parse(stored.metricsJson), validSampleCount: 60 };
    const gate = buildInitialMarketWorkflowMetadata({ scanId: scan.id, sampleHash: scan.sampleHash, metricsHash: hashJson(metrics), metricsVersion: stored.metricsVersion });
    await state.client!.marketScan.update({ where: { id: scan.id }, data: { metricsJson: JSON.stringify(metrics), sampleDefinitionJson: writeMarketWorkflowMetadata(stored.sampleDefinitionJson, { ...gate, marketGate: { ...gate.marketGate, status: "PROCEED", missingDataAcknowledged: true } }) } });
    const frozen = await state.client!.marketScan.findUniqueOrThrow({ where: { id: scan.id } }); scan = await read(scan.id);
    expect(scan.decisionReadiness.validSampleCount).toBe(1); expect(scan.marketGate.effectiveStatus).toBe("PENDING");
    const reread = await state.client!.marketScan.findUniqueOrThrow({ where: { id: scan.id } }); expect(reread).toEqual(frozen);
    await state.client!.marketScan.update({ where: { id: scan.id }, data: { sampleHash: "f".repeat(64), metricsJson: JSON.stringify({ ...metrics, sampleHash: "f".repeat(64) }), sampleSnapshotJson: JSON.stringify({ ...JSON.parse(frozen.sampleSnapshotJson), sampleHash: "f".repeat(64) }) } });
    scan = await read(scan.id); expect(scan.marketGate.stale).toBe(true); expect(scan.marketGate.effectiveStatus).toBe("PENDING");
  });
});
