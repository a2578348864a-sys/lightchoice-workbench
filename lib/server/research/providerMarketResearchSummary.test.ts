import { describe, expect, it } from "vitest";
import { buildProviderMarketResearchSummary } from "@/lib/server/research/providerMarketResearchSummary";

const subjectKey = "amazon:US:B000000001";
const contentHash = "a".repeat(64);
const capturedAt = "2026-09-26T08:50:36.000Z";

function sourceEvidenceRef(attachmentId: string, hash = contentHash, subject = subjectKey) {
  return {
    refId: `attachment:${attachmentId}`,
    kind: "attachment" as const,
    subjectKey: subject,
    evidenceId: "ev-current",
    captureId: "cap-current",
    version: 1,
    contentHash: hash,
    capturedAt,
    attachmentId,
  };
}

describe("provider market Research summary", () => {
  it("preserves source, time, metric nature, currency, product identity and citations for both modules", () => {
    const summary = buildProviderMarketResearchSummary({
      subjectKey,
      allowedEvidenceRefs: ["attachment:market-1", "attachment:keyword-1"],
      sourceEvidenceRefs: [sourceEvidenceRef("market-1"), sourceEvidenceRef("keyword-1")],
      providerProductMarketEvidence: [{
        schemaVersion: "provider-product-market-evidence.v1",
        provider: "SellerSprite",
        module: "sellersprite_product_market",
        subjectKey,
        marketplace: "US",
        asin: "B000000001",
        parentAsin: "B0B75Y63J4",
        sourceType: "sellersprite_plugin",
        sourceSurface: "visible product summary",
        sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
        evidenceRefId: "attachment:market-1",
        attachmentId: "market-1",
        contentHash,
        capturedAt,
        observedAt: null,
        metricPeriod: null,
        metricNature: "provider_estimate",
        limitations: ["visible result only"],
        metrics: [
          { metric: "monthlySalesEstimate", value: 80, unit: "count", currency: null, metricNature: "provider_estimate", status: "parsed", raw: "80", scope: null },
          { metric: "price", value: 37.01, unit: "currency", currency: "USD", metricNature: "provider_estimate", status: "parsed", raw: "37.01 USD", scope: null },
        ],
      }],
      providerMetricEvidence: [{
        schemaVersion: "provider-metric-evidence.v1",
        provider: "SellerSprite",
        module: "reverse_asin",
        subjectKey,
        queryIdentity: { subjectKey, marketplace: "US", asin: "B000000001" },
        sourceType: "sellersprite_plugin",
        sourceSurface: "reverse ASIN visible table",
        sourceUrl: null,
        evidenceRefId: "attachment:keyword-1",
        attachmentId: "keyword-1",
        contentHash,
        capturedAt,
        observedAt: null,
        metricPeriod: null,
        metricNature: "provider_estimate",
        limitations: [],
        rows: [{
          rowKey: "kw-1",
          keyword: "baking mat",
          status: "valid",
          metrics: [{ metric: "estimatedTraffic", value: 1200, unit: "count", metricNature: "provider_estimate", status: "parsed", raw: "1,200" }],
        }],
      }],
    });

    expect(summary).toMatchObject({
      sources: [
        {
          module: "reverse_asin",
          subjectKey,
          asin: "B000000001",
          capturedAt,
          metricNature: "provider_estimate",
          evidenceRefId: "attachment:keyword-1",
          metrics: [{ dimension: "baking mat", metric: "estimatedTraffic", value: 1200, metricNature: "provider_estimate" }],
        },
        {
          module: "sellersprite_product_market",
          subjectKey,
          asin: "B000000001",
          parentAsin: "B0B75Y63J4",
          capturedAt,
          metricNature: "provider_estimate",
          evidenceRefId: "attachment:market-1",
          metrics: [
            { metric: "monthlySalesEstimate", value: 80, metricNature: "provider_estimate" },
            { metric: "price", value: 37.01, currency: "USD", metricNature: "provider_estimate" },
          ],
        },
      ],
    });
  });

  it("omits evidence whose citation is not allowlisted or whose attachment identity does not match", () => {
    const summary = buildProviderMarketResearchSummary({
      subjectKey,
      allowedEvidenceRefs: ["attachment:allowed"],
      sourceEvidenceRefs: [sourceEvidenceRef("allowed")],
      providerProductMarketEvidence: [{
        schemaVersion: "provider-product-market-evidence.v1",
        provider: "SellerSprite",
        module: "sellersprite_product_market",
        subjectKey,
        marketplace: "US",
        asin: "B000000001",
        parentAsin: null,
        sourceType: "sellersprite_plugin",
        sourceSurface: "visible card",
        sourceUrl: null,
        evidenceRefId: "attachment:not-allowed",
        attachmentId: "not-allowed",
        contentHash,
        capturedAt,
        observedAt: null,
        metricPeriod: null,
        metricNature: "provider_observed",
        limitations: [],
        metrics: [{ metric: "bsrRank", value: 10, unit: "count", currency: null, metricNature: "provider_observed", status: "parsed", raw: "10", scope: "Kitchen" }],
      }],
    });

    expect(summary).toBeNull();
  });

  it("does not mix allowlisted typed keyword metrics from another ASIN", () => {
    const otherSubject = "amazon:US:B0ZZZZZZZZ";
    const summary = buildProviderMarketResearchSummary({
      subjectKey,
      allowedEvidenceRefs: ["attachment:other-keyword"],
      sourceEvidenceRefs: [sourceEvidenceRef("other-keyword", contentHash, otherSubject)],
      providerMetricEvidence: [{
        schemaVersion: "provider-metric-evidence.v1",
        provider: "SellerSprite",
        module: "reverse_asin",
        subjectKey: otherSubject,
        queryIdentity: { subjectKey: otherSubject, marketplace: "US", asin: "B0ZZZZZZZZ" },
        sourceType: "sellersprite_plugin",
        sourceSurface: "reverse ASIN visible table",
        sourceUrl: null,
        evidenceRefId: "attachment:other-keyword",
        attachmentId: "other-keyword",
        contentHash,
        capturedAt,
        observedAt: null,
        metricPeriod: null,
        metricNature: "provider_estimate",
        limitations: [],
        rows: [{
          rowKey: "kw-other",
          keyword: "baking mat",
          status: "valid",
          metrics: [{ metric: "estimatedTraffic", value: 1200, unit: "count", metricNature: "provider_estimate", status: "parsed", raw: "1,200" }],
        }],
      }],
    });

    expect(summary).toBeNull();
  });

  it("keeps SellerSprite historical trend estimates separate and labels their metric period", () => {
    const summary = buildProviderMarketResearchSummary({
      subjectKey,
      allowedEvidenceRefs: ["attachment:trend-1"],
      sourceEvidenceRefs: [sourceEvidenceRef("trend-1")],
      trendObservations: [{
        observationId: "trend-point-1",
        subjectKey,
        field: "sellersprite.traffic.searchVolume",
        value: 2400,
        valueKind: "estimated",
        sourceType: "sellersprite_plugin",
        capturedAt: "2026-03-01T00:00:00.000Z",
        capturedDate: "2026-03-01",
        evidenceRefs: ["attachment:trend-1"],
      }, {
        observationId: "trend-point-2",
        subjectKey,
        field: "sellersprite.traffic.searchVolume",
        value: 3300,
        valueKind: "estimated",
        sourceType: "sellersprite_plugin",
        capturedAt: "2026-04-01T00:00:00.000Z",
        capturedDate: "2026-04-01",
        evidenceRefs: ["attachment:trend-1"],
      }],
    } as never);

    expect(summary).toMatchObject({
      sources: [{
        provider: "SellerSprite",
        module: "historical_trend",
        sourceType: "sellersprite_plugin",
        subjectKey,
        capturedAt,
        evidenceRefId: "attachment:trend-1",
        metricNature: "provider_estimate",
        metrics: [{
          period: "2026-03-01 ~ 2026-04-01",
          metric: "sellersprite.traffic.searchVolume",
          metricNature: "provider_estimate",
          trend: { pointsCount: 2, startValue: 2400, endValue: 3300, minValue: 2400, maxValue: 3300, direction: "rising" },
        }],
      }],
    });
  });

  it("keeps an ambiguous same-instant source conflict at unknown direction", () => {
    const summary = buildProviderMarketResearchSummary({
      subjectKey,
      allowedEvidenceRefs: ["attachment:trend-1"],
      sourceEvidenceRefs: [sourceEvidenceRef("trend-1")],
      trendObservations: [2400, 3300].map((value, index) => ({
        observationId: `trend-conflict-${index}`,
        subjectKey,
        field: "sellersprite.traffic.searchVolume",
        value,
        valueKind: "estimated",
        sourceType: "sellersprite_plugin",
        capturedAt: "2026-03-01T00:00:00.000Z",
        capturedDate: "2026-03-01",
        evidenceRefs: ["attachment:trend-1"],
      })) as never,
    });

    expect(summary?.sources[0].metrics[0].trend).toMatchObject({
      pointsCount: 2,
      startValue: null,
      endValue: null,
      minValue: 2400,
      maxValue: 3300,
      conflictedInstantsCount: 1,
      direction: "unknown",
    });
  });
});
