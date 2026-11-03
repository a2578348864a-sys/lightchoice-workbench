import { describe, expect, it } from "vitest";
import { manualEntryAdapter } from "@/lib/sourceLayer/adapters/manualEntryAdapter";
import { sellerSpriteAdapter } from "@/lib/sourceLayer/adapters/sellerSpriteAdapter";
import { keepaAdapter } from "@/lib/sourceLayer/adapters/keepaAdapter";
import { createSourceLayerTestWorkbook } from "@/lib/sourceLayer/adapters/__fixtures__/sellerSpriteWorkbook";
import {
  adaptEvidenceToProductFact,
  withTimeSeries,
  withMarketConcentration,
  withVariationAnalysis,
  timeSeriesFromKeepaAttachment,
  concentrationFromMarketShareAttachment,
} from "@/lib/sourceLayer/fact/productFactAdapter";

const NOW = "2026-09-19T08:00:00.000Z";

function evidence() {
  const captured = manualEntryAdapter.capture({
    payload: {
      asin: "B0FACT0001",
      title: "A structurally mapped product fact fixture",
      productUrl: "https://www.amazon.com/dp/B0FACT0001",
      brand: "Fixture Brand",
      price: 19.99,
      rating: 4.5,
      reviewCount: 120,
      bsrRank: 88,
      bsrCategory: "Home & Kitchen",
      estimatedMonthlySales: 400,
      estimatedMonthlyRevenueUsd: 7996,
    },
    capturedAt: NOW,
    operator: "owner:v1",
  });
  const draft = captured.drafts[0];
  if (!draft) throw new Error("fixture draft missing");
  const pkg = manualEntryAdapter.normalize({
    draft,
    captureId: "cap-fact-fixture",
    version: 1,
  });
  const outcome = manualEntryAdapter.validate({ pkg, context: { now: NOW } });
  return manualEntryAdapter.createEvidence({ pkg: outcome.pkg, report: outcome.report });
}

