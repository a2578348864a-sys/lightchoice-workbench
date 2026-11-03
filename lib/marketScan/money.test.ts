import { describe, expect, it } from "vitest";

import { isValidMarketMoneyValue } from "@/lib/marketScan/money";

describe("MarketScan V1 money rule", () => {
  it.each([
    { amount: 0, currency: "USD" },
    { amount: -1, currency: "USD" },
    { amount: Number.NaN, currency: "USD" },
    { amount: 10 },
    { currency: "USD" },
    { amount: 10, currency: "usd" },
    { amount: 10, currency: "" },
  ])("rejects malformed money %#", (value) => {
    expect(isValidMarketMoneyValue(value)).toBe(false);
  });

  it("accepts only a finite positive amount with a three-letter uppercase currency", () => {
    expect(isValidMarketMoneyValue({ amount: 10, currency: "USD" })).toBe(true);
    expect(isValidMarketMoneyValue({ amount: 0.01, currency: "EUR" })).toBe(true);
  });
});
