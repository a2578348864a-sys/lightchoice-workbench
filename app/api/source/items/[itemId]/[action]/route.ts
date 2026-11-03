import { NextRequest, NextResponse } from "next/server";
import { sourceItemAction } from "@/lib/server/v5SourceLifecycleService";
import { authResponse, jsonBody, originError, writeAuth, writeOriginOk, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { requireIdempotencyKey, safeParseBody, okResponse, V5CoreError } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ itemId: string; action: string }> }) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  try {
    const { itemId, action } = await context.params;
    if (action !== "archive" && action !== "restore" && action !== "delete") throw new V5CoreError("INVALID_INPUT", "来源条目动作无效。", 400);
    const body = safeParseBody(await jsonBody(request));
    const key = request.headers.get("Idempotency-Key") ?? (typeof body.idempotencyKey === "string" ? body.idempotencyKey : "");
    const data = await sourceItemAction({ context: auth.context, itemId, action, expectedVersion: body.expectedVersion, idempotencyKey: requireIdempotencyKey(key), reason: typeof body.reason === "string" ? body.reason : undefined });
    return NextResponse.json(okResponse(data, 200, ["source-batches", `source-item:${itemId}`, "home-summary"]).body);
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
