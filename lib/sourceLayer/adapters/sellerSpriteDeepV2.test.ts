import { describe, expect, it } from "vitest";
import {
  sellerSpriteAdapter,
  buildSellerSpriteMarketShareAttachment,
} from "@/lib/sourceLayer/adapters/sellerSpriteAdapter";
import {
  createSourceLayerTestWorkbook,
  SOURCE_LAYER_TEST_HEADERS,
} from "@/lib/sourceLayer/adapters/__fixtures__/sellerSpriteWorkbook";
import {
  adaptEvidenceToProductFact,
  concentrationFromMarketShareAttachment,
  withMarketConcentration,
  withVariationAnalysis,
} from "@/lib/sourceLayer/fact/productFactAdapter";

const NOW = "2026-09-25T12:00:00.000Z";

function createMultiSheetTestWorkbook(): Uint8Array {
  const usHeaders = [
    ...SOURCE_LAYER_TEST_HEADERS,
    "子体销量",
    "子体销售额($)",
    "卖家所属地",
    "秒杀",
  ];

  const usRows = [
    {
      ASIN: "B0DEEP0001",
      "商品标题": "Owala FreeSip Stainless Steel Water Bottle, 24 oz, Shy Marshmallow",
      "商品详情页链接": "https://www.amazon.com/dp/B0DEEP0001",
      "商品主图": "https://m.media-amazon.com/images/I/deep-1.jpg",
      "搜索排名": "自然位：第1页第1位",
      "大类目": "Sports & Outdoors",
      "大类BSR": "50",
      "小类BSR": "5",
      "月销量": "1000",
      "月销售额($)": "25000",
      "价格($)": "25.00",
      "评分": "4.8",
      "评分数": "5000",
      "品牌": "Owala",
      "包装重量（单位换算）": "1.2 lb",
      "包装尺寸（单位换算）": "10 x 4 x 4 in",
      "商品重量（单位换算）": "0.9 lb",
      "商品尺寸（单位换算）": "9 x 3 x 3 in",
      "上架时间": "2024-01-01",
      "Buybox卖家": "Owala Official",
      "配送方式": "FBA",
      "预估FBA费": "$4.50",
      "毛利率": "40.0%",
      "LQS评分": "9.2",
      "未映射原始列": "preserved",
      "子体销量": "600",
      "子体销售额($)": "15000",
      "卖家所属地": "CN",
      "秒杀": "Lightning Deal",
    },
    {
      ASIN: "B0DEEP0002",
      "商品标题": "Owala FreeSip Stainless Steel Water Bottle, 24 oz, Retro Boardwalk",
      "商品详情页链接": "https://www.amazon.com/dp/B0DEEP0002",
      "商品主图": "https://m.media-amazon.com/images/I/deep-2.jpg",
      "搜索排名": "自然位：第1页第2位",
      "大类目": "Sports & Outdoors",
      "大类BSR": "150",
      "小类BSR": "12",
      "月销量": "1000",
      "月销售额($)": "25000",
      "价格($)": "25.00",
      "评分": "4.7",
      "评分数": "1200",
      "品牌": "Owala",
      "包装重量（单位换算）": "1.2 lb",
      "包装尺寸（单位换算）": "10 x 4 x 4 in",
      "商品重量（单位换算）": "0.9 lb",
      "商品尺寸（单位换算）": "9 x 3 x 3 in",
      "上架时间": "2024-03-01",
      "Buybox卖家": "Example Seller",
      "配送方式": "FBA",
      "预估FBA费": "$4.50",
      "毛利率": "38.0%",
      "LQS评分": "8.8",
      "未映射原始列": "preserved",
      "子体销量": "80",
      "子体销售额($)": "2000",
      "卖家所属地": "US",
      "秒杀": "",
    },
  ];

  const brandHeaders = ["品牌", "市场份额"];
  const brandRows = [
    { "品牌": "Owala", "市场份额": "30.0%" },
    { "品牌": "Hydro Flask", "市场份额": "20.0%" },
    { "品牌": "Stanley", "市场份额": "15.0%" },
    { "品牌": "Yeti", "市场份额": "10.0%" },
    { "品牌": "Contigo", "市场份额": "5.0%" },
    { "品牌": "CamelBak", "市场份额": "3.0%" },
  ];

  const sellerHeaders = ["卖家", "市场份额"];
  const sellerRows = [
    { "卖家": "Amazon.com", "市场份额": "22.5%" },
    { "卖家": "Owala Official", "市场份额": "18.0%" },
    { "卖家": "Example Seller", "市场份额": "5.0%" },
  ];

  return createSourceLayerTestWorkbook({
    headers: usHeaders,
    rows: usRows,
    sheetName: "US",
    extraSheets: [
      { name: "Brands", headers: brandHeaders, rows: brandRows },
      { name: "Sellers", headers: sellerHeaders, rows: sellerRows },
    ],
  });
}

