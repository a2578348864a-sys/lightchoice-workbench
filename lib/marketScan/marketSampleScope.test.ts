/**
 * MarketScan 样本范围投影（P2）。
 *
 * 重点：技术有效数量与「符合研究范围」数量必须分开；没有正式范围规则时全部保持待人工核实，
 * 不得用 0 或全量冒充已核实，也不得把 validSampleCount 当成直接竞品数量。
 */
import { describe, expect, it } from "vitest";
import { buildMarketSampleScope } from "@/lib/marketScan/marketSampleScope";
import type { MarketScopeAnalysisV1 } from "@/lib/marketScan/marketScopeAnalysis";

/** 真实收纳箱 MarketScan 锁定样本（Amazon Search · 收纳盒 · 2026/10/17，30 件）的 ASIN 与标题。 */
const REAL_STORAGE_BIN_SAMPLE: ReadonlyArray<readonly [string, string]> = [
  ["B002BA5F52", "Sterilite Ultra Latch Box with Lids for Home and Office, 18 Quart, 6-Pack"],
  ["B071225BBS", "Amazon Basics Collapsible Fabric Storage Cubes Organizer with Handles, Sturdy, Foldable, Space-Saving, 10.5\"x10.5\"x11\", Gray, 6-Pack"],
  ["B07PR9NM54", "Rubbermaid Cleverstore 95 Qt Clear Storage Bins with Lids, 4-Pack, Stackable, BPA-Free, Made in USA"],
  ["B07TPRTV6P", "joyoldelf Sock Drawer Organizer Divider 2 Packs Underwear Organizer, 24 Cell Closet Organizers and Storage Organizer Sock Holders Organizers for Storing Socks, Handkerchiefs, Ties, Belts (Grey)"],
  ["B082VWSMCB", "HOMZ Clear Plastic Storage Bin with Secure Latching Gray Lid, 64 Qt, 2 Pack"],
  ["B085ZV98JM", "90L Large Storage Bags, 6 Pack Clothes Storage Bins Closet Organizers"],
  ["B08KXKVT4K", "Vtopmart 25 PCS Clear Plastic Drawer Organizers Set, 4-Size Versatile Bathroom and Vanity Drawer Organizer Trays, Storage Bins for Makeup, Bedroom, Kitchen Gadgets Utensils and Office"],
  ["B09F32F4TR", "Bagnizer Large 22 Quart Linen Fabric Foldable Storage Bin Cube Organizer Basket with Flip-Top Lid & Handles, Clothes Blanket Box for Home, Office, Closet, Gray, 4 Pack 14.6 x 9.5 x 9.5”"],
  ["B09TB8WFXC", "HomeHacks 3-Pack Clothes Organizer Storage Bags, 35L Storage Bins, Gray"],
  ["B09ZV2TX28", "Lifewit 6 Pack Clothes Storage Bins with Lids, Foldable Blanket Storage Bags with Zippers, Clear Window and Reinforced Handles, Closet and Organization for Clothing, Sweater, Comforter, Bedding"],
  ["B0B1DG8D3W", "JessLab Acrylic Makeup Organizer, 1-Compartment Clear Bathroom Drawer Tray"],
  ["B0B1DHPP98", "JessLab Acrylic Makeup Organizer, 3-Compartment Clear Bathroom Drawer Tray"],
  ["B0B93HTY9Y", "Pantry Organization and Storage Bins with Dividers Kitchen Organizer 2 Pack"],
  ["B0BVQ69QJD", "WYT Clear Storage Latch Bins, 6-Pack Storage Organizer Box with Handle and Lids, 5-Litre"],
  ["B0C57FV4JS", "Clear Plastic Storage Bins, Pantry Organizers and Storage or Kitchen Organization and Storage Containers Bins for Organizing, Fridge, Freezer, Bathroom, Pantries, Refrigerator, Cabinet Organizer Bin"],
  ["B0C5C9BFXM", "Large Thick Clear Shoe Organizer, Magnetic Door Stackable Shoe Storage Box"],
  ["B0CDXLYN2W", "Vtopmart Clear Stackable Storage Drawers, 2 Pack Wide Plastic Organizers"],
  ["B0CG5FZZCR", "TYMENSH Over the Door Organizer for Bedroom Bathroom Pantry, 5 Shelf Black"],
  ["B0CGXT9PGR", "ClearSpace Heavy Duty Moving Bags - Water Resistant Storage Bags with Backpack Straps, Zippers and Handles - Large Moving Boxes for College Dorm, Travel, Closet Organization - 6 Pack, Clear"],
  ["B0CHYHTH2L", "6 Pack Clear Drawer Organizer Set, Drawer Storage Trays, Storage Bins"],
  ["B0CJ5DPB8D", "Mathtoxyz Bead Organizer Box, 30Pcs Small Beads Organizers and Storage Plastic Cases Mini Clear Dimond Storage Containers Boxes with Hinged Lid and Rectangle for Bracelet Making DIY Jewelry Craft Nail"],
  ["B0DDT9XFRB", "Storage Bins with Handles,Grey and Beige,10.2x7.9x6.7in,1 Pack"],
  ["B0DHGM5XT4", "Criusia Drawer Organizer Clothes, 10 Pack Dresser Organizer for Baby Clothes, Underwear, Sock- Foldable Closet Organization and Storage Dividers Bins for Nursery, Bedroom (Beige)"],
  ["B0DKHZ1JLG", "NaturalCozy 11.8\"x8\"x4.5” Storage Baskets for Shelves 3 Pack | Cotton Rope Woven Small Baskets for Organizing | Small Storage Bins for Nursery, Bathroom, Closet, Cube Shelf, Decorative, Gift Basket"],
  ["B0DMVX69PW", "BALEINE 1 Pack Fabric Closet Storage Bins for Shelves, Linen Closet Organizers and Storage, Decorative Baskets for Organizing, Shelf, Clothes, Home, Office (Grey, 12\"x8\"x8\")"],
  ["B0F1HXGW42", "IRIS USA Storage Bins with Lids |Made in USA| 2 Qt - (6-Pack) - Clear"],
  ["B0F8HLC5KP", "Small Foldable Fabric Drawer Organizer 3-Pack - 11\" Breathable Closet & Dresser Storage Bins for Underwear, Socks, Baby Clothes & Bras, Grey"],
  ["B0FHQFBTN8", "SNSLXH 4-Tier Clear Makeup Organizer Bathroom Storage"],
  ["B0GFDKH1HD", "Comforter Storage Bag 2-Pack Self Compression Organizer,22 Gallons"],
  ["B0GPSS6RQ7", "IRIS USA 4-Pack 55 Quart Clip Box with Latching Lid"],
];

