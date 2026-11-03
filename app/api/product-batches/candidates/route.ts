import { isTrustedWriteRequest as sameOrigin } from "@/lib/server/accessPassword";
import { NextRequest, NextResponse } from "next/server";

import { requireAuthenticated } from "@/lib/server/demoGuard";
import {
  convertProductBatchItemToCandidate,
  ProductBatchCandidateConversionError,
} from "@/lib/server/productBatchCandidateService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}



function conversionStatus(code: ProductBatchCandidateConversionError["code"]): number {
  if (code === "product_batch_item_id_invalid") return 400;
  if (code === "product_batch_item_not_found") return 404;
  return 409;
}

export async function POST(request: NextRequest) {
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
  if (typeof body !== "object"
    || body === null
    || Array.isArray(body)
    || Object.keys(body).length !== 1
    || typeof (body as { productBatchItemId?: unknown }).productBatchItemId !== "string"
    || !(body as { productBatchItemId: string }).productBatchItemId.trim()) {
    return errorResponse(
      400,
      "invalid_product_batch_candidate_request",
      "只能提交 productBatchItemId。",
    );
  }
  try {
    const result = await convertProductBatchItemToCandidate(
      auth.context,
      (body as { productBatchItemId: string }).productBatchItemId.trim(),
    );
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    if (error instanceof ProductBatchCandidateConversionError) {
      return errorResponse(conversionStatus(error.code), error.code, error.message);
    }
    return errorResponse(
      500,
      "product_batch_candidate_conversion_failed",
      "创建商品研究 Candidate 失败。",
    );
  }
}
