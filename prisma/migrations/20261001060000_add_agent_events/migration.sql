-- Reconcile the existing AgentEvent model with the checked-in migration chain.
-- IF NOT EXISTS supports older environments where Prisma created this table.
CREATE TABLE IF NOT EXISTS "agent_events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "taskId" TEXT,
  "runId" TEXT,
  "module" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "level" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "metadataJson" TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS "agent_events_taskId_createdAt_idx" ON "agent_events"("taskId", "createdAt");
CREATE INDEX IF NOT EXISTS "agent_events_module_createdAt_idx" ON "agent_events"("module", "createdAt");
CREATE INDEX IF NOT EXISTS "agent_events_level_createdAt_idx" ON "agent_events"("level", "createdAt");
CREATE INDEX IF NOT EXISTS "agent_events_createdAt_idx" ON "agent_events"("createdAt");
