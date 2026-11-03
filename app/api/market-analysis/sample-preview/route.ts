import { NextRequest, NextResponse } from "next/server";
import { previewMarketAnalysisSample } from "@/lib/server/v5MarketService";
import { authResponse, readAuth, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { okResponse, V5CoreError } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * D0-004：创建市场研究前的权威样本预检（GET 只读，不写任何业务数据）。
 *
 * 返回来源商品数、初步有效数、最终可冻结样本数与逐阶段排除原因；
 * 服务端创建仍然保留最终权威（门禁不因预检而放宽）。
 */
export async function GET(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const query = new URL(request.url).searchParams;
    const productBatchId = (query.get("productBatchId") ?? "").trim();
    const marketplace = (query.get("marketplace") ?? "US").trim();
    if (!productBatchId) {
      throw new V5CoreError("MARKET_ANALYSIS_INPUT_INVALID", "缺少 productBatchId。", 400);
    }
    const data = await previewMarketAnalysisSample({ context: auth.context, productBatchId, marketplace });
    return NextResponse.json(okResponse(data).body);
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
