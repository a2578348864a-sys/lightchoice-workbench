import { describe, expect, it } from "vitest";
import { buildSellerSpriteCategoryLookupQuery, matchSellerSpriteCandidate } from "./sellerSpriteCategoryMatch";
describe("SellerSprite lookup from the complete Amazon path", () => {
  it("preserves parent context and uses the observed working US query", () => {
    const path = ["Home & Kitchen", "Kitchen & Dining"];
    expect(buildSellerSpriteCategoryLookupQuery(path)).toBe("Home Kitchen Dining");
    expect(path).toEqual(["Home & Kitchen", "Kitchen & Dining"]);
  });
  it("does not weaken identity checks for a similarly named other-market node", () => {
    const result = matchSellerSpriteCandidate({ candidate: { id: "6314630051:6537675051", label: "Home:Kitchen and Dining" },
      amazon: { amazonNodeId: "284507", amazonPathEn: ["Home & Kitchen", "Kitchen & Dining"] } });
    expect(result.trusted).toBe(false);
    expect(matchSellerSpriteCandidate({ candidate: { id: "1055398:284507", label: "Home & Kitchen:Kitchen & Dining" },
      amazon: { amazonNodeId: "284507", amazonPathEn: ["Home & Kitchen", "Kitchen & Dining"] } }).trusted).toBe(true);
  });
  it("keeps deep lookups bounded without changing the taxonomy", () => {
    expect(buildSellerSpriteCategoryLookupQuery(["A".repeat(200)]).length).toBeLessThanOrEqual(120);
  });
});
