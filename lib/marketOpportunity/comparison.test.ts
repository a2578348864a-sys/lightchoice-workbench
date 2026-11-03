import { describe, expect, it } from "vitest";

import { compareMarketScans } from "@/lib/marketOpportunity/comparison";
import { computeMarketMetricsV1 } from "@/lib/marketScan/metrics";
import { FIXTURE_NICHE_DEFINITION, FIXTURE_SAMPLE_DEFINITION, makeProductFact } from "@/lib/marketScan/__fixtures__/productFactFixture";
import type { MarketScanRecordView } from "@/lib/server/marketScanRepository";

function scan(id: string, createdAt: string, price: number, requestedLimit = 100): MarketScanRecordView {
  const fact = makeProductFact({ asin: "B0FIXTURE1", price, monthlySalesEstimate: 300 });
  const sampleHash = "a".repeat(64);
  const metrics = computeMarketMetricsV1({
    sample: [{ subjectKey: fact.subjectKey, productFact: fact, evidenceId: fact.sourceProof.evidenceId, evidenceVersion: 1, capturedAt: createdAt }],
    referenceDate: createdAt,
    sampleHash,
    marketplace: "US",
  });
  return {
    id,
    scanName: id,
    marketplace: "US",
    nicheDefinition: FIXTURE_NICHE_DEFINITION,
    sampleDefinition: { ...FIXTURE_SAMPLE_DEFINITION, requestedLimit },
    sampleSnapshot: { schemaVersion: "market-scan-sample.v1", metricsVersion: metrics.metricsVersion, itemCount: 1, sampleHash, items: [] },
    metrics,
    sampleCount: 1,
    metricsVersion: metrics.metricsVersion,
    sampleHash,
    createdAt,
    updatedAt: createdAt,
  } as unknown as MarketScanRecordView;
}

describe("compareMarketScans", () => {
  it("computes absolute deltas only for equivalent definitions", () => {
    const from = scan("scan-a", "2026-09-19T00:00:00.000Z", 10);
    const to = scan("scan-b", "2026-09-20T00:00:00.000Z", 20);
    const result = compareMarketScans(from, to);
    expect(result.status).toBe("COMPARABLE");
    expect(result.priceMedianDelta).toBe(10);
    expect(result.knownSalesDelta).toBe(0);
    expect(result.reasons).not.toContain("sample_definition_mismatch");
  });

  it("fails closed when sample definitions differ", () => {
    const from = scan("scan-a", "2026-09-19T00:00:00.000Z", 10, 50);
    const to = scan("scan-b", "2026-09-20T00:00:00.000Z", 20, 100);
    const result = compareMarketScans(from, to);
    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.reasons).toContain("sample_definition_mismatch");
    expect(result.priceMedianDelta).toBeNull();
  });
});
