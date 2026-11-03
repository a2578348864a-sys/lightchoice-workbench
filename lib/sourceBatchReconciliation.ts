export type SourceBatchCountReconciliation = {
  status: "matched" | "mismatch" | "unavailable";
  acceptedCount: number | null;
  detailCount: number | null;
  difference: number | null;
};

export function reconcileSourceBatchItemCounts(
  acceptedCount: number | null | undefined,
  detailCount: number | null | undefined,
): SourceBatchCountReconciliation {
  if (
    typeof acceptedCount !== "number" || !Number.isSafeInteger(acceptedCount) || acceptedCount < 0
    || typeof detailCount !== "number" || !Number.isSafeInteger(detailCount) || detailCount < 0
  ) {
    return { status: "unavailable", acceptedCount: null, detailCount: null, difference: null };
  }

  const difference = Math.abs(acceptedCount - detailCount);
  return {
    status: difference === 0 ? "matched" : "mismatch",
    acceptedCount,
    detailCount,
    difference,
  };
}

export type SourceBatchQualityTone = "emerald" | "amber" | "slate" | "rose";

export type SourceBatchQualityPresentation = {
  text: string;
  tone: SourceBatchQualityTone;
  isReconciliationMismatch?: boolean;
};

export function sourceBatchQualityPresentation(
  dataQualityStatus: string | null | undefined,
  options?: {
    itemCount?: number | null;
    reconciliation?: SourceBatchCountReconciliation | null;
  },
): SourceBatchQualityPresentation {
  const itemCount = options?.itemCount ?? null;
  const reconciliation = options?.reconciliation ?? null;

  // 1. Zero-item batches must never display "质检通过"
  if (itemCount === 0) {
    return {
      text: "空批次 / 待补充",
      tone: "slate",
    };
  }

  // 2. Count reconciliation mismatch / unverified items > 0 must never display "质检通过"
  if (reconciliation && reconciliation.difference !== null && reconciliation.difference > 0) {
    return {
      text: "批次需核对",
      tone: "amber",
      isReconciliationMismatch: true,
    };
  }

  // 3. Standard status mapping
  if (dataQualityStatus === "passed" || dataQualityStatus === "ok") {
    return {
      text: "质检通过",
      tone: "emerald",
    };
  }

  if (dataQualityStatus === "pending") {
    return {
      text: "等待质检",
      tone: "amber",
    };
  }

  if (dataQualityStatus === "failed") {
    return {
      text: "质检未通过",
      tone: "rose",
    };
  }

  return {
    text: dataQualityStatus || "状态未知",
    tone: "slate",
  };
}
