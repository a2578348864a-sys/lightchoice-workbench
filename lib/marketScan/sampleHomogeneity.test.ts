import { describe, expect, it } from "vitest";

import {
  analyzeSampleHomogeneity,
  classifySampleTitle,
  filterSamplesBySubtype,
} from "@/lib/marketScan/sampleHomogeneity";

/** 真实「收纳盒」批次（30 款）的标题快照，用于回归分类规则。 */
const REAL_TITLES: Array<{ asin: string; title: string }> = [
  { asin: "B09ZV2TX28", title: "Lifewit 6 Pack Clothes Storage Bins with Lids, Foldable Blanket Storage Bags with Handles" },
  { asin: "B071225BBS", title: "Amazon Basics Collapsible Fabric Storage Cubes Organizer with Handles, Sturdy" },
  { asin: "B08KXKVT4K", title: "Vtopmart 25 PCS Clear Plastic Drawer Organizers Set, 4-Size Versatile Bathroom and" },
  { asin: "B0GPSS6RQ7", title: "IRIS USA 4-Pack 55 Quart Clip Box with Latching Lid" },
  { asin: "B09F32F4TR", title: "Bagnizer Large 22 Quart Linen Fabric Foldable Storage Bin Cube Organizer Basket" },
  { asin: "B0B93HTY9Y", title: "Pantry Organization and Storage Bins with Dividers Kitchen Organizer 2 Pack" },
  { asin: "B0C57FV4JS", title: "Clear Plastic Storage Bins, Pantry Organizers and Storage or Kitchen Organization" },
  { asin: "B082VWSMCB", title: "HOMZ Clear Plastic Storage Bin with Secure Latching Gray Lid, 64 Qt, 2 Pack" },
  { asin: "B0DHGM5XT4", title: "Criusia Drawer Organizer Clothes, 10 Pack Dresser Organizer for Baby Clothes" },
  { asin: "B085ZV98JM", title: "90L Large Storage Bags, 6 Pack Clothes Storage Bins Closet Organizers" },
  { asin: "B0CG5FZZCR", title: "TYMENSH Over the Door Organizer for Bedroom Bathroom Pantry, 5 Shelf Black" },
  { asin: "B07PR9NM54", title: "Rubbermaid Cleverstore 95 Qt Clear Storage Bins with Lids, 4-Pack, Stackable" },
  { asin: "B0DDT9XFRB", title: "Storage Bins with Handles,Grey and Beige,10.2x7.9x6.7in,1 Pack" },
  { asin: "B0C5C9BFXM", title: "Large Thick Clear Shoe Organizer, Magnetic Door Stackable Shoe Storage Box" },
  { asin: "B0F8HLC5KP", title: "Small Foldable Fabric Drawer Organizer 3-Pack - 11\" Breathable Closet & Dresser" },
  { asin: "B0DMVX69PW", title: "BALEINE 1 Pack Fabric Closet Storage Bins for Shelves, Linen Closet Organizers" },
  { asin: "B0DKHZ1JLG", title: "NaturalCozy 11.8\"x8\"x4.5\" Storage Baskets for Shelves 3 Pack, Cotton Rope Woven" },
  { asin: "B0CGXT9PGR", title: "ClearSpace Heavy Duty Moving Bags - Water Resistant Storage Bags with Backpack" },
  { asin: "B0FHQFBTN8", title: "SNSLXH 4-Tier Clear Makeup Organizer Bathroom Storage" },
  { asin: "B0GFDKH1HD", title: "Comforter Storage Bag 2-Pack Self Compression Organizer,22 Gallons" },
  { asin: "B0CJ5DPB8D", title: "Mathtoxyz Bead Organizer Box, 30Pcs Small Beads Organizers and Storage Plastic" },
  { asin: "B0BVQ69QJD", title: "WYT Clear Storage Latch Bins, 6-Pack Storage Organizer Box with Handle and Lids" },
  { asin: "B09TB8WFXC", title: "HomeHacks 3-Pack Clothes Organizer Storage Bags, 35L Storage Bins, Gray" },
  { asin: "B0CHYHTH2L", title: "6 Pack Clear Drawer Organizer Set, Drawer Storage Trays, Storage Bins" },
  { asin: "B0CDXLYN2W", title: "Vtopmart Clear Stackable Storage Drawers, 2 Pack Wide Plastic Organizers" },
  { asin: "B0B1DG8D3W", title: "JessLab Acrylic Makeup Organizer, 1-Compartment Clear Bathroom Drawer Tray" },
  { asin: "B0B1DHPP98", title: "JessLab Acrylic Makeup Organizer, 3-Compartment Clear Bathroom Drawer Tray" },
  { asin: "B0F1HXGW42", title: "IRIS USA Storage Bins with Lids |Made in USA| 2 Qt - (6-Pack) - Clear" },
  { asin: "B002BA5F52", title: "Sterilite Ultra Latch Box with Lids for Home and Office, 18 Quart, 6-Pack" },
  { asin: "B07TPRTV6P", title: "joyoldelf Sock Drawer Organizer Divider 2 Packs Underwear Organizer, 24 Cell" },
];

