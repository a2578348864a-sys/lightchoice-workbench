import { describe, expect, it } from "vitest";
import { AMAZON_DETAIL_D4_FIELD_FAILURE_OBSERVATIONS } from "./fixtures/amazon-detail-d4-field-failures.v1";
import { AMAZON_DETAIL_FIELD_REGISTRY } from "./detail-page-field-registry";
import { auditAmazonDetailPageFieldPresence } from "./detail-page-presence-audit";
import {
  extractAmazonDetailPageV2,
  type AmazonDetailDomCandidate,
  type AmazonDetailPageDomSnapshot,
} from "./detail-page-extract-v2";

const ASIN = "B00063QBL8";
const PAGE_URL = `https://www.amazon.com/dp/${ASIN}?th=1`;
const PAY_NOW_SELECTOR = "#corePrice_feature_div .apex-pricetopay-value .a-offscreen";
const DESKTOP_PRICE_SELECTOR = "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen";
const MOBILE_PRICE_SELECTOR = "#corePriceDisplay_mobile_feature_div .a-price .a-offscreen";
const PRICE_SELECTORS = [
  PAY_NOW_SELECTOR,
  DESKTOP_PRICE_SELECTOR,
  MOBILE_PRICE_SELECTOR,
  "#corePrice_feature_div .a-offscreen",
  ".priceToPay .a-offscreen",
  "#priceblock_ourprice",
  "#priceblock_dealprice",
] as const;

type TestPriceContext = NonNullable<AmazonDetailDomCandidate["priceContext"]>;

function candidate(
  selector: string,
  values: Partial<AmazonDetailDomCandidate> & { text?: string },
) {
  return [{ selector, text: values.text ?? null, label: values.label ?? null, value: values.value ?? null, href: values.href ?? null, src: values.src ?? null, alt: values.alt ?? null, selected: values.selected ?? null, priceContext: values.priceContext ?? null }];
}

function priceCandidate(
  selector: string,
  text: string,
  options: { role?: TestPriceContext["semanticRole"]; purchaseContext?: TestPriceContext["purchaseContext"]; selected?: boolean | null; className?: string | null; dataAColor?: string | null; inPrimaryBuyBox?: boolean } = {},
) {
  return candidate(selector, {
    text,
    priceContext: {
      id: null,
      className: options.className ?? (options.role === "list_price" ? "a-price a-text-price" : "a-price apex-pricetopay-value"),
      dataAColor: options.dataAColor ?? (options.role === "list_price" ? "secondary" : "price"),
      dataASize: "xl",
      semanticRole: options.role ?? "current_pay_now",
      purchaseContext: options.purchaseContext ?? "not_applicable",
      selected: options.selected ?? null,
      inPrimaryBuyBox: options.inPrimaryBuyBox ?? true,
    },
  });
}

function priceSnapshot(candidates: Array<{ selector: string; text: string; role?: TestPriceContext["semanticRole"]; purchaseContext?: TestPriceContext["purchaseContext"]; selected?: boolean | null; className?: string | null; dataAColor?: string | null; inPrimaryBuyBox?: boolean }>) {
  const base = snapshot();
  const priceCandidates: AmazonDetailPageDomSnapshot["candidates"] = { ...base.candidates };
  for (const selector of PRICE_SELECTORS) priceCandidates[selector] = [];
  for (const entry of candidates) {
    priceCandidates[entry.selector] = [
      ...(priceCandidates[entry.selector] ?? []),
      ...priceCandidate(entry.selector, entry.text, entry),
    ];
  }
  return snapshot({ candidates: priceCandidates });
}

function observedD4FailureSnapshot(observation: typeof AMAZON_DETAIL_D4_FIELD_FAILURE_OBSERVATIONS[number]) {
  const base = snapshot();
  const fakeTitlePair = observation.titleConflict
    ? [
      ...candidate("#productTitle", { text: "Synthetic D4 target title 24 oz &amp; steel" }),
      ...candidate("#productTitle", { text: "Synthetic D4 target title 32 oz & steel" }),
    ]
    : base.candidates["#productTitle"];
  const priceTexts = observation.observedPriceCandidates ?? ["$24.99", "$22.99"];
  const rows: AmazonDetailPageDomSnapshot["specificationRows"] = [];
  if (observation.dateFirstAvailablePresent) {
    rows.push({ region: "productSpecifications", selector: "#detailBullets_feature_div li", label: null, value: null, text: "Date First Available January 2, 2020" });
  }
  if (observation.itemDimensionsPresent) {
    rows.push({ region: "productSpecifications", selector: "#productDetails_techSpec_section_1 tr", label: null, value: null, text: "Product Dimensions 2 x 3 x 4 inches" });
  }
  const d4Candidates: AmazonDetailPageDomSnapshot["candidates"] = { ...base.candidates };
  for (const selector of PRICE_SELECTORS) d4Candidates[selector] = [];
  if (observation.priceConflict) {
    d4Candidates[PAY_NOW_SELECTOR] = priceTexts.flatMap((text) => priceCandidate(PAY_NOW_SELECTOR, text, {
      purchaseContext: "unknown",
      selected: null,
    }));
  }
  const asinCandidate = candidate("input#ASIN", { value: observation.asin });
  return snapshot({
    pageUrl: `https://www.amazon.com/dp/${observation.asin}`,
    candidates: {
      ...d4Candidates,
      "input#ASIN": asinCandidate,
      "#productTitle": fakeTitlePair,
    },
    specificationRows: rows,
  });
}

