import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CapturePlanPanel,
  describeCapturePlanExecutionState,
  describeRunControlStatus,
} from "./CapturePlanPanel";
import { buildMarketCapturePlan } from "@/lib/sourceLayer/captureStrategy/marketCapturePlan";

import type { CapturePlanConfirmResult } from "@/lib/client/capturePlanClient";

function planFixture(strategyId: "full_market_capture" | "quick_market_scan" = "full_market_capture") {
  return buildMarketCapturePlan({
    strategyId,
    batchId: "batch-market-0001",
    marketTargetItemCount: 60,
    batchCapacity: 60,
    authorizedItemCount: 60,
    searchNavigationUsed: 2,
  });
}

const previewOk = async () => ({
  ok: true as const,
  plan: planFixture(),
  batchContext: {
    batchId: "batch-market-0001",
    batchCapacity: 60,
    batchSourceType: "amazon_search_capture",
    searchNavigationUsed: 2,
    searchNavigationKnown: true,
  },
});

/** 受控的预览实现：首次调用立即 resolve，便于服务端渲染断言初始加载态。 */
function deferredPreview() {
  let resolve: ((value: Awaited<ReturnType<typeof previewOk>>) => void) | null = null;
  const promise = new Promise<Awaited<ReturnType<typeof previewOk>>>((res) => { resolve = res; });
  return { call: () => promise, resolve: (value: Awaited<ReturnType<typeof previewOk>>) => resolve?.(value) };
}

