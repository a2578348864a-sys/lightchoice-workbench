import { NextRequest, NextResponse } from "next/server";

import { readAuth, authResponse, jsonBody, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { enrichBatchWithAmazonDetail } from "@/lib/server/batchDetailEnrichmentService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ProductBatch → Amazon Detail 批次补齐（第一阶段，仅 amazon_detail 模块）。
 * 运行级幂等：同 idempotencyKey 重放返回首次 run receipt；
 * 环境级失败（ENV_BLOCKED）为 retryable，同 key 可续跑（已补齐条目自动跳过）。
 */
export async function POST(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const body = await jsonBody(request);
    const source = body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
    const idempotencyKey = typeof source.idempotencyKey === "string" && source.idempotencyKey.trim()
      ? source.idempotencyKey
      : request.headers.get("idempotency-key") ?? "";
    const result = await enrichBatchWithAmazonDetail({
      context: auth.context,
      batchId: source.batchId ?? null,
      limit: source.limit ?? null,
      targetAsin: source.targetAsin,
      forceRecapture: source.forceRecapture === true,
      idempotencyKey,
    });
    return NextResponse.json({
      ok: true,
      receiptId: result.receiptId,
      replayed: result.replayed,
      summary: result.value.summary,
      items: result.value.items,
      timings: result.value.timings,
    });
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
