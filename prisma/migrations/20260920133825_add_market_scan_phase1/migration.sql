-- Product Development V1 — Phase 1: MarketScan（市场扫描）基础表。
--
-- MarketScan 是业务研究对象（编组层），不是来源事实：
--   Source Adapter → Capture Gateway → Evidence → ProductFact
--                                                ↓ 编组（只读）
--                                             MarketScan
--                                                ↓
--                                       MarketSample Snapshot（事实版本锁定）
--                                                ↓
--                                      Deterministic Market Metrics（纯函数）
--
-- 本 migration 只新增一张表，不锁表重建、不 DROP、不改动任何既有表：
--   OpportunityCandidate / ViralAnalysisRecord / ProductBatch / ProductBatchItem /
--   ProductDiscoverySelection / V4* / ListingCopyHistory / agent_events 全部不变。

-- CreateTable
CREATE TABLE "MarketScan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerScope" TEXT NOT NULL,
    "scanName" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "nicheKind" TEXT NOT NULL,
    "nicheDefinitionJson" TEXT NOT NULL,
    "sampleDefinitionJson" TEXT NOT NULL,
    "sampleSnapshotJson" TEXT NOT NULL,
    "metricsJson" TEXT NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "metricsVersion" TEXT NOT NULL,
    "sampleHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketScan_ownerScope_check"
      CHECK (length("ownerScope") BETWEEN 1 AND 64),
    CONSTRAINT "MarketScan_scanName_check"
      CHECK (length("scanName") BETWEEN 1 AND 200),
    CONSTRAINT "MarketScan_marketplace_check"
      CHECK (length("marketplace") BETWEEN 1 AND 16),
    CONSTRAINT "MarketScan_nicheKind_check"
      CHECK (
        "nicheKind" IN (
          'category',
          'keyword',
          'keyword_cluster',
          'best_sellers',
          'new_releases',
          'sellersprite_filter',
          'custom_sample'
        )
      ),
    CONSTRAINT "MarketScan_sampleCount_check"
      CHECK ("sampleCount" >= 1),
    CONSTRAINT "MarketScan_metricsVersion_check"
      CHECK (length("metricsVersion") BETWEEN 1 AND 64),
    CONSTRAINT "MarketScan_sampleHash_check"
      CHECK (length("sampleHash") = 64),
    CONSTRAINT "MarketScan_metricsJson_check"
      CHECK (
        json_valid("metricsJson")
        AND json_type("metricsJson", '$.schemaVersion') IS NOT NULL
        AND json_type("metricsJson", '$.schemaVersion') <> 'null'
        AND json_extract("metricsJson", '$.schemaVersion') = 'market-metrics.v1'
        AND json_type("metricsJson", '$.metricsVersion') IS NOT NULL
        AND json_type("metricsJson", '$.metricsVersion') <> 'null'
        AND json_extract("metricsJson", '$.metricsVersion') = "metricsVersion"
        AND json_type("metricsJson", '$.sampleHash') IS NOT NULL
        AND json_type("metricsJson", '$.sampleHash') <> 'null'
        AND json_extract("metricsJson", '$.sampleHash') = "sampleHash"
        AND json_type("metricsJson", '$.sampleCount') IS NOT NULL
        AND json_type("metricsJson", '$.sampleCount') <> 'null'
        AND json_extract("metricsJson", '$.sampleCount') = "sampleCount"
      ),
    CONSTRAINT "MarketScan_nicheDefinitionJson_check"
      CHECK (
        json_valid("nicheDefinitionJson")
        AND json_type("nicheDefinitionJson", '$.schemaVersion') IS NOT NULL
        AND json_type("nicheDefinitionJson", '$.schemaVersion') <> 'null'
        AND json_extract("nicheDefinitionJson", '$.schemaVersion') = 'market-scan-sample.v1'
        AND json_type("nicheDefinitionJson", '$.kind') IS NOT NULL
        AND json_type("nicheDefinitionJson", '$.kind') <> 'null'
        AND json_extract("nicheDefinitionJson", '$.kind') = "nicheKind"
      ),
    CONSTRAINT "MarketScan_sampleDefinitionJson_check"
      CHECK (
        json_valid("sampleDefinitionJson")
        AND json_type("sampleDefinitionJson", '$.schemaVersion') IS NOT NULL
        AND json_type("sampleDefinitionJson", '$.schemaVersion') <> 'null'
        AND json_extract("sampleDefinitionJson", '$.schemaVersion') = 'market-scan-sample.v1'
        AND json_type("sampleDefinitionJson", '$.marketplace') IS NOT NULL
        AND json_type("sampleDefinitionJson", '$.marketplace') <> 'null'
        AND json_extract("sampleDefinitionJson", '$.marketplace') = "marketplace"
      ),
    CONSTRAINT "MarketScan_sampleSnapshotJson_check"
      CHECK (
        json_valid("sampleSnapshotJson")
        AND json_type("sampleSnapshotJson", '$.schemaVersion') IS NOT NULL
        AND json_type("sampleSnapshotJson", '$.schemaVersion') <> 'null'
        AND json_extract("sampleSnapshotJson", '$.schemaVersion') = 'market-scan-sample.v1'
        -- json_type(...) IS NOT NULL 保证键真的存在：缺失键会让 json_extract 返回 NULL，
        -- 而 `NULL = 某列` 在 SQLite 里是 NULL（视为通过），那样约束就形同虚设；
        -- 显式 JSON null 也必须拒绝，不能仅依赖列值比较。
        AND json_type("sampleSnapshotJson", '$.metricsVersion') IS NOT NULL
        AND json_type("sampleSnapshotJson", '$.metricsVersion') <> 'null'
        AND json_extract("sampleSnapshotJson", '$.metricsVersion') = "metricsVersion"
        AND json_type("sampleSnapshotJson", '$.sampleHash') IS NOT NULL
        AND json_type("sampleSnapshotJson", '$.sampleHash') <> 'null'
        AND json_extract("sampleSnapshotJson", '$.sampleHash') = "sampleHash"
        AND json_type("sampleSnapshotJson", '$.itemCount') IS NOT NULL
        AND json_type("sampleSnapshotJson", '$.itemCount') <> 'null'
        AND json_extract("sampleSnapshotJson", '$.itemCount') = "sampleCount"
      ),
    CONSTRAINT "MarketScan_jsonSize_check"
      CHECK (
        length(CAST("nicheDefinitionJson" AS BLOB)) <= 65536
        AND length(CAST("sampleDefinitionJson" AS BLOB)) <= 65536
        AND length(CAST("sampleSnapshotJson" AS BLOB)) <= 4194304
        AND length(CAST("metricsJson" AS BLOB)) <= 4194304
      )
);

-- CreateIndex
CREATE INDEX "MarketScan_ownerScope_createdAt_idx"
  ON "MarketScan"("ownerScope", "createdAt");

-- CreateIndex
CREATE INDEX "MarketScan_ownerScope_sampleHash_idx"
  ON "MarketScan"("ownerScope", "sampleHash");
