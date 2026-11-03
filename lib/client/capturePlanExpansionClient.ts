import { buildAccessHeaders } from "@/lib/client/accessToken";
import type { MarketCaptureExpansionPreview } from "@/lib/sourceLayer/captureStrategy/marketCaptureExpansion";

const ENDPOINT = "/api/source-layer/capture-plan/expand";

export type CaptureExpansionPreviewResult =
  | { ok: true; preview: MarketCaptureExpansionPreview; localAcquisitionEnabled: boolean; expansionRecovery: CaptureExpansionRecovery }
  | { ok: false; errorCode: string; errorMessage: string };

export type CaptureExpansionRecovery = {
  available: boolean;
  recoveryRequired?: boolean;
  manualReviewRequired?: boolean;
  recoveryPending?: boolean;
  authorizationId?: string;
  stage?: string;
  ownerPid?: number | null;
  ownerHost?: string | null;
  requiresProfileConfirmation?: boolean;
  message?: string;
  reason?: string;
};

export type CaptureExpansionRecoveryResult =
  | { ok: true; message: string; batchItemCount: number; addedCount: number; runStatus: string | null }
  | { ok: false; errorCode: string; errorMessage: string };

export type CaptureExpansionConfirmResult =
  | {
      ok: true;
      authorizationRecorded: boolean;
      searchStatus: "target_reached" | "insufficient_results" | "blocked";
      batchItemCount: number;
      targetTotal: number;
      addedCount: number;
      duplicateProductCount?: number;
      validEvidenceCount: number;
      detailCompletedCount: number;
      runId: string | null;
      runStatus: string | null;
      runGeneration: number | null;
      driveStarted: boolean;
      driveError: string | null;
      sourceAccess: string;
      errorCode?: string;
      message: string;
    }
  | { ok: false; errorCode: string; errorMessage: string };

function readError(value: unknown, fallback: string): { errorCode: string; errorMessage: string } {
  const error = (value as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return {
    errorCode: typeof error?.code === "string" ? error.code : "CAPTURE_EXPANSION_CLIENT_ERROR",
    errorMessage: typeof error?.message === "string" && error.message.trim() ? error.message : fallback,
  };
}

export async function fetchCaptureExpansionPreview(input: {
  batchId: string;
  targetTotal: number;
  signal?: AbortSignal;
}): Promise<CaptureExpansionPreviewResult> {
  try {
    const params = new URLSearchParams({ batchId: input.batchId, targetTotal: String(input.targetTotal) });
    const response = await fetch(`${ENDPOINT}?${params.toString()}`, {
      headers: buildAccessHeaders(),
      cache: "no-store",
      signal: input.signal,
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || (json as { ok?: unknown } | null)?.ok !== true) {
      return { ok: false, ...readError(json, `读取扩充计划失败 (${response.status})。`) };
    }
    const data = (json as { data?: { preview?: MarketCaptureExpansionPreview; localAcquisitionEnabled?: unknown; expansionRecovery?: CaptureExpansionRecovery } }).data;
    if (!data?.preview || typeof data.localAcquisitionEnabled !== "boolean") {
      return { ok: false, errorCode: "CAPTURE_EXPANSION_RESPONSE_INVALID", errorMessage: "服务端扩充预览不完整，已拒绝展示。" };
    }
    return { ok: true, preview: data.preview, localAcquisitionEnabled: data.localAcquisitionEnabled,
      expansionRecovery: data.expansionRecovery && typeof data.expansionRecovery.available === "boolean"
        ? data.expansionRecovery : { available: false, reason: "恢复状态不可读取。" } };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, errorCode: "ABORTED", errorMessage: "扩充预览已取消。" };
    }
    return { ok: false, errorCode: "NETWORK_ERROR", errorMessage: "网络连接中断，未能读取扩充预览。" };
  }
}

export async function recoverStalledCaptureExpansion(input: {
  batchId: string;
  authorizationId: string;
  confirmProfileReleased: boolean;
}): Promise<CaptureExpansionRecoveryResult> {
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildAccessHeaders() },
      body: JSON.stringify({ ...input, action: "recover_stalled" }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || (json as { ok?: unknown } | null)?.ok !== true) {
      return { ok: false, ...readError(json, `恢复扩充任务失败 (${response.status})。`) };
    }
    const data = (json as { data?: Partial<Extract<CaptureExpansionRecoveryResult, { ok: true }>> }).data;
    if (!data || typeof data.message !== "string" || typeof data.batchItemCount !== "number" || typeof data.addedCount !== "number") {
      return { ok: false, errorCode: "CAPTURE_EXPANSION_RECOVERY_RESPONSE_INVALID", errorMessage: "恢复结果不完整，请刷新读取服务端状态。" };
    }
    return { ok: true, message: data.message, batchItemCount: data.batchItemCount, addedCount: data.addedCount,
      runStatus: typeof data.runStatus === "string" ? data.runStatus : null };
  } catch {
    return { ok: false, errorCode: "NETWORK_ERROR", errorMessage: "连接中断，无法确认恢复是否完成；请刷新读取服务端状态，不要重新搜索。" };
  }
}

export async function confirmCaptureExpansion(input: {
  batchId: string;
  targetTotal: number;
  planFingerprint: string;
  authorizationId: string;
}): Promise<CaptureExpansionConfirmResult> {
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildAccessHeaders() },
      body: JSON.stringify(input),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || (json as { ok?: unknown } | null)?.ok !== true) {
      return { ok: false, ...readError(json, `确认扩充失败 (${response.status})。`) };
    }
    const data = (json as { data?: Partial<Extract<CaptureExpansionConfirmResult, { ok: true }>> }).data;
    if (!data || typeof data.batchItemCount !== "number" || typeof data.targetTotal !== "number"
      || typeof data.addedCount !== "number" || typeof data.validEvidenceCount !== "number"
      || typeof data.detailCompletedCount !== "number"
      || !["target_reached", "insufficient_results", "blocked"].includes(String(data.searchStatus))) {
      return { ok: false, errorCode: "CAPTURE_EXPANSION_RESPONSE_INVALID", errorMessage: "服务端扩充结果不完整，请刷新后以批次和 Run 持久化状态为准。" };
    }
    return {
      ok: true,
      authorizationRecorded: data.authorizationRecorded === true,
      searchStatus: data.searchStatus as "target_reached" | "insufficient_results" | "blocked",
      batchItemCount: data.batchItemCount,
      targetTotal: data.targetTotal,
      addedCount: data.addedCount,
      duplicateProductCount: typeof data.duplicateProductCount === "number" ? data.duplicateProductCount : 0,
      validEvidenceCount: data.validEvidenceCount,
      detailCompletedCount: data.detailCompletedCount,
      runId: typeof data.runId === "string" ? data.runId : null,
      runStatus: typeof data.runStatus === "string" ? data.runStatus : null,
      runGeneration: typeof data.runGeneration === "number" ? data.runGeneration : null,
      driveStarted: data.driveStarted === true,
      driveError: typeof data.driveError === "string" ? data.driveError : null,
      sourceAccess: typeof data.sourceAccess === "string" ? data.sourceAccess : "UNKNOWN",
      errorCode: typeof data.errorCode === "string" ? data.errorCode : undefined,
      message: typeof data.message === "string" ? data.message : "扩充操作已处理，请核对服务端状态。",
    };
  } catch {
    return { ok: false, errorCode: "NETWORK_ERROR", errorMessage: "连接中断，无法确认扩充是否完成；请刷新读取服务端状态，勿重复搜索。" };
  }
}
