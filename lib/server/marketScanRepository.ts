/**
 * Product Development V1 — Phase 1：MarketScan 持久化。
 *
 * 只负责 MarketScan 一张表的读写；不触碰任何既有表（Candidate / Task / ProductBatch / V4*）。
 * Owner 边界沿用既有架构：固定服务器归属 `MARKET_SCAN_OWNER_SCOPE`，不新增 RBAC。
 */

import type { PrismaClient } from "@prisma/client";

import {
  MARKET_SCAN_OWNER_SCOPE,
  MarketScanContractError,
  assertJsonFieldWithinLimit,
  assertMarketScanHash,
  assertMetricsVersion,
  assertSampleCount,
  assertScanName,
  assertMarketplace,
  parseMarketMetricsV1,
  parseMarketScanSampleSnapshotV1,
  parseNicheDefinitionV1,
  parseSampleDefinitionV1,
} from "@/lib/marketScan/contract";
import type {
  MarketMetricsV1,
  MarketScanSampleSnapshotV1,
  NicheDefinitionV1,
  SampleDefinitionV1,
} from "@/lib/marketScan/types";
import { prisma } from "@/lib/server/db";

export type MarketScanRecordView = {
  id: string;
  scanName: string;
  marketplace: string;
  nicheDefinition: NicheDefinitionV1;
  sampleDefinition: SampleDefinitionV1;
  sampleSnapshot: MarketScanSampleSnapshotV1;
  metrics: MarketMetricsV1;
  sampleCount: number;
  metricsVersion: string;
  sampleHash: string;
  createdAt: string;
  updatedAt: string;
};

export type MarketScanCreateInput = {
  scanName: string;
  marketplace: string;
  nicheKind: string;
  nicheDefinition: NicheDefinitionV1;
  sampleDefinition: SampleDefinitionV1;
  sampleSnapshot: MarketScanSampleSnapshotV1;
  metrics: MarketMetricsV1;
};

type MarketScanRow = {
  id: string;
  ownerScope: string;
  scanName: string;
  marketplace: string;
  nicheKind: string;
  nicheDefinitionJson: string;
  sampleDefinitionJson: string;
  sampleSnapshotJson: string;
  metricsJson: string;
  sampleCount: number;
  metricsVersion: string;
  sampleHash: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type MarketScanRepository = {
  create(input: MarketScanCreateInput): Promise<MarketScanRecordView>;
  getById(id: string): Promise<MarketScanRecordView | null>;
  list(input?: { limit?: number }): Promise<MarketScanRecordView[]>;
};

export class MarketScanPersistenceError extends Error {
  constructor(
    public readonly code: "market_scan_persist_failed" | "market_scan_invalid_record",
    message: string,
  ) {
    super(message);
    this.name = "MarketScanPersistenceError";
  }
}

const MAX_LIST_LIMIT = 100;

function isoOf(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new MarketScanPersistenceError("market_scan_invalid_record", "MarketScan 时间戳不合法。");
  }
  return date.toISOString();
}

/** 反序列化边界：绝不直接信任数据库里的 JSON。 */
export function parseMarketScanRow(row: MarketScanRow): MarketScanRecordView {
  try {
    const nicheDefinition = parseNicheDefinitionV1(JSON.parse(row.nicheDefinitionJson));
    const sampleDefinition = parseSampleDefinitionV1(JSON.parse(row.sampleDefinitionJson));
    const sampleSnapshot = parseMarketScanSampleSnapshotV1(JSON.parse(row.sampleSnapshotJson));
    const metrics = parseMarketMetricsV1(JSON.parse(row.metricsJson));
    if (sampleSnapshot.sampleHash !== row.sampleHash) {
      throw new MarketScanPersistenceError(
        "market_scan_invalid_record",
        "MarketScan 记录内 sampleHash 不一致。",
      );
    }
    if (sampleSnapshot.metricsVersion !== row.metricsVersion
      || metrics.metricsVersion !== row.metricsVersion) {
      throw new MarketScanPersistenceError(
        "market_scan_invalid_record",
        "MarketScan 记录内 metricsVersion 不一致。",
      );
    }
    if (sampleSnapshot.itemCount !== row.sampleCount || metrics.sampleCount !== row.sampleCount) {
      throw new MarketScanPersistenceError(
        "market_scan_invalid_record",
        "MarketScan 记录内样本条数不一致。",
      );
    }
    if (nicheDefinition.kind !== row.nicheKind) {
      throw new MarketScanPersistenceError(
        "market_scan_invalid_record",
        "MarketScan 记录内 nicheKind 不一致。",
      );
    }
    return {
      id: row.id,
      scanName: row.scanName,
      marketplace: row.marketplace,
      nicheDefinition,
      sampleDefinition,
      sampleSnapshot,
      metrics,
      sampleCount: row.sampleCount,
      metricsVersion: row.metricsVersion,
      sampleHash: row.sampleHash,
      createdAt: isoOf(row.createdAt),
      updatedAt: isoOf(row.updatedAt),
    };
  } catch (error) {
    if (error instanceof MarketScanPersistenceError) throw error;
    if (error instanceof MarketScanContractError) {
      throw new MarketScanPersistenceError("market_scan_invalid_record", error.message);
    }
    throw new MarketScanPersistenceError("market_scan_invalid_record", "MarketScan 记录解析失败。");
  }
}

