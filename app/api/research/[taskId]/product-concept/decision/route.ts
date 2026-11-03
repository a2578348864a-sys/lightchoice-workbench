import { NextRequest, NextResponse } from "next/server";
import { decideProductConceptV5, ProductConceptV5Error } from "@/lib/server/productConceptV5Service";
import { authResponse, boundedJsonBody, boundedJsonBodyErrorResponse, originError, v5ErrorResponse, writeAuth, writeOriginOk } from "@/lib/server/v5ApiRoute";
import { okResponse } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return NextResponse.json({ ok: false, error: { code: "ORIGIN_NOT_ALLOWED", message: "请求来源不受信任。" } }, { status: 403 });
  try {
    const body = await boundedJsonBody(request, 4 * 1024);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ ok: false, error: { code: "INVALID_BODY", message: "请求体格式无效。" } }, { status: 400 });
    }
    const value = body as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["status", "reason", "expectedRevision", "expectedPacketHash", "expectedTeamRecommendationId", "expectedVersion", "applyTeamRecommendation", "confirmed"].includes(key))
      || !["APPROVE", "VALIDATE_MORE", "PAUSE", "DROP"].includes(String(value.status))
      || typeof value.reason !== "string" || !Number.isSafeInteger(value.expectedRevision)) {
      return NextResponse.json({ ok: false, error: { code: "INVALID_BODY", message: "人工决策字段无效。" } }, { status: 400 });
    }
    const { taskId } = await context.params;
    return NextResponse.json(okResponse(await decideProductConceptV5({
      context: auth.context,
      taskId,
      status: value.status as "APPROVE" | "VALIDATE_MORE" | "PAUSE" | "DROP",
      reason: value.reason,
      expectedRevision: value.expectedRevision as number,
      expectedPacketHash: typeof value.expectedPacketHash === "string" ? value.expectedPacketHash : undefined,
      expectedTeamRecommendationId: typeof value.expectedTeamRecommendationId === "string" ? value.expectedTeamRecommendationId : undefined,
      expectedVersion: typeof value.expectedVersion === "string" ? value.expectedVersion : undefined,
      applyTeamRecommendation: value.applyTeamRecommendation === true,
      confirmed: value.confirmed === true,
    })).body);
  } catch (error) {
    const bodyError = boundedJsonBodyErrorResponse(error);
    if (bodyError) return bodyError;
    if (error instanceof ProductConceptV5Error) return NextResponse.json({ ok: false, error: { code: error.code, message: error.message } }, { status: error.status });
    return v5ErrorResponse(error);
  }
}
