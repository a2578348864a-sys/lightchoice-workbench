import { describe, expect, it } from "vitest";
import { planAmazonDetailCapture, planAmazonSearchCapture } from "./amazon";
import type { AmazonDetailPageExtractionV2 } from "@/tools/collectors/amazon/detail-page-extract-v2";

const ASIN = "B00063QBL8";

function detailExtraction(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: "amazon-detail-page-extraction.v1" as const,
    expectedAsin: ASIN,
    urlAsin: ASIN,
    pageAsin: ASIN,
    entityBound: true,
    bindingProof: { urlMatchesExpected: true, pageAnchorMatchesExpected: true, productContainerFound: true },
    pageStatus: "ok" as const,
    fields: {
      asin: { field: "asin" as const, value: ASIN, status: "correct" as const, reason: null },
      title: { field: "title" as const, value: "A real observed Amazon product title", status: "correct" as const, reason: null },
      price: { field: "price" as const, value: 29.99, status: "correct" as const, reason: null },
      bsr: { field: "bsr" as const, value: 321, status: "correct" as const, reason: null },
      rating: { field: "rating" as const, value: 4.5, status: "correct" as const, reason: null },
      reviews: { field: "reviews" as const, value: 1200, status: "correct" as const, reason: null },
    },
    capturedAt: "2026-09-21T00:00:00.000Z",
    collectorVersion: "test",
    ...overrides,
  };
}

