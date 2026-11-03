import { describe, expect, it } from "vitest";
import { buildUiSearchQueries, findCategorySuggestionIndex } from "@/lib/server/sellerSpriteCategoryMarketCapture";

describe("SellerSprite suggestion index is deterministic (never first-by-default)", () => {
  it("matches full label", () => {
    expect(findCategorySuggestionIndex(
      ["Other", "Automotive:Interior Accessories"],
      { id: "15684181:15857501", label: "Automotive:Interior Accessories" },
    )).toBe(1);
  });

  it("matches when page shows shorter leaf-only suggestion", () => {
    expect(findCategorySuggestionIndex(
      ["Car Care", "Interior Accessories", "Exterior Accessories"],
      { id: "15684181:15857501", label: "Automotive:Interior Accessories" },
    )).toBe(1);
  });

  it("does not fall back to index 0 when nothing matches", () => {
    expect(findCategorySuggestionIndex(
      ["Cell Phones & Accessories", "Cases"],
      { id: "15684181:15857501", label: "Automotive:Interior Accessories" },
    )).toBe(-1);
  });

  it("prefers path-overlapping suggestion over first item", () => {
    expect(findCategorySuggestionIndex(
      ["Home & Kitchen", "Kitchen & Dining", "Tools & Home Improvement"],
      { id: "1055398:284507", label: "Home & Kitchen:Kitchen & Dining" },
    )).toBe(1);
  });

  it("strips trailing product counts from suggestion labels", () => {
    expect(findCategorySuggestionIndex(
      ["Automotive:Interior Accessories93,516", "Automotive:Exterior Accessories101,025"],
      { id: "15684181:15857501", label: "Automotive:Interior Accessories" },
    )).toBe(0);
  });

  it("builds shorter UI queries that still identify the category", () => {
    const queries = buildUiSearchQueries("Automotive Interior Accessories", {
      id: "15684181:15857501",
      label: "Automotive:Interior Accessories",
    });
    expect(queries[0]).toBe("Automotive Interior Accessories");
    expect(queries).toContain("Interior Accessories");
    expect(queries).toContain("Automotive");
    expect(new Set(queries.map((q) => q.toLowerCase())).size).toBe(queries.length);
  });
});
