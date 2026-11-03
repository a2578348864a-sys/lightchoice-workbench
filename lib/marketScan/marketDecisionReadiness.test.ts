import { describe, expect, it } from "vitest";
import {
  evaluateMarketDecisionReadiness,
  marketProceedBlockReason,
  MIN_VALID_SAMPLE_COUNT,
} from "@/lib/marketScan/marketDecisionReadiness";

function completeMetrics(validSampleCount: number) {
  const missingCount = 0;
  const metric = { status: "PRESENT", value: { median: 20, ratio: 0.5 }, sampleSize: validSampleCount, missingCount };
  return {
    sampleCount: validSampleCount,
    validSampleCount,
    price: metric,
    sales: metric,
    brandConcentration: { brandCr5: metric },
    evidenceWindow: {
      earliestCapturedAt: "2026-09-20T00:00:00.000Z",
      latestCapturedAt: "2026-09-29T00:00:00.000Z",
      observedAtSource: "evidence_captured_at",
    },
  };
}

describe("Market Decision Readiness", () => {
  it("keeps raw count, valid count, and the approved 30-item threshold separate", () => {
    expect(MIN_VALID_SAMPLE_COUNT).toBe(30);
    const readiness = evaluateMarketDecisionReadiness({ ...completeMetrics(34), sampleCount: 50 });
    expect(readiness.rawSampleCount).toBe(50);
    expect(readiness.validSampleCount).toBe(34);
    expect(readiness.sampleSufficiency).toBe("SAMPLE_SUFFICIENT");
  });

  it.each([1, 29])("blocks Proceed with %i valid samples", (count) => {
    const readiness = evaluateMarketDecisionReadiness(completeMetrics(count));
    expect(readiness.sampleSufficiency).toBe("INSUFFICIENT_SAMPLE");
    expect(marketProceedBlockReason(readiness)).toBe("INSUFFICIENT_SAMPLE");
  });

  it("allows sample sufficiency at 30 to continue through readiness, without deciding the human Gate", () => {
    const readiness = evaluateMarketDecisionReadiness(completeMetrics(30));
    expect(readiness.sampleSufficiency).toBe("SAMPLE_SUFFICIENT");
    expect(readiness.status).toBe("READY");
    expect(marketProceedBlockReason(readiness)).toBeNull();
  });

  it("treats 60 samples with missing demand and CR5 as READY_WITH_MISSING_DATA_CONFIRMATION", () => {
    const metrics = completeMetrics(60);
    const readiness = evaluateMarketDecisionReadiness({
      ...metrics,
      sales: { status: "NOT_AVAILABLE", value: null, sampleSize: 0, missingCount: 60 },
      brandConcentration: {
        brandCr5: { status: "NOT_AVAILABLE", value: null, sampleSize: 0, missingCount: 60 },
      },
    });
    expect(readiness.status).toBe("READY_WITH_MISSING_DATA_CONFIRMATION");
    expect(readiness.blockers).toHaveLength(0);
    expect(readiness.acknowledgeableMissing.map((b) => b.code)).toEqual([
      "DEMAND_NOT_COMPLETE",
      "BRAND_CR5_NOT_COMPUTABLE",
    ]);
    expect(readiness.acknowledgeableMissing[0]?.detail).toContain("当前数据来源暂时无法提供该指标");
    expect(readiness.acknowledgeableMissing.some((b) => /NOT_AVAILABLE|INSUFFICIENT_DATA/.test(b.detail))).toBe(false);

    // Without options -> blocks with MISSING_ACK_REQUIRED
    expect(marketProceedBlockReason(readiness)).toBe("MISSING_ACK_REQUIRED");
    expect(marketProceedBlockReason(readiness, { missingDataAcknowledged: false })).toBe("MISSING_ACK_REQUIRED");

    // With explicit acknowledgment -> proceed allowed (null)
    expect(marketProceedBlockReason(readiness, { missingDataAcknowledged: true })).toBeNull();
  });

  it("hard blocks Proceed when price is missing even with sufficient sample", () => {
    const metrics = completeMetrics(60);
    const readiness = evaluateMarketDecisionReadiness({
      ...metrics,
      price: { status: "NOT_AVAILABLE", value: null, sampleSize: 0, missingCount: 60 },
    });
    expect(readiness.status).toBe("NOT_READY");
    expect(readiness.blockers.map((b) => b.code)).toContain("PRICE_NOT_COMPLETE");
    expect(marketProceedBlockReason(readiness)).toBe("NOT_READY");
    expect(marketProceedBlockReason(readiness, { missingDataAcknowledged: true })).toBe("NOT_READY");
  });

  it("hard blocks Proceed when evidence window is unknown", () => {
    const metrics = completeMetrics(60);
    const readiness = evaluateMarketDecisionReadiness({
      ...metrics,
      evidenceWindow: { earliestCapturedAt: null, latestCapturedAt: null, observedAtSource: "unknown" },
    });
    expect(readiness.status).toBe("NOT_READY");
    expect(readiness.blockers.map((b) => b.code)).toContain("EVIDENCE_WINDOW_NOT_COMPUTABLE");
    expect(marketProceedBlockReason(readiness)).toBe("NOT_READY");
    expect(marketProceedBlockReason(readiness, { missingDataAcknowledged: true })).toBe("NOT_READY");
  });
});
