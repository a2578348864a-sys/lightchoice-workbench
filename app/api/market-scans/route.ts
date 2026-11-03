import { NextRequest, NextResponse } from "next/server";

import "@/lib/sourceLayer/adapters";
import {
  MARKET_SCAN_MAX_SAMPLE_ITEMS,
  MarketScanServiceError,
  createMarketScan,
  listMarketScans,
  type CreateMarketScanInput,
} from "@/lib/server/marketScanService";
import type { MarketScanRecordView } from "@/lib/server/marketScanRepository";
import { requireAuthenticated, requireOwnerOnly } from "@/lib/server/demoGuard";
import {
  NICHE_DEFINITION_KINDS,
  type NicheDefinitionKind,
} from "@/lib/marketScan/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRODUCT_BATCH_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const SUBJECT_KEY_PATTERN = /^[A-Za-z0-9:._\-|@]{1,160}$/u;
const NICHE_KINDS = new Set<string>(NICHE_DEFINITION_KINDS);

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function serviceErrorResponse(error: MarketScanServiceError) {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.detailCode ? { detailCode: error.detailCode } : {}),
      },
    },
    { status: error.httpStatus },
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

/**
 * MarketScan 的对外投影。只暴露扫描结果本身；
 * 缺失一律显式为 `NOT_AVAILABLE` / `null`，绝不用 0 顶替。
 */
function toApiView(record: MarketScanRecordView) {
  return {
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
    sampleItems: record.sampleSnapshot.items.map((item) => ({
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
    })),
    metrics: record.metrics,
    /** 明确声明样本范围，避免被读成 Amazon 整体市场。 */
    scopeNotice: "统计结果基于当前 MarketScan 锁定的商品样本，不代表 Amazon 整体市场。",
  };
}

/**
 * GET /api/market-scans
 * 列出最近的市场扫描（Owner-only 读取，沿用既有 owner 架构）。
 */
export async function GET(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  if (auth.context.mode !== "owner") {
    return errorResponse(403, "market_scan_owner_only", "市场扫描目前只对 Owner 开放。");
  }
  const rawLimit = new URL(request.url).searchParams.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
      return errorResponse(400, "limit_invalid", "limit 必须是 1 到 100 之间的整数。");
    }
    limit = parsed;
  }
  try {
    const records = await listMarketScans({
      context: auth.context,
      ...(limit === undefined ? {} : { limit }),
    });
    return NextResponse.json({
      ok: true,
      data: {
        schemaVersion: "market-scan-list.v1",
        items: records.map(toApiView),
      },
    });
  } catch (error) {
    if (error instanceof MarketScanServiceError) return serviceErrorResponse(error);
    return errorResponse(500, "market_scan_failed", "读取市场扫描失败，请稍后重试。");
  }
}

/**
 * POST /api/market-scans
 *
 * body: {
 *   scanName, marketplace,
 *   niche: { kind, label, notes?, parameters? },
 *   sample?: { subjectKeys?, evidenceVersions?, sourceTypes?, productBatchId?, requestedLimit?, observedAt? }
 * }
 *
 * 硬边界：只读已存在的 Evidence，不采集、不写证据、不建 Candidate、不建 Task、
 * 不跑 Research、不调用 AI。唯一写操作是最后单行写入 MarketScan。
 */
