import { NextRequest, NextResponse } from "next/server";

import { requireAuthenticated } from "@/lib/server/demoGuard";
import { isSameOriginRequest } from "@/lib/server/accessPassword";
import { collectAmazonDetailWithPlaywright } from "@/lib/server/captureRecipeBrowser";
import { newTraceId } from "@/lib/sourceLayer/diagnostics";
import { recordCaptureApiDiagnostic } from "@/lib/sourceLayer/server/diagnosticService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
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
  const asin = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as { asin?: unknown }).asin
    : null;
  if (typeof asin !== "string" || !/^[A-Za-z0-9]{10}$/.test(asin.trim())) {
    return errorResponse(400, "asin_invalid", "ASIN 必须是 10 位字母数字。");
  }

  const traceId = newTraceId();
  try {
    const result = await collectAmazonDetailWithPlaywright({
      context: auth.context,
      asin,
      traceId,
    });
    if (result.capture) {
      const firstItem = result.capture.capture.items[0] ?? null;
      await recordCaptureApiDiagnostic({
        context: auth.context,
        traceId: result.trace?.traceId ?? result.capture.traceId,
        sourceType: result.capture.source,
        subjectKey: firstItem?.subjectKey ?? null,
        captureId: firstItem?.captureId ?? null,
        evidenceRefs: result.capture.capture.items.map((item) => `${item.subjectKey}:v${item.version}`),
        contentHash: firstItem?.contentHash ?? null,
        status: result.status === "captured" ? "succeeded" : "failed",
        reason: result.status === "captured"
          ? "Amazon detail API completed after Capture Gateway persistence."
          : "Amazon detail API returned a browser-gated capture result.",
        errorCode: result.errorCode ?? null,
      }).catch(() => undefined);
      return NextResponse.json({
        ok: true,
        data: {
          status: result.status,
          partial: result.partial ?? false,
          postWriteFailures: result.postWriteFailures ?? [],
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
          traceId: result.trace?.traceId ?? result.capture?.traceId ?? null,
          trace: result.trace,
          extraction: result.extraction,
          ...(result.pageFieldPresenceAudit ? { pageFieldPresenceAudit: result.pageFieldPresenceAudit } : {}),
          capture: result.capture.capture,
          productFactCount: result.capture.productFacts.length,
          qualityGate: result.capture.qualityGate,
          consoleErrors: result.consoleErrors,
          consoleErrorDiagnostics: result.consoleErrorDiagnostics ?? null,
          pageErrors: result.pageErrors,
          browser: result.browser,
        },
      }, { status: result.status === "captured" ? 201 : 200 });
    }
    await recordCaptureApiDiagnostic({
      context: auth.context,
      traceId: result.trace?.traceId ?? traceId,
      sourceType: "amazon_dom",
      subjectKey: `amazon:US:${asin.trim().toUpperCase()}`,
      captureId: null,
      evidenceRefs: [],
      contentHash: null,
      status: "failed",
      reason: "Amazon detail browser completed without a capture result.",
      errorCode: result.errorCode ?? null,
    }).catch(() => undefined);
    return NextResponse.json({
      ok: false,
      error: {
        status: result.status,
        code: result.errorCode ?? "amazon_detail_collect_failed",
        message: result.errorMessage ?? "Amazon 详情采集未完成。",
        traceId: result.trace?.traceId ?? traceId,
        ...(result.pageFieldPresenceAudit ? { pageFieldPresenceAudit: result.pageFieldPresenceAudit } : {}),
        consoleErrorDiagnostics: result.consoleErrorDiagnostics ?? null,
        consoleErrors: result.consoleErrors,
        pageErrors: result.pageErrors,
        browser: result.browser,
        sessionDiagnostics: result.sessionDiagnostics ?? null,
      },
    }, { status: result.status === "failed" ? 500 : 409 });
  } catch (error) {
    const thrownCode = error instanceof Error && "code" in error
      ? String((error as Error & { code: unknown }).code)
      : "";
    const code = thrownCode === "PROFILE_BROWSER_CLOSE_FAILED" || thrownCode === "PROFILE_LOCK_OWNERSHIP_LOST"
      ? thrownCode
      : "amazon_detail_collect_failed";
    const closeUnconfirmed = code === "PROFILE_BROWSER_CLOSE_FAILED" || code === "PROFILE_LOCK_OWNERSHIP_LOST";
    console.error("[source-layer/amazon-detail]", { traceId, code: "amazon_detail_collect_failed" });
    return NextResponse.json({
      ok: false,
      error: {
        status: "failed",
        code,
        message: closeUnconfirmed
          ? "Amazon 详情浏览器未能确认关闭，Profile 锁已保留。请检查已保存证据和浏览器进程后再继续。"
          : "Amazon 详情采集发生异常，请先检查已保存证据与采集审计。",
        traceId,
      },
    }, { status: 500 });
  }
}
