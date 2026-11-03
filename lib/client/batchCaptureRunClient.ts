import { buildAccessHeaders } from "@/lib/client/accessToken";
import type { BatchCaptureRunView } from "@/lib/sourceLayer/batchCaptureRunPresentation";

/**
 * BatchCaptureRun 的唯一前端数据入口。
 * 只读取/操作服务端权威状态，不在前端缓存或伪造进度。
 */

const ENDPOINT = "/api/source-layer/batch-capture";

export type BatchCaptureRunStatusResult =
  | { ok: true; run: BatchCaptureRunView | null }
  | { ok: false; errorCode: string; errorMessage: string };

export type BatchCaptureRunDriveInfo = {
  started: boolean;
  alreadyRunning: boolean;
  runId: string | null;
  status: string | null;
  errorCode: string | null;
  message: string;
};

export type BatchCaptureRunActionResult =
  | { ok: true; run: BatchCaptureRunView | null; drive?: BatchCaptureRunDriveInfo | null }
  | { ok: false; errorCode: string; errorMessage: string };

function readError(json: unknown, fallback: string): { errorCode: string; errorMessage: string } {
  const error = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return {
    errorCode: typeof error?.code === "string" ? error.code : "BATCH_CAPTURE_CLIENT_ERROR",
    errorMessage: typeof error?.message === "string" && error.message.trim() ? error.message : fallback,
  };
}

export async function fetchBatchCaptureRun(
  batchId: string,
  init: { signal?: AbortSignal } = {},
): Promise<BatchCaptureRunStatusResult> {
  try {
    const response = await fetch(`${ENDPOINT}?batchId=${encodeURIComponent(batchId)}`, {
      headers: buildAccessHeaders(),
      cache: "no-store",
      signal: init.signal,
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !(json as { ok?: unknown } | null)?.ok) {
      const failure = readError(json, `读取批次自动采集状态失败 (${response.status})。`);
      return { ok: false, ...failure };
    }
    const run = (json as { data?: { run?: BatchCaptureRunView | null } }).data?.run ?? null;
    return { ok: true, run };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, errorCode: "ABORTED", errorMessage: "读取已取消。" };
    }
    return { ok: false, errorCode: "NETWORK_ERROR", errorMessage: "网络连接中断，未能读取批次自动采集状态；页面显示的仍是上一次持久化状态。" };
  }
}

export type BatchCaptureRunAction =
  | "start"
  | "drive"
  | "pause"
  | "resume"
  | "cancel"
  | "retry"
  | "recover_stalled_execution"
  | "prepare_product_market_query"
  | "prepare_keyword_mining_query";

export type BatchCaptureRunActionOptions = {
  maxSlices?: number;
  allowRetry?: boolean;
  query?: { category: string; filters?: Record<string, string> };
  keywordMiningQuery?: { seedKeyword: string; conditions?: Record<string, string> };
  /** 仅 start：本次用户明确授权的商品数量上限（服务端会重新校验）。 */
  authorizedItemLimit?: number;
  /** 仅 start：本次授权覆盖的模块范围；缺省使用服务端默认八模块矩阵。 */
  allowedModules?: string[];
  /** 仅 start：每轮推进的商品预算。 */
  maxItemsPerAdvance?: number;
  /** 仅 recover_stalled_execution：旧执行器的精确身份 + 人工核对原因。 */
  recovery?: {
    runId: string;
    runGeneration: number;
    executionEpoch: number;
    reason: string;
  };
};

export type BatchCaptureRunStartResult =
  | {
    ok: true;
    run: BatchCaptureRunView | null;
    created: boolean;
    searchNavigationProvenance: { provenance: string; used: number; reason: string } | null;
    drive?: BatchCaptureRunDriveInfo | null;
  }
  | { ok: false; errorCode: string; errorMessage: string };

export async function postBatchCaptureRunAction(
  batchId: string,
  action: BatchCaptureRunAction,
  options: BatchCaptureRunActionOptions = {},
): Promise<BatchCaptureRunActionResult> {
  const started = await postBatchCaptureRunActionRaw(batchId, action, options);
  if (!started.ok) return started;
  return { ok: true, run: started.run, drive: started.drive ?? null };
}

/** 与 `postBatchCaptureRunAction` 同一请求路径；额外返回 start 的创建结果与预算来源。 */
export async function postBatchCaptureRunActionRaw(
  batchId: string,
  action: BatchCaptureRunAction,
  options: BatchCaptureRunActionOptions = {},
): Promise<BatchCaptureRunStartResult> {
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildAccessHeaders() },
      body: JSON.stringify({
        batchId,
        action,
        ...(typeof options.maxSlices === "number" ? { maxSlices: options.maxSlices } : {}),
        ...(options.allowRetry ? { allowRetry: true } : {}),
        ...(options.query ? { query: options.query } : {}),
        ...(options.keywordMiningQuery ? { keywordMiningQuery: options.keywordMiningQuery } : {}),
        ...(typeof options.authorizedItemLimit === "number" ? { authorizedItemLimit: options.authorizedItemLimit } : {}),
        ...(Array.isArray(options.allowedModules) ? { allowedModules: options.allowedModules } : {}),
        ...(typeof options.maxItemsPerAdvance === "number" ? { maxItemsPerAdvance: options.maxItemsPerAdvance } : {}),
        ...(options.recovery
          ? {
            runId: options.recovery.runId,
            runGeneration: options.recovery.runGeneration,
            executionEpoch: options.recovery.executionEpoch,
            reason: options.recovery.reason,
          }
          : {}),
      }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !(json as { ok?: unknown } | null)?.ok) {
      const failure = readError(json, `批次自动采集操作失败 (${response.status})。`);
      return { ok: false, ...failure };
    }
    const data = (json as {
      data?: {
        run?: BatchCaptureRunView | null;
        created?: boolean;
        searchNavigationProvenance?: { provenance: string; used: number; reason: string } | null;
        drive?: BatchCaptureRunDriveInfo | null;
      };
    }).data;
    return {
      ok: true,
      run: data?.run ?? null,
      created: data?.created === true,
      searchNavigationProvenance: data?.searchNavigationProvenance ?? null,
      drive: data?.drive ?? null,
    };
  } catch {
    return { ok: false, errorCode: "NETWORK_ERROR", errorMessage: "网络连接中断，操作未确认；请刷新后以服务端状态为准。" };
  }
}
