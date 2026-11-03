/**
 * 只读 ProductFact projection adapter 测试。
 *
 * 断言：投影只读、缺失保持缺失、第三方估算被如实标注、版本锁定元数据正确、
 * Evidence 版本不存在时不会静默回落到其它版本。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  asinFromSubjectKey,
  marketFactValuesOf,
  marketplaceFromSubjectKey,
  projectProductFactsFromEvidence,
  toMarketScanSampleInput,
} from "@/lib/marketScan/productFactSource";
import { projectMarketFactValuesV1 } from "@/lib/marketScan/metrics";
import { makeProductFact } from "@/lib/marketScan/__fixtures__/productFactFixture";
import { captureThroughGateway } from "@/lib/sourceLayer/server/captureGateway";
import type { AccessContext } from "@/lib/server/accessPassword";

const ownerContext: AccessContext = { mode: "owner", token: "" };
const ASIN = "B0MANUAL01";
const SUBJECT_KEY = `amazon:US:${ASIN}`;
let tempRoot = "";

const MANUAL_PAYLOAD = {
  asin: ASIN,
  title: "Manual Entry Water Bottle",
  brand: "ManualBrand",
  price: 12.5,
  currency: "USD",
  rating: 4.1,
  reviewCount: 120,
  bsrRank: 900,
  bsrCategory: "Sports & Outdoors",
  estimatedMonthlySales: 300,
  estimatedMonthlyRevenueUsd: 3750,
};

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "market-scan-projection-"));
  process.env.SOURCE_LAYER_STORE_DIR = join(tempRoot, "store");
});

afterEach(() => {
  delete process.env.SOURCE_LAYER_STORE_DIR;
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("subject key helpers", () => {
  it("parses only the frozen amazon subject key convention", () => {
    expect(asinFromSubjectKey("amazon:US:B0FH1ZXTN1")).toBe("B0FH1ZXTN1");
    expect(asinFromSubjectKey("amazon:US:b0fh1zxtn1")).toBe("B0FH1ZXTN1");
    expect(asinFromSubjectKey("amazon:US:TOO-SHORT")).toBeNull();
    expect(asinFromSubjectKey("manual:81ada31911fc")).toBeNull();
    expect(marketplaceFromSubjectKey("amazon:DE:B0FH1ZXTN1")).toBe("DE");
    expect(marketplaceFromSubjectKey("nonsense")).toBeNull();
  });
});

describe("projectProductFactsFromEvidence", () => {
  it("returns an empty projection when nothing has been captured yet", async () => {
    expect(await projectProductFactsFromEvidence({ operator: "owner:v1" })).toEqual([]);
  });

  it("projects existing evidence without writing anything", async () => {
    await captureThroughGateway({
      context: ownerContext,
      source: "manual",
      payload: MANUAL_PAYLOAD,
      now: new Date("2026-08-01T00:00:00.000Z"),
    });

    const first = await projectProductFactsFromEvidence({ operator: "owner:v1" });
    expect(first).toHaveLength(1);
    expect(first[0].asin).toBe(ASIN);
    expect(first[0].evidenceVersion).toBe(1);
    expect(first[0].sourceType).toBe("manual");
    expect(first[0].sourceProofHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first[0].productFact.schema).toBe("product-fact.v3");

    // 再投影一次结果完全一致（纯读，不产生新版本）。
    const second = await projectProductFactsFromEvidence({ operator: "owner:v1" });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("keeps missing fields missing and marks provider estimates as estimates", async () => {
    await captureThroughGateway({
      context: ownerContext,
      source: "manual",
      payload: { ...MANUAL_PAYLOAD, rating: null, reviewCount: null, bsrRank: null, brand: null },
      now: new Date("2026-08-01T00:00:00.000Z"),
    });
    const [projection] = await projectProductFactsFromEvidence({ operator: "owner:v1" });
    const [sample] = toMarketScanSampleInput([projection]);
    const values = sample.factValues;
    expect(values).toBeDefined();
    expect(values?.rating.presence).toBe("missing");
    expect(values?.reviewCount.presence).toBe("missing");
    expect(values?.bsr.presence).toBe("missing");
    expect(values?.brand.presence).toBe("missing");
    expect(values?.price.presence).toBe("present");
    expect(values?.monthlySalesEstimate).toEqual({
      presence: "present",
      value: 300,
      valueSource: "PROVIDER_ESTIMATE",
    });
    expect(values?.monthlyRevenueEstimate).toEqual({
      presence: "present",
      value: { amount: 3750, currency: "USD" },
      valueSource: "PROVIDER_ESTIMATE",
    });
    // 缺失字段绝不用 0 表示。
    expect(JSON.stringify(values)).not.toContain("\"value\":0");
  });

  it("honours an explicit evidence version and never falls back when it is gone", async () => {
    const base = {
      context: ownerContext,
      source: "manual" as const,
    };
    // 内容不同（价格变化）才会产生新的 Evidence 版本，而不是复用同一版本。
    await captureThroughGateway({
      ...base,
      payload: { ...MANUAL_PAYLOAD, price: 12.5 },
      now: new Date("2026-08-01T00:00:00.000Z"),
    });
    await captureThroughGateway({
      ...base,
      payload: { ...MANUAL_PAYLOAD, price: 15.75 },
      now: new Date("2026-08-03T00:00:00.000Z"),
    });
    const latest = await projectProductFactsFromEvidence({ operator: "owner:v1" });
    expect(latest).toHaveLength(1);
    expect(latest[0].evidenceVersion).toBe(2);

    const pinnedV1 = await projectProductFactsFromEvidence({
      operator: "owner:v1",
      evidenceVersions: { [SUBJECT_KEY]: 1 },
    });
    expect(pinnedV1).toHaveLength(1);
    expect(pinnedV1[0].evidenceVersion).toBe(1);
    expect(pinnedV1[0].sourceProofHash).not.toBe(latest[0].sourceProofHash);
    expect(latest[0].productFact.basic.price.value?.amount).toBe(15.75);
    expect(pinnedV1[0].productFact.basic.price.value?.amount).toBe(12.5);

    // 指定一个不存在的版本 → 该主体被丢弃（fail-closed），不回落到最新版本。
    const gone = await projectProductFactsFromEvidence({
      operator: "owner:v1",
      evidenceVersions: { [SUBJECT_KEY]: 99 },
    });
    expect(gone).toEqual([]);
  });

  it("treats incomplete money structures as missing instead of inventing a value", () => {
    // 真实证据里存在这些非法金额结构：`{ amount: 0 }`、`{ currency: "USD" }`（amount 键缺失）。
    // 它们必须 fail-closed 为 missing：0 不能被当成「价格为 0」，缺 amount 也不能补 0。
    const base = {
      schema: "product-fact.v3" as const,
      subjectKey: SUBJECT_KEY,
      sourceProof: {
        source: "manual" as const,
        captureId: "capture-1",
        evidenceId: "ev-1",
        subjectKey: SUBJECT_KEY,
        capturedAt: "2026-08-01T00:00:00.000Z",
        contentHash: "a".repeat(64),
        sourceUrl: null,
        operator: "owner:v1",
      },
      basic: {
        asin: { value: ASIN, status: "present" as const, source: "manual" as const, confidence: 1, capturedAt: null, rawProofHash: null },
        title: { value: "T", status: "present" as const, source: "manual" as const, confidence: 1, capturedAt: null, rawProofHash: null },
        image: { value: null, status: "missing" as const, source: "manual" as const, confidence: 0, capturedAt: null, rawProofHash: null },
        brand: { value: null, status: "missing" as const, source: "manual" as const, confidence: 0, capturedAt: null, rawProofHash: null },
        category: { value: null, status: "missing" as const, source: "manual" as const, confidence: 0, capturedAt: null, rawProofHash: null },
        price: { value: { amount: 0, currency: "USD" }, status: "present" as const, source: "manual" as const, confidence: 1, capturedAt: null, rawProofHash: null },
        rating: { value: null, status: "missing" as const, source: "manual" as const, confidence: 0, capturedAt: null, rawProofHash: null },
        reviewCount: { value: null, status: "missing" as const, source: "manual" as const, confidence: 0, capturedAt: null, rawProofHash: null },
        bulletPoints: { value: null, status: "missing" as const, source: "manual" as const, confidence: 0, capturedAt: null, rawProofHash: null },
      },
      market: {
        bsr: { value: null, status: "missing" as const, source: "manual" as const, confidence: 0, capturedAt: null, rawProofHash: null },
        monthlySalesEstimate: { value: null, status: "missing" as const, source: "manual" as const, confidence: 0, capturedAt: null, rawProofHash: null },
        monthlyRevenueEstimate: {
          value: { currency: "USD" } as unknown as { amount: number; currency: string },
          status: "present" as const,
          source: "manual" as const,
          confidence: 1,
          capturedAt: null,
          rawProofHash: null,
        },
        launchedDate: { value: null, status: "missing" as const, source: "manual" as const, confidence: 0, capturedAt: null, rawProofHash: null },
      },
      profit: {
        packageWeight: { value: null, status: "missing" as const, source: "manual" as const, confidence: 0, capturedAt: null, rawProofHash: null },
        packageDimensions: { value: null, status: "missing" as const, source: "manual" as const, confidence: 0, capturedAt: null, rawProofHash: null },
        fbaFee: { value: null, status: "missing" as const, source: "manual" as const, confidence: 0, capturedAt: null, rawProofHash: null },
      },
    };
    const values = marketFactValuesOf(base);
    expect(values.price).toEqual({ presence: "missing", valueSource: "FACT" });
    expect(values.monthlyRevenueEstimate).toEqual({
      presence: "missing",
      valueSource: "PROVIDER_ESTIMATE",
    });
    // 快照里绝不出现 0 金额或半截金额结构。
    expect(JSON.stringify(values)).not.toContain("\"amount\":0");
  });

  it.each([
    { amount: 0, currency: "USD" },
    { amount: -1, currency: "USD" },
    { amount: Number.NaN, currency: "USD" },
    { amount: 10 },
    { currency: "USD" },
    { amount: 10, currency: "usd" },
    { amount: 10, currency: "" },
  ])("applies the same money rule in ProductFact and metrics fallback projection %#", (invalid) => {
    const base = makeProductFact();
    const fact = {
      ...base,
      basic: {
        ...base.basic,
        price: { ...base.basic.price, value: invalid as never },
      },
      market: {
        ...base.market,
        monthlyRevenueEstimate: { ...base.market.monthlyRevenueEstimate, value: invalid as never },
      },
    };

    const sourceProjection = marketFactValuesOf(fact);
    const metricsFallbackProjection = projectMarketFactValuesV1(fact);
    expect(sourceProjection.price).toEqual(metricsFallbackProjection.price);
    expect(sourceProjection.monthlyRevenueEstimate).toEqual(metricsFallbackProjection.monthlyRevenueEstimate);
    expect(sourceProjection.price.presence).toBe("missing");
    expect(sourceProjection.monthlyRevenueEstimate.presence).toBe("missing");
  });

  it("keeps evidence isolated per access subject", async () => {
    await captureThroughGateway({
      context: ownerContext,
      source: "manual",
      payload: MANUAL_PAYLOAD,
      now: new Date("2026-08-01T00:00:00.000Z"),
    });
    expect(await projectProductFactsFromEvidence({ operator: "visitor-other" })).toEqual([]);
  });
});
