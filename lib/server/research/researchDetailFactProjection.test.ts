import { describe, expect, it } from "vitest";
import type { FactFieldEvidenceRef, ProductFact } from "@/lib/sourceLayer/fact/types";
import { projectResearchDetailFacts } from "@/lib/server/research/researchDetailFactProjection";
import { resolveProductFacts } from "@/lib/server/v5ResearchService";

const ref = (refId: string, capturedAt = "2026-10-15T12:00:00.000Z", source: FactFieldEvidenceRef["source"] = "amazon_dom"): FactFieldEvidenceRef => ({
  refId,
  source,
  captureId: refId.replace("attachment:", ""),
  evidenceId: refId.replace("attachment:", ""),
  subjectKey: "amazon:US:B0EXAMPLE01",
  capturedAt,
  contentHash: `hash-${refId}`,
  sourceUrl: null,
});

function fact(overrides: Partial<ProductFact> = {}): ProductFact {
  const present = <T,>(value: T, evidenceRefs: readonly FactFieldEvidenceRef[] = []) => ({
    value,
    status: "present" as const,
    source: "amazon_dom" as const,
    confidence: 1,
    capturedAt: "2026-10-15T12:00:00.000Z",
    rawProofHash: "proof-hash",
    evidenceRefs,
  });
  const missing = <T,>() => ({
    value: null,
    status: "missing" as const,
    source: "amazon_dom" as const,
    confidence: 0,
    capturedAt: null,
    rawProofHash: null,
    evidenceRefs: [],
  });
  return {
    schema: "product-fact.v3",
    subjectKey: "amazon:US:B0EXAMPLE01",
    sourceProof: {
      source: "amazon_dom",
      captureId: "capture-1",
      evidenceId: "evidence-1",
      subjectKey: "amazon:US:B0EXAMPLE01",
      capturedAt: "2026-10-15T12:00:00.000Z",
      contentHash: "content-hash",
      sourceUrl: null,
      operator: "test",
      sourceMethod: "amazon_product_detail",
    },
    basic: {
      asin: present("B0EXAMPLE01"),
      title: present("Example product"),
      image: missing<string>(),
      brand: present("Example Brand", [ref("attachment:brand")]),
      category: present("Home & Kitchen", [ref("attachment:category")]),
      price: present({ amount: 19.99, currency: "USD" }, [ref("attachment:price")]),
      rating: present(4.7, [ref("attachment:rating")]),
      reviewCount: present(25, [ref("attachment:review-count")]),
      bulletPoints: present(["A product detail"], [ref("attachment:bullets")]),
    },
    market: {
      bsr: missing<number>(),
      monthlySalesEstimate: missing<number>(),
      monthlyRevenueEstimate: missing(),
      launchedDate: missing<string>(),
    },
    profit: {
      packageWeight: present({ value: 2.2, unit: "lb" }),
      packageDimensions: present({ length: 18, width: 12, height: 4, unit: "in" }),
      fbaFee: missing(),
      itemDimensions: present({ length: 10, width: 6, height: 2, unit: "in" }, [ref("attachment:item-dimensions")]),
      itemWeight: present({ value: 9.5, unit: "oz" }, [ref("attachment:item-weight")]),
    },
    extended: {
      categoryPath: missing<string[]>(),
      parentAsin: missing<string>(),
      material: missing<string>(),
      includedComponents: missing<string[]>(),
      galleryImageUrls: missing<string[]>(),
      listPrice: missing(),
      coupon: missing(),
      seller: missing<string>(),
      shipsFrom: missing<string>(),
      fulfillment: missing<string>(),
      buyBox: missing(),
      ratingDistribution: missing(),
      boughtPastMonth: missing(),
      variations: missing<string[]>(),
      ...overrides.extended,
    },
    ...overrides,
  } as ProductFact;
}

