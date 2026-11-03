import { NextRequest, NextResponse } from "next/server";

import { requireAuthenticated } from "@/lib/server/demoGuard";
import { getLatestCategoryMarketCapture } from "@/lib/sourceLayer/server/sourceLayerService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);

  try {
    const latest = await getLatestCategoryMarketCapture(auth.context);
    return NextResponse.json({ ok: true, data: latest });
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? String((error as { code: unknown }).code)
      : "source_layer_read_failed";
    return errorResponse(500, code, "最近一次类目市场证据读取失败，请稍后重试。");
  }
}
