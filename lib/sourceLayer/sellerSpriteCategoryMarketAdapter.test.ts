import { describe, expect, it } from "vitest";

import { adaptSellerSpriteCategoryMarketTable } from "@/lib/sourceLayer/sellerSpriteCategoryMarketAdapter";

const HEADERS = [
  "细分市场",
  "样本数量",
  "月总销量",
  "月均销量(头部)",
  "月均销售额(头部)",
  "平均评分数/星级",
  "平均BSR(头部)",
  "平均卖家数",
  "平均价格",
  "卖家类型",
  "集中度指标",
  "新品数量/占比",
  "商品总数",
  "退货率",
];

const ROW = [
  "Thermoses (热水器)",
  "商品 100 / 品牌 33 / 卖家 35",
  "978,477",
  "9,784 · 头部参考 46,437 (4.7)",
  "258,513 · 参考 1,200,010",
  "评分数 8,399 · 星级 4.5",
  "23,830 · 参考 133",
  "2.5",
  "$28.32",
  "FBA 41% / AMZ 42% / FBM 1%",
  "商品 47.5% / 品牌 78.7% / 卖家 84.9%",
  "3 (3%)",
  "5,105",
  "4.71%",
];

const CAPTURED_AT = "2026-10-07T10:00:00.000Z";

