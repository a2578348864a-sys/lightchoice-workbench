import { NextRequest, NextResponse } from "next/server";

import {
  MarketScanServiceError,
  getMarketScan,
} from "@/lib/server/marketScanService";
import { marketScanAction } from "@/lib/server/v5MarketService";
import { requireIdempotencyKey, V5CoreError } from "@/lib/server/v5CoreCommon";
import { v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { resolveMarketScanImageRef } from "@/lib/server/marketScanImage";
import { requireAuthenticated } from "@/lib/server/demoGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/**
 * GET /api/market-scans/[id]
 *
 * 只读回放已锁定的样本快照与指标结果：刷新页面后必须完全恢复，
 * 且不得因证据库后续变化而重算历史结果。
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  if (auth.context.mode !== "owner") {
    return errorResponse(403, "market_scan_owner_only", "市场扫描目前只对 Owner 开放。");
  }
  const { id } = await context.params;
  try {
    const record = await getMarketScan({ context: auth.context, id });
    if (!record) return errorResponse(404, "market_scan_not_found", "没有找到该市场扫描。");
    const sampleItems = await Promise.all(record.sampleSnapshot.items.map(async (item) => ({
      asin: item.asin,
      subjectKey: item.subjectKey,
      candidateId: item.candidateId,
      productFactFingerprint: item.productFactFingerprint,
      sourceProofHash: item.sourceProofHash,
      evidenceId: item.evidenceId,
      evidenceVersion: item.evidenceVersion,
      capturedAt: item.capturedAt,
      sourceType: item.sourceType,
      dedupeOf: item.dedupeOf,
      imageUrl: await resolveMarketScanImageRef(item.imageRef),
      title: item.factValues.title.presence === "present" ? item.factValues.title.value : null,
      factValues: item.factValues,
    })));
    return NextResponse.json({
      ok: true,
      data: {
        id: record.id,
        scanName: record.scanName,
        marketplace: record.marketplace,
        nicheDefinition: record.nicheDefinition,
        sampleDefinition: record.sampleDefinition,
        sampleCount: record.sampleCount,
        metricsVersion: record.metricsVersion,
        sampleHash: record.sampleHash,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        sampleItems,
        metrics: record.metrics,
        scopeNotice: "统计结果基于当前市场扫描锁定的商品样本，不代表 Amazon 整体市场。",
      },
    });
  } catch (error) {
    if (error instanceof MarketScanServiceError) {
      return errorResponse(error.httpStatus, error.code, error.message);
    }
    return errorResponse(500, "market_scan_failed", "读取市场扫描失败，请稍后重试。");
  }
}

/**
 * DELETE /api/market-scans/[id]
 *
 * 经过生命周期安全审计的删除入口：若已有 NicheOpportunity 引用，409 Conflict 拒绝并保护证据链。
 */
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  if (auth.context.mode !== "owner") {
    return errorResponse(403, "market_scan_owner_only", "市场扫描删除目前只对 Owner 开放。");
  }
  if (!sameOrigin(request)) {
    return errorResponse(403, "origin_not_allowed", "请求来源不受信任。");
  }

  const { id } = await context.params;
  try {
    let body: Record<string, unknown> = {};
    try {
      const parsed = await request.json() as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      // DELETE requests from old clients may have no body; the V5 contract error below is explicit.
    }
    const expectedVersion = body.expectedVersion ?? new URL(request.url).searchParams.get("expectedVersion");
    const headerKey = request.headers.get("Idempotency-Key") ?? body.idempotencyKey;
    const data = await marketScanAction({
      context: auth.context,
      scanId: id,
      action: "delete",
      expectedVersion,
      expectedEvidenceBinding: body.expectedEvidenceBinding,
      idempotencyKey: requireIdempotencyKey(headerKey),
    });
    return NextResponse.json({
      ok: true,
      data: { ...data, compatibility: "legacy", missingCapabilities: [] },
    });
  } catch (error) {
    if (error instanceof V5CoreError) return v5ErrorResponse(error);
    return errorResponse(500, "market_scan_delete_failed", "删除市场扫描失败，请稍后重试。");
  }
}
