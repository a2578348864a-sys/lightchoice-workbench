import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticated } from "@/lib/server/demoGuard";
import {
  LarkBaseDestination,
  LarkCommodityPoolDestination,
} from "@/lib/integrations/lark";

export const runtime = "nodejs";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * GET /api/research-export/lark-preflight
 *
 * 飞书多维表格连接预检 API。
 * 检查当前环境变量配置、飞书 Base/Table 可达性与 21 项字段契约匹配度。
 * `writable` 代表「当前真实写入行可以安全发送」：必须字段、写入字段、字段类型三者都满足。
 * 纯预检，不写入任何数据。
 */
export async function GET(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) {
    return json({ ok: false, error: { code: auth.code, message: auth.message } }, auth.status);
  }

  try {
    const contract = new URL(request.url).searchParams.get("contract");
    const destination = contract === "commodity"
      ? new LarkCommodityPoolDestination()
      : new LarkBaseDestination();
    const preflight = await destination.preflight();
    return json({ ok: true, data: preflight });
  } catch (error) {
    const message = error instanceof Error ? error.message : "飞书连接预检发生未知异常";
    return json(
      {
        ok: false,
        error: { code: "lark_preflight_failed", message },
      },
      500,
    );
  }
}
