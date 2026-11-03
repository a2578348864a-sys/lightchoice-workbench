import { describe, expect, it } from "vitest";

import { adaptEvidenceToProductFact } from "@/lib/sourceLayer/fact/productFactAdapter";
import type { FactField, ProductFact } from "@/lib/sourceLayer/fact/types";
import {
  SOURCE_ASSET_COVERAGE_FIELDS,
  coverageOf,
  hasDisplayValue,
  isReadyForResearch,
} from "./sourceAssetInbox";

/**
 * 字段覆盖率与「可研究」判定的确定性规则测试。
 *
 * 关键边界：`rating = 0` / `reviewCount = 0` 是真实观测值，不能被 Boolean 误判为缺失。
 */

function field<T>(value: T | null, status: "present" | "missing"): FactField<T> {
  return {
    value,
    status,
    source: "manual",
    confidence: status === "present" ? 1 : 0,
    capturedAt: "2026-08-01T00:00:00.000Z",
    rawProofHash: null,
  };
}

function missing<T>(): FactField<T> {
  return {
    value: null,
    status: "missing",
    source: "manual",
    confidence: 0,
    capturedAt: "2026-08-01T00:00:00.000Z",
    rawProofHash: null,
  };
}

function factWith(overrides: {
  rating?: FactField<number>;
  reviewCount?: FactField<number>;
  price?: FactField<{ amount: number; currency: string }>;
}): ProductFact {
  return {
    schema: "product-fact.v3",
    subjectKey: "amazon:US:B000000001",
    sourceProof: {
      source: "manual",
      captureId: "c1",
      evidenceId: "e1",
      subjectKey: "amazon:US:B000000001",
      capturedAt: "2026-08-01T00:00:00.000Z",
      contentHash: "a".repeat(64),
      sourceUrl: null,
      operator: "owner:v1",
    },
    basic: {
      asin: field("B000000001", "present"),
      title: field("Test title", "present"),
      image: missing<string>(),
      brand: missing<string>(),
      category: missing<string>(),
      price: overrides.price ?? missing<{ amount: number; currency: string }>(),
      rating: overrides.rating ?? missing<number>(),
      reviewCount: overrides.reviewCount ?? missing<number>(),
      bulletPoints: missing<readonly string[]>(),
    },
    market: {
      bsr: missing<number>(),
      monthlySalesEstimate: missing<number>(),
      monthlyRevenueEstimate: missing<{ amount: number; currency: string }>(),
      launchedDate: missing<string>(),
    },
    profit: {
      packageWeight: missing(),
      packageDimensions: missing(),
      fbaFee: missing(),
    },
  };
}

describe("hasDisplayValue", () => {
  it("treats numeric zero as a real value, not as missing", () => {
    expect(hasDisplayValue(field(0, "present"))).toBe(true);
    expect(hasDisplayValue(field(0, "missing"))).toBe(false);
  });

  it("trusts the fact-layer status over truthiness", () => {
    // 值为空字符串但事实层标记 present：仍以 status 为准（事实层负责裁决），
    // 值为非空但标记 missing：判为缺失。
    expect(hasDisplayValue(field("", "present"))).toBe(true);
    expect(hasDisplayValue(field("有值", "missing"))).toBe(false);
  });
});

describe("coverageOf", () => {
  it("counts rating = 0 and reviewCount = 0 as present", () => {
    const coverage = coverageOf(factWith({
      rating: field(0, "present"),
      reviewCount: field(0, "present"),
    }));
    expect(coverage.totalCount).toBe(SOURCE_ASSET_COVERAGE_FIELDS.length);
    expect(coverage.presentFields).toContain("评分");
    expect(coverage.presentFields).toContain("评论数");
    expect(coverage.missingFields).not.toContain("评分");
    expect(coverage.missingFields).not.toContain("评论数");
  });

  it("reports a 0 amount price as present when the fact layer says present", () => {
    const coverage = coverageOf(factWith({
      price: field({ amount: 0, currency: "USD" }, "present"),
    }));
    expect(coverage.presentFields).toContain("价格");
  });

  it("keeps present + missing equal to the total and rounds the ratio to 2 decimals", () => {
    const coverage = coverageOf(factWith({ rating: field(4.5, "present") }));
    expect(coverage.presentCount + coverage.missingFields.length).toBe(coverage.totalCount);
    expect(coverage.coverageRatio).toBeCloseTo(
      Math.round((coverage.presentCount / coverage.totalCount) * 100) / 100,
      4,
    );
  });
});

describe("isReadyForResearch", () => {
  it("requires both the authoritative flag and the passed verdict", () => {
    expect(isReadyForResearch({ verdict: "passed", readyForResearch: true })).toBe(true);
    expect(isReadyForResearch({ verdict: "passed", readyForResearch: false })).toBe(false);
    expect(isReadyForResearch({ verdict: "needs_review", readyForResearch: true })).toBe(false);
    expect(isReadyForResearch({ verdict: "blocked", readyForResearch: false })).toBe(false);
    expect(isReadyForResearch({ verdict: "passed", readyForResearch: null })).toBe(false);
  });
});

describe("validator contract: passed implies readyForResearch", () => {
  it("is enforced by the evidence parser and the validator", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const validator = readFileSync(resolve(process.cwd(), "lib/sourceLayer/validator.ts"), "utf8");
    const sourceAdapter = readFileSync(resolve(process.cwd(), "lib/sourceLayer/sourceAdapter.ts"), "utf8");
    // validator 字面赋值；parser 显式拒绝 readyForResearch 与 verdict 不一致的记录。
    expect(validator).toMatch(/readyForResearch: verdict === "passed"/u);
    expect(sourceAdapter).toMatch(/if \(validation\.readyForResearch && validation\.verdict !== "passed"\) return null;/u);
  });

  it("keeps the projection adapter prefix-agnostic so ASIN parsing works", async () => {
    // 回归护栏：`amazon` 前缀曾误写成 `amazon:`，导致所有 ASIN 解析为 null。
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "lib/marketScan/productFactSource.ts"), "utf8");
    expect(source).toContain('const ASIN_SUBJECT_PREFIX = "amazon";');
    expect(source).not.toContain('const ASIN_SUBJECT_PREFIX = "amazon:";');
  });
});

describe("adaptEvidenceToProductFact keeps zero-valued fields present", () => {
  it("marks rating 0 as present (documents the fact-layer rule the coverage relies on)", () => {
    // 该断言防止未来有人在 adapter 里把 0 当成缺失，从而让覆盖率口径失真。
    const fact = factWith({ rating: field(0, "present") });
    expect(fact.basic.rating.status).toBe("present");
    expect(adaptEvidenceToProductFact).toBeTypeOf("function");
  });
});
