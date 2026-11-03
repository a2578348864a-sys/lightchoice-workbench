import { NextRequest, NextResponse } from "next/server";

import { requireOwnerOnly } from "@/lib/server/demoGuard";
import {
  attachProductFactToExistingCandidate,
  CandidateFactRecoveryError,
} from "@/lib/sourceLayer/server/candidateFactRecovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = requireOwnerOnly(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);

  const { id } = await context.params;
  const candidateId = (id ?? "").trim();
  if (!candidateId) {
    return errorResponse(400, "invalid_candidate_id", "缺少有效 candidate id。");
  }

  try {
    const result = await attachProductFactToExistingCandidate({
      candidateId,
      context: auth.context,
    });
    return NextResponse.json({ ok: true, data: result }, { status: 200 });
  } catch (error) {
    if (error instanceof CandidateFactRecoveryError) {
      const status = error.code === "candidate_not_found"
        ? 404
        : error.code === "owner_only_required" ? 403 : 409;
      return errorResponse(status, error.code, error.message);
    }
    return errorResponse(500, "fact_recovery_failed", "商品事实重建失败，请稍后重试。");
  }
}
