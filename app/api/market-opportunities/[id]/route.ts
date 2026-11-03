import { NextRequest, NextResponse } from "next/server";

import { requireAuthenticated } from "@/lib/server/demoGuard";
import {
  apiErrorOf,
  createMarketOpportunityRepository,
  toMarketOpportunityDetailView,
} from "@/lib/server/marketOpportunityService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return json({ ok: false, error: { code: auth.code, message: auth.message } }, auth.status);
  if (auth.context.mode !== "owner") {
    return json({ ok: false, error: { code: "market_opportunity_owner_only", message: "市场机会池目前只对 Owner 开放。" } }, 403);
  }
  const { id } = await context.params;
  try {
    const record = await createMarketOpportunityRepository().getById(id);
    if (!record) return json({ ok: false, error: { code: "market_opportunity_not_found", message: "没有找到该市场机会。" } }, 404);
    return json({ ok: true, data: toMarketOpportunityDetailView(record) });
  } catch (error) {
    const mapped = apiErrorOf(error, "读取市场机会失败，请稍后重试。");
    return json({ ok: false, error: { code: mapped.code, message: mapped.message } }, mapped.httpStatus);
  }
}

/**
 * DELETE /api/market-opportunities/[id]
 *
 * 经过生命周期安全审计的删除入口：若已有决断、代表品研究或产品概念，409 Conflict 拒绝并保护事实链。
 */
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return json({ ok: false, error: { code: auth.code, message: auth.message } }, auth.status);
  if (auth.context.mode !== "owner") {
    return json({ ok: false, error: { code: "market_opportunity_owner_only", message: "市场机会删除目前只对 Owner 开放。" } }, 403);
  }

  const { id } = await context.params;
  const { checkMarketOpportunityDeletionSafety } = await import("@/lib/server/lifecycleSafety");
  const { prisma } = await import("@/lib/server/db");
  const { MARKET_OPPORTUNITY_OWNER_SCOPE } = await import("@/lib/marketOpportunity/types");

  const safety = await checkMarketOpportunityDeletionSafety(id);
  if (!safety.canDelete) {
    if (safety.code === "not_found") {
      return json({ ok: false, error: { code: "market_opportunity_not_found", message: "没有找到该市场机会。" } }, 404);
    }
    return json({ ok: false, error: { code: "market_opportunity_protected", message: safety.reason || "该细分机会已产生业务决断，禁止物理删除。" } }, 409);
  }

  try {
    await prisma.nicheOpportunity.delete({
      where: { id, ownerScope: MARKET_OPPORTUNITY_OWNER_SCOPE },
    });
    return json({ ok: true, data: { id, deleted: true } });
  } catch (error) {
    return json({ ok: false, error: { code: "market_opportunity_delete_failed", message: "删除市场机会失败，请稍后重试。" } }, 500);
  }
}
