import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessContext } from "@/lib/server/accessPassword";
import type { ProductBatchItemView, ProductBatchView } from "@/lib/productBatchStore";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const batchState = vi.hoisted(() => ({
  batch: null as unknown,
  items: [] as unknown[],
  bridgeItemIds: [] as string[],
}));

vi.mock("@/lib/server/productBatchStoreResolver", () => ({
  getProductBatchStore: () => ({
    getSelection: async () => ({ activeProductBatchId: "batch-1" }),
    getBatch: async () => batchState.batch,
    getBatchItems: async () => batchState.items,
  }),
}));

vi.mock("@/lib/productBatchImagePresentation", () => ({
  readProductBatchItemImageSnapshot: (json: string) => {
    const parsed = JSON.parse(json) as { status?: string };
    if (parsed.status !== "cached") return null;
    return {
      dataUrl: `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`,
      mimeType: "image/png",
      contentHash: "a".repeat(64),
      provenance: "product_batch_snapshot",
    };
  },
}));

import {
  SourceLayerServiceError,
  captureFromProductBatch,
  extractProductBatchFactFields,
  listSourceEvidence,
} from "@/lib/sourceLayer/server/sourceLayerService";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";

const ownerContext: AccessContext = { mode: "owner", token: "" };
const CAPTURED_AT = "2026-02-01T00:00:00.000Z";

/** 与 buildItems 落库形状一致的 providerMetrics 表（键为字段名）。 */
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

function batchItem(overrides: {
  id: string;
  asin: string | null;
  metrics?: Record<string, unknown>;
  imageStatus?: "cached" | "not_cached";
}): ProductBatchItemView {
  return {
    id: overrides.id,
    batchId: "batch-1",
    createdAt: CAPTURED_AT,
    ordinal: 0,
    productKey: `amazon:US:${overrides.asin ?? overrides.id}`,
    asin: overrides.asin,
    parentAsin: null,
    itemIdentityHash: "b".repeat(64),
    itemHash: "c".repeat(64),
    evidenceHash: "d".repeat(64),
    normalizedProductJson: JSON.stringify({
      asin: overrides.asin,
      providerMetrics: providerMetrics(overrides.metrics ?? {}),
    }),
    occurrenceProjectionJson: "{}",
    familyProjectionJson: "{}",
    rankingJson: "{}",
    provisionalDisposition: "provisional_score_only",
    researchPriority: "priority_1",
    evidenceStatus: "sufficient_for_comparison",
    promotionEligible: false,
    imageSnapshotJson: overrides.imageStatus === "cached"
      ? JSON.stringify({ status: "cached", mimeType: "image/png", sizeBytes: 68, sha256: "a".repeat(64), base64: ONE_PIXEL_PNG_BASE64 })
      : JSON.stringify({ status: "not_cached" }),
  } as ProductBatchItemView;
}

function batch(): ProductBatchView {
  return {
    id: "batch-1",
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

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "source-layer-bridge-"));
  process.env.SOURCE_LAYER_STORE_DIR = join(tempRoot, "store");
  batchState.batch = batch();
  batchState.items = [
    batchItem({
      id: "item-pass",
      asin: "B0FH1ZXTN1",
      imageStatus: "cached",
      metrics: {
        productTitle: "Owala FreeSip Insulated Stainless Steel Water Bottle with Straw, 24 oz",
        productUrl: "https://www.amazon.com/dp/B0FH1ZXTN1",
        price: 29.99,
        rating: 4.6,
        reviews: 2948,
        rootCategory: "Sports & Outdoors",
        rootCategoryBsr: 120,
        brand: "Owala",
      },
    }),
    batchItem({
      id: "item-missing",
      asin: "B0SRC00002",
      imageStatus: "not_cached",
      metrics: {
        productTitle: "Incomplete Export Row Without Price Or Rating",
        productUrl: null,
        price: null,
        rating: null,
        reviews: null,
        rootCategory: null,
        rootCategoryBsr: null,
      },
    }),
    batchItem({ id: "item-no-asin", asin: null, metrics: {} }),
  ];
  batchState.bridgeItemIds = [];
});