export async function POST(request: NextRequest) {
  const auth = requireOwnerOnly(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  if (!sameOrigin(request)) {
    return errorResponse(403, "origin_not_allowed", "请求来源不受信任。");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "market_scan_invalid_request", "请求体必须是 JSON。");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse(400, "market_scan_invalid_request", "请求体必须是 JSON 对象。");
  }
  const payload = body as Record<string, unknown>;

  const scanName = typeof payload.scanName === "string" ? payload.scanName : "";
  if (!scanName.trim()) {
    return errorResponse(400, "market_scan_invalid_request", "请填写扫描名称。");
  }
  const marketplace = typeof payload.marketplace === "string" && payload.marketplace.trim()
    ? payload.marketplace.trim()
    : "US";

  const nicheRaw = payload.niche;
  if (typeof nicheRaw !== "object" || nicheRaw === null || Array.isArray(nicheRaw)) {
    return errorResponse(400, "market_scan_invalid_request", "缺少 Niche 定义。");
  }
  const niche = nicheRaw as Record<string, unknown>;
  if (typeof niche.kind !== "string" || !NICHE_KINDS.has(niche.kind)) {
    return errorResponse(400, "market_scan_invalid_request", "Niche 类型不受支持。");
  }
  const nicheLabel = typeof niche.label === "string" && niche.label.trim()
    ? niche.label.trim()
    : scanName.trim();
  let nicheParameters: Record<string, string | number | boolean | null> | null = null;
  if (niche.parameters !== undefined && niche.parameters !== null) {
    if (typeof niche.parameters !== "object" || Array.isArray(niche.parameters)) {
      return errorResponse(400, "market_scan_invalid_request", "Niche 参数必须是对象。");
    }
    nicheParameters = {};
    for (const [key, raw] of Object.entries(niche.parameters as Record<string, unknown>)) {
      if (raw === null || typeof raw === "string" || typeof raw === "boolean") {
        nicheParameters[key] = raw;
      } else if (typeof raw === "number" && Number.isFinite(raw)) {
        nicheParameters[key] = raw;
      } else {
        return errorResponse(400, "market_scan_invalid_request", "Niche 参数只允许标量。");
      }
    }
  }

  const sampleRaw = payload.sample;
  let subjectKeys: string[] | null = null;
  let evidenceVersions: Record<string, number> | null = null;
  let productBatchId: string | null = null;
  let requestedLimit: number | null = null;
  let observedAt: string | null = null;
  let sourceTypes: string[] | null = null;
  if (sampleRaw !== undefined && sampleRaw !== null) {
    if (typeof sampleRaw !== "object" || Array.isArray(sampleRaw)) {
      return errorResponse(400, "market_scan_invalid_request", "sample 必须是对象。");
    }
    const sample = sampleRaw as Record<string, unknown>;
    if (sample.subjectKeys !== undefined && sample.subjectKeys !== null) {
      if (!Array.isArray(sample.subjectKeys)) {
        return errorResponse(400, "market_scan_invalid_request", "subjectKeys 必须是数组。");
      }
      if (sample.subjectKeys.length > MARKET_SCAN_MAX_SAMPLE_ITEMS) {
        return errorResponse(422, "market_scan_sample_too_large", "样本数量超出上限。");
      }
      subjectKeys = [];
      for (const raw of sample.subjectKeys) {
        if (typeof raw !== "string" || !SUBJECT_KEY_PATTERN.test(raw.trim())) {
          return errorResponse(400, "market_scan_invalid_request", "subjectKey 不合法。");
        }
        subjectKeys.push(raw.trim());
      }
    }
    if (sample.evidenceVersions !== undefined && sample.evidenceVersions !== null) {
      if (typeof sample.evidenceVersions !== "object" || Array.isArray(sample.evidenceVersions)) {
        return errorResponse(400, "market_scan_invalid_request", "evidenceVersions 必须是对象。");
      }
      evidenceVersions = {};
      for (const [key, raw] of Object.entries(sample.evidenceVersions as Record<string, unknown>)) {
        if (!SUBJECT_KEY_PATTERN.test(key) || !Number.isSafeInteger(raw) || (raw as number) < 1) {
          return errorResponse(400, "market_scan_invalid_request", "evidenceVersions 不合法。");
        }
        evidenceVersions[key] = raw as number;
      }
    }
    if (sample.productBatchId !== undefined && sample.productBatchId !== null) {
      if (typeof sample.productBatchId !== "string"
        || !PRODUCT_BATCH_ID_PATTERN.test(sample.productBatchId.trim())) {
        return errorResponse(400, "market_scan_invalid_request", "productBatchId 不合法。");
      }
      productBatchId = sample.productBatchId.trim();
    }
    if (sample.requestedLimit !== undefined && sample.requestedLimit !== null) {
      if (!Number.isSafeInteger(sample.requestedLimit) || (sample.requestedLimit as number) < 1
        || (sample.requestedLimit as number) > MARKET_SCAN_MAX_SAMPLE_ITEMS) {
        return errorResponse(400, "market_scan_invalid_request", "requestedLimit 不合法。");
      }
      requestedLimit = sample.requestedLimit as number;
    }
    if (sample.observedAt !== undefined && sample.observedAt !== null) {
      if (typeof sample.observedAt !== "string"
        || Number.isNaN(Date.parse(sample.observedAt))) {
        return errorResponse(400, "market_scan_invalid_request", "observedAt 不合法。");
      }
      observedAt = new Date(sample.observedAt).toISOString();
    }
    if (sample.sourceTypes !== undefined && sample.sourceTypes !== null) {
      if (!Array.isArray(sample.sourceTypes)) {
        return errorResponse(400, "market_scan_invalid_request", "sourceTypes 必须是数组。");
      }
      sourceTypes = [];
      for (const raw of sample.sourceTypes) {
        if (raw !== "sellersprite_xlsx" && raw !== "sellersprite_plugin"
          && raw !== "amazon_dom" && raw !== "manual") {
          return errorResponse(400, "market_scan_invalid_request", "sourceTypes 含不支持的来源。");
        }
        sourceTypes.push(raw);
      }
    }
  }

  try {
    const record = await createMarketScan({
      context: auth.context,
      scanName: scanName.trim(),
      marketplace,
      nicheKind: niche.kind as NicheDefinitionKind,
      nicheLabel,
      nicheNotes: typeof niche.notes === "string" ? niche.notes : null,
      nicheParameters,
      subjectKeys,
      evidenceVersions,
      sourceTypes: sourceTypes as CreateMarketScanInput["sourceTypes"],
      productBatchId,
      requestedLimit,
      observedAt,
    });
    return NextResponse.json(
      { ok: true, data: toApiView(record) },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof MarketScanServiceError) return serviceErrorResponse(error);
    // 非契约错误不在响应体里泄露细节，但必须留在服务端日志中以便定位。
    console.error("[market-scans] create failed", error);
    return errorResponse(500, "market_scan_failed", "创建市场扫描失败，请稍后重试。");
  }
}
