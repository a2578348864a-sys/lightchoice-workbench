import { NextRequest, NextResponse } from "next/server";
import {
  CustomerVoiceServiceError,
  importCustomerVoiceFile,
  listCustomerVoiceForResearchTask,
} from "@/lib/server/customerVoiceService";
import { authResponse, boundedFormData, boundedJsonBodyErrorResponse, originError, readAuth, v5ErrorResponse, writeAuth, writeOriginOk } from "@/lib/server/v5ApiRoute";
import { okResponse } from "@/lib/server/v5CoreCommon";
import { ResearchV1InputError } from "@/lib/server/research/researchInput";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const { taskId } = await context.params;
    return NextResponse.json(okResponse(await listCustomerVoiceForResearchTask({ context: auth.context, taskId })).body);
  } catch (error) {
    if (error instanceof ResearchV1InputError) {
      return NextResponse.json({ ok: false, error: { code: error.code.toUpperCase(), message: "当前研究的商品事实或来源绑定不可验证，请显式补齐来源后重试。", retryable: false, conflict: error.status === 409 } }, { status: error.status });
    }
    if (error instanceof CustomerVoiceServiceError) {
      return NextResponse.json({ ok: false, error: { code: error.code, message: error.message, retryable: false, conflict: error.status === 409 } }, { status: error.status });
    }
    return v5ErrorResponse(error);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  try {
    const { taskId } = await context.params;
    const form = await boundedFormData(request, 6 * 1024 * 1024);
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: { code: "CUSTOMER_VOICE_FILE_REQUIRED", message: "请选择 CSV、XLSX 或 JSON 文件。" } }, { status: 400 });
    }
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ ok: false, error: { code: "CUSTOMER_VOICE_FILE_SIZE_INVALID", message: "文件不得超过 5 MiB。" } }, { status: 413 });
    }
    const result = await importCustomerVoiceFile({
      context: auth.context,
      taskId,
      fileName: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return NextResponse.json(okResponse(result).body, { status: 201 });
  } catch (error) {
    const bodyError = boundedJsonBodyErrorResponse(error);
    if (bodyError) return bodyError;
    return v5ErrorResponse(error);
  }
}
