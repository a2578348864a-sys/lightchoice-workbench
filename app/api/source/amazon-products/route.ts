import { NextRequest, NextResponse } from "next/server";
import { authResponse, readAuth, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { listAmazonSourceProjection } from "@/lib/sourceLayer/server/amazonSourceProjection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const items = await listAmazonSourceProjection(auth.context);
    return NextResponse.json({ ok: true, data: { authority: "EvidenceStore", items } });
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
