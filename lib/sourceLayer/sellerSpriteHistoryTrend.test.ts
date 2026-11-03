import { describe, expect, it } from "vitest";

import {
  buildSellerSpriteHistorySeries,
  parseSellerSpriteHistoryMonthTables,
  parseSellerSpriteHistoryMoneyCell,
  parseSellerSpriteHistoryNumber,
  parseSellerSpriteHistoryTooltip,
  resolveSellerSpriteHistoryMonthTables,
  validateSellerSpriteHistoryMonths,
  type SellerSpriteHistoryDrawerRaw,
  type SellerSpriteHistoryMonthTable,
} from "./sellerSpriteHistoryTrend";

// 真实页面快照（2026-10-24 专用 9222 浏览器：查竞品 → 行内「历史趋势」图标 → 底部抽屉）。
const REAL_MONTHS = [
  "2024-10", "2024-11", "2024-12", "2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06",
  "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03",
  "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10",
];

const REAL_SALES_ROW = ["267,678", "226,970", "15,883", "155,684", "270,796", "267,044", "268,404", "276,803", "294,864", "357,586", "329,960", "309,258", "61,858", "327,875", "277,879", "324,110", "345,626", "331,612", "376,392", "403,519", "434,853", "375,616", "351,836", "164,231", "618,202"];
const REAL_REVENUE_ROW = ["$1,520,411", "$4,709,628", "$269,852", "$2,626,389", "$4,600,824", "$4,587,816", "$6,597,371", "$4,918,790", "$5,009,740", "$6,622,493", "$5,757,803", "$5,362,534", "$1,087,464", "$6,088,639", "$4,721,164", "$5,506,629", "$5,872,186", "$5,634,088", "$6,394,900", "$7,069,653", "$7,340,319", "$6,411,765", "$5,981,212", "$2,584,996", "$9,019,567"];
const REAL_AVG_PRICE_ROW = ["N/A", "$20.75", "$16.99", "$16.87", "$16.99", "$17.18", "$24.58", "$17.77", "$16.99", "$18.52", "$17.45", "$17.34", "$17.58", "$18.57", "$16.99", "$16.99", "$16.99", "$16.99", "$16.99", "$17.52", "$16.88", "$17.07", "$17.00", "$15.74", "$14.59"];

const realMergedTable: SellerSpriteHistoryMonthTable = {
  months: REAL_MONTHS,
  rows: [
    { label: "月销量", values: REAL_SALES_ROW },
    { label: "月销售额", values: REAL_REVENUE_ROW },
    { label: "平均单价", values: REAL_AVG_PRICE_ROW },
  ],
};

const REAL_TOOLTIP_1 = `2026-07-30 06:32
Buybox价格 $17.04
价格 $17.04
Coupon(订阅) $14.48(save 15%后)
子体销量 20,000+
大类BSR[Health & Household] 3
小类BSR[Toilet Paper] 1
评分 4.6
卖家数 2
评分数 144,423`;

const REAL_TOOLTIP_2 = `2026-08-09 13:30
Buybox价格 $16.99
价格 $16.99
Coupon(订阅) $14.44(save 15%后)
子体销量 20,000+
大类BSR[Health & Household] 3
小类BSR[Toilet Paper] 1
评分 4.5
卖家数 2
评分数 146,220`;

function rawDrawer(overrides: Partial<SellerSpriteHistoryDrawerRaw> = {}): SellerSpriteHistoryDrawerRaw {
  return {
    asin: "B0DJWKTVSW",
    title: "Scott ComfortPlus Toilet Paper",
    headerText: "B0DJWKTVSW BSR排名: 1 价格: $14.29",
    activeTab: "历史趋势",
    rangeLabel: "近3个月",
    monthTableGroups: [{ months: realMergedTable.months, rows: realMergedTable.rows }],
    labelRows: [],
    tooltipTexts: [],
    ...overrides,
  };
}

