import { describe, expect, it } from "vitest";

import {
  assertAiInterpretationBound,
  interpretMarketOpportunityDeterministically,
  resolveMarketOpportunityAiMode,
} from "@/lib/marketOpportunity/ai";
import { buildMarketOpportunityAnalysisSnapshot } from "@/lib/server/marketOpportunityRepository";
import { computeMarketMetricsV1 } from "@/lib/marketScan/metrics";
import { FIXTURE_NICHE_DEFINITION, FIXTURE_SAMPLE_DEFINITION, makeProductFact } from "@/lib/marketScan/__fixtures__/productFactFixture";
import type { MarketScanRecordView } from "@/lib/server/marketScanRepository";

function fixtureScan(): MarketScanRecordView {
  const fact = makeProductFact({ asin: "B0FIXTURE1" });
  const sampleHash = "a".repeat(64);
  const createdAt = "2026-09-20T00:00:00.000Z";
  const metrics = computeMarketMetricsV1({
    sample: [{ subjectKey: fact.subjectKey, productFact: fact, evidenceId: "evidence-1", evidenceVersion: 1, capturedAt: createdAt }],
    referenceDate: createdAt,
    sampleHash,
    marketplace: "US",
  });
  return {
    id: "scan-ai",
    scanName: "AI fixture",
    marketplace: "US",
    nicheDefinition: FIXTURE_NICHE_DEFINITION,
    sampleDefinition: FIXTURE_SAMPLE_DEFINITION,
    sampleSnapshot: { schemaVersion: "market-scan-sample.v1", metricsVersion: metrics.metricsVersion, itemCount: 1, sampleHash, items: [] },
    metrics,
    sampleCount: 1,
    metricsVersion: metrics.metricsVersion,
    sampleHash,
    createdAt,
    updatedAt: createdAt,
  } as unknown as MarketScanRecordView;
}

describe("market opportunity AI boundary", () => {
  it("marks the local test substitute and binds every reference to the scan", () => {
    const scan = fixtureScan();
    const snapshot = buildMarketOpportunityAnalysisSnapshot({ latest: scan, history: [], generatedAt: new Date("2026-09-20T00:00:00.000Z") });
    const result = interpretMarketOpportunityDeterministically(snapshot);
    expect(result.status).toBe("READY");
    expect(result.model).toBe("local-deterministic-v1");
    expect(assertAiInterpretationBound(result, new Set([scan.id])).factRefs.every((ref) => ref.scanId === scan.id)).toBe(true);
  });

  it("keeps real mode disabled unless the explicit gate is set", () => {
    expect(resolveMarketOpportunityAiMode({ MARKET_OPPORTUNITY_AI_MODE: "real" })).toBe("disabled");
    expect(resolveMarketOpportunityAiMode({ MARKET_OPPORTUNITY_AI_MODE: "real", MARKET_OPPORTUNITY_REAL_AI_ENABLED: "true" })).toBe("real");
  });
});
