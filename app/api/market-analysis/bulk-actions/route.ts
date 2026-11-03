import { NextRequest, NextResponse } from "next/server";
import { marketBulkAction } from "@/lib/server/v5MarketService";
import { authResponse, jsonBody, originError, writeAuth, writeOriginOk, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { okResponse, requireIdempotencyKey, safeParseBody, V5CoreError } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  try {
    const body = safeParseBody(await jsonBody(request));
    const items = Array.isArray(body.items) ? body.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))).map((item) => ({ id: typeof item.id === "string" ? item.id : "", expectedVersion: item.expectedVersion })) : [];
    const resource = body.resource === "market_sample" || body.resource === "market_scan" ? body.resource : null;
    const action = body.action === "archive" || body.action === "restore" || body.action === "delete" ? body.action : null;
    if (!resource || !action) return v5ErrorResponse(new V5CoreError("BULK_ACTION_INVALID", "市场批量操作参数无效。", 400));
    const key = request.headers.get("Idempotency-Key") ?? (typeof body.idempotencyKey === "string" ? body.idempotencyKey : "");
    const data = await marketBulkAction({ context: auth.context, resource, action, items, expectedScanHash: typeof body.expectedScanHash === "string" ? body.expectedScanHash : undefined, idempotencyKey: requireIdempotencyKey(key) });
    return NextResponse.json(okResponse(data, 200, ["market-analysis-list", "home-summary"]).body);
  } catch (error) { return v5ErrorResponse(error); }
}
