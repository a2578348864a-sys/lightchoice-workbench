import { describe, expect, it } from "vitest";

import {
  identifySellerSpriteVisibleKeywordRows,
  identifySellerSpriteVisibleRows,
} from "@/lib/sourceLayer/sellerSpriteVisibleRowIdentity";

describe("SellerSprite visible row identity", () => {
  it("requires a unique explicit ASIN column for Product Research", () => {
    const rows = identifySellerSpriteVisibleRows("sellersprite_product_market", [
      { headers: ["商品名称", "ASIN", "价格"], rows: [["Lamp", "B012345678", "$20"], ["Lamp copy", "B012345678", "$19"]] },
      { headers: ["商品名称", "标题"], rows: [["B099999999", "very long title"]] },
      { headers: ["ASIN", "产品ASIN"], rows: [["B022222222", "B033333333"]] },
    ]);
    expect(rows.capturedUniqueRows).toBe(1);
    expect(rows.structuredValidRows).toBe(1);
    expect(rows.structuredValidRowKeys).toHaveLength(1);
    expect(rows.rowKeys).toHaveLength(1);
  });

  it("deduplicates keyword rows by typed row identity and does not guess columns", () => {
    const rows = identifySellerSpriteVisibleRows("reverse_asin", [
      { headers: ["Keyword", "Search Volume"], rows: [["desk lamp", "12,000"], ["desk lamp", "12,000"]] },
      { headers: ["Metric", "Value"], rows: [["keyword that is a longer string", "1"]] },
    ]);
    expect(rows.capturedUniqueRows).toBe(1);
    expect(rows.structuredValidRows).toBe(1);
    expect(rows.structuredValidRowKeys).toHaveLength(1);
  });

  it("keeps structured count below unique count when metrics are unknown", () => {
    const rows = identifySellerSpriteVisibleRows("keyword_mining_trend", [
      { headers: ["Keyword", "Search Volume"], rows: [["desk lamp", "N/A"]] },
    ]);
    expect(rows.capturedUniqueRows).toBe(1);
    expect(rows.structuredValidRows).toBe(0);
    expect(rows.structuredValidRowKeys).toEqual([]);
  });

  it("keeps row identity stable across virtual windows with changing estimates and reports rejected overlaps", () => {
    const first = identifySellerSpriteVisibleKeywordRows("keyword_mining_trend", [
      { headers: ["Keyword", "Search Volume"], rows: [["desk lamp", "12,000"], ["lamp shade", "8,000"]] },
    ]);
    const overlapping = identifySellerSpriteVisibleKeywordRows("keyword_mining_trend", [
      { headers: ["Keyword", "Search Volume"], rows: [["desk lamp", "12,400"], ["desk lamp", "12,400"], ["new lamp", "3,000"]] },
    ]);

    expect(overlapping.rows.map((row) => row.rowKey)).toEqual([
      expect.any(String), expect.any(String),
    ]);
    expect(overlapping.rows[0].rowKey).toBe(first.rows[0].rowKey);
    expect(overlapping.rows.map((row) => row.typedRow.keyword)).toEqual(["desk lamp", "new lamp"]);
    expect(overlapping.actualVisibleRows).toBe(3);
    expect(overlapping.duplicatesRejected).toBe(1);
  });
});
