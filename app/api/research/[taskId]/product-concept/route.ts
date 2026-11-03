import { NextRequest, NextResponse } from "next/server";
import { generateProductConceptV5, readProductConceptV5, ProductConceptV5Error } from "@/lib/server/productConceptV5Service";
import { authResponse, boundedJsonBody, boundedJsonBodyErrorResponse, originError, readAuth, v5ErrorResponse, writeAuth, writeOriginOk } from "@/lib/server/v5ApiRoute";
import { okResponse } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const { taskId } = await context.params;
    return NextResponse.json(okResponse(await readProductConceptV5({ context: auth.context, taskId })).body);
  } catch (error) {
    return v5ErrorResponse(error);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  try {
    const body = await boundedJsonBody(request, 1024);
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length > 0) {
      return NextResponse.json({ ok: false, error: { code: "INVALID_BODY", message: "生成产品概念不接受额外请求字段。" } }, { status: 400 });
    }
    const { taskId } = await context.params;
    return NextResponse.json(okResponse(await generateProductConceptV5({ context: auth.context, taskId })).body, { status: 201 });
  } catch (error) {
    const bodyError = boundedJsonBodyErrorResponse(error);
    if (bodyError) return bodyError;
    if (error instanceof ProductConceptV5Error) return NextResponse.json({ ok: false, error: { code: error.code, message: error.message } }, { status: error.status });
    return v5ErrorResponse(error);
  }
}
