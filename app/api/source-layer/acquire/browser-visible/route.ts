import { NextRequest, NextResponse } from "next/server";

import { isSameOriginRequest } from "@/lib/server/accessPassword";
import { requireAuthenticated } from "@/lib/server/demoGuard";
import { captureBrowserVisibleV3Envelope, readV3ModuleEvidence } from "@/lib/sourceLayer/browserVisibleModuleCapture";
import { SOURCE_TYPES, type CaptureSourceType } from "@/lib/sourceLayer/capturePackage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (origin) return isSameOriginRequest(origin, request);
  const referer = request.headers.get("referer");
  const fetchSite = request.headers.get("sec-fetch-site");
  try {
    return referer !== null
      && isSameOriginRequest(new URL(referer).origin, request)
      && (fetchSite === null || fetchSite === "same-origin");
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const sourceType = body.sourceType;
  if (!SOURCE_TYPES.includes(sourceType as CaptureSourceType)
    || !["amazon_dom", "sellersprite_plugin", "manual_entry"].includes(String(sourceType))) {
    return errorResponse(422, "source_type_not_allowed", "Browser Visible Evidence 只接受已授权的页面/插件来源。");
  }
  try {
    const result = await captureBrowserVisibleV3Envelope({
      context: auth.context,
      envelope: body.envelope,
      sourceType: sourceType as "amazon_dom" | "sellersprite_plugin" | "manual_entry",
      sourceFingerprint: typeof body.sourceFingerprint === "string" ? body.sourceFingerprint : null,
    });
    return NextResponse.json({
      ok: true,
      data: {
        module: result.moduleEvidence.module,
        subjectKey: result.moduleEvidence.subjectKey,
        status: result.moduleEvidence.status,
        acquisitionMode: result.moduleEvidence.acquisitionMode,
        metricNature: result.moduleEvidence.metricNature,
        attachment: result.attachment,
        rawArtifact: result.rawArtifact.artifact,
        downstream: result.downstream,
      },
    }, { status: result.gateway.created ? 201 : 200 });
  } catch (error) {
    return errorResponse(422, "browser_visible_capture_failed", error instanceof Error ? error.message : "Browser Visible Evidence 未能写入 EvidenceStore。");
  }
}

export async function GET(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  const subjectKey = request.nextUrl.searchParams.get("subjectKey")?.trim() ?? "";
  if (!subjectKey) return errorResponse(400, "subject_key_required", "subjectKey 必填。");
  try {
    const result = await readV3ModuleEvidence({ context: auth.context, subjectKey });
    return NextResponse.json({
      ok: true,
      data: {
        subjectKey: result.subjectKey,
        modules: result.modules,
        attachmentCount: result.evidenceStore?.attachments?.length ?? 0,
        rawArtifactCount: result.evidenceStore?.rawArtifacts?.length ?? 0,
        downstream: { readable: true, evidenceOnly: result.modules.every((item) => item.evidenceOnly) },
      },
    });
  } catch (error) {
    return errorResponse(400, "browser_visible_read_failed", error instanceof Error ? error.message : "Browser Visible Evidence 读取失败。");
  }
}
