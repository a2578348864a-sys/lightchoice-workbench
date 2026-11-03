import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireOwnerOnly: vi.fn(),
  buildResearchExportBatchPreview: vi.fn(),
  sync: vi.fn(),
  syncDecisions: vi.fn(),
  getProductResearchDecisionState: vi.fn(),
}));

vi.mock("@/lib/server/demoGuard", () => ({ requireOwnerOnly: mocks.requireOwnerOnly }));
vi.mock("@/lib/server/research/researchExportBatch", () => ({
  buildResearchExportBatchPreview: mocks.buildResearchExportBatchPreview,
  normalizeResearchExportTaskIds: (taskIds: string[]) => Array.from(new Set(taskIds.map((id) => id.trim()).filter(Boolean))),
  RESEARCH_EXPORT_BATCH_MAX_ITEMS: 100,
}));
vi.mock("@/lib/integrations/lark", () => ({
  LarkBaseDestination: class {
    sync = mocks.sync;
  },
  syncResearchDecisionsToCommodityPool: mocks.syncDecisions,
}));
vi.mock("@/lib/server/productResearchRecordStore", () => ({
  ProductResearchStoreError: class ProductResearchStoreError extends Error {
    code = "mock_error";
    status = 500;
  },
  getProductResearchDecisionState: mocks.getProductResearchDecisionState,
}));

import { POST } from "./route";

