/**
 * 商品卡「采集状态/完整度」展示助手（presentation-only）。
 *
 * 状态全部从现有数据派生（itemView 已投影的字段）：
 * - Amazon 搜索：条目本身来自搜索采集批次（有证据引用即视为已采集）。
 * - Amazon 详情：enrichmentStatus 来自条目 normalizedProductJson 的 enrichment 块
 *   （Detail Enrichment Worker 写入）—— enriched=已采集 / captured_partial=部分完成 /
 *   无块=未采集。绝不从 brand/bsr 反推，避免把导入批次或字段缺失误判为采集状态。
 * - 品牌 / BSR：字段有值=有，null=缺失（诚实空态，不推断）。
 */

export type CaptureStatusTone = "ok" | "partial" | "missing";

export type CaptureStatusBadge = {
  key: "search" | "detail" | "brand" | "bsr";
  label: string;
  tone: CaptureStatusTone;
};

export type CaptureStatusInput = {
  /**
   * Amazon 搜索采集判定：由调用方从**批次级** `sourceType === "amazon_search_capture"` 传入。
   * 不使用条目侧 asin/evidenceRefs 判定——卖家精灵导入/证据提档批次的条目同样有 ASIN 与证据，
   * 按 ASIN 判定会把非 Amazon 搜索来源误标为「Amazon 搜索 ✓」。
   */
  searchCaptured?: boolean;
  brand?: string | null;
  bsr?: { rank?: number | null } | null;
  /** 来自 itemView 的 enrichment 块状态；未补齐的条目为 null。 */
  enrichmentStatus?: string | null;
};

export type AmazonDetailBatchStatus = {
  evidenceLabel: string;
  batchLabel: string;
};

export function describeAmazonDetailBatchStatus(input: {
  currentBatchStatus?: "enriched" | "captured_partial" | null;
  captureOrigin?: "CAPTURED_NOW" | "REUSED_VALID_EVIDENCE" | null;
  hasUnlinkedDetailEvidence?: boolean;
  evidenceCapturedAt?: string | null;
  batchCreatedAt?: string | null;
}): AmazonDetailBatchStatus {
  if (input.currentBatchStatus === "enriched" || input.currentBatchStatus === "captured_partial") {
    const evidenceLabel = input.captureOrigin === "CAPTURED_NOW"
      ? "本次采集并关联"
      : input.captureOrigin === "REUSED_VALID_EVIDENCE"
        ? "复用有效证据并关联"
        : "已关联到当前批次";
    return {
      evidenceLabel,
      batchLabel: input.currentBatchStatus === "enriched" ? "已补齐" : "部分完成",
    };
  }

  const evidenceTime = input.evidenceCapturedAt ? Date.parse(input.evidenceCapturedAt) : Number.NaN;
  const batchTime = input.batchCreatedAt ? Date.parse(input.batchCreatedAt) : Number.NaN;
  const historical = input.hasUnlinkedDetailEvidence === true
    && Number.isFinite(evidenceTime)
    && Number.isFinite(batchTime)
    && evidenceTime < batchTime;
  return {
    evidenceLabel: historical
      ? "已有历史详情证据"
      : input.hasUnlinkedDetailEvidence
        ? "已有详情证据，尚未关联当前批次"
        : "暂无可信详情证据",
    batchLabel: "待补齐",
  };
}

export function deriveCaptureStatusBadges(input: CaptureStatusInput): CaptureStatusBadge[] {
  const badges: CaptureStatusBadge[] = [
    input.searchCaptured
      ? { key: "search", label: "Amazon 搜索 ✓", tone: "ok" }
      : { key: "search", label: "Amazon 搜索 未采集", tone: "missing" },
  ];

  if (input.enrichmentStatus === "enriched") {
    badges.push({ key: "detail", label: "当前批次详情 ✓", tone: "ok" });
  } else if (input.enrichmentStatus === "captured_partial") {
    badges.push({ key: "detail", label: "当前批次详情 部分完成", tone: "partial" });
  } else {
    badges.push({ key: "detail", label: "当前批次详情 待补齐", tone: "missing" });
  }

  badges.push(
    input.brand
      ? { key: "brand", label: "品牌 ✓", tone: "ok" }
      : { key: "brand", label: "品牌 缺失", tone: "missing" },
  );
  badges.push(
    input.bsr && input.bsr.rank != null
      ? { key: "bsr", label: "BSR ✓", tone: "ok" }
      : { key: "bsr", label: "BSR 缺失", tone: "missing" },
  );
  return badges;
}

/** 画廊级完整度统计（纯客户端派生，不新增任何数据库字段）。 */
export type CaptureCompletenessSummary = {
  total: number;
  detailEnriched: number;
  detailPartial: number;
  detailPending: number;
  brandHit: number;
  bsrHit: number;
};

export function summarizeCaptureCompleteness(
  items: ReadonlyArray<CaptureStatusInput>,
): CaptureCompletenessSummary {
  const total = items.length;
  const detailEnriched = items.filter((item) => item.enrichmentStatus === "enriched").length;
  const detailPartial = items.filter((item) => item.enrichmentStatus === "captured_partial").length;
  return {
    total,
    detailEnriched,
    detailPartial,
    detailPending: total - detailEnriched - detailPartial,
    brandHit: items.filter((item) => Boolean(item.brand)).length,
    bsrHit: items.filter((item) => item.bsr && item.bsr.rank != null).length,
  };
}
