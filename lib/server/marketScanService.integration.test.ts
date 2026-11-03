/**
 * Product Development V1 — Phase 1 端到端集成测试。
 *
 * 真实链路（全部真实实现，只把「商品批次存储」替换为内存桩）：
 *
 * ```
 * ProductBatch（内存桩，真实 providerMetrics 形状）
 *   → captureFromProductBatch（真实：写 Evidence 版本台账 + 审计）
 *   → adaptEvidenceToProductFact（真实纯函数）
 *   → projectProductFactsFromEvidence（只读投影）
 *   → MarketScan 编组 + 事实版本锁定
 *   → 确定性指标
 *   → 一次写入 MarketScan（真实 SQLite + 真实 migration）
 * ```
 *
 * 断言重点：
 * - MarketScan 读到的价格 / 销量 / 销售额 / 品牌是真实来源事实，不是 0 也不是伪造；
 * - 缺失字段保持缺失（不用 0 顶替）；
 * - Candidate 数、Task 数、Research 记录数在扫描前后完全不变（零业务副作用）。
 */

import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessContext } from "@/lib/server/accessPassword";
import type { ProductBatchItemView, ProductBatchView } from "@/lib/productBatchStore";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const batchState = vi.hoisted(() => ({
  batch: null as unknown,
  items: [] as unknown[],
  activeBatchId: "batch-phase1",
  batches: new Map<string, unknown>(),
  itemsByBatch: new Map<string, unknown[]>(),
}));

vi.mock("@/lib/server/productBatchStoreResolver", () => ({
  getProductBatchStore: () => ({
    getSelection: async () => ({ activeProductBatchId: batchState.activeBatchId }),
    getBatch: async (batchId: string) => batchState.batches.get(batchId)
      ?? ((batchState.batch as { id?: string } | null)?.id === batchId ? batchState.batch : null),
    getBatchItems: async (batchId: string) => batchState.itemsByBatch.get(batchId)
      ?? ((batchState.batch as { id?: string } | null)?.id === batchId ? batchState.items : []),
  }),
}));

vi.mock("@/lib/productBatchImagePresentation", () => ({
  readProductBatchItemImageSnapshot: () => ({ dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }),
}));

import { adaptEvidenceToProductFact } from "@/lib/sourceLayer/fact/productFactAdapter";
import { marketFactValuesOf } from "@/lib/marketScan/productFactSource";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { captureFromProductBatch } from "@/lib/sourceLayer/server/sourceLayerService";
import { createMarketScan as createMarketScanService, listMarketScans } from "@/lib/server/marketScanService";
import { createMarketScanRepository } from "@/lib/server/marketScanRepository";
import {
  cleanupMigratedSqliteDatabase,
  createMigratedSqliteDatabase,
  fileDatabaseUrl,
  openSqlite,
} from "@/lib/marketScan/__fixtures__/testDatabase";

const createMarketScan: typeof createMarketScanService = (input, repository) => createMarketScanService({ ...input, insufficientSampleReason: "disposable historical MarketScan contract fixture" }, repository);

const ownerContext: AccessContext = { mode: "owner", token: "" };
const CAPTURED_AT = "2026-08-01T00:00:00.000Z";

function providerMetrics(fields: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(fields).map(([fieldName, normalized]) => [
      fieldName,
      {
        raw: normalized === null ? null : String(normalized),
        normalized,
        source: "SellerSprite",
        sourceType: "provider_metric",
        capturedAt: CAPTURED_AT,
        metricNature: "snapshot",
        applicability: normalized === null ? "missing" : "available",
      },
    ]),
  );
}

function batchItem(input: {
  id: string;
  asin: string;
  fields: Record<string, unknown>;
  batchId?: string;
}): ProductBatchItemView {
  return {
    id: input.id,
    batchId: input.batchId ?? "batch-phase1",
    createdAt: CAPTURED_AT,
    ordinal: 0,
    productKey: `amazon:US:${input.asin}`,
    asin: input.asin,
    parentAsin: null,
    itemIdentityHash: "b".repeat(64),
    itemHash: "c".repeat(64),
    evidenceHash: "d".repeat(64),
    normalizedProductJson: JSON.stringify({
      asin: input.asin,
      providerMetrics: providerMetrics(input.fields),
    }),
    occurrenceProjectionJson: "{}",
    familyProjectionJson: "{}",
    rankingJson: "{}",
    provisionalDisposition: "provisional_score_only",
    researchPriority: "priority_1",
    evidenceStatus: "sufficient_for_comparison",
    promotionEligible: false,
    imageSnapshotJson: JSON.stringify({ status: "not_cached" }),
  } as ProductBatchItemView;
}