describe("Amazon capture recipe bridges", () => {
  it("maps a bound detail extraction without manufacturing a URL", () => {
    const result = planAmazonDetailCapture({
      extraction: detailExtraction(),
      pageUrl: `https://www.amazon.com/dp/${ASIN}`,
      bulletPoints: ["Observed bullet"],
      packageWeight: { value: 1.2, unit: "lb" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.productUrl).toBe(`https://www.amazon.com/dp/${ASIN}`);
    expect(result.payload.price).toBe(29.99);
    expect(result.payload.bulletPoints).toEqual(["Observed bullet"]);
    expect(result.pageContext.entityBinding?.bound).toBe(true);
  });

  it("plans registered V2 detail fields with separate item/package facts and blocked metrics", () => {
    const sourceTrace = {
      ruleId: "fixture",
      registryVersion: "amazon-detail-field-registry.v1" as const,
      region: "primary_product_specifications",
      selector: "#dp",
      label: null,
      ruleVersion: null,
    };
    const field = (canonicalField: string, value: unknown, fieldNature = "DIRECT_FACT", status = "observed") => ({
      canonicalField,
      priority: "P1",
      fieldNature,
      status,
      value,
      reason: null,
      sourceTrace: { ...sourceTrace, ruleId: canonicalField },
    });
    const blocked = (canonicalField: string) => ({
      canonicalField,
      priority: "BLOCKED",
      fieldNature: "BLOCKED",
      status: "blocked",
      value: null,
      reason: "field_contract_blocked",
      sourceTrace: { ...sourceTrace, ruleId: canonicalField, selector: null },
    });
    const extraction = {
      ...detailExtraction(),
      extractorVersion: "amazon-detail-extractor.v2",
      fieldRegistryVersion: "amazon-detail-field-registry.v1",
      registeredFields: {
        asin: field("asin", ASIN),
        title: field("title", "A real observed Amazon product title"),
        price: field("price", { amount: 29.99, currency: "USD" }),
        primaryBsr: field("primaryBsr", { rank: 88, category: "Home & Kitchen" }, "DERIVED_FACT", "derived"),
        subCategoryBsr: field("subCategoryBsr", { rank: 320, category: "Sports & Outdoors" }, "DERIVED_FACT", "derived"),
        bsrRanks: field("bsrRanks", [{ rank: 88, category: "Home & Kitchen" }, { rank: 320, category: "Sports & Outdoors" }]),
        packageWeight: field("packageWeight", { rawText: "Package Weight: 1 lb", amount: 1, unit: "lb" }),
        packageDimensions: field("packageDimensions", { rawText: "Package Dimensions: 10 x 5 x 2 in", dimensions: [10, 5, 2], unit: "in" }),
        itemWeight: field("itemWeight", { rawText: "Item Weight: 12 oz", amount: 12, unit: "oz" }),
        itemDimensions: field("itemDimensions", { rawText: "Item Dimensions: 9 x 4 x 1 in", dimensions: [9, 4, 1], unit: "in" }),
        boughtPastMonth: field("boughtPastMonth", {
          rawText: "1K+ bought in past month",
          lowerBound: 1000,
          upperBound: null,
          qualifier: "at_least",
          metricNature: "estimate",
        }, "ESTIMATED_METRIC"),
        fbaFee: blocked("fbaFee"),
        estimatedMonthlySales: blocked("estimatedMonthlySales"),
        estimatedMonthlyRevenue: blocked("estimatedMonthlyRevenue"),
      },
    } as unknown as AmazonDetailPageExtractionV2;

    const result = planAmazonDetailCapture({
      extraction,
      pageUrl: `https://www.amazon.com/dp/${ASIN}`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toMatchObject({
      bsrRank: 88,
      bsrCategory: "Home & Kitchen",
      subCategoryBsr: 320,
      bsrRanks: [{ rank: 88, category: "Home & Kitchen" }, { rank: 320, category: "Sports & Outdoors" }],
      packageWeight: { value: 1, unit: "lb" },
      packageDimensions: { length: 10, width: 5, height: 2, unit: "in" },
      itemWeight: { value: 12, unit: "oz" },
      itemDimensions: { length: 9, width: 4, height: 1, unit: "in" },
      boughtPastMonth: { rawText: "1K+ bought in past month", lowerBound: 1000, upperBound: null, qualifier: "at_least", metricNature: "estimate" },
      amazonDetail: {
        schemaVersion: "amazon-detail-registered-fields.v1",
        extractorVersion: "amazon-detail-extractor.v2",
        fieldRegistryVersion: "amazon-detail-field-registry.v1",
        primaryBsrProjectionVersion: "primary-bsr.v1",
      },
    });
    expect(result.payload).not.toHaveProperty("fbaFee");
    expect(result.payload).not.toHaveProperty("estimatedMonthlySales");
    expect(result.payload).not.toHaveProperty("estimatedMonthlyRevenueUsd");
  });

  it("turns a CAPTCHA page into a zero-field human gate", () => {
    const result = planAmazonDetailCapture({
      extraction: detailExtraction({
        pageStatus: "captcha",
        entityBound: false,
        bindingProof: { urlMatchesExpected: true, pageAnchorMatchesExpected: false, productContainerFound: false },
        fields: {
          ...detailExtraction().fields,
          title: { field: "title" as const, value: null, status: "unknown" as const, reason: "page_status_captcha" },
        },
      }),
      pageUrl: `https://www.amazon.com/dp/${ASIN}`,
    });
    expect(result).toMatchObject({ ok: false, errorCode: "CAPTCHA_DETECTED", pageContext: { allowFields: false } });
  });

  it("enforces two pages and twenty observations for search capture", () => {
    const page = {
      query: "water bottle",
      page: 1,
      pageStatus: "ok",
      observations: Array.from({ length: 20 }, (_, index) => ({
        appearanceKey: `canary-p1-${String(index + 1).padStart(2, "0")}`,
        page: 1,
        position: index + 1,
        sponsored: index === 0 ? true : index === 1 ? null : false,
        asin: ASIN,
        identityMissingReason: null,
        title: "Observed result",
        priceText: "$29.99",
        priceCurrency: "USD",
        ratingText: "4.5 out of 5 stars",
        reviewCountText: "1,200",
        brand: null,
        observedProductUrl: `https://www.amazon.com/dp/${ASIN}`,
        productUrl: `https://www.amazon.com/dp/${ASIN}`,
        imageUrl: null,
        capturedAt: "2026-09-21T00:00:00.000Z",
        sponsoredDiagnostic: {} as never,
        fieldMissingReasons: {},
      })),
    } as never;
    const result = planAmazonSearchCapture({ pages: [page] });
    expect(result.totalObservationCount).toBe(20);
    expect(result.observations[0]).toMatchObject({ appearanceKey: "canary-p1-01", sponsored: true, status: "ready" });
    expect(result.observations[1]?.sponsored).toBeNull();
    expect(result.observations[2]?.sponsored).toBe(false);
    expect(() => planAmazonSearchCapture({ pages: Array.from({ length: 11 }, () => page) })).toThrow("COLLECTOR_PAGE_BUDGET_EXCEEDED");
    expect(planAmazonSearchCapture({ pages: Array.from({ length: 10 }, () => page), maxAppearances: 200 }).totalObservationCount).toBe(200);
  });

  it("reports an empty normal search explicitly instead of creating a product", () => {
    const result = planAmazonSearchCapture({ pages: [{ query: "nothing", page: 1, pageStatus: "ok", observations: [] } as never] });
    expect(result.emptyResultReason).toBe("no_result_cards");
    expect(result.observations).toEqual([]);
  });

  it("keeps the default twenty budget, permits an explicit bounded sample budget up to the hard cap, and rejects invalid budgets", () => {
    const pageWith = (count: number) => ({ query: "offline budget fixture", page: 1, pageStatus: "ok", observations: Array.from({ length: count }, (_, index) => ({
      asin: ASIN, observedProductUrl: `https://www.amazon.com/dp/${ASIN}`, appearanceKey: `fixture-${index}`, page: 1, position: index + 1,
    })) } as never);
    // 默认预算仍是 20：60 条观察超出默认预算即拒绝
    expect(() => planAmazonSearchCapture({ pages: [pageWith(60)] })).toThrow("COLLECTOR_SAMPLE_BUDGET_EXCEEDED");
    expect(planAmazonSearchCapture({ pages: [pageWith(60)], maxAppearances: 60 }).totalObservationCount).toBe(60);
    // 硬上限提升到 200：恰好 200 条观察在显式授权下可通过，超过则拒绝
    expect(() => planAmazonSearchCapture({ pages: [pageWith(201)] })).toThrow("COLLECTOR_SAMPLE_BUDGET_EXCEEDED");
    expect(planAmazonSearchCapture({ pages: [pageWith(200)], maxAppearances: 200 }).totalObservationCount).toBe(200);
    for (const maxAppearances of [0, 201, 1.5, NaN]) expect(() => planAmazonSearchCapture({ pages: [], maxAppearances })).toThrow("COLLECTOR_SAMPLE_BUDGET_INVALID");
  });

  it("quarantines an ASIN when the search card did not expose an observed product URL", () => {
    const result = planAmazonSearchCapture({ pages: [{
      query: "fixture",
      page: 1,
      pageStatus: "ok",
      observations: [{
        asin: ASIN,
        productUrl: `https://www.amazon.com/dp/${ASIN}`,
        observedProductUrl: null,
        appearanceKey: "canary-p1-01",
        page: 1,
        position: 1,
        sponsored: false,
        identityMissingReason: null,
      }],
    } as never] });
    expect(result.observations[0]).toMatchObject({ status: "quarantined", reason: "product_url_not_observed" });
    expect(result.observations[0]?.payload).toBeNull();
  });
});