function snapshot(overrides: Partial<AmazonDetailPageDomSnapshot> = {}): AmazonDetailPageDomSnapshot {
  const candidates: AmazonDetailPageDomSnapshot["candidates"] = {
    "input#ASIN": candidate("input#ASIN", { value: ASIN }),
    "#productTitle": candidate("#productTitle", { text: "Example Target Product" }),
    "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen": priceCandidate(
      "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
      "$24.99",
    ),
    "#acrPopover .a-icon-alt": candidate("#acrPopover .a-icon-alt", { text: "4.6 out of 5 stars" }),
    "#acrCustomerReviewText": candidate("#acrCustomerReviewText", { text: "1,234 ratings" }),
    "#detailBullets_feature_div li": [
      { selector: "#detailBullets_feature_div li", text: "Best Sellers Rank: #2,541 in Kitchen & Dining #7 in Cutting Boards", label: null, value: null, href: null, src: null, alt: null, selected: null },
    ],
    "#wayfinding-breadcrumbs_feature_div a": [
      { selector: "#wayfinding-breadcrumbs_feature_div a", text: "Home", label: null, value: null, href: null, src: null, alt: null, selected: null },
      { selector: "#wayfinding-breadcrumbs_feature_div a", text: "Kitchen & Dining", label: null, value: null, href: null, src: null, alt: null, selected: null },
    ],
    "#feature-bullets li .a-list-item": [
      { selector: "#feature-bullets li .a-list-item", text: "Target bullet one", label: null, value: null, href: null, src: null, alt: null, selected: null },
    ],
    "#landingImage": candidate("#landingImage", { src: "https://m.media-amazon.com/images/I/target-main.jpg" }),
    "#altImages img": [
      { selector: "#altImages img", text: null, label: null, value: null, href: null, src: "https://m.media-amazon.com/images/I/target-gallery.jpg", alt: "Target view", selected: null },
    ],
    "#social-proofing-faceout": candidate("#social-proofing-faceout", { text: "1K+ bought in past month" }),
    "#tabular-buybox-container": candidate("#tabular-buybox-container", { text: "Ships from Amazon.com\nSold by Example Seller" }),
    "#tabular-buybox-container #sellerProfileTriggerId": candidate("#tabular-buybox-container #sellerProfileTriggerId", { text: "Example Seller" }),
    ".basisPrice .a-offscreen": candidate(".basisPrice .a-offscreen", { text: "$34.99" }),
    "#couponText": candidate("#couponText", { text: "Save 10% with coupon" }),
    "#histogramTable tr": [
      { selector: "#histogramTable tr", text: "5 star 82%", label: null, value: null, href: null, src: null, alt: null, selected: null },
    ],
    "#twister option": [
      { selector: "#twister option", text: "Blue", label: null, value: "blue", href: null, src: null, alt: null, selected: true },
    ],
    "#productDescription": candidate("#productDescription", { text: "A bounded target-product description." }),
    "#aplus_feature_div": candidate("#aplus_feature_div", { text: "" }),
  };
  return {
    schemaVersion: "amazon-detail-page-dom-snapshot.v1",
    pageUrl: PAGE_URL,
    pageStatus: "ok",
    productRootSelector: "#dp",
    candidates,
    specificationRows: [
      { region: "productSpecifications", selector: "#productDetails_expanderTables_depthLeftSections table tr", label: "Brand", value: "Example Brand", text: "Brand Example Brand" },
      { region: "productSpecifications", selector: "#productDetails_expanderTables_depthLeftSections table tr", label: "Product Dimensions", value: "7.5 x 3.1 x 2.0 inches", text: "Product Dimensions 7.5 x 3.1 x 2.0 inches" },
      { region: "productSpecifications", selector: "#productDetails_expanderTables_depthLeftSections table tr", label: "Item Weight", value: "1.2 pounds", text: "Item Weight 1.2 pounds" },
      { region: "productSpecifications", selector: "#productDetails_expanderTables_depthLeftSections table tr", label: "Date First Available", value: "September 11, 2018", text: "Date First Available September 11, 2018" },
      { region: "productSpecifications", selector: "#productDetails_expanderTables_depthLeftSections table tr", label: "Material Type", value: "Stainless Steel", text: "Material Type Stainless Steel" },
      { region: "productSpecifications", selector: "#productDetails_expanderTables_depthLeftSections table tr", label: "Sponsored Product", value: "Neighbor Brand", text: "Sponsored Product Neighbor Brand" },
      { region: "productSpecifications", selector: "#productDetails_expanderTables_depthLeftSections table tr", label: "FBA Fee", value: "$5.12", text: "FBA Fee $5.12" },
    ],
    ...overrides,
  };
}

function valueOf(result: ReturnType<typeof extractAmazonDetailPageV2>, field: string) {
  return result.registeredFields[field]?.value;
}

