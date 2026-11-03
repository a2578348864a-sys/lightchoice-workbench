import { NextRequest, NextResponse } from "next/server";

import "@/lib/sourceLayer/adapters";
import { SOURCE_TYPES, type CaptureSourceType } from "@/lib/sourceLayer/capturePackage";
import { getSourceAdapter } from "@/lib/sourceLayer/sourceAdapter";
import { requireAuthenticated } from "@/lib/server/demoGuard";
import {
  SourceLayerServiceError,
} from "@/lib/sourceLayer/server/sourceLayerService";
import {
  captureThroughGateway,
  type CaptureGatewaySource,
} from "@/lib/sourceLayer/server/captureGateway";
import { recordCaptureApiDiagnostic } from "@/lib/sourceLayer/server/diagnosticService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SOURCE_URL_LENGTH = 2048;

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

function gatewaySourceFor(sourceType: CaptureSourceType): CaptureGatewaySource | null {
  if (sourceType === "manual_entry") return "manual";
  if (sourceType === "amazon_dom"
    || sourceType === "sellersprite_plugin"
    || sourceType === "sellersprite_xlsx") {
    return sourceType;
  }
  return null;
}

export async function POST(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  if (!sameOrigin(request)) {
    return errorResponse(403, "origin_not_allowed", "请求来源不受信任。");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "请求体不是合法 JSON。");
  }
  if (!isRecord(body)) {
    return errorResponse(400, "invalid_body", "请求体必须是 JSON object。");
  }
  const sourceTypeValue = typeof body.sourceType === "string" ? body.sourceType : "";
  if (!SOURCE_TYPES.includes(sourceTypeValue as CaptureSourceType)) {
    return errorResponse(400, "source_type_invalid", "来源类型不受支持。");
  }
  const sourceType = sourceTypeValue as CaptureSourceType;
  if (!getSourceAdapter(sourceType)) {
    return errorResponse(422, "adapter_not_found", "该来源类型尚未接入 Adapter，无法采集。");
  }
  if (body.payload === undefined || body.payload === null) {
    return errorResponse(400, "payload_missing", "请提供来源数据。");
  }
  const sourceUrl = optionalText(body.sourceUrl, MAX_SOURCE_URL_LENGTH);
  const sourceFingerprint = optionalText(body.sourceFingerprint, 128);

  try {
    const gatewaySource = gatewaySourceFor(sourceType);
    if (!gatewaySource) {
      return errorResponse(422, "source_type_not_supported_by_gateway", "该来源尚未接入统一采集网关。" );
    }
    const gatewayResult = await captureThroughGateway({
      context: auth.context,
      source: gatewaySource,
      payload: body.payload,
      sourceUrl,
      sourceFingerprint,
    });
    const firstItem = gatewayResult.capture.items[0] ?? null;
    await recordCaptureApiDiagnostic({
      context: auth.context,
      traceId: gatewayResult.traceId,
      sourceType: gatewayResult.source,
      subjectKey: firstItem?.subjectKey ?? null,
      captureId: firstItem?.captureId ?? null,
      evidenceRefs: gatewayResult.capture.items.map((item) => `${item.subjectKey}:v${item.version}`),
      contentHash: firstItem?.contentHash ?? null,
      status: "succeeded",
      reason: "Source Layer ingest API completed after Capture Gateway persistence.",
    }).catch(() => undefined);
    return NextResponse.json({
      ok: true,
      data: {
        ...gatewayResult.capture,
        gatewaySource: gatewayResult.source,
        traceId: gatewayResult.traceId,
        productFactCount: gatewayResult.productFacts.length,
        qualityGate: gatewayResult.qualityGate,
      },
    }, { status: 201 });
  } catch (error) {
    if (error instanceof SourceLayerServiceError) {
      const status = error.code === "adapter_not_found" ? 422
        : error.code === "no_capturable_records" ? 422
          : 400;
      return errorResponse(status, error.code, error.message);
    }
    const code = error instanceof Error && "code" in error
      ? String((error as { code: unknown }).code)
      : "source_layer_ingest_failed";
    return errorResponse(500, code, "来源采集失败，请稍后重试。");
  }
}