function batch(id = "batch-phase1"): ProductBatchView {
  return {
    id,
    batchName: "Sports & Outdoors · water bottle",
    marketplace: "US",
    currency: "USD",
    reportType: "search_results",
    query: "water bottle",
    category: "Sports & Outdoors",
    priceMinCents: null,
    priceMaxCents: null,
    briefHash: "e".repeat(64),
    sourceFileName: "sellersprite-export.xlsx",
    sourceFileSha256: "f".repeat(64),
    normalizedBusinessHash: "1".repeat(64),
    snapshotHash: "2".repeat(64),
    manifestHash: "3".repeat(64),
    itemCount: 3,
    acceptedCount: 3,
    quarantinedCount: 0,
    dataQualityStatus: "passed",
    batchStatus: "ready",
    sellerSpriteDisclaimerVersion: "sellersprite-v1-frozen.2026-07-27",
    normalizedSnapshotJson: "{}",
    manifestJson: "{}",
    qualitySummaryJson: "{}",
    errorJson: null,
    dedupeKey: "g".repeat(64),
    importedAt: CAPTURED_AT,
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
  } as ProductBatchView;
}

let tempRoot = "";
let databaseRoot = "";
let databasePath = "";
let client: PrismaClient;

function seedLegacyBusinessRows(): void {
  const database = openSqlite(databasePath);
  try {
    database.prepare(`
      INSERT INTO "OpportunityCandidate" ("id","name","updatedAt")
      VALUES ('candidate-seed','既有候选','2026-08-01T00:00:00.000Z')
    `).run();
    database.prepare(`
      INSERT INTO "ViralAnalysisRecord" (
        "id","updatedAt","platform","materialText","source","score","level","oneLineSummary","resultJson"
      ) VALUES ('task-seed','2026-08-01T00:00:00.000Z','amazon','既有任务','manual',1,'pending','既有总结','{}')
    `).run();
  } finally {
    database.close();
  }
}

function businessRowCounts(): Record<string, number> {
  const database = openSqlite(databasePath);
  try {
    return {
      candidate: Number(database.prepare(
        `SELECT COUNT(*) AS "count" FROM "OpportunityCandidate"`,
      ).get()?.count),
      task: Number(database.prepare(
        `SELECT COUNT(*) AS "count" FROM "ViralAnalysisRecord"`,
      ).get()?.count),
      researchRun: Number(database.prepare(
        `SELECT COUNT(*) AS "count" FROM "V4ResearchRun"`,
      ).get()?.count),
      productBatch: Number(database.prepare(
        `SELECT COUNT(*) AS "count" FROM "ProductBatch"`,
      ).get()?.count),
      marketScan: Number(database.prepare(
        `SELECT COUNT(*) AS "count" FROM "MarketScan"`,
      ).get()?.count),
    };
  } finally {
    database.close();
  }
}

