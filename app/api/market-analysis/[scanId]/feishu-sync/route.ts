import { NextRequest, NextResponse } from "next/server";
import { syncMarketScan } from "@/lib/server/v5FeishuService";
import { authResponse, jsonBody, originError, writeAuth, writeOriginOk, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { okResponse, requireIdempotencyKey, safeParseBody } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ scanId: string }> }) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  try {
    const { scanId } = await context.params;
    const body = safeParseBody(await jsonBody(request));
    const key = request.headers.get("Idempotency-Key") ?? (typeof body.idempotencyKey === "string" ? body.idempotencyKey : "");
    const data = await syncMarketScan({ context: auth.context, scanId, expectedScanHash: typeof body.expectedScanHash === "string" ? body.expectedScanHash : "", sampleKeys: Array.isArray(body.sampleKeys) ? body.sampleKeys.filter((item): item is string => typeof item === "string") : undefined, idempotencyKey: requireIdempotencyKey(key) });
    return NextResponse.json(okResponse(data, 200, [`market-analysis:${scanId}`]).body);
  } catch (error) { return v5ErrorResponse(error); }
}