/** 创建前的完整守卫：所有 JSON 必须通过契约校验，且大小受限。 */
export function assertMarketScanCreateInput(input: MarketScanCreateInput): {
  nicheDefinitionJson: string;
  sampleDefinitionJson: string;
  sampleSnapshotJson: string;
  metricsJson: string;
  scanName: string;
  marketplace: string;
  sampleCount: number;
  metricsVersion: string;
  sampleHash: string;
} {
  const scanName = assertScanName(input.scanName);
  const marketplace = assertMarketplace(input.marketplace);
  const nicheDefinition = parseNicheDefinitionV1(input.nicheDefinition);
  const sampleDefinition = parseSampleDefinitionV1(input.sampleDefinition);
  const sampleSnapshot = parseMarketScanSampleSnapshotV1(input.sampleSnapshot);
  const metrics = parseMarketMetricsV1(input.metrics);
  const sampleCount = assertSampleCount(sampleSnapshot.itemCount);
  const metricsVersion = assertMetricsVersion(sampleSnapshot.metricsVersion);
  const sampleHash = assertMarketScanHash(sampleSnapshot.sampleHash, "sampleHash");

  // 契约一致性：样本快照与指标结果必须描述同一次编组。
  if (metrics.sampleHash !== sampleHash) {
    throw new MarketScanContractError(
      "market_scan_sample_hash_mismatch",
      "指标结果与样本快照的 sampleHash 不一致。",
    );
  }
  if (metrics.metricsVersion !== metricsVersion) {
    throw new MarketScanContractError(
      "market_scan_metrics_version_mismatch",
      "指标结果与样本快照的 metricsVersion 不一致。",
    );
  }
  if (metrics.sampleCount !== sampleCount) {
    throw new MarketScanContractError("market_scan_invalid", "指标 sampleCount 与样本快照不一致。");
  }
  if (nicheDefinition.kind !== input.nicheKind) {
    throw new MarketScanContractError("market_scan_invalid", "nicheKind 与 nicheDefinition 不一致。");
  }
  if (sampleDefinition.marketplace !== marketplace) {
    throw new MarketScanContractError(
      "market_scan_invalid",
      "marketplace 与 sampleDefinition.marketplace 不一致。",
    );
  }

  return {
    nicheDefinitionJson: assertJsonFieldWithinLimit(
      "nicheDefinitionJson",
      JSON.stringify(nicheDefinition),
    ),
    sampleDefinitionJson: assertJsonFieldWithinLimit(
      "sampleDefinitionJson",
      JSON.stringify(sampleDefinition),
    ),
    sampleSnapshotJson: assertJsonFieldWithinLimit(
      "sampleSnapshotJson",
      JSON.stringify(sampleSnapshot),
    ),
    metricsJson: assertJsonFieldWithinLimit("metricsJson", JSON.stringify(metrics)),
    scanName,
    marketplace,
    sampleCount,
    metricsVersion,
    sampleHash,
  };
}

const ROW_SELECT = {
  id: true,
  ownerScope: true,
  scanName: true,
  marketplace: true,
  nicheKind: true,
  nicheDefinitionJson: true,
  sampleDefinitionJson: true,
  sampleSnapshotJson: true,
  metricsJson: true,
  sampleCount: true,
  metricsVersion: true,
  sampleHash: true,
  createdAt: true,
  updatedAt: true,
} as const;

export function createMarketScanRepository(
  client: PrismaClient = prisma,
): MarketScanRepository {
  return {
    async create(input) {
      const guarded = assertMarketScanCreateInput(input);
      try {
        const row = await client.marketScan.create({
          data: {
            ownerScope: MARKET_SCAN_OWNER_SCOPE,
            scanName: guarded.scanName,
            marketplace: guarded.marketplace,
            nicheKind: input.nicheKind,
            nicheDefinitionJson: guarded.nicheDefinitionJson,
            sampleDefinitionJson: guarded.sampleDefinitionJson,
            sampleSnapshotJson: guarded.sampleSnapshotJson,
            metricsJson: guarded.metricsJson,
            sampleCount: guarded.sampleCount,
            metricsVersion: guarded.metricsVersion,
            sampleHash: guarded.sampleHash,
          },
          select: ROW_SELECT,
        });
        return parseMarketScanRow(row as MarketScanRow);
      } catch (error) {
        if (error instanceof MarketScanContractError
          || error instanceof MarketScanPersistenceError) {
          throw error;
        }
        throw new MarketScanPersistenceError(
          "market_scan_persist_failed",
          error instanceof Error ? error.message : "MarketScan 写入失败。",
        );
      }
    },

    async getById(id) {
      const row = await client.marketScan.findFirst({
        where: { id, ownerScope: MARKET_SCAN_OWNER_SCOPE },
        select: ROW_SELECT,
      });
      return row ? parseMarketScanRow(row as MarketScanRow) : null;
    },

    async list(input) {
      const requested = input?.limit;
      const limit = Number.isSafeInteger(requested) && (requested as number) > 0
        ? Math.min(requested as number, MAX_LIST_LIMIT)
        : MAX_LIST_LIMIT;
      const rows = await client.marketScan.findMany({
        where: { ownerScope: MARKET_SCAN_OWNER_SCOPE },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
        select: ROW_SELECT,
      });
      return rows.map((row) => parseMarketScanRow(row as MarketScanRow));
    },
  };
}
