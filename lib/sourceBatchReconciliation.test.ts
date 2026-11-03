import { describe, expect, it } from "vitest";
import {
  reconcileSourceBatchItemCounts,
  sourceBatchQualityPresentation,
} from "./sourceBatchReconciliation";

describe("reconcileSourceBatchItemCounts", () => {
  it("marks equal accepted and returned detail counts as matched", () => {
    expect(reconcileSourceBatchItemCounts(3, 3)).toEqual({
      status: "matched",
      acceptedCount: 3,
      detailCount: 3,
      difference: 0,
    });
  });

  it("reports a discrepancy without guessing whether rows were archived or deleted", () => {
    expect(reconcileSourceBatchItemCounts(4, 3)).toEqual({
      status: "mismatch",
      acceptedCount: 4,
      detailCount: 3,
      difference: 1,
    });
  });

  it("fails closed when either count is unavailable or invalid", () => {
    expect(reconcileSourceBatchItemCounts(undefined, 3).status).toBe("unavailable");
    expect(reconcileSourceBatchItemCounts(3, -1).status).toBe("unavailable");
  });
});

describe("sourceBatchQualityPresentation", () => {
  it("returns 空批次 / 待补充 for batches with 0 items even if dataQualityStatus is passed", () => {
    const result = sourceBatchQualityPresentation("passed", { itemCount: 0 });
    expect(result.text).toBe("空批次 / 待补充");
    expect(result.text).not.toContain("质检通过");
  });

  it("returns 批次需核对 when reconciliation shows a mismatch, never 质检通过", () => {
    const reconciliation = reconcileSourceBatchItemCounts(4, 3);
    const result = sourceBatchQualityPresentation("passed", {
      itemCount: 4,
      reconciliation,
    });
    expect(result.text).toBe("批次需核对");
    expect(result.isReconciliationMismatch).toBe(true);
    expect(result.text).not.toContain("质检通过");
  });

  it("returns 质检通过 only when itemCount > 0 and no mismatch", () => {
    const reconciliation = reconcileSourceBatchItemCounts(3, 3);
    const result = sourceBatchQualityPresentation("passed", {
      itemCount: 3,
      reconciliation,
    });
    expect(result.text).toBe("质检通过");
    expect(result.tone).toBe("emerald");
  });
});
