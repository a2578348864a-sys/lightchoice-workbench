import { NextRequest, NextResponse } from "next/server";

import { requireAuthenticated, requireOwnerOnly } from "@/lib/server/demoGuard";
import {
  apiErrorOf,
  createMarketOpportunityRepository,
  sameOrigin,
  toMarketOpportunityListView,
} from "@/lib/server/marketOpportunityService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function errorResponse(status: number, code: string, message: string) {
  return json({ ok: false, error: { code, message } }, status);
}

function ownerRead(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return { response: errorResponse(auth.status, auth.code, auth.message) } as const;
  if (auth.context.mode !== "owner") {
    return { response: errorResponse(403, "market_opportunity_owner_only", "市场机会池目前只对 Owner 开放。") } as const;
  }
  return { auth } as const;
}

export async function GET(request: NextRequest) {
  const gate = ownerRead(request);
  if (gate.response) return gate.response;
  try {
    const rawLimit = new URL(request.url).searchParams.get("limit");
    const limit = rawLimit === null ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
      return errorResponse(400, "limit_invalid", "limit 必须是 1 到 100 之间的整数。");
    }
    const records = await createMarketOpportunityRepository().list({ limit });
    return json({
      ok: true,
      data: {
        schemaVersion: "market-opportunity-list.v1",
        items: records.map(toMarketOpportunityListView),
      },
    });
  } catch (error) {
    const mapped = apiErrorOf(error, "读取市场机会池失败，请稍后重试。");
    return errorResponse(mapped.httpStatus, mapped.code, mapped.message);
  }
}

export async function POST(request: NextRequest) {
  const auth = requireOwnerOnly(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  if (!sameOrigin(request)) return errorResponse(403, "origin_not_allowed", "请求来源不受信任。");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "market_opportunity_invalid_request", "请求体必须是 JSON。");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse(400, "market_opportunity_invalid_request", "请求体必须是 JSON 对象。");
  }
  if (JSON.stringify(body).length > 64 * 1024) {
    return errorResponse(413, "market_opportunity_request_too_large", "请求体超出大小上限。");
  }
  const payload = body as Record<string, unknown>;
  const name = typeof payload.name === "string" ? payload.name : "";
  const latestMarketScanId = typeof payload.latestMarketScanId === "string"
    ? payload.latestMarketScanId
    : typeof payload.scanId === "string" ? payload.scanId : "";
  let scanIds: string[] | undefined;
  if (payload.scanIds !== undefined) {
    if (!Array.isArray(payload.scanIds) || payload.scanIds.some((value) => typeof value !== "string")) {
      return errorResponse(400, "market_opportunity_invalid_request", "scanIds 必须是字符串数组。");
    }
    scanIds = (payload.scanIds as string[]).map((value) => value.trim()).filter(Boolean);
  }
  if (!name.trim() || !latestMarketScanId.trim()) {
    return errorResponse(400, "market_opportunity_invalid_request", "请填写机会名称并选择 latest MarketScan。");
  }
  try {
    const record = await createMarketOpportunityRepository().create({
      name,
      latestMarketScanId: latestMarketScanId.trim(),
      scanIds,
    });
    return json({ ok: true, data: toMarketOpportunityListView(record) }, 201);
  } catch (error) {
    const mapped = apiErrorOf(error, "创建市场机会失败，请稍后重试。");
    return errorResponse(mapped.httpStatus, mapped.code, mapped.message);
  }
}
