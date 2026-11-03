import { NextRequest, NextResponse } from "next/server";

import "@/lib/sourceLayer/adapters";
import { SOURCE_TYPES, type CaptureSourceType } from "@/lib/sourceLayer/capturePackage";
import { requireAuthenticated } from "@/lib/server/demoGuard";
import {
  retrySourceCapture,
  SourceLayerServiceError,
} from "@/lib/sourceLayer/server/sourceLayerService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUBJECT_KEY_PATTERN = /^[A-Za-z0-9:._\-|@]{1,160}$/;

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function sameOrigin(request: NextRequest): boolean {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  let expected = url.origin;
  if (host !== null) {
    try {
      expected = new URL(`${url.protocol}//${host}`).origin;
    } catch {
      return false;
    }
  }
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === expected;
  const referer = request.headers.get("referer");
  const fetchSite = request.headers.get("sec-fetch-site");
  try {
    return referer !== null
      && new URL(referer).origin === expected
      && (fetchSite === null || fetchSite === "same-origin");
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

export async function POST(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  if (!sameOrigin(request)) return errorResponse(403, "origin_not_allowed", "请求来源不受信任。");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "请求体不是合法 JSON。");
  }
  if (!isRecord(body)) return errorResponse(400, "invalid_body", "请求体必须是 JSON object。");

  const subjectKey = optionalText(body.subjectKey, 160);
  const sourceType = typeof body.sourceType === "string" ? body.sourceType : "";
  if (!subjectKey || !SUBJECT_KEY_PATTERN.test(subjectKey)) {
    return errorResponse(400, "subject_key_invalid", "商品主体标识不合法。");
  }
  if (!SOURCE_TYPES.includes(sourceType as CaptureSourceType)) {
    return errorResponse(400, "source_type_invalid", "来源类型不受支持。");
  }
  if (body.payload === undefined || body.payload === null) {
    return errorResponse(400, "payload_missing", "请提供重新采集所需的来源数据。");
  }

  try {
    const result = await retrySourceCapture({
      context: auth.context,
      subjectKey,
      sourceType: sourceType as CaptureSourceType,
      payload: body.payload,
      sourceUrl: optionalText(body.sourceUrl, 2048),
      sourceFingerprint: optionalText(body.sourceFingerprint, 128),
      marketplace: optionalText(body.marketplace, 20),
    });
    return NextResponse.json({ ok: true, data: result }, { status: 201 });
  } catch (error) {
    if (error instanceof SourceLayerServiceError) {
      const status = error.code === "source_retry_not_allowed" ? 409
        : error.code === "adapter_not_found" ? 422
          : 400;
      return errorResponse(status, error.code, error.message);
    }
    return errorResponse(500, "source_layer_retry_failed", "来源恢复失败，请稍后重试。");
  }
}
