import { describe, expect, it } from "vitest";

import type { ResearchFactField, ResearchFactSnapshot } from "@/lib/research/researchContracts";
import {
  buildEconomicAssumptions,
  buildUnitEconomicsView,
  hasEconomicInputs,
} from "./unitEconomicsScenario";

const CAPTURED_AT = "2026-10-13T00:00:00.000Z";
const CONTENT_HASH = "c".repeat(64);

function field<T>(value: T | null): ResearchFactField<T> {
  return {
    value,
    status: value === null ? "missing" : "present",
    source: "sellersprite_plugin",
    confidence: value === null ? 0 : 1,
    capturedAt: CAPTURED_AT,
    rawProofHash: CONTENT_HASH,
    evidenceRefs: [{
      refId: "evidence:ev-fixture",
      source: "sellersprite_plugin",
      captureId: "cap-fixture",
      evidenceId: "ev-fixture",
      subjectKey: "amazon:US:B0FIXTURE1",
      capturedAt: CAPTURED_AT,
      contentHash: CONTENT_HASH,
      sourceUrl: "https://www.amazon.com/dp/B0FIXTURE1",
    }],
  };
}

type PkgWeight = { value: number; unit: "kg" | "lb" | "oz" | "g" };
type PkgDims = { length: number; width: number; height: number; unit: "cm" | "in" };
type Price = { amount: number; currency: string };

/** 与真实场景一致的快照：有售价，包装与 FBA 事实缺失（必须由用户输入补齐）。 */
function snapshot(overrides: {
  price?: Price | null;
  packageWeight?: PkgWeight | null;
  packageDimensions?: PkgDims | null;
  fbaFee?: Price | null;
} = {}): ResearchFactSnapshot {
  return {
    basic: {
      asin: field<string>("B0FIXTURE1"),
      title: field<string>("Fixture product"),
      image: field<string>("https://cdn.example.com/B0FIXTURE1.jpg"),
      brand: field<string>("FixtureBrand"),
      category: field<string>("Home & Kitchen"),
      price: field<Price>(overrides.price === undefined ? { amount: 9.99, currency: "USD" } : overrides.price),
      rating: field<number>(4.5),
      reviewCount: field<number>(120),
      bulletPoints: field<readonly string[]>(["point one"]),
    },
    market: {
      bsr: field<number>(1500),
      monthlySalesEstimate: field<number>(null),
      monthlyRevenueEstimate: field<Price>(null),
      launchedDate: field<string>(null),
      subCategoryBsr: field<number>(null),
      dateFirstAvailable: field<string>(null),
      buyboxSeller: field<string>(null),
      fulfillmentType: field<string>(null),
      estimatedGrossMargin: field<number>(null),
      listingQualityScore: field<number>(null),
    },
    profit: {
      packageWeight: field<PkgWeight>(overrides.packageWeight ?? null),
      packageDimensions: field<PkgDims>(overrides.packageDimensions ?? null),
      fbaFee: field<Price>(overrides.fbaFee ?? null),
      itemWeight: field<PkgWeight>({ value: 0.4, unit: "kg" }),
      itemDimensions: field<{ length: number; width: number; height?: number; unit: "cm" | "in" }>({
        length: 16.5, width: 11.6, height: 1, unit: "in",
      }),
    },
    keywordEvidence: { topKeywords: field<readonly unknown[]>(null) as never },
  };
}

