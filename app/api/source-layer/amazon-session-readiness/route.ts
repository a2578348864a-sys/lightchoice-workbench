import { NextRequest, NextResponse } from "next/server";

import { requireAuthenticated } from "@/lib/server/demoGuard";
import { checkAmazonSessionReadiness } from "@/lib/server/amazonSessionReadiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/source-layer/amazon-session-readiness
 *
 * 「采集前先证明 Amazon 会话可用」的只读环境检查：
 * - 非美国出口直接返回 `PREFLIGHT_BLOCKED`，不启动浏览器；
 * - 只有 `US_READY` 才打开 Amazon 首页判断 pageStatus / delivery / language；
 * - 不请求 Detail ASIN、不发起 Search keyword、不采集 Review，
 *   不产生 Evidence / ProductFact / Search observation / ReviewEvidence；
 * - 唯一副作用是一条 `amazon_us_session_readiness_checked` 诊断事件。
 *
 * 该请求会启动一次真实浏览器（headful，与采集路径共用专用 profile），
 * 因此只允许本机 Owner 会话调用，且不应被缓存或预取。
 */
export async function GET(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: { code: auth.code, message: auth.message } }, { status: auth.status });
  }

  try {
    const readiness = await checkAmazonSessionReadiness({ context: auth.context });
    return NextResponse.json({ ok: true, data: readiness }, { status: 200 });
  } catch {
    return NextResponse.json({
      ok: false,
      error: {
        code: "AMAZON_SESSION_READINESS_FAILED",
        message: "Amazon 会话就绪检查发生异常；未写入任何采集事实。",
      },
    }, { status: 500 });
  }
}
