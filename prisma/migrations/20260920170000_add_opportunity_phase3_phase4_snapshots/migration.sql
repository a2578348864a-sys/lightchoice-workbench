-- Phase 3/4：在既有 NicheOpportunity 上增加版本化关系/概念快照。
-- 不新增代表商品、ProductConcept 或飞书项目业务表；不修改历史事实表。
ALTER TABLE "NicheOpportunity" ADD COLUMN "representativeSetJson" TEXT NOT NULL DEFAULT '{"schemaVersion":"market-opportunity-representatives.v1","revision":0,"items":[]}';
ALTER TABLE "NicheOpportunity" ADD COLUMN "conceptSnapshotJson" TEXT;
ALTER TABLE "NicheOpportunity" ADD COLUMN "conceptProjectSyncJson" TEXT NOT NULL DEFAULT '{"status":"NOT_SYNCED"}';