describe("CapturePlanPanel（市场采集计划面板）", () => {
  it("初始渲染：两种策略可选、目标数量与批次容量可见、提示计划未确认前不采集", () => {
    const previewer = vi.fn(() => deferredPreview().call());
    const html = renderToStaticMarkup(createElement(CapturePlanPanel, {
      batchId: "batch-market-0001",
      batchCapacity: 60,
      previewer: previewer as never,
      confirmer: (async () => ({ ok: false, errorCode: "X", errorMessage: "x" })) as never,
    }));

    expect(html).toContain("市场采集计划");
    expect(html).toContain("完整市场采集");
    expect(html).toContain("快速市场扫描");
    expect(html).toContain('data-testid="capture-strategy-full_market_capture"');
    expect(html).toContain('data-testid="capture-strategy-quick_market_scan"');
    expect(html).toContain('data-testid="capture-target-count"');
    expect(html).toContain('data-testid="capture-batch-capacity">60<');
    expect(html).toContain("计划待确认");
    expect(html).toContain("计划未确认前不会采集任何商品");
    // 计划尚未返回时不显示确认按钮之外的矩阵内容
    expect(html).not.toContain('data-testid="capture-plan-matrix"');
  });

  it("计划返回前不提供任何确认入口（不能确认不存在的计划）", () => {
    const previewer = vi.fn(() => deferredPreview().call());
    const html = renderToStaticMarkup(createElement(CapturePlanPanel, {
      batchId: "batch-market-0001",
      batchCapacity: 60,
      previewer: previewer as never,
      confirmer: (async () => ({ ok: false, errorCode: "X", errorMessage: "x" })) as never,
    }));
    // 计划未就绪时确认、刷新、矩阵按钮都不渲染，用户没有任何途径在无计划的情况下确认。
    expect(html).not.toContain('data-testid="capture-plan-confirm"');
    expect(html).not.toContain('data-testid="capture-plan-refresh"');
    expect(html).not.toContain('data-testid="capture-plan-toggle-matrix"');
    expect(html).not.toContain('data-testid="capture-plan-confirmed"');
  });

  it("已有采集任务时如实标注为已创建，而不是显示待确认", () => {
    const previewer = vi.fn(() => deferredPreview().call());
    const html = renderToStaticMarkup(createElement(CapturePlanPanel, {
      batchId: "batch-market-0001",
      batchCapacity: 60,
      existingRunStatus: "RUNNING",
      previewer: previewer as never,
      confirmer: (async () => ({ ok: false, errorCode: "X", errorMessage: "x" })) as never,
    }));
    // 粗粒度提示只证明「存在任务」；权威的控制状态与计划绑定来自 GET 的 existingRun 回执。
    expect(html).toContain("已有采集任务（RUNNING）");
    expect(html).not.toContain("计划待确认");
  });

  it("执行状态表述：执行器启动不等于真实采集成功，Mock/等待/未知分别表述（A3）", () => {
    // 执行器已启动：只能说明控制流程开始，必须指向回执与证据，禁止宣称采集成功。
    const started = describeCapturePlanExecutionState({
      created: true, runStatus: "WAITING", driveStarted: true, driveError: null,
    });
    expect(started.label).toBe("任务已创建，执行器已启动");
    expect(started.note).toContain("仅表示控制流程开始");
    expect(started.note).toContain("回执为准");
    expect(started.note).not.toContain("采集成功");

    // 执行器未启动：任务已保留，真实采集尚未开始。
    const waiting = describeCapturePlanExecutionState({
      created: true, runStatus: "WAITING", driveStarted: false, driveError: null,
    });
    expect(waiting.label).toBe("任务已创建（等待执行条件）");

    // 执行器启动失败：如实报告原因，不回滚已创建任务。
    const failed = describeCapturePlanExecutionState({
      created: true, runStatus: "WAITING", driveStarted: false, driveError: "BATCH_CAPTURE_LEASE_BUSY",
    });
    expect(failed.label).toBe("任务已创建（执行器未启动）");
    // 已知错误码优先显示中文原因；未知错误码保留原始码，便于排查，不猜测。
    expect(failed.note).toContain("采集执行租约被占用");
    const failedUnknown = describeCapturePlanExecutionState({
      created: true, runStatus: "WAITING", driveStarted: false, driveError: "SOME_NEW_CODE",
    });
    expect(failedUnknown.note).toContain("SOME_NEW_CODE");
    // D2-1E：环境未启用时给出可理解的中文原因。
    const failedLocalEnv = describeCapturePlanExecutionState({
      created: true, runStatus: "WAITING", driveStarted: false, driveError: "LOCAL_ENVIRONMENT_REQUIRED",
    });
    expect(failedLocalEnv.note).toContain("本地采集未启用");

    // 幂等复用：没有重复创建，也没有扩大授权。
    const reused = describeCapturePlanExecutionState({
      created: false, runStatus: "RUNNING", driveStarted: true, driveError: null,
    });
    expect(reused.label).toBe("任务已存在（幂等复用）");
    expect(reused.note).toContain("没有扩大授权");
  });

  it("运行控制状态标签：已知状态映射中文，未知状态原样透出不猜测", () => {
    expect(describeRunControlStatus("RUNNING")).toBe("采集中");
    expect(describeRunControlStatus("HUMAN_REQUIRED")).toBe("需要人工处理");
    expect(describeRunControlStatus("CANCELLED")).toBe("已中止");
    expect(describeRunControlStatus(null)).toBe("未知");
    expect(describeRunControlStatus("SOMETHING_NEW")).toContain("SOMETHING_NEW");
  });

  it("客户端契约：预览不提交预算、确认必须携带指纹（防止前端篡改）", async () => {
    const { fetchCapturePlan, confirmCapturePlan } = await import("@/lib/client/capturePlanClient");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init || init.method !== "POST") {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            plan: planFixture(),
            batchContext: { batchId: "b1", batchCapacity: 60, batchSourceType: null, searchNavigationUsed: 2, searchNavigationKnown: true },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        ok: true,
        data: {
          plan: planFixture(),
          created: true,
          drive: { started: true },
          driveError: null,
          run: { runId: "run-01", status: "WAITING" },
        },
      }), { status: 201, headers: { "content-type": "application/json" } });
    }));

    const preview = await fetchCapturePlan({ batchId: "b1", strategyId: "full_market_capture", marketTargetItemCount: 60 });
    expect(preview.ok).toBe(true);
    expect(calls[0].url).toContain("strategyId=full_market_capture");
    expect(calls[0].url).toContain("marketTargetItemCount=60");
    // 预览请求不得携带任何预算字段
    expect(calls[0].url).not.toContain("navigationLimit");
    expect(calls[0].url).not.toContain("allowedModules");

    const confirmed = await confirmCapturePlan({
      batchId: "b1",
      strategyId: "full_market_capture",
      marketTargetItemCount: 60,
      planFingerprint: "a".repeat(64),
    });
    expect(confirmed.ok).toBe(true);
    const body = JSON.parse(String(calls[1].init?.body)) as Record<string, unknown>;
    expect(body.planFingerprint).toBe("a".repeat(64));
    expect(body).not.toHaveProperty("navigationLimit");
    expect(body).not.toHaveProperty("allowedModules");
    expect(body).not.toHaveProperty("authorizedItemLimit");

    vi.unstubAllGlobals();
  });

  it("客户端契约：服务端拒绝时如实透出业务错误码，不谎报成功", async () => {
    const { confirmCapturePlan } = await import("@/lib/client/capturePlanClient");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: "MARKET_PLAN_FINGERPRINT_MISMATCH", message: "计划已变化，请刷新后重新确认。" },
    }), { status: 409, headers: { "content-type": "application/json" } })));

    const result: CapturePlanConfirmResult = await confirmCapturePlan({
      batchId: "b1",
      strategyId: "full_market_capture",
      planFingerprint: "b".repeat(64),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("MARKET_PLAN_FINGERPRINT_MISMATCH");
      expect(result.errorMessage).toContain("计划已变化");
    }
    vi.unstubAllGlobals();
  });
});
