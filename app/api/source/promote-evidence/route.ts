import { NextRequest, NextResponse } from "next/server";

import { readAuth, authResponse, jsonBody, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { promoteEvidence } from "@/lib/sourceLayer/server/promotableEvidenceService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
export async function POST(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const body = await jsonBody(request);
    if (!isRecord(body)
      || !Array.isArray(body.bindings)
      || body.bindings.length === 0
      || body.bindings.length > 100
      || body.confirmed !== true) {
      return NextResponse.json({ ok: false, error: { code: "PROMOTION_CONFIRM_REQUIRED", message: "请先确认要提档的商品。" } }, { status: 400 });
    }
    const idempotencyKey = request.headers.get("idempotency-key") ?? body.idempotencyKey;
    const result = await promoteEvidence({
      context: auth.context,
      bindings: body.bindings,
      targetBatchId: typeof body.targetBatchId === "string" ? body.targetBatchId : null,
      confirmed: true,
      idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : "",
    });
    return NextResponse.json({ ok: true, data: result.value, receiptId: result.receiptId, replayed: result.replayed });
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
