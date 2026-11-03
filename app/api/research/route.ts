import { NextRequest, NextResponse } from "next/server";
import { listResearch } from "@/lib/server/v5ResearchService";
import { authResponse, readAuth, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { okResponse } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const query = new URL(request.url).searchParams;
    const data = await listResearch({ context: auth.context, view: query.get("view") ?? undefined, include: query.get("include") ?? undefined, limit: query.has("limit") ? Number(query.get("limit")) : undefined });
    return NextResponse.json(okResponse(data).body);
  } catch (error) { return v5ErrorResponse(error); }
}
