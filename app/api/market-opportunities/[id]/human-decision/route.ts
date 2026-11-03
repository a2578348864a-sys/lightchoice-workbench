import { NextRequest, NextResponse } from "next/server";

import { parseMarketOpportunityHumanDecisionStatus } from "@/lib/marketOpportunity/contract";
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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: { code: "market_opportunity_invalid_request", message: "请求体必须是 JSON。" } }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ ok: false, error: { code: "market_opportunity_invalid_request", message: "请求体必须是 JSON 对象。" } }, 400);
  }
  const payload = body as Record<string, unknown>;
  let status: ReturnType<typeof parseMarketOpportunityHumanDecisionStatus>;
  try {
    status = parseMarketOpportunityHumanDecisionStatus(payload.status);
  } catch (error) {
    const mapped = apiErrorOf(error, "人工决策状态不合法。");
    return json({ ok: false, error: { code: mapped.code, message: mapped.message } }, mapped.httpStatus);
  }
  if (status === "UNREVIEWED") {
    return json({ ok: false, error: { code: "market_opportunity_human_decision_invalid", message: "保存人工决策时必须选择具体状态。" } }, 422);
  }
  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  const nextAction = payload.nextAction === null || payload.nextAction === undefined
    ? null : typeof payload.nextAction === "string" ? payload.nextAction.trim() : "";
  const expectedRevision = payload.expectedRevision;
  if (!reason || reason.length > 4_000 || (nextAction !== null && nextAction.length > 4_000)
    || !Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) {
    return json({ ok: false, error: { code: "market_opportunity_human_decision_invalid", message: "请填写人工理由，并提供有效的 revision。" } }, 422);
  }
  const { id } = await context.params;
  try {
    const record = await createMarketOpportunityRepository().setHumanDecision({
      id,
      status,
      reason,
      nextAction,
      expectedRevision: expectedRevision as number,
    });
    return json({ ok: true, data: toMarketOpportunityDetailView(record) });
  } catch (error) {
    const mapped = apiErrorOf(error, "保存人工决策失败，请刷新后重试。");
    return json({ ok: false, error: { code: mapped.code, message: mapped.message } }, mapped.httpStatus);
  }
}
