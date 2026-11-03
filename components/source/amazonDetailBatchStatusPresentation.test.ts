import { describe, expect, it } from "vitest";

import { summarizeAmazonDetailBatchStatus } from "./amazonDetailBatchStatusPresentation";

describe("summarizeAmazonDetailBatchStatus", () => {
  it("separates full completion, partial evidence, and pending items", () => {
    const summary = summarizeAmazonDetailBatchStatus([
      { enrichmentStatus: "enriched" },
      { enrichmentStatus: "enriched" },
      { enrichmentStatus: "captured_partial" },
      { enrichmentStatus: null },
    ], "ready");

    expect(summary).toMatchObject({
      total: 4,
      complete: 2,
      partial: 1,
      pending: 1,
      unknown: 0,
      evidenceBacked: 3,
      completePercent: 50,
      canContinue: true,
      disabledReason: null,
    });
  });

  it("does not offer a second pass when only partial items remain", () => {
    const summary = summarizeAmazonDetailBatchStatus([
      { enrichmentStatus: "captured_partial" },
    ], "ready");

    expect(summary.canContinue).toBe(false);
    expect(summary.pending).toBe(0);
    expect(summary.disabledReason).toContain("不会通过此入口自动重采");
  });

  it("blocks a non-ready batch even when it has pending items", () => {
    const summary = summarizeAmazonDetailBatchStatus([
      { enrichmentStatus: null },
    ], "blocked");

    expect(summary.canContinue).toBe(false);
    expect(summary.disabledReason).toContain("批次当前未就绪");
  });

  it("fails closed on an unknown item status", () => {
    const summary = summarizeAmazonDetailBatchStatus([
      { enrichmentStatus: "unexpected" },
      { enrichmentStatus: null },
    ], "ready");

    expect(summary).toMatchObject({
      complete: 0,
      partial: 0,
      pending: 1,
      unknown: 1,
      canContinue: false,
    });
    expect(summary.disabledReason).toContain("无法识别");
  });

  it("handles an empty batch without presenting progress as complete", () => {
    const summary = summarizeAmazonDetailBatchStatus([], "ready");

    expect(summary).toMatchObject({
      total: 0,
      completePercent: 0,
      canContinue: false,
    });
    expect(summary.disabledReason).toContain("没有可处理的商品");
  });
});
