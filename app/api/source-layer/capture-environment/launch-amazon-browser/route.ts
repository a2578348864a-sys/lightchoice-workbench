import { NextRequest, NextResponse } from "next/server";

import { isTrustedWriteRequest as sameOrigin } from "@/lib/server/accessPassword";
import { launchAmazonBrowser } from "@/lib/server/amazonBrowserLauncher";
import { authResponse, readAuth, v5ErrorResponse } from "@/lib/server/v5ApiRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "no-store, max-age=0" };

/**
 * 受控启动 Amazon 专用可见浏览器（POST）。
 *
 * 安全边界：
 * - 仅 Owner 主体 + 同源请求；
 * - **不接受任何请求参数**：Chrome/Edge 程序、Profile 路径、代理地址全部由服务端正式配置解析；
 * - 已有同 Profile 窗口 → 复用（already_running），不重复启动；
 * - Profile 被工作台租约或其他程序占用 → 409 PROFILE_IN_USE；
 * - 不开放 CDP、不自动登录、不关闭用户浏览器、不写采集事实。
 */
export async function POST(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (auth.context.mode !== "owner") {
    return NextResponse.json(
      { ok: false, error: { code: "owner_required", message: "当前主体不允许启动本机采集浏览器。" } },
      { status: 403, headers: noStoreHeaders },
    );
  }
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { ok: false, error: { code: "origin_not_allowed", message: "请求来源不受信任。" } },
      { status: 403, headers: noStoreHeaders },
    );
  }

  try {
    const result = await launchAmazonBrowser();
    if (result.status === "rejected") {
      return NextResponse.json(
        { ok: false, error: { code: result.code, message: result.message } },
        { status: 409, headers: noStoreHeaders },
      );
    }
    if (result.status === "failed") {
      return NextResponse.json(
        { ok: false, error: { code: result.code, message: result.message } },
        { status: 500, headers: noStoreHeaders },
      );
    }
    return NextResponse.json(
      { ok: true, data: { status: result.status, pid: result.pid } },
      { status: 200, headers: noStoreHeaders },
    );
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
