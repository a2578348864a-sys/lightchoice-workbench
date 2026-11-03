import { NextRequest, NextResponse } from "next/server";
import { readAuth, authResponse, jsonBody, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { startResearchFromQuickAsin } from "@/lib/server/quickAsinService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const body = await jsonBody(request);
    const result = await startResearchFromQuickAsin({
      context: auth.context,
      asin: body && typeof body === "object" && !Array.isArray(body) ? (body as { asin?: unknown }).asin : null,
      idempotencyKey: request.headers.get("idempotency-key") ?? "",
    });
    return NextResponse.json({ ok: true, data: result.value, receiptId: result.receiptId, replayed: result.replayed });
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