describe("V6 商业输入 → 经济性假设映射", () => {
  it("只有非经济性字段时不产生假设（保持历史 null 行为）", () => {
    expect(hasEconomicInputs({ moq: 100, compliance: { status: "not_reviewed" } })).toBe(false);
    expect(buildEconomicAssumptions({ moq: 100 })).toBeNull();
  });

  it("字段逐一映射到计算引擎契约（含 0 作为合法值）", () => {
    const assumptions = buildEconomicAssumptions({
      purchasePrice: { value: 0, currency: "CNY" },
      targetSellingPrice: { value: 12.99, currency: "USD" },
      packageWeight: { value: 350, unit: "g" },
      packageDimensions: { length: 21, width: 8.5, height: 4, unit: "cm" },
      logisticsCost: { value: 6.5, currency: "CNY" },
      fbaFee: { value: 4.25, currency: "USD" },
      commissionRate: 0.15,
      adCostRate: 0.1,
      exchangeRate: 7.2,
    }, { marketplace: "US" });

    expect(assumptions).not.toBeNull();
    expect(assumptions!.procurementCost).toEqual({ amount: 0, currency: "CNY" });
    expect(assumptions!.targetSellingPrice).toEqual({ amount: 12.99, currency: "USD" });
    expect(assumptions!.packageWeight).toEqual({ value: 350, unit: "g" });
    expect(assumptions!.packageDimensions).toEqual({ length: 21, width: 8.5, height: 4, unit: "cm" });
    expect(assumptions!.unitLogisticsCost).toEqual({ amount: 6.5, currency: "CNY" });
    expect(assumptions!.fbaFee).toEqual({ amount: 4.25, currency: "USD" });
    expect(assumptions!.commissionRate).toBe(0.15);
    expect(assumptions!.targetTacosRate).toBe(0.1);
    expect(assumptions!.exchangeRate).toBe(7.2);
    // 按单件头程费用口径时不套用计费重费率
    expect(assumptions!.shippingMode).toBeUndefined();
  });

  it("未填单件头程费用时才使用计费重口径（模式 + 单价）", () => {
    const assumptions = buildEconomicAssumptions({
      purchasePrice: { value: 20, currency: "CNY" },
      packageWeight: { value: 0.5, unit: "kg" },
      packageDimensions: { length: 20, width: 15, height: 10, unit: "cm" },
      shippingRatePerKg: 2.5,
      adCostRate: 0.1,
    }, { marketplace: "US" });

    expect(assumptions!.unitLogisticsCost).toBeUndefined();
    expect(assumptions!.shippingMode).toBe("custom_rate");
    expect(assumptions!.customShippingRatePerKg).toBe(2.5);
  });

  it("平台费率性质决定来源性质：情景假设 → USER_INPUT；官方引用 → CONFIRMED_REFERENCE 且登记来源与生效日期", () => {
    const scenario = buildEconomicAssumptions({
      fbaFee: { value: 4, currency: "USD" },
      platformFeeNature: "user_scenario",
    }, { marketplace: "US" });
    expect(scenario!.metadata!.fbaFee!.metricNature).toBe("USER_INPUT");

    const official = buildEconomicAssumptions({
      fbaFee: { value: 4, currency: "USD" },
      platformFeeNature: "official_reference",
      platformFeeSourceNote: "Amazon FBA 费率页 2026-01-15 生效档",
      platformFeeEffectiveDate: "2026-01-15",
    }, { marketplace: "US" });
    expect(official!.metadata!.fbaFee!.metricNature).toBe("CONFIRMED_REFERENCE");
    expect(official!.metadata!.fbaFee!.source).toBe("Amazon FBA 费率页 2026-01-15 生效档");
    expect(official!.metadata!.fbaFee!.effectiveDate).toBe("2026-01-15T00:00:00.000Z");
    expect(official!.metadata!.fbaFee!.marketplace).toBe("US");
  });
});

