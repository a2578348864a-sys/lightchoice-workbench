import { NextRequest, NextResponse } from "next/server";

import "@/lib/sourceLayer/adapters";
import { requireAuthenticated } from "@/lib/server/demoGuard";
import {
  SOURCE_LAYER_INGEST_SCHEMA,
  SourceLayerServiceError,
  sourceLayerOperator,
} from "@/lib/sourceLayer/server/sourceLayerService";
import { captureProductBatchThroughGateway } from "@/lib/sourceLayer/server/captureGateway";
import { recordCaptureApiDiagnostic } from "@/lib/sourceLayer/server/diagnosticService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRODUCT_BATCH_ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function sameOrigin(request: NextRequest): boolean {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  let expected = url.origin;
  if (host !== null) {
    try {
      expected = new URL(`${url.protocol}//${host}`).origin;
    } catch {
      return false;
    }
  }
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === expected;
  const referer = request.headers.get("referer");
  const fetchSite = request.headers.get("sec-fetch-site");
  try {
    return referer !== null
      && new URL(referer).origin === expected
      && (fetchSite === null || fetchSite === "same-origin");
  } catch {
    return false;
  }
}

/**
 * POST /api/source-layer/from-product-batch
 *
 * 把当前商品批次中的商品接入统一来源证据（只读桥接，不重新采集、不修改批次）。
 * body: { productBatchItemId?: string }  —— 缺省时接入当前批次内全部商品（有上限）。
 */
export async function POST(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  if (!sameOrigin(request)) {
    return errorResponse(403, "origin_not_allowed", "请求来源不受信任。");
  }
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // 允许空请求体：表示接入当前批次全部商品。
    body = {};
  }
  const rawItemId = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as { productBatchItemId?: unknown }).productBatchItemId
    : undefined;
  if (rawItemId !== undefined && rawItemId !== null) {
    if (typeof rawItemId !== "string" || !PRODUCT_BATCH_ITEM_ID_PATTERN.test(rawItemId.trim())) {
      return errorResponse(400, "product_batch_item_id_invalid", "商品批次条目标识无效。");
    }
  }
  const productBatchItemId = typeof rawItemId === "string" ? rawItemId.trim() : undefined;

  try {
    const gatewayResult = await captureProductBatchThroughGateway({
      context: auth.context,
      ...(productBatchItemId ? { productBatchItemId } : {}),
    });
    const result = gatewayResult.capture;
    const firstItem = result.items[0] ?? null;
    await recordCaptureApiDiagnostic({
      context: auth.context,
      traceId: gatewayResult.traceId,
      sourceType: gatewayResult.source,
      subjectKey: firstItem?.subjectKey ?? null,
      captureId: firstItem?.captureId ?? null,
      evidenceRefs: result.items.map((item) => `${item.subjectKey}:v${item.version}`),
      contentHash: firstItem?.contentHash ?? null,
      status: "succeeded",
      reason: "Product Batch bridge API completed after Capture Gateway persistence.",
    }).catch(() => undefined);
    // 与 /api/source-layer/ingest 返回同一形状（外加批次归属信息），
    // 使 UI 与审计报告可以复用同一套展示与断言，不必学两套结构。
    return NextResponse.json({
      ok: true,
      data: {
        schemaVersion: SOURCE_LAYER_INGEST_SCHEMA,
        operator: sourceLayerOperator(auth.context),
        sourceType: "sellersprite_xlsx" as const,
        adapterLabel: "SellerSprite 导出报表",
        capturedAt: result.items[0]?.auditTail[0]?.timestamp ?? new Date().toISOString(),
        pageDigest: `product_batch;batchId=${result.productBatchId};requested=${result.requestedItemIds.length}`,
        totalDrafts: result.requestedItemIds.length,
        quarantinedCount: result.skippedItemIds.length,
        readyCount: result.readyCount,
        reviewCount: result.reviewCount,
        blockedCount: result.blockedCount,
        captureErrorCodes: [],
        items: result.items,
        errors: result.errors,
        productBatchId: result.productBatchId,
        batchName: result.batchName,
        skippedItemIds: result.skippedItemIds,
        gatewaySource: gatewayResult.source,
        traceId: gatewayResult.traceId,
        productFactCount: gatewayResult.productFacts.length,
        qualityGate: gatewayResult.qualityGate,
      },
    });
  } catch (error) {
    if (error instanceof SourceLayerServiceError) {
      const status = error.code === "no_capturable_records" ? 422 : 409;
      return errorResponse(status, error.code, error.message);
    }
    const code = error instanceof Error && "code" in error
      ? String((error as { code: unknown }).code)
      : "source_layer_bridge_failed";
    return errorResponse(500, code, "从商品批次接入来源证据失败，请稍后重试。");
  }
}
