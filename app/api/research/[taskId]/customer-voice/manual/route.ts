import { NextRequest, NextResponse } from "next/server";
import { addManualCustomerVoice, CustomerVoiceServiceError } from "@/lib/server/customerVoiceService";
import { authResponse, boundedJsonBody, boundedJsonBodyErrorResponse, originError, v5ErrorResponse, writeAuth, writeOriginOk } from "@/lib/server/v5ApiRoute";
import { okResponse } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  try {
    const body = await boundedJsonBody(request, 512 * 1024);
    if (typeof body !== "object" || body === null || Array.isArray(body)
      || Object.keys(body).some((key) => key !== "observations")
      || !Array.isArray((body as Record<string, unknown>).observations)) {
      return NextResponse.json({ ok: false, error: { code: "CUSTOMER_VOICE_MANUAL_INPUT_INVALID", message: "请提供 observations 数组。" } }, { status: 400 });
    }
    const rows = (body as { observations: unknown[] }).observations;
    if (rows.some((item) => typeof item !== "object" || item === null || Array.isArray(item))) {
      return NextResponse.json({ ok: false, error: { code: "CUSTOMER_VOICE_MANUAL_INPUT_INVALID", message: "每条 VOC 必须是对象。" } }, { status: 400 });
    }
    const observations = rows.map((item) => item as Record<string, unknown>);
    const allowed = new Set(["externalContentId", "contentType", "title", "text", "rating", "verifiedPurchase", "publishedAt"]);
    if (observations.some((item) => Object.keys(item).some((key) => !allowed.has(key))
      || typeof item.text !== "string"
      || item.text.length > 2_000
      || item.externalContentId !== undefined && item.externalContentId !== null && (typeof item.externalContentId !== "string" || item.externalContentId.length > 160)
      || item.contentType !== undefined && !["review", "post", "comment", "social_post"].includes(String(item.contentType))
      || item.title !== undefined && item.title !== null && (typeof item.title !== "string" || item.title.length > 200)
      || item.rating !== undefined && item.rating !== null && (typeof item.rating !== "number" || item.rating < 1 || item.rating > 5)
      || item.verifiedPurchase !== undefined && item.verifiedPurchase !== null && typeof item.verifiedPurchase !== "boolean"
      || item.publishedAt !== undefined && item.publishedAt !== null && (typeof item.publishedAt !== "string" || item.publishedAt.length > 80 || Number.isNaN(Date.parse(item.publishedAt)))) ) {
      return NextResponse.json({ ok: false, error: { code: "CUSTOMER_VOICE_MANUAL_INPUT_INVALID", message: "VOC 字段不合法或文本超过 2000 字。" } }, { status: 400 });
    }
    const { taskId } = await context.params;
    const result = await addManualCustomerVoice({
      context: auth.context,
      taskId,
      observations: observations as unknown as Parameters<typeof addManualCustomerVoice>[0]["observations"],
    });
    return NextResponse.json(okResponse(result).body, { status: 201 });
  } catch (error) {
    const bodyError = boundedJsonBodyErrorResponse(error);
    if (bodyError) return bodyError;
    if (error instanceof CustomerVoiceServiceError) {
      return NextResponse.json({ ok: false, error: { code: error.code, message: error.message, retryable: false, conflict: error.status === 409 } }, { status: error.status });
    }
    return v5ErrorResponse(error);
  }
}
