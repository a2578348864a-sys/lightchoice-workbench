import { NextRequest, NextResponse } from "next/server";
import { readAuth, authResponse, jsonBody, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { orchestrateCaptureCapabilityModules } from "@/lib/server/captureCapabilityOrchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const body = await jsonBody(request);
    const source = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const idempotencyKey = typeof source.idempotencyKey === "string" && source.idempotencyKey.trim()
      ? source.idempotencyKey
      : request.headers.get("idempotency-key") ?? "";
    const result = await orchestrateCaptureCapabilityModules({
      context: auth.context,
      batchId: source.batchId,
      modules: source.modules,
      targetAsin: source.targetAsin,
      limit: source.limit,
      idempotencyKey,
    });
    return NextResponse.json({
      ok: true,
      receiptId: result.receiptId,
      replayed: result.replayed,
      ...result.value,
    });
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
