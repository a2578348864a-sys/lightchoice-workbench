import { NextRequest, NextResponse } from "next/server";

import { failedAiFromError, runMarketOpportunityAi } from "@/lib/marketOpportunity/ai";
import { requireOwnerOnly } from "@/lib/server/demoGuard";
import {
  apiErrorOf,
  createMarketOpportunityRepository,
  sameOrigin,
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
    const ai = runMarketOpportunityAi(current.analysisSnapshot, current.nicheDefinition);
    const updated = await repository.setAiInterpretation(id, ai);
    return json({ ok: true, data: toMarketOpportunityDetailView(updated) });
  } catch (error) {
    const failed = failedAiFromError(error);
    try {
      const failedRecord = await repository.setAiInterpretation(id, failed);
      const mapped = apiErrorOf(error, "AI 解释未完成，已记录失败状态。");
      return json({
        ok: false,
        data: toMarketOpportunityDetailView(failedRecord),
        error: { code: mapped.code, message: mapped.message },
      }, mapped.httpStatus === 500 ? 503 : mapped.httpStatus);
    } catch (persistError) {
      const mapped = apiErrorOf(persistError, "记录 AI 失败状态时发生错误。");
      return json({ ok: false, error: { code: mapped.code, message: mapped.message } }, mapped.httpStatus);
    }
  }
}
