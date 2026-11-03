import { NextRequest, NextResponse } from "next/server";
import { createMarketAnalysis, listMarketAnalyses } from "@/lib/server/v5MarketService";
import { authResponse, jsonBody, originError, readAuth, writeAuth, writeOriginOk, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { okResponse, requireIdempotencyKey, safeParseBody } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const query = new URL(request.url).searchParams;
    const data = await listMarketAnalyses({ context: auth.context, include: query.get("include") ?? undefined, marketplace: query.get("marketplace") ?? undefined, limit: query.has("limit") ? Number(query.get("limit")) : undefined });
    return NextResponse.json(okResponse(data).body);
  } catch (error) { return v5ErrorResponse(error); }
}

export async function POST(request: NextRequest) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  try {
    const body = safeParseBody(await jsonBody(request));
    const niche = body.niche && typeof body.niche === "object" && !Array.isArray(body.niche) ? body.niche as Record<string, unknown> : {};
    const source = body.source && typeof body.source === "object" && !Array.isArray(body.source) ? body.source as Record<string, unknown> : {};
    const key = request.headers.get("Idempotency-Key") ?? (typeof body.idempotencyKey === "string" ? body.idempotencyKey : "");
    const data = await createMarketAnalysis({ context: auth.context, scanName: typeof body.scanName === "string" ? body.scanName : "", marketplace: typeof body.marketplace === "string" ? body.marketplace : "US", niche, source, idempotencyKey: requireIdempotencyKey(key), expectedBatchVersion: body.expectedBatchVersion });
    return NextResponse.json(okResponse(data, data.replayed ? 200 : 201, ["market-analysis-list", `market-analysis:${data.id}`, "home-summary"]).body, { status: data.replayed ? 200 : 201 });
  } catch (error) { return v5ErrorResponse(error); }
}
