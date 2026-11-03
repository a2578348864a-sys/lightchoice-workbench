import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  sameOrigin: vi.fn(),
  start: vi.fn(),
  recover: vi.fn(),
  getBatch: vi.fn(),
  control: vi.fn(),
  ensureRunning: vi.fn(),
  isRunning: vi.fn(() => false),
  noteExecutionBlocked: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({ prisma: {} }));
vi.mock("@/lib/server/accessPassword", () => ({ isTrustedWriteRequest: mocks.sameOrigin }));
vi.mock("@/lib/server/v5ApiRoute", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server/v5ApiRoute")>(),
  readAuth: mocks.auth,
}));
vi.mock("@/lib/server/batchCaptureRunService", () => ({
  createBatchCaptureRunService: () => ({
    start: mocks.start,
    recoverStalledExecution: mocks.recover,
    control: mocks.control,
    noteExecutionBlocked: mocks.noteExecutionBlocked,
  }),
}));
vi.mock("@/lib/server/batchCaptureRunExecutor", () => ({
  getBatchCaptureRunExecutor: () => ({ ensureRunning: mocks.ensureRunning, isRunning: mocks.isRunning }),
}));
vi.mock("@/lib/server/productBatchStoreResolver", () => ({
  getProductBatchStore: () => ({ getBatch: mocks.getBatch }),
}));