describe("Amazon detail extractor V2 field registry", () => {
  it("defines the complete detail contract with explicit semantics, scope, parsers, targets, and missing/ambiguity behavior", () => {
    const byField = new Map(AMAZON_DETAIL_FIELD_REGISTRY.map((rule) => [rule.canonicalField, rule]));
    for (const field of [
      "asin", "title", "brand", "productUrl", "marketplace", "price", "currency", "rating", "reviewCount",
      "bsrRanks", "primaryBsr", "subCategoryBsr", "categoryPath", "dateFirstAvailable", "bulletPoints", "mainImage", "material",
      "packageDimensions", "packageWeight", "itemDimensions", "itemWeight", "seller", "shipsFrom", "fulfillment",
      "galleryImages", "ratingDistribution", "variations", "parentAsin", "listPrice", "coupon", "boughtPastMonth",
      "rawSpecifications", "productDescription", "aPlusPresence", "fbaFee", "estimatedMonthlySales", "estimatedMonthlyRevenue",
    ]) {
      const rule = byField.get(field);
      expect(rule, field).toBeDefined();
      expect(rule?.fieldNature).toBeTruthy();
      expect(rule?.pageRegion).toBeTruthy();
      expect(rule?.parser).toBeTruthy();
      expect(rule?.validator).toBeTruthy();
      expect(rule?.missingBehavior).toBeTruthy();
      expect(rule?.ambiguityBehavior).toBeTruthy();
      expect(rule?.targetStorage).toBeDefined();
      expect(rule?.sourceTrace).toBeTruthy();
    }
    expect(byField.get("fbaFee")).toMatchObject({ fieldNature: "BLOCKED", selectorCandidates: [], targetStorage: null });
    expect(byField.get("estimatedMonthlySales")).toMatchObject({ fieldNature: "BLOCKED", selectorCandidates: [], targetStorage: null });
  });

  it("preserves all BSR ranks, separates item/package fields, and keeps bought-past-month as an estimate", () => {
    const result = extractAmazonDetailPageV2(snapshot(), {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
      marketplace: "US",
    });

    expect(result.entityBound).toBe(true);
    expect(result.fields.title.value).toBe("Example Target Product");
    expect(valueOf(result, "brand")).toBe("Example Brand");
    expect(valueOf(result, "productUrl")).toBe(`https://www.amazon.com/dp/${ASIN}`);
    expect(valueOf(result, "marketplace")).toBe("US");
    expect(valueOf(result, "price")).toMatchObject({ amount: 24.99, currency: "USD" });
    expect(valueOf(result, "currency")).toBe("USD");
    expect(valueOf(result, "rating")).toBe(4.6);
    expect(valueOf(result, "reviewCount")).toBe(1234);
    expect(valueOf(result, "bsrRanks")).toEqual([
      { rank: 2541, category: "Kitchen & Dining" },
      { rank: 7, category: "Cutting Boards" },
    ]);
    expect(valueOf(result, "primaryBsr")).toMatchObject({ rank: 2541, category: "Kitchen & Dining", ruleVersion: "primary-bsr.v1" });
    expect(valueOf(result, "subCategoryBsr")).toMatchObject({ rank: 7, category: "Cutting Boards", ruleVersion: "sub-category-bsr.v1" });
    expect(valueOf(result, "itemDimensions")).toMatchObject({ rawText: "7.5 x 3.1 x 2.0 inches" });
    expect(valueOf(result, "packageDimensions")).toBeNull();
    expect(valueOf(result, "itemWeight")).toMatchObject({ rawText: "1.2 pounds" });
    expect(valueOf(result, "packageWeight")).toBeNull();
    expect(valueOf(result, "dateFirstAvailable")).toEqual({ rawText: "September 11, 2018", normalizedDate: "2018-09-11" });
    expect(valueOf(result, "material")).toBe("Stainless Steel");
    expect(valueOf(result, "categoryPath")).toEqual(["Home", "Kitchen & Dining"]);
    expect(valueOf(result, "bulletPoints")).toEqual(["Target bullet one"]);
    expect(valueOf(result, "mainImage")).toBe("https://m.media-amazon.com/images/I/target-main.jpg");
    expect(valueOf(result, "galleryImages")).toEqual(["https://m.media-amazon.com/images/I/target-gallery.jpg"]);
    expect(valueOf(result, "seller")).toBe("Example Seller");
    expect(valueOf(result, "shipsFrom")).toBe("Amazon.com");
    expect(valueOf(result, "fulfillment")).toMatchObject({ value: "amazon_fulfilled", derivedFrom: ["seller", "shipsFrom"], ruleVersion: "fulfillment.v1" });
    expect(valueOf(result, "ratingDistribution")).toEqual({ "5": 82 });
    expect(valueOf(result, "listPrice")).toMatchObject({ amount: 34.99, currency: "USD" });
    expect(valueOf(result, "coupon")).toMatchObject({ percent: 10, currency: null });
    expect(valueOf(result, "variations")).toEqual([{ value: "Blue", selected: true }]);
    expect(valueOf(result, "productDescription")).toBe("A bounded target-product description.");
    expect(valueOf(result, "aPlusPresence")).toBe(false);
    expect(valueOf(result, "boughtPastMonth")).toEqual({
      rawText: "1K+ bought in past month",
      lowerBound: 1000,
      upperBound: null,
      qualifier: "at_least",
      metricNature: "estimate",
    });
    expect(valueOf(result, "rawSpecifications")).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Sponsored Product" }),
    ]));
    expect(valueOf(result, "fbaFee")).toBeNull();
    expect(valueOf(result, "estimatedMonthlySales")).toBeNull();
    expect(valueOf(result, "estimatedMonthlyRevenue")).toBeNull();
  });

  it("derives subCategoryBsr from bsrRanks without re-capturing, and fails closed when the page reports no sub-category rank", () => {
    const rankRow = (text: string) => ({
      selector: "#detailBullets_feature_div li",
      text,
      label: null,
      value: null,
      href: null,
      src: null,
      alt: null,
      selected: null,
    });
    const withRanks = (text: string | null) => snapshot({
      candidates: {
        ...snapshot().candidates,
        "#detailBullets_feature_div li": text === null ? [] : [rankRow(text)],
      },
    });
    const config = { expectedAsin: ASIN, capturedAt: "2026-09-25T00:00:00.000Z", collectorVersion: "amazon-detail-extractor.v2", marketplace: "US" as const };

    // ① 页面报告根类目 + 小类目：第一条作为 primaryBsr，第一条不同类目作为 subCategoryBsr。
    const multi = extractAmazonDetailPageV2(
      withRanks("Best Sellers Rank: #666 in Beauty & Personal Care #27 in Facial Serums #44 in Facial Creams & Moisturizers"),
      config,
    );
    expect(valueOf(multi, "bsrRanks")).toEqual([
      { rank: 666, category: "Beauty & Personal Care" },
      { rank: 27, category: "Facial Serums" },
      { rank: 44, category: "Facial Creams & Moisturizers" },
    ]);
    expect(valueOf(multi, "primaryBsr")).toMatchObject({ rank: 666, category: "Beauty & Personal Care" });
    expect(valueOf(multi, "subCategoryBsr")).toMatchObject({ rank: 27, category: "Facial Serums", ruleVersion: "sub-category-bsr.v1" });
    expect(multi.registeredFields.subCategoryBsr).toMatchObject({
      status: "derived",
      priority: "P2",
      fieldNature: "DERIVED_FACT",
      sourceTrace: { selector: "@bsrRanks", label: "Facial Serums", ruleVersion: "sub-category-bsr.v1" },
    });

    // ② 页面只报告单一（根类目）排名：主 BSR 保留既有行为，小类目 BSR 诚实置 missing，不编造。
    const single = extractAmazonDetailPageV2(withRanks("Best Sellers Rank: #666 in Beauty & Personal Care"), config);
    expect(valueOf(single, "primaryBsr")).toMatchObject({ rank: 666, category: "Beauty & Personal Care" });
    expect(single.registeredFields.subCategoryBsr).toMatchObject({ status: "missing", value: null, reason: "no_sub_category_rank" });

    // ③ 页面没有 BSR：两者都保持 missing。
    const none = extractAmazonDetailPageV2(withRanks(null), config);
    expect(valueOf(none, "bsrRanks")).toEqual([]);
    expect(none.registeredFields.primaryBsr).toMatchObject({ status: "missing", value: null, reason: "no_valid_bsr_ranks" });
    expect(none.registeredFields.subCategoryBsr).toMatchObject({ status: "missing", value: null, reason: "no_valid_bsr_ranks" });
  });

  it("maps explicit package labels only to package fields and keeps all four physical fields independent", () => {
    const physicalRows = [
      { region: "productSpecifications", selector: "table tr", label: "Item Dimensions", value: "2 x 3 x 4 inches", text: "Item Dimensions 2 x 3 x 4 inches" },
      { region: "productSpecifications", selector: "table tr", label: "Package Dimensions", value: "5 x 6 x 7 inches", text: "Package Dimensions 5 x 6 x 7 inches" },
      { region: "productSpecifications", selector: "table tr", label: "Item Weight", value: "8 ounces", text: "Item Weight 8 ounces" },
      { region: "productSpecifications", selector: "table tr", label: "Shipping Weight", value: "1.5 pounds", text: "Shipping Weight 1.5 pounds" },
    ];
    const result = extractAmazonDetailPageV2(snapshot({ specificationRows: physicalRows }), {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });

    expect(valueOf(result, "itemDimensions")).toMatchObject({ rawText: "2 x 3 x 4 inches", dimensions: [2, 3, 4], unit: "in" });
    expect(valueOf(result, "packageDimensions")).toMatchObject({ rawText: "5 x 6 x 7 inches", dimensions: [5, 6, 7], unit: "in" });
    expect(valueOf(result, "itemWeight")).toMatchObject({ rawText: "8 ounces", amount: 8, unit: "oz" });
    expect(valueOf(result, "packageWeight")).toMatchObject({ rawText: "1.5 pounds", amount: 1.5, unit: "lb" });
  });

  it("does not borrow a recommended product's brand or price and leaves absent target brand missing", () => {
    const noBrand = snapshot({
      specificationRows: [],
      candidates: {
        ...snapshot().candidates,
        "#recommended-brand": candidate("#recommended-brand", { text: "Neighbor Brand" }),
        "#recommended-price": candidate("#recommended-price", { text: "$999.99" }),
        "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen": priceCandidate("#corePriceDisplay_desktop_feature_div .a-price .a-offscreen", "$24.99"),
      },
    });
    const result = extractAmazonDetailPageV2(noBrand, {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });

    expect(result.entityBound).toBe(true);
    expect(result.registeredFields.brand).toMatchObject({ status: "missing", value: null });
    expect(valueOf(result, "price")).toMatchObject({ amount: 24.99, currency: "USD" });
  });

  it("fails closed instead of choosing a conflicting price by selector priority", () => {
    const result = extractAmazonDetailPageV2(priceSnapshot([
      { selector: DESKTOP_PRICE_SELECTOR, text: "$19.97", purchaseContext: "not_applicable" },
      { selector: MOBILE_PRICE_SELECTOR, text: "$18.97", purchaseContext: "not_applicable" },
    ]), {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });

    expect(result.registeredFields.price).toMatchObject({ status: "ambiguous", value: null, reason: "conflicting_candidates" });
    expect(result.registeredFields.currency).toMatchObject({ status: "ambiguous", value: null, reason: "conflicting_candidates" });
  });

  it("uses only a current pay-now price when list, unit, basis, coupon, or member prices are also visible", () => {
    const result = extractAmazonDetailPageV2(priceSnapshot([
      { selector: PAY_NOW_SELECTOR, text: "$19.97" },
      { selector: DESKTOP_PRICE_SELECTOR, text: "$34.99", role: "list_price", className: "a-price a-text-price", dataAColor: "secondary" },
      { selector: DESKTOP_PRICE_SELECTOR, text: "$1.30", role: "unit_price", className: "a-price apex-priceperunit-value" },
      { selector: DESKTOP_PRICE_SELECTOR, text: "$87.99", role: "basis_price", className: "a-price apex-basisprice-value" },
      { selector: DESKTOP_PRICE_SELECTOR, text: "$15.97", role: "coupon", className: "a-price coupon-price" },
      { selector: DESKTOP_PRICE_SELECTOR, text: "$17.97", role: "member_price", className: "a-price member-price" },
    ]), {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });

    expect(result.registeredFields.price).toMatchObject({ status: "observed", sourceTrace: { selector: PAY_NOW_SELECTOR } });
    expect(valueOf(result, "price")).toMatchObject({ amount: 19.97, currency: "USD" });
    expect(result.registeredFields.currency).toMatchObject({ status: "observed", sourceTrace: { selector: PAY_NOW_SELECTOR } });
    expect(valueOf(result, "currency")).toBe("USD");
  });

  it("uses the selected one-time purchase price and never substitutes an unselected Subscribe & Save price", () => {
    const result = extractAmazonDetailPageV2(priceSnapshot([
      { selector: PAY_NOW_SELECTOR, text: "$19.97", purchaseContext: "one_time", selected: true },
      { selector: PAY_NOW_SELECTOR, text: "$18.97", purchaseContext: "subscribe_save", selected: false },
    ]), {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });

    expect(valueOf(result, "price")).toMatchObject({ amount: 19.97, currency: "USD" });
    expect(valueOf(result, "currency")).toBe("USD");
  });

  it("keeps two unselected current purchase candidates ambiguous even if one is cheaper", () => {
    const result = extractAmazonDetailPageV2(priceSnapshot([
      { selector: PAY_NOW_SELECTOR, text: "$19.97", purchaseContext: "one_time", selected: null },
      { selector: PAY_NOW_SELECTOR, text: "$18.97", purchaseContext: "subscribe_save", selected: null },
    ]), {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });

    expect(result.registeredFields.price).toMatchObject({ status: "ambiguous", value: null, reason: "conflicting_candidates" });
    expect(result.registeredFields.currency).toMatchObject({ status: "ambiguous", value: null, reason: "conflicting_candidates" });
  });

  it("does not treat a recommended, sponsored, or unrelated offer price as the target ProductFact price", () => {
    const base = snapshot();
    const candidates = { ...base.candidates };
    for (const selector of PRICE_SELECTORS) candidates[selector] = [];
    candidates[".priceToPay .a-offscreen"] = priceCandidate(".priceToPay .a-offscreen", "$999.99", { inPrimaryBuyBox: false });
    const result = extractAmazonDetailPageV2(snapshot({ candidates }), {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });

    expect(result.registeredFields.price).toMatchObject({ status: "missing", value: null });
    expect(result.registeredFields.currency).toMatchObject({ status: "missing", value: null });
  });

  it("selects Amazon's explicit pay-now price node instead of per-unit or basis prices", () => {
    const desktopSelector = "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen";
    const corePriceSelector = "#corePrice_feature_div .a-offscreen";
    const payNowSelector = "#corePrice_feature_div .apex-pricetopay-value .a-offscreen";
    const page = snapshot({
      candidates: {
        ...snapshot().candidates,
        [desktopSelector]: [
          ...candidate(desktopSelector, { text: "$1.30", priceContext: { id: null, className: "a-price a-text-price apex-priceperunit-value", dataAColor: "base", dataASize: "mini" } }),
          ...candidate(desktopSelector, { text: "$87.99", priceContext: { id: null, className: "a-price a-text-price apex-basisprice-value", dataAColor: "secondary", dataASize: "s" } }),
        ],
        [corePriceSelector]: [
          ...candidate(corePriceSelector, { text: "$69.98", priceContext: { id: null, className: "a-price aok-align-center apex-pricetopay-value", dataAColor: "base", dataASize: "xl" } }),
          ...candidate(corePriceSelector, { text: "$1.30", priceContext: { id: null, className: "a-price a-text-price apex-priceperunit-value", dataAColor: "base", dataASize: "mini" } }),
        ],
        [payNowSelector]: candidate(payNowSelector, { text: "$69.98", priceContext: { id: null, className: "a-price aok-align-center apex-pricetopay-value", dataAColor: "base", dataASize: "xl" } }),
      },
    });
    const result = extractAmazonDetailPageV2(page, {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
      marketplace: "US",
    });

    expect(result.registeredFields.price).toMatchObject({ status: "observed", sourceTrace: { selector: payNowSelector } });
    expect(valueOf(result, "price")).toMatchObject({ amount: 69.98, currency: "USD" });
    expect(result.registeredFields.currency).toMatchObject({ status: "observed", sourceTrace: { selector: payNowSelector } });
  });

  it("fails closed when the detail snapshot has no primary title candidate", () => {
    const page = snapshot({
      candidates: {
        ...snapshot().candidates,
        "#productTitle": [],
      },
    });
    const result = extractAmazonDetailPageV2(page, {
      expectedAsin: ASIN,
      capturedAt: "2026-10-13T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
      marketplace: "US",
    });

    expect(result.entityBound).toBe(false);
    expect(result.registeredFields.title).toMatchObject({ status: "missing", value: null });
  });

  it("normalizes only equivalent encoded ampersands in duplicate titles and keeps substantive conflicts blocked", () => {
    const titleSelector = "#productTitle";
    const equivalent = extractAmazonDetailPageV2(snapshot({
      candidates: {
        ...snapshot().candidates,
        [titleSelector]: [
          ...candidate(titleSelector, { text: "Home Hero Silicone & Stainless Steel Utensils" }),
          ...candidate(titleSelector, { text: "Home Hero Silicone &amp; Stainless Steel Utensils" }),
        ],
      },
    }), {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });
    const substantiveConflict = extractAmazonDetailPageV2(snapshot({
      candidates: {
        ...snapshot().candidates,
        [titleSelector]: [
          ...candidate(titleSelector, { text: "Home Hero Silicone & Stainless Steel Utensils" }),
          ...candidate(titleSelector, { text: "Different Neighbor Product" }),
        ],
      },
    }), {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });

    expect(equivalent.registeredFields.title).toMatchObject({ status: "observed", value: "Home Hero Silicone & Stainless Steel Utensils" });
    expect(substantiveConflict.registeredFields.title).toMatchObject({ status: "ambiguous", value: null, reason: "conflicting_candidates" });
  });

  it("normalizes decimal and hexadecimal ampersand entities in the canonical title", () => {
    const titleSelector = "#productTitle";
    const result = extractAmazonDetailPageV2(snapshot({
      candidates: {
        ...snapshot().candidates,
        [titleSelector]: [
          ...candidate(titleSelector, { text: "Salt &amp; Pepper" }),
          ...candidate(titleSelector, { text: "Salt &#38; Pepper" }),
          ...candidate(titleSelector, { text: "Salt &#x26; Pepper" }),
        ],
      },
    }), {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });

    expect(result.registeredFields.title).toMatchObject({ status: "observed", value: "Salt & Pepper" });
  });

  it("takes the fullest title when one candidate is the prefix of all others (real page visible/offscreen pair)", () => {
    // 2026-10-14 真实 ASIN B0CFTP6JR4：#productTitle 下同时存在可见短标题与离屏完整标题，
    // 短标题是完整标题的前缀。这不是冲突，而是同一标题的两种呈现；取完整版，仍来自页面真实文本。
    const titleSelector = "#productTitle";
    const visible = "Koolstuffs Silicone Baking Mat, Nonstick and Reusable, 3 Pack";
    const full = "Koolstuffs Silicone Baking Mat, Nonstick and Reusable, 3 Pack | Easy Cleanup, Half- and Quarter-Sheet Sizes for Cookies, Bread, Pastries, Roasted Vegetables, Gray";
    const result = extractAmazonDetailPageV2(snapshot({
      candidates: {
        ...snapshot().candidates,
        [titleSelector]: [
          ...candidate(titleSelector, { text: visible }),
          // 离屏完整标题：innerText 为空，文本来自 textContent（快照的 value 通道）。
          ...candidate(titleSelector, { value: full }),
        ],
      },
    }), {
      expectedAsin: ASIN,
      capturedAt: "2026-10-14T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });

    expect(result.registeredFields.title).toMatchObject({ status: "observed", value: full });
  });

  it("keeps genuinely different titles ambiguous even when one is a prefix of a third candidate", () => {
    const titleSelector = "#productTitle";
    const result = extractAmazonDetailPageV2(snapshot({
      candidates: {
        ...snapshot().candidates,
        [titleSelector]: [
          ...candidate(titleSelector, { text: "Home Hero Silicone Utensils" }),
          ...candidate(titleSelector, { text: "Home Hero Silicone Utensils Pro Set" }),
          ...candidate(titleSelector, { text: "Different Neighbor Product" }),
        ],
      },
    }), {
      expectedAsin: ASIN,
      capturedAt: "2026-10-14T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });

    expect(result.registeredFields.title).toMatchObject({ status: "ambiguous", value: null, reason: "conflicting_candidates" });
  });

  it("normalizes Unicode-equivalent whitespace but does not normalize material title differences", () => {
    const titleSelector = "#productTitle";
    const whitespaceEquivalent = extractAmazonDetailPageV2(snapshot({
      candidates: {
        ...snapshot().candidates,
        [titleSelector]: [
          ...candidate(titleSelector, { text: "Target\u00a0Product\n16 oz" }),
          ...candidate(titleSelector, { text: "Target Product\u300016 oz" }),
        ],
      },
    }), {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });
    const materialConflict = extractAmazonDetailPageV2(snapshot({
      candidates: {
        ...snapshot().candidates,
        [titleSelector]: [
          ...candidate(titleSelector, { text: "Target Product 24 oz" }),
          ...candidate(titleSelector, { text: "Target Product 32 oz" }),
        ],
      },
    }), {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });

    expect(whitespaceEquivalent.registeredFields.title).toMatchObject({ status: "observed", value: "Target Product 16 oz" });
    expect(materialConflict.registeredFields.title).toMatchObject({ status: "ambiguous", value: null, reason: "conflicting_candidates" });
  });

  it("recovers report-backed D4 failure patterns from minimal offline fixtures without raw page HTML", () => {
    for (const observation of AMAZON_DETAIL_D4_FIELD_FAILURE_OBSERVATIONS) {
      const page = observedD4FailureSnapshot(observation);
      const result = extractAmazonDetailPageV2(page, {
        expectedAsin: observation.asin,
        capturedAt: "2026-09-23T00:00:00.000Z",
        collectorVersion: "amazon-detail-extractor.v2",
        marketplace: "US",
      });

      expect(result.entityBound, observation.asin).toBe(true);
      if (observation.titleConflict) {
        expect(result.registeredFields.title, observation.asin).toMatchObject({ status: "ambiguous", value: null, reason: "conflicting_candidates" });
      }
      if (observation.priceConflict) {
        expect(result.registeredFields.price, observation.asin).toMatchObject({ status: "ambiguous", value: null });
        expect(result.registeredFields.currency, observation.asin).toMatchObject({ status: "ambiguous", value: null });
      }
      if (observation.dateFirstAvailablePresent) {
        expect(result.registeredFields.dateFirstAvailable, observation.asin).toMatchObject({
          status: "observed",
          value: { rawText: "January 2, 2020", normalizedDate: "2020-01-02" },
        });
      }
      if (observation.itemDimensionsPresent) {
        expect(result.registeredFields.itemDimensions, observation.asin).toMatchObject({
          status: "observed",
          value: { rawText: "2 x 3 x 4 inches", dimensions: [2, 3, 4], unit: "in" },
        });
        expect(result.registeredFields.packageDimensions, observation.asin).toMatchObject({ status: "missing", value: null });
      }
    }
  });

  it("extracts Date First Available from a scoped label-to-sibling row and keeps absent dates missing", () => {
    const present = extractAmazonDetailPageV2(snapshot({
      specificationRows: [
        { region: "productSpecifications", selector: "#productDetails_techSpec_section_1 tr", label: " Date first available: ", value: "March 4, 2022", text: "Date first available: March 4, 2022" },
      ],
    }), {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });
    const absent = extractAmazonDetailPageV2(snapshot({ specificationRows: [] }), {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });

    expect(valueOf(present, "dateFirstAvailable")).toEqual({ rawText: "March 4, 2022", normalizedDate: "2022-03-04" });
    expect(present.registeredFields.dateFirstAvailable.status).toBe("observed");
    expect(absent.registeredFields.dateFirstAvailable).toMatchObject({ status: "missing", value: null });
  });

  it("maps Product Dimensions to itemDimensions only and never cross-fills packageDimensions", () => {
    const itemOnly = extractAmazonDetailPageV2(snapshot({
      specificationRows: [
        { region: "productSpecifications", selector: "#productDetails_detailBullets_sections1 tr", label: null, value: null, text: "Product Dimensions: 4 x 5 x 6 cm" },
      ],
    }), {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });
    const packageOnly = extractAmazonDetailPageV2(snapshot({
      specificationRows: [
        { region: "productSpecifications", selector: "#productDetails_techSpec_section_1 tr", label: "Package Dimensions", value: "8 x 9 x 10 inches", text: "Package Dimensions 8 x 9 x 10 inches" },
      ],
    }), {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });

    expect(valueOf(itemOnly, "itemDimensions")).toMatchObject({ rawText: "4 x 5 x 6 cm", dimensions: [4, 5, 6], unit: "cm" });
    expect(itemOnly.registeredFields.packageDimensions).toMatchObject({ status: "missing", value: null });
    expect(valueOf(packageOnly, "packageDimensions")).toMatchObject({ rawText: "8 x 9 x 10 inches", dimensions: [8, 9, 10], unit: "in" });
    expect(packageOnly.registeredFields.itemDimensions).toMatchObject({ status: "missing", value: null });
  });

  it("falls back past invalid higher-priority prices but rejects conflicting values within the chosen selector", () => {
    const desktopSelector = "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen";
    const mobileSelector = "#corePriceDisplay_mobile_feature_div .a-price .a-offscreen";
    const result = extractAmazonDetailPageV2(snapshot({
      candidates: {
        ...snapshot().candidates,
        [desktopSelector]: candidate(desktopSelector, { text: "Price unavailable" }),
        [mobileSelector]: [
          ...priceCandidate(mobileSelector, "$19.99"),
          ...priceCandidate(mobileSelector, "$21.99"),
        ],
      },
    }), {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });

    expect(result.registeredFields.price).toMatchObject({ status: "ambiguous", reason: "conflicting_candidates" });
    expect(result.registeredFields.currency).toMatchObject({ status: "ambiguous", reason: "conflicting_candidates" });
    expect(valueOf(result, "price")).toBeNull();
    expect(valueOf(result, "currency")).toBeNull();
  });

  it("audits field presence independently from extraction status using the bounded target-product snapshot", () => {
    const page = snapshot({
      candidates: {
        ...snapshot().candidates,
        "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen": candidate(
          "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
          { text: "Retail price $24.99" },
        ),
      },
    });
    const presence = auditAmazonDetailPageFieldPresence(page);
    const extraction = extractAmazonDetailPageV2(page, {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
      marketplace: "US",
    });

    expect(extraction.registeredFields.price.status).toBe("missing");
    expect(presence.fields.price).toBe(true);
    expect(presence.fields.currency).toBe(true);
    expect(presence.fields.dateFirstAvailable).toBe(true);
    expect(presence.fields.itemDimensions).toBe(true);
    expect(presence.fields.packageDimensions).toBe(false);
    expect(presence.fields.primaryBsr).toBe(true);
    expect(presence.fields.productUrl).toBe(true);
    expect(presence.fields.marketplace).toBe(true);
  });

  it("does not count recommendation or general specification rows as target price or package fields", () => {
    const page = snapshot({
      candidates: {
        ...snapshot().candidates,
        "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen": [],
        "#recommended-price": candidate("#recommended-price", { text: "$999.99" }),
      },
      specificationRows: [
        { region: "productSpecifications", selector: "table tr", label: "Color", value: "Blue", text: "Color Blue" },
      ],
    });
    const presence = auditAmazonDetailPageFieldPresence(page);

    expect(presence.fields.price).toBe(false);
    expect(presence.fields.packageDimensions).toBe(false);
    expect(presence.fields.itemWeight).toBe(false);
  });

  it("returns only bounded title and price candidate text for opt-in D4 conflict diagnostics", () => {
    const titleSelector = "#productTitle";
    const desktopPriceSelector = "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen";
    const page = snapshot({
      candidates: {
        ...snapshot().candidates,
        [titleSelector]: [
          ...candidate(titleSelector, { text: "Example Target Product" }),
          ...candidate(titleSelector, { text: "Example Target Product - Alternate Title" }),
        ],
        [desktopPriceSelector]: [
          ...candidate(desktopPriceSelector, { text: "$24.99", priceContext: { id: "desktop-price", className: "a-price aok-align-center", dataAColor: "price", dataASize: "l" } }),
          ...candidate(desktopPriceSelector, { text: "$34.99", priceContext: { id: "desktop-list-price", className: "a-price a-text-price", dataAColor: "secondary", dataASize: "s" } }),
        ],
        "#corePriceDisplay_mobile_feature_div .a-price .a-offscreen": candidate(
          "#corePriceDisplay_mobile_feature_div .a-price .a-offscreen",
          { text: "$19.99", priceContext: { id: "mobile-price", className: "a-price aok-align-center", dataAColor: "price", dataASize: "l" } },
        ),
        "#recommended-price": candidate("#recommended-price", { text: "$999.99" }),
      },
    });

    const presence = auditAmazonDetailPageFieldPresence(page, { includeCandidateEvidence: true });

    expect(presence.candidateEvidence).toEqual({
      titleCandidates: [
        { selector: titleSelector, text: "Example Target Product" },
        { selector: titleSelector, text: "Example Target Product - Alternate Title" },
      ],
      priceCandidates: [
        { selector: desktopPriceSelector, text: "$24.99", priceContext: { id: "desktop-price", className: "a-price aok-align-center", dataAColor: "price", dataASize: "l" } },
        { selector: desktopPriceSelector, text: "$34.99", priceContext: { id: "desktop-list-price", className: "a-price a-text-price", dataAColor: "secondary", dataASize: "s" } },
        { selector: "#corePriceDisplay_mobile_feature_div .a-price .a-offscreen", text: "$19.99", priceContext: { id: "mobile-price", className: "a-price aok-align-center", dataAColor: "price", dataASize: "l" } },
      ],
    });
  });

  it("fails closed for a cross-ASIN snapshot and includes bounded source trace on present fields", () => {
    const unbound = snapshot({
      specificationRows: [{ region: "productSpecifications", selector: "table tr", label: "ASIN", value: "B0OTHER001", text: "ASIN B0OTHER001" }],
    });
    const result = extractAmazonDetailPageV2(unbound, {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });

    expect(result.entityBound).toBe(false);
    expect(result.registeredFields.brand).toMatchObject({ status: "missing", value: null, reason: "entity_binding_unproven" });

    const bound = extractAmazonDetailPageV2(snapshot(), {
      expectedAsin: ASIN,
      capturedAt: "2026-09-23T00:00:00.000Z",
      collectorVersion: "amazon-detail-extractor.v2",
    });
    expect(JSON.stringify(bound.registeredFields.brand?.sourceTrace).length).toBeLessThan(400);
    expect(bound.registeredFields.brand?.sourceTrace).toMatchObject({ ruleId: "brand", region: "primary_product_identity_or_specifications" });
  });
});
