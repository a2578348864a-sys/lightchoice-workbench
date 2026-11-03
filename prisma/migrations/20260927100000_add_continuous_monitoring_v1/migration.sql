CREATE TABLE "WatchTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subjectKey" TEXT NOT NULL,
    "captureModule" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "schedule" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "policyJson" TEXT NOT NULL,
    "lastRunAt" DATETIME,
    "lastMeaningfulChangeAt" DATETIME,
    "nextRunAt" DATETIME NOT NULL,
    "activeRunId" TEXT,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "MonitoringRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "watchTargetId" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "outcome" TEXT,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "previousEvidenceRefJson" TEXT,
    "currentEvidenceRefJson" TEXT,
    "changeSummaryJson" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "aiExplanationJson" TEXT,
    CONSTRAINT "MonitoringRun_watchTargetId_fkey" FOREIGN KEY ("watchTargetId") REFERENCES "WatchTarget" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "WatchTarget_enabled_nextRunAt_idx" ON "WatchTarget"("enabled", "nextRunAt");
CREATE UNIQUE INDEX "WatchTarget_subjectKey_captureModule_key" ON "WatchTarget"("subjectKey", "captureModule");
CREATE INDEX "MonitoringRun_watchTargetId_startedAt_idx" ON "MonitoringRun"("watchTargetId", "startedAt");
