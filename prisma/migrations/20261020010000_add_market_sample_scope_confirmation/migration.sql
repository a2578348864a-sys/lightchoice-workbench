-- P3: 市场研究范围人工确认（与 archivedAt 语义分离）
-- 全部可空；历史行 NULL = 从未人工确认；不自动生成任何 IN_SCOPE。

ALTER TABLE "V5MarketSampleLifecycle" ADD COLUMN "scopeStatus" TEXT;
ALTER TABLE "V5MarketSampleLifecycle" ADD COLUMN "scopeReason" TEXT;
ALTER TABLE "V5MarketSampleLifecycle" ADD COLUMN "scopeSampleHash" TEXT;
ALTER TABLE "V5MarketSampleLifecycle" ADD COLUMN "scopeNicheHash" TEXT;
ALTER TABLE "V5MarketSampleLifecycle" ADD COLUMN "scopeConfirmedAt" DATETIME;
ALTER TABLE "V5MarketSampleLifecycle" ADD COLUMN "scopeConfirmedBy" TEXT;
ALTER TABLE "V5MarketSampleLifecycle" ADD COLUMN "scopeRevision" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "V5MarketSampleLifecycle_ownerScope_scanId_scopeStatus_idx"
  ON "V5MarketSampleLifecycle"("ownerScope", "scanId", "scopeStatus");
