import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { checkedInMigrationNames, replayAllCheckedInMigrations } from "@/lib/marketScan/__fixtures__/migrationReplay";
const state = vi.hoisted(() => ({ client: null as PrismaClient | null, provider: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ prisma: new Proxy({}, { get(_target, key) {
  if (!state.client) throw new Error("disposable_database_not_ready");
  const value = Reflect.get(state.client, key); return typeof value === "function" ? value.bind(state.client) : value;
} }) }));
vi.mock("@/lib/server/aiClient", () => ({ getAiConfig: () => ({ ok: true, data: { provider: "deepseek" } }), callAiJson: state.provider }));
import { seedP4ReadPath } from "@/lib/server/__fixtures__/p4ReadPathFixture";
import { GET as readRoute } from "@/app/api/research/[taskId]/route";
import { GET as listRoute } from "@/app/api/research/route";
import { POST as writeRoute } from "@/app/api/research/[taskId]/[action]/route";
import { PATCH as legacyPatch } from "@/app/api/tasks/[id]/route";
import { canonicalToDbDecisionStatus, type CanonicalDecisionStatus } from "@/lib/types/v5DecisionStatus";
let root: string;
const taskId = "p4-task-0";
function req(path: string, body?: unknown, key = crypto.randomUUID(), method = "POST") {
  return new NextRequest("http://localhost:3011" + path, { method: body === undefined ? "GET" : method,
    headers: { host: "localhost:3011", origin: "http://localhost:3011", "content-type": "application/json", "Idempotency-Key": key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function row() { return state.client!.viralAnalysisRecord.findUniqueOrThrow({ where: { id: taskId } }); }
async function read() { return (await (await readRoute(req("/api/research/" + taskId), { params: Promise.resolve({ taskId }) })).json()).data; }
async function act(action: string, body: unknown, key?: string) { return writeRoute(req(`/api/research/${taskId}/${action}`, body, key), { params: Promise.resolve({ taskId, action }) }); }
function choice(detail: Awaited<ReturnType<typeof read>>, canonicalStatus: CanonicalDecisionStatus = "PROCEED") {
  return { canonicalStatus, reason: "Owner 已检查当前证据", expectedVersion: detail.resourceVersion,
    readinessAcknowledged: true,
    expectedRevision: detail.researchRevision, expectedReportHash: detail.reportHash, expectedFactHash: detail.factHash, expectedEvidenceHash: detail.evidenceHash };
}
async function generate(confirm = false) { return act("advisory", { expectedRevision: (await read()).researchRevision, requested: ["deepseek_summary"], confirmFinalAdvisoryRegeneration: confirm }); }
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "v5-p5-research-")); const path = join(root, "fixture.db"), db = new DatabaseSync(path);
  try { expect(replayAllCheckedInMigrations(db)).toHaveLength(checkedInMigrationNames().length); } finally { db.close(); }
  state.client = new PrismaClient({ datasources: { db: { url: "file:" + path.replaceAll("\\", "/") } } });
  vi.stubEnv("SOURCE_LAYER_STORE_DIR", join(root, "evidence")); vi.stubEnv("V5_RESEARCH_PROVIDER", "");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external_network_forbidden"); }));
  await seedP4ReadPath(state.client);
  const task = await row(), data = JSON.parse(task.resultJson);
  Object.assign(data.v5Research, { report: null, reportHash: null, researchRevision: 0, myChoice: null });
  await state.client.viralAnalysisRecord.update({ where: { id: taskId }, data: { resultJson: JSON.stringify(data), decisionStatus: "pending" } });
  state.provider.mockReset(); state.provider.mockImplementation(async (input) => {
    const refs = JSON.parse(input.messages[1].content).allowedEvidenceRefs;
    return { ok: true, data: { summary: { text: "离线且有来源引用的研究", evidenceRefs: [refs[0]] }, opportunities: [], risks: [],
      vocAnalysis: { painPoints: [], positiveSignals: [], failureModes: [], useCases: [], replacementSignals: [], switchReasons: [], ownershipClaims: [] },
      citations: [{ quote: "来源观察", source: refs[0] }] } };
  });
});
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await state.client?.$disconnect(); state.client = null; rmSync(root, { recursive: true, force: true }); });

