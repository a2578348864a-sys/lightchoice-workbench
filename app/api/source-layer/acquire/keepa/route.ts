import { NextRequest, NextResponse } from "next/server";

import { isSameOriginRequest } from "@/lib/server/accessPassword";
import { requireAuthenticated } from "@/lib/server/demoGuard";
import { captureV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import { parseKeepaExport } from "@/lib/upstream/keepa/keepaExportParser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * P2-CAP-01：Keepa 导表上传入口（用户自带文件，零出站采集）。
 * 复用既有链路：parseKeepaExport（纯解析）→ captureV3ModuleEvidence（sourceType=keepa_export,
 * module=historical_trend）→ Capture Gateway → EvidenceStore。下游 unitEconomics/riskGate
 * 通过 facts.timeSeries 消费 price90dMin/buyBoxAmazonSharePercent/dealCount90d 等时序字段。
 * 非法文件 fail-closed（400，不入库）。
 */

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 50;

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (origin) return isSameOriginRequest(origin, request);
  const referer = request.headers.get("referer");
  const fetchSite = request.headers.get("sec-fetch-site");
  try {
    return referer !== null
      && isSameOriginRequest(new URL(referer).origin, request)
      && (fetchSite === null || fetchSite === "same-origin");
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  if (!sameOrigin(request)) {
    return errorResponse(403, "origin_not_allowed", "请求来源不受信任。");
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(400, "invalid_form", "请求必须是 multipart/form-data 表单。");
  }
  const file = form.get("file");
  if (!(file instanceof File)) return errorResponse(400, "file_required", "请选择 Keepa 导出文件（CSV）。");
  if (file.size === 0) return errorResponse(400, "file_empty", "上传文件为空。");
  if (file.size > MAX_UPLOAD_BYTES) return errorResponse(413, "file_too_large", "文件超过 5MB 上限，请拆分导表。");
  const marketplace = String(form.get("marketplace") ?? "US").trim().toUpperCase() || "US";
  if (!/^[A-Z]{2}$/.test(marketplace)) return errorResponse(400, "marketplace_invalid", "市场代码无效（两位字母，如 US）。");

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const parsed = parseKeepaExport(fileBytes);
  if (!parsed.ok || parsed.rows.length === 0) {
    return errorResponse(400, "keepa_export_invalid", `导表解析失败（fail-closed，未入库）：${parsed.errors.slice(0, 3).join("；") || "没有可识别的 Keepa 数据行"}`);
  }
  const researchScanId = String(form.get("researchScanId") ?? "").trim();
  if (researchScanId) {
    // Validate the whole file before the first write: an 02 import may not expand its formal sample.
    try {
      const { getMarketIntelligence } = await import("@/lib/server/marketIntelligenceService");
      const study = await getMarketIntelligence({ context: auth.context, scanId: researchScanId });
      if (study.marketplace !== marketplace || parsed.rows.some(row => !study.statistics?.subjects.includes(`amazon:${marketplace}:${row.asin}`))) {
        return errorResponse(422, "keepa_research_scope_mismatch", "文件包含当前正式研究之外的商品或站点，未写入任何行。请仅导出本研究的商品。");
      }
    } catch {
      return errorResponse(422, "keepa_research_unavailable", "无法确认当前研究范围，未写入任何行。");
    }
  }
  const rows = parsed.rows.slice(0, MAX_ROWS);

  const imported: Array<{ asin: string; subjectKey: string; metrics: Record<string, unknown> }> = [];
  const failed: Array<{ asin: string; reason: string }> = [];
  const seenAsins = new Set<string>();
  for (const row of rows) {
    const asin = String(row.asin ?? "").toUpperCase();
    const subjectKey = `amazon:${marketplace}:${asin}`;
    if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) {
      failed.push({ asin, reason: "ASIN 缺失或格式无效" });
      continue;
    }
    if (seenAsins.has(asin)) {
      failed.push({ asin, reason: "同一导表内 ASIN 重复，已拒绝重复写入" });
      continue;
    }
    seenAsins.add(asin);
    try {
      const result = await captureV3ModuleEvidence({
        context: auth.context,
        sourceType: "keepa_export",
        sourceFingerprint: parsed.sourceFileSha256,
        moduleEvidence: {
          module: "historical_trend",
          subjectKey,
          marketplace,
          capturedAt: new Date().toISOString(),
          provider: "keepa_product_viewer",
          sourceSurface: "keepa-csv-export",
          acquisitionMode: "FILE_EXPORT",
          metricNature: "provider_observed",
          status: "VALIDATED_AVAILABLE",
          limitations: [
            "Keepa 导表为用户自带文件；系统校验结构、ASIN 与字段映射，但不独立验证文件来源或是否被编辑。指标为导出时的历史快照/统计，非实时数据。",
            "Evidence 保留本行原始字段与整份源文件 SHA-256，不保存整份上传文件；复核需使用用户保留的原始导表。",
          ],
          identity: { asin },
          data: {
            timeSeries: row.metrics,
            rawSourceRow: row.rawRow,
            sourceFileSha256: parsed.sourceFileSha256,
          },
          evidenceOnly: false,
        },
      });
      imported.push({ asin, subjectKey, metrics: result.moduleEvidence.data });
    } catch (error) {
      failed.push({ asin, reason: error instanceof Error ? error.message : "入库失败" });
    }
  }

  return NextResponse.json({
    ok: true,
    data: {
      importedCount: imported.length,
      failedCount: failed.length,
      imported,
      failed,
      quarantinedCount: Math.max(0, parsed.totalRows - parsed.acceptedRows),
      omittedByBudgetCount: Math.max(0, parsed.acceptedRows - rows.length),
      sourceFileSha256: parsed.sourceFileSha256,
    },
  }, { status: 200 });
}