describe("SellerSprite 类目市场映射", () => {
  it("maps the visible market table into provider-estimate facts without treating it as Amazon-confirmed", () => {
    const result = adaptSellerSpriteCategoryMarketTable({
      query: "kitchen",
      category: { id: "1055398:284507", label: "Home & Kitchen:Kitchen & Dining", products: 415126 },
      headers: HEADERS,
      rows: [ROW],
      sourceUrl: "https://www.sellersprite.com/v2/market-research",
      capturedAt: CAPTURED_AT,
    });

    expect(result.sourceType).toBe("category");
    expect(result.category.label).toBe("Home & Kitchen:Kitchen & Dining");
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]).toMatchObject({
      segment: { value: "Thermoses (热水器)", authority: "provider_derived" },
      sampleProductCount: { value: 100, nature: "provider_estimate" },
      sampleBrandCount: { value: 33, nature: "provider_estimate" },
      sampleSellerCount: { value: 35, nature: "provider_estimate" },
      monthlyTotalSales: { value: 978477, nature: "provider_estimate" },
      topMonthlyAverageSales: { value: 9784, nature: "provider_estimate" },
      topMonthlyAverageRevenueUsd: { value: 258513, nature: "provider_estimate" },
      averageReviewCount: { value: 8399, nature: "provider_estimate" },
      averageRating: { value: 4.5, nature: "provider_estimate" },
      averageTopBsr: { value: 23830, nature: "provider_estimate" },
      averageSellerCount: { value: 2.5, nature: "provider_estimate" },
      averagePriceUsd: { value: 28.32, nature: "provider_estimate" },
      fbaSellerSharePercent: { value: 41, nature: "provider_estimate" },
      amazonSellerSharePercent: { value: 42, nature: "provider_estimate" },
      fbmSellerSharePercent: { value: 1, nature: "provider_estimate" },
      productConcentrationPercent: { value: 47.5, nature: "provider_estimate" },
      brandConcentrationPercent: { value: 78.7, nature: "provider_estimate" },
      sellerConcentrationPercent: { value: 84.9, nature: "provider_estimate" },
      newProductCount: { value: 3, nature: "provider_estimate" },
      newProductSharePercent: { value: 3, nature: "provider_estimate" },
      totalProductCount: { value: 5105, nature: "provider_estimate" },
      returnRatePercent: { value: 4.71, nature: "provider_estimate" },
    });
    expect(result.amazonConfirmed).toBe(false);
  });

  it("keeps unavailable numeric cells null and reports absent optional columns", () => {
    const result = adaptSellerSpriteCategoryMarketTable({
      query: "kitchen",
      category: { id: "1055398", label: "Home & Kitchen", products: 1333736 },
      headers: ["细分市场", "月总销量"],
      rows: [["Storage", "—"]],
      sourceUrl: "https://www.sellersprite.com/v2/market-research",
      capturedAt: CAPTURED_AT,
    });

    expect(result.rows[0]?.monthlyTotalSales).toEqual({ value: null, nature: "provider_estimate" });
    expect(result.rows[0]?.averagePriceUsd.value).toBeNull();
    expect(result.rows[0]?.warnings).toContain("market_columns_missing");
  });

  it("rejects empty or oversized market tables and invalid source origins", () => {
    const input = {
      query: "kitchen",
      category: { id: "1055398", label: "Home & Kitchen", products: 1333736 },
      headers: HEADERS,
      rows: [ROW],
      sourceUrl: "https://www.sellersprite.com/v2/market-research",
      capturedAt: CAPTURED_AT,
    };

    expect(() => adaptSellerSpriteCategoryMarketTable({ ...input, rows: [] }))
      .toThrow("CATEGORY_MARKET_TABLE_EMPTY");
    expect(() => adaptSellerSpriteCategoryMarketTable({ ...input, rows: Array.from({ length: 61 }, () => ROW) }))
      .toThrow("CATEGORY_MARKET_ROW_LIMIT");
    expect(() => adaptSellerSpriteCategoryMarketTable({ ...input, sourceUrl: "https://example.com/fake" }))
      .toThrow("CATEGORY_MARKET_SOURCE_INVALID");
  });

  it("does not classify one absent price column as all market values unavailable", () => {
    const result = adaptSellerSpriteCategoryMarketTable({ query: "kitchen", category: { id: "1055398", label: "Home & Kitchen", products: null },
      headers: HEADERS.filter(header => header !== "平均价格"), rows: [ROW.filter((_, index) => index !== 8)],
      sourceUrl: "https://www.sellersprite.com/v2/market-research", capturedAt: CAPTURED_AT });
    expect(result.rows[0].averagePriceUsd.value).toBeNull();
    expect(result.rows[0].warnings).toEqual(["market_columns_missing", "market_values_partial"]);
    expect(result.rows[0].fieldCoverage).toMatchObject({ missingColumns: ["averagePriceUsd"], unavailableFields: ["averagePriceUsd"], availableMetricCount: 20, totalMetricCount: 21 });
    expect(result.observedHeaders).not.toContain("平均价格");
  });

  it("distinguishes a present empty field and a table with all numeric values absent", () => {
    const input = { query: "kitchen", category: { id: "1055398", label: "Home & Kitchen", products: null },
      headers: HEADERS, sourceUrl: "https://www.sellersprite.com/v2/market-research", capturedAt: CAPTURED_AT };
    const partial = adaptSellerSpriteCategoryMarketTable({ ...input, rows: [ROW.map((value, index) => index === 8 ? "—" : value)] });
    expect(partial.rows[0].warnings).toEqual(["market_values_partial"]);
    expect(partial.rows[0].fieldCoverage?.missingColumns).toEqual([]);
    const empty = adaptSellerSpriteCategoryMarketTable({ ...input, rows: [HEADERS.map((_, index) => index === 0 ? "Storage" : "—")] });
    expect(empty.rows[0].warnings).toEqual(["market_values_unavailable"]);
    expect(empty.rows[0].fieldCoverage?.availableMetricCount).toBe(0);
  });

  it("recognizes the headers observed in the one real capture, keeping fixture values separate", () => {
    // Header spellings from the real response; all numeric values below are deterministic fixtures.
    const headers = ["细分市场", "样本数量", "月总销量", "月均销量", "月均销售额", "平均评分数", "平均BSR",
      "平均卖家数\n     平均价格", "卖家类型", "集中度指标", "新品数量", "商品总数", "退货率"];
    const row = [ROW[0], ROW[1], ROW[2], ROW[3], ROW[4], "8,399\n4.5", ROW[6], "2.5\n$28.32", ROW[9], ROW[10], "3\n3%", ROW[12], ROW[13]];
    const input = { query: "Home Kitchen Dining", category: { id: "1055398:284507", label: "Home & Kitchen:Kitchen & Dining", products: null },
      headers, sourceUrl: "https://www.sellersprite.com/v2/market-research", capturedAt: CAPTURED_AT };
    const result = adaptSellerSpriteCategoryMarketTable({ ...input, rows: [row] });
    expect(result.rows[0]).toMatchObject({ averageReviewCount: { value: 8399 }, averageRating: { value: 4.5 },
      averageSellerCount: { value: 2.5 }, averagePriceUsd: { value: 28.32 }, newProductCount: { value: 3 }, newProductSharePercent: { value: 3 } });
    expect(result.rows[0].warnings).toEqual([]);
    expect(result.rows[0].fieldCoverage?.availableMetricCount).toBe(21);
    const uncertain = adaptSellerSpriteCategoryMarketTable({ ...input, rows: [row.map((value, index) => index === 7 ? "2.5 28.32" : value)] });
    expect(uncertain.rows[0].averageSellerCount.value).toBeNull();
    expect(uncertain.rows[0].averagePriceUsd.value).toBeNull();
    expect(uncertain.rows[0].warnings).toEqual(["market_values_partial"]);
  });
});
