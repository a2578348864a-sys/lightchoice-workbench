import { NextRequest, NextResponse } from "next/server";

import {
  readScopeConfirmationView,
  saveScopeConfirmations,
} from "@/lib/server/marketScopeConfirmationService";
import {
  authResponse,
  boundedJsonBody,
  boundedJsonBodyErrorResponse,
  originError,
  readAuth,
  writeAuth,
  writeOriginOk,
  v5ErrorResponse,
} from "@/lib/server/v5ApiRoute";
import { okResponse, requireIdempotencyKey, V5CoreError } from "@/lib/server/v5CoreCommon";
import type { ScopeConfirmationInput } from "@/lib/marketScan/scopeConfirmation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 128 * 1024;

/** 只读：人工范围确认视图（逐样本状态 + 有效/未确认/过期统计）。 */
export async function GET(request: NextRequest, context: { params: Promise<{ scanId: string }> }) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const { scanId } = await context.params;
    const view = await readScopeConfirmationView(scanId);
    return NextResponse.json(okResponse({
      scanId,
      scanHash: view.scanHash,
      nicheHash: view.nicheHash,
      summary: view.summary,
      items: view.rows,
    }, 200, [`market-analysis:${scanId}`]).body);
  } catch (error) {
    return v5ErrorResponse(error);
  }
}

function parseItems(value: unknown): ScopeConfirmationInput[] {
  if (!Array.isArray(value)) throw new V5CoreError("INVALID_INPUT", "items 必须是数组。", 400);
  return value.map((raw) => {
    const item = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    return {
      marketSampleKey: typeof item.marketSampleKey === "string" ? item.marketSampleKey : "",
      asin: typeof item.asin === "string" ? item.asin : "",
      subjectKey: typeof item.subjectKey === "string" ? item.subjectKey : "",
      status: item.status as ScopeConfirmationInput["status"],
      reason: typeof item.reason === "string" ? item.reason : "",
      expectedVersion: typeof item.expectedVersion === "string" ? item.expectedVersion : "",
      expectedScopeRevision: typeof item.expectedScopeRevision === "number" ? item.expectedScopeRevision : -1,
    };
  });
}

export async function POST(request: NextRequest, context: { params: Promise<{ scanId: string }> }) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  try {
    const { scanId } = await context.params;
    const body = await boundedJsonBody(request, MAX_BODY_BYTES);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new V5CoreError("INVALID_INPUT", "请求体必须是 JSON 对象。", 400);
    }
    const payload = body as Record<string, unknown>;
    const allowed = new Set(["expectedScanHash", "items", "idempotencyKey"]);
    if (Object.keys(payload).some((key) => !allowed.has(key))) {
      throw new V5CoreError("INVALID_INPUT", "请求包含未允许的字段。", 400);
    }
    if (typeof payload.expectedScanHash !== "string" || !payload.expectedScanHash.trim()) {
      throw new V5CoreError("EXPECTED_SCAN_HASH_REQUIRED", "必须携带 expectedScanHash。", 400);
    }
    const key = request.headers.get("Idempotency-Key")
      ?? (typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : "");

    const data = await saveScopeConfirmations({
      context: auth.context,
      scanId,
      expectedScanHash: payload.expectedScanHash.trim(),
      items: parseItems(payload.items),
      idempotencyKey: requireIdempotencyKey(key),
    });
    return NextResponse.json(okResponse(data, 200, [`market-analysis:${scanId}`, "market-analysis-list"]).body);
  } catch (error) {
    const bodyError = boundedJsonBodyErrorResponse(error);
    if (bodyError) return bodyError;
    return v5ErrorResponse(error);
  }
}
