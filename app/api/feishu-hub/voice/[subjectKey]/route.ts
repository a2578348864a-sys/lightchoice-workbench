import { NextRequest, NextResponse } from "next/server";

import { projectCustomerVoiceEvidenceToV5Hub } from "@/lib/server/v5HubSourceProjectionService";
import { authResponse, boundedJsonBody, boundedJsonBodyErrorResponse, originError, writeAuth, writeOriginOk, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { okResponse, requireIdempotencyKey, safeParseBody } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";

export async function POST(request: NextRequest, route: { params: Promise<{ subjectKey: string }> }) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  try {
    const { subjectKey } = await route.params;
    const body = safeParseBody(await boundedJsonBody(request, 1024));
    const key = request.headers.get("Idempotency-Key") ?? (typeof body.idempotencyKey === "string" ? body.idempotencyKey : "");
    const data = await projectCustomerVoiceEvidenceToV5Hub({
      context: auth.context,
      subjectKey,
      idempotencyKey: requireIdempotencyKey(key),
    });
    return NextResponse.json(okResponse(data, 200, [`feishu-hub:voice:${subjectKey}`]).body);
  } catch (error) {
    const bodyError = boundedJsonBodyErrorResponse(error);
    if (bodyError) return bodyError;
    return v5ErrorResponse(error);
  }
}