import { V5CoreError } from "@/lib/server/v5CoreCommon";

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3010/api/source-layer/batch-capture", {
    method: "POST",
    headers: {
      host: "localhost:3010",
      origin: "http://localhost:3010",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** 真实搜索采集批次的 provenance + 搜索导航回执。 */
function searchBatch(searchNavigationUsed?: number) {
  return {
    id: "batch-search-0001",
    batchStatus: "ready",
    itemCount: 60,
    manifestJson: JSON.stringify({ schemaVersion: "amazon-search-capture-manifest.v1", sourceType: "amazon_search_capture" }),
    normalizedSnapshotJson: JSON.stringify({ schemaVersion: "amazon-search-capture-snapshot.v1", sourceType: "amazon_search_capture" }),
    qualitySummaryJson: JSON.stringify({
      schemaVersion: "amazon-search-capture-batch-quality.v1",
      ...(searchNavigationUsed === undefined ? {} : { searchNavigationUsed }),
    }),
  };
}

describe("POST /api/source-layer/batch-capture · start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockReturnValue({ ok: true, context: { mode: "owner", token: "" } });
    mocks.sameOrigin.mockReturnValue(true);
    mocks.getBatch.mockResolvedValue(searchBatch(2));
    mocks.start.mockResolvedValue({
      created: true,
      run: { runId: "run-01", batchId: "batch-search-0001", status: "WAITING", runGeneration: 1, authorizedItemLimit: 30 },
    });
  });

  it("创建运行：服务端自行推导搜索导航预算，并忽略客户端提交的 searchNavigationUsed", async () => {
    const response = await POST(request({
      action: "start",
      batchId: "batch-search-0001",
      authorizedItemLimit: 30,
      allowedModules: ["amazon_detail", "variation", "review_voc", "reverse_asin", "sellersprite_product_market", "keyword_mining_trend", "historical_trend", "amazon_search_market"],
      // 伪造较低值：必须被忽略（服务端以批次回执 2 为准）
      searchNavigationUsed: 0,
    }));
    expect(response.status).toBe(201);
    const json = await response.json() as {
      ok: boolean;
      data: { created: boolean; searchNavigationProvenance: { provenance: string; used: number } };
    };
    expect(json.ok).toBe(true);
    expect(json.data.created).toBe(true);
    expect(json.data.searchNavigationProvenance).toMatchObject({ provenance: "search_stage_receipt", used: 2 });
    expect(mocks.start).toHaveBeenCalledTimes(1);
    const passed = mocks.start.mock.calls[0]![0] as { authorizedItemLimit: number; searchNavigationUsed: number };
    expect(passed.authorizedItemLimit).toBe(30);
    expect(passed.searchNavigationUsed).toBe(2);
  });

  it("缺少授权数量时由服务端 fail-closed（不默认任何数量）", async () => {
    mocks.start.mockRejectedValue(new V5CoreError("AUTHORIZED_ITEM_LIMIT_REQUIRED", "必须显式声明本次授权的商品数量上限。", 400));
    const response = await POST(request({ action: "start", batchId: "batch-search-0001" }));
    expect(response.status).toBe(400);
    const json = await response.json() as { ok: boolean; error: { code: string } };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("AUTHORIZED_ITEM_LIMIT_REQUIRED");
  });

  it("授权数量超限时被拒绝，且没有创建运行", async () => {
    mocks.start.mockRejectedValue(new V5CoreError("AUTHORIZED_ITEM_LIMIT_INVALID", "authorizedItemLimit 超出允许范围。", 400));
    const response = await POST(request({ action: "start", batchId: "batch-search-0001", authorizedItemLimit: 9999 }));
    expect(response.status).toBe(400);
    const json = await response.json() as { error: { code: string } };
    expect(json.error.code).toBe("AUTHORIZED_ITEM_LIMIT_INVALID");
  });

  it("已有相同运行时不重复创建", async () => {
    mocks.start.mockResolvedValue({
      created: false,
      run: { runId: "run-existing", batchId: "batch-search-0001", status: "RUNNING", runGeneration: 1 },
    });
    const response = await POST(request({ action: "start", batchId: "batch-search-0001", authorizedItemLimit: 10 }));
    expect(response.status).toBe(200);
    const json = await response.json() as { data: { created: boolean } };
    expect(json.data.created).toBe(false);
  });

  it("搜索采集批次缺少导航回执时明确阻断（不伪造、不默认 0）", async () => {
    mocks.getBatch.mockResolvedValue(searchBatch(undefined));
    const response = await POST(request({ action: "start", batchId: "batch-search-0001", authorizedItemLimit: 10 }));
    expect(response.status).toBe(409);
    const json = await response.json() as { ok: boolean; error: { code: string; message: string } };
    expect(json.error.code).toBe("BATCH_CAPTURE_SEARCH_NAVIGATION_PROVENANCE_MISSING");
    expect(json.error.message).toContain("阻断");
    // 关键：没有把请求转发给 start（不会创建运行）
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("非搜索采集批次可证明没有搜索阶段，按 0 处理", async () => {
    mocks.getBatch.mockResolvedValue({
      id: "batch-xlsx-0001", batchStatus: "ready",
      manifestJson: JSON.stringify({ sourceType: "sellersprite_xlsx" }),
      normalizedSnapshotJson: null, qualitySummaryJson: "{}",
    });
    const response = await POST(request({ action: "start", batchId: "batch-xlsx-0001", authorizedItemLimit: 5 }));
    expect(response.status).toBe(201);
    const passed = mocks.start.mock.calls[0]![0] as { searchNavigationUsed: number };
    expect(passed.searchNavigationUsed).toBe(0);
  });

  it("已取消但旧 Worker 未退出：由服务端拒绝新代次（不产生第二个运行）", async () => {
    mocks.start.mockRejectedValue(new V5CoreError("BATCH_CAPTURE_EXECUTION_STATE_UNKNOWN", "存在未确认退出的执行器。", 409, true));
    const response = await POST(request({ action: "start", batchId: "batch-search-0001", authorizedItemLimit: 10 }));
    expect(response.status).toBe(409);
    const json = await response.json() as { error: { code: string } };
    expect(json.error.code).toBe("BATCH_CAPTURE_EXECUTION_STATE_UNKNOWN");
  });

  it("缺少 batchId 时拒绝", async () => {
    const response = await POST(request({ action: "start", authorizedItemLimit: 10 }));
    expect(response.status).toBe(400);
    const json = await response.json() as { error: { code: string } };
    expect(json.error.code).toBe("batch_id_required");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("来源不可信时拒绝（same-origin 门禁不放宽）", async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const response = await POST(request({ action: "start", batchId: "batch-search-0001", authorizedItemLimit: 10 }));
    expect(response.status).toBe(403);
    expect(mocks.start).not.toHaveBeenCalled();
  });
});

describe("POST /api/source-layer/batch-capture · recover_stalled_execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockReturnValue({ ok: true, context: { mode: "owner", token: "" } });
    mocks.sameOrigin.mockReturnValue(true);
  });

  it("转发精确身份与核对原因到服务端人工确认入口", async () => {
    mocks.recover.mockResolvedValue({ runId: "run-01", runGeneration: 1, executionEpoch: 1, acknowledgedEpoch: 1, stopConfirmedBy: "operator" });
    const response = await POST(request({
      action: "recover_stalled_execution",
      batchId: "batch-search-0001",
      runId: "run-01",
      runGeneration: 1,
      executionEpoch: 1,
      reason: "已核对旧采集进程不再存活",
    }));
    expect(response.status).toBe(200);
    expect(mocks.recover).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-01", runGeneration: 1, executionEpoch: 1, reason: "已核对旧采集进程不再存活",
    }));
  });

  it("身份不匹配时服务端拒绝（不会清空租约）", async () => {
    mocks.recover.mockRejectedValue(new V5CoreError("BATCH_CAPTURE_STOP_CONFIRMATION_STALE", "确认身份与当前运行不一致。", 409, true));
    const response = await POST(request({
      action: "recover_stalled_execution",
      batchId: "batch-search-0001", runId: "run-01", runGeneration: 99, executionEpoch: 1,
      reason: "已核对旧采集进程不再存活",
    }));
    expect(response.status).toBe(409);
    const json = await response.json() as { error: { code: string } };
    expect(json.error.code).toBe("BATCH_CAPTURE_STOP_CONFIRMATION_STALE");
  });

  it("D2-1H: resume 被拒（存在人工单元）时不得启动执行器", async () => {
    mocks.auth.mockReturnValue({ ok: true, context: { mode: "owner", token: "" } });
    mocks.sameOrigin.mockReturnValue(true);
    mocks.control.mockRejectedValue(new V5CoreError(
      "BATCH_CAPTURE_HUMAN_REQUIRED",
      "存在 3 个需要人工处理的单元（CAPTCHA_DETECTED、HUMAN_GATE_PAUSE）：请先在专用浏览器中完成登录或人工验证，然后再点击继续。",
      409,
      true,
    ));

    const response = await POST(request({ batchId: "batch-search-0001", action: "resume" }));
    expect(response.status).toBe(409);
    const json = await response.json() as { error: { code: string } };
    expect(json.error.code).toBe("BATCH_CAPTURE_HUMAN_REQUIRED");
    expect(mocks.ensureRunning).not.toHaveBeenCalled();
  });
});

