import { describe, expect, it } from "vitest";
import { assessReviewCount, classifyReviewSurface, type ReviewCountObservation } from "./reviewCountCaliber";

const observation = (value: number, capturedAt: string, evidenceId: string, sourceUrl: string): ReviewCountObservation => ({
  value, capturedAt, evidenceId, version: 1, surface: classifyReviewSurface(sourceUrl),
});

const SEARCH_URL = "https://www.amazon.com/Non-slip-Measurements-Folksy-Super-Kitchen/dp/B01ACUA8HC/ref=sr_1_10?keywords=silicone+baking+mat&qid=1791929129&sr=8-10";
const DETAIL_URL = "https://www.amazon.com/dp/B01ACUA8HC";

describe("classifyReviewSurface", () => {
  it("separates product page from search card", () => {
    expect(classifyReviewSurface(DETAIL_URL)).toBe("detail");
    expect(classifyReviewSurface("https://www.amazon.com/dp/B0725GYNG6?th=1")).toBe("detail");
    expect(classifyReviewSurface(SEARCH_URL)).toBe("search");
    expect(classifyReviewSurface("https://www.amazon.com/s?k=silicone+baking+mat")).toBe("other");
    expect(classifyReviewSurface("https://www.sellersprite.com/v3/competitor-lookup")).toBe("other");
    expect(classifyReviewSurface(null)).toBe("other");
  });
});

describe("assessReviewCount", () => {
  it("keeps the locked reading but flags a product-page contradiction (27 vs 27,477)", () => {
    const caliber = assessReviewCount({
      lockedValue: 27,
      lockedCapturedAt: "2026-10-13T22:05:26.673Z",
      lockedSourceUrl: SEARCH_URL,
      observations: [
        observation(27, "2026-10-13T20:26:12.238Z", "ev-search-1", SEARCH_URL),
        observation(27477, "2026-10-13T20:29:06.704Z", "ev-detail-1", DETAIL_URL),
        observation(27, "2026-10-13T22:05:26.673Z", "ev-search-2", SEARCH_URL),
      ],
    });
    expect(caliber.state).toBe("conflict");
    expect(caliber.lockedValue).toBe(27);
    expect(caliber.productPageValue).toBe(27477);
    expect(caliber.conflicts.map((item) => item.evidenceId)).toEqual(["ev-detail-1"]);
    expect(caliber.reason).toBe("product_page_reading_incompatible");
  });

  it("accepts a search reading that a product page agrees with (570)", () => {
    const caliber = assessReviewCount({
      lockedValue: 570,
      lockedCapturedAt: "2026-10-13T22:05:26.673Z",
      lockedSourceUrl: SEARCH_URL,
      observations: [
        observation(570, "2026-10-13T20:37:34.410Z", "ev-detail-1", DETAIL_URL),
        observation(570, "2026-10-13T22:05:26.673Z", "ev-search-1", SEARCH_URL),
      ],
    });
    expect(caliber.state).toBe("verified");
    expect(caliber.productPageValue).toBe(570);
    expect(caliber.conflicts).toEqual([]);
  });

  it("treats growth between product-page readings as normal, not a conflict", () => {
    const caliber = assessReviewCount({
      lockedValue: 27477,
      lockedCapturedAt: "2026-10-13T20:29:06.704Z",
      lockedSourceUrl: DETAIL_URL,
      observations: [observation(27000, "2026-10-01T00:00:00.000Z", "ev-detail-0", DETAIL_URL)],
    });
    expect(caliber.state).toBe("verified");
    expect(caliber.reason).toBe("product_page_surface");
  });

  it("flags a locked product-page value that a later product page contradicts (decrease)", () => {
    const caliber = assessReviewCount({
      lockedValue: 3354,
      lockedCapturedAt: "2026-10-13T20:37:23.478Z",
      lockedSourceUrl: DETAIL_URL,
      observations: [observation(3, "2026-10-14T20:37:23.478Z", "ev-detail-2", DETAIL_URL)],
    });
    expect(caliber.state).toBe("conflict");
    expect(caliber.conflicts.map((item) => item.value)).toEqual([3]);
  });

  it("marks a search-only reading as unverified instead of confirmed", () => {
    const caliber = assessReviewCount({
      lockedValue: 27,
      lockedCapturedAt: "2026-10-13T20:26:12.238Z",
      lockedSourceUrl: SEARCH_URL,
      observations: [observation(27, "2026-10-13T20:26:12.238Z", "ev-search-1", SEARCH_URL)],
    });
    expect(caliber.state).toBe("unverified");
    expect(caliber.productPageValue).toBeNull();
    expect(caliber.reason).toBe("search_surface_only");
  });

  it("reports a missing reading without inventing a value", () => {
    const caliber = assessReviewCount({ lockedValue: null, lockedCapturedAt: null, lockedSourceUrl: DETAIL_URL });
    expect(caliber.state).toBe("missing");
    expect(caliber.lockedValue).toBeNull();
    expect(caliber.conflicts).toEqual([]);
  });
});
