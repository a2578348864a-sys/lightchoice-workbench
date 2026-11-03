export type AmazonDetailBatchItemStatus = "enriched" | "captured_partial" | null | undefined;

export type AmazonDetailBatchStatusSummary = {
  total: number;
  complete: number;
  partial: number;
  pending: number;
  unknown: number;
  evidenceBacked: number;
  completePercent: number;
  canContinue: boolean;
  disabledReason: string | null;
};

/**
 * Derive the Source-page detail status from the existing ProductBatchItem
 * enrichment projection. Unknown values fail closed and are never counted as
 * successful or retryable.
 */
export function summarizeAmazonDetailBatchStatus(
  items: readonly { enrichmentStatus?: unknown }[],
  batchStatus: string | null | undefined,
): AmazonDetailBatchStatusSummary {
  let complete = 0;
  let partial = 0;
  let pending = 0;
  let unknown = 0;

  for (const item of items) {
    if (item.enrichmentStatus === "enriched") complete += 1;
    else if (item.enrichmentStatus === "captured_partial") partial += 1;
    else if (item.enrichmentStatus == null) pending += 1;
    else unknown += 1;
  }

  const total = items.length;
  const canContinue = batchStatus === "ready" && total > 0 && pending > 0 && unknown === 0;
  let disabledReason: string | null = null;

  if (batchStatus !== "ready") {
    disabledReason = "批次当前未就绪，不能开始详情补齐。";
  } else if (unknown > 0) {
    disabledReason = `${unknown} 条商品的详情状态无法识别；请重新读取后再判断。`;
  } else if (total === 0) {
    disabledReason = "当前批次没有可处理的商品。";
  } else if (pending === 0 && partial > 0) {
    disabledReason = "没有待补齐条目；部分完成的商品不会通过此入口自动重采。";
  } else if (pending === 0) {
    disabledReason = "本批次商品的详情均已完整补齐。";
  }

  return {
    total,
    complete,
    partial,
    pending,
    unknown,
    evidenceBacked: complete + partial,
    completePercent: total === 0 ? 0 : Math.round((complete / total) * 100),
    canContinue,
    disabledReason,
  };
}
