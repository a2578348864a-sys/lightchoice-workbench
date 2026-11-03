import { NextRequest, NextResponse } from "next/server";

import { isTrustedWriteRequest as sameOrigin } from "@/lib/server/accessPassword";
import { openSellerSpriteProfileDirectory } from "@/lib/server/sellerSpriteBrowserLauncher";
import { authResponse, readAuth, v5ErrorResponse } from "@/lib/server/v5ApiRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "no-store, max-age=0" };

/**
 * 在本机文件管理器中打开 SellerSprite 专用 Profile 目录（辅助入口，POST 写操作）。
 *
 * 安全边界：仅 Owner + 同源请求；目录由服务端配置解析（`SELLERSPRITE_PROFILE_DIR`
 * 或 `<cwd>/.playwright-profile/sellersprite-v3`），不接受前端传入任何路径。
 */
export async function POST(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  if (auth.context.mode !== "owner") {
    return NextResponse.json(
      { ok: false, error: { code: "owner_required", message: "当前主体不允许打开本机目录。" } },
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
    const result = await openSellerSpriteProfileDirectory();
    if (result.status === "rejected") {
      return NextResponse.json(
        { ok: false, error: { code: result.code, message: result.message } },
        { status: 409, headers: noStoreHeaders },
      );
    }
    return NextResponse.json({ ok: true, data: result }, { status: 200, headers: noStoreHeaders });
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
