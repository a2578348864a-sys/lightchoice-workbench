import { buildAccessHeaders } from "@/lib/client/accessToken";
import type { MarketCapturePlan } from "@/lib/sourceLayer/captureStrategy/marketCapturePlan";

/**
 * 市场采集计划（Market Capture Plan）的唯一前端数据入口。
 *
 * 规则：
 * - 预览与确认都只把「策略 + 目标数量」交给服务端；预算、模块矩阵、导航上限一律由服务端推导，
 *   前端**不**提交、也不缓存这些数字，避免出现「页面显示一个数、后端执行另一个数」。
 * - 确认必须携带服务端预览返回的计划指纹；指纹不符时服务端会拒绝（页面如实显示原因）。
 */

const ENDPOINT = "/api/source-layer/capture-plan";

/** 已存在 Capture Run 的只读摘要（GET 预览透出；只读，不创建不驱动）。 */
export type CapturePlanExistingRun = {
  runId: string;
  status: string;
  /** 绑定的计划指纹；旧代次（无计划绑定）为 null。 */
  planFingerprint: string | null;
  planStrategyId: string | null;
  authorizedItemLimit: number;
};

export type CapturePlanPreviewResult =
  | {
      ok: true;
      plan: MarketCapturePlan;
      batchContext: {
        batchId: string;
        batchCapacity: number;
        batchSourceType: string | null;
        searchNavigationUsed: number;
        searchNavigationKnown: boolean;
      };
      /** 已存在的采集任务摘要；null 表示当前没有任务。 */
      existingRun: CapturePlanExistingRun | null;
      /** 任务回执读取失败：面板不得把未知显示成「计划待确认」。 */
      existingRunReadFailed: boolean;
      /** 服务端实际生效的批量采集能力（V5_ACQUISITION_SCOPE）；缺失按不允许处理。 */
      acquisition?: { batchCaptureScopeAllowed: boolean };
    }
  | { ok: false; errorCode: string; errorMessage: string };

export type CapturePlanConfirmResult =
  | {
    ok: true;
    plan: MarketCapturePlan;
    runStatus: string | null;
    runId: string | null;
    created: boolean;
    driveStarted: boolean;
    driveError: string | null;
  }
  | { ok: false; errorCode: string; errorMessage: string };

function readError(json: unknown, fallback: string): { errorCode: string; errorMessage: string } {
  const error = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return {
    errorCode: typeof error?.code === "string" ? error.code : "CAPTURE_PLAN_CLIENT_ERROR",
    errorMessage: typeof error?.message === "string" && error.message.trim() ? error.message : fallback,
  };
}

export async function fetchCapturePlan(input: {
  batchId: string;
  strategyId: string;
  marketTargetItemCount?: number;
  authorizedItemCount?: number;
  supplementalModules?: readonly string[];
  signal?: AbortSignal;
}): Promise<CapturePlanPreviewResult> {
  const params = new URLSearchParams({
    batchId: input.batchId,
    strategyId: input.strategyId,
  });
  if (typeof input.marketTargetItemCount === "number") {
    params.set("marketTargetItemCount", String(input.marketTargetItemCount));
  }
  if (typeof input.authorizedItemCount === "number") {
    params.set("authorizedItemCount", String(input.authorizedItemCount));
  }
  if (input.supplementalModules && input.supplementalModules.length > 0) {
    params.set("supplementalModules", input.supplementalModules.join(","));
  }
  try {
    const response = await fetch(`${ENDPOINT}?${params.toString()}`, {
      headers: buildAccessHeaders(),
      cache: "no-store",
      signal: input.signal,
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !(json as { ok?: unknown } | null)?.ok) {
      return { ok: false, ...readError(json, `读取采集计划失败 (${response.status})。`) };
    }
    const data = (json as {
      data?: {
        plan?: MarketCapturePlan;
        batchContext?: {
          batchId: string;
          batchCapacity: number;
          batchSourceType: string | null;
          searchNavigationUsed: number;
          searchNavigationKnown: boolean;
        };
        existingRun?: CapturePlanExistingRun | null;
        existingRunReadFailed?: boolean;
        acquisition?: { batchCaptureScopeAllowed: boolean };
      };
    }).data;
    if (!data?.plan || !data.batchContext) {
      return { ok: false, errorCode: "CAPTURE_PLAN_RESPONSE_INVALID", errorMessage: "服务端返回的采集计划不完整，已拒绝展示。" };
    }
    return {
      ok: true,
      plan: data.plan,
      batchContext: data.batchContext,
      existingRun: data.existingRun ?? null,
      existingRunReadFailed: data.existingRunReadFailed === true,
      // 必须原样透传：面板据此决定是否允许确认批量计划。
      // 之前漏传导致 batch_and_single 也被禁用（真实缺陷，非测试问题）。
      acquisition: data.acquisition,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, errorCode: "ABORTED", errorMessage: "读取已取消。" };
    }
    return { ok: false, errorCode: "NETWORK_ERROR", errorMessage: "网络连接中断，未能读取采集计划。" };
  }
}

export async function confirmCapturePlan(input: {
  batchId: string;
  strategyId: string;
  marketTargetItemCount?: number;
  authorizedItemCount?: number;
  supplementalModules?: readonly string[];
  planFingerprint: string;
}): Promise<CapturePlanConfirmResult> {
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildAccessHeaders() },
      body: JSON.stringify({
        batchId: input.batchId,
        strategyId: input.strategyId,
        ...(typeof input.marketTargetItemCount === "number" ? { marketTargetItemCount: input.marketTargetItemCount } : {}),
        ...(typeof input.authorizedItemCount === "number" ? { authorizedItemCount: input.authorizedItemCount } : {}),
        ...(input.supplementalModules && input.supplementalModules.length > 0
          ? { supplementalModules: [...input.supplementalModules] }
          : {}),
        planFingerprint: input.planFingerprint,
      }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !(json as { ok?: unknown } | null)?.ok) {
      return { ok: false, ...readError(json, `确认采集计划失败 (${response.status})。`) };
    }
    const data = (json as {
      data?: {
        plan?: MarketCapturePlan;
        created?: boolean;
        drive?: { started?: boolean } | null;
        driveError?: string | null;
        run?: { runId?: string; status?: string } | null;
      };
    }).data;
    if (!data?.plan) {
      return { ok: false, errorCode: "CAPTURE_PLAN_RESPONSE_INVALID", errorMessage: "服务端返回的采集计划不完整，已拒绝展示。" };
    }
    return {
      ok: true,
      plan: data.plan,
      runId: typeof data.run?.runId === "string" ? data.run.runId : null,
      runStatus: typeof data.run?.status === "string" ? data.run.status : null,
      created: data.created === true,
      driveStarted: data.drive?.started === true,
      driveError: typeof data.driveError === "string" ? data.driveError : null,
    };
  } catch {
    return { ok: false, errorCode: "NETWORK_ERROR", errorMessage: "网络连接中断，确认未提交；请刷新后以服务端状态为准。" };
  }
}
