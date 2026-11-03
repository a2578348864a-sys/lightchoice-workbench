import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { checkedInMigrationNames, replayAllCheckedInMigrations } from "@/lib/marketScan/__fixtures__/migrationReplay";
const state = vi.hoisted(() => ({ client: null as PrismaClient | null, provider: vi.fn(), priority: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ prisma: new Proxy({}, { get(_target, key) {
  if (!state.client) throw new Error("disposable_database_not_ready");
  const value = Reflect.get(state.client, key); return typeof value === "function" ? value.bind(state.client) : value;
} }) }));
vi.mock("@/lib/server/aiClient", () => ({ getAiConfig: () => ({ ok: true, data: { provider: "deepseek" } }), callAiJson: state.provider }));
vi.mock("@/lib/decision/decisionEngine", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/decision/decisionEngine")>(), analyzeResearchPriority: state.priority }));
import { POST as priorityRoute } from "@/app/api/decision/research-priority/[candidateId]/route";
import { seedP4ReadPath } from "@/lib/server/__fixtures__/p4ReadPathFixture";
import { GET as readRoute } from "@/app/api/research/[taskId]/route";
import { POST as writeRoute } from "@/app/api/research/[taskId]/[action]/route";
import { buildResearchInputBundle } from "@/lib/server/research/researchInputBundle";
import { computeResearchEvidenceHash } from "@/lib/productResearchRecord";
import { manualEntryAdapter } from "@/lib/sourceLayer/adapters/manualEntryAdapter";
import { adaptEvidenceToProductFact } from "@/lib/sourceLayer/fact/productFactAdapter";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { listResearch } from "@/lib/server/v5ResearchService";
import { POST as writeBrief } from "@/app/api/research/[taskId]/product-brief/route";
let root: string;
const context = { mode: "owner", token: "" } as const;
const taskId = "p4-task-0";
function request(path: string, body?: unknown) {
  return new NextRequest("http://localhost:3011" + path, { method: body === undefined ? "GET" : "POST",
    headers: { host: "localhost:3011", origin: "http://localhost:3011", "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function read() { return (await (await readRoute(request("/api/research/" + taskId), { params: Promise.resolve({ taskId }) })).json()).data; }
async function write(action: string, body: unknown) { return writeRoute(request(`/api/research/${taskId}/${action}`, body), { params: Promise.resolve({ taskId, action }) }); }
async function stored() { return JSON.parse((await state.client!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: taskId } })).resultJson); }
function choice(detail: any) { return { canonicalStatus: "PROCEED", reason: "已检查当前证据", readinessAcknowledged: true, expectedVersion: detail.resourceVersion, expectedRevision: detail.researchRevision, expectedReportHash: detail.reportHash, expectedFactHash: detail.factHash, expectedEvidenceHash: detail.evidenceHash }; }
async function generate(confirm = false) { const detail = await read(); return write("advisory", { expectedRevision: detail.researchRevision, requested: ["deepseek_summary"], confirmFinalAdvisoryRegeneration: confirm }); }
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "v5-p6-")); const path = join(root, "fixture.db"), db = new DatabaseSync(path);
  try { expect(replayAllCheckedInMigrations(db)).toHaveLength(checkedInMigrationNames().length); } finally { db.close(); }
  state.client = new PrismaClient({ datasources: { db: { url: "file:" + path.replaceAll("\\", "/") } } });
  vi.stubEnv("SOURCE_LAYER_STORE_DIR", join(root, "evidence")); vi.stubEnv("V5_RESEARCH_PROVIDER", "");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external_network_forbidden"); }));
  await seedP4ReadPath(state.client);
  state.provider.mockReset();
  state.provider.mockImplementation(async (input: any) => {
    const refs = JSON.parse(input.messages[1].content).allowedEvidenceRefs as string[];
    return { ok: true, data: { summary: { text: "离线响应：可追溯的研究摘要", evidenceRefs: [refs[0]] }, opportunities: [], risks: [],
      vocAnalysis: { painPoints: [], positiveSignals: [], failureModes: [], useCases: [], replacementSignals: [], switchReasons: [], ownershipClaims: [] },
      citations: [{ quote: "商品页已有观察", source: refs[0] }] } };
  });
});
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await state.client?.$disconnect(); state.client = null; rmSync(root, { recursive: true, force: true }); });
describe("P6 full-migration Research API acceptance", () => {
  it.each(["schema", "citation", "provider", "test-only"])("%s failure preserves report, revision, all bindings and read visibility", async (failure) => {
    expect((await generate()).status).toBe(200); const before = (await stored()).v5Research;
    if (failure === "schema") state.provider.mockResolvedValue({ ok: true, data: { summary: "wrong shape" } });
    if (failure === "citation") state.provider.mockResolvedValue({ ok: true, data: { summary: { text: "unsupported", evidenceRefs: [] }, opportunities: [], risks: [], vocAnalysis: { painPoints: [], positiveSignals: [], failureModes: [], useCases: [], replacementSignals: [], switchReasons: [], ownershipClaims: [] }, citations: [] } });
    if (failure === "provider") state.provider.mockResolvedValue({ ok: false, error: { code: "provider_unavailable" } });
    if (failure === "test-only") state.provider.mockResolvedValue({ ok: true, data: { testOnly: true, summary: { text: "testing" } } });
    const failed = await generate(); expect(failed.status).toBe(200); expect((await failed.json()).data.deepseek.status).toBe("failed");
    const after = (await stored()).v5Research;
    for (const key of ["report", "reportHash", "factHash", "evidenceHash", "researchRevision", "evidenceRefs", "reportBindingHashes"]) expect(after[key]).toEqual(before[key]);
    const detail = await read(); expect(detail.report).toEqual(before.report); expect(detail.deepseek.status).toBe("available"); expect(detail.lastAdvisoryAttempt.status).toBe("failed");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("persists decision bindings, detects evidence change on read without diagnostic writes and requires a current report", async () => {
    await generate(); const detail = await read(); expect(detail.stale).toBe(false);
    const response = await write("choice", choice(detail)); expect(response.status).toBe(200); const binding = (await response.json()).data.decisionBindingHash;
    const saved = await stored(); expect(saved.v5Research.myChoice.decisionBindingHash).toBe(binding); expect(saved.v5Research.myChoice.bindingHashes.reportHash).toBe(detail.reportHash);
    const task = await state.client!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: taskId } });
    await state.client!.viralAnalysisRecord.update({ where: { id: taskId }, data: { resultJson: JSON.stringify({ ...saved, keywordEvidence: { terms: ["new evidence"] } }) } });
    const auditBefore = await createEvidenceStore("owner:v1").getAudit("amazon:US:B000000041");
    const beforeRead = await state.client!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: taskId } }); const events = await state.client!.agentEvent.count();
    const stale = await read(); expect(stale.stale).toBe(true); expect(stale.staleReason).toBe("RESEARCH_EVIDENCE_CHANGED");
    const rows = await listResearch({ context }); expect(rows.items.find((item: any) => item.taskId === taskId)?.stale).toBe(true);
    expect(await state.client!.agentEvent.count()).toBe(events);
    expect(await createEvidenceStore("owner:v1").getAudit("amazon:US:B000000041")).toEqual(auditBefore);
    expect((await state.client!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: taskId } })).resultJson).toBe(beforeRead.resultJson);
    const denied = await write("choice", choice(stale)); expect(denied.status).toBe(409); expect((await denied.json()).error.code).toBe("RESEARCH_EVIDENCE_STALE");
    expect(task.resultJson).not.toBe(beforeRead.resultJson);
    const blocked = await generate(); expect(blocked.status).toBe(409); expect((await blocked.json()).error.code).toBe("FINAL_ADVISORY_CONFIRMATION_REQUIRED");
    expect((await generate(true)).status).toBe(200); const refreshed = await read(); expect(refreshed.stale).toBe(true); expect(refreshed.reportStale).toBe(false);
    expect((await write("choice", choice(refreshed))).status).toBe(200); expect((await read()).stale).toBe(false);
  });
  it.each(["production", "test"])("%s refuses fake before Provider or report mutation", async (environment) => {
    vi.stubEnv("NODE_ENV", environment); vi.stubEnv("V5_RESEARCH_PROVIDER", "fake"); const before = await stored();
    const denied = await generate(); expect(denied.status).toBe(409); expect((await denied.json()).error.code).toBe("TEST_ADVISORY_FORBIDDEN");
    expect((await stored()).v5Research).toEqual(before.v5Research); expect(state.provider).not.toHaveBeenCalled();
  });
  it("read-only canonical bundle does not append diagnostics", async () => {
    const auditBefore = await createEvidenceStore("owner:v1").getAudit("amazon:US:B000000041");
    const before = await state.client!.agentEvent.count(); await buildResearchInputBundle({ context, taskId, recordDiagnostic: false });
    expect(await state.client!.agentEvent.count()).toBe(before);
    expect(await createEvidenceStore("owner:v1").getAudit("amazon:US:B000000041")).toEqual(auditBefore);
  });
  it("a regenerated V5 report does not rewrite or remain trapped by historical completion bindings", async () => {
    const first = await stored(); first.keywordEvidence = { terms: ["old keyword"] };
    first.researchCompletion = { schema: "research-completion.v1", status: "completed", completedAt: "2026-10-01T00:00:00.000Z", decisionId: "12345678-1234-4234-8234-123456789012", revision: 1, finalStatus: "needs_information", evidenceHash: computeResearchEvidenceHash(first) };
    await state.client!.viralAnalysisRecord.update({ where: { id: taskId }, data: { resultJson: JSON.stringify(first) } });
    await generate(); const changed = await stored(); changed.keywordEvidence.terms = ["new keyword"];
    await state.client!.viralAnalysisRecord.update({ where: { id: taskId }, data: { resultJson: JSON.stringify(changed) } });
    expect((await read()).reportStale).toBe(true); expect((await generate()).status).toBe(200);
    const detail = await read(); expect(detail.reportStale).toBe(false); expect((await write("choice", choice(detail))).status).toBe(200);
    expect((await stored()).researchCompletion).toEqual(first.researchCompletion);
  });
  it("the canonical Research input retains provider estimate nature", async () => {
    const candidate = await state.client!.opportunityCandidate.findUniqueOrThrow({ where: { id: "p4-candidate-0" } });
    const meta = JSON.parse(candidate.sourceMetaJson!);
    // Estimates must originate in EvidenceStore, never a hand-edited Candidate cache.
    const now = "2026-10-01T01:00:00.000Z";
    const captured = manualEntryAdapter.capture({ payload: { asin: "B000000041", title: "便携不锈钢水杯", brand: "ClearTrail",
      productUrl: "https://www.amazon.com/dp/B000000041", images: ["https://m.media-amazon.com/images/I/offline-fixture.jpg"],
      price: 24.75, rating: 4.3, reviewCount: 123, estimatedMonthlySales: 450 }, capturedAt: now, operator: "owner:v1" });
    const pkg = manualEntryAdapter.normalize({ draft: captured.drafts[0], captureId: "p6-estimate", version: 2 });
    const outcome = manualEntryAdapter.validate({ pkg, context: { now } });
    const evidence = manualEntryAdapter.createEvidence({ pkg: outcome.pkg, report: outcome.report });
    await createEvidenceStore("owner:v1").appendEvidence({ evidence, auditEntries: [], operator: "owner:v1", now: new Date(now) });
    meta.productFact = adaptEvidenceToProductFact({ evidence });
    await state.client!.opportunityCandidate.update({ where: { id: candidate.id }, data: { sourceMetaJson: JSON.stringify(meta) } });
    const bundle = await buildResearchInputBundle({ context, taskId, recordDiagnostic: false });
    expect(bundle.productFact?.market.monthlySalesEstimate).toMatchObject({ value: 450, metricNature: "estimate" });
  });
  it("priority route catch records a safe audit event", async () => {
    state.priority.mockRejectedValue(new Error("sensitive_provider_body_must_not_be_logged"));
    const response = await priorityRoute(request("/api/decision/research-priority/p4-candidate-0", {}), { params: Promise.resolve({ candidateId: "p4-candidate-0" }) });
    expect(response.status).toBe(500); expect((await response.json()).error.code).toBe("decision_analysis_failed");
    const events = await state.client!.agentEvent.findMany({ where: { module: "research-priority", event: "analysis_failed" } });
    expect(events).toHaveLength(1); expect(JSON.stringify(events)).not.toContain("sensitive_provider_body");
    expect(events[0].metadataJson).toContain("decision_analysis_failed");
  });
  it("an evidence-free target user cannot persist as FACT", async () => {
    const params = { params: Promise.resolve({ taskId: "p4-task-2" }) };
    const created = await writeBrief(request("/brief", { action: "generate" }), params); expect(created.status).toBe(201);
    const brief = (await created.json()).data.brief;
    const saved = await writeBrief(request("/brief", { action: "save", status: "READY", expectedRevision: brief.revision,
      targetUser: { text: "尚未验证的目标人群", nature: "FACT", evidenceRefs: [] } }), params);
    expect(saved.status).toBe(200); expect((await saved.json()).data.brief.targetUser.nature).toBe("ASSUMPTION");
    const raw = JSON.parse((await state.client!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: "p4-task-2" } })).resultJson);
    expect(raw.productBrief.targetUser.nature).toBe("ASSUMPTION");
  });

  it("P0-BR batch1: generate prefills A1-A5 sections and save round-trips them", async () => {
    const params = { params: Promise.resolve({ taskId: "p4-task-2" }) };
    const created = await writeBrief(request("/brief", { action: "generate" }), params);
    expect(created.status).toBe(201);
    const brief = (await created.json()).data.brief;

    // A1 预填：规格行来自 ProductFact（缺失则为空数组，但结构必须存在）
    expect(Array.isArray(brief.specifications)).toBe(true);
    if (brief.specifications.length > 0) {
      expect(["FACT", "ASSUMPTION"]).toContain(brief.specifications[0].nature);
      expect(brief.specifications[0].id).toBeTruthy();
    }
    // 追加修正：产品开发确认事项——只提出待确认问题，不生成供应链数值
    expect(Array.isArray(brief.confirmationItems)).toBe(true);
    expect(brief.confirmationItems.length).toBeGreaterThan(0);
    expect(brief.confirmationItems.every((item: { status: string }) => item.status === "待确认")).toBe(true);
    expect(brief.confirmationItems.every((item: { reason: string | null }) => item.reason === "需要供应商确认")).toBe(true);
    const briefJson = JSON.stringify(brief);
    expect(briefJson).not.toContain("supplyChain");
    expect(briefJson).not.toContain("samplingRequirements");
    // A4 预填：四行对照行
    expect(brief.benchmarkComparison.rows.map((row: { id: string }) => row.id)).toEqual(["cmp_price", "cmp_rating", "cmp_reviews", "cmp_selling_point"]);
    // A5 预填：验证计划与 missingValidation 同源
    expect(brief.verificationPlan).toHaveLength(brief.missingValidation.length);
    expect(brief.verificationPlan.every((item: { status: string }) => item.status === "pending")).toBe(true);

    // 编辑 → 保存 → 写后读
    const nextSpecs = [...brief.specifications, { id: "spec_manual", label: "人工规格", value: "450", unit: "ml", nature: "ASSUMPTION", verification: "verified", evidenceRefs: [] as string[] }];
    const nextConfirms = [
      ...brief.confirmationItems.map((item: Record<string, unknown>, index: number) => index === 0 ? { ...item, status: "已确认", reason: "已与供应商口头确认" } : item),
      { id: "cfq_manual", item: "是否支持小批量混装", status: "待确认", reason: "需要供应商确认" },
    ];
    const saved = await writeBrief(request("/brief", {
      action: "save",
      status: "READY",
      expectedRevision: brief.revision,
      specifications: nextSpecs,
      confirmationItems: nextConfirms,
      benchmarkComparison: { rows: brief.benchmarkComparison.rows.map((row: Record<string, unknown>) => row.id === "cmp_price" ? { ...row, theirs: "29.99 USD" } : row) },
      verificationPlan: brief.verificationPlan.map((item: Record<string, unknown>, index: number) => index === 0 ? { ...item, method: "人工复核", status: "done" } : item),
    }), params);
    expect(saved.status).toBe(200);
    const savedBrief = (await saved.json()).data.brief;
    expect(savedBrief.revision).toBe(brief.revision + 1);
    expect(savedBrief.specifications).toHaveLength(brief.specifications.length + 1);
    expect(savedBrief.confirmationItems).toHaveLength(brief.confirmationItems.length + 1);
    expect(savedBrief.confirmationItems[0].status).toBe("已确认");
    expect(savedBrief.confirmationItems.at(-1).item).toBe("是否支持小批量混装");
    expect(savedBrief.benchmarkComparison.rows[0].theirs).toBe("29.99 USD");
    expect(savedBrief.verificationPlan[0].method).toBe("人工复核");
    expect(savedBrief.verificationPlan[0].status).toBe("done");

    // 数据库落盘读回（API 写后读 + 持久化）
    const raw = JSON.parse((await state.client!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: "p4-task-2" } })).resultJson);
    expect(raw.productBrief.specifications).toHaveLength(brief.specifications.length + 1);
    expect(raw.productBrief.confirmationItems[0].status).toBe("已确认");
    expect(raw.productBrief.verificationPlan[0].status).toBe("done");
    expect(JSON.stringify(raw.productBrief)).not.toContain("supplyChain");
  });

  it("P0-BR batch2: generate produces positioning/userScenarios and save round-trips positioning", async () => {
    const params = { params: Promise.resolve({ taskId: "p4-task-2" }) };
    const created = await writeBrief(request("/brief", { action: "generate" }), params);
    expect(created.status).toBe(201);
    const brief = (await created.json()).data.brief;
    // BR-02：定位段存在（研报搬运或显式 null，不编造）；场景段为只读数组（可为空）
    expect("positioning" in brief).toBe(true);
    if (brief.positioning) expect(["FACT", "ASSUMPTION", "EVIDENCE_DERIVED"]).toContain(brief.positioning.nature);
    expect(Array.isArray(brief.userScenarios)).toBe(true);
    if (brief.userScenarios.length > 0) expect(brief.userScenarios.every((item: { evidenceRefs: string[] }) => item.evidenceRefs.length > 0)).toBe(true);

    // 人工填写定位 → 保存 → 写后读；清空 → 保存 → 显式 null
    const saved = await writeBrief(request("/brief", {
      action: "save",
      status: "DRAFT",
      expectedRevision: brief.revision,
      positioning: { text: "人工填写的定位（假设）", nature: "ASSUMPTION", evidenceRefs: [] as string[] },
    }), params);
    expect(saved.status).toBe(200);
    expect((await saved.json()).data.brief.positioning.text).toBe("人工填写的定位（假设）");
    const cleared = await writeBrief(request("/brief", {
      action: "save",
      status: "DRAFT",
      expectedRevision: brief.revision + 1,
      positioning: null,
    }), params);
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).data.brief.positioning).toBeNull();
  });

  it("root report hash tampering is stale and cannot be confirmed", async () => {
    await generate(); const before = await stored(); before.v5Research.report.summary = "tampered";
    await state.client!.viralAnalysisRecord.update({ where: { id: taskId }, data: { resultJson: JSON.stringify(before) } });
    expect((await read()).reportStale).toBe(true); const denied = await write("choice", choice(await read())); expect(denied.status).toBe(409);
  });
});
