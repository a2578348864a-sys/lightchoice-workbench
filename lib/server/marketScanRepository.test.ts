/**
 * MarketScan 持久化测试（真实 migration SQL + 真实 Prisma client + 真实 SQLite）。
 *
 * 覆盖：create / read / list / 非法 JSON / 非法 snapshot / 原子失败 / Owner 边界 /
 * metricsVersion 历史保留 / 既有表零改动。
 */

import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MARKET_SCAN_SAMPLE_SCHEMA } from "@/lib/marketScan/types";
import { factValuesFingerprintOf } from "@/lib/marketScan/metrics";
import {
  MarketScanContractError,
  buildNicheDefinitionV1,
  buildSampleDefinitionV1,
} from "@/lib/marketScan/contract";
import {
  MarketScanPersistenceError,
  createMarketScanRepository,
} from "@/lib/server/marketScanRepository";
import type { MarketScanCreateInput } from "@/lib/server/marketScanRepository";
import {
  HASH_A,
  HASH_B,
  cleanupMigratedSqliteDatabase,
  createMigratedSqliteDatabase,
  fileDatabaseUrl,
  openSqlite,
} from "@/lib/marketScan/__fixtures__/testDatabase";

const SAMPLE_HASH = "c".repeat(64);

let root = "";
let databasePath = "";
let client: PrismaClient;
let repository: ReturnType<typeof createMarketScanRepository>;

function niche() {
  return buildNicheDefinitionV1({
    kind: "custom_sample",
    label: "水杯 · 自定义样本",
    notes: null,
    parameters: { query: "water bottle" },
  });
}

function sampleDefinition() {
  return buildSampleDefinitionV1({
    origin: "existing_product_batch_evidence",
    marketplace: "US",
    sourceTypes: ["sellersprite_xlsx"],
    productBatchId: "batch-1",
    requestedLimit: 50,
  });
}

function sampleItem(index: number) {
  const asin = `B00000000${index}`;
  const factValues = {
    asin,
    title: { presence: "present" as const, value: `商品 ${index}` },
    brand: { presence: "missing" as const },
    category: { presence: "missing" as const },
    price: {
      presence: "present" as const,
      value: { amount: 19.99, currency: "USD" },
      valueSource: "FACT" as const,
    },
    rating: { presence: "missing" as const },
    reviewCount: { presence: "missing" as const },
    bsr: { presence: "missing" as const },
    monthlySalesEstimate: {
      presence: "present" as const,
      value: 100,
      valueSource: "PROVIDER_ESTIMATE" as const,
    },
    monthlyRevenueEstimate: {
      presence: "missing" as const,
      valueSource: "PROVIDER_ESTIMATE" as const,
    },
    launchedDate: { presence: "missing" as const },
  };
  const subjectKey = `amazon:US:${asin}`;
  return {
    asin,
    subjectKey,
    candidateId: null,
    productFactFingerprint: HASH_A,
    factValuesFingerprint: factValuesFingerprintOf({ subjectKey, factValues }),
    sourceProofHash: HASH_B,
    evidenceId: `ev-capture-${index}`,
    evidenceVersion: 1,
    capturedAt: "2026-08-01T00:00:00.000Z",
    sourceType: "sellersprite_xlsx" as const,
    dedupeOf: null,
    factValues,
  };
}

function sampleSnapshot(sampleHash = SAMPLE_HASH, itemCount = 2) {
  return {
    schemaVersion: MARKET_SCAN_SAMPLE_SCHEMA,
    metricsVersion: "market-metrics.v1",
    itemCount,
    sampleHash,
    items: Array.from({ length: itemCount }, (_, index) => sampleItem(index)),
  };
}

function coverage(presentCount: number, sampleCount: number) {
  return {
    presentCount,
    missingCount: sampleCount - presentCount,
    coverageRatio: sampleCount === 0 ? 0 : presentCount / sampleCount,
  };
}

