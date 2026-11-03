import { NextRequest, NextResponse } from "next/server";

import { requireAuthenticated } from "@/lib/server/demoGuard";
import { getSourceEvidenceDetail } from "@/lib/sourceLayer/server/sourceLayerService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subjectKey: string }> },
) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  const { subjectKey } = await context.params;
  const decoded = decodeURIComponent(subjectKey ?? "").trim();
  if (!decoded || decoded.length > 160 || !/^[A-Za-z0-9:._\-|@]+$/.test(decoded)) {
    return errorResponse(400, "evidence_subject_invalid", "商品标识不合法。");
  }
  try {
    const { subject, audit } = await getSourceEvidenceDetail(auth.context, decoded);
    if (!subject) {
      return errorResponse(404, "evidence_subject_not_found", "没有找到该商品的来源证据。");
    }
    return NextResponse.json({
      ok: true,
      data: {
        subjectKey: subject.subjectKey,
        marketplace: subject.marketplace,
        versions: subject.versions,
        ...(subject.marketCaptures ? { marketCaptures: subject.marketCaptures } : {}),
        audit,
      },
    });
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? String((error as { code: unknown }).code)
      : "source_layer_read_failed";
    return errorResponse(500, code, "来源证据读取失败，请稍后重试。");
  }
}
