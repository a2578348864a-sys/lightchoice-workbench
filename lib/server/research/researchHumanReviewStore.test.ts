import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutateTaskResultJson: vi.fn(),
  readStoredResearchReport: vi.fn(),
}));

vi.mock("@/lib/server/taskResultJsonMutation", () => ({
  mutateTaskResultJson: mocks.mutateTaskResultJson,
  TaskResultJsonMutationError: class TaskResultJsonMutationError extends Error {
    code: string;
    status: number;

    constructor(code: string, status: number, message: string) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));
vi.mock("./researchReportStore", () => ({
  readStoredResearchReport: mocks.readStoredResearchReport,
}));

import {
  isStoredResearchDecision,
  readStoredResearchDecision,
  saveResearchHumanReview,
} from "./researchHumanReviewStore";
import { isResearchReviewStale } from "@/lib/research/researchContracts";

const decision = {
  status: "need_more_validation" as const,
  nextAction: "collect_more_data" as const,
  notes: "补充成本与竞品验证。",
  updatedAt: "2026-09-19T10:00:00.000Z",
  updatedBy: "owner",
  reviewedReportHash: null,
};
const expectedStorageVersion = {
  resultJsonHash: "a".repeat(64),
  updatedAt: "2026-09-19T09:00:00.000Z",
};

describe("research human review store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readStoredResearchReport.mockReturnValue({
      report: { schema: "research-report.v1" },
      reportHash: "b".repeat(64),
      generatedAt: "2026-09-19T08:00:00.000Z",
    });
    mocks.mutateTaskResultJson.mockResolvedValue({
      resultJson: JSON.stringify({ researchDecision: decision }),
      value: decision,
      updatedAt: "2026-09-19T10:00:01.000Z",
    });
  });

  it("只通过 research-human-review writer 写入独立 namespace，并要求 CAS", async () => {
    const result = await saveResearchHumanReview({
      context: { mode: "owner", token: "owner-token" },
      taskId: "task-1",
      decision,
      expectedStorageVersion,
    });

    expect(result.decision).toEqual(decision);
    expect(result.storageVersion.resultJsonHash).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.mutateTaskResultJson).toHaveBeenCalledWith(expect.objectContaining({
      writer: "research-human-review",
      expectedStorageVersion,
    }));
  });

  it("读取合法复核意见，拒绝伪造或缺失字段", () => {
    expect(isStoredResearchDecision(decision)).toBe(true);
    expect(readStoredResearchDecision({ researchDecision: decision })).toEqual(decision);
    expect(readStoredResearchDecision({ researchDecision: { ...decision, updatedBy: "" } })).toBeNull();
    expect(readStoredResearchDecision({ researchDecision: { ...decision, status: "automatic" } })).toBeNull();
  });

  it("RESEARCH-001：服务端强制绑定复核指纹，客户端声明不一致时拒绝", async () => {
    mocks.mutateTaskResultJson.mockImplementation(async (input: {
      mutate: (current: unknown) => { result: unknown; value: { reviewedReportHash: string | null } };
    }) => {
      const mutated = input.mutate({});
      return {
        resultJson: JSON.stringify(mutated.result),
        value: mutated.value,
        updatedAt: "2026-09-19T10:00:01.000Z",
      };
    });

    const storedHash = "b".repeat(64);
    const saved = await saveResearchHumanReview({
      context: { mode: "owner", token: "owner-token" },
      taskId: "task-1",
      decision: { ...decision, reviewedReportHash: null },
      expectedStorageVersion,
    });
    // 客户端未声明（null）时，由服务端写入当前报告指纹
    expect(saved.decision.reviewedReportHash).toBe(storedHash);

    // 客户端声明了另一个报告指纹 → 说明它基于旧报告，必须拒绝
    await expect(saveResearchHumanReview({
      context: { mode: "owner", token: "owner-token" },
      taskId: "task-1",
      decision: { ...decision, reviewedReportHash: "c".repeat(64) },
      expectedStorageVersion,
    })).rejects.toMatchObject({ code: "research_review_report_stale" });
  });

  it("RESEARCH-001：历史复核缺 reviewedReportHash 时读取归一为 null（判为过期）", () => {
    const legacy = {
      status: "continue",
      nextAction: "continue_research",
      notes: "旧版复核",
      updatedAt: "2026-09-19T10:00:00.000Z",
      updatedBy: "owner",
    };
    const restored = readStoredResearchDecision({ researchDecision: legacy });
    expect(restored).toEqual({ ...legacy, reviewedReportHash: null });
    expect(isResearchReviewStale(restored, "d".repeat(64))).toBe(true);
  });

  it("权限与结构边界：拒绝非法的人工复核输入结构（400 invalid_research_human_review）", async () => {
    // 缺失必填字段
    await expect(saveResearchHumanReview({
      context: { mode: "owner", token: "owner-token" },
      taskId: "task-1",
      decision: { ...decision, updatedBy: "" },
      expectedStorageVersion,
    })).rejects.toMatchObject({ code: "invalid_research_human_review", status: 400 });

    // 状态非法（不在白名单内）
    await expect(saveResearchHumanReview({
      context: { mode: "owner", token: "owner-token" },
      taskId: "task-1",
      decision: { ...decision, status: "auto_approved" as any },
      expectedStorageVersion,
    })).rejects.toMatchObject({ code: "invalid_research_human_review", status: 400 });

    // 备注超过 2000 字符限制
    await expect(saveResearchHumanReview({
      context: { mode: "owner", token: "owner-token" },
      taskId: "task-1",
      decision: { ...decision, notes: "a".repeat(2001) },
      expectedStorageVersion,
    })).rejects.toMatchObject({ code: "invalid_research_human_review", status: 400 });
  });

  it("业务前提门禁：未先生成 ResearchReport 时禁止提交人工复核（409 research_report_required）", async () => {
    mocks.readStoredResearchReport.mockReturnValue(null);
    mocks.mutateTaskResultJson.mockImplementation(async (input: {
      mutate: (current: unknown) => unknown;
    }) => {
      input.mutate({});
      return { resultJson: "{}", value: null, updatedAt: "2026-09-19T10:00:01.000Z" };
    });

    await expect(saveResearchHumanReview({
      context: { mode: "owner", token: "owner-token" },
      taskId: "task-1",
      decision,
      expectedStorageVersion,
    })).rejects.toMatchObject({ code: "research_report_required", status: 409 });
  });
});