function metrics(sampleHash = SAMPLE_HASH, sampleCount = 2) {
  const notAvailable = <T,>() => ({
    status: "NOT_AVAILABLE" as const,
    value: null as T | null,
    sampleSize: 0,
    missingCount: sampleCount,
    calculationVersion: "market-metrics.v1",
  });
  return {
    schemaVersion: "market-metrics.v1" as const,
    metricsVersion: "market-metrics.v1",
    sampleHash,
    sampleCount,
    validSampleCount: sampleCount,
    fieldCoverage: {
      price: coverage(sampleCount, sampleCount),
      sales: coverage(0, sampleCount),
      revenue: coverage(0, sampleCount),
      brand: coverage(0, sampleCount),
      rating: coverage(0, sampleCount),
      reviewCount: coverage(0, sampleCount),
      bsr: coverage(0, sampleCount),
      launchedDate: coverage(0, sampleCount),
    },
    price: {
      status: "PRESENT" as const,
      value: {
        min: 19.99,
        max: 19.99,
        mean: 19.99,
        median: 19.99,
        p25: 19.99,
        p75: 19.99,
        sampleSize: sampleCount,
        missingCount: 0,
      },
      sampleSize: sampleCount,
      missingCount: 0,
      calculationVersion: "market-metrics.v1",
    },
    sales: notAvailable<unknown>(),
    revenue: notAvailable<unknown>(),
    salesConcentration: {
      cr3: notAvailable<unknown>(),
      cr5: notAvailable<unknown>(),
      cr10: notAvailable<unknown>(),
    },
    brandConcentration: {
      brandCr3: notAvailable<unknown>(),
      brandCr5: notAvailable<unknown>(),
      uniqueBrandCount: notAvailable<unknown>(),
      missingBrandCount: sampleCount,
    },
    rating: {
      averageRating: notAvailable<unknown>(),
      medianRating: notAvailable<unknown>(),
    },
    reviews: {
      averageReviewCount: notAvailable<unknown>(),
      medianReviewCount: notAvailable<unknown>(),
      topReviewThreshold: notAvailable<unknown>(),
    },
    newEntrants: {
      referenceDate: "2026-08-02T00:00:00.000Z",
      newProductCount30d: notAvailable<unknown>(),
      newProductCount90d: notAvailable<unknown>(),
      newProductShare90d: notAvailable<unknown>(),
      newProductSalesShare90d: notAvailable<unknown>(),
    },
    evidenceWindow: {
      earliestCapturedAt: "2026-08-01T00:00:00.000Z",
      latestCapturedAt: "2026-08-01T00:00:00.000Z",
      recordedObservedAt: null,
      observedAtSource: "evidence_captured_at" as const,
      marketplace: "US",
    },
    notes: ["test fixture"],
  };
}

function createInput(overrides: Partial<MarketScanCreateInput> = {}): MarketScanCreateInput {
  return {
    scanName: "水杯市场扫描 A",
    marketplace: "US",
    nicheKind: "custom_sample",
    nicheDefinition: niche(),
    sampleDefinition: sampleDefinition(),
    sampleSnapshot: sampleSnapshot(),
    metrics: metrics(),
    ...overrides,
  } as MarketScanCreateInput;
}

beforeEach(() => {
  const created = createMigratedSqliteDatabase();
  root = created.root;
  databasePath = created.databasePath;
  client = new PrismaClient({ datasources: { db: { url: fileDatabaseUrl(databasePath) } } });
  repository = createMarketScanRepository(client);
});

afterEach(async () => {
  await client.$disconnect();
  cleanupMigratedSqliteDatabase(root);
});

