import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuthenticated: vi.fn(),
  buildResearchExportBatchPreview: vi.fn(),
}));

vi.mock("@/lib/server/demoGuard", () => ({ requireAuthenticated: mocks.requireAuthenticated }));
vi.mock("@/lib/server/research/researchExportBatch", () => ({
  buildResearchExportBatchPreview: mocks.buildResearchExportBatchPreview,
  normalizeResearchExportTaskIds: (taskIds: string[]) => Array.from(new Set(taskIds.map((id) => id.trim()).filter(Boolean))),
}));

import { GET } from "./route";

const preview = {
  count: 2,
  items: [
    { taskId: "task-1", candidateId: "candidate-1" },
    { taskId: "task-2", candidateId: "candidate-2" },
  ],
  larkRecords: [{ 商品信息: { ASIN: "B0ONE" } }, { 商品信息: { ASIN: "B0TWO" } }],
};

describe("GET /api/research-export/batch-preview", () => {
  beforeEach(() => {
    mocks.requireAuthenticated.mockReset();
    mocks.buildResearchExportBatchPreview.mockReset();
    mocks.requireAuthenticated.mockReturnValue({
      ok: true,
      context: { mode: "owner", demoAccessId: null },
    });
    mocks.buildResearchExportBatchPreview.mockResolvedValue(preview);
  });

  it("未认证时拒绝批量预览", async () => {
    mocks.requireAuthenticated.mockReturnValueOnce({
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "未登录。",
    });

    const response = await GET(new NextRequest("http://localhost/api/research-export/batch-preview?taskId=task-1"));
    expect(response.status).toBe(401);
    expect((await response.json()).ok).toBe(false);
    expect(mocks.buildResearchExportBatchPreview).not.toHaveBeenCalled();
  });

  it("没有 taskId 时返回 400", async () => {
    const response = await GET(new NextRequest("http://localhost/api/research-export/batch-preview"));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("task_ids_required");
  });

  it("读取重复 taskId 并保持去重后的批量预览契约", async () => {
    const response = await GET(new NextRequest(
      "http://localhost/api/research-export/batch-preview?taskId=task-1&taskId=task-1&taskIds=task-2%2Ctask-2",
    ));
    expect(response.status).toBe(200);
    expect(mocks.buildResearchExportBatchPreview).toHaveBeenCalledWith({
      context: { mode: "owner", demoAccessId: null },
      taskIds: ["task-1", "task-2"],
    });
    expect(await response.json()).toEqual({ ok: true, data: preview });
  });
});