beforeEach(() => {
  vi.stubEnv("V5_MARKET_ALLOW_INSUFFICIENT_SAMPLE", "true");
  tempRoot = mkdtempSync(join(tmpdir(), "market-scan-e2e-store-"));
  process.env.SOURCE_LAYER_STORE_DIR = join(tempRoot, "store");
  const created = createMigratedSqliteDatabase();
  databaseRoot = created.root;
  databasePath = created.databasePath;
  client = new PrismaClient({ datasources: { db: { url: fileDatabaseUrl(databasePath) } } });
  seedLegacyBusinessRows();
  batchState.batch = batch();
  batchState.activeBatchId = "batch-phase1";
  batchState.batches.clear();
  batchState.itemsByBatch.clear();
  batchState.items = [
    batchItem({
      id: "item-owala",
      asin: "B0FH1ZXTN1",
      fields: {
        productTitle: "Owala FreeSip Insulated Stainless Steel Water Bottle, 24 oz",
        brand: "Owala",
        price: 29.99,
        rating: 4.6,
        reviews: 2948,
        rootCategory: "Sports & Outdoors",
        rootCategoryBsr: 120,
        estimatedMonthlySales: 26065,
        estimatedMonthlyRevenue: 369862.5,
        productUrl: "https://www.amazon.com/dp/B0FH1ZXTN1",
      },
    }),
    batchItem({
      id: "item-hydro",
      // ASIN 必须是 10 位：11 位的 "B0HYDRO0002" 会被身份解析拒绝，样本会被显式跳过。
      asin: "B0HYDRO002",
      fields: {
        productTitle: "Hydro Flask Wide Mouth Bottle 32 oz",
        brand: "Hydro Flask",
        price: 44.95,
        rating: 4.8,
        reviews: 15832,
        rootCategory: "Sports & Outdoors",
        rootCategoryBsr: 45,
        estimatedMonthlySales: 18240,
        estimatedMonthlyRevenue: 819888,
        productUrl: "https://www.amazon.com/dp/B0HYDRO002",
      },
    }),
    batchItem({
      id: "item-incomplete",
      asin: "B0INCOMPL3",
      fields: {
        productTitle: "Incomplete Export Row Without Price Or Rating",
        brand: null,
        price: null,
        rating: null,
        reviews: null,
        rootCategory: null,
        rootCategoryBsr: null,
        estimatedMonthlySales: null,
        estimatedMonthlyRevenue: null,
        productUrl: null,
      },
    }),
    batchItem({
      id: "item-manual",
      asin: "B0MANUAL01",
      fields: {
        productTitle: "Manual Bridged Water Bottle",
        brand: "ManualBrand",
        price: 12.5,
        rating: 4.2,
        reviews: 214,
        rootCategory: "Sports & Outdoors",
        rootCategoryBsr: 640,
        estimatedMonthlySales: 1500,
        estimatedMonthlyRevenue: 18750,
        productUrl: "https://www.amazon.com/dp/B0MANUAL01",
      },
    }),
  ];
  void ONE_PIXEL_PNG_BASE64;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await client.$disconnect();
  delete process.env.SOURCE_LAYER_STORE_DIR;
  rmSync(tempRoot, { recursive: true, force: true });
  cleanupMigratedSqliteDatabase(databaseRoot);
});

