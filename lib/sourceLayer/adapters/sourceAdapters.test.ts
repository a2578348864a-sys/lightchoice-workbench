import * as sellerSpriteXlsx from "@/lib/upstream/sellersprite/xlsx";
import { describe, expect, it, vi } from "vitest";

import "@/lib/sourceLayer/adapters";

import {
  createSourceLayerTestWorkbook,
  SOURCE_LAYER_TEST_HEADERS,
  SOURCE_LAYER_TEST_ROWS,
} from "@/lib/sourceLayer/adapters/__fixtures__/sellerSpriteWorkbook";
import { createSellerSpritePreviewWorkbook } from "@/lib/upstream/sellersprite/previewTestFixtures";
import { captureSellerSpriteXlsx, sellerSpriteAdapter } from "@/lib/sourceLayer/adapters/sellerSpriteAdapter";
import { amazonDomAdapter } from "@/lib/sourceLayer/adapters/amazonDomAdapter";
import { captureManualEntry, manualEntryAdapter } from "@/lib/sourceLayer/adapters/manualEntryAdapter";
import { getSourceAdapter, listSourceAdapters } from "@/lib/sourceLayer/sourceAdapter";

const CAPTURED_AT = "2026-02-01T00:00:00.000Z";
const OPERATOR = "owner:v1";

function captureXlsx(bytes: Uint8Array) {
  return sellerSpriteAdapter.capture({
    payload: bytes,
    capturedAt: CAPTURED_AT,
    operator: OPERATOR,
  });
}

describe("SellerSprite adapter registration", () => {
  it("registers itself so new sources only need to add an adapter", () => {
    expect(getSourceAdapter("sellersprite_xlsx")).toBe(sellerSpriteAdapter);
    expect(getSourceAdapter("manual_entry")).toBe(manualEntryAdapter);
    expect(getSourceAdapter("amazon_dom")).not.toBeNull();
    expect(getSourceAdapter("sellersprite_plugin")).not.toBeNull();
    expect(listSourceAdapters().map((adapter) => adapter.sourceType)).toContain("sellersprite_xlsx");
    expect(listSourceAdapters().map((adapter) => adapter.sourceType)).toEqual(
      expect.arrayContaining(["amazon_dom", "sellersprite_plugin"]),
    );
  });

  it("declares the V1.2 adapter interface", () => {
    for (const adapter of [sellerSpriteAdapter, manualEntryAdapter]) {
      expect(typeof adapter.capture).toBe("function");
      expect(typeof adapter.normalize).toBe("function");
      expect(typeof adapter.validate).toBe("function");
      expect(typeof adapter.createEvidence).toBe("function");
    }
  });
});

