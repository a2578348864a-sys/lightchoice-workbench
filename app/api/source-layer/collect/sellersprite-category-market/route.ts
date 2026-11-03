import { NextRequest, NextResponse } from "next/server";

import { captureCategoryMarketBatchThroughGateway } from "@/lib/sourceLayer/server/captureGateway";
import { requireAuthenticated } from "@/lib/server/demoGuard";
import {
  captureSellerSpriteCategoryMarketTable,
  SellerSpriteCategoryCaptureError,
} from "@/lib/server/sellerSpriteCategoryMarketCapture";
import { matchSellerSpriteCandidate } from "@/lib/sourceLayer/sellerSpriteCategoryMatch";

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

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

const AMAZON_NODE_ID = /^[0-9]+$/u;
const SELLERSPRITE_NODE_ID = /^[0-9]+(?::[0-9]+)*$/u;

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
  const categoryId = isRecord(body) && typeof body.categoryId === "string" ? body.categoryId.trim() : "";
  const amazonNodeId = isRecord(body) && typeof body.amazonNodeId === "string" ? body.amazonNodeId.trim() : "";
  const amazonPathEnRaw = isRecord(body) && Array.isArray(body.amazonPathEn)
    ? body.amazonPathEn.map((segment) => (typeof segment === "string" ? segment.trim() : "")).filter(Boolean)
    : [];

  if (!query || query.length > 120 || hasControlChars(query)
    || !SELLERSPRITE_NODE_ID.test(categoryId) || categoryId.length > 80) {
    return errorResponse(400, "category_capture_input_invalid", "类目关键词或所选类目无效，请重新选择。");
  }

  // fail-closed：正式类目采集必须携带完整 Amazon 上下文，禁止“没传就跳过 matcher”。
  if (!amazonNodeId || amazonPathEnRaw.length === 0) {
    return errorResponse(400, "category_match_unconfirmed", "必须提供完整的 Amazon 类目上下文（amazonNodeId 与 amazonPathEn），否则禁止采集。");
  }
  if (!AMAZON_NODE_ID.test(amazonNodeId)) {
    return errorResponse(400, "category_capture_input_invalid", "Amazon 类目节点 ID 无效。");
  }
  if (amazonPathEnRaw.length > 12) {
    return errorResponse(400, "category_capture_input_invalid", "Amazon 类目路径过长。");
  }

  try {
    const batch = await captureSellerSpriteCategoryMarketTable({
      query,
      categoryId,
      amazonNodeId,
      amazonPathEn: amazonPathEnRaw,
    });
    const gateway = await captureCategoryMarketBatchThroughGateway({ context: auth.context, batch });
    return NextResponse.json({
      ok: true,
      data: {
        batch: gateway.batch,
        subjectKey: gateway.subjectKey,
        traceId: gateway.traceId,
        contentHash: gateway.contentHash,
        created: gateway.created,
        duplicate: gateway.duplicate,
        match: matchSellerSpriteCandidate({
          amazon: { amazonNodeId, amazonPathEn: amazonPathEnRaw },
          candidate: { id: categoryId, label: batch.category.label },
        }),
      },
    }, { status: gateway.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof SellerSpriteCategoryCaptureError) {
      const status = error.code === "category_query_invalid" ? 400
        : error.code === "category_match_unconfirmed" ? 409
          : error.code === "category_selection_stale" ? 409
            : error.code === "seller_sprite_session_unavailable" || error.code === "seller_sprite_login_required" ? 409
              : 502;
      return errorResponse(status, error.code, error.message.trim());
    }
    console.error("[source-layer/sellersprite-category-market]", { code: "category_capture_failed" });
    return errorResponse(502, "category_capture_failed", "类目市场采集失败，请检查 SellerSprite 登录状态和结果页面后重试。");
  }
}
