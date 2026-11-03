import { NextRequest, NextResponse } from "next/server";
import { getMarketAnalysis } from "@/lib/server/v5MarketService";
import { authResponse, readAuth, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { okResponse } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ scanId: string }> }) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const { scanId } = await context.params;
    return NextResponse.json(okResponse(await getMarketAnalysis({ context: auth.context, scanId, include: new URL(request.url).searchParams.get("include") ?? undefined })).body);
  } catch (error) { return v5ErrorResponse(error); }
}
