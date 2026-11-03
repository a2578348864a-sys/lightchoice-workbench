import { describe, expect, it } from "vitest";
import { PRODUCT_BATCH_EVIDENCE_STATUSES, isProductBatchEvidenceStatus } from "@/lib/productBatchContract";
import { classifyMarketProductEligibility, resolveValidMarketProductSet, MIN_VALID_SAMPLE_COUNT,
  type MarketProductCandidate } from "./marketSamplePolicy";

const item: MarketProductCandidate = { id: "item-1", ordinal: 0, asin: "B000000001",
  productKey: "amazon:US:B000000001", parentAsin: null, familyProjectionJson: "{}",
  evidenceStatus: "limited_evidence", archivedAt: null };
describe("P1 evidence vocabulary and deterministic identity", () => {
  it("keeps limited evidence distinct from invalid identity and decision readiness", () => {
    expect(PRODUCT_BATCH_EVIDENCE_STATUSES).toContain("limited_evidence");
    expect(isProductBatchEvidenceStatus("ready")).toBe(false);
    expect(classifyMarketProductEligibility({ item, batchMarketplace: "US" })).toEqual({ eligible: true });
    const result = resolveValidMarketProductSet({ items: [item], batchMarketplace: "US" });
    expect(result.validCount).toBe(1);
    expect(result.minimumRequired).toBe(MIN_VALID_SAMPLE_COUNT);
    expect(result).not.toHaveProperty("decisionReady");
    expect(result).not.toHaveProperty("proceed");
  });
  it.each(["blocked", "corrupted", "ready", "invented", "insufficient_evidence"])(
    "fails closed for non-valid evidence state %s", (evidenceStatus) => {
      expect(classifyMarketProductEligibility({ item: { ...item, evidenceStatus }, batchMarketplace: "US" }).eligible).toBe(false);
    });
  it("does not count mismatched identities or marketplaces", () => {
    expect(classifyMarketProductEligibility({ item: { ...item, asin: "B000000002" }, batchMarketplace: "US" }).eligible).toBe(false);
    expect(classifyMarketProductEligibility({ item, batchMarketplace: "DE" }).eligible).toBe(false);
    expect(classifyMarketProductEligibility({ item }).eligible).toBe(false);
  });
  it("collapses observations of the same product and deterministic parent family", () => {
    const result = resolveValidMarketProductSet({ batchMarketplace: "US", items: [
      { ...item, parentAsin: "B000000099" },
      { ...item, id: "item-2", asin: "B000000002", productKey: "amazon:US:B000000002", parentAsin: "B000000099" },
    ] });
    expect(result.validCount).toBe(1);
  });
  it("does not count repeated ASIN observations even when parent/family evidence is unavailable", () => {
    expect(resolveValidMarketProductSet({ batchMarketplace: "US",
      items: [item, { ...item, id: "duplicate", ordinal: 1 }] }).validCount).toBe(1);
  });
});
