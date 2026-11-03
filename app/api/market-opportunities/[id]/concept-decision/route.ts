import { NextRequest, NextResponse } from "next/server";

import { CONCEPT_HUMAN_DECISIONS, type ConceptHumanDecisionStatus } from "@/lib/marketOpportunity/concept";
import { requireOwnerOnly } from "@/lib/server/demoGuard";
import { sameOrigin, toMarketOpportunityDetailView } from "@/lib/server/marketOpportunityService";
import { MarketOpportunityConceptError, saveProductConceptDecision } from "@/lib/server/marketOpportunityConceptService";
import { logAgentEvent } from "@/lib/server/agentEventLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) { return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } }); }

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = requireOwnerOnly(request);
  if (!auth.ok) return json({ ok: false, error: { code: auth.code, message: auth.message } }, auth.status);
  if (!sameOrigin(request)) return json({ ok: false, error: { code: "origin_not_allowed", message: "请求来源不受信任。" } }, 403);
  let body: unknown;
  try { body = await request.json(); } catch { return json({ ok: false, error: { code: "invalid_json", message: "请求体必须是 JSON。" } }, 400); }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ ok: false, error: { code: "invalid_body", message: "请求体必须是 JSON 对象。" } }, 400);
  const payload = body as Record<string, unknown>;
  if (Object.keys(payload).some((key) => !["status", "reason", "expectedRevision"].includes(key))) return json({ ok: false, error: { code: "invalid_body", message: "请求包含未允许的字段。" } }, 400);
  const status = payload.status;
  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  if (typeof status !== "string" || !(CONCEPT_HUMAN_DECISIONS as readonly string[]).includes(status) || status === "UNREVIEWED" || !reason || reason.length > 4_000 || !Number.isSafeInteger(payload.expectedRevision) || (payload.expectedRevision as number) < 0) {
    return json({ ok: false, error: { code: "concept_decision_invalid", message: "请填写有效的概念决定、理由和 revision。" } }, 422);
  }
  const { id } = await context.params;
  try {
    const result = await saveProductConceptDecision({ context: auth.context, opportunityId: id, status: status as ConceptHumanDecisionStatus, reason, expectedRevision: payload.expectedRevision as number });
    await logAgentEvent({ module: "market-opportunity", event: "concept_decision_saved", level: "info", message: "产品概念人工决定已保存。", metadata: { opportunityId: id, status } });
    return json({ ok: true, data: toMarketOpportunityDetailView(result) });
  } catch (error) {
    if (error instanceof MarketOpportunityConceptError) return json({ ok: false, error: { code: error.code, message: error.message } }, error.status);
    return json({ ok: false, error: { code: "concept_decision_failed", message: "保存产品概念人工决定失败。" } }, 500);
  }
}