describe("projectResearchDetailFacts", () => {
  it("passes verified BSR 138 and an estimated FBA fee through the downstream detail contract", () => {
    const source = fact();
    const projected = resolveProductFacts({}, {}, { ...source,
      market: { ...source.market, bsr: { ...source.market.bsr, value: 138, status: "present", evidenceRefs: [ref("attachment:bsr-138")] } },
      profit: { ...source.profit, fbaFee: { ...source.profit.fbaFee, value: { amount: 4.25, currency: "USD" }, status: "present", source: "sellersprite_plugin", metricNature: "estimate", evidenceRefs: [ref("attachment:fba-estimate", undefined, "sellersprite_plugin")] } },
    });
    expect(projected.bsr).toBe(138);
    expect(projected.fieldEvidence.bsr?.[0].refId).toBe("attachment:bsr-138");
    expect(projected.fbaFee).toEqual({ amount: 4.25, currency: "USD" });
    expect(projected.fbaFeeNature).toBe("estimate");
    expect(projected.fieldEvidence.fbaFee?.[0].source).toBe("sellersprite_plugin");
  });
  it("projects verified item dimensions and weight with their field citations, never package values", () => {
    const projected = projectResearchDetailFacts(fact());

    expect(projected.itemDimensions).toEqual({ length: 10, width: 6, height: 2, unit: "in" });
    expect(projected.itemWeight).toEqual({ value: 9.5, unit: "oz" });
    expect(projected.fieldEvidence.itemDimensions).toEqual([
      expect.objectContaining({ refId: "attachment:item-dimensions", capturedAt: "2026-10-15T12:00:00.000Z" }),
    ]);
    expect(projected.fieldEvidence.itemWeight).toEqual([
      expect.objectContaining({ refId: "attachment:item-weight", capturedAt: "2026-10-15T12:00:00.000Z" }),
    ]);
    expect(projected.itemDimensions).not.toEqual({ length: 18, width: 12, height: 4, unit: "in" });
    expect(projected.itemWeight).not.toEqual({ value: 2.2, unit: "lb" });
  });

  it("keeps an unresolved review-count unknown and projects each candidate's provenance", () => {
    const projected = projectResearchDetailFacts(fact({
      sourceConflicts: [{
        field: "basic.reviewCount",
        code: "SOURCE_CONFLICT_UNRESOLVED",
        resolved: false,
        candidates: [
          { source: "amazon_dom", value: 3, capturedAt: "2026-10-15T12:00:00.000Z", evidenceRefs: [ref("attachment:review-a")] },
          { source: "sellersprite_xlsx", value: 3354, capturedAt: "2026-10-14T12:00:00.000Z", evidenceRefs: [ref("attachment:review-b", "2026-10-14T12:00:00.000Z", "sellersprite_xlsx")] },
        ],
      }],
    }));

    expect(projected.reviewCount).toBeNull();
    expect(projected.conflicts).toEqual([expect.objectContaining({
      field: "basic.reviewCount",
      code: "SOURCE_CONFLICT_UNRESOLVED",
      resolved: false,
      candidates: [
        {
          source: "amazon_dom",
          value: 3,
          capturedAt: "2026-10-15T12:00:00.000Z",
          evidenceRefs: [{ refId: "attachment:review-a", source: "amazon_dom", capturedAt: "2026-10-15T12:00:00.000Z" }],
        },
        {
          source: "sellersprite_xlsx",
          value: 3354,
          capturedAt: "2026-10-14T12:00:00.000Z",
          evidenceRefs: [{ refId: "attachment:review-b", source: "sellersprite_xlsx", capturedAt: "2026-10-14T12:00:00.000Z" }],
        },
      ],
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ refId: "attachment:review-a" }),
        expect.objectContaining({ refId: "attachment:review-b" }),
      ]),
    })]);
  });

  it("does not display an item measurement while its source conflict is unresolved", () => {
    const projected = projectResearchDetailFacts(fact({
      sourceConflicts: [{
        field: "profit.itemDimensions",
        code: "SOURCE_CONFLICT_UNRESOLVED",
        resolved: false,
        candidates: [
          { source: "amazon_dom", value: { length: 10, width: 6, unit: "in" }, capturedAt: "2026-10-15T12:00:00.000Z", evidenceRefs: [ref("attachment:dimensions-amazon")] },
          { source: "sellersprite_xlsx", value: { length: 9, width: 6, unit: "in" }, capturedAt: "2026-10-14T12:00:00.000Z", evidenceRefs: [ref("attachment:dimensions-sellersprite")] },
        ],
      }],
    }));

    expect(projected.itemDimensions).toBeNull();
    expect(projected.fieldEvidence.itemDimensions).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: "attachment:dimensions-amazon" }),
      expect.objectContaining({ refId: "attachment:dimensions-sellersprite" }),
    ]));
  });

  it("projects the evidence-bound variation structure and does not infer one when it is absent", () => {
    const structure = {
      schemaVersion: "product-fact-variation-structure.v1" as const,
      subjectKey: "amazon:US:B0EXAMPLE01",
      subjectAsin: "B0EXAMPLE01",
      outcome: "partial" as const,
      completeness: "partial" as const,
      parentAsin: "B0PARENT001",
      memberAsins: ["B0EXAMPLE01", "B0CHILD0001"],
      members: [{ asin: "B0EXAMPLE01", options: [{ dimensionKey: "color", label: "Color", value: "Blue" }] }],
      relations: [{ fromAsin: "B0PARENT001", toAsin: "B0EXAMPLE01", relation: "child" as const }],
      evidenceRefs: [ref("attachment:variation")],
      limitation: "只确认到部分成员",
    };
    const projected = projectResearchDetailFacts(fact({ extended: {
      ...fact().extended!,
      variationStructure: structure,
    } }));

    expect(projected.variationStructure).toMatchObject({
      parentAsin: "B0PARENT001",
      memberAsins: ["B0EXAMPLE01", "B0CHILD0001"],
      evidenceRefs: [expect.objectContaining({ refId: "attachment:variation" })],
    });
    expect(projected.variationStructure?.evidenceRefs).toEqual([{
      refId: "attachment:variation",
      source: "amazon_dom",
      capturedAt: "2026-10-15T12:00:00.000Z",
    }]);
    expect(projected.fieldEvidence.variationStructure).toEqual([
      expect.objectContaining({ refId: "attachment:variation" }),
    ]);
    expect(projectResearchDetailFacts(fact()).variationStructure).toBeNull();
  });

  it("keeps missing item fields missing even when a package field is present", () => {
    const source = fact();
    const projected = projectResearchDetailFacts({
      ...source,
      profit: {
        ...source.profit,
        itemDimensions: { ...source.profit.itemDimensions!, value: { length: 18, width: 12, height: 4, unit: "in" }, status: "missing" },
        itemWeight: { ...source.profit.itemWeight!, value: { value: 2.2, unit: "lb" }, status: "missing" },
      },
    });

    expect(projected.itemDimensions).toBeNull();
    expect(projected.itemWeight).toBeNull();
  });

  it("returns unknown fields for a legacy ProductFact with incomplete groups", () => {
    const projected = projectResearchDetailFacts({
      schema: "product-fact.v3",
      subjectKey: "amazon:US:B0EXAMPLE01",
      sourceProof: { evidenceId: "legacy-evidence" },
    } as ProductFact);

    expect(projected).toMatchObject({
      brand: null,
      price: null,
      rating: null,
      reviewCount: null,
      mainCategory: null,
      imageUrl: null,
      itemDimensions: null,
      itemWeight: null,
      material: null,
      bulletPoints: [],
      fieldEvidence: {},
      conflicts: [],
      variationStructure: null,
    });
  });

  it("includes the ProductFact projection and citations in the research detail DTO", () => {
    const source = fact({ extended: {
      ...fact().extended!,
      variationStructure: {
        schemaVersion: "product-fact-variation-structure.v1",
        subjectKey: "amazon:US:B0EXAMPLE01",
        subjectAsin: "B0EXAMPLE01",
        outcome: "complete",
        completeness: "complete",
        parentAsin: "B0PARENT001",
        memberAsins: ["B0EXAMPLE01", "B0CHILD0001"],
        members: [{ asin: "B0EXAMPLE01", options: [{ dimensionKey: "size", label: "Size", value: "Large" }] }],
        relations: [{ fromAsin: "B0PARENT001", toAsin: "B0EXAMPLE01", relation: "child" }],
        evidenceRefs: [ref("attachment:variation")],
        limitation: null,
      },
    } });
    const detailFacts = resolveProductFacts({}, {}, source);

    expect(detailFacts.itemDimensions).toEqual({ length: 10, width: 6, height: 2, unit: "in" });
    expect(detailFacts.itemWeight).toEqual({ value: 9.5, unit: "oz" });
    expect(detailFacts.fieldEvidence.itemDimensions).toEqual([
      expect.objectContaining({ refId: "attachment:item-dimensions" }),
    ]);
    expect(detailFacts.variationStructure).toMatchObject({ parentAsin: "B0PARENT001" });
  });
});
