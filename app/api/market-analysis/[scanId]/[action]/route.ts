import { NextRequest, NextResponse } from "next/server";
import {
  getMarketCategoryEvidence,
  handoffMarketToResearch,
  marketScanAction,
  saveMarketCategoryEvidenceBinding,
  saveMarketGate,
  saveMarketRepresentatives,
} from "@/lib/server/v5MarketService";
import { authResponse, jsonBody, originError, readAuth, writeAuth, writeOriginOk, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { okResponse, requireIdempotencyKey, safeParseBody, V5CoreError } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";

/** 只读查询：类目市场证据视图（绑定状态 + 可绑定列表 + 已绑定详情）。 */
export async function GET(request: NextRequest, context: { params: Promise<{ scanId: string; action: string }> }) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const { scanId, action } = await context.params;
    if (action !== "category-evidence") throw new V5CoreError("INVALID_INPUT", "不支持的市场分析查询动作。", 404);
    const data = await getMarketCategoryEvidence({ context: auth.context, scanId });
    return NextResponse.json(okResponse(data, 200, [`market-analysis:${scanId}`]).body);
  } catch (error) { return v5ErrorResponse(error); }
}

export async function POST(request: NextRequest, context: { params: Promise<{ scanId: string; action: string }> }) {
  const auth = writeAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (!writeOriginOk(request)) return originError();
  try {
    const { scanId, action } = await context.params;
    const body = safeParseBody(await jsonBody(request));
    const key = request.headers.get("Idempotency-Key") ?? (typeof body.idempotencyKey === "string" ? body.idempotencyKey : "");
    if (action === "market-gate") {
      const status = typeof body.status === "string" ? body.status : "";
      const data = await saveMarketGate({
        context: auth.context,
        scanId,
        status: status as "PENDING" | "PROCEED" | "VALIDATE_MORE" | "PAUSE" | "DROP",
        reason: typeof body.reason === "string" ? body.reason : body.reason === null ? null : undefined,
        missingDataAcknowledged: body.missingDataAcknowledged === true,
        expectedScanHash: typeof body.expectedScanHash === "string" ? body.expectedScanHash : "",
        expectedVersion: body.expectedVersion,
        idempotencyKey: requireIdempotencyKey(key),
      });
      return NextResponse.json(okResponse(data, 200, [`market-analysis:${scanId}`, "market-analysis-list", "home-summary"]).body);
    }
    if (action === "representatives") {
      const items = Array.isArray(body.items)
        ? body.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))).map((item) => ({
            marketSampleKey: typeof item.marketSampleKey === "string" ? item.marketSampleKey : "",
            asin: typeof item.asin === "string" ? item.asin : "",
            subjectKey: typeof item.subjectKey === "string" ? item.subjectKey : "",
            role: typeof item.role === "string" ? item.role : "",
            note: typeof item.note === "string" ? item.note : item.note === null ? null : undefined,
            researchRecommendation: item.researchRecommendation,
          }))
        : [];
      const data = await saveMarketRepresentatives({
        context: auth.context,
        scanId,
        expectedScanHash: typeof body.expectedScanHash === "string" ? body.expectedScanHash : "",
        expectedVersion: body.expectedVersion,
        items,
        idempotencyKey: requireIdempotencyKey(key),
      });
      return NextResponse.json(okResponse(data, 200, [`market-analysis:${scanId}`, "market-analysis-list", "home-summary"]).body);
    }
    if (action === "research-handoff") {
      const selections = Array.isArray(body.selections) ? body.selections.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))).map((item) => ({ marketSampleKey: typeof item.marketSampleKey === "string" ? item.marketSampleKey : "", asin: typeof item.asin === "string" ? item.asin : "", subjectKey: typeof item.subjectKey === "string" ? item.subjectKey : "", role: typeof item.role === "string" ? item.role : undefined })) : [];
      const data = await handoffMarketToResearch({ context: auth.context, scanId, expectedScanHash: typeof body.expectedScanHash === "string" ? body.expectedScanHash : "", selections, idempotencyKey: requireIdempotencyKey(key) });
      return NextResponse.json(okResponse(data, 201, [`market-analysis:${scanId}`, "research-list"]).body, { status: 201 });
    }
    if (action === "category-evidence") {
      const subjectKey = body.subjectKey === null
        ? null
        : typeof body.subjectKey === "string" ? body.subjectKey : undefined;
      if (subjectKey === undefined) throw new V5CoreError("INVALID_INPUT", "请提供 subjectKey；传 null 表示解绑。", 400);
      const data = await saveMarketCategoryEvidenceBinding({
        context: auth.context,
        scanId,
        subjectKey,
        acknowledgeScopeWarning: body.acknowledgeScopeWarning === true,
        expectedVersion: body.expectedVersion,
        idempotencyKey: requireIdempotencyKey(key),
      });
      return NextResponse.json(okResponse(data, 200, [`market-analysis:${scanId}`, "market-analysis-list"]).body);
    }
    if (action !== "archive" && action !== "restore" && action !== "delete") throw new V5CoreError("INVALID_INPUT", "市场分析动作无效。", 400);
    const data = await marketScanAction({ context: auth.context, scanId, action, expectedVersion: body.expectedVersion, expectedEvidenceBinding: body.expectedEvidenceBinding, idempotencyKey: requireIdempotencyKey(key) });
    return NextResponse.json(okResponse(data, 200, ["market-analysis-list", `market-analysis:${scanId}`, "research-list", "home-summary"]).body);
  } catch (error) { return v5ErrorResponse(error); }
}
