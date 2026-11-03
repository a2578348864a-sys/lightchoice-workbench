import { NextRequest, NextResponse } from "next/server";
import { collectPublicRedditVoice, CustomerVoiceServiceError } from "@/lib/server/customerVoiceService";
import { authResponse, boundedJsonBody, boundedJsonBodyErrorResponse, originError, v5ErrorResponse, writeAuth, writeOriginOk } from "@/lib/server/v5ApiRoute";
import { okResponse } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  try {
    const { taskId } = await context.params;
    const body = await boundedJsonBody(request, 4 * 1024);
    if (typeof body !== "object" || body === null || Array.isArray(body)
      || typeof (body as Record<string, unknown>).query !== "string") {
      return NextResponse.json({ ok: false, error: { code: "REDDIT_QUERY_INVALID", message: "请提供 2 到 120 个字符的搜索词。" } }, { status: 400 });
    }
    const result = await collectPublicRedditVoice({
      context: auth.context,
      taskId,
      query: (body as { query: string }).query,
    });
    return NextResponse.json(okResponse(result).body);
  } catch (error) {
    const bodyError = boundedJsonBodyErrorResponse(error);
    if (bodyError) return bodyError;
    if (error instanceof CustomerVoiceServiceError) {
      return NextResponse.json({ ok: false, error: { code: error.code, message: error.message, retryable: false, conflict: error.status === 409 } }, { status: error.status });
    }
    return v5ErrorResponse(error);
  }
}
