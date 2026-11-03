import { NextRequest, NextResponse } from "next/server";

import { requireOwnerOnly } from "@/lib/server/demoGuard";
import { sameOrigin, toMarketOpportunityDetailView } from "@/lib/server/marketOpportunityService";
import { generateProductConcept, MarketOpportunityConceptError, type ConceptGenerationMode } from "@/lib/server/marketOpportunityConceptService";
import { logAgentEvent } from "@/lib/server/agentEventLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 32 * 1024;

function json(body: unknown, status = 200) { return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } }); }

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = requireOwnerOnly(request);
  if (!auth.ok) return json({ ok: false, error: { code: auth.code, message: auth.message } }, auth.status);
  if (!sameOrigin(request)) return json({ ok: false, error: { code: "origin_not_allowed", message: "请求来源不受信任。" } }, 403);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return json({ ok: false, error: { code: "body_too_large", message: "请求体过大。" } }, 413);
  let body: unknown = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: { code: "invalid_json", message: "请求体必须是 JSON。" } }, 400); }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ ok: false, error: { code: "invalid_body", message: "请求体必须是 JSON 对象。" } }, 400);
  const payload = body as Record<string, unknown>;
  if (Object.keys(payload).some((key) => key !== "mode")) return json({ ok: false, error: { code: "invalid_body", message: "请求包含未允许的字段。" } }, 400);
  const mode: ConceptGenerationMode = payload.mode === "fail" ? "fail" : "deterministic";
  const { id } = await context.params;
  try {
    const result = await generateProductConcept({ context: auth.context, opportunityId: id, mode });
    await logAgentEvent({ module: "market-opportunity", event: "concept_generated", level: result.concept.status === "FAILED" ? "warn" : "info", message: result.concept.status === "FAILED" ? "产品概念合成失败，保留人工决策入口。" : "产品概念已生成。", metadata: { opportunityId: id, conceptId: result.concept.conceptId, status: result.concept.status, mode } });
    return json({ ok: true, data: toMarketOpportunityDetailView(result.opportunity) });
  } catch (error) {
    if (error instanceof MarketOpportunityConceptError) return json({ ok: false, error: { code: error.code, message: error.message } }, error.status);
    return json({ ok: false, error: { code: "concept_failed", message: "生成产品概念失败。" } }, 500);
  }
}
