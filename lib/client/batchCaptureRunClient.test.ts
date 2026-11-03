import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchBatchCaptureRun, postBatchCaptureRunAction, postBatchCaptureRunActionRaw } from "./batchCaptureRunClient";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("batch capture run client contract", () => {
  it("reads the authoritative run from the batch-capture endpoint", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { run: { runId: "run-01", batchId: "batch-01", status: "RUNNING" } } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBatchCaptureRun("batch-01");
    expect(result).toEqual({ ok: true, run: { runId: "run-01", batchId: "batch-01", status: "RUNNING" } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/source-layer/batch-capture?batchId=batch-01");
    expect(init.cache).toBe("no-store");
  });

  it("returns run=null when the batch has no executor yet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, data: { run: null } })));
    expect(await fetchBatchCaptureRun("batch-01")).toEqual({ ok: true, run: null });
  });

  it("surfaces a server business error instead of inventing progress", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: { code: "BATCH_CAPTURE_RUN_NOT_FOUND", message: "尚未创建批次自动采集任务。" } }, 404)));
    const result = await fetchBatchCaptureRun("batch-01");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("BATCH_CAPTURE_RUN_NOT_FOUND");
      expect(result.errorMessage).toContain("尚未创建");
    }
  });

  it("reports a network failure explicitly so the UI can keep the last persisted state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("failed to fetch"); }));
    const result = await fetchBatchCaptureRun("batch-01");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("NETWORK_ERROR");
      expect(result.errorMessage).toContain("网络连接中断");
    }
  });

  it("posts a drive action with the authorized batch id and returns the new run", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { run: { runId: "run-01", status: "RUNNING" } } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postBatchCaptureRunAction("batch-01", "drive", { maxSlices: 4, allowRetry: true });
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/source-layer/batch-capture");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ batchId: "batch-01", action: "drive", maxSlices: 4, allowRetry: true });
  });

  it.each(["pause", "resume", "cancel", "retry"] as const)("posts the %s action", async (action) => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { run: null } }));
    vi.stubGlobal("fetch", fetchMock);
    await postBatchCaptureRunAction("batch-01", action);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ batchId: "batch-01", action });
  });

  it("does not claim success when the action request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: { code: "BATCH_CAPTURE_RUN_PAUSED", message: "任务已暂停，请先继续。" } }, 409)));
    const result = await postBatchCaptureRunAction("batch-01", "drive");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe("BATCH_CAPTURE_RUN_PAUSED");
  });

  it("posts a start action carrying the authorized item limit and module scope", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      ok: true,
      data: {
        created: true,
        run: { runId: "run-02", status: "WAITING", runGeneration: 1 },
        searchNavigationProvenance: { provenance: "search_stage_receipt", used: 2, reason: "批次回执" },
      },
    }, 201));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postBatchCaptureRunActionRaw("batch-01", "start", {
      authorizedItemLimit: 12,
      allowedModules: ["amazon_detail", "variation", "review_voc", "reverse_asin", "sellersprite_product_market", "keyword_mining_trend", "historical_trend", "amazon_search_market"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.created).toBe(true);
      expect(result.run?.runId).toBe("run-02");
      expect(result.searchNavigationProvenance).toMatchObject({ provenance: "search_stage_receipt", used: 2 });
    }
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ batchId: "batch-01", action: "start", authorizedItemLimit: 12 });
    expect(Array.isArray(body.allowedModules)).toBe(true);
    // 客户端绝不提交 searchNavigationUsed：该值只能由服务端从批次回执推导。
    expect(body).not.toHaveProperty("searchNavigationUsed");
  });

  it("does not claim a run was created when the server rejects the start", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      ok: false,
      error: { code: "AUTHORIZED_ITEM_LIMIT_REQUIRED", message: "必须显式声明本次授权的商品数量上限。" },
    }, 400)));
    const result = await postBatchCaptureRunActionRaw("batch-01", "start", { authorizedItemLimit: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("AUTHORIZED_ITEM_LIMIT_REQUIRED");
      expect(result.errorMessage).toContain("必须显式声明");
    }
  });

  it("posts the manual recovery action with the exact execution identity and reason", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { run: { runId: "run-01", status: "CANCELLED" } } }));
    vi.stubGlobal("fetch", fetchMock);

    await postBatchCaptureRunAction("batch-01", "recover_stalled_execution", {
      recovery: { runId: "run-01", runGeneration: 1, executionEpoch: 2, reason: "已核对旧采集进程不再存活" },
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      batchId: "batch-01",
      action: "recover_stalled_execution",
      runId: "run-01",
      runGeneration: 1,
      executionEpoch: 2,
      reason: "已核对旧采集进程不再存活",
    });
  });
});
