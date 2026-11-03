-- Product Development V1 — Phase 2: NicheOpportunity。
-- 只新增市场机会编组表；不改动 MarketScan、Candidate、Task、ProductBatch 或 V4 表。

CREATE TABLE "NicheOpportunity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerScope" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL DEFAULT 'market-opportunity.v1',
    "name" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "nicheKind" TEXT NOT NULL,
    "nicheDefinitionJson" TEXT NOT NULL,
    "latestMarketScanId" TEXT NOT NULL,
    "scanRefsJson" TEXT NOT NULL,
    "analysisSnapshotJson" TEXT NOT NULL,
    "aiInterpretationJson" TEXT,
    "humanDecisionJson" TEXT,
    "larkSyncJson" TEXT NOT NULL DEFAULT '{"status":"NOT_SYNCED"}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "NicheOpportunity_ownerScope_updatedAt_idx"
  ON "NicheOpportunity"("ownerScope", "updatedAt");

CREATE INDEX "NicheOpportunity_ownerScope_createdAt_idx"
  ON "NicheOpportunity"("ownerScope", "createdAt");

CREATE INDEX "NicheOpportunity_ownerScope_latestMarketScanId_idx"
  ON "NicheOpportunity"("ownerScope", "latestMarketScanId");