const storageBinItems = REAL_STORAGE_BIN_SAMPLE.map(([asin, title]) => ({ asin, title }));

function confirmedTopicAnalysis(overrides: Partial<MarketScopeAnalysisV1> = {}): MarketScopeAnalysisV1 {
  return {
    version: "market-scope-analysis.v1",
    basis: "FROZEN_MARKETSCAN_TITLE_ONLY",
    sampleHash: "a".repeat(64),
    totalCount: 3,
    counts: { IN_SCOPE: 2, OUT_OF_SCOPE: 1, UNCERTAIN: 0 },
    strictComparability: { status: "NOT_ESTABLISHED", reason: "尺寸与垫型未统一" },
    items: [],
    listingPrice: {
      status: "NO_VALID_PRICES", currency: null, sampleCount: 0, missingCount: 0,
      min: null, median: null, max: null, basis: "OBSERVED_LISTING_PRICE_NOT_UNIT_PRICE",
    },
    fieldCoverage: {
      title: { presentCount: 3, missingCount: 0, totalCount: 3 },
      brand: { presentCount: 3, missingCount: 0, totalCount: 3 },
      category: { presentCount: 0, missingCount: 3, totalCount: 3 },
      price: { presentCount: 3, missingCount: 0, totalCount: 3 },
      rating: { presentCount: 3, missingCount: 0, totalCount: 3 },
      reviewCount: { presentCount: 3, missingCount: 0, totalCount: 3 },
      bsr: { presentCount: 0, missingCount: 3, totalCount: 3 },
      monthlySalesEstimate: { presentCount: 0, missingCount: 3, totalCount: 3 },
      monthlyRevenueEstimate: { presentCount: 0, missingCount: 3, totalCount: 3 },
      launchedDate: { presentCount: 0, missingCount: 3, totalCount: 3 },
    },
    limits: [],
    ...overrides,
  };
}

