import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuthenticated: vi.fn(),
  readResearchTaskSnapshot: vi.fn(),
  buildResearchEngineInput: vi.fn(),
  runResearchEngine: vi.fn(),
  readStoredResearchReport: vi.fn(),
  saveResearchReport: vi.fn(),
  mapReportToLarkFields: vi.fn(),
}));

vi.mock("@/lib/server/demoGuard", () => ({ requireAuthenticated: mocks.requireAuthenticated }));
vi.mock("@/lib/server/research/researchInput", () => ({
  DEFAULT_RESEARCH_CONFIG: { locale: "zh-CN", focus: ["market", "competition", "voc", "differentiation"], maxTokens: 2400, timeoutMs: 45000 },
  buildResearchEngineInput: mocks.buildResearchEngineInput,
  readResearchTaskSnapshot: mocks.readResearchTaskSnapshot,
  ResearchV1InputError: class ResearchV1InputError extends Error {},
}));
vi.mock("@/lib/server/research/researchEngine", () => ({ runResearchEngine: mocks.runResearchEngine }));
vi.mock("@/lib/server/research/researchReportStore", () => ({
  readStoredResearchReport: mocks.readStoredResearchReport,
  saveResearchReport: mocks.saveResearchReport,
}));
vi.mock("@/lib/research/larkMapping", () => ({ mapReportToLarkFields: mocks.mapReportToLarkFields }));
vi.mock("@/lib/server/taskResultJsonMutation", () => ({
  TaskResultJsonMutationError: class TaskResultJsonMutationError extends Error {
    status = 409;
    code = "task_result_conflict";
  },
}));

import { GET, POST } from "./route";

const context = { params: Promise.resolve({ id: "task-1" }) };
const task = { id: "task-1", type: "workflow", decisionStatus: "pending", result: {}, updatedAt: "2026-09-19T00:00:00.000Z" };
const report = {
  schema: "research-report.v1",
  taskId: "task-1",
  decisionSummary: {
    researchPriority: "P2",
    recommendedNextAction: "补充数据",
    keyReasons: ["需要补充来源数据"],
    blockingRisks: ["成本缺失"],
    missingInformation: ["采购成本"],
  },
};

describe("Active Research V1 route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticated.mockReturnValue({ ok: true, context: { mode: "owner" } });
    mocks.readResearchTaskSnapshot.mockResolvedValue(task);
    mocks.readStoredResearchReport.mockReturnValue(null);
    mocks.buildResearchEngineInput.mockResolvedValue({
      taskId: "task-1",
      candidateId: "candidate-1",
      productFact: { subjectKey: "amazon:US:B0TESTV1", basic: {}, profit: {}, extended: {} },
      sourceEvidenceRefs: [{ refId: "evidence:v1-route", contentHash: "c".repeat(64), evidenceId: "v1-route" }],
    });
    mocks.runResearchEngine.mockResolvedValue({ report, reportHash: "hash", generatedAt: "2026-09-19T00:00:00.000Z", aiProviderCallStarted: true });
    mocks.saveResearchReport.mockResolvedValue({ report, reportHash: "hash", generatedAt: "2026-09-19T00:00:00.000Z" });
    mocks.mapReportToLarkFields.mockReturnValue({});
  });

  it("POST 只执行 Active Research Engine 并保存报告，保留认证入口", async () => {
    const response = await POST(new NextRequest("http://localhost/api/tasks/task-1/research-v1", { method: "POST", body: "{}" }), context);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.mode).toBe("generated");
    expect(mocks.runResearchEngine).toHaveBeenCalledTimes(1);
    expect(mocks.saveResearchReport).toHaveBeenCalledTimes(1);
    expect((mocks.saveResearchReport.mock.calls[0]?.[0] as { report: typeof report }).report.decisionSummary.researchPriority).toBe("P2");
    expect(mocks.mapReportToLarkFields).toHaveBeenCalledTimes(1);
  });

  it("已有报告默认不重复调用 DeepSeek，force 才重新执行", async () => {
    mocks.readStoredResearchReport.mockReturnValue({ report, reportHash: "old", generatedAt: "2026-09-18T00:00:00.000Z" });
    const existing = await POST(new NextRequest("http://localhost/api/tasks/task-1/research-v1", { method: "POST", body: "{}" }), context);
    expect((await existing.json()).data.mode).toBe("existing");
    expect(mocks.runResearchEngine).not.toHaveBeenCalled();

    const forced = await POST(new NextRequest("http://localhost/api/tasks/task-1/research-v1", { method: "POST", body: JSON.stringify({ force: true }) }), context);
    expect(forced.status).toBe(200);
    expect(mocks.runResearchEngine).toHaveBeenCalledTimes(1);
  });

  it("未通过认证时不读取任务、不调用 Research", async () => {
    mocks.requireAuthenticated.mockReturnValue({ ok: false, status: 401, code: "unauthorized", message: "未授权" });
    const response = await GET(new NextRequest("http://localhost/api/tasks/task-1/research-v1"), context);
    expect(response.status).toBe(401);
    expect(mocks.readResearchTaskSnapshot).not.toHaveBeenCalled();
  });
});