describe("MarketScan persistence", () => {
  it("creates and reads back a scan with locked sample snapshot and metrics", async () => {
    const created = await repository.create(createInput());
    expect(created.id).toBeTruthy();
    expect(created.scanName).toBe("水杯市场扫描 A");
    expect(created.sampleCount).toBe(2);
    expect(created.metricsVersion).toBe("market-metrics.v1");
    expect(created.sampleHash).toBe(SAMPLE_HASH);
    expect(created.sampleSnapshot.items[0].factValues.price.presence).toBe("present");

    const read = await repository.getById(created.id);
    expect(read).not.toBeNull();
    expect(read?.sampleHash).toBe(SAMPLE_HASH);
    expect(read?.sampleSnapshot.items.map((item) => item.asin))
      .toEqual(["B000000000", "B000000001"]);
    expect(read?.metrics.newEntrants.newProductCount30d.status).toBe("NOT_AVAILABLE");
    expect(read?.metrics.newEntrants.newProductCount30d.value).toBeNull();
  });

  it("lists scans newest first and never leaks another owner's rows", async () => {
    await repository.create(createInput({ scanName: "first" }));
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 5));
    await repository.create(createInput({ scanName: "second" }));
    const database = openSqlite(databasePath);
    try {
      database.prepare(`
        INSERT INTO "MarketScan" (
          "id","ownerScope","scanName","marketplace","nicheKind",
          "nicheDefinitionJson","sampleDefinitionJson","sampleSnapshotJson",
          "metricsJson","sampleCount","metricsVersion","sampleHash"
        ) VALUES ('foreign','owner:other','other','US','custom_sample',
          ?,?,?,?,2,'market-metrics.v1',?)
      `).run(
        JSON.stringify(niche()),
        JSON.stringify(sampleDefinition()),
        JSON.stringify(sampleSnapshot()),
        JSON.stringify(metrics()),
        SAMPLE_HASH,
      );
    } finally {
      database.close();
    }
    const listed = await repository.list();
    expect(listed.map((item) => item.scanName)).toEqual(["second", "first"]);
    expect(await repository.getById("foreign")).toBeNull();
  });

  it("fails closed on invalid or corrupted JSON and never returns a half-written record", async () => {
    const created = await repository.create(createInput());
    const database = openSqlite(databasePath);
    try {
      // 数据库层已经拦住非法 JSON 与非本版 schemaVersion：
      // 非法内容根本进不去，所以这里断言的是「写不进」，而不是「读不出」。
      expect(() => database.prepare(`UPDATE "MarketScan" SET "metricsJson" = 'not json' WHERE "id" = ?`)
        .run(created.id)).toThrow();
      expect(() => database.prepare(
        `UPDATE "MarketScan" SET "metricsJson" = ? WHERE "id" = ?`,
      ).run(
        JSON.stringify({ schemaVersion: "market-metrics.v9", metricsVersion: "market-metrics.v1" }),
        created.id,
      )).toThrow();
      // 缺 required key 的 JSON 壳也必须被数据库约束拒绝，不能依赖 CHECK(NULL)
      // 的 SQLite 三值逻辑把坏记录放进去。
      expect(() => database.prepare(
        `UPDATE "MarketScan" SET "metricsJson" = ? WHERE "id" = ?`,
      ).run(
        JSON.stringify({ schemaVersion: "market-metrics.v1", metricsVersion: "market-metrics.v1" }),
        created.id,
      )).toThrow();
    } finally {
      database.close();
    }
    // SQLite 拒绝了所有非法更新，因此原始完整记录仍可正常读取。
    await expect(repository.getById(created.id)).resolves.toMatchObject({ id: created.id });
  });

  it("rejects a snapshot whose metrics disagree on hash, version or count", async () => {
    await expect(repository.create(createInput({
      metrics: metrics("d".repeat(64)),
    } as Partial<MarketScanCreateInput>))).rejects.toBeInstanceOf(MarketScanContractError);

    await expect(repository.create(createInput({
      metrics: { ...metrics(), metricsVersion: "market-metrics.v2", schemaVersion: "market-metrics.v1" },
    } as Partial<MarketScanCreateInput>))).rejects.toBeInstanceOf(MarketScanContractError);

    await expect(repository.create(createInput({
      sampleSnapshot: sampleSnapshot(SAMPLE_HASH, 1),
    } as Partial<MarketScanCreateInput>))).rejects.toBeInstanceOf(MarketScanContractError);
  });

  it("rejects a scan whose nicheKind contradicts the niche definition", async () => {
    await expect(repository.create(createInput({
      nicheKind: "keyword",
    }))).rejects.toBeInstanceOf(MarketScanContractError);
  });

  it("enforces the database-level guards (hash length, sampleCount, metricsVersion consistency)", async () => {
    const created = await repository.create(createInput());
    const database = openSqlite(databasePath);
    try {
      // 直接绕过应用层写库，验证 CHECK 约束真的在数据库边界生效。
      expect(() => database.prepare(
        `UPDATE "MarketScan" SET "sampleHash" = 'short' WHERE "id" = ?`,
      ).run(created.id)).toThrow();
      expect(() => database.prepare(
        `UPDATE "MarketScan" SET "sampleCount" = 0 WHERE "id" = ?`,
      ).run(created.id)).toThrow();
      expect(() => database.prepare(
        `UPDATE "MarketScan" SET "metricsVersion" = 'market-metrics.v9' WHERE "id" = ?`,
      ).run(created.id)).toThrow();
      expect(() => database.prepare(
        `UPDATE "MarketScan" SET "nicheKind" = 'market_scan' WHERE "id" = ?`,
      ).run(created.id)).toThrow();
      // JSON 内容与列不一致也必须被拒。
      expect(() => database.prepare(
        `UPDATE "MarketScan" SET "sampleSnapshotJson" = '{"schemaVersion":"market-scan-sample.v1"}' WHERE "id" = ?`,
      ).run(created.id)).toThrow();
    } finally {
      database.close();
    }
  });

  it("rejects every required JSON key when it is missing", async () => {
    const created = await repository.create(createInput());
    const database = openSqlite(databasePath);
    try {
      const cases: Array<{ column: string; json: Record<string, unknown> }> = [
        ...["schemaVersion", "metricsVersion", "sampleHash", "sampleCount"].map((key) => {
          const json = JSON.parse(JSON.stringify(metrics())) as Record<string, unknown>;
          delete json[key];
          return { column: "metricsJson", json };
        }),
        ...["schemaVersion", "kind"].map((key) => {
          const json = JSON.parse(JSON.stringify(niche())) as Record<string, unknown>;
          delete json[key];
          return { column: "nicheDefinitionJson", json };
        }),
        ...["schemaVersion", "marketplace"].map((key) => {
          const json = JSON.parse(JSON.stringify(sampleDefinition())) as Record<string, unknown>;
          delete json[key];
          return { column: "sampleDefinitionJson", json };
        }),
        ...["schemaVersion", "metricsVersion", "sampleHash", "itemCount"].map((key) => {
          const json = JSON.parse(JSON.stringify(sampleSnapshot())) as Record<string, unknown>;
          delete json[key];
          return { column: "sampleSnapshotJson", json };
        }),
      ];

      for (const testCase of cases) {
        expect(() => database.prepare(
          `UPDATE "MarketScan" SET "${testCase.column}" = ? WHERE "id" = ?`,
        ).run(JSON.stringify(testCase.json), created.id)).toThrow();
      }

      const nullCases: Array<{ column: string; json: Record<string, unknown> }> = [
        ...["schemaVersion", "metricsVersion", "sampleHash", "sampleCount"].map((key) => ({
          column: "metricsJson",
          json: { ...metrics(), [key]: null },
        })),
        ...["schemaVersion", "kind"].map((key) => ({
          column: "nicheDefinitionJson",
          json: { ...niche(), [key]: null },
        })),
        ...["schemaVersion", "marketplace"].map((key) => ({
          column: "sampleDefinitionJson",
          json: { ...sampleDefinition(), [key]: null },
        })),
        ...["schemaVersion", "metricsVersion", "sampleHash", "itemCount"].map((key) => ({
          column: "sampleSnapshotJson",
          json: { ...sampleSnapshot(), [key]: null },
        })),
      ];

      for (const testCase of nullCases) {
        expect(() => database.prepare(
          `UPDATE "MarketScan" SET "${testCase.column}" = ? WHERE "id" = ?`,
        ).run(JSON.stringify(testCase.json), created.id)).toThrow();
      }
    } finally {
      database.close();
    }
  });

  it("keeps history intact: an older metricsVersion row is never silently rewritten", async () => {
    const created = await repository.create(createInput());
    const database = openSqlite(databasePath);
    try {
      const before = database.prepare(
        `SELECT "metricsJson", "metricsVersion" FROM "MarketScan" WHERE "id" = ?`,
      ).get(created.id);
      // 模拟算法升版：另一条新扫描使用 v2，历史行必须保持原样（v1 的 metricsJson 与版本号都不变）。
      await repository.create(createInput({
        metrics: { ...metrics(), metricsVersion: "market-metrics.v2" },
        sampleSnapshot: { ...sampleSnapshot(), metricsVersion: "market-metrics.v2" },
      } as Partial<MarketScanCreateInput>));
      const after = database.prepare(
        `SELECT "metricsJson", "metricsVersion" FROM "MarketScan" WHERE "id" = ?`,
      ).get(created.id);
      expect(after).toEqual(before);
      expect(after?.metricsVersion).toBe("market-metrics.v1");
      expect(JSON.parse(String(after?.metricsJson)).metricsVersion).toBe("market-metrics.v1");
      expect(database.prepare(
        `SELECT COUNT(*) AS "count" FROM "MarketScan"`,
      ).get()?.count).toBe(2);
    } finally {
      database.close();
    }
  });

  it("leaves every pre-existing table untouched", async () => {
    const database = openSqlite(databasePath);
    try {
      const tables = database.prepare(
        `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' ORDER BY "name"`,
      ).all().map((row) => String(row.name));
      expect(tables).toEqual(expect.arrayContaining([
        "ListingCopyHistory",
        "ViralAnalysisRecord",
        "OpportunityCandidate",
        "ProductBatch",
        "ProductBatchItem",
        "ProductDiscoverySelection",
        "V4ResearchRun",
        "V4FactRecord",
        "MarketScan",
      ]));
      // 本阶段新增的表有且只有 MarketScan：任何其它 Market* / Opportunity* 新表都算越界。
      expect(tables.filter((name) => name.startsWith("Market"))).toEqual(["MarketScan"]);
      expect(tables).not.toEqual(expect.arrayContaining([
        "NicheOpportunity",
        "MarketSample",
        "RepresentativeSet",
        "ProductConcept",
        "OpportunityScore",
      ]));
    } finally {
      database.close();
    }
  });
});