describe("SellerSprite adapter capture", () => {
  it("turns an official-shape export into one capture draft per product", () => {
    const result = captureXlsx(createSourceLayerTestWorkbook());
    expect(result.drafts).toHaveLength(2);
    expect(result.errorCodes).toEqual([]);
    const [first] = result.drafts;
    expect(first.subjectKey).toBe("amazon:US:B0FH1ZXTN1");
    expect(first.marketplace).toBe("US");
    expect(first.sourceProof.sourceType).toBe("sellersprite_xlsx");
    expect(first.sourceProof.captureMethod).toBe("xlsx_export");
    expect(first.sourceProof.capturedAt).toBe(CAPTURED_AT);
    expect(first.sourceProof.operator).toBe(OPERATOR);
    expect(first.sourceProof.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.fields.asin.value).toBe("B0FH1ZXTN1");
    expect(first.fields.title.value).toContain("Owala");
    expect(first.fields.price.value).toEqual({ amount: 29.99, currency: "USD" });
    expect(first.fields.rating.value).toBe(4.6);
    expect(first.fields.reviewCount.value).toBe(2948);
    expect(first.fields.brand?.value).toBe("Owala");
    expect(first.fields.subCategoryBsr?.value).toBe(15);
    expect(first.fields.estimatedMonthlySales?.value).toBe(3500);
    expect(first.fields.estimatedMonthlyRevenueUsd?.value).toBe(104965);
    expect(first.fields.images.value).toEqual(["https://m.media-amazon.com/images/I/main-1.jpg"]);
    expect(first.extensions?.packageWeight).toEqual({ value: 1.25, unit: "lb" });
    expect(first.extensions?.packageDimensions).toEqual({ length: 10, width: 5, height: 3, unit: "in" });
    expect(first.extensions?.estimatedFbaFee).toEqual({ amount: 4.25, currency: "USD" });
    expect(first.extensions?.estimatedGrossMargin).toBe(35.5);
    expect(first.extensions?.listingQualityScore).toBe(8.7);
    expect(first.extensions?.fieldMetadata?.estimatedFbaFee?.metricNature).toBe("estimate");
    expect(first.extensions?.fieldMetadata?.packageWeight?.metricNature).toBe("snapshot");
    expect(first.extensions?.sellerSpriteRaw?.rows[0]?.columns["未映射原始列"])
      .toBe("preserved-value");
  });

  it("keeps SellerSprite estimates estimated with non-maximal confidence", () => {
    const result = captureXlsx(createSourceLayerTestWorkbook());
    const pkg = sellerSpriteAdapter.normalize({
      draft: result.drafts[0],
      captureId: "cap-estimate-confidence",
      version: 1,
    });
    const outcome = sellerSpriteAdapter.validate({ pkg, context: { now: CAPTURED_AT } });

    expect(pkg.fieldStates.estimatedMonthlySales).toMatchObject({ status: "estimated", metricNature: "estimate" });
    expect(pkg.fieldStates.estimatedMonthlySales.confidence).toBeLessThan(1);
    expect(pkg.fieldStates.estimatedMonthlyRevenueUsd.status).toBe("estimated");
    expect(pkg.fieldStates.estimatedMonthlyRevenueUsd.confidence).toBeLessThan(1);
    expect(outcome.report.issues.some((item) => item.error.code === "LOW_CONFIDENCE")).toBe(false);
  });

  it("does not report an optional embedded-image parser failure as a browser selector failure", () => {
    const parserSpy = vi.spyOn(sellerSpriteXlsx, "parseXlsxEmbeddedImages");
    parserSpy.mockImplementation(() => { throw new Error("synthetic optional image decode failure"); });
    try {
      const result = captureXlsx(createSourceLayerTestWorkbook());
      expect(parserSpy).toHaveBeenCalled();
      expect(result.drafts).toHaveLength(2);
      expect(result.errorCodes).not.toContain("SELECTOR_FAILED");
      expect(result.drafts[0].replay.warnings).toContain("embedded_image_unavailable");
    } finally {
      parserSpy.mockRestore();
    }
  });

  it("supports images, price, rating, review and BSR for every product (V1.2 Phase 6 scope)", () => {
    const result = captureXlsx(createSourceLayerTestWorkbook());
    for (const draft of result.drafts) {
      expect(draft.fields.images.value.length).toBeGreaterThan(0);
      expect(draft.fields.price.value).not.toBeNull();
      expect(draft.fields.rating.value).not.toBeNull();
      expect(draft.fields.reviewCount.value).not.toBeNull();
      expect(draft.fields.bsr.value).not.toBeNull();
    }
  });

  it("keeps quarantined rows visible instead of silently dropping them", () => {
    const rows = [
      ...SOURCE_LAYER_TEST_ROWS,
      {
        ASIN: "B0BROKEN1",
        "商品标题": "Broken row without a product URL",
        "商品详情页链接": "",
        "搜索排名": "5",
        "大类目": "Home & Kitchen",
        "大类BSR": "10",
        "价格($)": "9.99",
        "评分": "4.0",
        "评分数": "20",
      },
    ];
    const result = captureXlsx(createSourceLayerTestWorkbook({ rows }));
    expect(result.quarantinedCount).toBeGreaterThan(0);
    expect(result.drafts.map((draft) => draft.fields.asin.value)).not.toContain("B0BROKEN1");
  });

  it("returns an explicit error code rather than inventing data when the sheet is unusable", () => {
    const result = captureXlsx(createSourceLayerTestWorkbook({
      headers: ["ASIN", "Something Else"],
      rows: [{ ASIN: "B0FH1ZXTN1", "Something Else": "x" }],
    }));
    expect(result.drafts).toEqual([]);
    expect(result.errorCodes).toEqual(["INVALID_FORMAT"]);
  });

  it("rejects non-bytes payloads as an invalid XLSX format rather than a selector failure", () => {
    const result = sellerSpriteAdapter.capture({
      payload: "not-bytes",
      capturedAt: CAPTURED_AT,
      operator: OPERATOR,
    });
    expect(result.drafts).toEqual([]);
    expect(result.errorCodes).toEqual(["INVALID_FORMAT"]);
  });

  it("never derives keywords from anything other than existing deterministic context", () => {
    const result = captureXlsx(createSourceLayerTestWorkbook({
      rows: [{
        ...SOURCE_LAYER_TEST_ROWS[0],
        "商品详情页链接": "https://www.amazon.com/dp/B0FH1ZXTN1?k=insulated+bottle",
      }],
      headers: [...SOURCE_LAYER_TEST_HEADERS],
    }));
    const [draft] = result.drafts;
    expect(draft.fields.keywords.value).toContain("Owala");
    expect(draft.fields.keywords.value).toContain("Sports & Outdoors");
    expect(draft.fields.keywords.value).toContain("insulated bottle");
  });

  it("produces a valid Capture Package through normalize()", () => {
    const captured = captureXlsx(createSourceLayerTestWorkbook());
    const pkg = sellerSpriteAdapter.normalize({
      draft: captured.drafts[0],
      captureId: "cap-xlsx-1",
      version: 1,
    });
    expect(pkg.schemaVersion).toBe("source-capture-package.v1");
    expect(pkg.sourceProof.sourceType).toBe("sellersprite_xlsx");
    expect(pkg.fieldStates.title.status).toBe("confirmed");
    expect(pkg.fieldStates.price.status).toBe("confirmed");
    expect(pkg.extensions?.sellerSpriteRaw?.rows[0]?.columns["包装重量（单位换算）"])
      .toBe("1.25 lb");
  });

  it("accepts the official Preview/Confirm Search Results layout without mapping search rank to BSR", () => {
    const result = captureXlsx(createSellerSpritePreviewWorkbook({
      headers: [
        "ASIN",
        "商品标题",
        "商品详情页链接",
        "商品主图",
        "价格($)",
        "评分",
        "评分数",
        "品牌",
        "类目路径",
        "搜索排名",
        "月销量",
        "月销售额($)",
      ],
      rows: [[
        "B0TEST0001",
        "Preview product",
        "https://www.amazon.com/dp/B0TEST0001",
        "https://images.example.test/product.jpg",
        "$19.99",
        "4.5",
        "123",
        "Example Brand",
        "Home & Kitchen",
        "12",
        "321",
        "$4567.89",
      ]],
    }));
    expect(result.drafts).toHaveLength(1);
    expect(result.errorCodes).toEqual([]);
    expect(result.drafts[0].fields.bsr.value).toBeNull();
    expect(result.drafts[0].fields.estimatedMonthlySales?.value).toBe(321);
    expect(result.drafts[0].fields.estimatedMonthlyRevenueUsd?.value).toBe(4567.89);
  });
});

