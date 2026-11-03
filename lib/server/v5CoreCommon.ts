import "server-only";

import { randomUUID } from "node:crypto";
import type { AccessContext } from "@/lib/server/accessPassword";
import { prisma } from "@/lib/server/db";
import { hashJson } from "@/lib/server/v5CanonicalHash";

export { canonicalJson, hashJson } from "@/lib/server/v5CanonicalHash";

export const V5_SCHEMA_VERSION = "core-api.v1" as const;

export class V5CoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly retryable = false,
    public readonly conflict = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "V5CoreError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonRecord(value: string | null | undefined, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (!value) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function actorScopeOf(context: AccessContext): string {
  return context.mode === "owner" ? "owner:v1" : `visitor:${context.demoAccessId}`;
}

export function requireOwnerContext(context: AccessContext): void {
  if (context.mode !== "owner") {
    throw new V5CoreError("FORBIDDEN", "当前主体不允许访问 V5 正式核心数据。", 403);
  }
}

export function resourceVersion(updatedAt: Date): string {
  return updatedAt.toISOString();
}

export function assertExpectedVersion(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new V5CoreError("EXPECTED_VERSION_REQUIRED", "危险写操作必须携带 expectedVersion。", 400);
  }
  const normalized = String(value).trim();
  if (!normalized) {
    throw new V5CoreError("EXPECTED_VERSION_REQUIRED", "危险写操作必须携带 expectedVersion。", 400);
  }
  return normalized;
}

export function assertExpectedVersionMatches(expected: string, updatedAt: Date): void {
  const current = resourceVersion(updatedAt);
  if (expected !== current && expected !== String(updatedAt.getTime())) {
    throw new V5CoreError(
      "CAS_CONFLICT",
      "对象已在其他页面更新，请刷新后重试。",
      409,
      true,
      true,
      { currentVersion: current },
    );
  }
}

export function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 128) {
    throw new V5CoreError("IDEMPOTENCY_KEY_REQUIRED", "写操作必须携带 Idempotency-Key。", 400);
  }
  return value.trim();
}