describe("ProductBatch → Evidence → ProductFact → MarketScan", () => {
  it("computes deterministic metrics from real ProductFacts with zero business side effects", async () => {
    const before = businessRowCounts();

    const bridged = await captureFromProductBatch({ context: ownerContext });
    expect(bridged.items.map((item) => item.subjectKey)).toEqual([
      "amazon:US:B0FH1ZXTN1",
      "amazon:US:B0HYDRO002",
      "amazon:US:B0INCOMPL3",
      "amazon:US:B0MANUAL01",
    ]);

    const repository = createMarketScanRepository(client);
    const scan = await createMarketScan({
      context: ownerContext,
      scanName: "水杯市场扫描 · 真实样本",
      marketplace: "US",
      nicheKind: "sellersprite_filter",
      nicheLabel: "Sports & Outdoors · water bottle",
      nicheNotes: "Phase 1 真实验收样本",
      nicheParameters: { query: "water bottle", reportType: "search_results" },
      productBatchId: "batch-phase1",
      observedAt: CAPTURED_AT,
      now: new Date("2026-08-02T00:00:00.000Z"),
    }, repository);

    expect(scan.sampleCount).toBe(3);
    expect(scan.sampleSnapshot.items.map((item) => item.asin)).toEqual([
      "B0FH1ZXTN1",
      "B0HYDRO002",
      "B0MANUAL01",
    ]);
    // 版本锁定字段全部落到快照里。
    for (const item of scan.sampleSnapshot.items) {
      expect(item.evidenceVersion).toBe(1);
      expect(item.subjectKey).toBe(`amazon:US:${item.asin}`);
      expect(item.sourceProofHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(item.productFactFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(item.capturedAt).toBeTruthy();
      expect(item.candidateId).toBeNull();
    }

    // P5: blocked incomplete evidence is excluded; 3 bound prices retain the same median.
    expect(scan.metrics.sampleCount).toBe(3);
    expect(scan.metrics.fieldCoverage.price.presentCount).toBe(3);
    expect(scan.metrics.fieldCoverage.price.missingCount).toBe(0);
    expect(scan.metrics.price.status).toBe("PRESENT");
    expect(scan.metrics.price.value?.sampleSize).toBe(3);
    expect(scan.metrics.price.value?.min).toBe(12.5);
    expect(scan.metrics.price.value?.max).toBe(44.95);
    expect(scan.metrics.price.value?.median).toBe(29.99);

    // 销量：真实第三方估算，不是补零。
    expect(scan.metrics.fieldCoverage.sales.presentCount).toBe(3);
    expect(scan.metrics.sales.status).toBe("PRESENT");
    expect(scan.metrics.sales.value?.total).toBe(26065 + 18240 + 1500);

    // 销售额：真实来源字段（PROVIDER_ESTIMATE），status 仍为 PRESENT（有来源数据）。
    expect(scan.metrics.fieldCoverage.revenue.presentCount).toBe(3);
    expect(scan.metrics.revenue.status).toBe("PRESENT");
    expect(scan.metrics.revenue.value?.total).toBeCloseTo(369862.5 + 819888 + 18750, 4);

    // 品牌：部分缺失必须显式暴露，且不得落入兜底品牌。
    expect(scan.metrics.fieldCoverage.brand.presentCount).toBe(3);
    expect(scan.metrics.brandConcentration.missingBrandCount).toBe(0);
    expect(scan.metrics.brandConcentration.uniqueBrandCount.value).toBe(3);
    expect(scan.metrics.brandConcentration.uniqueBrandCount.sampleSize).toBe(3);
    // 缺失品牌的商品绝不进入任何品牌桶：
    const brandKeys = scan.metrics.brandConcentration.brandCr3.value?.topN.map((item) => item.key) ?? [];
    expect(brandKeys.every((key) => key === "Owala" || key === "Hydro Flask" || key === "ManualBrand"))
      .toBe(true);

    // 评分 / 评论：有来源数据。
    expect(scan.metrics.rating.averageRating.status).toBe("PRESENT");
    expect(scan.metrics.reviews.medianReviewCount.status).toBe("PRESENT");

    // 上架时间：XLSX / ProductBatch 链路结构性不可得 → NOT_AVAILABLE，绝不猜。
    expect(scan.metrics.fieldCoverage.launchedDate.presentCount).toBe(0);
    expect(scan.metrics.newEntrants.newProductCount30d.status).toBe("NOT_AVAILABLE");
    expect(scan.metrics.newEntrants.newProductCount30d.value).toBeNull();

    // 观测窗口如实记录调用方给出的 observedAt。
    expect(scan.metrics.evidenceWindow.observedAtSource).toBe("caller_recorded");
    expect(scan.metrics.evidenceWindow.recordedObservedAt).toBe(CAPTURED_AT);

    // 逐条样本的事实值快照：缺失保持 missing，存在带 valueSource。
    expect(scan.sampleSnapshot.items.some((item) => item.asin === "B0INCOMPL3")).toBe(false);
    const originalIncomplete = (await createEvidenceStore("owner:v1").getSubject("amazon:US:B0INCOMPL3"))!.versions[0]!;
    expect(originalIncomplete.validation.verdict).toBe("blocked");
    const incomplete = { factValues: marketFactValuesOf(adaptEvidenceToProductFact({ evidence: originalIncomplete })) };
    expect(incomplete?.factValues.price.presence).toBe("missing");
    expect(incomplete?.factValues.brand.presence).toBe("missing");
    expect(incomplete?.factValues.monthlySalesEstimate.presence).toBe("missing");
    const owala = scan.sampleSnapshot.items.find((item) => item.asin === "B0FH1ZXTN1");
    expect(owala?.factValues.monthlySalesEstimate).toEqual({
      presence: "present",
      value: 26065,
      valueSource: "PROVIDER_ESTIMATE",
    });
    expect(owala?.factValues.price).toEqual({
      presence: "present",
      value: { amount: 29.99, currency: "USD" },
      valueSource: "FACT",
    });

    // 读回后完全一致（刷新恢复）。
    const reread = await repository.getById(scan.id);
    expect(reread?.sampleHash).toBe(scan.sampleHash);
    expect(JSON.stringify(reread?.metrics)).toBe(JSON.stringify(scan.metrics));

    // 零业务副作用：Candidate / Task / Research / ProductBatch 计数不变，只多了 MarketScan。
    const after = businessRowCounts();
    expect(after).toEqual({ ...before, marketScan: before.marketScan + 1 });
    expect(after.candidate).toBe(1);
    expect(after.task).toBe(1);
    expect(after.researchRun).toBe(0);
    expect(after.productBatch).toBe(0);

    const listed = await listMarketScans({ context: ownerContext }, repository);
    expect(listed.map((item) => item.id)).toEqual([scan.id]);
  });

  it("is reproducible: the same evidence yields the same sampleHash and metrics, with a different scan id", async () => {
    await captureFromProductBatch({ context: ownerContext });
    const repository = createMarketScanRepository(client);
    const input = {
      context: ownerContext,
      scanName: "可重复性验证",
      marketplace: "US",
      nicheKind: "custom_sample" as const,
      nicheLabel: "water bottle",
      now: new Date("2026-08-02T00:00:00.000Z"),
    };
    const first = await createMarketScan(input, repository);
    const second = await createMarketScan(input, repository);
    expect(first.id).not.toBe(second.id);
    expect(first.sampleHash).toBe(second.sampleHash);
    expect(JSON.stringify(first.metrics)).toBe(JSON.stringify(second.metrics));
  });

  it("uses ProductBatch item provenance instead of the latest owner Evidence for the same ASIN", async () => {
    const batchA = batch("batch-a");
    const batchB = batch("batch-b");
    const itemA = batchItem({
      id: "batch-item-a",
      batchId: "batch-a",
      asin: "B0BATC0001",
      fields: {
        productTitle: "Batch A product",
        brand: "BatchA",
        price: 10,
        rating: 4,
        reviews: 10,
        rootCategory: "Sports & Outdoors",
        rootCategoryBsr: 100,
        estimatedMonthlySales: 100,
        estimatedMonthlyRevenue: 1000,
        productUrl: "https://www.amazon.com/dp/B0BATC0001",
      },
    });
    const itemB = batchItem({
      id: "batch-item-b",
      batchId: "batch-b",
      asin: "B0BATC0001",
      fields: {
        productTitle: "Batch B product",
        brand: "BatchB",
        price: 99,
        rating: 4,
        reviews: 99,
        rootCategory: "Sports & Outdoors",
        rootCategoryBsr: 200,
        estimatedMonthlySales: 999,
        estimatedMonthlyRevenue: 98901,
        productUrl: "https://www.amazon.com/dp/B0BATC0001",
      },
    });
    batchState.batches.set(batchA.id, batchA);
    batchState.batches.set(batchB.id, batchB);
    batchState.itemsByBatch.set(batchA.id, [itemA]);
    batchState.itemsByBatch.set(batchB.id, [itemB]);

    batchState.batch = batchA;
    batchState.items = [itemA];
    batchState.activeBatchId = batchA.id;
    await captureFromProductBatch({ context: ownerContext, now: new Date("2026-08-01T00:00:00.000Z") });

    batchState.batch = batchB;
    batchState.items = [itemB];
    batchState.activeBatchId = batchB.id;
    await captureFromProductBatch({ context: ownerContext, now: new Date("2026-08-02T00:00:00.000Z") });

    const scan = await createMarketScan({
      context: ownerContext,
      scanName: "Batch A provenance scope",
      marketplace: "US",
      nicheKind: "custom_sample",
      nicheLabel: "batch-a",
      productBatchId: batchA.id,
      now: new Date("2026-08-03T00:00:00.000Z"),
    }, createMarketScanRepository(client));

    expect(scan.sampleDefinition.productBatchId).toBe(batchA.id);
    expect(scan.sampleSnapshot.items).toHaveLength(1);
    expect(scan.sampleSnapshot.items[0].subjectKey).toBe("amazon:US:B0BATC0001");
    expect(scan.sampleSnapshot.items[0].evidenceVersion).toBe(1);
    expect(scan.metrics.price.value?.median).toBe(10);
    expect(scan.metrics.brandConcentration.uniqueBrandCount.value).toBe(1);
  });

  it("fails closed when there is no existing evidence to scan", async () => {
    const repository = createMarketScanRepository(client);
    await expect(createMarketScan({
      context: ownerContext,
      scanName: "空样本扫描",
      marketplace: "US",
      nicheKind: "custom_sample",
      nicheLabel: "empty",
    }, repository)).rejects.toMatchObject({ code: "market_scan_source_empty" });
    expect(businessRowCounts().marketScan).toBe(0);
  });

  it("refuses visitor access without touching owner data", async () => {
    await captureFromProductBatch({ context: ownerContext });
    const repository = createMarketScanRepository(client);
    await expect(createMarketScan({
      context: {
        mode: "demo",
        token: "",
        demoAccessId: "visitor-phase1",
        isActive: true,
        isExpired: false,
        remainingAiCalls: 50,
      },
      scanName: "访客扫描",
      marketplace: "US",
      nicheKind: "custom_sample",
      nicheLabel: "visitor",
    }, repository)).rejects.toMatchObject({ code: "market_scan_owner_only" });
    expect(businessRowCounts().marketScan).toBe(0);
  });
});
