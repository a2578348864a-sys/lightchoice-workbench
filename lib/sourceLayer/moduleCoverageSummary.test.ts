import { describe, expect, it } from "vitest";

import {
  summarizeSourceModuleCoverage,
  summarizeModuleCoverageTotals,
  moduleWasExecuted,
  moduleHasEvidence,
  type ModuleCoverageEntryLike,
  type ModuleCoverageItemLike,
} from "@/lib/sourceLayer/moduleCoverageSummary";

function entry(
  module: string,
  label: string,
  status: ModuleCoverageEntryLike["status"],
  evidenceId: string | null,
  latestAttempt: unknown = null,
): ModuleCoverageEntryLike {
  return { module, label, status, evidenceId, latestAttempt };
}

/**
 * Mirrors the real 手套-batch distribution (60 items × 8 modules):
 * - amazon_detail 59 COMPLETE / 1 CAPTURED_PARTIAL, evidence on all 60
 * - amazon_search_market 60 CAPTURED_PARTIAL, evidence on all 60
 * - 4 SellerSprite/historical modules executed with receipts only (no evidence)
 * - variation 5 COMPLETE / 20 PARTIAL / 35 BLOCKED, evidence on all 60
 * - review_voc 5 CAPTURED_PARTIAL / 54 BLOCKED / 1 HUMAN_ACTION_REQUIRED, evidence on all 60
 */
function buildItems(): ModuleCoverageItemLike[] {
  const items: ModuleCoverageItemLike[] = [];
  for (let i = 0; i < 60; i++) {
    const coverage: ModuleCoverageEntryLike[] = [
      entry("amazon_detail", "Amazon 商品详情", i === 0 ? "CAPTURED_PARTIAL" : "COMPLETE", `ev-detail-${i}`),
      entry("amazon_search_market", "Amazon 市场搜索 / Top N", "CAPTURED_PARTIAL", `ev-search-${i}`),
      entry("sellersprite_product_market", "SellerSprite 商品 / 市场深度", "HUMAN_ACTION_REQUIRED", null, { status: "human_action_required" }),
      entry("reverse_asin", "SellerSprite 反查 ASIN", "HUMAN_ACTION_REQUIRED", null, { status: "human_action_required" }),
      entry("keyword_mining_trend", "关键词挖掘 / 趋势", "HUMAN_ACTION_REQUIRED", null, { status: "human_action_required" }),
      entry("variation", "父子变体 / Variation", i < 5 ? "COMPLETE" : i < 25 ? "CAPTURED_PARTIAL" : "BLOCKED_WITH_EVIDENCE", `ev-var-${i}`),
      entry("review_voc", "Review / VOC", i < 5 ? "CAPTURED_PARTIAL" : i < 59 ? "BLOCKED_WITH_EVIDENCE" : "HUMAN_ACTION_REQUIRED", `ev-review-${i}`),
      entry("historical_trend", "历史趋势 / 竞争结构", "HUMAN_ACTION_REQUIRED", null, { status: "source_input_required" }),
    ];
    items.push({ moduleCoverage: coverage });
  }
  return items;
}

describe("module coverage summary (execution vs evidence)", () => {
  const summary = summarizeSourceModuleCoverage(buildItems());
  const byModule = new Map(summary.map((e) => [e.module, e]));

  it("counts a real evidence attachment as evidence, not a receipt", () => {
    expect(moduleHasEvidence(entry("m", "M", "COMPLETE", "ev-1"))).toBe(true);
    expect(moduleHasEvidence(entry("m", "M", "HUMAN_ACTION_REQUIRED", null, { status: "human_action_required" }))).toBe(false);
    expect(moduleWasExecuted(entry("m", "M", "HUMAN_ACTION_REQUIRED", null, { status: "human_action_required" }))).toBe(true);
    expect(moduleWasExecuted(entry("m", "M", "NOT_COLLECTED", null, null))).toBe(false);
  });

  it("does not present SellerSprite receipt-only execution as captured data", () => {
    const seller = byModule.get("sellersprite_product_market");
    expect(seller).toBeDefined();
    expect(seller!.executedCount).toBe(60);
    expect(seller!.evidenceCount).toBe(0);
    expect(seller!.receiptOnlyCount).toBe(60);
    expect(seller!.humanActionCount).toBe(60);
  });

  it("summarizes Review/VOC as 5 partial / 54 blocked / 1 human with 0 complete", () => {
    const review = byModule.get("review_voc");
    expect(review).toBeDefined();
    expect(review!.completeCount).toBe(0);
    expect(review!.partialCount).toBe(5);
    expect(review!.blockedCount).toBe(54);
    expect(review!.humanActionCount).toBe(1);
    expect(review!.evidenceCount).toBe(60);
  });

  it("rolls up 480 cells into 240 evidence and 240 receipt-only", () => {
    const totals = summarizeModuleCoverageTotals(summary);
    expect(totals.moduleCount).toBe(8);
    expect(totals.totalCells).toBe(480);
    expect(totals.executedModules).toBe(8);
    expect(totals.evidenceModules).toBe(4);
    expect(totals.evidenceCells).toBe(240);
    expect(totals.receiptOnlyModules).toBe(4);
    expect(totals.receiptOnlyCells).toBe(240);
  });

  it("counts receipt-only execution without inflating evidence", () => {
    const single = summarizeSourceModuleCoverage([
      { moduleCoverage: [entry("m", "M", "HUMAN_ACTION_REQUIRED", null, { status: "human_action_required" })] },
    ]);
    expect(single[0].evidenceCount).toBe(0);
    expect(single[0].executedCount).toBe(1);
    expect(single[0].receiptOnlyCount).toBe(1);
    expect(single[0].notCollectedCount).toBe(0);
  });

  it("counts a truly untouched module as not executed", () => {
    const single = summarizeSourceModuleCoverage([
      { moduleCoverage: [entry("m", "M", "NOT_COLLECTED", null, null)] },
    ]);
    expect(single[0].executedCount).toBe(0);
    expect(single[0].receiptOnlyCount).toBe(0);
    expect(single[0].notCollectedCount).toBe(1);
  });
});
