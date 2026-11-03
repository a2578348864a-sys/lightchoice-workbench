import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readResearchTaskSnapshot: vi.fn(),
  readStoredResearchReport: vi.fn(),
  readStoredResearchDecision: vi.fn(),
  buildResearchExportRecord: vi.fn(),
  mapResearchExportToLarkRecord: vi.fn(),
}));

vi.mock("./researchInput", () => ({
  readResearchTaskSnapshot: mocks.readResearchTaskSnapshot,
  ResearchV1InputError: class ResearchV1InputError extends Error {
    code = "task_not_found";
    status = 404;
  },
}));
vi.mock("./researchReportStore", () => ({ readStoredResearchReport: mocks.readStoredResearchReport }));
vi.mock("./researchHumanReviewStore", () => ({ readStoredResearchDecision: mocks.readStoredResearchDecision }));
vi.mock("@/lib/research/exportRecord", () => ({ buildResearchExportRecord: mocks.buildResearchExportRecord }));
vi.mock("@/lib/research/larkMapping", () => ({ mapResearchExportToLarkRecord: mocks.mapResearchExportToLarkRecord }));

import { buildResearchExportBatchPreview } from "./researchExportBatch";

describe("buildResearchExportBatchPreview", () => {
  beforeEach(() => {
    mocks.readResearchTaskSnapshot.mockReset();
    mocks.readStoredResearchReport.mockReset();
    mocks.readStoredResearchDecision.mockReset();
    mocks.buildResearchExportRecord.mockReset();
    mocks.mapResearchExportToLarkRecord.mockReset();

    mocks.readResearchTaskSnapshot.mockImplementation(async (_context: unknown, taskId: string) => ({
      id: taskId,
      result: { ready: taskId !== "task-incomplete" },
    }));
    mocks.readStoredResearchReport.mockImplementation((result: { ready?: boolean }) => result.ready
      ? {
          report: { candidateId: "candidate" },
          reportHash: "hash",
          generatedAt: "2026-09-19T00:00:00.000Z",
        }
      : null);
    mocks.readStoredResearchDecision.mockReturnValue(null);
    mocks.buildResearchExportRecord.mockImplementation(({ taskId }: { taskId: string }) => ({ taskId }));
    mocks.mapResearchExportToLarkRecord.mockImplementation((record: { taskId: string }) => ({ taskId: record.taskId }));
  });

  it("只输出有已保存 ResearchReport 的任务，并保持去重后的选择顺序", async () => {
    const result = await buildResearchExportBatchPreview({
      context: { mode: "owner", token: "test-token" },
      taskIds: ["task-2", "task-1", "task-2", "task-incomplete"],
    });

    expect(result).toEqual({
      count: 2,
      items: [{ taskId: "task-2" }, { taskId: "task-1" }],
      larkRecords: [{ taskId: "task-2" }, { taskId: "task-1" }],
    });
    expect(mocks.buildResearchExportRecord).toHaveBeenCalledTimes(2);
    expect(mocks.mapResearchExportToLarkRecord).toHaveBeenCalledTimes(2);
  });
});
