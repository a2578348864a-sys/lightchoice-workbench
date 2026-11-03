import { NextRequest, NextResponse } from "next/server";

import { readAuth, authResponse, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { listPromotableEvidenceSubjects } from "@/lib/sourceLayer/server/promotableEvidenceService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const result = await listPromotableEvidenceSubjects(auth.context);
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
