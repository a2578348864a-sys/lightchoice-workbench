import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  sameOrigin: vi.fn(),
  collect: vi.fn(),
  handoff: vi.fn(),
  diagnostic: vi.fn(),
  // 解耦后这些模块**不应**再被搜索路由加载；保留 mock 以便在误引入时立即失败。
  startCaptureRun: vi.fn(),
  autoDrive: vi.fn(),
  ensureDetailJob: vi.fn(),
  receipts: [] as Array<Record<string, unknown>>,
  receiptId: 0,
}));

vi.mock("@/lib/server/demoGuard", () => ({ requireAuthenticated: mocks.auth }));
vi.mock("@/lib/server/accessPassword", () => ({ isTrustedWriteRequest: mocks.sameOrigin }));
vi.mock("@/lib/server/captureRecipeBrowser", () => ({ collectAmazonSearchWithPlaywright: mocks.collect }));
vi.mock("@/lib/server/amazonSearchProductBatchHandoff", () => ({ createAmazonSearchProductBatch: mocks.handoff }));
vi.mock("@/lib/server/batchCaptureRunService", () => ({
  createBatchCaptureRunService: () => ({ start: mocks.startCaptureRun }),
}));
vi.mock("@/lib/server/batchCaptureRunExecutor", () => ({
  getBatchCaptureRunExecutor: () => ({ ensureRunning: mocks.autoDrive }),
}));
vi.mock("@/lib/server/batchDetailEnrichmentScheduler", () => ({
  ensureBatchDetailEnrichmentJob: mocks.ensureDetailJob,
}));
vi.mock("@/lib/sourceLayer/server/diagnosticService", () => ({ recordCaptureApiDiagnostic: mocks.diagnostic }));
vi.mock("@/lib/server/db", () => ({
  prisma: {
    v5OperationReceipt: {
      findUnique: async ({ where }: { where: { actorScope_operation_resourceKey_idempotencyKey: Record<string, unknown> } }) => {
        const key = where.actorScope_operation_resourceKey_idempotencyKey;
        return mocks.receipts.find((row) => Object.entries(key).every(([name, value]) => row[name] === value)) ?? null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (mocks.receipts.some((row) => ["actorScope", "operation", "resourceKey", "idempotencyKey"].every((key) => row[key] === data[key]))) {
          throw new Error("unique_constraint");
        }
        const row = { id: `search-receipt-${++mocks.receiptId}`, ...data, updatedAt: new Date() };
        mocks.receipts.push(row);
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = mocks.receipts.find((entry) => Object.entries(where).every(([name, value]) => {
          if (name === "status" && value && typeof value === "object" && "in" in value) {
            return ((value as { in: string[] }).in).includes(String(entry.status));
          }
          return entry[name] === value;
        }));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  },
}));

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3010/api/source-layer/collect/amazon-search", {
    method: "POST",
    headers: {
      host: "localhost:3010",
      origin: "http://localhost:3010",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function capturedResult() {
  const evidenceReference = {
    subjectKey: "amazon:US:B000000001",
    captureId: "capture-01",
    evidenceId: "evidence-01",
    evidenceVersion: 1,
    contentHash: "a".repeat(64),
  };
  return {
    status: "captured",
    plan: {
      schemaVersion: "amazon-search-capture-plan.v1",
      query: "christmas tree",
      pageCount: 1,
      totalObservationCount: 1,
      pageStatuses: ["ok"],
      emptyResultReason: null,
      observations: [],
    },
    traces: [{ traceId: "trace-search-01" }],
    captures: [{
      traceId: "trace-search-01",
      source: "amazon_dom",
      capture: { items: [{ subjectKey: "amazon:US:B000000001", captureId: "capture-01", version: 1, contentHash: "a".repeat(64) }] },
    }],
    navigationUsed: 1,
    partial: false,
    pageCheckpoints: [{ page: 1, state: "evidence_persisted", pageStatus: "ok", observationCount: 1, evidenceReferences: [evidenceReference] }],
  };
}

describe("POST /api/source-layer/collect/amazon-search（搜索与后续采集彻底解耦）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.receipts = [];
    mocks.receiptId = 0;
    mocks.auth.mockReturnValue({ ok: true, context: { mode: "owner", token: "" } });
    mocks.sameOrigin.mockReturnValue(true);
    mocks.collect.mockResolvedValue(capturedResult());
    mocks.handoff.mockResolvedValue({
      created: true,
      batchId: "batch-search-0001",
      batchStatus: "ready",
      itemCount: 1,
      quarantinedCount: 0,
      duplicateProductCount: 0,
      rejectedProductFactCount: 0,
    });
    mocks.diagnostic.mockResolvedValue(undefined);
  });

  it("搜索只保存证据并建立批次，返回待确认采集计划，不创建任何运行", async () => {
    const response = await POST(request({ query: "christmas tree", authorizedItemLimit: 1 }));
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json.ok).toBe(true);
    expect(json.data.productBatchHandoff).toMatchObject({ batchId: "batch-search-0001", batchStatus: "ready" });
    // 搜索不再自动入队详情补齐
    expect(json.data.detailEnrichmentJob).toBeNull();
    // 搜索不再自动创建 / 驱动 Capture Run
    expect(json.data.batchCaptureRun).toBeNull();
    expect(mocks.startCaptureRun).not.toHaveBeenCalled();
    expect(mocks.autoDrive).not.toHaveBeenCalled();
    expect(mocks.ensureDetailJob).not.toHaveBeenCalled();
  });

  it("返回明确的待确认状态与计划预览入口（WAITING_CAPTURE_PLAN）", async () => {
    const response = await POST(request({ query: "christmas tree", authorizedItemLimit: 1 }));
    const json = await response.json();

    expect(json.data.capturePlan).toMatchObject({
      required: true,
      state: "WAITING_CAPTURE_PLAN",
      batchId: "batch-search-0001",
    });
    expect(json.data.capturePlan.previewPath).toContain("/api/source-layer/capture-plan?batchId=batch-search-0001");
  });

  it("搜索失败或批次交接失败时同样不创建任何运行", async () => {
    mocks.collect.mockResolvedValueOnce({ status: "failed", errorCode: "CAPTCHA_DETECTED", traces: [], captures: [] });
    const captureFailed = await POST(request({ query: "christmas tree", authorizedItemLimit: 1 }));
    expect(captureFailed.status).toBe(500);
    expect(mocks.startCaptureRun).not.toHaveBeenCalled();
    expect(mocks.autoDrive).not.toHaveBeenCalled();

    mocks.handoff.mockRejectedValueOnce(new Error("batch persistence failed"));
    const handoffFailed = await POST(request({ query: "christmas tree", authorizedItemLimit: 1 }));
    expect(handoffFailed.status).toBe(500);
    expect((await handoffFailed.json()).error.code).toBe("PRODUCT_BATCH_HANDOFF_FAILED");
    expect(mocks.startCaptureRun).not.toHaveBeenCalled();
    expect(mocks.autoDrive).not.toHaveBeenCalled();
  });

  it("批次交接失败后用同一操作编号只恢复交接，并回放已完成结果", async () => {
    const operationId = "search-recovery-0001";
    mocks.handoff.mockRejectedValueOnce(new Error("batch persistence failed"));
    const failedHandoff = await POST(request({ query: "christmas tree", authorizedItemLimit: 1, operationId }));
    expect(failedHandoff.status).toBe(500);
    expect((await failedHandoff.json()).error.code).toBe("PRODUCT_BATCH_HANDOFF_FAILED");
    expect(mocks.collect).toHaveBeenCalledTimes(1);

    const recovered = await POST(request({ query: "christmas tree", authorizedItemLimit: 1, operationId }));
    expect(recovered.status).toBe(201);
    const recoveredBody = await recovered.json();
    expect(recoveredBody.data).toMatchObject({ operationId, productBatchHandoff: { batchId: "batch-search-0001" } });
    expect(mocks.collect).toHaveBeenCalledTimes(1);
    expect(mocks.handoff).toHaveBeenCalledTimes(2);
    expect(mocks.handoff.mock.calls[1]?.[0]).toMatchObject({
      captures: [],
      persistedEvidenceReferences: [{
        subjectKey: "amazon:US:B000000001",
        captureId: "capture-01",
        evidenceId: "evidence-01",
        evidenceVersion: 1,
        contentHash: "a".repeat(64),
      }],
    });

    const replay = await POST(request({ query: "christmas tree", authorizedItemLimit: 1, operationId }));
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(recoveredBody);
    expect(mocks.collect).toHaveBeenCalledTimes(1);
  });

  it("P0-1) 未声明授权数量一律拒绝，且不发起搜索", async () => {
    const response = await POST(request({ query: "christmas tree" }));
    const json = await response.json();
    expect(response.status).toBe(400);
    expect(json.error.code).toBe("authorized_item_limit_required");
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it("P0-1) 授权数量越界一律拒绝", async () => {
    for (const bad of [0, 201, 2.5]) {
      const response = await POST(request({ query: "christmas tree", authorizedItemLimit: bad }));
      expect(response.status).toBe(400);
    }
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it("P0-1) pages/maxAppearances 与授权上限冲突时拒绝", async () => {
    const response = await POST(request({ query: "christmas tree", authorizedItemLimit: 5, maxAppearances: 60 }));
    const json = await response.json();
    expect(response.status).toBe(400);
    expect(json.error.code).toBe("sample_budget_conflict");
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it("访客批次同样不创建运行", async () => {
    mocks.auth.mockReturnValue({ ok: true, context: { mode: "demo", token: "", demoAccessId: "demo-one" } });
    const visitorResponse = await POST(request({ query: "christmas tree", authorizedItemLimit: 1 }));
    expect(visitorResponse.status).toBe(201);
    const json = await visitorResponse.json();
    expect(json.data.batchCaptureRun).toBeNull();
    expect(mocks.startCaptureRun).not.toHaveBeenCalled();
    expect(mocks.autoDrive).not.toHaveBeenCalled();
  });
});
