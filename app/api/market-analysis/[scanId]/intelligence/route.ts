import { NextRequest, NextResponse } from "next/server";
import { getMarketIntelligence, updateMarketIntelligence } from "@/lib/server/marketIntelligenceService";
import { authResponse, readAuth, writeAuth, writeOriginOk, originError, jsonBody, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { okResponse, safeParseBody, requireIdempotencyKey, V5CoreError } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ scanId: string }> }) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const { scanId } = await context.params;
    return NextResponse.json(okResponse(await getMarketIntelligence({ context: auth.context, scanId })).body);
  } catch (error) { return v5ErrorResponse(error); }
}

export async function POST(request: NextRequest, context: { params: Promise<{ scanId: string }> }) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  try {
    const { scanId } = await context.params;
    const body = safeParseBody(await jsonBody(request));
    if (!["bind", "generate", "apply-scope", "translate", "resolve-ai"].includes(String(body.action))) throw new V5CoreError("INVALID_INPUT", "市场情报动作无效。", 400);
    if (body.action === "bind" && (!Array.isArray(body.subjectKeys) || body.subjectKeys.some((key) => typeof key !== "string"))) throw new V5CoreError("INVALID_INPUT", "请选择查询证据。", 400);
    if (body.action === "translate" && (!Array.isArray(body.targetIds) || body.targetIds.some((id) => typeof id !== "string"))) throw new V5CoreError("INVALID_INPUT", "请选择需要翻译的原文。", 400);
    const data = await updateMarketIntelligence({ context: auth.context, scanId, action: body.action as "bind" | "generate" | "apply-scope" | "translate" | "resolve-ai", confirmedProviderChecked: body.confirmedProviderChecked === true, subjectKeys: body.subjectKeys as string[] | undefined, comparisonSubjects: Array.isArray(body.comparisonSubjects) ? body.comparisonSubjects as string[] : undefined, targetIds: body.targetIds as string[] | undefined, expectedScopeHash: typeof body.expectedScopeHash === "string" ? body.expectedScopeHash : undefined, expectedVersion: body.expectedVersion, expectedInputHash: typeof body.expectedInputHash === "string" ? body.expectedInputHash : undefined, idempotencyKey: requireIdempotencyKey(request.headers.get("Idempotency-Key") ?? "") });
    return NextResponse.json(okResponse(data, 200, [`market-analysis:${scanId}`]).body);
  } catch (error) { return v5ErrorResponse(error); }
}
