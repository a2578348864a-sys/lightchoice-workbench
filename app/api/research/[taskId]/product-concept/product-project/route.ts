import { NextRequest, NextResponse } from "next/server";
import { syncProductConceptV5, ProductConceptV5Error } from "@/lib/server/productConceptV5Service";
import { authResponse, boundedJsonBody, boundedJsonBodyErrorResponse, originError, v5ErrorResponse, writeAuth, writeOriginOk } from "@/lib/server/v5ApiRoute";
import { okResponse } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  try {
    const body = await boundedJsonBody(request, 1024);
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length > 0) {
      return NextResponse.json({ ok: false, error: { code: "INVALID_BODY", message: "同步 Product Project 不接受额外请求字段。" } }, { status: 400 });
    }
    const { taskId } = await context.params;
    return NextResponse.json(okResponse(await syncProductConceptV5({ context: auth.context, taskId })).body);
  } catch (error) {
    const bodyError = boundedJsonBodyErrorResponse(error);
    if (bodyError) return bodyError;
    if (error instanceof ProductConceptV5Error) return NextResponse.json({ ok: false, error: { code: error.code, message: error.message } }, { status: error.status });
    return v5ErrorResponse(error);
  }
}
