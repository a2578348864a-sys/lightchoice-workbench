import { NextRequest, NextResponse } from "next/server";

import { requireAuthenticated } from "@/lib/server/demoGuard";
import { captureSellerSpriteKeywordEvidence } from "@/lib/server/sellerSpriteKeywordCapture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sameOrigin(request: NextRequest): boolean {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin) return origin === url.origin;
  const referer = request.headers.get("referer");
  try {
    return referer !== null && new URL(referer).origin === url.origin;
  } catch {
    return false;
  }
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTable(value: unknown): ReadonlyArray<ReadonlyArray<string | null>> | null {
  if (!Array.isArray(value) || value.length > 500) return null;
  const rows: Array<Array<string | null>> = [];
  for (const raw of value) {
    if (!Array.isArray(raw) || raw.length > 100) return null;
    rows.push(raw.map((cell) => cell === null || typeof cell === "string" ? cell : null));
  }
  return rows;
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
  const asin = typeof body.asin === "string" ? body.asin.trim().toUpperCase() : "";
  const headers = Array.isArray(body.headers) && body.headers.length <= 100
    ? body.headers.map((value) => value === null || typeof value === "string" ? value : null)
    : null;
  const rows = parseTable(body.rows);
  const sourceRef = typeof body.sourceRef === "string" ? body.sourceRef.trim().slice(0, 300) : "";
  const sourceMethod = body.sourceMethod === "sellersprite_page_manual_tsv"
    || body.sourceMethod === "sellersprite_official_xlsx"
    ? body.sourceMethod
    : undefined;
  const unavailableReason = body.unavailableReason === "plugin_not_loaded"
    || body.unavailableReason === "permission_denied"
    || body.unavailableReason === "quota_exhausted"
    || body.unavailableReason === "no_source"
    ? body.unavailableReason
    : undefined;
  if (!/^[A-Z0-9]{10}$/.test(asin) || !sourceRef || (body.rows !== undefined && rows === null)) {
    return errorResponse(400, "invalid_capture_input", "ASIN、来源引用或报表表格格式无效。");
  }

  try {
    const result = await captureSellerSpriteKeywordEvidence({
      context: auth.context,
      asin,
      headers,
      rows,
      sourceRef,
      sourceMethod,
      unavailableReason,
    });
    if (!result.ok) {
      return errorResponse(result.plan.status === "human_required" ? 409 : 422, result.plan.errorCode, result.plan.reason);
    }
    return NextResponse.json({
      ok: true,
      data: {
        reportType: result.reportType,
        evidence: result.evidence,
        sourceEvidenceRef: result.gateway.sourceEvidenceRef,
        created: result.gateway.created,
        duplicate: result.gateway.duplicate,
      },
    }, { status: result.gateway.created ? 201 : 200 });
  } catch (error) {
    console.error("[source-layer/sellersprite-report]", { code: "source_attachment_failed" });
    return errorResponse(
      409,
      "source_attachment_failed",
      error instanceof Error ? error.message : "SellerSprite 关键词证据未能进入 Source Layer。",
    );
  }
}
