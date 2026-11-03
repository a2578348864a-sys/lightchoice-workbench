import { NextRequest, NextResponse } from "next/server";

import { requireAuthenticated } from "@/lib/server/demoGuard";
import {
  getSellerSpriteCategoryNodes,
  SellerSpriteCategoryCaptureError,
} from "@/lib/server/sellerSpriteCategoryMarketCapture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function sameOrigin(request: NextRequest): boolean {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.protocol !== url.protocol || originUrl.port !== url.port) return false;
      return originUrl.host === url.host
        || (isLoopbackHost(originUrl.hostname) && isLoopbackHost(url.hostname));
    } catch {
      return false;
    }
  }
  const referer = request.headers.get("referer");
  try {
    if (!referer) return false;
    const refererUrl = new URL(referer);
    if (refererUrl.protocol !== url.protocol || refererUrl.port !== url.port) return false;
    return refererUrl.host === url.host
      || (isLoopbackHost(refererUrl.hostname) && isLoopbackHost(url.hostname));
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
  const query = isRecord(body) && typeof body.query === "string" ? body.query.trim() : "";
  if (!query || query.length > 120 || hasControlChars(query)) {
    return errorResponse(400, "category_query_invalid", "请输入 1 到 120 个字符的 Amazon 类目关键词。");
  }

  try {
    const nodes = await getSellerSpriteCategoryNodes(query);
    return NextResponse.json({ ok: true, data: { nodes } });
  } catch (error) {
    if (error instanceof SellerSpriteCategoryCaptureError) {
      const status = error.code === "category_query_invalid" ? 400
        : error.code === "seller_sprite_login_required" ? 409
          : 503;
      return errorResponse(status, error.code, error.message.trim());
    }
    console.error("[source-layer/sellersprite-category-nodes]", { code: "category_suggestions_failed" });
    return errorResponse(503, "category_suggestions_failed", "SellerSprite 类目建议未能加载，请检查登录会话后重试。");
  }
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
