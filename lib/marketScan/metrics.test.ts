/**
 * MarketScan 指标引擎契约测试：缺失绝不补零、集中度分母显式、确定性可重算。
 */

import { describe, expect, it } from "vitest";

import { computeMarketMetricsV1, projectMarketFactValuesV1 } from "@/lib/marketScan/metrics";
import {
  MARKET_METRICS_SCHEMA,
  MARKET_METRICS_VERSION,
  type MarketMetricsV1,
  type MarketScanSampleInputV1,
} from "@/lib/marketScan/types";
import {
  FIXTURE_CAPTURED_AT,
  FIXTURE_REFERENCE_DATE,
  fixtureAsinAt,
  fixtureFactValues,
  makeProductFact,
  makeSampleInput,
  makeSampleSeries,
  type ProductFactFixtureOptions,
} from "@/lib/marketScan/__fixtures__/productFactFixture";

/* ── 测试工具 ─────────────────────────────────────────────────── */

type AnyMetric = {
  status: string;
  value: unknown;
  sampleSize: number;
  missingCount: number;
  calculationVersion: string;
};

function collectMetrics(node: unknown, found: AnyMetric[] = []): AnyMetric[] {
  if (Array.isArray(node)) {
    for (const child of node) collectMetrics(child, found);
    return found;
  }
  if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    const status = record.status;
    const calculationVersion = record.calculationVersion;
    if (typeof calculationVersion === "string" && typeof status === "string") {
      found.push({
        status,
        value: record.value,
        sampleSize: Number(record.sampleSize),
        missingCount: Number(record.missingCount),
        calculationVersion,
      });
      return found;
    }
    for (const child of Object.values(record)) collectMetrics(child, found);
  }
  return found;
}

function collectNumbers(node: unknown, found: number[] = []): number[] {
  if (typeof node === "number") {
    found.push(node);
    return found;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectNumbers(child, found);
    return found;
  }
  if (node !== null && typeof node === "object") {
    for (const child of Object.values(node)) collectNumbers(child, found);
  }
  return found;
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("expected a non-null value");
  return value;
}

/** 除显式给出的字段外，其余事实一律缺失，保证每个用例只测一个变量。 */
const NO_OTHER_FACTS: ProductFactFixtureOptions = {
  brand: null,
  rating: null,
  reviewCount: null,
  bsr: null,
  monthlySalesEstimate: null,
  monthlyRevenueEstimate: null,
  launchedDate: null,
};

function samplesWith(optionsList: readonly ProductFactFixtureOptions[]): MarketScanSampleInputV1[] {
  return optionsList.map((options, index) =>
    makeSampleInput({ ...NO_OTHER_FACTS, asin: fixtureAsinAt(index), ...options }),
  );
}

function metricsOf(
  sample: readonly MarketScanSampleInputV1[],
  referenceDate = FIXTURE_REFERENCE_DATE,
  metricsVersion?: string,
): MarketMetricsV1 {
  return computeMarketMetricsV1({ sample, referenceDate, metricsVersion });
}

/** 全量指标的统一结构不变式。 */
function expectMetricInvariants(result: MarketMetricsV1, calculationVersion: string): void {
  const metrics = collectMetrics(result);
  expect(metrics).toHaveLength(18);
  for (const metric of metrics) {
    expect(["PRESENT", "NOT_AVAILABLE", "INSUFFICIENT_DATA"]).toContain(metric.status);
    if (metric.status === "PRESENT") {
      expect(metric.value).not.toBeNull();
    } else {
      expect(metric.value).toBeNull();
    }
    expect(Number.isInteger(metric.sampleSize)).toBe(true);
    expect(Number.isInteger(metric.missingCount)).toBe(true);
    expect(metric.sampleSize).toBeGreaterThanOrEqual(0);
    expect(metric.missingCount).toBeGreaterThanOrEqual(0);
    expect(metric.sampleSize + metric.missingCount).toBe(result.sampleCount);
    expect(metric.calculationVersion).toBe(calculationVersion);
  }
  for (const value of collectNumbers(result)) {
    expect(Number.isFinite(value)).toBe(true);
  }
}

/* ── 数值分布 ─────────────────────────────────────────────────── */

describe("computeMarketMetricsV1 — 数值分布（price）", () => {
  it("mean / median / min / max 手算校验", () => {
    const result = metricsOf(samplesWith([{ price: 10 }, { price: 20 }, { price: 30 }, { price: 40 }]));
    const price = required(result.price.value);

    expect(result.price.status).toBe("PRESENT");
    expect(price.min).toBe(10);
    expect(price.max).toBe(40);
    expect(price.mean).toBe(25);
    expect(price.median).toBe(25);
    expect(price.sampleSize).toBe(4);
    expect(price.missingCount).toBe(0);
    expect(result.price.sampleSize).toBe(4);
    expect(result.price.missingCount).toBe(0);
  });

  it("分位数固定为 position = (n - 1) * p 的线性插值（n = 1 / 2 / 3 / 4 / 5）", () => {
    const one = required(metricsOf(samplesWith([{ price: 42 }])).price.value);
    expect([one.min, one.max, one.mean, one.median, one.p25, one.p75]).toEqual([
      42, 42, 42, 42, 42, 42,
    ]);

    const two = required(metricsOf(samplesWith([{ price: 10 }, { price: 20 }])).price.value);
    expect(two.mean).toBe(15);
    expect(two.median).toBe(15); // position 0.5 → 10 + (20-10)*0.5
    expect(two.p25).toBe(12.5); // position 0.25 → 10 + 10*0.25
    expect(two.p75).toBe(17.5); // position 0.75 → 10 + 10*0.75

    const three = required(
      metricsOf(samplesWith([{ price: 10 }, { price: 20 }, { price: 30 }])).price.value,
    );
    expect(three.median).toBe(20);
    expect(three.p25).toBe(15); // position 0.5
    expect(three.p75).toBe(25); // position 1.5

    const four = required(
      metricsOf(samplesWith([{ price: 1 }, { price: 2 }, { price: 3 }, { price: 4 }])).price.value,
    );
    expect(four.median).toBe(2.5); // position 1.5 → 2 + 0.5
    expect(four.p25).toBe(1.75); // position 0.75 → 1 + 0.75
    expect(four.p75).toBe(3.25); // position 2.25 → 3 + 0.25

    const five = required(
      metricsOf(
        samplesWith([{ price: 1 }, { price: 2 }, { price: 3 }, { price: 4 }, { price: 5 }]),
      ).price.value,
    );
    expect(five.median).toBe(3); // position 2 → 精确命中
    expect(five.p25).toBe(2);
    expect(five.p75).toBe(4);
  });

  it("输入顺序不影响任何统计量", () => {
    const sample = samplesWith([{ price: 10 }, { price: 20 }, { price: 30 }, { price: 40 }]);
    const forward = required(metricsOf(sample).price.value);
    const backward = required(metricsOf([...sample].reverse()).price.value);

    expect(backward).toEqual(forward);
  });
});