describe("Amazon DOM adapter provenance", () => {
  it("marks extracted fields as page observations and keeps Amazon extraction refs", () => {
    const captured = amazonDomAdapter.capture({
      payload: {
        asin: "B07G4VTV2F",
        title: "Observed Amazon product title",
        productUrl: "https://www.amazon.com/dp/B07G4VTV2F",
        images: ["https://m.media-amazon.com/images/I/amazon-main.jpg"],
        brand: "Observed Brand",
        price: 24.99,
        currency: "USD",
        rating: 4.6,
        reviewCount: 1046,
        bsrRank: 412,
        bsrCategory: "Home & Kitchen",
        bulletPoints: ["Visible feature from the detail page"],
        packageWeight: { value: 1.2, unit: "lb" },
        packageDimensions: { length: 10, width: 5, height: 3, unit: "in" },
      },
      capturedAt: CAPTURED_AT,
      operator: OPERATOR,
    });
    const draft = captured.drafts[0];
    const pkg = amazonDomAdapter.normalize({ draft, captureId: "cap-amazon-provenance", version: 1 });

    expect(pkg.sourceProof.sourceType).toBe("amazon_dom");
    expect(pkg.sourceProof.captureMethod).toBe("browser_dom");
    for (const field of ["asin", "title", "brand", "images", "price", "rating", "reviewCount", "bsr"] as const) {
      expect(pkg.fieldStates[field].valueOrigin).toBe("page_measured");
      expect(pkg.fieldStates[field].sourceRef).toMatch(/^amazon_dom\./);
      expect(pkg.fieldStates[field].sourceRef).not.toMatch(/^manual_form\./);
    }
    expect(Object.values(pkg.fieldStates).some((state) => state.sourceRef.startsWith("manual_form."))).toBe(false);
    expect(pkg.extensions?.bulletPoints).toEqual(["Visible feature from the detail page"]);
    expect(pkg.extensions?.packageWeight).toEqual({ value: 1.2, unit: "lb" });
    expect(pkg.extensions?.packageDimensions).toEqual({ length: 10, width: 5, height: 3, unit: "in" });
    expect(pkg.fieldStates.estimatedMonthlySales.status).toBe("missing");
    expect(pkg.fieldStates.estimatedMonthlyRevenueUsd.status).toBe("missing");
  });
});

