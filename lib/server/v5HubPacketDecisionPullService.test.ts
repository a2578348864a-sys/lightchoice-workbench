import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ find: vi.fn(), update: vi.fn(), fields: vi.fn(), search: vi.fn(), remoteUpdate: vi.fn(), config: vi.fn(), detail: vi.fn(), concept: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ prisma: { viralAnalysisRecord: { findUnique: mocks.find, updateMany: mocks.update } } }));
vi.mock("@/lib/integrations/lark/baseClient", async original => ({ ...await original<typeof import("@/lib/integrations/lark/baseClient")>(),
  listTableFields: mocks.fields, searchTableRecords: mocks.search, batchUpdateRecords: mocks.remoteUpdate }));
vi.mock("@/lib/integrations/lark/config", () => ({ getLarkConfig: mocks.config }));
vi.mock("@/lib/server/v5ResearchService", () => ({ getResearchDetail: mocks.detail }));
vi.mock("@/lib/server/productConceptV5Service", () => ({ readProductConceptV5: mocks.concept }));
vi.mock("@/lib/server/v5CoreCommon", async original => ({ ...await original<typeof import("@/lib/server/v5CoreCommon")>(),
  withV5Receipt: async (input: { execute: () => Promise<unknown> }) => ({ value: await input.execute(), replayed: false }) }));
import { LarkApiError } from "@/lib/integrations/lark/baseClient";
import { pullV5HubHumanDecisions, ensureT01DecisionMirror } from "@/lib/server/v5HubDecisionPullService";
import { hashJson } from "@/lib/server/v5CoreCommon";
import { V5_HUB_AUTHORIZED_TEST_BASE_ID, V5_HUB_TEST_BASE_TABLE_IDS } from "@/lib/integrations/lark/v5HubConfig";
import { V5_HUB_TABLES } from "@/lib/integrations/lark/v5HubSchema";
import { parseV5HubPacketDecisionRecord } from "@/lib/integrations/lark/v5HubPacketDecisionPull";
const context = { mode: "owner", token: "" } as const;
const factHash = "a".repeat(64), packetEvidenceHash = "b".repeat(64), packetHash = "c".repeat(64), report = { schema: "research-report.v5", summary: "unit fixture" };
const config = { appId: "fixture", appSecret: "fixture", appToken: V5_HUB_AUTHORIZED_TEST_BASE_ID, tableId: V5_HUB_TEST_BASE_TABLE_IDS.T02, openApiDomain: "https://open.feishu.cn" };
let task: any, records: any[], concepts: any[];
function record(fields: Record<string, unknown> = {}, id = "rec_t02_1") { const now = Date.parse("2026-10-01T03:00:00.000Z"); return { record_id: id, fields: {
  "主体键": "amazon:US:B07G4VTV2F", "任务 ID": "task-1", "ASIN": "B07G4VTV2F", "销售站点": "US", "修订版本": 1,
  "研究包哈希": packetHash, "事实哈希": factHash, "证据哈希": packetEvidenceHash, "人工决策": "通过", "决策备注": "建议推进",
  ...fields }, last_modified_by: { id: "ou_fixture" }, last_modified_time: now }; }