describe("SellerSprite Deep Adapter V2 Multi-Sheet", () => {
  it("extracts variation sales share, dominance, and multi-sheet market concentration", () => {
    const workbook = createMultiSheetTestWorkbook();
    const captured = sellerSpriteAdapter.capture({
      payload: workbook,
      capturedAt: NOW,
      operator: "owner:v5",
    });

    expect(captured.drafts).toHaveLength(2);

    // ASIN 1: Dominant variation (600 / 1000 = 0.60)
    const draft1 = captured.drafts[0];
    expect(draft1.fields.asin.value).toBe("B0DEEP0001");
    expect(draft1.extensions?.childSales).toBe(600);
    expect(draft1.extensions?.childRevenue).toBe(15000);
    expect(draft1.extensions?.currentAsinSalesShare).toBe(0.6);
    expect(draft1.extensions?.isDominantVariation).toBe(true);
    expect(draft1.extensions?.isMinorVariation).toBe(false);
    expect(draft1.extensions?.dealBadge).toBe("Lightning Deal");
    expect(draft1.extensions?.sellerLocation).toBe("CN");

    // Multi-sheet concentration checks
    // Top 5 Brands: 30% + 20% + 15% + 10% + 5% = 80% (0.8)
    expect(draft1.extensions?.brandCr5Share).toBe(0.8);
    // Amazon 1P Share: 22.5% (0.225)
    expect(draft1.extensions?.amazon1pShare).toBe(0.225);
    // Seller Owala Official: 18.0% (0.18)
    expect(draft1.extensions?.sellerMarketShare).toBe(0.18);
    // 1 CN out of 2 sellers = 50% (0.5)
    expect(draft1.extensions?.sellerOriginDomesticRatio).toBe(0.5);

    // ASIN 2: Minor variation (80 / 1000 = 0.08)
    const draft2 = captured.drafts[1];
    expect(draft2.fields.asin.value).toBe("B0DEEP0002");
    expect(draft2.extensions?.childSales).toBe(80);
    expect(draft2.extensions?.childRevenue).toBe(2000);
    expect(draft2.extensions?.currentAsinSalesShare).toBe(0.08);
    expect(draft2.extensions?.isDominantVariation).toBe(false);
    expect(draft2.extensions?.isMinorVariation).toBe(true);
    expect(draft2.extensions?.dealBadge).toBeNull();
    expect(draft2.extensions?.sellerLocation).toBe("US");
    expect(draft2.extensions?.sellerMarketShare).toBe(0.05);
  });

  it("normalizes, validates, and creates evidence with V5.1 extensions", () => {
    const workbook = createMultiSheetTestWorkbook();
    const captured = sellerSpriteAdapter.capture({
      payload: workbook,
      capturedAt: NOW,
      operator: "owner:v5",
    });
    const draft = captured.drafts[0];
    const pkg = sellerSpriteAdapter.normalize({
      draft,
      captureId: "cap-ss-deep-v2",
      version: 1,
    });
    expect(pkg.extensions?.childSales).toBe(600);
    expect(pkg.extensions?.brandCr5Share).toBe(0.8);

    const validation = sellerSpriteAdapter.validate({ pkg, context: { now: NOW } });
    expect(["passed", "needs_review"]).toContain(validation.report.verdict);

    const evidence = sellerSpriteAdapter.createEvidence({
      pkg: validation.pkg,
      report: validation.report,
    });
    expect(evidence.sourceType).toBe("sellersprite_xlsx");
    expect(evidence.pkg.extensions?.currentAsinSalesShare).toBe(0.6);
    expect(evidence.pkg.extensions?.amazon1pShare).toBe(0.225);
  });

  it("projects variationAnalysis and concentration into ProductFact", () => {
    const workbook = createMultiSheetTestWorkbook();
    const captured = sellerSpriteAdapter.capture({
      payload: workbook,
      capturedAt: NOW,
      operator: "owner:v5",
    });
    const draft = captured.drafts[0];
    const pkg = sellerSpriteAdapter.normalize({
      draft,
      captureId: "cap-ss-deep-v2-fact",
      version: 1,
    });
    const validation = sellerSpriteAdapter.validate({ pkg, context: { now: NOW } });
    const evidence = sellerSpriteAdapter.createEvidence({
      pkg: validation.pkg,
      report: validation.report,
    });

    const fact = adaptEvidenceToProductFact({ evidence });

    // Variation Analysis
    expect(fact.variationAnalysis).toBeDefined();
    expect(fact.variationAnalysis?.childSales).toMatchObject({
      value: 600,
      status: "present",
      metricNature: "estimate",
    });
    expect(fact.variationAnalysis?.parentTotalSales).toMatchObject({
      value: 1000,
      status: "present",
    });
    expect(fact.variationAnalysis?.currentAsinSalesShare).toMatchObject({
      value: 0.6,
      status: "present",
      metricNature: "derived",
    });
    expect(fact.variationAnalysis?.isDominantVariation).toMatchObject({
      value: true,
      status: "present",
      metricNature: "derived",
    });
    expect(fact.variationAnalysis?.isMinorVariation).toMatchObject({
      value: false,
      status: "present",
      metricNature: "derived",
    });

    // Market Concentration
    expect(fact.concentration).toBeDefined();
    expect(fact.concentration?.brandCr5Share).toMatchObject({
      value: 0.8,
      status: "present",
      metricNature: "derived",
    });
    expect(fact.concentration?.amazon1pShare).toMatchObject({
      value: 0.225,
      status: "present",
      metricNature: "derived",
    });
    expect(fact.concentration?.sellerMarketShare).toMatchObject({
      value: 0.18,
      status: "present",
      metricNature: "derived",
    });
    expect(fact.concentration?.sellerOriginDomesticRatio).toMatchObject({
      value: 0.5,
      status: "present",
      metricNature: "derived",
    });
  });

  it("builds and rehydrates sellersprite_market_share_v1 attachment", () => {
    const attachment = buildSellerSpriteMarketShareAttachment({
      subjectKey: "amazon:US:B0DEEP0001",
      asin: "B0DEEP0001",
      brandCr5Share: 0.8,
      amazon1pShare: 0.225,
      sellerMarketShare: 0.18,
      sellerOriginDomesticRatio: 0.5,
      capturedAt: NOW,
    });

    expect(attachment.kind).toBe("sellersprite_market_share_v1");
    expect(attachment.sourceType).toBe("sellersprite_xlsx");
    expect(attachment.payload.schema).toBe("sellersprite-market-share-attachment.v1");

    const rehydrated = concentrationFromMarketShareAttachment(attachment.payload);
    expect(rehydrated).toEqual({
      brandCr5Share: 0.8,
      amazon1pShare: 0.225,
      sellerMarketShare: 0.18,
      sellerOriginDomesticRatio: 0.5,
    });
  });

  it("handles single-sheet workbook without Brands/Sellers gracefully", () => {
    const singleSheetWorkbook = createSourceLayerTestWorkbook();
    const captured = sellerSpriteAdapter.capture({
      payload: singleSheetWorkbook,
      capturedAt: NOW,
      operator: "owner:v5",
    });

    const draft = captured.drafts[0];
    expect(draft.extensions?.brandCr5Share).toBeNull();
    expect(draft.extensions?.amazon1pShare).toBeNull();
    expect(draft.extensions?.sellerMarketShare).toBeNull();

    const pkg = sellerSpriteAdapter.normalize({ draft, captureId: "cap-ss-single", version: 1 });
    const validation = sellerSpriteAdapter.validate({ pkg, context: { now: NOW } });
    const evidence = sellerSpriteAdapter.createEvidence({ pkg: validation.pkg, report: validation.report });
    const fact = adaptEvidenceToProductFact({ evidence });

    // Single sheet workbook doesn't have variation sales or concentration data
    expect(fact.concentration).toBeUndefined();
    expect(fact.variationAnalysis).toBeUndefined();
    expect(fact.basic.asin.value).toBe("B0FH1ZXTN1");
  });
});
