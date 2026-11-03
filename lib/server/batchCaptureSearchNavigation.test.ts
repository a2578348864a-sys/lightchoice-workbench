import { describe, expect, it } from "vitest";

import {
  readBatchSourceType,
  resolveBatchSearchNavigationUsed,
} from "./batchCaptureSearchNavigation";

function searchBatch(searchNavigationUsed?: unknown) {
  return {
    manifestJson: JSON.stringify({ schemaVersion: "amazon-search-capture-manifest.v1", sourceType: "amazon_search_capture" }),
    normalizedSnapshotJson: JSON.stringify({ schemaVersion: "amazon-search-capture-snapshot.v1", sourceType: "amazon_search_capture" }),
    qualitySummaryJson: JSON.stringify({
      schemaVersion: "amazon-search-capture-batch-quality.v1",
      ...(searchNavigationUsed === undefined ? {} : { searchNavigationUsed }),
    }),
  };
}

describe("批次搜索阶段导航回执推导（预算合同）", () => {
  it("读取批次 provenance 的 sourceType，无法解析时返回 null", () => {
    expect(readBatchSourceType(searchBatch())).toBe("amazon_search_capture");
    expect(readBatchSourceType({ manifestJson: JSON.stringify({ sourceType: "sellersprite_xlsx" }) })).toBe("sellersprite_xlsx");
    expect(readBatchSourceType({ manifestJson: "{not-json}", normalizedSnapshotJson: null })).toBeNull();
    expect(readBatchSourceType({})).toBeNull();
  });

  it("非搜索采集批次可证明没有搜索阶段，按 0 处理", () => {
    const result = resolveBatchSearchNavigationUsed({
      manifestJson: JSON.stringify({ sourceType: "sellersprite_xlsx" }),
      normalizedSnapshotJson: null,
      qualitySummaryJson: "{}",
    });
    expect(result).toMatchObject({ known: true, used: 0, provenance: "no_search_stage" });
  });

  it("搜索采集批次以质量摘要回执为准", () => {
    const result = resolveBatchSearchNavigationUsed(searchBatch(3));
    expect(result).toMatchObject({ known: true, used: 3, provenance: "search_stage_receipt" });
  });

  it("搜索采集批次缺少导航回执时明确阻断，不伪造也不默认 0", () => {
    const result = resolveBatchSearchNavigationUsed(searchBatch(undefined));
    expect(result.known).toBe(false);
    if (!result.known) {
      expect(result.code).toBe("BATCH_CAPTURE_SEARCH_NAVIGATION_PROVENANCE_MISSING");
      expect(result.reason).toContain("阻断");
    }
  });

  it.each([
    ["零值", 0],
    ["负数", -2],
    ["非整数", 1.5],
    ["字符串", "2"],
    ["空值", null],
  ])("回执为%s时不视为可信", (_label, value) => {
    const result = resolveBatchSearchNavigationUsed(searchBatch(value));
    expect(result.known).toBe(false);
  });

  it("manifestJson 损坏但 normalizedSnapshotJson 可解析时仍能识别来源", () => {
    const result = resolveBatchSearchNavigationUsed({
      manifestJson: "{broken",
      normalizedSnapshotJson: JSON.stringify({ sourceType: "amazon_search_capture" }),
      qualitySummaryJson: JSON.stringify({ searchNavigationUsed: 4 }),
    });
    expect(result).toMatchObject({ known: true, used: 4, provenance: "search_stage_receipt" });
  });
});