describe("P5 Research Created -> Generated -> Needs Decision -> Human Final with real SQLite CAS", () => {
  it.each(["PROCEED", "VALIDATE_MORE", "PAUSE", "DROP"] as const)("%s is explicit Human authority; advisory cannot change it", async status => {
    const premature = await act("choice", choice(await read(), status));
    expect(premature.status).toBe(409); expect((await premature.json()).error.code).toBe("RESEARCH_REPORT_REQUIRED");
    const generated = await generate(); expect(generated.status).toBe(200);
    expect((await generated.json()).data.deepseek.status).toBe("available");
    expect((await row()).decisionStatus).toBe("pending"); expect((await read()).myChoice).toBeNull();
    const list = (await (await listRoute(req("/api/research?view=needs_decision"))).json()).data;
    expect(list.items.some((item: { taskId: string }) => item.taskId === taskId)).toBe(true);
    const saved = await act("choice", choice(await read(), status)); expect(saved.status).toBe(200);
    const before = await row(), human = JSON.parse(before.resultJson).v5Research.myChoice;
    expect(human.canonicalStatus).toBe(status); expect(before.decisionStatus).toBe(canonicalToDbDecisionStatus(status));
    expect((await generate(true)).status).toBe(200);
    const after = await row(); expect(after.decisionStatus).toBe(before.decisionStatus);
    expect(JSON.parse(after.resultJson).v5Research.myChoice).toEqual(human);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("missing expectedVersion cannot bypass human decision CAS", async () => {
    await generate(); const data = choice(await read()); delete (data as Partial<typeof data>).expectedVersion;
    const before = await row(), response = await act("choice", data);
    expect(response.status).toBe(400); expect((await response.json()).error.code).toBe("EXPECTED_VERSION_REQUIRED");
    expect((await row()).resultJson).toBe(before.resultJson);
  });
  it("a second decision with an old page version cannot overwrite the first even when all report hashes match", async () => {
    await generate(); const detail = await read(); expect((await act("choice", choice(detail, "PROCEED"))).status).toBe(200);
    const before = await row(); const stale = await act("choice", choice(detail, "DROP"));
    expect(stale.status).toBe(409); expect((await stale.json()).error.code).toBe("CAS_CONFLICT");
    expect((await row()).resultJson).toBe(before.resultJson);
  });
  it("one current version has one concurrent winner", async () => {
    await generate(); const detail = await read(), data = choice(detail), key = crypto.randomUUID();
    const responses = await Promise.all([act("choice", data, key), act("choice", choice(detail, "DROP"))]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const loser = responses.find(r => r.status === 409)!;
    expect(["CAS_CONFLICT", "CHOICE_CAS_CONFLICT"]).toContain((await loser.json()).error.code);
  });
  it("same idempotency key replays without another write; changed payload conflicts", async () => {
      await generate(); const data = choice(await read()), key = crypto.randomUUID();
      expect((await act("choice", data, key)).status).toBe(200);
      const before = await row(), replay = await act("choice", data, key);
      expect(replay.status).toBe(200); expect((await replay.json()).data.replayed).toBe(true);
      expect(await row()).toEqual(before);
      const conflict = await act("choice", { ...data, canonicalStatus: "DROP" }, key);
      expect(conflict.status).toBe(409); expect((await conflict.json()).error.code).toBe("IDEMPOTENCY_KEY_REUSE");
  });
  it("AI decision fields are rejected and cannot create Human Decision or a formal report", async () => {
    state.provider.mockResolvedValue({ ok: true, data: { summary: { text: "AI 决策", evidenceRefs: [] }, opportunities: [], risks: [], citations: [], myChoice: { canonicalStatus: "DROP" }, decisionStatus: "rejected" } });
    const response = await generate(); expect(response.status).toBe(200);
    expect((await response.json()).data.deepseek).toMatchObject({ status: "failed", errorCode: "PROVIDER_SCHEMA_VALIDATION_ERROR" });
    const current = await read(); expect(current.report).toBeNull(); expect(current.myChoice).toBeNull();
    expect((await row()).decisionStatus).toBe("pending");
  });
  it("模型失败时不覆盖已有正式报告与人工决定，也不推进研究版本", async () => {
    expect((await generate()).status).toBe(200);
    expect((await act("choice", choice(await read(), "PROCEED"))).status).toBe(200);
    const withReportAndDecision = await row();
    const beforeRoot = JSON.parse(withReportAndDecision.resultJson).v5Research;
    expect(beforeRoot.reportHash).toBeTruthy();

    // 模型超时/失败：路由仍返回可读状态，但不得产出新报告
    state.provider.mockResolvedValue({ ok: false, error: { code: "PROVIDER_TIMEOUT" }, diagnostics: { responseFailureClass: "timeout" } });
    const failed = await generate(true);
    expect(failed.status).toBe(200);
    expect((await failed.json()).data.deepseek).toMatchObject({ status: "failed", errorCode: "PROVIDER_TIMEOUT" });

    const after = await row();
    const afterRoot = JSON.parse(after.resultJson).v5Research;
    expect(afterRoot.reportHash).toBe(beforeRoot.reportHash);
    expect(afterRoot.researchRevision).toBe(beforeRoot.researchRevision);
    expect(afterRoot.report).toEqual(beforeRoot.report);
    expect(afterRoot.myChoice).toEqual(beforeRoot.myChoice);
    expect(after.decisionStatus).toBe(withReportAndDecision.decisionStatus);
  });

  it("真实 SQLite 写入失败不误报成功且保留旧内容；修复后重试只推进一次版本", async () => {
    expect((await generate()).status).toBe(200);
    const before = await row();
    const beforeRoot = JSON.parse(before.resultJson).v5Research;

    // 真实数据库故障注入：任何对该表的 UPDATE 都直接 ABORT
    await state.client!.$executeRawUnsafe(
      "CREATE TRIGGER p5_inject_write_failure BEFORE UPDATE ON ViralAnalysisRecord BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;",
    );
    const failed = await generate(true);
    expect(failed.status).toBeGreaterThanOrEqual(400);
    const afterFailure = await row();
    expect(afterFailure.resultJson).toBe(before.resultJson);
    expect(afterFailure.decisionStatus).toBe(before.decisionStatus);

    // 解除注入后重试：必须真正落盘，且只推进一个版本
    await state.client!.$executeRawUnsafe("DROP TRIGGER p5_inject_write_failure;");
    const retried = await generate(true);
    expect(retried.status).toBe(200);
    expect((await retried.json()).data.deepseek.status).toBe("available");
    const afterRetry = await row();
    const afterRoot = JSON.parse(afterRetry.resultJson).v5Research;
    expect(afterRoot.researchRevision).toBe(beforeRoot.researchRevision + 1);
    // 替身输出确定，内容相同则 reportHash 相同（内容寻址），这里只校验确实有报告与来源绑定
    expect(typeof afterRoot.reportHash).toBe("string");
    expect(afterRoot.reportBindingHashes?.factHash).toBeTruthy();
    expect(JSON.parse(afterRetry.resultJson).v5Research.myChoice).toBeNull();
  });

  it.each([null, "malformed", {}])("legacy PATCH rejects presence of v5Research namespace (%j) with no direct state write", async namespace => {
    const task = await row(), data = JSON.parse(task.resultJson); data.v5Research = namespace;
    const resultJson = JSON.stringify(data); await state.client!.viralAnalysisRecord.update({ where: { id: taskId }, data: { resultJson } });
    const response = await legacyPatch(req("/api/tasks/" + taskId, { decisionStatus: "continue" }, undefined, "PATCH"), { params: Promise.resolve({ id: taskId }) });
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("versioned_research_decision_route_required");
    expect((await row()).resultJson).toBe(resultJson); expect((await row()).decisionStatus).toBe("pending");
  });
});
