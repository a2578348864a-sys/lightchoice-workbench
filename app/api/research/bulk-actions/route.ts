import { NextRequest, NextResponse } from "next/server";
import { researchBulkAction } from "@/lib/server/v5ResearchService";
import { authResponse, jsonBody, originError, writeAuth, writeOriginOk, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { okResponse, requireIdempotencyKey, safeParseBody } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  try {
    const body = safeParseBody(await jsonBody(request));
    const items = Array.isArray(body.items) ? body.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))).map((item) => ({ id: typeof item.id === "string" ? item.id : "", expectedVersion: item.expectedVersion })) : [];
    const key = request.headers.get("Idempotency-Key") ?? (typeof body.idempotencyKey === "string" ? body.idempotencyKey : "");
    const data = await researchBulkAction({ context: auth.context, resource: body.resource === "candidate" ? "candidate" : "research_task", action: body.action as "archive" | "restore" | "delete", items, idempotencyKey: requireIdempotencyKey(key) });
    return NextResponse.json(okResponse(data, 200, ["research-list", "home-summary"]).body);
  } catch (error) { return v5ErrorResponse(error); }
}
