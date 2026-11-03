import { NextRequest, NextResponse } from "next/server";
import { authResponse, originError, writeAuth, writeOriginOk } from "@/lib/server/v5ApiRoute";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  return NextResponse.json({ ok: false, error: { code: "LEGACY_SYNC_RETRY_RETIRED", message: "旧同步重试入口已停用，请从 Workbench 的飞书个人看板投影入口重新提交。" } }, { status: 410 });
}
