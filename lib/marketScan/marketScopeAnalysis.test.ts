import { describe, expect, it } from "vitest";

import type { MarketScanSampleItemV1 } from "@/lib/marketScan/types";
import { analyzeMarketScopeForConfirmedTopic, analyzeMarketSampleScope, summarizeSourceCandidatesOutsideMarketScan } from "@/lib/marketScan/marketScopeAnalysis";

function sample(asin: string, title: string | null, price: number | null, currency = "USD"): MarketScanSampleItemV1 {
  const missing = { presence: "missing" } as const;
  return {
    asin,
    subjectKey: `amazon:US:${asin}`,
    candidateId: null,
    productFactFingerprint: "a".repeat(64),
    factValuesFingerprint: "b".repeat(64),
    sourceProofHash: `${asin.slice(-1).padEnd(64, "c")}`,
    evidenceId: `evidence-${asin}`,
    evidenceVersion: 2,
    capturedAt: "2026-10-13T22:05:26.673Z",
    sourceType: "amazon_dom",
    dedupeOf: null,
    evidenceStatus: "ready",
    parentAsin: null,
    factValues: {
      asin,
      title: title ? { presence: "present", value: title } : missing,
      brand: missing,
      category: missing,
      price: price === null ? { ...missing, valueSource: "FACT" } : { presence: "present", value: { amount: price, currency }, valueSource: "FACT" },
      rating: missing,
      reviewCount: missing,
      bsr: missing,
      monthlySalesEstimate: { ...missing, valueSource: "PROVIDER_ESTIMATE" },
      monthlyRevenueEstimate: { ...missing, valueSource: "PROVIDER_ESTIMATE" },
      launchedDate: missing,
    },
  };
}

describe("analyzeMarketSampleScope", () => {
  it("classifies from frozen titles, keeps ambiguous items uncertain, and binds evidence", () => {
    const input = [
      sample("B0CWPNBC4Z", "Silicone Baking Mat 2-Pack", 5.99),
      sample("B0D5RF6GH8", "Silicone Heat-Resistant Countertop Mat for Craft Table", 24.99),
      sample("B000000003", "Silicone Kitchen Mat", 12.5),
    ];
    const original = JSON.stringify(input);
    const result = analyzeMarketSampleScope(input, "f".repeat(64));

    expect(result.counts).toEqual({ IN_SCOPE: 1, OUT_OF_SCOPE: 1, UNCERTAIN: 1 });
    expect(result.items[0]).toMatchObject({ status: "IN_SCOPE", titleOnly: true, evidence: { evidenceId: "evidence-B0CWPNBC4Z", evidenceVersion: 2 } });
    expect(result.items[1]).toMatchObject({ status: "OUT_OF_SCOPE", asin: "B0D5RF6GH8" });
    expect(result.items[2].status).toBe("UNCERTAIN");
    expect(result.items[0].comparabilityFlags).toContain("组合数量可能不同");
    expect(JSON.stringify(input)).toBe(original);
  });

  it("computes only listing-price statistics for title-in-scope items and reports coverage limits", () => {
    const result = analyzeMarketSampleScope([
      sample("B000000001", "Pastry Baking Mat", 10),
      sample("B000000002", "Baking Mat 3-Pack", 20),
      sample("B000000003", "Countertop Craft Mat", 99),
    ], "e".repeat(64));

    expect(result.listingPrice).toEqual({
      status: "AVAILABLE",
      currency: "USD",
      sampleCount: 2,
      missingCount: 0,
      min: 10,
      median: 15,
      max: 20,
      basis: "OBSERVED_LISTING_PRICE_NOT_UNIT_PRICE",
    });
    expect(result.fieldCoverage.brand).toEqual({ presentCount: 0, missingCount: 3, totalCount: 3 });
    expect(result.limits).toContain("样本没有品牌字段，不能计算品牌集中度。");
    expect(result.sampleHash).toBe("e".repeat(64));
  });

  it("does not combine mixed currencies", () => {
    const result = analyzeMarketSampleScope([
      sample("B000000001", "Baking Mat", 10, "USD"),
      sample("B000000002", "Pastry Mat", 12, "CAD"),
    ], "d".repeat(64));
    expect(result.listingPrice).toMatchObject({ status: "MIXED_CURRENCY", currency: null, min: null, median: null, max: null, sampleCount: 2 });
  });

  it("keeps source-batch candidates outside the locked sample visible without changing the sample", () => {
    const result = summarizeSourceCandidatesOutsideMarketScan({
      sourceBatchId: "batch-1",
      sampleHash: "c".repeat(64),
      lockedSampleAsins: ["B000000001"],
      candidates: [
        { asin: "B000000001", title: "Baking Mat", promotionEligible: true, evidenceStatus: "ready", ratingStatus: "confirmed", reviewCountStatus: "confirmed", launchedDateStatus: "missing", evidenceId: "in", evidenceVersion: 1, capturedAt: "time", contentHash: "hash" },
        { asin: "B0HLRWFBHF", title: "Leakproof Silicone Baking Mat", promotionEligible: false, evidenceStatus: "limited_evidence", ratingStatus: "missing", reviewCountStatus: "missing", launchedDateStatus: "missing", evidenceId: "ev-out", evidenceVersion: 4, capturedAt: "time", contentHash: "hash-out" },
      ],
    });
    expect(result).toMatchObject({ sourceBatchCandidateCount: 2, lockedSampleCount: 1, outsideCount: 1, sampleHash: "c".repeat(64) });
    expect(result.outsideCandidates[0]).toMatchObject({ asin: "B0HLRWFBHF", missingSignals: ["评分", "评论数", "上架日期"], promotionEligible: false, evidence: { evidenceId: "ev-out", evidenceVersion: 4 } });
  });
});

describe("analyzeMarketScopeForConfirmedTopic", () => {
  const items = [sample("B000000001", "Baking Mat", 10)];

  it("runs the baking-mat scope analysis only for the exact confirmed silicone baking mat topic", () => {
    expect(analyzeMarketScopeForConfirmedTopic({ label: " Silicone Baking Mat " }, items, "a".repeat(64))).toMatchObject({
      totalCount: 1,
      items: [{ asin: "B000000001", status: "IN_SCOPE" }],
    });
    expect(analyzeMarketScopeForConfirmedTopic({ label: "硅胶烘焙垫" }, items, "a".repeat(64))).toMatchObject({ totalCount: 1 });
  });

  it("does not infer the topic from other category labels, notes, or partial matches", () => {
    expect(analyzeMarketScopeForConfirmedTopic({ label: "Pet Feeding Mat", notes: "silicone baking mat", scanName: "silicone baking mat" }, items, "a".repeat(64))).toBeUndefined();
    expect(analyzeMarketScopeForConfirmedTopic({ label: "baking mat" }, items, "a".repeat(64))).toBeUndefined();
    expect(analyzeMarketScopeForConfirmedTopic({ label: "silicone baking mat for dogs" }, items, "a".repeat(64))).toBeUndefined();
    expect(analyzeMarketScopeForConfirmedTopic({ label: "硅胶餐垫" }, items, "a".repeat(64))).toBeUndefined();
    expect(analyzeMarketScopeForConfirmedTopic(null, items, "a".repeat(64))).toBeUndefined();
  });
});
