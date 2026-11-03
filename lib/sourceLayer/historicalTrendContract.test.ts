import { describe, expect, it } from "vitest";
import { parseHistoricalTrendSeries } from "./historicalTrendContract";

const series = {
  schemaVersion: "historical-trend-series.v1",
  identity: { marketplace: "us", asin: "b0test0001" },
  provider: "SellerSprite",
  sourceUrl: "https://www.sellersprite.com/v3/trend",
  acquisitionMode: "DOM_DIRECT",
  metric: {
    key: "monthly_search_volume",
    unit: "searches/month",
    nature: "provider_estimate",
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: "2026-03-31T23:59:59.999Z",
    timeZone: "America/Los_Angeles",
  },
  points: [
    { observedAt: "2026-03-01T00:00:00.000Z", value: 120, evidenceRef: "attachment:trend-2" },
    { observedAt: "2026-01-01T00:00:00.000Z", value: 100, evidenceRef: "attachment:trend-1" },
  ],
};

describe("historical trend structured evidence contract", () => {
  it("keeps identity, metric semantics, period and refs, and sorts observed points", () => {
    const result = parseHistoricalTrendSeries(series);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.series.identity).toEqual({ marketplace: "US", asin: "B0TEST0001" });
    expect(result.series.metric).toMatchObject({
      key: "monthly_search_volume",
      unit: "searches/month",
      nature: "provider_estimate",
      timeZone: "America/Los_Angeles",
    });
    expect(result.series.points.map((point) => point.value)).toEqual([100, 120]);
    expect(result.series.points.every((point) => point.evidenceRef.startsWith("attachment:"))).toBe(true);
  });

  it("refuses screenshots as numeric data", () => {
    expect(parseHistoricalTrendSeries({
      ...series,
      acquisitionMode: "SCREENSHOT_EVIDENCE",
    })).toEqual({ ok: false, code: "screenshot_is_not_structured_data" });
  });

  it.each([
    ["malformed source URL", { ...series, sourceUrl: "https://seller sprite.example/trend" }, "provenance_invalid"],
    ["non-HTTPS source URL", { ...series, sourceUrl: "http://www.sellersprite.com/v3/trend" }, "provenance_invalid"],
    ["credential-bearing source URL", { ...series, sourceUrl: "https://fixture-user:fixture-pass@example.invalid/v3/trend" }, "provenance_invalid"],
    ["missing unit", { ...series, metric: { ...series.metric, unit: " " } }, "metric_contract_invalid"],
    ["invalid timezone", { ...series, metric: { ...series.metric, timeZone: "Mars/Olympus" } }, "timezone_invalid"],
    ["point outside period", { ...series, points: [{ ...series.points[0], observedAt: "2025-12-31T00:00:00.000Z" }] }, "points_invalid"],
    ["missing evidence ref", { ...series, points: [{ ...series.points[0], evidenceRef: " " }] }, "points_invalid"],
    ["conflicting values at one timestamp", { ...series, points: [series.points[0], { ...series.points[0], value: 130 }] }, "points_invalid"],
  ])("rejects %s", (_name, input, code) => {
    expect(parseHistoricalTrendSeries(input)).toEqual({ ok: false, code });
  });
});
