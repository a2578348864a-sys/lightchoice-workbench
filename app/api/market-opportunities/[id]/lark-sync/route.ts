import { NextRequest, NextResponse } from "next/server";

import { requireOwnerOnly } from "@/lib/server/demoGuard";
import { buildInitialLarkSync, parseMarketOpportunityLarkSync } from "@/lib/marketOpportunity/contract";
import {
  apiErrorOf,
  createMarketOpportunityRepository,
  sameOrigin,
  syncOpportunityExport,
  toMarketOpportunityDetailView,
} from "@/lib/server/marketOpportunityService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = requireOwnerOnly(request);
  if (!auth.ok) return json({ ok: false, error: { code: auth.code, message: auth.message } }, auth.status);
  if (!sameOrigin(request)) return json({ ok: false, error: { code: "origin_not_allowed", message: "请求来源不受信任。" } }, 403);
  const { id } = await context.params;
  const repository = createMarketOpportunityRepository();
  try {
    const current = await repository.getById(id);
    if (!current) return json({ ok: false, error: { code: "market_opportunity_not_found", message: "没有找到该市场机会。" } }, 404);
    if (current.humanDecision?.status !== "CONTINUE") {
      return json({ ok: false, error: { code: "market_opportunity_lark_blocked", message: "只有人工决策为“继续验证”时才允许同步机会池。" } }, 409);
    }
    const result = await syncOpportunityExport(current);
    const syncState = parseMarketOpportunityLarkSync({
      ...buildInitialLarkSync(),
      status: result.status,
      opportunityId: current.id,
      tableId: result.tableId,
      recordId: result.recordId,
      viewUrl: result.viewUrl,
      syncedAt: result.status === "SYNCED" ? new Date().toISOString() : null,
      idempotencyKey: result.idempotencyKey,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    });
    const updated = await repository.setLarkSync(id, syncState);
    return json({ ok: true, data: { result, opportunity: toMarketOpportunityDetailView(updated) } });
  } catch (error) {
    const mapped = apiErrorOf(error, "同步机会池到飞书失败，请稍后重试。");
    return json({ ok: false, error: { code: mapped.code, message: mapped.message } }, mapped.httpStatus);
  }
}
