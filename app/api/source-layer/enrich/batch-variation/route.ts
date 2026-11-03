import { NextRequest, NextResponse } from "next/server";
import { readAuth, authResponse, jsonBody, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { enrichBatchWithVariation } from "@/lib/server/batchVariationEnrichmentService";

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
    const result = await enrichBatchWithVariation({
      context: auth.context,
      batchId: source.batchId ?? null,
      limit: source.limit ?? null,
      targetAsin: source.targetAsin,
      forceRecapture: source.forceRecapture === true,
      idempotencyKey,
    });
    return NextResponse.json({
      ok: true,
      receiptId: result.receiptId,
      replayed: result.replayed,
      summary: result.value.summary,
      items: result.value.items,
    });
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
