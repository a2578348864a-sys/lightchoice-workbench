import { describe, expect, it } from "vitest";

import { withAmazonVariationSourceSignals } from "./amazonVariationSourceSignals";

const SOURCE_SIGNALS = {
  parentAsin: "B0DMQ2YQLJ",
  dimensionToAsinMap: { "0_18": "B0CLY1KWLB" },
  dimensionValuesDisplayData: { B0CLY1KWLB: ["18 Ounces", "Neon Crush"] },
  variationDisplayLabels: { size_name: "Size", color_name: "Color" },
  domGroups: [],
  variationRootFound: false,
  explicitNoVariation: false,
  jsonStateFound: true,
  jsonStateDiagnostics: { scriptsScanned: 1, scriptsMatched: 1 },
};

describe("Amazon variation source signal evidence bounds", () => {
  it("retains bounded source signals without changing the normalized fields", () => {
    const result = withAmazonVariationSourceSignals({ outcome: "CAPTURED_PARTIAL" }, SOURCE_SIGNALS);

    expect(result.data).toMatchObject({
      outcome: "CAPTURED_PARTIAL",
      rawVariationSignals: SOURCE_SIGNALS,
      rawVariationSignalsStatus: "retained",
    });
    expect(result.sourceSignals).toEqual(SOURCE_SIGNALS);
  });

  it("omits source signals when the raw maps exceed the bound", () => {
    const oversized = {
      ...SOURCE_SIGNALS,
      dimensionValuesDisplayData: Object.fromEntries(Array.from({ length: 80 }, (_, index) => [
        `raw-row-${index}`,
        Array.from({ length: 20 }, () => "x".repeat(120)),
      ])),
    };
    const result = withAmazonVariationSourceSignals({ outcome: "CAPTURED_PARTIAL" }, oversized);

    expect(result.data).toEqual({ outcome: "CAPTURED_PARTIAL", rawVariationSignalsStatus: "omitted_size_limit" });
    expect(result.sourceSignals).toBeNull();
  });

  it("omits source signals when the surrounding Evidence data leaves insufficient headroom", () => {
    const result = withAmazonVariationSourceSignals({ normalized: "x".repeat(220 * 1024 - 300) }, SOURCE_SIGNALS);

    expect(result.data).toHaveProperty("rawVariationSignalsStatus", "omitted_size_limit");
    expect(result.data).not.toHaveProperty("rawVariationSignals");
    expect(result.sourceSignals).toBeNull();
  });

  it("records the absence of source signals on fallback evidence", () => {
    const result = withAmazonVariationSourceSignals({ outcome: "FAILED_RETRYABLE" }, null);

    expect(result.data).toEqual({ outcome: "FAILED_RETRYABLE", rawVariationSignalsStatus: "unavailable" });
    expect(result.sourceSignals).toBeNull();
  });
});
