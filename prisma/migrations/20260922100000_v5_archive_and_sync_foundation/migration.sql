-- V5 B0: one orthogonal archive marker for all business objects.
-- Existing ProductBatch batchStatus=archived is normalized to its last
-- business state (ready) while preserving visibility in archivedAt.
ALTER TABLE "ViralAnalysisRecord" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "OpportunityCandidate" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "ProductBatch" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "ProductBatchItem" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "ProductBatchItem" ADD COLUMN "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "MarketScan" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "NicheOpportunity" ADD COLUMN "archivedAt" DATETIME;

UPDATE "ProductBatch"
SET "archivedAt" = COALESCE("updatedAt", CURRENT_TIMESTAMP),
    "batchStatus" = 'ready'
WHERE "batchStatus" = 'archived' AND "archivedAt" IS NULL;

CREATE INDEX "ProductBatch_ownerSubject_archivedAt_updatedAt_idx"
  ON "ProductBatch"("ownerSubject", "archivedAt", "updatedAt");
CREATE INDEX "ProductBatchItem_batchId_archivedAt_createdAt_idx"
  ON "ProductBatchItem"("batchId", "archivedAt", "createdAt");
CREATE INDEX "MarketScan_ownerScope_archivedAt_updatedAt_idx"
  ON "MarketScan"("ownerScope", "archivedAt", "updatedAt");

-- Technical operation receipt only: no prompt, secret, external payload, or business state.
CREATE TABLE "V5OperationReceipt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actorScope" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "resourceKey" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'processing',
  "responseJson" TEXT,
  "errorCode" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "expiresAt" DATETIME
);
CREATE UNIQUE INDEX "V5OperationReceipt_actorScope_operation_resourceKey_idempotencyKey_key"
  ON "V5OperationReceipt"("actorScope", "operation", "resourceKey", "idempotencyKey");
CREATE INDEX "V5OperationReceipt_actorScope_operation_resourceKey_idx"
  ON "V5OperationReceipt"("actorScope", "operation", "resourceKey");

-- Local Feishu projection state; one-way LightChoice -> Feishu only.
CREATE TABLE "V5FeishuSyncMetadata" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actorScope" TEXT NOT NULL,
  "resourceType" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "tableName" TEXT NOT NULL,
  "businessKey" TEXT NOT NULL,
  "projectionHash" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'NOT_SYNCED',
  "remoteRecordId" TEXT,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" DATETIME,
  "lastSuccessAt" DATETIME,
  "nextRetryAt" DATETIME,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "retryable" BOOLEAN NOT NULL DEFAULT false,
  "idempotencyKey" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "V5FeishuSyncMetadata_actorScope_tableName_businessKey_key"
  ON "V5FeishuSyncMetadata"("actorScope", "tableName", "businessKey");
CREATE INDEX "V5FeishuSyncMetadata_actorScope_resourceType_resourceId_idx"
  ON "V5FeishuSyncMetadata"("actorScope", "resourceType", "resourceId");
CREATE INDEX "V5FeishuSyncMetadata_state_nextRetryAt_idx"
  ON "V5FeishuSyncMetadata"("state", "nextRetryAt");

-- MarketSample 行级生命周期只保存 archive marker；MarketScan snapshot remains immutable.
CREATE TABLE "V5MarketSampleLifecycle" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerScope" TEXT NOT NULL,
  "scanId" TEXT NOT NULL,
  "marketSampleKey" TEXT NOT NULL,
  "archivedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "V5MarketSampleLifecycle_ownerScope_marketSampleKey_key"
  ON "V5MarketSampleLifecycle"("ownerScope", "marketSampleKey");
CREATE INDEX "V5MarketSampleLifecycle_ownerScope_scanId_archivedAt_updatedAt_idx"
  ON "V5MarketSampleLifecycle"("ownerScope", "scanId", "archivedAt", "updatedAt");