describe("样本子类型确定性识别", () => {
  it("按用途把 30 款真实标题分成多个细分类型，不产生 unknown", () => {
    const report = analyzeSampleHomogeneity(REAL_TITLES);
    expect(report.total).toBe(30);
    expect(report.unknownCount).toBe(0);
    expect(report.groups.length).toBeGreaterThanOrEqual(5);
  });

  it("具体用途优先于通用形态（抽屉 / 鞋盒 / 化妆 / 珠串 / 搬家 / 门后）", () => {
    expect(classifySampleTitle(REAL_TITLES[2]!.title).subtype).toBe("drawer_organizer");
    expect(classifySampleTitle(REAL_TITLES[8]!.title).subtype).toBe("drawer_organizer");
    expect(classifySampleTitle(REAL_TITLES[13]!.title).subtype).toBe("shoe_box");
    expect(classifySampleTitle(REAL_TITLES[18]!.title).subtype).toBe("makeup_bathroom");
    expect(classifySampleTitle(REAL_TITLES[20]!.title).subtype).toBe("bead_craft");
    expect(classifySampleTitle(REAL_TITLES[17]!.title).subtype).toBe("moving_bag");
    expect(classifySampleTitle(REAL_TITLES[10]!.title).subtype).toBe("door_hanging");
    expect(classifySampleTitle(REAL_TITLES[5]!.title).subtype).toBe("pantry_kitchen");
    expect(classifySampleTitle(REAL_TITLES[0]!.title).subtype).toBe("fabric_soft");
    expect(classifySampleTitle(REAL_TITLES[3]!.title).subtype).toBe("hard_plastic_bin");
  });

  it("混杂风险为 high，且不把最大类型当作整体代表", () => {
    const report = analyzeSampleHomogeneity(REAL_TITLES);
    expect(report.mixedRisk).toBe("high");
    expect(report.dominantShare).toBeLessThan(0.5);
    expect(report.headline).toMatch(/最大同类/u);
    expect(report.caveats.join(" ")).toMatch(/不能直接当作某一具体产品的确定结论/u);
  });

  it("标题缺失或无法识别时保留 unknown，不强行归类", () => {
    expect(classifySampleTitle(null).subtype).toBe("unknown");
    expect(classifySampleTitle("   ").subtype).toBe("unknown");
    expect(classifySampleTitle("Generic Product 12345").subtype).toBe("unknown");
    const report = analyzeSampleHomogeneity([
      { asin: "A1", title: "Storage Bins with Lids" },
      { asin: "A2", title: null },
    ]);
    expect(report.unknownCount).toBe(1);
    expect(report.caveats.join(" ")).toMatch(/待人工确认/u);
  });

  it("记录命中片段与竞争类型，便于人工复核", () => {
    const result = classifySampleTitle("Small Foldable Fabric Drawer Organizer 3-Pack");
    expect(result.subtype).toBe("drawer_organizer");
    expect(result.matchedSignals.length).toBeGreaterThan(0);
    expect(result.competingSubtypes).toContain("fabric_soft");
  });

  it("类型筛选只影响列表视图，不改变报告与统计输入", () => {
    const report = analyzeSampleHomogeneity(REAL_TITLES);
    const filtered = filterSamplesBySubtype(REAL_TITLES, report.assignments, "shoe_box");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.asin).toBe("B0C5C9BFXM");
    expect(report.total).toBe(30);
    expect(report.groups.reduce((sum, group) => sum + group.count, 0)).toBe(30);
  });

  it("样本过少时不给出 high 风险结论", () => {
    const report = analyzeSampleHomogeneity([{ asin: "A1", title: "Storage Bins with Lids" }]);
    expect(report.mixedRisk).toBe("insufficient");
  });
});
