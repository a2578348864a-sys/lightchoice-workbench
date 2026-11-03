import {
  keywordReportToEvidence,
  type KeywordEvidenceV1,
} from "@/lib/server/keywordEvidence";
import {
  parseKeywordReport,
  type KeywordReportParseResult,
} from "@/lib/upstream/sellersprite/keywordReports";

export type SellerSpriteReportPlan =
  | {
    ok: true;
    evidence: KeywordEvidenceV1;
    reportType: "reverse_asin" | "keyword_mining";
    sourceRef: string;
  }
  | {
    ok: false;
    status: "human_required" | "blocked";
    errorCode: "PLUGIN_NOT_LOADED" | "PROVIDER_PERMISSION_DENIED" | "PROVIDER_QUOTA_EXHAUSTED" | "INVALID_FORMAT" | "NO_SOURCE_IN_REPO";
    reason: string;
  };

/**
 * SellerSprite 只接受人工打开的官方面板或官方导出进入此解析器。
 * 不在这里寻找 DOM、点击授权弹窗、调用付费 API 或猜测表头。
 */
export function planSellerSpriteReport(input: {
  headers: ReadonlyArray<string | null> | null;
  rows: ReadonlyArray<ReadonlyArray<string | null>> | null;
  capturedAt: string;
  sourceRef: string;
  sourceMethod?: "sellersprite_page_manual_tsv" | "sellersprite_official_xlsx";
  unavailableReason?: "plugin_not_loaded" | "permission_denied" | "quota_exhausted" | "no_source";
}): SellerSpriteReportPlan {
  if (input.unavailableReason) {
    if (input.unavailableReason === "permission_denied") {
      return { ok: false, status: "human_required", errorCode: "PROVIDER_PERMISSION_DENIED", reason: "SellerSprite 套餐或权限不足，需要人工确认。" };
    }
    if (input.unavailableReason === "quota_exhausted") {
      return { ok: false, status: "human_required", errorCode: "PROVIDER_QUOTA_EXHAUSTED", reason: "SellerSprite 额度不可用，不尝试绕过。" };
    }
    if (input.unavailableReason === "no_source") {
      return { ok: false, status: "blocked", errorCode: "NO_SOURCE_IN_REPO", reason: "当前没有可追溯的 SellerSprite 官方报表来源。" };
    }
    return { ok: false, status: "human_required", errorCode: "PLUGIN_NOT_LOADED", reason: "请人工打开 SellerSprite 面板或完成官方导出后重试。" };
  }
  if (!input.headers || !input.rows) {
    return { ok: false, status: "human_required", errorCode: "PLUGIN_NOT_LOADED", reason: "没有收到 SellerSprite 官方面板/导出数据。" };
  }
  const parsed: KeywordReportParseResult = parseKeywordReport({
    headers: input.headers,
    rows: input.rows,
    capturedAt: input.capturedAt,
  });
  if (!parsed.ok) {
    return { ok: false, status: "blocked", errorCode: "INVALID_FORMAT", reason: parsed.message };
  }
  return {
    ok: true,
    evidence: keywordReportToEvidence(parsed.report, input.capturedAt, undefined, input.sourceMethod),
    reportType: parsed.report.reportType,
    sourceRef: input.sourceRef,
  };
}