describe("buildMarketSampleScope", () => {
  it("真实收纳箱混合样本：技术有效 30 件，但范围归属全部待人工核实", () => {
    const scope = buildMarketSampleScope({
      nicheDefinition: { label: "Amazon Search · 收纳盒 · 2026/10/17 市场研究" },
      items: storageBinItems,
      technicallyValidCount: 30,
    });

    expect(scope.basis).toBe("TITLE_SUBTYPE_ONLY");
    expect(scope.counts.raw).toBe(30);
    expect(scope.counts.technicallyValid).toBe(30);
    // 没有正式范围规则：不得给出 in/out 数量
    expect(scope.counts.inScope).toBeNull();
    expect(scope.counts.outOfScope).toBeNull();
    expect(scope.counts.unknown).toBe(30);
    expect(scope.manualReviewRequired).toBe(true);

    // 标题子类型分布可用于人工筛选，但不得冒充范围判定
    const byId = new Map(scope.subtypeGroups.map((group) => [group.id, group.count]));
    expect(byId.get("hard_plastic_bin") ?? 0).toBeGreaterThanOrEqual(3);
    expect(scope.subtypeGroups.reduce((sum, group) => sum + group.count, 0)).toBe(30);

    const text = [...scope.notes, ...scope.limitations].join(" ");
    expect(text).toContain("待人工核实");
    expect(text).toContain("不等于同质竞品数量");
  });

  it("已有专项范围规则的品类：直接沿用其 IN/OUT/UNCERTAIN 计数", () => {
    const scope = buildMarketSampleScope({
      nicheDefinition: { label: "silicone baking mat" },
      items: [
        { asin: "B0A", title: "Silicone Baking Mat for Oven" },
        { asin: "B0B", title: "Silicone Baking Mat Nonstick" },
        { asin: "B0C", title: "Silicone Countertop Placemat" },
      ],
      technicallyValidCount: 3,
      marketScopeAnalysis: confirmedTopicAnalysis(),
    });

    expect(scope.basis).toBe("CONFIRMED_TOPIC_SCOPE");
    expect(scope.counts).toEqual({ raw: 3, technicallyValid: 3, inScope: 2, outOfScope: 1, unknown: 0 });
    expect(scope.notes.join(" ")).toContain("专项范围规则");
  });

  it("未知商品类型：不套用其它品类规则，全部保持待人工核实", () => {
    const scope = buildMarketSampleScope({
      nicheDefinition: { label: "garden hose reel" },
      items: [
        { asin: "B0X1", title: "Garden Hose Reel Cart with Wheels" },
        { asin: "B0X2", title: "Expandable Garden Hose 50ft" },
      ],
      technicallyValidCount: 2,
    });

    expect(scope.basis).toBe("TITLE_SUBTYPE_ONLY");
    expect(scope.counts.inScope).toBeNull();
    expect(scope.counts.unknown).toBe(2);
    expect(scope.manualReviewRequired).toBe(true);
    // 不得凭空产生「硬质塑料箱」或烘焙垫分类
    expect(scope.subtypeGroups.some((group) => group.id === "hard_plastic_bin" && group.count > 0)).toBe(false);
  });

  it("标题全部缺失：降级为 UNAVAILABLE，不推断任何类型", () => {
    const scope = buildMarketSampleScope({
      nicheDefinition: { label: "收纳盒" },
      items: [
        { asin: "B0N1", title: null },
        { asin: "B0N2", title: "" },
      ],
      technicallyValidCount: 2,
    });

    expect(scope.basis).toBe("UNAVAILABLE");
    expect(scope.counts.unknown).toBe(2);
    expect(scope.counts.inScope).toBeNull();
    expect(scope.dominantSubtype).toBeNull();
  });

  it("技术有效数量不得超过原始样本数，也不得被范围投影改写", () => {
    const scope = buildMarketSampleScope({
      nicheDefinition: { label: "收纳盒" },
      items: storageBinItems.slice(0, 5),
      technicallyValidCount: 99,
    });
    expect(scope.counts.raw).toBe(5);
    expect(scope.counts.technicallyValid).toBe(5);
  });
});
