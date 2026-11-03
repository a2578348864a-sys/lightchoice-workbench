import { describe, expect, it } from "vitest";

import { parseSellerSpriteCategoryNodes } from "@/lib/server/sellerSpriteCategoryMarketCapture";

describe("SellerSprite category node normalization", () => {
  it("returns only bounded, numeric Amazon node identities and provider product estimates", () => {
    expect(parseSellerSpriteCategoryNodes({
      data: [
        { id: 123, label: "Home & Kitchen", products: "1,333,736" },
        { id: "1055398:284507", label: "Home & Kitchen:Kitchen & Dining", products: 415126 },
        { id: "1055398:284507", label: "duplicate", products: 1 },
        { id: "javascript:1", label: "unsafe", products: 10 },
        { id: "400", label: "", products: 0 },
      ],
    })).toEqual([
      { id: "123", label: "Home & Kitchen", products: 1333736 },
      { id: "1055398:284507", label: "Home & Kitchen:Kitchen & Dining", products: 415126 },
    ]);
  });

  it("caps the returned suggestions to the first 30 nodes", () => {
    const nodes = Array.from({ length: 35 }, (_, index) => ({
      id: String(index + 1),
      label: `Category ${index + 1}`,
      products: index,
    }));

    expect(parseSellerSpriteCategoryNodes(nodes)).toHaveLength(30);
  });
});
