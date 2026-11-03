import { NextRequest, NextResponse } from "next/server";

import { captureProductBatchThroughGateway } from "@/lib/sourceLayer/server/captureGateway";
import { getProductBatchStore } from "@/lib/server/productBatchStoreResolver";
import { requireOwnerOnly } from "@/lib/server/demoGuard";
import {
  COMMODITY_SUBJECT_KEY_PATTERN,
  syncBatchCommodityFacts,
} from "@/lib/integrations/lark/batchCommoditySync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BATCH_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function errorResponse(status: number, code: string, message: string, data?: unknown) {
  return NextResponse.json(
    { ok: false, error: { code, message }, ...(data === undefined ? {} : { data }) },
    { status },
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * POST /api/feishu-sync/batch-commodities
 *
 * 读取指定 Owner ProductBatch，经既有 Capture Gateway 投影到同一个
 * EvidenceStore/ProductFact 链路，再单向写入飞书商品池。接口不接受事实行，
 * 客户端不能绕过服务端直接构造飞书写入内容。
 */
export async function POST(request: NextRequest) {
  const auth = requireOwnerOnly(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  if (!sameOrigin(request)) return errorResponse(403, "origin_not_allowed", "请求来源不受信任。");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "请求体必须是 JSON。 ");
  }
  if (!isRecord(body)) return errorResponse(400, "invalid_body", "请求体必须是对象。 ");

  const batchId = typeof body.batchId === "string" ? body.batchId.trim() : "";
  if (!BATCH_ID_PATTERN.test(batchId)) {
    return errorResponse(400, "batch_id_invalid", "batchId 无效。 ");
  }

  const rawClientToken = body.clientToken ?? body.client_token;
  const clientToken = rawClientToken === undefined || rawClientToken === null
    ? undefined
    : typeof rawClientToken === "string" ? rawClientToken.trim() : null;
  if (clientToken !== undefined && (clientToken === null || !UUID_V4_PATTERN.test(clientToken))) {
    return errorResponse(400, "client_token_invalid", "client_token 必须是 UUIDv4。 ");
  }

  try {
    const store = getProductBatchStore(auth.context);
    const batch = await store.getBatch(batchId);
    if (!batch) return errorResponse(404, "batch_not_found", "商品批次不存在。 ");
    if (batch.batchStatus !== "ready") {
      return errorResponse(409, "product_batch_not_ready", "商品批次尚未就绪，不能推送商品池。 ");
    }

    const gateway = await captureProductBatchThroughGateway({
      context: auth.context,
      productBatchId: batch.id,
    });
    if (gateway.capture.productBatchId !== batch.id) {
      return errorResponse(409, "batch_identity_mismatch", "来源桥接返回的批次身份与请求不一致。 ");
    }
    if (gateway.productFacts.length === 0) {
      return errorResponse(422, "product_fact_missing", "该批次没有可同步的 ProductFact。 ");
    }
    if (gateway.productFacts.some((fact) => !COMMODITY_SUBJECT_KEY_PATTERN.test(fact.subjectKey))) {
      return errorResponse(422, "subject_key_invalid", "批次包含不符合 subjectKey 契约的商品，已拒绝整批同步。 ");
    }

    const result = await syncBatchCommodityFacts(gateway.productFacts, {
      baseUrl: new URL(request.url).origin,
      qualityStatus: batch.dataQualityStatus,
      ...(clientToken ? { requestClientToken: clientToken } : {}),
    });
    const data = {
      batchId: batch.id,
      batchName: batch.batchName,
      productFactCount: gateway.productFacts.length,
      ...result,
    };
    if (result.failedCount > 0) {
      return errorResponse(502, "FEISHU_SYNC_FAILED", "商品池同步存在失败项；工作台事实未回滚。", data);
    }
    if (result.conflictCount > 0) {
      return errorResponse(409, "FEISHU_SUBJECT_KEY_CONFLICT", "飞书商品池存在重复 subjectKey，冲突项已 fail-closed。", data);
    }
    return NextResponse.json({
      ok: true,
      data,
    });
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? String((error as { code: unknown }).code)
      : "FEISHU_BATCH_COMMODITY_SYNC_FAILED";
    return errorResponse(500, code, "批量商品池同步失败；工作台事实未回滚。 ");
  }
}