describe("Manual entry adapter", () => {
  it("captures a complete manual record as a trusted source", () => {
    const result = captureManualEntry({
      payload: {
        asin: "b0fh1zxtn1",
        title: "Owala FreeSip Insulated Stainless Steel Water Bottle with Straw, 24 oz",
        productUrl: "https://www.amazon.com/dp/B0FH1ZXTN1",
        images: ["https://m.media-amazon.com/images/I/main.jpg"],
        brand: "Owala",
        price: 29.99,
        currency: "usd",
        rating: 4.6,
        reviewCount: 2948,
        bsrRank: 120,
        bsrCategory: "Sports & Outdoors",
        subCategoryBsr: 15,
        estimatedMonthlySales: 3500,
        estimatedMonthlyRevenueUsd: 104965,
        keywords: ["water bottle"],
      },
      capturedAt: CAPTURED_AT,
      operator: OPERATOR,
    });
    expect(result.drafts).toHaveLength(1);
    const [draft] = result.drafts;
    expect(draft.sourceProof.sourceType).toBe("manual_entry");
    expect(draft.sourceProof.captureMethod).toBe("manual_form");
    expect(draft.sourceProof.sourceFingerprint).toBeNull();
    expect(draft.fields.asin.value).toBe("B0FH1ZXTN1");
    expect(draft.fields.brand?.value).toBe("Owala");
    expect(draft.fields.price.value).toEqual({ amount: 29.99, currency: "USD" });
    expect(draft.fields.subCategoryBsr?.value).toBe(15);
    expect(draft.fields.estimatedMonthlySales?.value).toBe(3500);
    expect(draft.fields.estimatedMonthlyRevenueUsd?.value).toBe(104965);

    const pkg = manualEntryAdapter.normalize({ draft, captureId: "cap-m-1", version: 1 });
    expect(pkg.fields.brand).toBe("Owala");
    expect(pkg.fields.rating).toBe(4.6);
    expect(pkg.fields.subCategoryBsr).toBe(15);
    expect(pkg.fields.estimatedMonthlySales).toBe(3500);
    expect(pkg.fields.estimatedMonthlyRevenueUsd).toBe(104965);
    expect(pkg.fieldStates.rating.status).toBe("confirmed");
    expect(pkg.fieldStates.brand.status).toBe("confirmed");
  });

  it("fails closed when no identity at all is provided", () => {
    const result = captureManualEntry({
      payload: { price: 12 },
      capturedAt: CAPTURED_AT,
      operator: OPERATOR,
    });
    expect(result.drafts).toEqual([]);
    expect(result.errorCodes).toEqual(["FIELD_MISSING"]);
  });

  it("fails closed on an invalid ASIN with no usable title instead of creating an anonymous subject", () => {
    const result = captureManualEntry({
      payload: { asin: "BAD-ASIN", title: "", rating: 9.9 },
      capturedAt: CAPTURED_AT,
      operator: OPERATOR,
    });
    expect(result.drafts).toEqual([]);
    expect(result.errorCodes).toEqual(["FIELD_MISSING"]);
    expect(result.quarantinedCount).toBe(1);
  });

  it("uses a deterministic, path-safe subject key when only the title is usable", () => {
    const payload = { asin: "BAD-ASIN", title: "Manual entry without a usable ASIN value" };
    const first = captureManualEntry({ payload, capturedAt: CAPTURED_AT, operator: OPERATOR });
    const second = captureManualEntry({ payload, capturedAt: CAPTURED_AT, operator: OPERATOR });
    const key = first.drafts[0].subjectKey;
    expect(key).toMatch(/^manual:[a-f0-9]{24}$/);
    expect(key).toBe(second.drafts[0].subjectKey);
    expect(first.drafts[0].fields.asin.value).toBeNull();
  });

  it("does not accept a non-object payload", () => {
    const result = captureManualEntry({
      payload: "hello",
      capturedAt: CAPTURED_AT,
      operator: OPERATOR,
    });
    expect(result.drafts).toEqual([]);
    expect(result.errorCodes).toEqual(["SELECTOR_FAILED"]);
  });
});