describe("POST /api/source-layer/batch-capture · resume（D2-1H：继续=重新检查+重新驱动）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockReturnValue({ ok: true, context: { mode: "owner", token: "" } });
    mocks.sameOrigin.mockReturnValue(true);
    mocks.isRunning.mockReturnValue(false);
  });

  it("D2-1H: resume 成功后必须重新触发有界执行器（继续 ≠ 只改状态）", async () => {
    mocks.auth.mockReturnValue({ ok: true, context: { mode: "owner", token: "" } });
    mocks.sameOrigin.mockReturnValue(true);
    mocks.control.mockResolvedValue({ status: "RUNNING", runId: "run-01" });
    mocks.ensureRunning.mockResolvedValue({ started: true, runId: "run-01", status: "RUNNING" });

    const response = await POST(request({ batchId: "batch-search-0001", action: "resume" }));
    expect(response.status).toBe(200);
    expect(mocks.control).toHaveBeenCalledWith({ context: { mode: "owner", token: "" }, batchId: "batch-search-0001", action: "resume" });
    // 继续成功 → 立即重新驱动（drive 内部重新预检登录/资格并跳过已完成单元）
    expect(mocks.ensureRunning).toHaveBeenCalledWith({ context: { mode: "owner", token: "" }, batchId: "batch-search-0001" });
    const json = await response.json() as { data: { drive?: { started?: boolean } } };
    expect(json.data.drive?.started).toBe(true);
  });

  it("retry 成功后必须带 allowRetry 启动执行器，且失败原因回传给前端", async () => {
    mocks.auth.mockReturnValue({ ok: true, context: { mode: "owner", token: "" } });
    mocks.sameOrigin.mockReturnValue(true);
    mocks.control.mockResolvedValue({ status: "RUNNING", runId: "run-01", retryAuthorized: true });
    mocks.ensureRunning.mockResolvedValue({
      started: false,
      runId: "run-01",
      status: "RUNNING",
      errorCode: "LOCAL_ENVIRONMENT_REQUIRED",
    });

    const response = await POST(request({ batchId: "batch-search-0001", action: "retry" }));
    expect(response.status).toBe(200);
    expect(mocks.ensureRunning).toHaveBeenCalledWith({
      context: { mode: "owner", token: "" },
      batchId: "batch-search-0001",
      allowRetry: true,
    });
    const json = await response.json() as {
      data: { drive?: { started?: boolean; errorCode?: string | null; message?: string } };
    };
    expect(json.data.drive?.started).toBe(false);
    expect(json.data.drive?.errorCode).toBe("LOCAL_ENVIRONMENT_REQUIRED");
    expect(json.data.drive?.message).toContain("LOCAL_ENVIRONMENT_REQUIRED");
  });

  it("retry 时 ensureRunning 抛错不吞掉：drive 带错误码返回", async () => {
    mocks.auth.mockReturnValue({ ok: true, context: { mode: "owner", token: "" } });
    mocks.sameOrigin.mockReturnValue(true);
    mocks.control.mockResolvedValue({ status: "RUNNING", runId: "run-01" });
    mocks.ensureRunning.mockRejectedValue(new Error("drive boom"));

    const response = await POST(request({ batchId: "batch-search-0001", action: "retry" }));
    expect(response.status).toBe(200);
    const json = await response.json() as {
      data: { drive?: { errorCode?: string | null; message?: string } };
    };
    expect(json.data.drive?.errorCode).toBeTruthy();
    expect(json.data.drive?.message).toContain("drive boom");
  });
});
