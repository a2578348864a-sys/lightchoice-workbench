import { describe, expect, it } from "vitest";
import {
  buildAmazonVariationPageExtractionExpression,
  normalizeAmazonVariationPageCapture,
} from "./variation-page-extract";

const ASIN = "B000000001";
const CHILD = "B000000002";
const PARENT = "B000000003";

function boundIdentity(pageAsin = ASIN) {
  return { urlAsin: ASIN, pageAsin, productContainerFound: true, pageStatus: "ok" };
}

describe("Amazon native variation extraction", () => {
  it("binds the native child-to-value map to a single explicit Amazon dimension", () => {
    const result = normalizeAmazonVariationPageCapture({
      expectedAsin: ASIN,
      sourceUrl: `https://www.amazon.com/dp/${ASIN}`,
      capturedAt: "2026-10-07T00:00:00.000Z",
      identity: boundIdentity(),
      raw: {
        parentAsin: PARENT,
        dimensionToAsinMap: { "0": ASIN, "1": CHILD },
        dimensionValuesDisplayData: { [ASIN]: ["Medium"], [CHILD]: ["Large"] },
        variationDisplayLabels: { size_name: "Size" },
        variationRootFound: true,
        jsonStateFound: true,
      },
    });

    expect(result.status).toBe("COMPLETE");
    expect(result.parentAsin).toBe(PARENT);
    expect(result.variantAsins).toEqual([ASIN, CHILD]);
    expect(result.variants[0]?.options).toEqual([
      { dimensionKey: "size_name", label: "Size", value: "Medium" },
    ]);
    expect(result.identityProof).toMatchObject({ urlAsin: ASIN, pageAsin: ASIN, productContainerFound: true, bound: true });
  });

  it("keeps multi-dimension options unpaired when Amazon does not expose a verified value order", () => {
    const result = normalizeAmazonVariationPageCapture({
      expectedAsin: ASIN,
      sourceUrl: `https://www.amazon.com/dp/${ASIN}`,
      capturedAt: "2026-10-07T00:00:00.000Z",
      identity: boundIdentity(),
      raw: {
        parentAsin: PARENT,
        dimensionToAsinMap: { "0": ASIN, "1": CHILD },
        dimensionValuesDisplayData: { [ASIN]: ["Red", "Small"], [CHILD]: ["Blue", "Large"] },
        variationDisplayLabels: { size_name: "Size", color_name: "Color" },
        variationRootFound: true,
      },
    });

    expect(result.status).toBe("CAPTURED_PARTIAL");
    expect(result.variants[0]?.options).toEqual([
      { dimensionKey: "dimension_1", label: null, value: "Red" },
      { dimensionKey: "dimension_2", label: null, value: "Small" },
    ]);
    expect(result.dimensions).toEqual([
      { key: "size_name", label: "Size", options: [] },
      { key: "color_name", label: "Color", options: [] },
    ]);
  });

  it("resolves multi-dimension array order only from visible child-ASIN option bindings", () => {
    const result = normalizeAmazonVariationPageCapture({
      expectedAsin: ASIN,
      sourceUrl: `https://www.amazon.com/dp/${ASIN}`,
      capturedAt: "2026-10-09T00:00:00.000Z",
      identity: boundIdentity(),
      raw: {
        parentAsin: PARENT,
        dimensionToAsinMap: { "0": ASIN, "1": CHILD },
        dimensionValuesDisplayData: {
          [ASIN]: ["18 Ounces", "Neon Crush"],
          [CHILD]: ["25 Ounces", "Navy"],
        },
        variationDisplayLabels: { size_name: "Size", color_name: "Color" },
        domGroups: [
          { key: "size_name", label: "Size", options: [
            { asin: ASIN, value: "18 Ounces" },
            { asin: CHILD, value: "25 Ounces" },
          ] },
          { key: "color_name", label: "Color", options: [
            { asin: ASIN, value: "Neon Crush" },
            { asin: CHILD, value: "Navy" },
          ] },
        ],
        variationRootFound: true,
        jsonStateFound: true,
      },
    });

    expect(result.status).toBe("COMPLETE");
    expect(result.variants[0]?.options).toEqual([
      { dimensionKey: "size_name", label: "Size", value: "18 Ounces" },
      { dimensionKey: "color_name", label: "Color", value: "Neon Crush" },
    ]);
    expect(result.variants[1]?.options).toEqual([
      { dimensionKey: "size_name", label: "Size", value: "25 Ounces" },
      { dimensionKey: "color_name", label: "Color", value: "Navy" },
    ]);
    expect(result.dimensions).toEqual([
      { key: "size_name", label: "Size", options: ["18 Ounces", "25 Ounces"] },
      { key: "color_name", label: "Color", options: ["Neon Crush", "Navy"] },
    ]);
  });

  it("keeps multi-dimension labels unresolved when visible option bindings conflict", () => {
    const result = normalizeAmazonVariationPageCapture({
      expectedAsin: ASIN,
      sourceUrl: `https://www.amazon.com/dp/${ASIN}`,
      capturedAt: "2026-10-09T00:00:00.000Z",
      identity: boundIdentity(),
      raw: {
        parentAsin: PARENT,
        dimensionToAsinMap: { "0": ASIN, "1": CHILD },
        dimensionValuesDisplayData: {
          [ASIN]: ["18 Ounces", "Neon Crush"],
          [CHILD]: ["25 Ounces", "Navy"],
        },
        variationDisplayLabels: { size_name: "Size", color_name: "Color" },
        domGroups: [
          { key: "size_name", label: "Size", options: [
            { asin: ASIN, value: "18 Ounces" },
            { asin: CHILD, value: "Navy" },
          ] },
          { key: "color_name", label: "Color", options: [
            { asin: ASIN, value: "Neon Crush" },
            { asin: CHILD, value: "25 Ounces" },
          ] },
        ],
        variationRootFound: true,
        jsonStateFound: true,
      },
    });

    expect(result.status).toBe("CAPTURED_PARTIAL");
    expect(result.diagnostics.everyMappedVariantHasDimensions).toBe(true);
    expect(result.variants[0]?.options).toEqual([
      { dimensionKey: "dimension_1", label: null, value: "18 Ounces" },
      { dimensionKey: "dimension_2", label: null, value: "Neon Crush" },
    ]);
  });

  it("preserves duplicate source array positions and refuses ambiguous dimension matches", () => {
    const result = normalizeAmazonVariationPageCapture({
      expectedAsin: ASIN,
      sourceUrl: `https://www.amazon.com/dp/${ASIN}`,
      capturedAt: "2026-10-09T00:00:00.000Z",
      identity: boundIdentity(),
      raw: {
        parentAsin: PARENT,
        dimensionToAsinMap: { "0": ASIN, "1": CHILD },
        dimensionValuesDisplayData: { [ASIN]: ["Same", "Same"], [CHILD]: ["Small", "Large"] },
        variationDisplayLabels: { size_name: "Size", color_name: "Color" },
        domGroups: [
          { key: "size_name", label: "Size", options: [{ asin: ASIN, value: "Same" }, { asin: CHILD, value: "Small" }] },
          { key: "color_name", label: "Color", options: [{ asin: ASIN, value: "Same" }, { asin: CHILD, value: "Large" }] },
        ],
        variationRootFound: true,
      },
    });

    expect(result.status).toBe("CAPTURED_PARTIAL");
    expect(result.variants[0]?.options).toEqual([
      { dimensionKey: "dimension_1", label: null, value: "Same" },
      { dimensionKey: "dimension_2", label: null, value: "Same" },
    ]);
  });

  it("preserves observed variation signals as partial when child mapping or options are incomplete", () => {
    const result = normalizeAmazonVariationPageCapture({
      expectedAsin: ASIN,
      sourceUrl: `https://www.amazon.com/dp/${ASIN}`,
      capturedAt: "2026-10-07T00:00:00.000Z",
      identity: boundIdentity(),
      raw: {
        parentAsin: PARENT,
        variationDisplayLabels: { color_name: "Color" },
        variationRootFound: true,
      },
    });

    expect(result.status).toBe("CAPTURED_PARTIAL");
    expect(result.variantAsins).toEqual([ASIN]);
    expect(result.dimensions).toMatchObject([{ key: "color_name", label: "Color" }]);
  });

  it("does not infer no variation from an empty or missing variation widget", () => {
    const result = normalizeAmazonVariationPageCapture({
      expectedAsin: ASIN,
      sourceUrl: `https://www.amazon.com/dp/${ASIN}`,
      capturedAt: "2026-10-07T00:00:00.000Z",
      identity: boundIdentity(),
      raw: { variationRootFound: false, explicitNoVariation: false },
    });

    expect(result.status).toBe("EXTRACTION_EMPTY_RETRYABLE");
  });

  it("requires an explicit Amazon no-variation signal before returning no-data evidence", () => {
    const result = normalizeAmazonVariationPageCapture({
      expectedAsin: ASIN,
      sourceUrl: `https://www.amazon.com/dp/${ASIN}`,
      capturedAt: "2026-10-07T00:00:00.000Z",
      identity: boundIdentity(),
      raw: { variationRootFound: true, explicitNoVariation: true },
    });

    expect(result.status).toBe("NO_VARIATION_WITH_EVIDENCE");
  });

  it("keeps page-identity conflicts and human gates separate from variation outcomes", () => {
    const changed = normalizeAmazonVariationPageCapture({
      expectedAsin: ASIN,
      sourceUrl: `https://www.amazon.com/dp/${ASIN}`,
      capturedAt: "2026-10-07T00:00:00.000Z",
      identity: boundIdentity(CHILD),
      raw: { variationRootFound: true },
    });
    const human = normalizeAmazonVariationPageCapture({
      expectedAsin: ASIN,
      sourceUrl: `https://www.amazon.com/dp/${ASIN}`,
      capturedAt: "2026-10-07T00:00:00.000Z",
      identity: { ...boundIdentity(), pageStatus: "captcha" },
      humanRequired: true,
      raw: { variationRootFound: true },
    });

    expect(changed.status).toBe("PAGE_CHANGED");
    expect(changed.identityProof.bound).toBe(false);
    expect(human.status).toBe("HUMAN_REQUIRED");
  });

  it("extracts only allowlisted Amazon variation objects from page state", async () => {
    const scriptText = JSON.stringify({
      dimensionToAsinMap: { "0": ASIN, "1": CHILD },
      dimensionValuesDisplayData: { "0": ["Black", "Medium"], "1": ["Blue", "Large"] },
      variationDisplayLabels: { color_name: "Color", size_name: "Size" },
      parentAsin: PARENT,
    });
    const root = { textContent: "" };
    const document = {
      querySelectorAll: (selector: string) => selector === "script"
        ? [{ textContent: scriptText }]
        : [],
      querySelector: (selector: string) => selector.startsWith("#twister") ? root : null,
    };
    const expression = buildAmazonVariationPageExtractionExpression();
    const factory = new Function("document", "window", `return ${expression}`) as (document: unknown, window: unknown) => unknown;

    const result = await factory(document, {});

    expect(result).toMatchObject({
      parentAsin: PARENT,
      dimensionToAsinMap: { "0": ASIN, "1": CHILD },
      variationDisplayLabels: { color_name: "Color", size_name: "Size" },
      variationRootFound: true,
      jsonStateFound: true,
    });
  });

  it("extracts inline-twister visible options with explicit dimension and ASIN bindings", async () => {
    const scriptText = JSON.stringify({
      dimensionToAsinMap: { "0": ASIN, "1": CHILD },
      dimensionValuesDisplayData: { [ASIN]: ["18 Ounces", "Neon Crush"], [CHILD]: ["25 Ounces", "Navy"] },
      variationDisplayLabels: { size_name: "Size", color_name: "Color" },
      parentAsin: PARENT,
    });
    const option = (asin: string, value: string, hidden = false, imageAlt?: string) => ({
      innerText: value,
      textContent: value,
      id: "",
      getAttribute: (name: string) => name === "data-asin" ? asin : null,
      getClientRects: () => [{}],
      closest: () => hidden ? { hidden: true } : null,
      querySelector: (selector: string) => selector === "img" && imageAlt ? { alt: imageAlt } : null,
    });
    const groups = [
      {
        id: "inline-twister-expander-content-size_name",
        querySelector: () => null,
        querySelectorAll: () => [option(ASIN, "18 Ounces"), option(CHILD, "25 Ounces")],
      },
      {
        id: "inline-twister-expander-content-color_name",
        querySelector: () => null,
        querySelectorAll: () => [option(ASIN, "swatch", false, "Neon Crush"), option(CHILD, "swatch", false, "Navy"), option("B000000004", "hidden option", true, "Hidden")],
      },
    ];
    const document = {
      querySelectorAll: (selector: string) => selector === "script" ? [{ textContent: scriptText }] : groups,
      querySelector: (selector: string) => selector.includes('[id^="inline-twister-expander-content-"]') ? groups[0] : null,
    };
    const expression = buildAmazonVariationPageExtractionExpression();
    const factory = new Function("document", "window", `return ${expression}`) as (document: unknown, window: unknown) => unknown;

    const result = await factory(document, {});

    expect(result).toMatchObject({
      domGroups: [
        { key: "size_name", label: "Size", options: [{ asin: ASIN, value: "18 Ounces" }, { asin: CHILD, value: "25 Ounces" }] },
        { key: "color_name", label: "Color", options: [{ asin: ASIN, value: "Neon Crush" }, { asin: CHILD, value: "Navy" }] },
      ],
      variationRootFound: true,
    });
  });

  it("omits incomplete value arrays rather than shifting dimension indexes", async () => {
    const scriptText = JSON.stringify({
      dimensionToAsinMap: { "0": ASIN, "1": CHILD },
      dimensionValuesDisplayData: { [ASIN]: ["Red", null, "Small"], [CHILD]: ["Blue", "Large"] },
      variationDisplayLabels: { color_name: "Color", size_name: "Size" },
      parentAsin: PARENT,
    });
    const document = {
      querySelectorAll: (selector: string) => selector === "script" ? [{ textContent: scriptText }] : [],
      querySelector: () => null,
    };
    const expression = buildAmazonVariationPageExtractionExpression();
    const factory = new Function("document", "window", `return ${expression}`) as (document: unknown, window: unknown) => unknown;

    const result = await factory(document, {}) as { dimensionValuesDisplayData: Record<string, unknown> };

    expect(result.dimensionValuesDisplayData).not.toHaveProperty(ASIN);
    expect(result.dimensionValuesDisplayData[CHILD]).toEqual(["Blue", "Large"]);
  });

  it("parses allowlisted object literals without evaluating page script code", async () => {
    const scriptText = `P.when("twister").execute(function(){var state={"dimensionToAsinMap":{"0":"${ASIN}","1":"${CHILD}"},"dimensionValuesDisplayData":{"0":["Black","Medium"],"1":["Blue","Large"]},"variationDisplayLabels":{"color_name":"Color","size_name":"Size"},"parentAsin":"${PARENT}"};});`;
    const document = {
      querySelectorAll: (selector: string) => selector === "script" ? [{ textContent: scriptText }] : [],
      querySelector: (selector: string) => selector.startsWith("#twister") ? { textContent: "" } : null,
    };
    const expression = buildAmazonVariationPageExtractionExpression();
    const factory = new Function("document", "window", `return ${expression}`) as (document: unknown, window: unknown) => unknown;

    const result = await factory(document, {});

    expect(result).toMatchObject({
      parentAsin: PARENT,
      dimensionToAsinMap: { "0": ASIN, "1": CHILD },
      dimensionValuesDisplayData: { "0": ["Black", "Medium"], "1": ["Blue", "Large"] },
      variationDisplayLabels: { color_name: "Color", size_name: "Size" },
      jsonStateFound: true,
    });
  });
});