describe("adaptEvidenceToProductFact", () => {
  it("preserves captured values and provenance without filling unsupported fields", () => {
    const record = evidence();
    const fact = adaptEvidenceToProductFact({
      evidence: record,
      source: "manual",
      extensions: { launchedDate: "2025-01-02" },
    });

    expect(fact.schema).toBe("product-fact.v3");
    expect(fact.subjectKey).toBe("amazon:US:B0FACT0001");
    expect(fact.sourceProof.contentHash).toBe(record.contentHash);
    expect(fact.basic.asin).toMatchObject({ value: "B0FACT0001", status: "present", source: "manual" });
    expect(fact.basic.image.value).toBeNull();
    expect(fact.basic.price.value).toEqual({ amount: 19.99, currency: "USD" });
    expect(fact.market.bsr.value).toBe(88);
    expect(fact.market.monthlySalesEstimate.value).toBe(400);
    expect(fact.market.monthlySalesEstimate.metricNature).toBe("estimate");
    expect(fact.market.monthlyRevenueEstimate.metricNature).toBe("estimate");
    expect(fact.basic.price.metricNature).toBe("snapshot");
    expect(fact.market.monthlyRevenueEstimate.value).toEqual({ amount: 7996, currency: "USD" });
    expect(fact.market.launchedDate.value).toBe("2025-01-02");
    expect(fact.basic.bulletPoints).toMatchObject({ value: null, status: "missing" });
    expect(fact.profit.packageWeight).toMatchObject({ value: null, status: "missing" });
    expect(fact.profit.packageDimensions).toMatchObject({ value: null, status: "missing" });
    expect(fact.profit.fbaFee).toMatchObject({ value: null, status: "missing" });
  });

  it("keeps SellerSprite raw columns and preserves provider snapshot/estimate semantics", () => {
    const captured = sellerSpriteAdapter.capture({
      payload: createSourceLayerTestWorkbook(),
      capturedAt: NOW,
      operator: "owner:v1",
    });
    const draft = captured.drafts[0];
    if (!draft) throw new Error("SellerSprite fixture draft missing");
    const pkg = sellerSpriteAdapter.normalize({
      draft,
      captureId: "cap-sellersprite-fact",
      version: 1,
    });
    const outcome = sellerSpriteAdapter.validate({ pkg, context: { now: NOW } });
    const record = sellerSpriteAdapter.createEvidence({ pkg: outcome.pkg, report: outcome.report });
    const fact = adaptEvidenceToProductFact({ evidence: record });

    expect(fact.sourceProof.source).toBe("sellersprite_xlsx");
    expect(fact.profit.packageWeight).toMatchObject({
      value: { value: 1.25, unit: "lb" },
      status: "present",
      metricNature: "snapshot",
      source: "sellersprite_xlsx",
    });
    expect(fact.profit.fbaFee).toMatchObject({
      value: { amount: 4.25, currency: "USD" },
      status: "present",
      metricNature: "estimate",
      source: "sellersprite_xlsx",
    });
    expect(fact.market.estimatedGrossMargin).toMatchObject({
      value: 35.5,
      metricNature: "estimate",
      source: "sellersprite_xlsx",
    });
    expect(fact.providerRawData?.rows[0]?.columns["未映射原始列"]).toBe("preserved-value");
    expect(fact.providerRawData?.rows[0]?.columns["包装重量（单位换算）"]).toBe("1.25 lb");
  });

  it("adapts keepa_export evidence and projects timeSeries with graceful degradation for missing fields", () => {
    const keepaCsv = [
      "ASIN,Title,Image,Current: New,Current: Sales Rank,90 days avg.: Sales Rank,90 days drops: Sales Rank,Buy Box: % Amazon,90 days avg.: New,90 days: Deals",
      "B0KEEPA001,Keepa Product Title,https://m.media-amazon.com/images/I/keepa.jpg,$24.99,150,180,45,15%,$26.50,3",
    ].join("\n");

    const captured = keepaAdapter.capture({
      payload: Buffer.from(keepaCsv, "utf8"),
      capturedAt: NOW,
      operator: "owner:v5",
    });

    expect(captured.drafts).toHaveLength(1);
    const draft = captured.drafts[0];
    const pkg = keepaAdapter.normalize({ draft, captureId: "cap-keepa-fact", version: 1 });
    const outcome = keepaAdapter.validate({ pkg, context: { now: NOW } });
    const evidence = keepaAdapter.createEvidence({ pkg: outcome.pkg, report: outcome.report });

    const fact = adaptEvidenceToProductFact({ evidence });

    expect(fact.sourceProof.source).toBe("keepa_export");
    expect(fact.basic.asin.value).toBe("B0KEEPA001");
    expect(fact.basic.title.value).toBe("Keepa Product Title");
    expect(fact.basic.price.value).toEqual({ amount: 24.99, currency: "USD" });

    // Time series projection
    expect(fact.timeSeries).toBeDefined();
    expect(fact.timeSeries?.bsr90dAvg).toMatchObject({
      value: 180,
      status: "present",
      source: "keepa_export",
    });
    expect(fact.timeSeries?.bsrDrops90d).toMatchObject({
      value: 45,
      status: "present",
      source: "keepa_export",
    });
    expect(fact.timeSeries?.price90dAvg).toMatchObject({
      value: 26.5,
      status: "present",
      source: "keepa_export",
    });
    expect(fact.timeSeries?.buyBoxAmazonSharePercent).toMatchObject({
      value: 15,
      status: "present",
      source: "keepa_export",
    });
    expect(fact.timeSeries?.dealCount90d).toMatchObject({
      value: 3,
      status: "present",
      source: "keepa_export",
    });

    // Unprovided fields degrade cleanly to missing
    expect(fact.timeSeries?.price90dMin).toMatchObject({
      value: null,
      status: "missing",
      metricNature: "unknown",
    });
    expect(fact.timeSeries?.price360dMin).toMatchObject({
      value: null,
      status: "missing",
      metricNature: "unknown",
    });
  });

  it("projects timeSeries, marketConcentration, and variationAnalysis via immutable helpers", () => {
    const record = evidence();
    const baseFact = adaptEvidenceToProductFact({ evidence: record, source: "manual" });

    // Test withTimeSeries
    const factWithTs = withTimeSeries(baseFact, {
      price90dMin: 19.99,
      price90dAvg: 22.50,
      price360dMin: 18.00,
      bsr90dAvg: 120,
      bsrDrops90d: 30,
      buyBoxAmazonSharePercent: 5,
      dealCount90d: 2,
    });
    expect(factWithTs.timeSeries?.price90dMin.value).toBe(19.99);
    expect(factWithTs.timeSeries?.dealCount90d.value).toBe(2);
    // Immutability check
    expect(baseFact.timeSeries).toBeUndefined();

    // Test withMarketConcentration
    const factWithConc = withMarketConcentration(baseFact, {
      brandCr5Share: 0.65,
      amazon1pShare: 0.10,
      sellerMarketShare: 0.25,
      sellerOriginDomesticRatio: 0.70,
    });
    expect(factWithConc.concentration?.brandCr5Share.value).toBe(0.65);
    expect(factWithConc.concentration?.brandCr5Share.metricNature).toBe("derived");
    expect(baseFact.concentration).toBeUndefined();

    // Test withVariationAnalysis
    const factWithVar = withVariationAnalysis(baseFact, {
      childSales: 400,
      parentTotalSales: 1000,
      currentAsinSalesShare: 0.40,
      isDominantVariation: false,
      isMinorVariation: false,
    });
    expect(factWithVar.variationAnalysis?.childSales.value).toBe(400);
    expect(factWithVar.variationAnalysis?.parentTotalSales.value).toBe(1000);
    expect(factWithVar.variationAnalysis?.currentAsinSalesShare.value).toBe(0.40);
    expect(baseFact.variationAnalysis).toBeUndefined();

    // Test attachment extraction helpers
    const tsPayload = {
      schema: "keepa-timeseries-attachment.v1",
      asin: "B0FACT0001",
      metrics: {
        price90dMin: 19.99,
        price90dAvg: 22.50,
        price360dMin: null,
        bsr90dAvg: 120,
        bsrDrops90d: 30,
        buyBoxAmazonSharePercent: 5,
        dealCount90d: 2,
      },
    };
    expect(timeSeriesFromKeepaAttachment(tsPayload)).toEqual({
      price90dMin: 19.99,
      price90dAvg: 22.50,
      price360dMin: null,
      bsr90dAvg: 120,
      bsrDrops90d: 30,
      buyBoxAmazonSharePercent: 5,
      dealCount90d: 2,
    });
    expect(timeSeriesFromKeepaAttachment({ schema: "invalid" })).toBeNull();

    const mktPayload = {
      schema: "sellersprite-market-share-attachment.v1",
      brandCr5Share: 0.75,
      amazon1pShare: 0.15,
      sellerMarketShare: 0.20,
      sellerOriginDomesticRatio: 0.60,
    };
    expect(concentrationFromMarketShareAttachment(mktPayload)).toEqual({
      brandCr5Share: 0.75,
      amazon1pShare: 0.15,
      sellerMarketShare: 0.20,
      sellerOriginDomesticRatio: 0.60,
    });
    expect(concentrationFromMarketShareAttachment({ schema: "invalid" })).toBeNull();
  });
});


it("does not turn margin estimates or provider quality scores into observed snapshots", () => {
  const record = evidence();
  const original = JSON.stringify(record);
  const fact = adaptEvidenceToProductFact({ evidence: record, extensions: { estimatedGrossMargin: 0.35, listingQualityScore: 8.4 } });
  expect(fact.market.estimatedGrossMargin).toMatchObject({ value: 0.35, status: "present", metricNature: "estimate" });
  expect(fact.market.listingQualityScore).toMatchObject({ value: 8.4, status: "present", metricNature: "derived" });
  expect(fact.basic.price.metricNature).toBe("snapshot");
  expect(fact.sourceProof.contentHash).toBe(record.contentHash);
  expect(JSON.stringify(record)).toBe(original);
});