describe("POST /api/research-export/lark-sync", () => {
  beforeEach(() => {
    mocks.requireOwnerOnly.mockReset();
    mocks.buildResearchExportBatchPreview.mockReset();
    mocks.sync.mockReset();
    mocks.syncDecisions.mockReset();
    mocks.getProductResearchDecisionState.mockReset();
    mocks.requireOwnerOnly.mockReturnValue({
      ok: true,
      context: { mode: "owner", demoAccessId: null },
    });
  });

  it("未认证时拒绝同步", async () => {
    mocks.requireOwnerOnly.mockReturnValueOnce({
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "未登录。",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/research-export/lark-sync", {
        method: "POST",
        body: JSON.stringify({ taskIds: ["t1"] }),
      }),
    );
    expect(response.status).toBe(401);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("访客不能进入真实 Lark 写入路径", async () => {
    mocks.requireOwnerOnly.mockReturnValueOnce({
      ok: false,
      status: 403,
      code: "demo_action_forbidden",
      message: "访客体验模式下不写入正式任务数据。",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/research-export/lark-sync", {
        method: "POST",
        body: JSON.stringify({ taskIds: ["owner-task-1"] }),
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.buildResearchExportBatchPreview).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("缺少 taskIds 时返回 400", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/research-export/lark-sync", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("invalid_params");
  });

  it("taskIds 为空数组时返回 400", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/research-export/lark-sync", {
        method: "POST",
        body: JSON.stringify({ taskIds: [] }),
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("task_ids_required");
  });

  it("当选中的任务没有有效的已保存 ResearchReport 时返回 400", async () => {
    mocks.buildResearchExportBatchPreview.mockResolvedValueOnce({
      count: 0,
      items: [],
      larkRecords: [],
    });

    const response = await POST(
      new NextRequest("http://localhost/api/research-export/lark-sync", {
        method: "POST",
        body: JSON.stringify({ taskIds: ["t1"] }),
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("no_valid_reports");
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("决策面板触发且尚无研报时返回业务失败体而非 HTTP 错误", async () => {
    mocks.buildResearchExportBatchPreview.mockResolvedValueOnce({
      count: 0,
      items: [],
      larkRecords: [],
    });

    const response = await POST(
      new NextRequest("http://localhost/api/research-export/lark-sync", {
        method: "POST",
        body: JSON.stringify({ taskIds: ["t1"], mode: "decision" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("no_valid_reports");
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("正确传递已有研报到 LarkBaseDestination 并返回同步结果", async () => {
    const fakeRecords = [
      {
        taskId: "t1",
        candidateId: "c1",
        product: { asin: "B001" },
      },
    ];

    mocks.buildResearchExportBatchPreview.mockResolvedValueOnce({
      count: 1,
      items: fakeRecords,
      larkRecords: [],
    });

    mocks.sync.mockResolvedValueOnce({
      total: 1,
      created: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
      results: [{ taskId: "t1", asin: "B001", action: "created", recordId: "rec_1" }],
      syncedAt: "2026-09-19T12:00:00.000Z",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/research-export/lark-sync", {
        method: "POST",
        body: JSON.stringify({ taskIds: ["t1"] }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.created).toBe(1);
    expect(mocks.sync).toHaveBeenCalledWith(fakeRecords);
  });

  it("新商品池路径按 subjectKey 读取人工决定，并只调用决策回写服务", async () => {
    const fakeRecords = [{
      taskId: "t-decision",
      candidateId: "c-decision",
      subjectKey: "amazon:US:B0DEC00001",
      product: { asin: "B0DEC00001" },
      evidence: { reportHash: "r".repeat(64) },
    }];
    mocks.buildResearchExportBatchPreview.mockResolvedValueOnce({ count: 1, items: fakeRecords, larkRecords: [] });
    mocks.getProductResearchDecisionState.mockResolvedValueOnce({
      taskId: "t-decision",
      legacy: false,
      readOnly: false,
      record: {
        latestDecision: {
          status: "creative_ready",
          reason: "证据充足",
          nextAction: "小单验证",
          decidedAt: "2026-09-24T00:00:00.000Z",
        },
      },
    });
    mocks.syncDecisions.mockResolvedValueOnce({
      total: 1,
      createdCount: 0,
      updatedCount: 1,
      skippedCount: 0,
      conflictCount: 0,
      failedCount: 0,
      results: [{ subjectKey: fakeRecords[0].subjectKey, action: "updated", recordId: "rec-1" }],
      syncedAt: "2026-09-24T00:00:01.000Z",
      requestClientToken: "token",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/research-export/lark-sync", {
        method: "POST",
        body: JSON.stringify({ taskIds: ["t-decision"] }),
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(mocks.syncDecisions).toHaveBeenCalledWith([
      {
        subjectKey: fakeRecords[0].subjectKey,
        decision: {
          researchStatus: "已完成",
          decision: "可做",
          reason: "证据充足",
          nextAction: "小单验证",
          decidedAt: "2026-09-24T00:00:00.000Z",
          reportHash: "r".repeat(64),
          syncedAt: expect.any(String),
        },
      },
    ], { requestClientToken: undefined });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("飞书决策写回失败时返回失败响应，但不触发本地回滚", async () => {
    const fakeRecords = [{
      taskId: "t-decision-failed",
      candidateId: "c-decision-failed",
      subjectKey: "amazon:US:B0DECF0001",
      product: { asin: "B0DECF0001" },
      evidence: { reportHash: "f".repeat(64) },
    }];
    mocks.buildResearchExportBatchPreview.mockResolvedValueOnce({ count: 1, items: fakeRecords, larkRecords: [] });
    mocks.getProductResearchDecisionState.mockResolvedValueOnce({
      taskId: fakeRecords[0].taskId,
      legacy: false,
      readOnly: false,
      record: {
        latestDecision: {
          status: "needs_information",
          reason: "缺少成本证据",
          nextAction: "补充供应链报价",
          decidedAt: "2026-09-24T00:00:00.000Z",
        },
      },
    });
    mocks.syncDecisions.mockResolvedValueOnce({
      total: 1,
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      conflictCount: 0,
      failedCount: 1,
      results: [{ subjectKey: fakeRecords[0].subjectKey, action: "failed", errorMessage: "配置缺失" }],
      syncedAt: "2026-09-24T00:00:01.000Z",
      requestClientToken: "token",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/research-export/lark-sync", {
        method: "POST",
        body: JSON.stringify({ taskIds: [fakeRecords[0].taskId] }),
      }),
    );
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.data.failedCount).toBe(1);
    expect(body.error.code).toBe("lark_sync_failed");
  });
});
