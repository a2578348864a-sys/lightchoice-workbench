import { describe, expect, it } from "vitest";
import { parseEvidencePromotionReference } from "./evidencePromotionReference";

const BASE = {
  schemaVersion: "evidence-store-product-reference.v1",
  subjectKey: "amazon:US:B0ABCDEF12",
  evidenceId: "ev-1",
  evidenceVersion: 3,
  contentHash: "a".repeat(64),
  factSchema: "product-fact.v3",
  factBuildable: true,
  asin: "B0ABCDEF12",
  parentAsin: null,
  marketplace: "US",
  title: "A real product title",
  image: null,
  capturedAt: "2026-09-29T00:00:00.000Z",
  productBatchId: "batch-1",
  metricNature: "preserved_in_product_fact_projection",
};

describe("evidence promotion reference", () => {
  it("accepts the minimal immutable EvidenceStore binding", () => {
    expect(parseEvidencePromotionReference(BASE)).toMatchObject({
      schemaVersion: "evidence-store-product-reference.v1",
      subjectKey: BASE.subjectKey,
      evidenceVersion: 3,
      contentHash: BASE.contentHash,
    });
  });

  it("rejects a malformed hash, fixture-shaped ASIN, or missing title", () => {
    expect(parseEvidencePromotionReference({ ...BASE, contentHash: "bad" })).toBeNull();
    expect(parseEvidencePromotionReference({ ...BASE, asin: "BAD-ASIN" })).toBeNull();
    expect(parseEvidencePromotionReference({ ...BASE, title: "" })).toBeNull();
  });

  it("rejects an unsafe parent ASIN instead of weakening identity validation", () => {
    expect(parseEvidencePromotionReference({ ...BASE, parentAsin: "not-an-asin" })).toBeNull();
  });
});
