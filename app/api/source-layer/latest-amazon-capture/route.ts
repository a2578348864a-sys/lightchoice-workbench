import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticated } from "@/lib/server/demoGuard";
import { getLatestAmazonCaptureSummary } from "@/lib/server/latestAmazonCaptureSummary";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store, max-age=0" };
export async function GET(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return NextResponse.json({ ok: false, error: { code: auth.code, message: auth.message } }, { status: auth.status, headers });
  try { return NextResponse.json({ ok: true, data: await getLatestAmazonCaptureSummary(auth.context) }, { headers }); }
  catch { return NextResponse.json({ ok: false, error: { code: "AMAZON_EVIDENCE_READ_FAILED", message: "读取已保存的 Amazon 证据失败，请重新读取。" } }, { status: 503, headers }); }
}
