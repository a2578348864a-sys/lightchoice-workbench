import { describe, expect, it } from "vitest";
import { parseSellerSpriteKeywordTable } from "@/lib/sourceLayer/sellerSpriteKeywordTable";

describe("SellerSprite visible keyword table contract", () => {
  it("recovers purchase count and purchase rate without changing search growth or raw evidence", () => {
    const parsed = parseSellerSpriteKeywordTable({ page: "keyword_mining_trend", table: {
      headers: ["关键词", "月购买量", "搜索量增长率"],
      rows: [["mat", "4,638 5.95%", "8.86%"], ["oven mat", "759 (11.15%)", "-2%"], ["unknown", "--", "0%"], ["zero", "0 0%", "0%"]],
    } });
    expect(parsed.rows[0].metrics).toMatchObject({ estimatedMonthlyPurchase: { value: 4638, raw: "4,638 5.95%" }, estimatedPurchaseRate: { value: expect.closeTo(0.0595, 10), unit: "ratio", metricNature: "provider_estimate" }, searchVolumeGrowth: { value: 0.0886 } });
    expect(parsed.rows[1].metrics.estimatedMonthlyPurchase?.value).toBe(759);
    expect(parsed.rows[1].metrics.estimatedPurchaseRate?.value).toBe(0.1115);
    expect(parsed.rows[2].metrics.estimatedMonthlyPurchase?.value).toBeNull();
    expect(parsed.rows[2].metrics.estimatedPurchaseRate).toBeUndefined();
    expect(parsed.rows[3].metrics.estimatedMonthlyPurchase?.value).toBe(0);
    expect(parsed.rows[3].metrics.estimatedPurchaseRate?.value).toBe(0);
    expect(parsed.rows[0].rawCells["月购买量"]).toBe("4,638 5.95%");
  });

  it("does not guess counts from rates, abbreviated, trailing or ambiguous purchase cells", () => {
    for (const value of ["5.95%", "4.6K 5.95%", "4,638 5.95% 999", "-1 5.95%", "4638 5.95%)", "4638 (5.95%"] ) {
      const result = parseSellerSpriteKeywordTable({page:"keyword_mining_trend",table:{headers:["关键词","月购买量"],rows:[["mat",value]]}});
      expect(result.rows[0].metrics.estimatedMonthlyPurchase?.value).toBeNull();
    }
    const result = parseSellerSpriteKeywordTable({page:"reverse_asin",table:{headers:["关键词","月购买量","购买率","Purchase rate"],rows:[["mat","4,638 5.95%","6%","7%"]]}});
    expect(result.rows[0].metrics.estimatedPurchaseRate).toBeUndefined();
    expect(result.limitations).toContain("duplicate_estimatedPurchaseRate_header");
  });
  it("maps only named Reverse ASIN headers and keeps provider estimates typed", () => {
    const result = parseSellerSpriteKeywordTable({
      page: "reverse_asin",
      table: {
        headers: ["Keyword", "Traffic Share", "Estimated Traffic", "Organic Rank", "Ad Rank"],
        rows: [["kitchen organizer", "38.37%", "81,070", "515", "—"]],
      },
    });

    expect(result.status).toBe("valid");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      keyword: "kitchen organizer",
      metrics: {
        trafficShare: { raw: "38.37%", value: 0.3837, unit: "ratio", status: "parsed" },
        estimatedTraffic: { raw: "81,070", value: 81070, unit: "count", status: "parsed" },
        organicRank: { raw: "515", value: 515, unit: "count", status: "parsed" },
        adRank: { raw: "—", value: null, unit: "count", status: "unknown" },
      },
    });
    expect(result.rows[0].rawCells).toEqual({
      Keyword: "kitchen organizer",
      "Traffic Share": "38.37%",
      "Estimated Traffic": "81,070",
      "Organic Rank": "515",
      "Ad Rank": "—",
    });
    expect(result.rows[0].rowKey).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("parses the explicit search-volume growth companion and leaves unknown metrics null", () => {
    const result = parseSellerSpriteKeywordTable({
      page: "keyword_mining_trend",
      table: {
        headers: ["关键词", "Search Volume", "SPR", "Title Density", "Estimated Monthly Sales"],
        rows: [["glass food storage", "135,693 (+14.42%)", "515", "0.38%", ""]],
      },
    });

    expect(result.status).toBe("valid");
    expect(result.rows[0].metrics).toMatchObject({
      searchVolume: { value: 135693, unit: "count", status: "parsed" },
      searchVolumeGrowth: { raw: "(+14.42%)", value: 0.1442, unit: "percent", status: "parsed" },
      spr: { value: 515, status: "parsed" },
      titleDensity: { raw: "0.38%", value: null, status: "unknown" },
      estimatedMonthlySales: { raw: "", value: null, status: "unknown" },
    });
    expect(result.rows[0].metrics.estimatedMonthlyRevenue).toBeUndefined();
  });

  it("does not infer a keyword from the second or longest column", () => {
    const result = parseSellerSpriteKeywordTable({
      page: "keyword_mining_trend",
      table: {
        headers: ["序号", "长文本", "月搜索量"],
        rows: [["1", "this is the longest text but not a labeled keyword", "2,000"]],
      },
    });
    expect(result.status).toBe("unavailable");
    expect(result.rows).toEqual([]);
    expect(result.limitations).toContain("keyword_header_unidentified");
  });

  it("marks duplicate keyword headers ambiguous instead of selecting one", () => {
    const result = parseSellerSpriteKeywordTable({
      page: "reverse_asin",
      table: {
        headers: ["Keyword", "关键词", "Traffic Share"],
        rows: [["kinto cup", "kinto tumbler", "12.5%"]],
      },
    });
    expect(result.status).toBe("unavailable");
    expect(result.limitations).toContain("duplicate_keyword_header");
  });

  it("drops repeated header and placeholder rows and deduplicates identical rows across pages", () => {
    const result = parseSellerSpriteKeywordTable({
      page: "reverse_asin",
      table: {
        headers: ["Keyword", "Traffic Share"],
        rows: [
          ["Keyword", "Traffic Share"],
          ["loading", ""],
          ["kitchen organizer", "38.37%"],
          [" kitchen   organizer ", "38.37%"],
        ],
      },
    });
    expect(result.inputRowCount).toBe(4);
    expect(result.rejectedRowCount).toBe(2);
    expect(result.uniqueRowCount).toBe(1);
    expect(result.rows).toHaveLength(1);
  });

  it("keeps row identity stable when provider estimates change and rejects the repeated logical row", () => {
    const first = parseSellerSpriteKeywordTable({
      page: "keyword_mining_trend",
      table: { headers: ["Keyword", "Search Volume"], rows: [["steel lunch box", "1,200"]] },
    });
    const nextWindow = parseSellerSpriteKeywordTable({
      page: "keyword_mining_trend",
      table: {
        headers: ["Keyword", "Search Volume"],
        rows: [[" steel   lunch box ", "1,450"], ["steel lunch box", "1,450"]],
      },
    });

    expect(nextWindow.rows[0].rowKey).toBe(first.rows[0].rowKey);
    expect(nextWindow.rows[0].metrics.searchVolume?.value).toBe(1450);
    expect(nextWindow.duplicateRowCount).toBe(1);
    expect(nextWindow.rows).toHaveLength(1);
  });

  it("preserves formatted values that cannot be safely normalized as unknown", () => {
    const result = parseSellerSpriteKeywordTable({
      page: "keyword_mining_trend",
      table: {
        headers: ["Keyword", "Search Volume"],
        rows: [["steel lunch box", "N/A"]],
      },
    });
    expect(result.status).toBe("partial");
    expect(result.rows[0].metrics.searchVolume).toEqual({
      raw: "N/A",
      value: null,
      unit: "count",
      metricNature: "provider_estimate",
      status: "unknown",
    });
    expect(result.rows[0].rawCells["Search Volume"]).toBe("N/A");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // P2-2：真实 SellerSprite Reverse ASIN 表头（含徽标/提示词、复合列）
  // ───────────────────────────────────────────────────────────────────────────
  const REAL_REVERSE_HEADERS = [
    "#", "关键词 数据解释", "内测版流量占比", "流量词类型", "流量分布", "自然排名", "广告排名",
    "月搜索趋势", "ABA周排名", "月搜索量增长率", "SPR", "标题密度", "月购买量", "展示量 点击量",
    "需供比 商品数", "广告竞品数", "ABA集中度", "PPC竞价精准词组精准广泛", "操作",
  ];
  const REAL_REVERSE_ROW = [
    "1", "christmas tree AC 圣诞树", "38.44% 80,590 主要流量词", "自然搜索词AC推荐词SP广告词",
    "* 自然: 99.89%* 广告: 0.11%", "58 第1页, 58 / 80 昨日22:04排名", "14 第1页, 14 / 78昨日10:40排名",
    null, "987", "135,693 14.42%", "12", "37", "515 0.38%", "3,720,21652,272", "1.2 112,190",
    "746", "点击: 5.82%转化: 1.49%15.97%7.46%", "$0.35$0.44$0.53", null,
  ];

  it("resolves the real Reverse ASIN headers (徽标/提示词 + 复合列) into typed provider metrics", () => {
    const result = parseSellerSpriteKeywordTable({
      page: "reverse_asin",
      table: { headers: REAL_REVERSE_HEADERS, rows: [REAL_REVERSE_ROW] },
    });
    expect(result.status).toBe("valid");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].keyword).toBe("christmas tree AC 圣诞树");
    expect(result.rows[0].metrics).toMatchObject({
      organicRank: { value: 58, status: "parsed" },
      adRank: { value: 14, status: "parsed" },
      spr: { value: 12, status: "parsed" },
      titleDensity: { value: 37, status: "parsed" },
    });
    // 「内测版流量占比」→ 流量占比（包含匹配，徽标不干扰）
    expect(result.rows[0].metrics.trafficShare?.value).toBeCloseTo(0.3844, 4);
    // 复合表头仍优先归增长率；精确双值单元格另外恢复真实计数。
    expect(result.rows[0].metrics.searchVolumeGrowth?.value).toBeCloseTo(0.1442, 4);
    expect(result.rows[0].metrics.searchVolumeGrowth?.unit).toBe("percent");
    expect(result.rows[0].metrics.searchVolume?.value).toBe(135693);
    for (const metric of Object.values(result.rows[0].metrics)) {
      expect(metric?.metricNature).toBe("provider_estimate");
    }
  });

  it("复合列没有明确计数时，不把百分比或缩写推算成搜索量",()=>{
    for(const cell of ["14.42%","135K 14.42%","135,693 14.42% 999","-1 14.42%"]){
      const result=parseSellerSpriteKeywordTable({page:"reverse_asin",table:{headers:["关键词","月搜索量增长率"],rows:[["kw",cell]]}});
      expect(result.rows[0].metrics.searchVolume).toBeUndefined();
    }
  });

  it("最长别名优先：`月搜索量增长率` 不得被更短的 `月搜索量` 抢先命中", () => {
    const result = parseSellerSpriteKeywordTable({
      page: "reverse_asin",
      table: { headers: ["关键词", "月搜索量增长率"], rows: [["kw", "135,693 14.42%"]] },
    });
    expect(result.rows[0].metrics.searchVolumeGrowth?.value).toBeCloseTo(0.1442, 4);
    expect(result.rows[0].metrics.searchVolume?.value).toBe(135693);
  });

  it("包含匹配遇到重复列时判为歧义并拒绝该指标（不猜）", () => {
    const result = parseSellerSpriteKeywordTable({
      page: "reverse_asin",
      table: { headers: ["关键词", "流量占比", "内测版流量占比"], rows: [["kw", "10%", "20%"]] },
    });
    expect(result.rows[0].metrics.trafficShare).toBeUndefined();
    expect(result.limitations).toContain("duplicate_trafficShare_header");
  });

  it("表头缺失或无关键词列时不产出任何行（fail-closed）", () => {
    const missing = parseSellerSpriteKeywordTable({
      page: "reverse_asin",
      table: { headers: [], rows: [["1", "kw"]] },
    });
    expect(missing.rows).toEqual([]);
    expect(missing.limitations).toContain("headers_missing");
    expect(missing.limitations).toContain("keyword_header_unidentified");
  });
});
