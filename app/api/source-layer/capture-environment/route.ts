import { NextRequest, NextResponse } from "next/server";

import { requireAuthenticated } from "@/lib/server/demoGuard";
import { checkSellerSpriteCdpReadiness } from "@/lib/server/captureEnvironmentReadiness";
import { probeBrowserIdentityViaHttp } from "@/lib/server/sellerSpriteBrowserIdentity";
import { resolveSellerSpriteCdpEndpoint, resolveSellerSpriteProfileDirectory } from "@/lib/server/sellerSpriteProfileConfig";
import { readCaptureRuntimeConfig } from "@/scripts/ops/capture-runtime-config.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "no-store, max-age=0" };

/**
 * D2-1F：CDP 可达时同时如实给出「实例身份」（是否本工作台专用浏览器）——
 * 不能把「9222 可达」表示成「SellerSprite 采集环境已就绪」；
 * 探测失败/无法验证一律 unknown（不猜测、不抛错、不启动浏览器、不触发采集）。
 */
async function probeEnvironmentBrowserIdentity(): Promise<"managed" | "foreign" | "unknown"> {
  try {
    const endpoint = resolveSellerSpriteCdpEndpoint();
    if (!endpoint) return "unknown";
    return await probeBrowserIdentityViaHttp(endpoint.origin, resolveSellerSpriteProfileDirectory());
  } catch {
    return "unknown";
  }
}

/**
 * Read-only status endpoint; it does not start or launch a browser or touch capture/storage services.
 * The identity probe only reads CDP metadata（/json/version + Browser.getBrowserCommandLine）。
 */
export async function GET(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: { code: auth.code, message: auth.message } },
      { status: auth.status, headers: noStoreHeaders }
    );
  }

  try {
    const readiness = await checkSellerSpriteCdpReadiness();
    // CDP 不可达时不做身份探测（browserIdentity = null 表示「无从判定」，不是「不可信」）。
    const browserIdentity = readiness.cdpReachable ? await probeEnvironmentBrowserIdentity() : null;
    return NextResponse.json(
      { ok: true, data: { ...readiness, browserIdentity, amazon: readCaptureRuntimeConfig() } },
      { status: 200, headers: noStoreHeaders },
    );
  } catch {
    return NextResponse.json({
      ok: false,
      error: {
        code: "CAPTURE_ENVIRONMENT_CHECK_FAILED",
        message: "采集环境检查失败；未启动浏览器，也未触发采集。",
      },
    }, { status: 503, headers: noStoreHeaders });
  }
}
