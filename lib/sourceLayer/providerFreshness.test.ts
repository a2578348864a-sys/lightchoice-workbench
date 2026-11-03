import { describe, expect, it } from "vitest";

import {
  evaluateV3ProviderFreshness,
  resolveV3ProviderCadence,
} from "@/lib/sourceLayer/providerFreshness";

describe("V3 provider-aware freshness", () => {
  it("keeps the existing short Amazon price cadence separate from SellerSprite reverse cadence", () => {
    expect(resolveV3ProviderCadence({ module: "amazon_detail", metricKey: "price" }).cadenceKey).toBe("amazon_price");
    expect(resolveV3ProviderCadence({ module: "reverse_asin" }).cadenceKey).toBe("sellersprite_reverse_asin");
  });

  it("marks an explicit provider timestamp fresh or stale without guessing when missing", () => {
    const now = "2026-09-26T00:00:00.000Z";
    expect(evaluateV3ProviderFreshness({
      module: "keyword_mining_trend",
      providerUpdatedAt: "2026-09-20T00:00:00.000Z",
      now,
    }).state).toBe("fresh");
    expect(evaluateV3ProviderFreshness({
      module: "reverse_asin",
      providerUpdatedAt: "2026-07-01T00:00:00.000Z",
      now,
    }).state).toBe("stale");
    expect(evaluateV3ProviderFreshness({ module: "historical_trend", now }).state).toBe("unknown");
  });
});
