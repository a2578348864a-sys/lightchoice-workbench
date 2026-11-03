import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResearchProductFactsCard } from "@/components/research/ResearchProductFactsCard";

const citation = (refId: string, source: "amazon_dom" | "sellersprite_xlsx" = "amazon_dom", capturedAt = "2026-10-15T12:00:00.000Z") => ({
  refId,
  source,
  capturedAt,
});

function render(facts: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(ResearchProductFactsCard, { facts: facts as never }));
}

describe("ResearchProductFactsCard", () => {
  it("labels item measurements explicitly and shows their source citations", () => {
    const html = render({
      brand: "Example Brand",
      price: 19.99,
      currency: "USD",
      rating: 4.7,
      reviewCount: 25,
      mainCategory: "Home & Kitchen",
      itemDimensions: { length: 10, width: 6, height: 2, unit: "in" },
      itemWeight: { value: 9.5, unit: "oz" },
      material: null,
      bulletPoints: [],
      fieldEvidence: {
        itemDimensions: [citation("attachment:item-dimensions")],
        itemWeight: [citation("attachment:item-weight")],
      },
      conflicts: [],
      variationStructure: null,
    });

    expect(html).toContain("商品本体尺寸");
    expect(html).toContain("10 × 6 × 2 in");
    expect(html).toContain("商品本体重量");
    expect(html).toContain("9.5 oz");
    expect(html).toContain("attachment:item-dimensions");
    expect(html).toContain("attachment:item-weight");
    expect(html).not.toContain("18 × 12 × 4");
    expect(html).not.toContain("2.2 lb");
    expect(html).not.toContain("尺寸与重量");
  });

  it("shows an unresolved review-count conflict as unknown while showing both candidate observations", () => {
    const html = render({
      brand: null,
      price: null,
      currency: null,
      rating: null,
      reviewCount: null,
      mainCategory: null,
      itemDimensions: null,
      itemWeight: null,
      material: null,
      bulletPoints: [],
      fieldEvidence: {},
      conflicts: [{
        field: "basic.reviewCount",
        code: "SOURCE_CONFLICT_UNRESOLVED",
        resolved: false,
        candidateSources: ["amazon_dom", "sellersprite_xlsx"],
        candidates: [
          { source: "amazon_dom", value: 3, capturedAt: "2026-10-15T12:00:00.000Z", evidenceRefs: [citation("attachment:review-a")] },
          { source: "sellersprite_xlsx", value: 3354, capturedAt: "2026-10-14T12:00:00.000Z", evidenceRefs: [citation("attachment:review-b", "sellersprite_xlsx", "2026-10-14T12:00:00.000Z")] },
        ],
        evidenceRefs: [citation("attachment:review-a"), citation("attachment:review-b")],
      }],
      variationStructure: null,
    });

    expect(html.replace(/<[^>]*>/gu, "")).toContain("评价数来源冲突，暂不显示数值");
    expect(html.replace(/<[^>]*>/gu, "")).toContain("评价数 · 来源冲突尚未解决");
    expect(html.replace(/<[^>]*>/gu, "")).toContain("来源冲突尚未解决");
    expect(html.replace(/<[^>]*>/gu, "")).toContain("来源：amazon_dom");
    expect(html.replace(/<[^>]*>/gu, "")).toContain("来源：sellersprite_xlsx");
    expect(html.replace(/<[^>]*>/gu, "")).toContain("候选值：3");
    expect(html.replace(/<[^>]*>/gu, "")).toContain("候选值：3354");
    expect(html.replace(/<[^>]*>/gu, "")).toContain("2026-10-15T12:00:00.000Z");
    expect(html.replace(/<[^>]*>/gu, "")).toContain("2026-10-14T12:00:00.000Z");
    expect(html).toContain("attachment:review-a");
    expect(html).toContain("attachment:review-b");
    expect(html).not.toContain(">3 条<");
    expect(html).not.toContain("3,354 条");
  });

  it("marks a conflicted item measurement as unknown instead of showing a winner", () => {
    const html = render({
      itemDimensions: null,
      fieldEvidence: {},
      conflicts: [{
        field: "profit.itemDimensions",
        code: "SOURCE_CONFLICT_UNRESOLVED",
        resolved: false,
        candidateSources: ["amazon_dom", "sellersprite_xlsx"],
        candidates: [
          { source: "amazon_dom", value: { length: 10, width: 6, unit: "in" }, capturedAt: "2026-10-15T12:00:00.000Z", evidenceRefs: [citation("attachment:dimensions-amazon")] },
          { source: "sellersprite_xlsx", value: { length: 9, width: 6, unit: "in" }, capturedAt: "2026-10-14T12:00:00.000Z", evidenceRefs: [citation("attachment:dimensions-sellersprite", "sellersprite_xlsx", "2026-10-14T12:00:00.000Z")] },
        ],
        evidenceRefs: [citation("attachment:dimensions-amazon"), citation("attachment:dimensions-sellersprite")],
      }],
      variationStructure: null,
    });

    expect(html.replace(/<[^>]*>/gu, "")).toContain("商品本体尺寸来源冲突，暂不显示数值");
    expect(html).toContain("attachment:dimensions-amazon");
    expect(html).toContain("attachment:dimensions-sellersprite");
  });

  it("distinguishes an evidence-backed no-variation result from missing variation evidence", () => {
    const noEvidenceHtml = render({
      fieldEvidence: {}, conflicts: [], variationStructure: null,
    });
    const noVariationHtml = render({
      fieldEvidence: {},
      conflicts: [],
      variationStructure: {
        outcome: "no_variation_with_evidence",
        completeness: "none",
        parentAsin: null,
        memberAsins: [],
        members: [],
        relations: [],
        evidenceRefs: [citation("attachment:no-variation")],
        limitation: null,
      },
    });
    const structureHtml = render({
      fieldEvidence: { variationStructure: [citation("attachment:variation")] },
      conflicts: [],
      variationStructure: {
        outcome: "partial",
        completeness: "partial",
        parentAsin: "B0PARENT001",
        memberAsins: ["B0CHILD0001"],
        members: [{ asin: "B0CHILD0001", options: [{ dimensionKey: "size", label: "Size", value: "Large" }] }],
        relations: [{ fromAsin: "B0PARENT001", toAsin: "B0CHILD0001", relation: "child" }],
        evidenceRefs: [citation("attachment:variation")],
        limitation: "只确认到部分成员",
      },
    });

    expect(noEvidenceHtml).toContain("暂无已核验的变体信息");
    expect(noVariationHtml).toContain("现有证据未发现变体");
    expect(noVariationHtml).toContain("attachment:no-variation");
    expect(structureHtml).toContain("B0PARENT001");
    expect(structureHtml).toContain("B0CHILD0001");
    expect(structureHtml).toContain("Size: Large");
    expect(structureHtml).toContain("attachment:variation");
    expect(structureHtml).toContain("只确认到部分成员");
  });
});
