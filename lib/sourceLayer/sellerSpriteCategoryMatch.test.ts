import { describe, expect, it } from "vitest";

import {
  isTrustedSellerSpriteMatch,
  matchSellerSpriteCandidate,
  sellerSpriteMatchBadge,
} from "@/lib/sourceLayer/sellerSpriteCategoryMatch";

describe("SellerSprite candidate deterministic matching", () => {
  const automotiveInterior = {
    amazonNodeId: "15684191",
    amazonPathEn: ["Automotive", "Interior Accessories"],
  };

  it("EXACT_NODE_MATCH: SellerSprite ID path leaf equals Amazon amazonNodeId", () => {
    const match = matchSellerSpriteCandidate({
      amazon: automotiveInterior,
      candidate: { id: "15684181:15684191", label: "Automotive:Interior Accessories" },
    });
    expect(match.matchType).toBe("EXACT_NODE_MATCH");
    expect(match.trusted).toBe(true);
    expect(match.conflicting).toBe(false);
    expect(match.details.sellerSpriteLeafId).toBe("15684191");
    expect(sellerSpriteMatchBadge(match)).toBe("精确节点匹配");
  });

  it("PATH_MATCH: ID path contains Amazon nodeId and English path is consistent", () => {
    const match = matchSellerSpriteCandidate({
      amazon: {
        amazonNodeId: "284507",
        amazonPathEn: ["Home & Kitchen", "Kitchen & Dining"],
      },
      candidate: {
        id: "1055398:284507:3370501",
        label: "Home & Kitchen:Kitchen & Dining:Storage & Organization",
      },
    });
    expect(match.matchType).toBe("PATH_MATCH");
    expect(match.trusted).toBe(true);
    expect(sellerSpriteMatchBadge(match)).toBe("推荐匹配");
  });

  it("SEMANTIC_PATH_MATCH: normalized English full path is highly consistent even when IDs differ", () => {
    const match = matchSellerSpriteCandidate({
      amazon: {
        amazonNodeId: "172282",
        amazonPathEn: ["Electronics", "Computers & Accessories"],
      },
      candidate: {
        id: "999001:999002",
        label: "Electronics : Computers & Accessories",
      },
    });
    expect(match.matchType).toBe("SEMANTIC_PATH_MATCH");
    expect(match.trusted).toBe(true);
    expect(match.score).toBeGreaterThanOrEqual(0.84);
    expect(sellerSpriteMatchBadge(match)).toBe("推荐匹配");
  });

  it("rejects Automotive Amazon selection vs Cell Phones SellerSprite candidate", () => {
    const match = matchSellerSpriteCandidate({
      amazon: {
        amazonNodeId: "15684191",
        amazonPathEn: ["Automotive", "Interior Accessories"],
      },
      candidate: {
        id: "2335752011:12345",
        label: "Cell Phones & Accessories:Cases & Covers",
      },
    });
    expect(match.matchType).toBe("UNCONFIRMED");
    expect(match.trusted).toBe(false);
    expect(match.conflicting).toBe(true);
    expect(isTrustedSellerSpriteMatch(match)).toBe(false);
    expect(match.reason).toContain("不匹配");
  });

  it("Electronics / Computers & Accessories exact match stays trusted", () => {
    const match = matchSellerSpriteCandidate({
      amazon: {
        amazonNodeId: "172282",
        amazonPathEn: ["Electronics", "Computers & Accessories"],
      },
      candidate: {
        id: "172282",
        label: "Electronics:Computers & Accessories",
      },
    });
    expect(match.matchType === "EXACT_NODE_MATCH" || match.matchType === "SEMANTIC_PATH_MATCH").toBe(true);
    expect(match.trusted).toBe(true);
  });

  it("never trusts order-first / single-word / same-department alone", () => {
    // 同属 Automotive，但叶子完全不同 → 不可信
    const sameDepartmentOnly = matchSellerSpriteCandidate({
      amazon: {
        amazonNodeId: "15684191",
        amazonPathEn: ["Automotive", "Interior Accessories"],
      },
      candidate: {
        id: "15684181:3339341",
        label: "Automotive:Car Care",
      },
    });
    expect(sameDepartmentOnly.trusted).toBe(false);
    expect(sameDepartmentOnly.matchType).toBe("UNCONFIRMED");

    // 仅一个词相同（Accessories）→ 不可信
    const oneWordOnly = matchSellerSpriteCandidate({
      amazon: {
        amazonNodeId: "15684191",
        amazonPathEn: ["Automotive", "Interior Accessories"],
      },
      candidate: {
        id: "2335752011:999",
        label: "Cell Phones & Accessories:Accessories",
      },
    });
    expect(oneWordOnly.trusted).toBe(false);
  });

  it("missing context is UNCONFIRMED and does not auto-accept", () => {
    const match = matchSellerSpriteCandidate({
      amazon: { amazonNodeId: "15684191", amazonPathEn: [] },
      candidate: { id: "15684181:15684191", label: "Automotive:Interior Accessories" },
    });
    expect(match.matchType).toBe("UNCONFIRMED");
    expect(match.trusted).toBe(false);
  });

  it("keeps Amazon node ID separate from SellerSprite node ID in details", () => {
    const match = matchSellerSpriteCandidate({
      amazon: automotiveInterior,
      candidate: { id: "15684181:15684191", label: "Automotive:Interior Accessories" },
    });
    expect(match.details.sellerSpriteIdPathSegments).toEqual(["15684181", "15684191"]);
    expect(match.details.amazonNodeId).toBe("15684191");
    expect(match.details.sellerSpriteLeafId).toBe("15684191");
  });
});
