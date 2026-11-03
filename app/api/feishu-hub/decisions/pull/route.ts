import { NextRequest, NextResponse } from "next/server";

import { pullV5HubHumanDecisions } from "@/lib/server/v5HubDecisionPullService";
import { authResponse, boundedJsonBody, boundedJsonBodyErrorResponse, originError, writeAuth, writeOriginOk, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { okResponse, requireIdempotencyKey, safeParseBody } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  try {
    const body = safeParseBody(await boundedJsonBody(request, 1024));
    const key = request.headers.get("Idempotency-Key")
      ?? (typeof body.idempotencyKey === "string" ? body.idempotencyKey : "");
    const data = await pullV5HubHumanDecisions({
      context: auth.context,
      idempotencyKey: requireIdempotencyKey(key),
    });
    return NextResponse.json(okResponse(data, 200, ["feishu-hub:human-decisions"]).body);
  } catch (error) {
    const bodyError = boundedJsonBodyErrorResponse(error);
    if (bodyError) return bodyError;
    return v5ErrorResponse(error);
  }
}
