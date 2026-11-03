import { NextRequest, NextResponse } from "next/server";

import { isTrustedWriteRequest as sameOrigin } from "@/lib/server/accessPassword";
import { launchSellerSpriteBrowser } from "@/lib/server/sellerSpriteBrowserLauncher";
import { authResponse, readAuth, v5ErrorResponse } from "@/lib/server/v5ApiRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "no-store, max-age=0" };

/**
 * 受控启动 SellerSprite 专用可见 Chrome（POST，写操作）。
 *
 * 安全边界：
 * - 仅 Owner 主体 + 同源（本机 127.0.0.1 工作台）请求；
 * - **不接受任何请求参数**：Chrome 程序、Profile 目录、调试端口全部由服务端配置解析，
 *   前端无法传入任意命令或路径；
 * - 已运行 → 直接复用（already_running），不重启、不断连；
 * - 端口占用但非 CDP / Profile 被其他实例占用 → 明确拒绝（fail-closed）。
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
    const result = await launchSellerSpriteBrowser();
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
    return NextResponse.json({ ok: true, data: result }, { status: 200, headers: noStoreHeaders });
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