function root() { return JSON.parse(task.resultJson); }
function mutate(transform: (value: any) => void) { const value = root(); transform(value); task.resultJson = JSON.stringify(value); }
function pull() { return pullV5HubHumanDecisions({ context, idempotencyKey: crypto.randomUUID() }); }
beforeEach(() => {
  vi.clearAllMocks(); const binding = { schemaVersion: "v5-hub-packet-binding.v1", status: "active", taskId: "task-1", subjectKey: "amazon:US:B07G4VTV2F", revision: 1,
    packetHash, reportHash: hashJson(report), factHash, evidenceHash: packetEvidenceHash, recordId: "rec_t02_1", projectedAt: "2026-10-01T02:00:00.000Z", provenance: "PROJECTION" };
  task = { id: "task-1", type: "workflow", updatedAt: new Date("2026-10-01T02:00:00.000Z"), decisionStatus: "rejected", resultJson: JSON.stringify({ preserveUnknown: { keep: true },
    v5Research: { asin: "B07G4VTV2F", marketplace: "US", researchRevision: 1, report, reportHash: hashJson(report), factHash,
      evidenceHash: "d".repeat(64), feishuHubPacketBinding: binding, myChoice: { canonicalStatus: "DROP", choice: "DROP", scope: "FINAL" } } }) };
  records = [record()]; concepts = [];
  mocks.config.mockReturnValue({ ok: true, config }); mocks.detail.mockResolvedValue({ reportStale: false });
  mocks.find.mockImplementation(async () => ({ ...task }));
  mocks.update.mockImplementation(async ({ where, data }: any) => {
    if (where.resultJson !== task.resultJson || +where.updatedAt !== +task.updatedAt) return { count: 0 };
    task = { ...task, ...data }; return { count: 1 };
  });
  mocks.fields.mockImplementation(async ({ tableId }: any) => [{ fieldId: "primary", fieldName: "记录名称", type: 1, uiType: "Text", isPrimary: true },
    ...V5_HUB_TABLES.find(table => table.id === (tableId === V5_HUB_TEST_BASE_TABLE_IDS.T02 ? "T02" : "T05"))!.fields.map((field, index) => ({
      fieldId: "fld_" + index, fieldName: field.displayName, type: field.name === "decision" ? 3 : field.kind === "number" ? 2 : field.kind === "datetime" ? 5 : 1, uiType: field.kind }))]);
  mocks.search.mockImplementation(async ({ tableId }: any) => tableId === V5_HUB_TEST_BASE_TABLE_IDS.T02 ? records : tableId === V5_HUB_TEST_BASE_TABLE_IDS.T05 ? concepts : []);
});
describe("P7 team recommendation Pull guard matrix (DB and Lark unit doubles)", () => {
  it("requires owner", async () => { await expect(pullV5HubHumanDecisions({ context: { mode: "anonymous", token: "" } as any, idempotencyKey: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" }); });
  it("receives a proposal while preserving local final decision and never mirrors T01", async () => {
    const before = root().v5Research.myChoice, result = await pull(); expect(result.recommendationsReceived).toBe(1); expect(result.applied).toBe(0);
    expect(root().v5Research.myChoice).toEqual(before); expect(task.decisionStatus).toBe("rejected"); expect(root().preserveUnknown).toEqual({ keep: true });
    expect(root().v5Research.teamRecommendation).toMatchObject({ status: "VERIFIED_TEAM_RECOMMENDATION", recommendationStatus: "RECOMMEND_PROCEED" });
    expect(mocks.remoteUpdate).not.toHaveBeenCalled(); expect(mocks.search.mock.calls.some(([arg]) => arg.tableId === V5_HUB_TEST_BASE_TABLE_IDS.T01)).toBe(false);
  });
  it("same proposal replay is unchanged, including after Workbench review", async () => {
    await pull(); mutate(value => { value.v5Research.teamRecommendation.status = "OVERRIDDEN"; }); const before = task.resultJson;
    mocks.update.mockClear(); const result = await pull(); expect(result.unchanged).toBe(1); expect(result.recommendationsReceived).toBe(0); expect(task.resultJson).toBe(before); expect(mocks.update).not.toHaveBeenCalled();
  });
  it("missing active packet binding rejects before CAS", async () => { mutate(value => delete value.v5Research.feishuHubPacketBinding); await expect(pull()).rejects.toMatchObject({ code: "FEISHU_DECISION_PACKET_BINDING_MISSING" }); expect(mocks.update).not.toHaveBeenCalled(); });
  it.each(["研究包哈希", "事实哈希", "证据哈希", "主体键", "修订版本", "ASIN", "销售站点"])("rejects mismatched %s with all Human Decision fields unchanged", async field => {
    records = [record({ [field]: field === "修订版本" ? 2 : field.endsWith("哈希") ? "f".repeat(64) : "different" })]; const before = task.resultJson;
    await expect(pull()).rejects.toMatchObject({ code: "FEISHU_DECISION_BINDING_STALE", status: 409 }); expect(task.resultJson).toBe(before); expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each(["report", "reportHash"])("missing %s rejects at E-1 before packet guard", async key => { mutate(value => delete value.v5Research[key]); await expect(pull()).rejects.toMatchObject({ code: "RESEARCH_REPORT_REQUIRED" }); });
  it("report hash tampering rejects", async () => { mutate(value => { value.v5Research.report.summary = "tampered"; }); await expect(pull()).rejects.toMatchObject({ code: "RESEARCH_REPORT_REQUIRED" }); });
  it("stale evidence rejects", async () => { mocks.detail.mockResolvedValue({ reportStale: true }); await expect(pull()).rejects.toMatchObject({ code: "RESEARCH_EVIDENCE_STALE" }); });
  it("newer remote recommendation is pending, older advice cannot overwrite it", async () => {
    await pull(); mutate(value => { value.v5Research.teamRecommendation.reviewedAt = "2026-10-01T05:00:00.000Z"; value.v5Research.teamRecommendation.id = "newer"; });
    await expect(pull()).rejects.toMatchObject({ code: "TEAM_RECOMMENDATION_STALE" });
  });
  it("credentials missing fails closed", async () => { mocks.config.mockReturnValue({ ok: false, missingKeys: ["LARK_APP_ID"] }); await expect(pull()).rejects.toMatchObject({ code: "FEISHU_CREDENTIAL_MISSING", status: 503 }); });
  it("wrong base fails closed", async () => { mocks.config.mockReturnValue({ ok: true, config: { ...config, appToken: "wrong" } }); await expect(pull()).rejects.toMatchObject({ code: "V5_HUB_WRONG_BASE", status: 403 }); });
  it("duplicate record ID fails before any writes", async () => { records.push(record()); await expect(pull()).rejects.toMatchObject({ code: "FEISHU_DECISION_DUPLICATE_RECORD" }); expect(mocks.update).not.toHaveBeenCalled(); });
  it("duplicate task ID fails before any writes", async () => { records.push(record({}, "different")); await expect(pull()).rejects.toMatchObject({ code: "FEISHU_DECISION_DUPLICATE_TASK" }); expect(mocks.update).not.toHaveBeenCalled(); });
  it.each([[500, 503], [403, 403], [429, 429]])("external read %s keeps exact failure HTTP %s", async (remote, local) => {
    mocks.search.mockRejectedValue(new LarkApiError("NETWORK_ERROR", "fixture unavailable", remote)); await expect(pull()).rejects.toMatchObject({ code: "FEISHU_DECISION_READ_FAILED", status: local });
  });
  it("schema drift fails closed", async () => { mocks.fields.mockResolvedValue([]); await expect(pull()).rejects.toMatchObject({ code: "V5_HUB_SCHEMA_DRIFT" }); });
  it("CAS failure leaves human state unchanged", async () => { mocks.update.mockResolvedValue({ count: 0 }); const before = task.resultJson; await expect(pull()).rejects.toMatchObject({ code: "CHOICE_CAS_CONFLICT" }); expect(task.resultJson).toBe(before); });
  it.each([["e", "c", false], ["c", "e", false], ["e", "e", true]])("stored binding %s and remote packet %s comparison; accepted=%s", async (bound, remote, accepted) => {
    mutate(value => { value.v5Research.feishuHubPacketBinding.packetHash = bound.repeat(64); }); records = [record({ "研究包哈希": remote.repeat(64) })];
    if (accepted) expect((await pull()).recommendationsReceived).toBe(1); else await expect(pull()).rejects.toMatchObject({ code: "FEISHU_DECISION_BINDING_STALE" });
  });
  it("malformed optional T05 is isolated and actual buckets reconcile", async () => {
    concepts = [{ record_id: "rec_bad", fields: { "人工决策": "通过" } }, { record_id: "rec_pending", fields: { "人工决策": "未审核" } }];
    const result = await pull(); expect(result).toMatchObject({ scannedRecords: 3, recommendationsReceived: 1, failedOrSkipped: 1, pendingReview: 1, unaccounted: 0, applied: 0 });
  });
  it("optional T05 unavailable is explicitly reported while T02 recommendation remains pending", async () => {
    mocks.fields.mockImplementation(async ({ tableId }: any) => { if (tableId === V5_HUB_TEST_BASE_TABLE_IDS.T05) throw new Error("fixture unavailable");
      return [{ fieldId: "primary", fieldName: "记录名称", type: 1, isPrimary: true }, ...V5_HUB_TABLES.find(table => table.id === "T02")!.fields.map((f, i) => ({ fieldId: "f" + i, fieldName: f.displayName, type: f.name === "decision" ? 3 : f.kind === "number" ? 2 : f.kind === "datetime" ? 5 : 1 }))]; });
    expect(await pull()).toMatchObject({ recommendationsReceived: 1, conceptStatus: "UNAVAILABLE", applied: 0 });
  });
});
// Retain the historical receipt compensation helper contract; new Pull never calls this helper.
describe("legacy T01 mirror helper preserves its three convergence outcomes", () => {
  it("failed remote mirror is reported truthfully", async () => {
    mocks.search.mockRejectedValue(new LarkApiError("NETWORK_ERROR", "fixture timeout", 500));
    expect(await ensureT01DecisionMirror(config, parseV5HubPacketDecisionRecord(record())!, true)).toMatchObject({ status: "MIRROR_FAILED" });
  });
  it("recovered mirror updates the exact status", async () => {
    mocks.search.mockResolvedValue([{ record_id: "rec_t01", fields: { "主体键": "amazon:US:B07G4VTV2F", "决策状态": "PENDING_HUMAN_REVIEW" } }]); mocks.remoteUpdate.mockResolvedValue([]);
    expect(await ensureT01DecisionMirror(config, parseV5HubPacketDecisionRecord(record())!, false)).toMatchObject({ status: "MIRROR_RECOVERED", decisionStatus: "PROCEED" });
    expect(mocks.remoteUpdate).toHaveBeenCalledWith(expect.objectContaining({ tableId: V5_HUB_TEST_BASE_TABLE_IDS.T01 }), [{ record_id: "rec_t01", fields: { "决策状态": "PROCEED" } }]);
  });
  it("matching mirror makes zero writes", async () => {
    mocks.search.mockResolvedValue([{ record_id: "rec_t01", fields: { "主体键": "amazon:US:B07G4VTV2F", "决策状态": "PROCEED" } }]);
    expect(await ensureT01DecisionMirror(config, parseV5HubPacketDecisionRecord(record())!, false)).toMatchObject({ status: "MIRROR_UNCHANGED" }); expect(mocks.remoteUpdate).not.toHaveBeenCalled();
  });
});
