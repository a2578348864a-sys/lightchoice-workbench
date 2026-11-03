import { isTrustedWriteRequest as sameOrigin } from "@/lib/server/accessPassword";
import { NextRequest, NextResponse } from "next/server";

import { requireAuthenticated } from "@/lib/server/demoGuard";
import { getProductBatchStore } from "@/lib/server/productBatchStoreResolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}



export async function PATCH(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  if (!sameOrigin(request)) {
    return errorResponse(403, "origin_not_allowed", "请求来源不受信任。");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_request", "请求内容无效。");
  }
  if (
    typeof body !== "object"
    || body === null
    || Array.isArray(body)
    || Object.keys(body).sort().join(",") !== "action,registrationId"
    || (body as { action?: unknown }).action !== "activate_legacy"
    || typeof (body as { registrationId?: unknown }).registrationId !== "string"
  ) {
    return errorResponse(400, "invalid_action", "Legacy 选择操作无效。");
  }
  try {
    const store = getProductBatchStore(auth.context);
    const selection = await store.activateLegacy(
      (body as { registrationId: string }).registrationId,
    );
    return NextResponse.json({ ok: true, data: { selection } });
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? String((error as { code: unknown }).code)
      : "product_batch_internal_error";
    return errorResponse(
      code === "legacy_registration_not_found" ? 404 : 500,
      code,
      "Legacy 批次不可用。",
    );
  }
}