describe("SellerSprite 历史序列解析（真实页面合同）", () => {
  it("严格数字：千分位可解析；区间/N/A/带后缀/货币前缀一律不可直接解析", () => {
    expect(parseSellerSpriteHistoryNumber("267,678")).toBe(267678);
    expect(parseSellerSpriteHistoryNumber("$1,520,411")).toBeNull();
    expect(parseSellerSpriteHistoryNumber("1,520,411.5")).toBe(1520411.5);
    expect(parseSellerSpriteHistoryNumber("20,000+")).toBeNull();
    expect(parseSellerSpriteHistoryNumber("N/A")).toBeNull();
    expect(parseSellerSpriteHistoryNumber("****")).toBeNull();
    expect(parseSellerSpriteHistoryNumber("")).toBeNull();
    expect(parseSellerSpriteHistoryNumber("12条")).toBeNull();
    // 月表里的货币列由专用函数剥离货币符号后解析。
    expect(parseSellerSpriteHistoryMoneyCell("$1,520,411")).toBe(1520411);
    expect(parseSellerSpriteHistoryMoneyCell("US$ 20.75")).toBe(20.75);
    expect(parseSellerSpriteHistoryMoneyCell("N/A")).toBeNull();
  });

  it("月份表头：严格递增、去重、3 年跨度上限", () => {
    expect(validateSellerSpriteHistoryMonths(REAL_MONTHS).months).toHaveLength(25);
    expect(validateSellerSpriteHistoryMonths(["2025-01", "2025-01", "2025-02", "2025-03"]).issues.map((item) => item.code)).toContain("MONTHS_DUPLICATED");
    expect(validateSellerSpriteHistoryMonths(["2025-03", "2025-02", "2025-01"]).months).toEqual([]);
    expect(validateSellerSpriteHistoryMonths(["2025-01", "2025-02"]).issues.map((item) => item.code)).toContain("MONTHS_TOO_FEW");
    expect(validateSellerSpriteHistoryMonths(["2020-01", "2022-01", "2024-01"]).issues.map((item) => item.code)).toContain("MONTHS_SPAN_EXCEEDED");
  });

  it("真实月份表：25 个月、月销量/月销售额/平均单价；首月 N/A 保持缺值", () => {
    const result = parseSellerSpriteHistoryMonthTables([realMergedTable]);
    expect(result.points).toHaveLength(25);
    expect(result.issues).toEqual([]);
    expect(result.points[0]).toEqual({ date: "2024-10", monthlySales: 267678, monthlyRevenue: 1520411 });
    expect(result.points.at(-1)).toEqual({ date: "2026-10", monthlySales: 618202, monthlyRevenue: 9019567, avgPrice: 14.59 });
    expect("avgPrice" in result.points[0]).toBe(false);
    expect(result.points.some((point) => point.avgPrice === 0)).toBe(false);
  });

  it("真实页面同屏多表：数值表 + 独立标签表按行号拼接；空模板表不会被当成数据", () => {
    const groups = [
      {
        months: REAL_MONTHS,
        rows: [
          { label: "", values: REAL_SALES_ROW },
          { label: "", values: REAL_REVENUE_ROW },
          { label: "", values: REAL_AVG_PRICE_ROW },
        ],
      },
      {
        months: REAL_MONTHS,
        rows: [
          { label: "月销量", values: REAL_MONTHS.map(() => "") },
          { label: "月销售额", values: REAL_MONTHS.map(() => "") },
          { label: "平均单价", values: REAL_MONTHS.map(() => "") },
        ],
      },
    ];
    const labelRows = [["月份", "", "", ""], ["月销量", "", "", ""], ["月销售额", "", "", ""], ["平均单价", "", "", ""]];
    const resolved = resolveSellerSpriteHistoryMonthTables({ monthTableGroups: groups, labelRows });
    expect(resolved.tables.length).toBeGreaterThanOrEqual(1);
    expect(resolved.tables[0].rows.map((row) => row.label)).toEqual(["月销量", "月销售额", "平均单价"]);
    const parsed = parseSellerSpriteHistoryMonthTables(resolved.tables);
    expect(parsed.points).toHaveLength(25);
    expect(parsed.points[0].monthlySales).toBe(267678);
  });

  it("悬停浮层：真实文本解析出日期与真实指标；Coupon/子体销量区间不写入数值序列", () => {
    const parsed = parseSellerSpriteHistoryTooltip(REAL_TOOLTIP_1);
    expect(parsed?.datetime).toBe("2026-07-30T06:32");
    expect(parsed?.date).toBe("2026-07-30");
    expect(parsed?.metrics).toEqual({ buyboxPrice: 17.04, price: 17.04, categoryBsr: 3, bsr: 1, rating: 4.6, sellerCount: 2, reviewCount: 144423 });
    expect(parsed?.metrics).not.toHaveProperty("childSales");
    expect(parsed?.metrics).not.toHaveProperty("couponPrice");
  });

  it("悬停浮层：无日期 / 无指标 / 非法日期 一律拒绝", () => {
    expect(parseSellerSpriteHistoryTooltip("价格 $17.04")).toBeNull();
    expect(parseSellerSpriteHistoryTooltip("2026-07-30 06:32")).toBeNull();
    expect(parseSellerSpriteHistoryTooltip("")).toBeNull();
    expect(parseSellerSpriteHistoryTooltip("2026-13-40 06:32\n价格 $17.04")).toBeNull();
  });

  it("留评率标签：YYYYMM 日期 + 标签/值分行，读出当月销量、评分数增长与留评率", () => {
    // 真实页面文本（2026-10-24 专用浏览器「留评率」标签悬停浮层）。
    const text = `202202
当月评分数增长值
301
当月销量
9,078
当月留评率
3.32%`;
    const parsed = parseSellerSpriteHistoryTooltip(text);
    expect(parsed?.date).toBe("2022-02");
    expect(parsed?.metrics).toEqual({ reviewGrowth: 301, monthlySales: 9078, reviewRate: 3.32 });
    // 单行排版仍可解析，且不会把「子体销量 20,000+」这种区间写进数值。
    const keepa = parseSellerSpriteHistoryTooltip(REAL_TOOLTIP_1);
    expect(keepa?.metrics.monthlySales).toBeUndefined();
  });

  it("同月既有月份表又有留评率悬停销量时，以月份表为准并计数；表格没有的月份才补位", () => {
    const result = buildSellerSpriteHistorySeries(rawDrawer({
      tooltipTexts: [
        // 与月份表重叠的月份：销量以表为准（表值为 267,678）。
        "202410\n当月评分数增长值\n120\n当月销量\n999,999\n当月留评率\n4.10%",
        // 表格未覆盖的更早月份：用悬停值补位。
        "202305\n当月评分数增长值\n330\n当月销量\n6,310\n当月留评率\n5.23%",
      ],
    }));
    expect(result.tablePreferredSales).toBe(1);
    const october = result.series.filter((point) => point.date === "2024-10");
    expect(october.some((point) => point.monthlySales === 267678)).toBe(true);
    expect(october.some((point) => point.monthlySales === 999999)).toBe(false);
    expect(result.series.find((point) => point.date === "2023-05")?.monthlySales).toBe(6310);
    expect(result.metrics).toContain("reviewRate");
    expect(result.metrics).toContain("reviewGrowth");
  });

  it("序列组装：月表点与悬停点并存；同一日期多次悬停只保留最早读数并计数", () => {
    const result = buildSellerSpriteHistorySeries(rawDrawer({
      tooltipTexts: [REAL_TOOLTIP_1, REAL_TOOLTIP_2, REAL_TOOLTIP_1, "2026-07-30 18:02\n价格 $18.00"],
    }));
    expect(result.accepted).toBe(true);
    expect(result.monthlyPoints).toBe(25);
    expect(result.eventPoints).toBe(2);
    expect(result.sameDateVariants).toBe(1);
    expect(result.monthlyRange).toEqual({ from: "2024-10", to: "2026-10", count: 25 });
    expect(result.eventRange).toEqual({ from: "2026-07-30", to: "2026-08-09", count: 2 });
    expect(result.series.find((point) => point.date === "2026-07-30")?.price).toBe(17.04);
    expect(result.metrics).toContain("monthlySales");
    expect(result.metrics).toContain("rating");
  });

  it("没有任何可验证点时如实拒绝，不生成空成功", () => {
    const result = buildSellerSpriteHistorySeries(rawDrawer({ monthTableGroups: [], labelRows: [], activeTab: "销量趋势" }));
    expect(result.accepted).toBe(false);
    expect(result.rejection).toBe("SELLERSPRITE_HISTORY_NO_VERIFIED_POINTS");
    expect(result.points).toBe(0);
  });

  it("月份跨度超过 3 年的表整表拒绝", () => {
    const months = ["2022-01", "2022-02", "2022-03", ...REAL_MONTHS];
    const table: SellerSpriteHistoryMonthTable = { months, rows: [{ label: "月销量", values: months.map(() => "1") }] };
    const result = parseSellerSpriteHistoryMonthTables([table]);
    expect(result.points).toEqual([]);
  });
});
