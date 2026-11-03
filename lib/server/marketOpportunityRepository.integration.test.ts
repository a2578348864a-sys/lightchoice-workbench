import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { interpretMarketOpportunityDeterministically } from "@/lib/marketOpportunity/ai";
import { buildInitialLarkSync } from "@/lib/marketOpportunity/contract";
import { buildSampleSnapshot, computeMarketMetricsV1 } from "@/lib/marketScan/metrics";
import { MARKET_METRICS_VERSION } from "@/lib/marketScan/types";
import { FIXTURE_NICHE_DEFINITION, FIXTURE_SAMPLE_DEFINITION, makeProductFact } from "@/lib/marketScan/__fixtures__/productFactFixture";
import { createMarketScanRepository, type MarketScanCreateInput } from "@/lib/server/marketScanRepository";
import { createMarketOpportunityRepository } from "@/lib/server/marketOpportunityRepository";
import {
  cleanupMigratedSqliteDatabase,
  createMigratedSqliteDatabase,
  fileDatabaseUrl,
  openSqlite,
} from "@/lib/marketScan/__fixtures__/testDatabase";

let root = "";
let databasePath = "";
let client: PrismaClient;

function scanInput(index: number): MarketScanCreateInput {
  const capturedAt = `2026-09-${String(10 + index).padStart(2, "0")}T00:00:00.000Z`;
  const fact = makeProductFact({
    asin: `B0FIXTURE${index}`,
    price: 10 + index,
    monthlySalesEstimate: 100 + index * 10,
    monthlyRevenueEstimate: 1_000 + index * 100,
    capturedAt,
  });
  const sample = [{ subjectKey: fact.subjectKey, productFact: fact, evidenceId: `ev-fixture-${index}`, evidenceVersion: 1, capturedAt }];
  const snapshot = buildSampleSnapshot({
    nicheDefinition: FIXTURE_NICHE_DEFINITION,
    sampleDefinition: FIXTURE_SAMPLE_DEFINITION,
    sample,
    metricsVersion: MARKET_METRICS_VERSION,
  });
  const metrics = computeMarketMetricsV1({
    sample,
    referenceDate: capturedAt,
    metricsVersion: MARKET_METRICS_VERSION,
    sampleHash: snapshot.sampleHash,
    marketplace: "US",
  });
  return {
    scanName: `Fixture scan ${index}`,
    marketplace: "US",
    nicheKind: FIXTURE_NICHE_DEFINITION.kind,
    nicheDefinition: FIXTURE_NICHE_DEFINITION,
    sampleDefinition: FIXTURE_SAMPLE_DEFINITION,
    sampleSnapshot: snapshot,
    metrics,
  };
}

beforeEach(() => {
  const created = createMigratedSqliteDatabase();
  root = created.root;
  databasePath = created.databasePath;
  client = new PrismaClient({ datasources: { db: { url: fileDatabaseUrl(databasePath) } } });
});

afterEach(async () => {
  await client.$disconnect();
  cleanupMigratedSqliteDatabase(root);
});

describe("NicheOpportunity isolated persistence", () => {
  it("links three existing scans into two opportunities without touching Candidate or Task", async () => {
    const scans = createMarketScanRepository(client);
    const first = await scans.create(scanInput(1));
    const second = await scans.create(scanInput(2));
    const third = await scans.create(scanInput(3));
    const database = openSqlite(databasePath);
    const before = {
      candidate: Number((database.prepare('SELECT COUNT(*) AS count FROM "OpportunityCandidate"').get() as { count: number }).count),
      task: Number((database.prepare('SELECT COUNT(*) AS count FROM "ViralAnalysisRecord"').get() as { count: number }).count),
    };
    database.close();

    const opportunities = createMarketOpportunityRepository(client, scans);
    const firstOpportunity = await opportunities.create({ name: "Fixture opportunity A", latestMarketScanId: second.id, scanIds: [first.id, second.id] });
    const secondOpportunity = await opportunities.create({ name: "Fixture opportunity B", latestMarketScanId: third.id, scanIds: [first.id, second.id, third.id] });
    expect(firstOpportunity.scanRefs).toHaveLength(2);
    expect(secondOpportunity.scanRefs).toHaveLength(3);
    expect(secondOpportunity.analysisSnapshot.latestScanId).toBe(third.id);
    expect(secondOpportunity.analysisSnapshot.comparison?.status).toBe("COMPARABLE");

    const ai = interpretMarketOpportunityDeterministically(secondOpportunity.analysisSnapshot);
    const withAi = await opportunities.setAiInterpretation(secondOpportunity.id, ai);
    expect(withAi.aiInterpretation?.model).toBe("local-deterministic-v1");
    const decided = await opportunities.setHumanDecision({ id: secondOpportunity.id, status: "CONTINUE", reason: "先继续验证", nextAction: "补一轮同定义扫描", expectedRevision: 0 });
    expect(decided.humanDecision?.status).toBe("CONTINUE");
    expect(decided.humanDecision?.revision).toBe(1);
    await expect(opportunities.setHumanDecision({ id: secondOpportunity.id, status: "DROP", reason: "旧页面不应覆盖", nextAction: null, expectedRevision: 0 })).rejects.toMatchObject({ code: "market_opportunity_conflict" });
    const syncedState = { ...buildInitialLarkSync(), status: "FAILED" as const, opportunityId: secondOpportunity.id, errorCode: "LIVE_SYNC_BLOCKED_BY_CREDENTIALS" };
    const afterLark = await opportunities.setLarkSync(secondOpportunity.id, syncedState);
    expect(afterLark.larkSync.status).toBe("FAILED");

    const listed = await opportunities.list();
    expect(listed).toHaveLength(2);
    const afterDb = openSqlite(databasePath);
    try {
      expect(Number((afterDb.prepare('SELECT COUNT(*) AS count FROM "OpportunityCandidate"').get() as { count: number }).count)).toBe(before.candidate);
      expect(Number((afterDb.prepare('SELECT COUNT(*) AS count FROM "ViralAnalysisRecord"').get() as { count: number }).count)).toBe(before.task);
      expect(Number((afterDb.prepare('SELECT COUNT(*) AS count FROM "NicheOpportunity"').get() as { count: number }).count)).toBe(2);
    } finally {
      afterDb.close();
    }
  });
});