describe("V6 单位经济性展示契约", () => {
  const completeInputs = {
    purchasePrice: { value: 20, currency: "CNY" as const },
    logisticsCost: { value: 6, currency: "CNY" as const },
    packageWeight: { value: 350, unit: "g" as const },
    packageDimensions: { length: 21, width: 8.5, height: 4, unit: "cm" as const },
    fbaFee: { value: 4.25, currency: "USD" as const },
    commissionRate: 0.15,
    adCostRate: 0.1,
    exchangeRate: 7.2,
  };

  it("输入完整时可计算，并给出成本构成、利润与保本售价", () => {
    const view = buildUnitEconomicsView({
      facts: snapshot(),
      assumptions: buildEconomicAssumptions(completeInputs, { marketplace: "US" }),
      marketplace: "US",
    });

    expect(view.status).toBe("available");
    expect(view.currency).toBe("USD");
    expect(view.commissionIncluded).toBe(true);
    expect(view.freightBasis).toBe("per_unit");
    // 采购 20/7.2=2.78 + 头程 6/7.2=0.83 → 到岸 3.61
    expect(view.costLines.map((line) => line.key)).toEqual([
      "procurementCost", "shipping", "landedCost", "commission", "fbaFee", "adCost", "totalCost",
    ]);
    expect(view.totalUnitCostUsd).not.toBeNull();
    const breakEven = view.metrics.find((metric) => metric.key === "breakEvenPrice");
    expect(breakEven?.status).toBe("available");
    expect(breakEven?.value).toBeGreaterThan(0);
    expect(view.formulaNotes.length).toBeGreaterThan(0);
    expect(view.excludedCosts).not.toContain("平台佣金（Amazon 佣金/推荐费）");
    // 未纳入费用必须显式列出 → 部分成本口径
    expect(view.isPartialCostBasis).toBe(true);
    expect(view.excludedCosts.length).toBeGreaterThan(0);
  });

  it("成本合计说明与佣金是否提供一致，0 佣金率仍是已提供的合法输入", () => {
    for (const rate of [undefined, 0, 0.15]) {
      const view = buildUnitEconomicsView({
        facts: snapshot(),
        assumptions: buildEconomicAssumptions({ ...completeInputs, commissionRate: rate }, { marketplace: "US" }),
        marketplace: "US",
      });
      const note = view.costLines.find((line) => line.key === "totalCost")?.note;
      expect(view.status).toBe("available");
      expect(view.commissionIncluded).toBe(rate !== undefined);
      if (rate === undefined) {
        expect(note).toContain("佣金未提供，未纳入");
        expect(note).not.toContain("+ 佣金");
      } else {
        expect(note).toContain("+ 佣金");
        expect(note).not.toContain("佣金未提供");
      }
    }
  });

  it("缺少广告费率时不可计算，并给出明确原因（不默认按 0）", () => {
    const view = buildUnitEconomicsView({
      facts: snapshot(),
      assumptions: buildEconomicAssumptions({
        purchasePrice: { value: 20, currency: "CNY" },
        logisticsCost: { value: 6, currency: "CNY" },
        fbaFee: { value: 4.25, currency: "USD" },
        exchangeRate: 7.2,
      }, { marketplace: "US" }),
      marketplace: "US",
    });

    expect(view.status).toBe("not_computable");
    expect(view.totalUnitCostUsd).toBeNull();
    expect(view.costLines).toHaveLength(0);
    expect(view.reasons.join(" ")).toContain("不默认按 0");
    // 未提供佣金时必须在未纳入清单中显式列出
    expect(view.excludedCosts).toContain("平台佣金（Amazon 佣金/推荐费）");
  });

  it("部分输入不能计算时，已填写的采购、头程、佣金和汇率仍显示为人工输入", () => {
    const view = buildUnitEconomicsView({
      facts: snapshot(),
      assumptions: buildEconomicAssumptions({
        purchasePrice: { value: 20, currency: "CNY" },
        logisticsCost: { value: 6, currency: "CNY" },
        fbaFee: { value: 4.25, currency: "USD" },
        commissionRate: 0,
        exchangeRate: 7.2,
      }, { marketplace: "US" }),
      marketplace: "US",
    });

    expect(view.status).toBe("not_computable");
    const byKey = new Map(view.inputProvenance.map((line) => [line.key, line]));
    for (const key of ["procurementCost", "shippingRate", "fbaFee", "commissionRate", "exchangeRate"]) {
      expect(byKey.get(key)?.nature, key).toBe("USER_INPUT");
    }
    expect(byKey.get("targetTacosRate")?.nature).toBe("MISSING");
    expect(view.totalUnitCostUsd).toBeNull();
  });

  it("人民币费用使用内置汇率时明确标注固定假设，不冒充用户输入或实时汇率", () => {
    for (const purchaseCurrency of ["CNY", "USD"] as const) {
      const view = buildUnitEconomicsView({
        facts: snapshot(),
        assumptions: buildEconomicAssumptions({
          ...completeInputs,
          purchasePrice: { value: 20, currency: purchaseCurrency },
          logisticsCost: { value: 6, currency: "CNY" },
          exchangeRate: undefined,
        }, { marketplace: "US" }),
        marketplace: "US",
      });
      const exchange = view.inputProvenance.find((line) => line.key === "exchangeRate");
      expect(view.status).toBe("available");
      expect(exchange?.nature).toBe("ESTIMATED");
      expect(exchange?.source).toBe("internal_fixed_assumption");
      expect(exchange?.note).toContain("7.2");
      expect(exchange?.note).toContain("非实时汇率");
    }
  });

  it("使用内置头程费率表时，成本展示标注估算和费率，不冒充用户报价", () => {
    const view = buildUnitEconomicsView({
      facts: snapshot(),
      assumptions: buildEconomicAssumptions({
        ...completeInputs,
        logisticsCost: undefined,
        shippingMode: "sea_fast",
        shippingRatePerKg: undefined,
      }, { marketplace: "US" }),
      marketplace: "US",
    });
    const shipping = view.costLines.find((line) => line.key === "shipping");
    expect(view.status).toBe("available");
    expect(shipping?.nature).toBe("ESTIMATED");
    expect(shipping?.source).toBe("internal_shipping_rate_table");
    expect(shipping?.note).toContain("2.5 USD/kg");
    expect(shipping?.note).toContain("非供应商报价");
  });

  it("无任何输入时不可计算，且不产生任何金额", () => {
    const view = buildUnitEconomicsView({
      facts: snapshot(),
      assumptions: null,
      marketplace: "US",
    });

    expect(view.status).toBe("not_computable");
    expect(view.sellingPrice.amountUsd).toBe(9.99);
    expect(view.totalUnitCostUsd).toBeNull();
    for (const metric of view.metrics) {
      expect(metric.value).toBeNull();
      expect(metric.status).toBe("not_computable");
    }
  });

  it("用户输入的包装重量与尺寸可补齐缺失事实，但商品净重/净尺寸不得代填", () => {
    const withUserPackaging = buildUnitEconomicsView({
      facts: snapshot(),
      assumptions: buildEconomicAssumptions({
        ...completeInputs,
        logisticsCost: undefined,
        shippingRatePerKg: 2.5,
      }, { marketplace: "US" }),
      marketplace: "US",
    });
    expect(withUserPackaging.status).toBe("available");
    expect(withUserPackaging.freightBasis).toBe("chargeable_weight");
    expect(withUserPackaging.chargeableWeightKg).toBe(0.35);

    const withoutPackaging = buildUnitEconomicsView({
      facts: snapshot(),
      assumptions: buildEconomicAssumptions({
        ...completeInputs,
        logisticsCost: undefined,
        shippingRatePerKg: 2.5,
        packageWeight: undefined,
        packageDimensions: undefined,
      }, { marketplace: "US" }),
      marketplace: "US",
    });
    expect(withoutPackaging.status).toBe("not_computable");
    expect(withoutPackaging.reasons.join(" ")).toContain("缺少包装重量和包装尺寸");
  });

  it("来源性质登记：事实售价为来源引用，用户填写项为用户输入", () => {
    const view = buildUnitEconomicsView({
      facts: snapshot(),
      assumptions: buildEconomicAssumptions(completeInputs, { marketplace: "US" }),
      marketplace: "US",
    });

    const byKey = new Map(view.inputProvenance.map((line) => [line.key, line]));
    expect(byKey.get("sellingPrice")!.nature).toBe("CONFIRMED_REFERENCE");
    expect(byKey.get("procurementCost")!.nature).toBe("USER_INPUT");
    expect(byKey.get("fbaFee")!.nature).toBe("USER_INPUT");
    expect(byKey.get("commissionRate")!.nature).toBe("USER_INPUT");
  });
});
