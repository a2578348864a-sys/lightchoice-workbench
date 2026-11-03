import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BASIC_CAPTURE_MODULE_IDS,
  MARKET_CAPTURE_MODULE_IDS,
  SUPPLEMENTAL_CAPTURE_MODULE_IDS,
} from "@/lib/sourceLayer/captureStrategy/marketCapturePlan";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  sameOrigin: vi.fn(),
  getBatch: vi.fn(),
  getBatchItems: vi.fn(),
  resolveNavigation: vi.fn(),
  start: vi.fn(),
  ensureRunning: vi.fn(),
  status: vi.fn(),
}));

vi.mock("@/lib/server/v5ApiRoute", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/v5ApiRoute")>("@/lib/server/v5ApiRoute");
  return { ...actual, readAuth: mocks.auth };
});
vi.mock("@/lib/server/accessPassword", () => ({ isTrustedWriteRequest: mocks.sameOrigin }));
vi.mock("@/lib/server/productBatchStoreResolver", () => ({
  getProductBatchStore: () => ({ getBatch: mocks.getBatch, getBatchItems: mocks.getBatchItems }),
}));
vi.mock("@/lib/server/batchCaptureSearchNavigation", () => ({ resolveBatchSearchNavigationUsed: mocks.resolveNavigation }));
vi.mock("@/lib/server/batchCaptureRunService", () => ({
  createBatchCaptureRunService: () => ({ start: mocks.start, status: mocks.status }),
}));
vi.mock("@/lib/server/batchCaptureRunExecutor", () => ({
  getBatchCaptureRunExecutor: () => ({ ensureRunning: mocks.ensureRunning }),
}));

import { GET, POST } from "./route";

const BATCH_ID = "batch-market-0001";

function batchRow() {
  return {
    id: BATCH_ID,
    batchStatus: "ready",
    normalizedSnapshotJson: JSON.stringify({ schemaVersion: "amazon-search-capture-snapshot.v1", sourceType: "amazon_search_capture" }),
  };
}

function items(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    asin: `B${String(index).padStart(9, "0")}`,
    ordinal: index,
    archivedAt: null,
  }));
}

function getRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost:3010/api/source-layer/capture-plan?${query}`, { method: "GET" });
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3010/api/source-layer/capture-plan", {
    method: "POST",
    headers: { host: "localhost:3010", origin: "http://localhost:3010", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/source-layer/capture-plan（采集计划预览与一次确认）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockReturnValue({ ok: true, context: { mode: "owner", token: "" } });
    mocks.sameOrigin.mockReturnValue(true);
    mocks.getBatch.mockResolvedValue(batchRow());
    mocks.getBatchItems.mockResolvedValue(items(100));
    mocks.resolveNavigation.mockReturnValue({ known: true, used: 4, provenance: "search_stage_receipt", reason: "" });
    mocks.start.mockImplementation(async (input: { planFingerprint: string; planStrategyId: string }) => ({
      created: true,
      run: {
        runId: "run-01",
        batchId: BATCH_ID,
        status: "WAITING",
        planFingerprint: input.planFingerprint,
        planStrategyId: input.planStrategyId,
      },
    }));
    mocks.ensureRunning.mockResolvedValue({ started: true, runId: "run-01", status: "WAITING" });
    mocks.status.mockResolvedValue(null);
  });

  it("GET 预览只读：默认只返回四项基础能力，不创建运行、不驱动", async () => {
    const response = await GET(getRequest(`batchId=${BATCH_ID}&strategyId=full_market_capture&marketTargetItemCount=100`));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.previewOnly).toBe(true);
    // 默认范围只含四项基础能力；补充能力必须显式声明后才会进入计划矩阵。
    expect(json.data.plan.entries.map((entry: { module: string }) => entry.module).sort())
      .toEqual([...BASIC_CAPTURE_MODULE_IDS].sort());
    expect(json.data.plan.entries).toHaveLength(BASIC_CAPTURE_MODULE_IDS.length);
    expect(json.data.plan.autoExecutableModuleCount).toBe(4);
    expect(json.data.plan.batchCapacity).toBe(100);
    expect(json.data.batchContext.searchNavigationUsed).toBe(4);
    // 预览只读透出任务绑定状态：没有运行时为 null，且读取失败必须显式标记。
    expect(json.data.existingRun).toBeNull();
    expect(json.data.existingRunReadFailed).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.ensureRunning).not.toHaveBeenCalled();
  });

  it("GET 预览透出服务端实际批量能力：默认 single_asin_only 时 batchCaptureScopeAllowed=false", async () => {
    const response = await GET(getRequest(`batchId=${BATCH_ID}&strategyId=full_market_capture&marketTargetItemCount=100`));
    const json = await response.json();
    expect(json.data.acquisition).toEqual({ batchCaptureScopeAllowed: false });
  });

  it("GET 预览：显式声明 batch_and_single 时 batchCaptureScopeAllowed=true", async () => {
    const previous = process.env.V5_ACQUISITION_SCOPE;
    process.env.V5_ACQUISITION_SCOPE = "batch_and_single";
    try {
      const response = await GET(getRequest(`batchId=${BATCH_ID}&strategyId=full_market_capture&marketTargetItemCount=100`));
      const json = await response.json();
      expect(json.data.acquisition).toEqual({ batchCaptureScopeAllowed: true });
    } finally {
      if (previous === undefined) delete process.env.V5_ACQUISITION_SCOPE;
      else process.env.V5_ACQUISITION_SCOPE = previous;
    }
  });

  it("GET 预览：显式声明补充能力后才扩展到八模块矩阵", async () => {
    const supplemental = SUPPLEMENTAL_CAPTURE_MODULE_IDS.join(",");
    const response = await GET(getRequest(
      `batchId=${BATCH_ID}&strategyId=full_market_capture&marketTargetItemCount=100&supplementalModules=${supplemental}`,
    ));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.plan.entries).toHaveLength(MARKET_CAPTURE_MODULE_IDS.length);
    expect(json.data.plan.entries.map((entry: { module: string }) => entry.module).sort())
      .toEqual([...MARKET_CAPTURE_MODULE_IDS].sort());
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.ensureRunning).not.toHaveBeenCalled();
  });

  it("GET 预览如实透出已存在运行的计划绑定（刷新后仍可显示当前已确认策略）", async () => {
    const preview = await (await GET(getRequest(`batchId=${BATCH_ID}&strategyId=full_market_capture&marketTargetItemCount=100`))).json();
    const fingerprint = preview.data.plan.planFingerprint as string;
    mocks.status.mockResolvedValueOnce({
      runId: "run-01",
      batchId: BATCH_ID,
      status: "RUNNING",
      planFingerprint: fingerprint,
      planStrategyId: "full_market_capture",
      authorizedItemLimit: 100,
    });

    const again = await (await GET(getRequest(`batchId=${BATCH_ID}&strategyId=full_market_capture&marketTargetItemCount=100`))).json();
    expect(again.data.existingRun.planFingerprint).toBe(fingerprint);
    expect(again.data.existingRun.status).toBe("RUNNING");
    expect(again.data.existingRunReadFailed).toBe(false);
    // 预览仍然只读：不得创建或驱动任何运行。
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.ensureRunning).not.toHaveBeenCalled();
  });

  it("GET 预览在运行回执读取失败时标记未知，不把未知显示成没有任务", async () => {
    mocks.status.mockRejectedValueOnce(new Error("receipt read failed"));
    const response = await GET(getRequest(`batchId=${BATCH_ID}&strategyId=full_market_capture&marketTargetItemCount=100`));
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data.existingRun).toBeNull();
    expect(json.data.existingRunReadFailed).toBe(true);
  });

  it("GET 预览对非法策略 fail-closed", async () => {
    const response = await GET(getRequest(`batchId=${BATCH_ID}&strategyId=whatever`));
    const json = await response.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("MARKET_STRATEGY_INVALID");
  });

  it("POST 确认：服务端重算计划、绑定指纹、创建运行并自动驱动", async () => {
    // 明确声明四项补充能力：只有经用户显式选择，八模块矩阵才会进入任务。
    const supplemental = SUPPLEMENTAL_CAPTURE_MODULE_IDS.join(",");
    const preview = await (await GET(getRequest(
      `batchId=${BATCH_ID}&strategyId=full_market_capture&marketTargetItemCount=100&supplementalModules=${supplemental}`,
    ))).json();
    const fingerprint = preview.data.plan.planFingerprint as string;

    const response = await POST(postRequest({
      batchId: BATCH_ID,
      strategyId: "full_market_capture",
      marketTargetItemCount: 100,
      planFingerprint: fingerprint,
      supplementalModules: [...SUPPLEMENTAL_CAPTURE_MODULE_IDS],
    }));
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({
      batchId: BATCH_ID,
      authorizedItemLimit: 100,
      planFingerprint: fingerprint,
      planStrategyId: "full_market_capture",
      searchNavigationUsed: 4,
      // 八模块矩阵全部进入任务（未自动接线模块以 source_input_required 单元格如实保留缺口）。
      allowedModules: expect.arrayContaining([
        "amazon_detail", "variation", "review_voc", "historical_trend", "sellersprite_product_market",
      ]),
    }));
    const allowed = mocks.start.mock.calls[0][0].allowedModules as string[];
    expect(allowed).toHaveLength(8);
    expect(json.data.sourceAccess).toBe("NONE");
    expect(mocks.ensureRunning).toHaveBeenCalledWith({ context: { mode: "owner", token: "" }, batchId: BATCH_ID });
  });

  it("重复确认同一计划幂等：不重复创建运行", async () => {
    const preview = await (await GET(getRequest(`batchId=${BATCH_ID}&strategyId=quick_market_scan&marketTargetItemCount=50`))).json();
    const fingerprint = preview.data.plan.planFingerprint as string;
    mocks.start.mockResolvedValueOnce({
      created: false,
      run: { runId: "run-01", batchId: BATCH_ID, status: "RUNNING", planFingerprint: fingerprint, planStrategyId: "quick_market_scan" },
    });

    const response = await POST(postRequest({
      batchId: BATCH_ID, strategyId: "quick_market_scan", marketTargetItemCount: 50, planFingerprint: fingerprint,
    }));
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data.created).toBe(false);
  });

  it("指纹不符一律拒绝：不按被篡改的范围采集", async () => {
    const response = await POST(postRequest({
      batchId: BATCH_ID,
      strategyId: "full_market_capture",
      marketTargetItemCount: 100,
      planFingerprint: "f".repeat(64),
    }));
    const json = await response.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("MARKET_PLAN_FINGERPRINT_MISMATCH");
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.ensureRunning).not.toHaveBeenCalled();
  });

  it("确认期间目标数量变化导致指纹变化时拒绝（防止悄悄扩大采集范围）", async () => {
    const preview = await (await GET(getRequest(`batchId=${BATCH_ID}&strategyId=full_market_capture&marketTargetItemCount=10`))).json();
    const fingerprint = preview.data.plan.planFingerprint as string;

    const response = await POST(postRequest({
      batchId: BATCH_ID, strategyId: "full_market_capture", marketTargetItemCount: 100, planFingerprint: fingerprint,
    }));
    const json = await response.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("MARKET_PLAN_FINGERPRINT_MISMATCH");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("未提供指纹时拒绝确认", async () => {
    const response = await POST(postRequest({ batchId: BATCH_ID, strategyId: "full_market_capture", marketTargetItemCount: 10 }));
    const json = await response.json();
    expect(json.error.code).toBe("MARKET_PLAN_FINGERPRINT_REQUIRED");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("搜索阶段导航不可核验时拒绝创建运行（不默认 0）", async () => {
    mocks.resolveNavigation.mockReturnValue({ known: false, used: 0, code: "SEARCH_NAVIGATION_UNKNOWN", reason: "批次缺少搜索导航回执。" });
    const response = await POST(postRequest({
      batchId: BATCH_ID, strategyId: "full_market_capture", marketTargetItemCount: 10, planFingerprint: "a".repeat(64),
    }));
    const json = await response.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("SEARCH_NAVIGATION_UNKNOWN");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("批次不存在或未就绪时 fail-closed", async () => {
    mocks.getBatch.mockResolvedValueOnce(null);
    const missing = await GET(getRequest(`batchId=${BATCH_ID}&strategyId=full_market_capture`));
    expect((await missing.json()).error.code).toBe("BATCH_NOT_FOUND");

    mocks.getBatch.mockResolvedValueOnce({ ...batchRow(), batchStatus: "processing" });
    const notReady = await GET(getRequest(`batchId=${BATCH_ID}&strategyId=full_market_capture`));
    expect((await notReady.json()).error.code).toBe("BATCH_NOT_READY");
  });

  it("批次容量为 0 时拒绝（没有可采集商品）", async () => {
    mocks.getBatchItems.mockResolvedValue([]);
    const response = await GET(getRequest(`batchId=${BATCH_ID}&strategyId=full_market_capture&marketTargetItemCount=10`));
    expect((await response.json()).error.code).toBe("capture_plan_capacity_empty");
  });

  it("100 件目标遇到授权上限时不偷偷截断：如实报告被推迟的数量", async () => {
    mocks.getBatchItems.mockResolvedValue(items(300));
    const preview = await (await GET(getRequest(
      `batchId=${BATCH_ID}&strategyId=full_market_capture&marketTargetItemCount=300&authorizedItemCount=200`,
    ))).json();
    expect(preview.data.plan.marketTargetItemCount).toBe(300);
    expect(preview.data.plan.authorizedItemCount).toBe(200);
    expect(preview.data.plan.deferredItemCount).toBe(100);
    expect(preview.data.plan.batching.requiresMultipleRuns).toBe(true);
  });

  it("运行绑定失败时拒绝并停止推进", async () => {
    const preview = await (await GET(getRequest(`batchId=${BATCH_ID}&strategyId=full_market_capture&marketTargetItemCount=100`))).json();
    const fingerprint = preview.data.plan.planFingerprint as string;
    mocks.start.mockResolvedValueOnce({
      created: true,
      run: { runId: "run-01", batchId: BATCH_ID, status: "WAITING", planFingerprint: null, planStrategyId: null },
    });
    const response = await POST(postRequest({
      batchId: BATCH_ID, strategyId: "full_market_capture", marketTargetItemCount: 100, planFingerprint: fingerprint,
    }));
    const json = await response.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("BATCH_CAPTURE_PLAN_BINDING_FAILED");
    expect(mocks.ensureRunning).not.toHaveBeenCalled();
  });

  it("执行器启动失败不回滚已创建运行，但如实报告 driveError", async () => {
    const preview = await (await GET(getRequest(`batchId=${BATCH_ID}&strategyId=full_market_capture&marketTargetItemCount=100`))).json();
    const fingerprint = preview.data.plan.planFingerprint as string;
    mocks.ensureRunning.mockRejectedValueOnce(Object.assign(new Error("lease busy"), { code: "BATCH_CAPTURE_LEASE_BUSY" }));

    const response = await POST(postRequest({
      batchId: BATCH_ID, strategyId: "full_market_capture", marketTargetItemCount: 100, planFingerprint: fingerprint,
    }));
    const json = await response.json();
    expect(json.ok).toBe(true);
    expect(json.data.drive).toBeNull();
    expect(json.data.driveError).toBe("BATCH_CAPTURE_LEASE_BUSY");
    expect(json.data.run.status).toBe("WAITING");
  });

  it("D2-1E) 执行器同步预检拒绝（环境未启用）时如实回报：started:false + driveError，不伪装成已启动", async () => {
    const preview = await (await GET(getRequest(`batchId=${BATCH_ID}&strategyId=full_market_capture&marketTargetItemCount=100`))).json();
    const fingerprint = preview.data.plan.planFingerprint as string;
    mocks.ensureRunning.mockResolvedValueOnce({
      started: false, runId: "run-01", status: "WAITING", errorCode: "LOCAL_ENVIRONMENT_REQUIRED",
    });

    const response = await POST(postRequest({
      batchId: BATCH_ID, strategyId: "full_market_capture", marketTargetItemCount: 100, planFingerprint: fingerprint,
    }));
    const json = await response.json();
    expect(json.ok).toBe(true);
    expect(json.data.drive).toEqual({ started: false, runId: "run-01", status: "WAITING" });
    expect(json.data.driveError).toBe("LOCAL_ENVIRONMENT_REQUIRED");
    expect(json.data.run.status).toBe("WAITING");
  });
});
