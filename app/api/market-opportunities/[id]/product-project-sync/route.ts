import { NextRequest, NextResponse } from "next/server";

import { buildInitialProductProjectSync, parseProductProjectSync } from "@/lib/marketOpportunity/concept";
import { requireOwnerOnly } from "@/lib/server/demoGuard";
import { sameOrigin, toMarketOpportunityDetailView } from "@/lib/server/marketOpportunityService";
import { createMarketOpportunityRepository } from "@/lib/server/marketOpportunityRepository";
import { syncProductProject } from "@/lib/integrations/lark/productProjectSync";
import { logAgentEvent } from "@/lib/server/agentEventLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) { return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } }); }

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = requireOwnerOnly(request);
  if (!auth.ok) return json({ ok: false, error: { code: auth.code, message: auth.message } }, auth.status);
  if (!sameOrigin(request)) return json({ ok: false, error: { code: "origin_not_allowed", message: "请求来源不受信任。" } }, 403);
  const { id } = await context.params;
  const repository = createMarketOpportunityRepository();
  try {
    const current = await repository.getById(id);
    if (!current) return json({ ok: false, error: { code: "opportunity_not_found", message: "没有找到该市场机会。" } }, 404);
    if (!current.conceptSnapshot) return json({ ok: false, error: { code: "concept_required", message: "请先生成产品概念。" } }, 409);
    const result = await syncProductProject({ opportunity: current, concept: current.conceptSnapshot });
    const state = parseProductProjectSync({
      ...buildInitialProductProjectSync(),
      status: result.status,
      conceptId: current.conceptSnapshot.conceptId,
      tableId: result.tableId,
      recordId: result.recordId,
      viewUrl: result.viewUrl,
      syncedAt: result.status === "SYNCED" ? new Date().toISOString() : null,
      idempotencyKey: result.idempotencyKey,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    });
    const updated = await repository.setConceptProjectSync(id, state);
    await logAgentEvent({ module: "market-opportunity", event: "product_project_sync", level: result.status === "SYNCED" ? "info" : "warn", message: result.status === "SYNCED" ? "产品开发项目已同步。" : "产品开发项目同步被门禁或预检拦截。", metadata: { opportunityId: id, conceptId: current.conceptSnapshot.conceptId, status: result.status, errorCode: result.errorCode ?? null } });
    return json({ ok: true, data: { result, opportunity: toMarketOpportunityDetailView(updated) } });
  } catch {
    return json({ ok: false, error: { code: "product_project_sync_failed", message: "产品开发项目同步失败，请稍后重试。" } }, 500);
  }
}
