import { NextRequest, NextResponse } from "next/server";
import { sourceBulkAction } from "@/lib/server/v5SourceLifecycleService";
import { authResponse, jsonBody, originError, writeAuth, writeOriginOk, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { requireIdempotencyKey, safeParseBody, okResponse, V5CoreError } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  try {
    const body = safeParseBody(await jsonBody(request));
    const items = Array.isArray(body.items) ? body.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))).map((item) => ({ id: typeof item.id === "string" ? item.id : "", expectedVersion: item.expectedVersion })) : [];
    if (body.resource !== "source_batch" || !["archive", "restore", "delete"].includes(String(body.action))) throw new V5CoreError("BULK_ACTION_INVALID", "批次批量动作无效。", 400);
    const key = request.headers.get("Idempotency-Key") ?? (typeof body.idempotencyKey === "string" ? body.idempotencyKey : "");
    const data = await sourceBulkAction({ context: auth.context, resource: "source_batch", action: body.action as "archive" | "restore" | "delete", items, idempotencyKey: requireIdempotencyKey(key) });
    return NextResponse.json(okResponse(data, 200, ["source-batches", "home-summary"]).body);
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
