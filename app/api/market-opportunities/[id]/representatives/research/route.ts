import { NextRequest, NextResponse } from "next/server";

import { requireOwnerOnly } from "@/lib/server/demoGuard";
import { sameOrigin } from "@/lib/server/marketOpportunityService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 旧版「代表商品 → 研究任务」交接入口（已退役，2026-11-02）。
 *
 * 为什么停用：本路由直接调用 `startRepresentativeResearch`，只校验 owner 与同源，
 * 不校验 Market Gate(PROCEED)、扫描快照哈希、readiness 与代表品版本，
 * 与正式交接 `POST /api/market-analysis/{scanId}/research-handoff`
 * （`lib/server/v5MarketService.ts#handoffMarketToResearch`，四重校验）构成第二条链路，
 * 可绕开 02 的人工市场判断。
 *
 * 处理方式：保留路由与鉴权以便给出可理解的稳定错误，但**不再创建或复用任何研究任务**。
 * 历史 NicheOpportunity、代表品关系与只读查询（`readRepresentativeView`）保持不变。
 */
const RETIRED = {
  code: "LEGACY_RESEARCH_HANDOFF_RETIRED",
  message:
    "旧版代表品研究入口已停用：请在 02 市场研究完成人工 Market Gate（PROCEED）并保存代表商品后，通过正式交接进入 03 商品深研。",
} as const;

function gone() {
  return NextResponse.json(
    { ok: false, error: { code: RETIRED.code, message: RETIRED.message } },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  // 鉴权与同源仍照旧执行：未授权请求得到 403，不会因 410 变成匿名可达端点。
  const auth = requireOwnerOnly(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: { code: auth.code, message: auth.message } }, { status: auth.status });
  }
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { ok: false, error: { code: "origin_not_allowed", message: "请求来源不受信任。" } },
      { status: 403 },
    );
  }
  return gone();
}

/** 只读访问同样明确返回 410，避免被误当作可恢复的交接端点。 */
export function GET() {
  return gone();
}
