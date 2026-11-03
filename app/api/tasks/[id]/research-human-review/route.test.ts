import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuthenticated: vi.fn(),
  readResearchTaskSnapshot: vi.fn(),
  readStoredResearchReport: vi.fn(),
  readStoredResearchDecision: vi.fn(),
  saveResearchHumanReview: vi.fn(),
}));

vi.mock("@/lib/server/demoGuard", () => ({ requireAuthenticated: mocks.requireAuthenticated }));
vi.mock("@/lib/server/research/researchInput", () => ({
  readResearchTaskSnapshot: mocks.readResearchTaskSnapshot,
  ResearchV1InputError: class ResearchV1InputError extends Error {
    code = "task_not_found";
    status = 404;
  },
}));
vi.mock("@/lib/server/research/researchReportStore", () => ({
  readStoredResearchReport: mocks.readStoredResearchReport,
}));
vi.mock("@/lib/server/research/researchHumanReviewStore", () => ({
  readStoredResearchDecision: mocks.readStoredResearchDecision,
  RESEARCH_HUMAN_REVIEW_NOTES_MAX_LENGTH: 2000,
  saveResearchHumanReview: mocks.saveResearchHumanReview,
}));
vi.mock("@/lib/server/taskResultJsonMutation", () => ({
  TaskResultJsonMutationError: class TaskResultJsonMutationError extends Error {
    status: number;
    code: string;

    constructor(code: string, status: number, message: string) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));

import { GET, POST } from "./route";

const context = { params: Promise.resolve({ id: "task-1" }) };
const reportHash = "a".repeat(64);
const storageVersion = {
  resultJsonHash: "b".repeat(64),
  updatedAt: "2026-09-19T10:00:00.000Z",
};
const report = {
  schema: "research-report.v1",
  generatedAt: "2026-09-19T09:00:00.000Z",
};
const decision = {
  status: "continue" as const,
  nextAction: "continue_research" as const,
  notes: "继续验证竞品差异。",
  updatedAt: "2026-09-19T10:01:00.000Z",
  updatedBy: "owner",
  reviewedReportHash: reportHash,
};

describe("Research Human Review API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticated.mockReturnValue({ ok: true, context: { mode: "owner", token: "owner-token" } });
    mocks.readResearchTaskSnapshot.mockResolvedValue({
      id: "task-1",
      type: "workflow",
      decisionStatus: "pending",
      resultJson: JSON.stringify({ researchReport: { reportJson: report, reportHash, generatedAt: report.generatedAt } }),
      result: { researchReport: { reportJson: report, reportHash, generatedAt: report.generatedAt } },
      updatedAt: new Date(storageVersion.updatedAt),
    });
    mocks.readStoredResearchReport.mockReturnValue({ report, reportHash, generatedAt: report.generatedAt });
    mocks.readStoredResearchDecision.mockReturnValue(null);
    mocks.saveResearchHumanReview.mockResolvedValue({ decision, storageVersion });
  });

  it("POST 保存人工复核意见，不调用正式 Decision 或 Research 执行链路", async () => {
    const response = await POST(new NextRequest("http://localhost/api/tasks/task-1/research-human-review", {
      method: "POST",
      body: JSON.stringify({
        expectedStorageVersion: storageVersion,
        status: "continue",
        nextAction: "continue_research",
        notes: "继续验证竞品差异。",
      }),
    }), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      data: { taskId: "task-1", decision, reportHash, reviewStale: false, storageVersion },
    });
    expect(mocks.saveResearchHumanReview).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      decision: expect.objectContaining({
        status: "continue",
        nextAction: "continue_research",
        notes: "继续验证竞品差异。",
        updatedBy: "owner",
        // RESEARCH-001：客户端未声明指纹 → 传 null，由服务端绑定当前报告
        reviewedReportHash: null,
      }),
      expectedStorageVersion: storageVersion,
    }));
  });

  it("RESEARCH-001：客户端声明了其他报告指纹时透传，交由存储层拒绝", async () => {
    const response = await POST(new NextRequest("http://localhost/api/tasks/task-1/research-human-review", {
      method: "POST",
      body: JSON.stringify({
        expectedStorageVersion: storageVersion,
        status: "continue",
        nextAction: "continue_research",
        notes: "基于旧报告的意见",
        reviewedReportHash: "c".repeat(64),
      }),
    }), context);

    expect(response.status).toBe(200);
    expect(mocks.saveResearchHumanReview).toHaveBeenCalledWith(expect.objectContaining({
      decision: expect.objectContaining({ reviewedReportHash: "c".repeat(64) }),
    }));
  });

  it("GET 刷新时恢复人工复核意见与当前存储版本", async () => {
    mocks.readStoredResearchDecision.mockReturnValue(decision);
    const response = await GET(new NextRequest("http://localhost/api/tasks/task-1/research-human-review"), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.decision).toEqual(decision);
    expect(body.data.reportHash).toBe(reportHash);
    expect(body.data.reviewStale).toBe(false);
    expect(body.data.storageVersion.resultJsonHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("未通过认证时拒绝读取和保存", async () => {
    mocks.requireAuthenticated.mockReturnValue({ ok: false, status: 401, code: "unauthorized", message: "未授权" });

    const getResponse = await GET(new NextRequest("http://localhost/api/tasks/task-1/research-human-review"), context);
    const postResponse = await POST(new NextRequest("http://localhost/api/tasks/task-1/research-human-review", {
      method: "POST",
      body: JSON.stringify({}),
    }), context);

    expect(getResponse.status).toBe(401);
    expect(postResponse.status).toBe(401);
    expect(mocks.readResearchTaskSnapshot).not.toHaveBeenCalled();
    expect(mocks.saveResearchHumanReview).not.toHaveBeenCalled();
  });

  it("拒绝没有 ResearchReport 的人工复核保存", async () => {
    mocks.readStoredResearchReport.mockReturnValue(null);
    const response = await POST(new NextRequest("http://localhost/api/tasks/task-1/research-human-review", {
      method: "POST",
      body: JSON.stringify({
        expectedStorageVersion: storageVersion,
        status: "pause",
        nextAction: "stop",
        notes: "暂无报告。",
      }),
    }), context);

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("research_report_required");
    expect(mocks.saveResearchHumanReview).not.toHaveBeenCalled();
  });

  it("不接受客户端伪造 updatedAt / updatedBy", async () => {
    const response = await POST(new NextRequest("http://localhost/api/tasks/task-1/research-human-review", {
      method: "POST",
      body: JSON.stringify({
        expectedStorageVersion: storageVersion,
        status: "pending",
        nextAction: "collect_more_data",
        notes: "补数据。",
        updatedAt: "forged",
        updatedBy: "forged-user",
      }),
    }), context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_body");
    expect(mocks.saveResearchHumanReview).not.toHaveBeenCalled();
  });
});