afterEach(() => {
  delete process.env.SOURCE_LAYER_STORE_DIR;
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

describe("extractProductBatchFactFields", () => {
  it("reads only available provider metrics and never invents values", () => {
    const parsed = JSON.parse(
      JSON.stringify({
        asin: "B0FH1ZXTN1",
        providerMetrics: providerMetrics({
          productTitle: "Owala FreeSip Insulated Stainless Steel Water Bottle with Straw, 24 oz",
          productUrl: "https://www.amazon.com/dp/B0FH1ZXTN1",
          price: 29.99,
          rating: 4.6,
          reviews: 2948,
          rootCategory: "Sports & Outdoors",
          rootCategoryBsr: 120,
          brand: "Owala",
        }),
      }),
    ) as { toString?: unknown };
    const facts = extractProductBatchFactFields(JSON.stringify(parsed));
    expect(facts.title).toContain("Owala");
    expect(facts.price).toBe(29.99);
    expect(facts.rating).toBe(4.6);
    expect(facts.reviewCount).toBe(2948);
    expect(facts.bsr).toEqual({ rank: 120, category: "Sports & Outdoors" });
    expect(facts.brand).toBe("Owala");
  });

  it("fails closed on missing metrics, malformed JSON and out-of-range values", () => {
    expect(extractProductBatchFactFields("not json")).toEqual({
      title: null,
      price: null,
      rating: null,
      reviewCount: null,
      bsr: null,
      brand: null,
      productUrl: null,
      estimatedMonthlySales: null,
      estimatedMonthlyRevenueUsd: null,
    });
    expect(extractProductBatchFactFields("{}")).toEqual({
      title: null,
      price: null,
      rating: null,
      reviewCount: null,
      bsr: null,
      brand: null,
      productUrl: null,
      estimatedMonthlySales: null,
      estimatedMonthlyRevenueUsd: null,
    });
    const outOfRange = extractProductBatchFactFields(JSON.stringify({
      providerMetrics: providerMetrics({
        price: 9_999_999,
        rating: 9.9,
        reviews: -5,
        rootCategoryBsr: 0,
        estimatedMonthlySales: -1,
        estimatedMonthlyRevenue: 9_999_999_999,
      }),
    }));
    expect(outOfRange.price).toBeNull();
    expect(outOfRange.rating).toBeNull();
    expect(outOfRange.reviewCount).toBeNull();
    expect(outOfRange.bsr).toBeNull();
    // 第三方估算字段同样 fail-closed：越界保持 null，绝不截断成 0 或上限值。
    expect(outOfRange.estimatedMonthlySales).toBeNull();
    expect(outOfRange.estimatedMonthlyRevenueUsd).toBeNull();
  });

  it("reads the persisted provider estimate columns the batch already stores", () => {
    const facts = extractProductBatchFactFields(JSON.stringify({
      providerMetrics: providerMetrics({
        estimatedMonthlySales: 26065,
        estimatedMonthlyRevenue: 369862.5,
        brand: "Owala",
      }),
    }));
    expect(facts.estimatedMonthlySales).toBe(26065);
    expect(facts.estimatedMonthlyRevenueUsd).toBe(369862.5);
    expect(facts.brand).toBe("Owala");
  });
});

describe("captureFromProductBatch", () => {
  it("bridges ready batch items into the unified evidence store without touching the batch", async () => {
    const before = JSON.stringify(batchState.items);
    const result = await captureFromProductBatch({ context: ownerContext });

    expect(result.productBatchId).toBe("batch-1");
    expect(result.requestedItemIds).toEqual(["item-pass", "item-missing", "item-no-asin"]);
    // 没有 ASIN 的条目被显式跳过，不伪造主体
    expect(result.skippedItemIds).toEqual(["item-no-asin"]);
    expect(result.items.map((item) => item.subjectKey)).toEqual([
      "amazon:US:B0FH1ZXTN1",
      "amazon:US:B0SRC00002",
    ]);
    // 批次本身未被修改
    expect(JSON.stringify(batchState.items)).toBe(before);
  });

  it("carries the original export fingerprint and evidence-only provenance", async () => {
    const result = await captureFromProductBatch({ context: ownerContext });
    const store = createEvidenceStore("owner:v1");
    const subject = await store.getSubject("amazon:US:B0FH1ZXTN1");
    const latest = subject?.versions.at(-1);
    expect(latest?.sourceType).toBe("sellersprite_xlsx");
    expect(latest?.pkg.sourceProof.sourceFingerprint).toBe("f".repeat(64));
    expect(latest?.pkg.sourceProof.sourceRecordRef).toBe("item-pass");
    expect(latest?.pkg.sourceProof.captureMethod).toBe("xlsx_export");
    expect(latest?.factAuthority).toBe("evidence_only");
    expect(latest?.pkg.fields.price).toEqual({ amount: 29.99, currency: "USD" });
    // 批次只缓存一张主图：这是真实状态，被如实标记为风险而不是补图
    expect(result.items[0].riskFlags).toContain("image_single");
    expect(result.items[0].state).toBe("READY_FOR_RESEARCH");
  });

  it("runs the same lifecycle and audit chain as a fresh capture", async () => {
    const result = await captureFromProductBatch({ context: ownerContext });
    const transitions = result.items[0].auditTail
      .map((entry) => entry.nextState)
      .filter((state): state is string => state !== null);
    expect(transitions).toContain("SOURCE_CHECKING");
    expect(transitions).toContain("CAPTURE_RUNNING");
    expect(transitions).toContain("NORMALIZING");
    expect(transitions).toContain("EVIDENCE_VALIDATING");
    expect(transitions).toContain("READY_FOR_RESEARCH");
    for (const entry of result.items[0].auditTail) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(Number.isFinite(Date.parse(entry.timestamp))).toBe(true);
    }
    // 审计写入证据库，刷新后可回放
    const store = createEvidenceStore("owner:v1");
    const audit = await store.getAudit("amazon:US:B0FH1ZXTN1");
    expect(audit.some((entry) => entry.eventKind === "validation_result")).toBe(true);
    expect(audit.some((entry) => entry.detail.bridgedFromProductBatchId === "batch-1")).toBe(true);
  });

  it("never fabricates missing export columns: they stay missing and are reported", async () => {
    const result = await captureFromProductBatch({ context: ownerContext });
    const incomplete = result.items.find((item) => item.subjectKey === "amazon:US:B0SRC00002");
    expect(incomplete).toBeDefined();
    expect(incomplete?.title).toBe("Incomplete Export Row Without Price Or Rating");
    expect(incomplete?.price).toBeNull();
    expect(incomplete?.rating).toBeNull();
    expect(incomplete?.reviewCount).toBeNull();
    expect(incomplete?.bsr).toBeNull();
    expect(incomplete?.imageCount).toBe(0);
    expect(incomplete?.readyForResearch).toBe(false);
    expect(incomplete?.issues.map((issue) => issue.code)).toContain("FIELD_MISSING");
    expect(incomplete?.riskFlags).toContain("image_missing");
  });

  it("re-capturing the same batch item records a new event without creating a semantic version", async () => {
    await captureFromProductBatch({ context: ownerContext, productBatchItemId: "item-pass" });
    const second = await captureFromProductBatch({
      context: ownerContext,
      productBatchItemId: "item-pass",
      now: new Date("2026-02-02T00:00:00.000Z"),
    });
    expect(second.items[0].version).toBe(1);
    expect(second.items[0].duplicate).toBe(true);
    const store = createEvidenceStore("owner:v1");
    const subject = await store.getSubject("amazon:US:B0FH1ZXTN1");
    expect(subject?.versions.map((item) => item.version)).toEqual([1]);
  });

  it("keeps bridged evidence isolated per access subject", async () => {
    await captureFromProductBatch({ context: ownerContext, productBatchItemId: "item-pass" });
    const visitorLedger = await listSourceEvidence({
      mode: "demo",
      token: "",
      demoAccessId: "visitor-bridge",
      isActive: true,
      isExpired: false,
      remainingAiCalls: 50,
    });
    expect(visitorLedger.subjects).toEqual([]);
  });

  it("fails closed when the requested item is not in the active batch", async () => {
    await expect(captureFromProductBatch({
      context: ownerContext,
      productBatchItemId: "item-does-not-exist",
    })).rejects.toBeInstanceOf(SourceLayerServiceError);
  });

  it("refuses to bridge when no batch is active", async () => {
    batchState.batch = { ...batch(), batchStatus: "processing" };
    await expect(captureFromProductBatch({ context: ownerContext }))
      .rejects.toMatchObject({ code: "candidate_not_ready" });
  });
});
