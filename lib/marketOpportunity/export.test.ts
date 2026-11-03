import { describe, expect, it } from "vitest";

import { buildOpportunityExportRecord, opportunityExportFields, opportunityIdempotencyKey } from "@/lib/marketOpportunity/export";
import { buildMarketOpportunityAnalysisSnapshot } from "@/lib/server/marketOpportunityRepository";
import { computeMarketMetricsV1 } from "@/lib/marketScan/metrics";
import { buildMarketOpportunityNicheDefinition, buildInitialHumanDecision, buildInitialLarkSync } from "@/lib/marketOpportunity/contract";
import { buildInitialProductProjectSync } from "@/lib/marketOpportunity/concept";
import { buildInitialRepresentativeSelectionSet } from "@/lib/marketOpportunity/representatives";
import { FIXTURE_NICHE_DEFINITION, FIXTURE_SAMPLE_DEFINITION, makeProductFact } from "@/lib/marketScan/__fixtures__/productFactFixture";
import type { MarketOpportunityRecordView } from "@/lib/marketOpportunity/types";
import type { MarketScanRecordView } from "@/lib/server/marketScanRepository";

function fixtureOpportunity(): MarketOpportunityRecordView {
  const fact = makeProductFact({ asin: "B0FIXTURE1" });
  const sampleHash = "a".repeat(64);
  const at = "2026-09-20T00:00:00.000Z";
  const metrics = computeMarketMetricsV1({ sample: [{ subjectKey: fact.subjectKey, productFact: fact, evidenceId: "evidence-1", evidenceVersion: 1, capturedAt: at }], referenceDate: at, sampleHash, marketplace: "US" });
  const scan = { id: "scan-export", scanName: "export", marketplace: "US", nicheDefinition: FIXTURE_NICHE_DEFINITION, sampleDefinition: FIXTURE_SAMPLE_DEFINITION, sampleSnapshot: { schemaVersion: "market-scan-sample.v1", metricsVersion: metrics.metricsVersion, itemCount: 1, sampleHash, items: [] }, metrics, sampleCount: 1, metricsVersion: metrics.metricsVersion, sampleHash, createdAt: at, updatedAt: at } as unknown as MarketScanRecordView;
  const analysisSnapshot = buildMarketOpportunityAnalysisSnapshot({ latest: scan, history: [], generatedAt: new Date(at) });
  return { id: "opp-export", ownerScope: "owner:v1", schemaVersion: "market-opportunity.v1", name: "Export fixture", marketplace: "US", nicheKind: "sellersprite_filter", nicheDefinition: buildMarketOpportunityNicheDefinition(FIXTURE_NICHE_DEFINITION), latestMarketScanId: scan.id, scanRefs: [{ scanId: scan.id, sampleHash, metricsVersion: metrics.metricsVersion, sampleCount: 1, createdAt: at }], analysisSnapshot, aiInterpretation: null, humanDecision: { ...buildInitialHumanDecision(), status: "CONTINUE", reason: "先继续验证", nextAction: "补一轮扫描", decidedAt: at, revision: 1 }, larkSync: buildInitialLarkSync(), representativeSet: buildInitialRepresentativeSelectionSet(), conceptSnapshot: null, conceptProjectSync: buildInitialProductProjectSync(), createdAt: at, updatedAt: at };
}

describe("OpportunityExportRecord", () => {
  it("uses OpportunityID as the business key and does not emit ASIN", () => {
    const record = buildOpportunityExportRecord(fixtureOpportunity(), { appBaseUrl: "http://127.0.0.1:3011", exportedAt: "2026-09-20T00:00:00.000Z" });
    const fields = opportunityExportFields(record);
    expect(record.opportunityId).toBe("opp-export");
    expect(fields.OpportunityID).toBe("opp-export");
    expect(Object.keys(fields)).not.toContain("ASIN");
    expect(record.opportunityUrl).toContain("/market-opportunities/opp-export");
  });

  it("keeps the idempotency key stable for the same opportunity and table", () => {
    const record = fixtureOpportunity();
    expect(opportunityIdempotencyKey(record, "tbl-opportunity")).toBe(opportunityIdempotencyKey(record, "tbl-opportunity"));
    expect(opportunityIdempotencyKey(record, "tbl-other")).not.toBe(opportunityIdempotencyKey(record, "tbl-opportunity"));
  });
});