export async function withV5Receipt<T>(input: {
  context: AccessContext;
  operation: string;
  resourceKey: string;
  idempotencyKey: string;
  requestBody: unknown;
  execute: () => Promise<T>;
  /** Optional read-only proof for recovering an abandoned processing receipt. */
  reconcileProcessing?: { readonly staleAfterMs?: number; readonly run: () => Promise<T | null> };
}): Promise<{ value: T; replayed: boolean; receiptId: string }> {
  requireOwnerContext(input.context);
  const actorScope = actorScopeOf(input.context);
  const requestHash = hashJson(input.requestBody);
  const existing = await prisma.v5OperationReceipt.findUnique({
    where: {
      actorScope_operation_resourceKey_idempotencyKey: {
        actorScope,
        operation: input.operation,
        resourceKey: input.resourceKey,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new V5CoreError("IDEMPOTENCY_KEY_REUSE", "同一幂等键不能复用于不同请求体。", 409, false, true);
    }
    if (existing.status === "processing") {
      const staleAfterMs = input.reconcileProcessing?.staleAfterMs ?? 60_000;
      if (input.reconcileProcessing && Date.now() - existing.updatedAt.getTime() >= staleAfterMs) {
        let reconciled: T | null = null;
        try {
          reconciled = await input.reconcileProcessing.run();
        } catch {
          // A failed read-only recovery is not evidence that the write failed;
          // retain the processing receipt and fail closed below.
        }
        if (reconciled !== null) {
          const settled = await prisma.v5OperationReceipt.updateMany({
            where: { id: existing.id, status: "processing", updatedAt: existing.updatedAt },
            data: { status: "succeeded", responseJson: JSON.stringify(reconciled), errorCode: null },
          });
          if (settled.count === 1) return { value: reconciled, replayed: true, receiptId: existing.id };
          const raced = await prisma.v5OperationReceipt.findUnique({ where: { id: existing.id } });
          if (raced?.status === "succeeded" && raced.responseJson) {
            return { value: JSON.parse(raced.responseJson) as T, replayed: true, receiptId: existing.id };
          }
        }
      }
      throw new V5CoreError("OPERATION_IN_PROGRESS", "相同操作正在处理中。", 202, true, false);
    }
    if (existing.status === "succeeded" && existing.responseJson) {
      return { value: JSON.parse(existing.responseJson) as T, replayed: true, receiptId: existing.id };
    }
    if (existing.status === "failed") {
      let isRetryable = false;
      let cachedError: { code?: string; message?: string; status?: number; conflict?: boolean } | null = null;
      if (existing.responseJson) {
        try {
          const parsed = JSON.parse(existing.responseJson);
          isRetryable = Boolean(parsed.retryable);
          cachedError = parsed;
        } catch {
          isRetryable = false;
        }
      }
      if (!isRetryable) {
        // non-retryable failure: 返回原失败/拒绝继续
        throw new V5CoreError(
          existing.errorCode ?? cachedError?.code ?? "OPERATION_FAILED",
          cachedError?.message ?? "上次相同操作已失败且不可重试，请更换幂等键或修正参数后重试。",
          cachedError?.status ?? 409,
          false,
          cachedError?.conflict ?? true,
        );
      }
      // retryable failure: 允许使用同 key 继续执行原 operation
    }
  }

  const receiptId = existing && existing.status === "failed" ? existing.id : randomUUID();
  if (existing && existing.status === "failed") {
    await prisma.v5OperationReceipt.update({
      where: { id: existing.id },
      data: {
        status: "processing",
        errorCode: null,
      },
    });
  } else {
    try {
      await prisma.v5OperationReceipt.create({
        data: {
          id: receiptId,
          actorScope,
          operation: input.operation,
          resourceKey: input.resourceKey,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          status: "processing",
        },
      });
    } catch (error) {
      const raced = await prisma.v5OperationReceipt.findUnique({
        where: {
          actorScope_operation_resourceKey_idempotencyKey: {
            actorScope,
            operation: input.operation,
            resourceKey: input.resourceKey,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (raced?.requestHash === requestHash && raced.status === "succeeded" && raced.responseJson) {
        return { value: JSON.parse(raced.responseJson) as T, replayed: true, receiptId: raced.id };
      }
      if (raced?.requestHash === requestHash && raced.status === "processing") {
        throw new V5CoreError("OPERATION_IN_PROGRESS", "相同操作正在处理中。", 202, true);
      }
      throw error;
    }
  }

  try {
    const value = await input.execute();
    await prisma.v5OperationReceipt.update({
      where: { id: receiptId },
      data: { status: "succeeded", responseJson: JSON.stringify(value) },
    });
    return { value, replayed: false, receiptId };
  } catch (error) {
    const code = error instanceof V5CoreError ? error.code : "OPERATION_FAILED";
    const message = error instanceof Error ? error.message : "操作失败";
    const status = error instanceof V5CoreError ? error.status : 500;
    const retryable = error instanceof V5CoreError ? Boolean(error.retryable) : false;
    const conflict = error instanceof V5CoreError ? Boolean(error.conflict) : false;
    await prisma.v5OperationReceipt.update({
      where: { id: receiptId },
      data: {
        status: "failed",
        errorCode: code,
        responseJson: JSON.stringify({ code, message, status, retryable, conflict }),
      },
    }).catch(() => undefined);
    throw error;
  }
}

export function apiMeta(refreshScopes: string[] = []) {
  const now = new Date().toISOString();
  return {
    schemaVersion: V5_SCHEMA_VERSION,
    requestId: `req_${randomUUID()}`,
    traceId: `trace_${randomUUID()}`,
    serverTime: now,
    ...(refreshScopes.length ? { refreshScopes } : {}),
  };
}

export function okResponse<T>(data: T, status = 200, refreshScopes: string[] = []) {
  return { body: { ok: true as const, data, meta: apiMeta(refreshScopes) }, status };
}

export function errorResponse(error: unknown) {
  let normalized: V5CoreError;
  if (error instanceof V5CoreError) {
    normalized = error;
  } else if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error &&
    "status" in error &&
    typeof (error as Record<string, unknown>).code === "string" &&
    typeof (error as Record<string, unknown>).message === "string" &&
    typeof (error as Record<string, unknown>).status === "number"
  ) {
    const err = error as Record<string, unknown>;
    normalized = new V5CoreError(
      err.code as string,
      err.message as string,
      err.status as number,
      Boolean(err.retryable),
      Boolean(err.conflict),
      err.details as Record<string, unknown> | undefined
    );
  } else {
    normalized = new V5CoreError("INTERNAL_ERROR", "核心服务暂时不可用，请稍后重试。", 500, true);
  }
  return {
    body: {
      ok: false as const,
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        conflict: normalized.conflict,
        ...(normalized.details ? { details: normalized.details } : {}),
      },
      meta: apiMeta(),
    },
    status: normalized.status,
  };
}

export function safeParseBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new V5CoreError("INVALID_INPUT", "请求体必须是 JSON 对象。", 400);
  return value;
}

export function parseBooleanQuery(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new V5CoreError("INVALID_FILTER", "查询参数必须是合法布尔值。", 400);
}
