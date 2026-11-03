import { NextRequest, NextResponse } from "next/server";
import { buildDeepResearchView } from "@/lib/server/deepResearchService";
import { authResponse, readAuth, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { okResponse } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 03 商品深研：只读深度分析投影（VOC 证据归属 / 代表商品可比性 / 开发机会）。
 *
 * 严格只读：不写 ProductFact、不写 EvidenceStore、不调用 AI、不创建研究结果。
 */
export async function GET(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const { taskId } = await context.params;
    return NextResponse.json(okResponse(await buildDeepResearchView({ context: auth.context, taskId })).body);
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