/* ── 空样本 / 单条 / 大批量 ───────────────────────────────────── */

describe("computeMarketMetricsV1 — 样本规模", () => {
  it("空样本：sampleCount = 0，全部指标 NOT_AVAILABLE 且 value === null（不是 0）", () => {
    const result = metricsOf([]);

    expect(result.sampleCount).toBe(0);
    expect(result.validSampleCount).toBe(0);
    expect(result.schemaVersion).toBe(MARKET_METRICS_SCHEMA);
    expectMetricInvariants(result, MARKET_METRICS_VERSION);

    for (const metric of collectMetrics(result)) {
      expect(metric.status).toBe("NOT_AVAILABLE");
      expect(metric.value).toBeNull();
    }
    expect(result.price.value).toBeNull();
    expect(result.sales.value).toBeNull();
    expect(result.revenue.value).toBeNull();
    expect(result.salesConcentration.cr3.value).toBeNull();
    expect(result.brandConcentration.uniqueBrandCount.value).toBeNull();
    expect(result.rating.averageRating.value).toBeNull();
    expect(result.reviews.topReviewThreshold.value).toBeNull();
    expect(result.newEntrants.newProductCount90d.value).toBeNull();
    expect(result.newEntrants.newProductSalesShare90d.value).toBeNull();

    for (const coverage of Object.values(result.fieldCoverage)) {
      expect(coverage.presentCount).toBe(0);
      expect(coverage.missingCount).toBe(0);
      expect(coverage.coverageRatio).toBe(0);
    }
  });

  it("1 条商品：单条可算的指标 PRESENT，Top N 类指标 INSUFFICIENT_DATA（value null）", () => {
    const result = metricsOf([
      makeSampleInput({
        asin: fixtureAsinAt(0),
        price: 25,
        monthlySalesEstimate: 100,
        monthlyRevenueEstimate: 2500,
        brand: "Alpha",
        rating: 4.2,
        reviewCount: 50,
        bsr: 800,
        launchedDate: "2024-06-01",
      }),
    ]);

    expect(result.sampleCount).toBe(1);
    expect(result.validSampleCount).toBe(1);
    expectMetricInvariants(result, MARKET_METRICS_VERSION);

    expect(required(result.price.value).median).toBe(25);
    expect(required(result.sales.value).total).toBe(100);
    const revenue = required(result.revenue.value);
    expect(revenue.total).toBe(2500);
    expect(revenue.currency).toBe("USD");
    expect(revenue.derivedFromSourceFacts).toBe(false);
    expect(revenue.derivedFromPriceTimesSales).toBeNull();

    expect(result.salesConcentration.cr3.status).toBe("INSUFFICIENT_DATA");
    expect(result.salesConcentration.cr3.value).toBeNull();
    expect(result.salesConcentration.cr3.sampleSize).toBe(1);
    expect(result.salesConcentration.cr5.status).toBe("INSUFFICIENT_DATA");
    expect(result.salesConcentration.cr10.status).toBe("INSUFFICIENT_DATA");
    expect(result.brandConcentration.brandCr3.status).toBe("INSUFFICIENT_DATA");
    expect(result.brandConcentration.missingBrandCount).toBe(0);
    expect(required(result.brandConcentration.uniqueBrandCount.value)).toBe(1);

    expect(required(result.rating.averageRating.value)).toBe(4.2);
    expect(required(result.rating.medianRating.value)).toBe(4.2);
    expect(required(result.reviews.averageReviewCount.value)).toBe(50);

    const topReview = required(result.reviews.topReviewThreshold.value);
    expect(topReview.topN).toBe(1); // max(1, ceil(1 * 0.2))
    expect(topReview.headSampleCount).toBe(1);
    expect(topReview.thresholdReviewCount).toBe(50);
    expect(topReview.headSalesShare).toBe(1); // 100 / 100
    expect(topReview.definition).toBe("top 20% by reviewCount desc, asin asc");

    // 参考日 2025-01-01，上架 2024-06-01（214 天）→ 真实计算出的 0，而不是缺失。
    expect(result.newEntrants.referenceDate).toBe(FIXTURE_REFERENCE_DATE);
    expect(required(result.newEntrants.newProductCount30d.value)).toBe(0);
    expect(required(result.newEntrants.newProductCount90d.value)).toBe(0);
    expect(required(result.newEntrants.newProductShare90d.value)).toBe(0);
    // 没有新品了，就不知道「新品销量占比」→ NOT_AVAILABLE，绝不用 0 顶替。
    expect(result.newEntrants.newProductSalesShare90d.status).toBe("NOT_AVAILABLE");
    expect(result.newEntrants.newProductSalesShare90d.value).toBeNull();

    for (const coverage of Object.values(result.fieldCoverage)) {
      expect(coverage.presentCount).toBe(1);
      expect(coverage.missingCount).toBe(0);
      expect(coverage.coverageRatio).toBe(1);
    }
  });

  it("100 条商品：覆盖率 / 集中度分母 / Top 20% 评论阈值手算校验", () => {
    const result = metricsOf(
      makeSampleSeries(100, (index) => ({
        price: 10 + index,
        monthlySalesEstimate: 100 + index,
        monthlyRevenueEstimate: (10 + index) * (100 + index),
        brand: `Brand-${index % 10}`,
        rating: 4 + (index % 10) / 10,
        reviewCount: index + 1,
        bsr: 5000 - index,
        launchedDate: "2024-06-01",
      })),
    );

    expect(result.sampleCount).toBe(100);
    expect(result.validSampleCount).toBe(100);
    expectMetricInvariants(result, MARKET_METRICS_VERSION);

    // 覆盖率：全部字段都有值。
    expect(result.fieldCoverage.price.presentCount).toBe(100);
    expect(result.fieldCoverage.price.missingCount).toBe(0);
    expect(result.fieldCoverage.price.coverageRatio).toBe(1);
    expect(result.fieldCoverage.launchedDate.coverageRatio).toBe(1);

    // price：10..109
    const price = required(result.price.value);
    expect(price.min).toBe(10);
    expect(price.max).toBe(109);
    expect(price.mean).toBeCloseTo(59.5, 10);
    expect(price.median).toBeCloseTo(59.5, 10);
    expect(price.p25).toBeCloseTo(34.75, 10); // position 24.75 → 34 + 0.75
    expect(price.p75).toBeCloseTo(84.25, 10); // position 74.25 → 84 + 0.25

    // sales：100..199，总和 = (100 + 199) * 100 / 2
    const sales = required(result.sales.value);
    expect(sales.total).toBe(14950);
    expect(sales.min).toBe(100);
    expect(sales.max).toBe(199);
    expect(sales.mean).toBeCloseTo(149.5, 10);
    expect(sales.median).toBeCloseTo(149.5, 10);
    expect(sales.distribution.sampleSize).toBe(100);

    // 销量集中度：Top 3 = 199 + 198 + 197
    const cr3 = required(result.salesConcentration.cr3.value);
    expect(cr3.denominator).toBe(14950);
    expect(cr3.usedSampleCount).toBe(100);
    expect(cr3.missingCount).toBe(0);
    expect(cr3.topN).toHaveLength(3);
    expect(cr3.topN.map((entry) => entry.key)).toEqual([
      fixtureAsinAt(99),
      fixtureAsinAt(98),
      fixtureAsinAt(97),
    ]);
    expect(cr3.topN.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    expect(cr3.ratio).toBeCloseTo(594 / 14950, 10);

    const cr5 = required(result.salesConcentration.cr5.value);
    expect(cr5.topN).toHaveLength(5);
    expect(cr5.ratio).toBeCloseTo(985 / 14950, 10); // 199+198+197+196+195

    const cr10 = required(result.salesConcentration.cr10.value);
    expect(cr10.topN).toHaveLength(10);
    expect(cr10.ratio).toBeCloseTo(1945 / 14950, 10); // 199..190

    // 品牌集中度：品牌 = index % 10，Brand-9 拿到 index 9/19/.../99，销量 109..199
    const brandCr3 = required(result.brandConcentration.brandCr3.value);
    expect(brandCr3.denominator).toBe(14950);
    expect(brandCr3.usedSampleCount).toBe(100);
    expect(brandCr3.topN.map((entry) => entry.key)).toEqual(["Brand-9", "Brand-8", "Brand-7"]);
    expect(brandCr3.topN.map((entry) => entry.value)).toEqual([1540, 1530, 1520]);
    expect(brandCr3.ratio).toBeCloseTo((1540 + 1530 + 1520) / 14950, 10);
    expect(required(result.brandConcentration.uniqueBrandCount.value)).toBe(10);
    expect(result.brandConcentration.missingBrandCount).toBe(0);

    // reviews：N = ceil(100 * 0.2) = 20，取 reviewCount 100..81（即 index 99..80）
    const topReview = required(result.reviews.topReviewThreshold.value);
    expect(topReview.topN).toBe(20);
    expect(topReview.headSampleCount).toBe(20);
    expect(topReview.thresholdReviewCount).toBe(81);
    expect(topReview.headSalesShare).toBeCloseTo(3790 / 14950, 10); // 199..180
  });
});

/* ── 缺失行为（绝不补零） ─────────────────────────────────────── */

describe("computeMarketMetricsV1 — 缺失行为", () => {
  it("price 全部缺失 → NOT_AVAILABLE，覆盖率 presentCount = 0", () => {
    const result = metricsOf(samplesWith([{ price: null }, { price: null }, { price: null }]));

    expect(result.price.status).toBe("NOT_AVAILABLE");
    expect(result.price.value).toBeNull();
    expect(result.price.sampleSize).toBe(0);
    expect(result.price.missingCount).toBe(3);
    expect(result.fieldCoverage.price.presentCount).toBe(0);
    expect(result.fieldCoverage.price.missingCount).toBe(3);
    expect(result.fieldCoverage.price.coverageRatio).toBe(0);
    expectMetricInvariants(result, MARKET_METRICS_VERSION);
  });

  it("sales 全部缺失 → NOT_AVAILABLE 且不补零；来源 revenue 事实仍然独立成立", () => {
    const result = metricsOf(
      samplesWith([
        { monthlySalesEstimate: null, monthlyRevenueEstimate: 1000 },
        { monthlySalesEstimate: null, monthlyRevenueEstimate: 2000 },
      ]),
    );

    expect(result.sales.status).toBe("NOT_AVAILABLE");
    expect(result.sales.value).toBeNull(); // 不是 0
    expect(result.sales.sampleSize).toBe(0);
    expect(result.sales.missingCount).toBe(2);
    expect(result.fieldCoverage.sales.presentCount).toBe(0);

    // revenue 只认来源事实，不受 sales 缺失影响。
    expect(result.revenue.status).toBe("PRESENT");
    expect(required(result.revenue.value).total).toBe(3000);
    expect(result.fieldCoverage.revenue.presentCount).toBe(2);

    // 没有已知销量 → 集中度 NOT_AVAILABLE，绝不假装份额。
    expect(result.salesConcentration.cr3.status).toBe("NOT_AVAILABLE");
    expect(result.salesConcentration.cr3.value).toBeNull();
    expect(result.notes.some((note) => note.includes("2 of 2 sample items"))).toBe(true);
  });

  it("brand 部分缺失：missingBrandCount 正确，且不存在任何兜底品牌", () => {
    const result = metricsOf(
      samplesWith([
        { brand: "Alpha", monthlySalesEstimate: 100 },
        { brand: "Alpha", monthlySalesEstimate: 50 },
        { brand: "Beta", monthlySalesEstimate: 80 },
        { brand: null, monthlySalesEstimate: 500 },
      ]),
    );

    expect(result.brandConcentration.missingBrandCount).toBe(1);
    expect(result.fieldCoverage.brand.presentCount).toBe(3);
    expect(result.fieldCoverage.brand.missingCount).toBe(1);
    expect(result.fieldCoverage.brand.coverageRatio).toBe(0.75);
    expect(required(result.brandConcentration.uniqueBrandCount.value)).toBe(2);
    expect(result.brandConcentration.uniqueBrandCount.sampleSize).toBe(3);
    expect(result.brandConcentration.uniqueBrandCount.missingCount).toBe(1);

    const brandCr3 = required(result.brandConcentration.brandCr3.value);
    expect(brandCr3.denominator).toBe(230); // 100 + 50 + 80，品牌缺失的 500 不参与分母
    expect(brandCr3.usedSampleCount).toBe(3);
    expect(brandCr3.missingCount).toBe(1);
    expect(brandCr3.topN.map((entry) => entry.key)).toEqual(["Alpha", "Beta"]);
    expect(brandCr3.topN.map((entry) => entry.value)).toEqual([150, 80]);
    expect(brandCr3.ratio).toBeCloseTo(1, 10);

    // 兜底品牌绝不能出现。
    const brandKeys = brandCr3.topN.map((entry) => entry.key);
    for (const fallback of ["Other", "Other Brand", "Unknown", "未知", "N/A"]) {
      expect(brandKeys).not.toContain(fallback);
    }
    expect(JSON.stringify(result)).not.toMatch(/Other Brand|Unknown|未知/);

    // 品牌缺失项在销量集中度里仍然可见（它不是销量缺失）。
    expect(required(result.salesConcentration.cr3.value).denominator).toBe(730);
    expect(result.notes.some((note) => note.includes("brand concentration only covers"))).toBe(
      true,
    );
    expectMetricInvariants(result, MARKET_METRICS_VERSION);
  });

  it("uniqueBrandCount counts every present brand even when some brands lack sales", () => {
    const result = metricsOf(
      samplesWith([
        { brand: "Alpha", monthlySalesEstimate: 100 },
        { brand: "Beta", monthlySalesEstimate: null },
        { brand: "Gamma", monthlySalesEstimate: 80 },
        { brand: "Delta", monthlySalesEstimate: 60 },
      ]),
    );

    expect(result.brandConcentration.uniqueBrandCount.value).toBe(4);
    expect(result.brandConcentration.uniqueBrandCount.sampleSize).toBe(4);
    expect(result.brandConcentration.uniqueBrandCount.missingCount).toBe(0);

    // CR3/CR5 仍只使用 brand present + sales present 的分母。
    const brandCr3 = required(result.brandConcentration.brandCr3.value);
    expect(brandCr3.denominator).toBe(240);
    expect(brandCr3.usedSampleCount).toBe(3);
    expect(brandCr3.missingCount).toBe(1);
    expect(brandCr3.topN.map((entry) => entry.key)).toEqual(["Alpha", "Gamma", "Delta"]);
  });

  it("rating / reviewCount 部分缺失：均值只用已知值，缺失计入 missingCount", () => {
    const result = metricsOf(
      samplesWith([
        { rating: 4, reviewCount: 10 },
        { rating: 5, reviewCount: null },
        { rating: null, reviewCount: 30 },
      ]),
    );

    expect(required(result.rating.averageRating.value)).toBe(4.5);
    expect(result.rating.averageRating.sampleSize).toBe(2);
    expect(result.rating.averageRating.missingCount).toBe(1);
    expect(required(result.rating.medianRating.value)).toBe(4.5);

    expect(required(result.reviews.averageReviewCount.value)).toBe(20);
    expect(required(result.reviews.medianReviewCount.value)).toBe(20);
    expect(result.reviews.averageReviewCount.sampleSize).toBe(2);
    expect(result.reviews.averageReviewCount.missingCount).toBe(1);
    expectMetricInvariants(result, MARKET_METRICS_VERSION);
  });

  it("rating / reviewCount 全部缺失 → 全部 NOT_AVAILABLE（value null）", () => {
    const result = metricsOf(samplesWith([{ rating: null }, { rating: null }]));

    expect(result.rating.averageRating.status).toBe("NOT_AVAILABLE");
    expect(result.rating.averageRating.value).toBeNull();
    expect(result.rating.medianRating.value).toBeNull();
    expect(result.reviews.averageReviewCount.status).toBe("NOT_AVAILABLE");
    expect(result.reviews.medianReviewCount.value).toBeNull();
    expect(result.reviews.topReviewThreshold.status).toBe("NOT_AVAILABLE");
    expect(result.reviews.topReviewThreshold.value).toBeNull();
  });

  it("launchedDate 全部缺失 → 4 个新品指标全部 NOT_AVAILABLE，并写入 notes 说明", () => {
    const result = metricsOf(samplesWith([{ launchedDate: null }, { launchedDate: null }]));

    expect(result.newEntrants.newProductCount30d.status).toBe("NOT_AVAILABLE");
    expect(result.newEntrants.newProductCount30d.value).toBeNull();
    expect(result.newEntrants.newProductCount90d.value).toBeNull();
    expect(result.newEntrants.newProductShare90d.value).toBeNull();
    expect(result.newEntrants.newProductSalesShare90d.value).toBeNull();
    expect(result.fieldCoverage.launchedDate.presentCount).toBe(0);
    expect(result.notes.some((note) => note.includes("launchedDate"))).toBe(true);
    expect(result.notes.some((note) => note.includes("NOT_AVAILABLE"))).toBe(true);
  });

  it("bsr 只出现在 fieldCoverage 中，不产出统计指标", () => {
    const result = metricsOf(samplesWith([{ bsr: 1200 }, { bsr: null }]));

    expect(result.fieldCoverage.bsr.presentCount).toBe(1);
    expect(result.fieldCoverage.bsr.missingCount).toBe(1);
    expect(result.fieldCoverage.bsr.coverageRatio).toBe(0.5);
    expect(Object.keys(result)).not.toContain("bsr");
  });
});

/* ── revenue ─────────────────────────────────────────────────── */

describe("computeMarketMetricsV1 — revenue", () => {
  it("有来源事实 → PRESENT，币种取出现次数最多者（并列取字典序最小）", () => {
    const result = metricsOf(
      samplesWith([
        { monthlyRevenueEstimate: 100, monthlyRevenueCurrency: "USD" },
        { monthlyRevenueEstimate: 200, monthlyRevenueCurrency: "EUR" },
        { monthlyRevenueEstimate: 300, monthlyRevenueCurrency: "EUR" },
        { monthlyRevenueEstimate: 400, monthlyRevenueCurrency: "USD" },
      ]),
    );

    const revenue = required(result.revenue.value);
    expect(result.revenue.status).toBe("PRESENT");
    expect(revenue.currency).toBe("EUR"); // 2:2 并列 → 字典序最小
    expect(revenue.total).toBe(1000);
    expect(revenue.median).toBe(250);
    expect(revenue.derivedFromSourceFacts).toBe(false);
    expect(revenue.derivedFromPriceTimesSales).toBeNull();
    expect(revenue.distribution.sampleSize).toBe(4);
  });

  it("完全无来源事实但可配对 price × sales → 仍为 NOT_AVAILABLE / value null，派生值只在 notes 中标注", () => {
    const result = metricsOf(
      samplesWith([
        { price: 10, monthlySalesEstimate: 100 },
        { price: 20, monthlySalesEstimate: 200 },
        { price: 30, monthlySalesEstimate: null },
      ]),
    );

    expect(result.revenue.status).toBe("NOT_AVAILABLE");
    expect(result.revenue.value).toBeNull();
    expect(result.revenue.sampleSize).toBe(2);
    expect(result.revenue.missingCount).toBe(1);
    expect(result.fieldCoverage.revenue.presentCount).toBe(0);
    expect(result.notes.some((note) => note.includes("DERIVED"))).toBe(true);
    expect(result.notes.some((note) => note.includes("5000"))).toBe(true); // 10*100 + 20*200
    expect(JSON.stringify(result.revenue)).not.toContain("5000");
    expectMetricInvariants(result, MARKET_METRICS_VERSION);
  });

  it("既无来源事实也无法配对 → NOT_AVAILABLE 且无派生说明", () => {
    const result = metricsOf(
      samplesWith([
        { monthlyRevenueEstimate: null, price: 10, monthlySalesEstimate: null },
        { monthlyRevenueEstimate: null, price: null, monthlySalesEstimate: 100 },
      ]),
    );

    expect(result.revenue.status).toBe("NOT_AVAILABLE");
    expect(result.revenue.value).toBeNull();
    expect(result.revenue.sampleSize).toBe(0);
    expect(result.revenue.missingCount).toBe(2);
    expect(result.notes.some((note) => note.includes("DERIVED"))).toBe(false);
  });
});

/* ── 极端值 ───────────────────────────────────────────────────── */

describe("computeMarketMetricsV1 — 极端值", () => {
  it("金额 0 按统一规则 missing；销量全为 0 时仍保留真实销量并让 ratio 为 null", () => {
    const result = metricsOf(
      samplesWith([
        { price: 0, monthlySalesEstimate: 0 },
        { price: 0, monthlySalesEstimate: 0 },
        { price: 0, monthlySalesEstimate: 0 },
      ]),
    );

    expect(result.price.status).toBe("NOT_AVAILABLE");
    expect(result.price.value).toBeNull();
    expect(result.fieldCoverage.price.presentCount).toBe(0);
    expect(result.fieldCoverage.price.missingCount).toBe(3);
    expect(result.fieldCoverage.sales.presentCount).toBe(3);

    const cr3 = required(result.salesConcentration.cr3.value);
    expect(cr3.denominator).toBe(0);
    expect(cr3.usedSampleCount).toBe(3);
    expect(cr3.ratio).toBeNull();
    expect(cr3.topN).toHaveLength(3);
    expect(cr3.topN.every((entry) => entry.share === 0)).toBe(true);
  });

  it("负价格 / 负销量按契约选择「视为 missing」，并在 notes 中写明", () => {
    const result = metricsOf(
      samplesWith([{ price: -5, monthlySalesEstimate: -10, rating: -1, reviewCount: -2, bsr: -3 }]),
    );

    expect(result.price.status).toBe("NOT_AVAILABLE");
    expect(result.price.value).toBeNull();
    expect(result.fieldCoverage.price.presentCount).toBe(0);
    expect(result.sales.status).toBe("NOT_AVAILABLE");
    expect(result.fieldCoverage.sales.presentCount).toBe(0);
    expect(result.fieldCoverage.rating.presentCount).toBe(0);
    expect(result.fieldCoverage.reviewCount.presentCount).toBe(0);
    expect(result.fieldCoverage.bsr.presentCount).toBe(0);
    expect(result.notes.some((note) => note.includes("negative"))).toBe(true);
    expectMetricInvariants(result, MARKET_METRICS_VERSION);
  });

  it("超大值（1e9）正常参与统计", () => {
    const result = metricsOf(
      samplesWith([
        { price: 1e9, monthlySalesEstimate: 1e9 },
        { price: 1e9, monthlySalesEstimate: 1e9 },
      ]),
    );

    const price = required(result.price.value);
    expect(price.min).toBe(1e9);
    expect(price.max).toBe(1e9);
    expect(price.mean).toBe(1e9);
    expect(required(result.sales.value).total).toBe(2e9);
    expect(required(result.sales.value).mean).toBe(1e9);
  });

  it("NaN / Infinity 一律按 missing，结果里不出现非有限数", () => {
    const result = metricsOf(
      samplesWith([
        { price: Number.NaN },
        { price: Number.POSITIVE_INFINITY },
        { price: Number.NEGATIVE_INFINITY, monthlySalesEstimate: Number.NaN, rating: Number.NaN },
      ]),
    );

    expect(result.price.status).toBe("NOT_AVAILABLE");
    expect(result.price.value).toBeNull();
    expect(result.fieldCoverage.price.presentCount).toBe(0);
    expect(result.sales.status).toBe("NOT_AVAILABLE");
    expect(result.rating.averageRating.status).toBe("NOT_AVAILABLE");
    expectMetricInvariants(result, MARKET_METRICS_VERSION);
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  });
});

/* ── 集中度 ───────────────────────────────────────────────────── */

describe("computeMarketMetricsV1 — 销量集中度", () => {
  const sample = samplesWith([
    { monthlySalesEstimate: 100 },
    { monthlySalesEstimate: 50 },
    { monthlySalesEstimate: 30 },
    { monthlySalesEstimate: 10 },
    { monthlySalesEstimate: 5 },
    { monthlySalesEstimate: null },
  ]);

  it("denominator / usedSampleCount / missingCount / ratio 手算校验", () => {
    const result = metricsOf(sample);

    const cr3 = required(result.salesConcentration.cr3.value);
    expect(cr3.denominator).toBe(195); // 100+50+30+10+5
    expect(cr3.usedSampleCount).toBe(5);
    expect(cr3.missingCount).toBe(1);
    expect(cr3.topN.map((entry) => entry.key)).toEqual([
      fixtureAsinAt(0),
      fixtureAsinAt(1),
      fixtureAsinAt(2),
    ]);
    expect(cr3.topN.map((entry) => entry.value)).toEqual([100, 50, 30]);
    expect(cr3.topN[0].share).toBeCloseTo(100 / 195, 10);
    expect(cr3.ratio).toBeCloseTo(180 / 195, 10);

    expect(result.salesConcentration.cr3.sampleSize).toBe(5);
    expect(result.salesConcentration.cr3.missingCount).toBe(1);

    const cr5 = required(result.salesConcentration.cr5.value);
    expect(cr5.topN).toHaveLength(5);
    expect(cr5.ratio).toBeCloseTo(1, 10);

    expect(result.salesConcentration.cr10.status).toBe("INSUFFICIENT_DATA");
    expect(result.salesConcentration.cr10.value).toBeNull();
    expect(result.salesConcentration.cr10.sampleSize).toBe(5);
    expect(result.salesConcentration.cr10.missingCount).toBe(1);

    expect(result.notes.some((note) => note.includes("1 of 6 sample items"))).toBe(true);
    expectMetricInvariants(result, MARKET_METRICS_VERSION);
  });

  it("value 降序、并列按 key 升序", () => {
    const result = metricsOf(
      samplesWith([
        { monthlySalesEstimate: 10 },
        { monthlySalesEstimate: 20 },
        { monthlySalesEstimate: 20 },
      ]),
    );

    const cr3 = required(result.salesConcentration.cr3.value);
    expect(cr3.topN.map((entry) => entry.key)).toEqual([
      fixtureAsinAt(1), // 20，ASIN 更小者排前
      fixtureAsinAt(2), // 20
      fixtureAsinAt(0), // 10
    ]);
    expect(cr3.ratio).toBeCloseTo(1, 10);
  });

  it("已知销量样本不足 Top N → INSUFFICIENT_DATA，但绝不伪造份额", () => {
    const result = metricsOf(samplesWith([{ monthlySalesEstimate: 10 }, { monthlySalesEstimate: 20 }]));

    expect(result.salesConcentration.cr3.status).toBe("INSUFFICIENT_DATA");
    expect(result.salesConcentration.cr3.value).toBeNull();
    expect(result.salesConcentration.cr3.sampleSize).toBe(2);
    expect(result.salesConcentration.cr5.status).toBe("INSUFFICIENT_DATA");
    expect(result.salesConcentration.cr10.status).toBe("INSUFFICIENT_DATA");
  });
});

/* ── 新品 ─────────────────────────────────────────────────────── */

describe("computeMarketMetricsV1 — newEntrants", () => {
  it("30 / 90 天窗口与销量占比手算校验（未来日期与不可解析日期不算新品）", () => {
    const result = metricsOf(
      samplesWith([
        { monthlySalesEstimate: 100, launchedDate: "2024-12-15" }, // 17 天
        { monthlySalesEstimate: 200, launchedDate: "2024-11-01" }, // 61 天
        { monthlySalesEstimate: 300, launchedDate: "2024-01-01" }, // 366 天
        { monthlySalesEstimate: 400, launchedDate: "2025-06-01" }, // 未来（-151 天）
        { monthlySalesEstimate: 500, launchedDate: null }, // 缺失
        { monthlySalesEstimate: null, launchedDate: "not-a-date" }, // 存在但无法解析
      ]),
    );

    expect(required(result.newEntrants.newProductCount30d.value)).toBe(1);
    expect(required(result.newEntrants.newProductCount90d.value)).toBe(2);
    expect(required(result.newEntrants.newProductShare90d.value)).toBe(0.5); // 2 / 4
    expect(required(result.newEntrants.newProductSalesShare90d.value)).toBe(0.2); // 300 / 1500

    expect(result.newEntrants.newProductCount90d.sampleSize).toBe(4);
    expect(result.newEntrants.newProductCount90d.missingCount).toBe(2);

    // coverage 只反映来源是否提供字段；可解析性由 newEntrants 自己判定。
    expect(result.fieldCoverage.launchedDate.presentCount).toBe(5);
    expect(result.fieldCoverage.launchedDate.missingCount).toBe(1);
    expectMetricInvariants(result, MARKET_METRICS_VERSION);
  });

  it("30 / 90 天含边界，超出一天即排除", () => {
    const result = metricsOf(
      samplesWith([
        { monthlySalesEstimate: 1, launchedDate: "2025-01-01" }, // 30 天 → 计入 30d
        { monthlySalesEstimate: 1, launchedDate: "2024-12-31" }, // 31 天 → 不计入 30d
        { monthlySalesEstimate: 1, launchedDate: "2024-11-02" }, // 90 天 → 计入 90d
        { monthlySalesEstimate: 1, launchedDate: "2024-11-01" }, // 91 天 → 不计入 90d
      ]),
      "2025-01-31T00:00:00.000Z",
    );

    expect(required(result.newEntrants.newProductCount30d.value)).toBe(1);
    // 2024-12-31（31 天）与 2024-11-02（恰好 90 天）都落在 90 天窗口内
    expect(required(result.newEntrants.newProductCount90d.value)).toBe(3);
  });

  it("新品销量全缺失 → newProductSalesShare90d 为 NOT_AVAILABLE（不用 0 顶替）", () => {
    const result = metricsOf(
      samplesWith([
        { monthlySalesEstimate: null, launchedDate: "2024-12-20" }, // 新品，销量缺失
        { monthlySalesEstimate: 900, launchedDate: "2024-01-01" }, // 老品，销量已知
      ]),
    );

    expect(required(result.newEntrants.newProductCount90d.value)).toBe(1);
    expect(required(result.newEntrants.newProductShare90d.value)).toBe(0.5);
    expect(result.newEntrants.newProductSalesShare90d.status).toBe("NOT_AVAILABLE");
    expect(result.newEntrants.newProductSalesShare90d.value).toBeNull();
  });

  it("referenceDate 无法解析 → 4 个新品指标 NOT_AVAILABLE 并说明原因", () => {
    const result = metricsOf(
      samplesWith([{ monthlySalesEstimate: 100, launchedDate: "2024-12-20" }]),
      "not-a-date",
    );

    expect(result.newEntrants.referenceDate).toBe("not-a-date");
    expect(result.newEntrants.newProductCount30d.status).toBe("NOT_AVAILABLE");
    expect(result.newEntrants.newProductCount30d.value).toBeNull();
    expect(result.newEntrants.newProductCount90d.value).toBeNull();
    expect(result.newEntrants.newProductShare90d.value).toBeNull();
    expect(result.newEntrants.newProductSalesShare90d.value).toBeNull();
    expect(result.notes.some((note) => note.includes("referenceDate"))).toBe(true);
  });

  it("无时区偏移的日期按 UTC 解释（结果与运行环境时区无关）", () => {
    const utcOnly = metricsOf(
      samplesWith([{ monthlySalesEstimate: 10, launchedDate: "2024-12-15T00:00:00.000" }]),
    );
    const explicitZ = metricsOf(
      samplesWith([{ monthlySalesEstimate: 10, launchedDate: "2024-12-15T00:00:00.000Z" }]),
    );

    expect(utcOnly.newEntrants.newProductCount30d).toEqual(
      explicitZ.newEntrants.newProductCount30d,
    );
    expect(required(utcOnly.newEntrants.newProductCount30d.value)).toBe(1);
  });
});

/* ── 不确定性与版本 ───────────────────────────────────────────── */

describe("computeMarketMetricsV1 — 确定性与版本", () => {
  const sample = makeSampleSeries(12, (index) => ({
    price: 10 + index,
    monthlySalesEstimate: 100 + index,
    monthlyRevenueEstimate: 1000 + index,
    brand: `Brand-${index % 3}`,
    rating: 4 + (index % 5) / 10,
    reviewCount: 10 + index,
    bsr: 900 - index,
    launchedDate: "2024-12-01",
  }));

  it("同一输入两次调用结果完全一致（含输入顺序打乱）", () => {
    const first = metricsOf(sample);
    const second = metricsOf(sample);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    const shuffled = [...sample].reverse();
    expect(JSON.stringify(metricsOf(shuffled))).toBe(JSON.stringify(first));
    expectMetricInvariants(first, MARKET_METRICS_VERSION);
  });

  it("metricsVersion 默认 MARKET_METRICS_VERSION 并透传到每个指标", () => {
    const result = metricsOf(sample);

    expect(MARKET_METRICS_VERSION).toBe("market-metrics.v1");
    expect(result.metricsVersion).toBe(MARKET_METRICS_VERSION);
    expect(result.schemaVersion).toBe(MARKET_METRICS_SCHEMA);
    for (const metric of collectMetrics(result)) {
      expect(metric.calculationVersion).toBe(MARKET_METRICS_VERSION);
    }
  });

  it("自定义 metricsVersion 透传到每个指标", () => {
    const custom = "market-metrics.v9-test";
    const result = metricsOf(sample, FIXTURE_REFERENCE_DATE, custom);

    expect(result.metricsVersion).toBe(custom);
    for (const metric of collectMetrics(result)) {
      expect(metric.calculationVersion).toBe(custom);
    }
  });

  it("无法解析 ASIN 的条目计入 sampleCount，但不进入统计", () => {
    const valid = makeSampleInput({ asin: fixtureAsinAt(0), price: 10 });
    const invalid = makeSampleInput({ asin: null, price: 20 });
    const result = metricsOf([valid, invalid]);

    expect(result.sampleCount).toBe(2);
    expect(result.validSampleCount).toBe(1);
    expect(result.fieldCoverage.price.presentCount).toBe(1);
    expect(result.fieldCoverage.price.missingCount).toBe(1);
    expect(result.fieldCoverage.price.coverageRatio).toBe(0.5);
    expect(required(result.price.value).min).toBe(10);
    expect(required(result.price.value).max).toBe(10);
    expectMetricInvariants(result, MARKET_METRICS_VERSION);
  });
});

/* ── 事实值快照 / 观测窗口 / 说明合并 ─────────────────────────── */

describe("computeMarketMetricsV1 — 冻结事实值与观测窗口", () => {
  it("调用方提供已冻结 factValues 时直接使用它，忽略现场 ProductFact 的变化", () => {
    const live = makeSampleInput({
      asin: fixtureAsinAt(0),
      price: 10,
      monthlySalesEstimate: 5,
      monthlyRevenueEstimate: 50,
      brand: "LiveBrand",
      rating: 1,
      reviewCount: 1,
      bsr: 1,
      launchedDate: "2024-01-01",
    });
    const frozen = fixtureFactValues({
      asin: fixtureAsinAt(0),
      price: {
        presence: "present",
        value: { amount: 99, currency: "USD" },
        valueSource: "FACT",
      },
      monthlySalesEstimate: { presence: "present", value: 55, valueSource: "PROVIDER_ESTIMATE" },
      monthlyRevenueEstimate: { presence: "missing", valueSource: "PROVIDER_ESTIMATE" },
      brand: { presence: "missing" },
      rating: { presence: "missing" },
      reviewCount: { presence: "missing" },
      bsr: { presence: "missing" },
      launchedDate: { presence: "missing" },
    });

    const result = metricsOf([{ ...live, factValues: frozen }]);

    // 价格 / 销量取冻结值（99 / 55），不是现场事实（10 / 5）。
    expect(required(result.price.value).median).toBe(99);
    expect(required(result.sales.value).total).toBe(55);
    // 冻结为 missing 的字段就是 missing，不会回落到现场事实。
    expect(result.fieldCoverage.brand.presentCount).toBe(0);
    expect(result.fieldCoverage.rating.presentCount).toBe(0);
    expect(result.fieldCoverage.revenue.presentCount).toBe(0);
    expect(result.revenue.status).toBe("NOT_AVAILABLE");
    expect(result.newEntrants.newProductCount30d.status).toBe("NOT_AVAILABLE");
    expectMetricInvariants(result, MARKET_METRICS_VERSION);
  });

  it("未提供 factValues 时由 ProductFact 现场投影（估算字段标 PROVIDER_ESTIMATE）", () => {
    const values = projectMarketFactValuesV1(
      makeProductFact({
        asin: "  b0proj0001 ",
        price: 5,
        monthlySalesEstimate: 12,
        monthlyRevenueEstimate: 34,
      }),
    );

    expect(values.asin).toBe("B0PROJ0001");
    expect(values.price).toEqual({
      presence: "present",
      value: { amount: 5, currency: "USD" },
      valueSource: "FACT",
    });
    expect(values.monthlySalesEstimate).toEqual({
      presence: "present",
      value: 12,
      valueSource: "PROVIDER_ESTIMATE",
    });
    expect(values.monthlyRevenueEstimate).toEqual({
      presence: "present",
      value: { amount: 34, currency: "USD" },
      valueSource: "PROVIDER_ESTIMATE",
    });

    const missing = projectMarketFactValuesV1(
      makeProductFact({ asin: "B0PROJ0002", price: null, brand: null, launchedDate: null }),
    );
    expect(missing.price).toEqual({ presence: "missing", valueSource: "FACT" });
    expect(missing.brand).toEqual({ presence: "missing" });
    expect(missing.launchedDate).toEqual({ presence: "missing" });
  });

  it("观测窗口：调用方 observedAt 优先，并合并 extraNotes（引擎只追加不覆盖）", () => {
    const result = computeMarketMetricsV1({
      sample: samplesWith([{ price: 10 }, { price: 20 }]),
      referenceDate: FIXTURE_REFERENCE_DATE,
      marketplace: "us",
      observedAt: "2025-02-02T00:00:00.000Z",
      extraNotes: ["sample origin: existing_evidence", "source types: sellersprite_xlsx", "   "],
    });

    expect(result.evidenceWindow.observedAtSource).toBe("caller_recorded");
    expect(result.evidenceWindow.recordedObservedAt).toBe("2025-02-02T00:00:00.000Z");
    expect(result.evidenceWindow.earliestCapturedAt).toBe(FIXTURE_CAPTURED_AT);
    expect(result.evidenceWindow.latestCapturedAt).toBe(FIXTURE_CAPTURED_AT);
    expect(result.evidenceWindow.marketplace).toBe("US"); // 显式入参归一化为大写
    // 调用方说明在前（空串说明被剔除），引擎自己的说明保留在后面。
    expect(result.notes.slice(0, 2)).toEqual([
      "sample origin: existing_evidence",
      "source types: sellersprite_xlsx",
    ]);
    expect(result.notes.length).toBeGreaterThan(2);
  });

  it("观测窗口：无 observedAt 时退化为 evidence capturedAt（最早 / 最晚）", () => {
    const result = computeMarketMetricsV1({
      sample: [
        makeSampleInput({
          asin: fixtureAsinAt(0),
          price: 10,
          capturedAtOverride: "2025-03-01T00:00:00.000Z",
        }),
        makeSampleInput({
          asin: fixtureAsinAt(1),
          price: 20,
          capturedAtOverride: "2025-01-15T00:00:00.000Z",
        }),
      ],
      referenceDate: FIXTURE_REFERENCE_DATE,
    });

    expect(result.evidenceWindow.observedAtSource).toBe("evidence_captured_at");
    expect(result.evidenceWindow.earliestCapturedAt).toBe("2025-01-15T00:00:00.000Z");
    expect(result.evidenceWindow.latestCapturedAt).toBe("2025-03-01T00:00:00.000Z");
    expect(result.evidenceWindow.recordedObservedAt).toBe("2025-03-01T00:00:00.000Z");
    // fixture now carries deterministic marketplace identity; do not infer it from display text.
    expect(result.evidenceWindow.marketplace).toBe("US");
  });

  it("观测窗口：marketplace 缺失时按 subjectKey 的市场段推断", () => {
    const result = computeMarketMetricsV1({
      sample: [
        makeSampleInput({ asin: "B0MARKET01", subjectKey: "amazon:US:B0MARKET01", price: 10 }),
        makeSampleInput({ asin: "B0MARKET02", subjectKey: "amazon:DE:B0MARKET02", price: 20 }),
      ],
      referenceDate: FIXTURE_REFERENCE_DATE,
    });

    expect(result.evidenceWindow.marketplace).toBe("UNKNOWN");
    const consistent = computeMarketMetricsV1({
      sample: [
        makeSampleInput({ asin: "B0MARKET03", subjectKey: "amazon:US:B0MARKET03", price: 10 }),
        makeSampleInput({ asin: "B0MARKET04", subjectKey: "amazon:US:B0MARKET04", price: 20 }),
      ],
      referenceDate: FIXTURE_REFERENCE_DATE,
    });
    expect(consistent.evidenceWindow.marketplace).toBe("US");
  });

  it("观测窗口：完全没有可信 capturedAt 时全部为 null / unknown，不用扫描时间冒充", () => {
    const fact = makeProductFact({ asin: "B0NOOBS001", price: 10 });
    const withoutCapturedAt = { ...fact, sourceProof: { ...fact.sourceProof, capturedAt: "  " } };
    const result = computeMarketMetricsV1({
      sample: [
        { subjectKey: fact.subjectKey, productFact: withoutCapturedAt, capturedAt: null },
      ],
      referenceDate: FIXTURE_REFERENCE_DATE,
    });

    expect(result.evidenceWindow.observedAtSource).toBe("unknown");
    expect(result.evidenceWindow.earliestCapturedAt).toBeNull();
    expect(result.evidenceWindow.latestCapturedAt).toBeNull();
    expect(result.evidenceWindow.recordedObservedAt).toBeNull();
  });
});
