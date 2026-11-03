import { NextRequest, NextResponse } from "next/server";

import { requireAuthenticated } from "@/lib/server/demoGuard";
import { checkAmazonCapturePreflight } from "@/lib/server/amazonCapturePreflight";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: { code: auth.code, message: auth.message } }, { status: auth.status });
  }

  try {
    const preflight = await checkAmazonCapturePreflight();
    return NextResponse.json({
      ok: true,
      data: {
        ok: preflight.ok,
        status: preflight.status,
        exitCountry: preflight.exitCountry,
        exitCountryName: preflight.exitCountryName,
        proxyConfigured: preflight.proxyConfigured,
        proxyProtocol: preflight.proxyProtocol,
        failureKind: preflight.failureKind,
        probeAttempts: preflight.probeAttempts,
        fallbackAttempted: preflight.fallbackAttempted,
        errorCode: preflight.errorCode ?? null,
        message: preflight.message,
        checkedAt: preflight.checkedAt,
      },
    }, { status: 200 });
  } catch {
    return NextResponse.json({
      ok: false,
      error: {
        code: "AMAZON_CAPTURE_PREFLIGHT_FAILED",
        message: "采集出口预检异常，请刷新后重试。",
      },
    }, { status: 500 });
  }
}
