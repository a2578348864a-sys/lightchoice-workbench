import { describe, expect, it, vi } from "vitest";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import type {
  ResearchEngineInput,
  ResearchEvidenceRef,
  ResearchFactSnapshot,
} from "@/lib/research/researchContracts";
import {
  evaluateDeterministicRiskGates,
  RISK_THRESHOLDS,
} from "./riskGateEvaluator";
import {
  calculateUnitEconomics,
  type UnitEconomicsCalculationResult,
} from "./unitEconomicsCalculator";
import { buildDecisionSummary } from "@/lib/research/decisionSummary";
import { runResearchEngine } from "./researchEngine";

const capturedAt = "2026-09-25T00:00:00.000Z";
const proofHash = "c".repeat(64);

function factField<T>(value: T | null) {
  return {
    value,
    status: value === null ? ("missing" as const) : ("present" as const),
    source: "sellersprite_plugin" as const,
    confidence: value === null ? 0 : 1,
    capturedAt,
    rawProofHash: proofHash,
  };
}

function fixtureFact(overrides: Partial<ProductFact> = {}): ProductFact {
  return {
    schema: "product-fact.v3",
    subjectKey: "amazon:US:B0RISKTEST1",
    sourceProof: {
      source: "sellersprite_plugin",
      captureId: "cap-risk-01",
      evidenceId: "ev-risk-01",
      subjectKey: "amazon:US:B0RISKTEST1",
      capturedAt,
      contentHash: proofHash,
      sourceUrl: "https://www.amazon.com/dp/B0RISKTEST1",
      operator: "owner:v1",
    },
    basic: {
      asin: factField("B0RISKTEST1"),
      title: factField("优质厨房收纳置物架"),
      image: factField("https://images.example.test/product.jpg"),
      brand: factField("GoodBrand"),
      category: factField("Kitchen"),
      price: factField({ amount: 35.0, currency: "USD" }),
      rating: factField(4.6),
      reviewCount: factField(600),
      bulletPoints: factField(["优质不锈钢", "承重强"]),
    },
    market: {
      bsr: factField(300),
      monthlySalesEstimate: factField(800),
      monthlyRevenueEstimate: factField({ amount: 28000, currency: "USD" }),
      launchedDate: factField("2024-01-01"),
      subCategoryBsr: factField(50),
      dateFirstAvailable: factField("2024-01-01"),
      buyboxSeller: factField("ThirdPartyStore"),
      fulfillmentType: factField("FBA"),
      estimatedGrossMargin: factField(0.45),
      listingQualityScore: factField(8.5),
    },
    profit: {
      packageWeight: factField({ value: 0.8, unit: "kg" }),
      packageDimensions: factField({ length: 25, width: 18, height: 12, unit: "cm" }),
      fbaFee: factField({ amount: 6.0, currency: "USD" }),
      itemWeight: factField(null),
      itemDimensions: factField(null),
    },
    timeSeries: {
      price90dMin: factField(32.0),
      price90dAvg: factField(34.0),
      price360dMin: factField(30.0),
      bsr90dAvg: factField(320),
      bsrDrops90d: factField(25),
      buyBoxAmazonSharePercent: factField(0),
      dealCount90d: factField(1),
    },
    variationAnalysis: {
      childSales: factField(600),
      parentTotalSales: factField(800),
      currentAsinSalesShare: factField(0.75),
      isDominantVariation: factField(true),
      isMinorVariation: factField(false),
    },
    concentration: {
      brandCr5Share: factField(0.45),
      amazon1pShare: factField(0),
      sellerMarketShare: factField(0.2),
      sellerOriginDomesticRatio: factField(0.8),
    },
    ...overrides,
  };
}

function snapField<T>(
  field: { value?: T | null; status?: string; source?: string; confidence?: number; capturedAt?: string | null; rawProofHash?: string | null } | undefined,
  proofRef: ResearchEvidenceRef,
  fallback: T | null = null,
) {
  const value = field?.value !== undefined ? field.value : fallback;
  return {
    value,
    status: (field?.status ?? (value === null ? "missing" : "present")) as any,
    source: (field?.source ?? "sellersprite_plugin") as any,
    confidence: field?.confidence ?? (value === null ? 0 : 1),
    capturedAt: field?.capturedAt ?? capturedAt,
    rawProofHash: field?.rawProofHash ?? proofHash,
    evidenceRefs: [proofRef] as readonly ResearchEvidenceRef[],
  };
}

function fixtureSnapshot(fact: ProductFact = fixtureFact()): ResearchFactSnapshot {
  const proofRef: ResearchEvidenceRef = {
    refId: `evidence:${fact.sourceProof.evidenceId}`,
    source: fact.sourceProof.source,
    captureId: fact.sourceProof.captureId,
    evidenceId: fact.sourceProof.evidenceId,
    subjectKey: fact.subjectKey,
    capturedAt: fact.sourceProof.capturedAt,
    contentHash: fact.sourceProof.contentHash,
    sourceUrl: fact.sourceProof.sourceUrl,
  };
  return {
    basic: {
      asin: snapField(fact.basic.asin, proofRef, "B0RISKTEST1"),
      title: snapField(fact.basic.title, proofRef, "优质厨房收纳置物架"),
      image: snapField(fact.basic.image, proofRef, "https://images.example.test/product.jpg"),
      brand: snapField(fact.basic.brand, proofRef, "GoodBrand"),
      category: snapField(fact.basic.category, proofRef, "Kitchen"),
      price: snapField(fact.basic.price, proofRef, { amount: 35.0, currency: "USD" }),
      rating: snapField(fact.basic.rating, proofRef, 4.6),
      reviewCount: snapField(fact.basic.reviewCount, proofRef, 600),
      bulletPoints: snapField(fact.basic.bulletPoints, proofRef, ["优质不锈钢", "承重强"]),
    },
    market: {
      bsr: snapField(fact.market.bsr, proofRef, 300),
      monthlySalesEstimate: snapField(fact.market.monthlySalesEstimate, proofRef, 800),
      monthlyRevenueEstimate: snapField(fact.market.monthlyRevenueEstimate, proofRef, { amount: 28000, currency: "USD" }),
      launchedDate: snapField(fact.market.launchedDate, proofRef, "2024-01-01"),
      subCategoryBsr: snapField(fact.market.subCategoryBsr, proofRef, null),
      dateFirstAvailable: snapField(fact.market.dateFirstAvailable, proofRef, null),
      buyboxSeller: snapField(fact.market.buyboxSeller, proofRef, null),
      fulfillmentType: snapField(fact.market.fulfillmentType, proofRef, null),
      estimatedGrossMargin: snapField(fact.market.estimatedGrossMargin, proofRef, null),
      listingQualityScore: snapField(fact.market.listingQualityScore, proofRef, null),
    },
    profit: {
      packageWeight: snapField(fact.profit.packageWeight, proofRef, null),
      packageDimensions: snapField(fact.profit.packageDimensions, proofRef, null),
      fbaFee: snapField(fact.profit.fbaFee, proofRef, null),
      itemWeight: snapField(fact.profit.itemWeight, proofRef, null),
      itemDimensions: snapField(fact.profit.itemDimensions, proofRef, null),
    },
    timeSeries: fact.timeSeries
      ? {
          price90dMin: snapField(fact.timeSeries.price90dMin, proofRef, 32.0),
          price90dAvg: snapField(fact.timeSeries.price90dAvg, proofRef, 34.0),
          price360dMin: snapField(fact.timeSeries.price360dMin, proofRef, 30.0),
          bsr90dAvg: snapField(fact.timeSeries.bsr90dAvg, proofRef, 320),
          bsrDrops90d: snapField(fact.timeSeries.bsrDrops90d, proofRef, 25),
          buyBoxAmazonSharePercent: snapField(fact.timeSeries.buyBoxAmazonSharePercent, proofRef, 0),
          dealCount90d: snapField(fact.timeSeries.dealCount90d, proofRef, 1),
        }
      : undefined,
    variationAnalysis: fact.variationAnalysis
      ? {
          childSales: snapField(fact.variationAnalysis.childSales, proofRef, 600),
          parentTotalSales: snapField(fact.variationAnalysis.parentTotalSales, proofRef, 800),
          currentAsinSalesShare: snapField(fact.variationAnalysis.currentAsinSalesShare, proofRef, 0.75),
          isDominantVariation: snapField(fact.variationAnalysis.isDominantVariation, proofRef, true),
          isMinorVariation: snapField(fact.variationAnalysis.isMinorVariation, proofRef, false),
        }
      : undefined,
    concentration: fact.concentration
      ? {
          brandCr5Share: snapField(fact.concentration.brandCr5Share, proofRef, 0.45),
          amazon1pShare: snapField(fact.concentration.amazon1pShare, proofRef, 0),
          sellerMarketShare: snapField(fact.concentration.sellerMarketShare, proofRef, 0.2),
          sellerOriginDomesticRatio: snapField(fact.concentration.sellerOriginDomesticRatio, proofRef, 0.8),
        }
      : undefined,
    keywordEvidence: {
      topKeywords: { value: null, status: "missing" as const, source: fact.sourceProof.source, confidence: 0, capturedAt, rawProofHash: proofHash, evidenceRefs: [proofRef] },
    },
  };
}

describe("RDO-2 Deterministic Risk Gates 规则引擎测试", () => {
  it("测试 1: 正常商品无风险（全绿 PASS）", () => {
    const facts = fixtureSnapshot();
    // 售价 $35, 采购 $5, FBA $6, 广告 10% ($3.5), 净利 ~ $18.5 > 0, 毛利率 ~ 62.9% > 15%, FBA 占比 17.1% < 40%, 评分 4.6, 卖家为第三方
    const unitEconomics = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 5.0, currency: "USD" },
        shippingMode: "sea_fast",
        targetTacosRate: 0.1,
      },
    });

    const summary = evaluateDeterministicRiskGates({ facts, unitEconomics });

    expect(summary.status).toBe("passed");
    expect(summary.hasBlockingRisk).toBe(false);
    expect(summary.blockingReasons).toHaveLength(0);
    expect(summary.warningReasons).toHaveLength(0);
    expect(summary.rules).toHaveLength(11);

    for (const rule of summary.rules) {
      expect(rule.status).toBe("passed");
      expect(rule.reason).toBeNull();
      expect(rule.sourceFields.length).toBeGreaterThan(0);
    }
  });

  it("测试 2: 单件亏损触发一票否决（NEGATIVE_NET_PROFIT -> BLOCK）", () => {
    const facts = fixtureSnapshot();
    // 售价 $35, 采购 $30, FBA $6 => 总成本至少 36+，净利必为负
    const unitEconomics = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 30.0, currency: "USD" },
        shippingMode: "sea_fast",
        targetTacosRate: 0,
      },
    });

    const summary = evaluateDeterministicRiskGates({ facts, unitEconomics });

    expect(summary.status).toBe("blocked");
    expect(summary.hasBlockingRisk).toBe(true);
    expect(summary.blockingReasons.length).toBeGreaterThanOrEqual(1);
    expect(summary.blockingReasons.some((r) => r.includes("[一票否决]") && r.includes("单件净利润为负"))).toBe(true);

    const rule = summary.rules.find((r) => r.ruleId === "NEGATIVE_NET_PROFIT");
    expect(rule).toBeDefined();
    expect(rule?.severity).toBe("BLOCK");
    expect(rule?.status).toBe("triggered");
    expect(rule?.sourceFields).toContain("unitEconomics.deterministic.netProfit");
    expect(rule?.sourceFields).toContain("facts.basic.price");
  });

  it("测试 3: 毛利率过低触发严重预警（LOW_GROSS_MARGIN -> WARNING）", () => {
    const facts = fixtureSnapshot();
    // 售价 $35, 采购 $23, FBA $6, 运费 ~ $2 => 到岸成本 ~ $25, grossProfit = 35 - 25 - 6 = $4, grossMargin = 4/35 = 11.4% < 15%
    // 净利润仍为正 (无广告时 4 > 0)
    const unitEconomics = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 23.0, currency: "USD" },
        shippingMode: "sea_fast",
        targetTacosRate: 0,
      },
    });

    const summary = evaluateDeterministicRiskGates({ facts, unitEconomics });

    expect(summary.status).toBe("warning");
    expect(summary.hasBlockingRisk).toBe(false);
    expect(summary.warningReasons.length).toBeGreaterThanOrEqual(1);

    const rule = summary.rules.find((r) => r.ruleId === "LOW_GROSS_MARGIN");
    expect(rule).toBeDefined();
    expect(rule?.severity).toBe("WARNING");
    expect(rule?.status).toBe("triggered");
    expect(rule?.reason).toContain("毛利率过低");
    expect(rule?.reason).toContain("< 15.0%");
  });

  it("测试 4: FBA 比例过高触发严重预警（HIGH_FBA_RATIO -> WARNING）", () => {
    // 售价 $20, FBA 费用 $10 => FBA 占售价 50% >= 40%
    const fact = fixtureFact({
      basic: {
        ...fixtureFact().basic,
        price: factField({ amount: 20.0, currency: "USD" }),
      },
      profit: {
        ...fixtureFact().profit,
        fbaFee: factField({ amount: 10.0, currency: "USD" }),
      },
    });
    const facts = fixtureSnapshot(fact);
    const unitEconomics = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 2.0, currency: "USD" },
        shippingMode: "sea_fast",
        targetTacosRate: 0,
      },
    });

    const summary = evaluateDeterministicRiskGates({ facts, unitEconomics });

    expect(summary.status).toBe("warning");
    const rule = summary.rules.find((r) => r.ruleId === "HIGH_FBA_RATIO");
    expect(rule).toBeDefined();
    expect(rule?.severity).toBe("WARNING");
    expect(rule?.status).toBe("triggered");
    expect(rule?.reason).toContain("FBA 履约费用占售价比例畸高");
    expect(rule?.reason).toContain("50.0% >= 40.0%");
    expect(rule?.sourceFields).toContain("facts.profit.fbaFee");
    expect(rule?.sourceFields).toContain("facts.basic.price");
  });

  it("测试 5: 口碑评分过低触发严重预警（LOW_RATING_RISK -> WARNING）", () => {
    // 1) 评分 3.6 且评论数 120 (>= 30) => 触发
    const factLowRating = fixtureFact({
      basic: {
        ...fixtureFact().basic,
        rating: factField(3.6),
        reviewCount: factField(120),
      },
    });
    const facts = fixtureSnapshot(factLowRating);
    const unitEconomics = calculateUnitEconomics({ facts, assumptions: null });

    const summary = evaluateDeterministicRiskGates({ facts, unitEconomics });
    const rule = summary.rules.find((r) => r.ruleId === "LOW_RATING_RISK");
    expect(rule?.status).toBe("triggered");
    expect(rule?.severity).toBe("WARNING");
    expect(rule?.reason).toContain("买家评分过低");
    expect(rule?.reason).toContain("3.6 < 3.8");
    expect(rule?.reason).toContain("不能证明缺陷频率、客诉严重程度或退货率");
    expect(rule?.reason).not.toContain("表明该品类");

    // 2) 评分 3.6 但评论数只有 15 (< 30) => 样本不足，不触发
    const factFewReviews = fixtureFact({
      basic: {
        ...fixtureFact().basic,
        rating: factField(3.6),
        reviewCount: factField(15),
      },
    });
    const summaryFew = evaluateDeterministicRiskGates({
      facts: fixtureSnapshot(factFewReviews),
      unitEconomics,
    });
    const ruleFew = summaryFew.rules.find((r) => r.ruleId === "LOW_RATING_RISK");
    expect(ruleFew?.status).toBe("passed");
  });

  it("测试 6: Amazon 官方自营触发自营竞争预警（AMAZON_BUYBOX_RISK -> WARNING）", () => {
    // 包含 Amazon 或 Amazon.com
    const factAmazonSeller = fixtureFact({
      market: {
        ...fixtureFact().market,
        buyboxSeller: factField("Amazon.com"),
      },
    });
    const facts = fixtureSnapshot(factAmazonSeller);
    const unitEconomics = calculateUnitEconomics({ facts, assumptions: null });

    const summary = evaluateDeterministicRiskGates({ facts, unitEconomics });
    const rule = summary.rules.find((r) => r.ruleId === "AMAZON_BUYBOX_RISK");
    expect(rule?.status).toBe("triggered");
    expect(rule?.severity).toBe("WARNING");
    expect(rule?.reason).toContain("Buybox 卖家为亚马逊自营");
    expect(rule?.reason).toContain("Amazon.com");
    expect(rule?.sourceFields).toEqual(["facts.market.buyboxSeller"]);
  });

  it("测试 7: 大件物流规格触发大件物流预警（OVERSIZE_LOGISTICS_RISK -> WARNING）", () => {
    // 1) 尺寸超标：包装单边长 60 cm (> 45.72 cm)
    const factOversize = fixtureFact({
      profit: {
        ...fixtureFact().profit,
        packageDimensions: factField({ length: 60, width: 30, height: 20, unit: "cm" }),
      },
    });
    const factsOversize = fixtureSnapshot(factOversize);
    const unitEconomics = calculateUnitEconomics({ facts: factsOversize, assumptions: null });

    const summaryOversize = evaluateDeterministicRiskGates({ facts: factsOversize, unitEconomics });
    const ruleOversize = summaryOversize.rules.find((r) => r.ruleId === "OVERSIZE_LOGISTICS_RISK");
    expect(ruleOversize?.status).toBe("triggered");
    expect(ruleOversize?.severity).toBe("WARNING");
    expect(ruleOversize?.reason).toContain("超大超重物流大件");
    expect(ruleOversize?.reason).toContain("最长单边 60.0cm > 45.72cm");

    // 2) 重量超标：包装重量 12 kg (> 9.0718 kg)
    const factOverweight = fixtureFact({
      profit: {
        ...fixtureFact().profit,
        packageWeight: factField({ value: 12.0, unit: "kg" }),
        packageDimensions: factField({ length: 30, width: 20, height: 10, unit: "cm" }),
      },
    });
    const factsOverweight = fixtureSnapshot(factOverweight);
    const summaryOverweight = evaluateDeterministicRiskGates({
      facts: factsOverweight,
      unitEconomics: calculateUnitEconomics({ facts: factsOverweight, assumptions: null }),
    });
    const ruleOverweight = summaryOverweight.rules.find((r) => r.ruleId === "OVERSIZE_LOGISTICS_RISK");
    expect(ruleOverweight?.status).toBe("triggered");
    expect(ruleOverweight?.reason).toContain("计费重 12.00kg > 9.0718kg");
  });

  it("测试 7b: 只有商品本体尺寸/重量时不得输出超大件物流结论（物流尺寸待验证）", () => {
    // 本体 29in（>18in）、本体 4.7lb，但缺少包装尺寸与包装重量：
    // 本体尺寸不能冒充物流外箱尺寸，规则必须保持 not_computable。
    const factItemOnly = fixtureFact({
      profit: {
        ...fixtureFact().profit,
        packageWeight: factField(null),
        packageDimensions: factField(null),
        itemWeight: factField({ value: 4.7, unit: "lb" }),
        itemDimensions: factField({ length: 29, width: 17.75, height: 13.25, unit: "in" }),
      },
    });
    const factsItemOnly = fixtureSnapshot(factItemOnly);
    const summary = evaluateDeterministicRiskGates({
      facts: factsItemOnly,
      unitEconomics: calculateUnitEconomics({ facts: factsItemOnly, assumptions: null }),
    });
    const rule = summary.rules.find((r) => r.ruleId === "OVERSIZE_LOGISTICS_RISK");
    expect(rule?.status).toBe("not_computable");
    expect(rule?.reason).toContain("物流尺寸待验证");
    expect(rule?.reason).not.toContain("超大超重物流大件");
  });

  it("测试 7c: 有包装重量但无包装尺寸时，重量仍可独立触发（不因缺尺寸而整体失效）", () => {
    const factWeightOnly = fixtureFact({
      profit: {
        ...fixtureFact().profit,
        packageDimensions: factField(null),
        packageWeight: factField({ value: 12.0, unit: "kg" }),
        itemDimensions: factField({ length: 10, width: 8, height: 6, unit: "in" }),
      },
    });
    const factsWeightOnly = fixtureSnapshot(factWeightOnly);
    const summary = evaluateDeterministicRiskGates({
      facts: factsWeightOnly,
      unitEconomics: calculateUnitEconomics({ facts: factsWeightOnly, assumptions: null }),
    });
    const rule = summary.rules.find((r) => r.ruleId === "OVERSIZE_LOGISTICS_RISK");
    expect(rule?.status).toBe("triggered");
    expect(rule?.reason).toContain("计费重 12.00kg");
    expect(rule?.reason).not.toContain("最长单边");
  });

  it("测试 8: 多风险同时存在（BLOCK 优先级最高，覆盖所有触发原因）", () => {
    // 同时具备：
    // 1) 单件亏损 (BLOCK)
    // 2) Buybox 卖家为 Amazon (WARNING)
    // 3) FBA 占售价超过 40% (WARNING)
    // 4) 评分 3.5 (WARNING)
    const multiRiskFact = fixtureFact({
      basic: {
        ...fixtureFact().basic,
        price: factField({ amount: 15.0, currency: "USD" }),
        rating: factField(3.5),
        reviewCount: factField(100),
      },
      market: {
        ...fixtureFact().market,
        buyboxSeller: factField("Amazon Services LLC"),
      },
      profit: {
        ...fixtureFact().profit,
        fbaFee: factField({ amount: 8.0, currency: "USD" }), // 8/15 = 53.3% >= 40%
      },
    });
    const facts = fixtureSnapshot(multiRiskFact);
    const unitEconomics = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 10.0, currency: "USD" }, // 售价 15，仅采购+FBA 就已 18 必亏
        shippingMode: "sea_fast",
        targetTacosRate: 0,
      },
    });

    const summary = evaluateDeterministicRiskGates({ facts, unitEconomics });

    // 必须被硬否决
    expect(summary.status).toBe("blocked");
    expect(summary.hasBlockingRisk).toBe(true);
    expect(summary.blockingReasons).toHaveLength(1);
    expect(summary.blockingReasons[0]).toContain("[一票否决]");

    // 同时记录了 3 项警告
    expect(summary.warningReasons.length).toBeGreaterThanOrEqual(3);
    const triggeredRuleIds = summary.rules.filter((r) => r.status === "triggered").map((r) => r.ruleId);
    expect(triggeredRuleIds).toContain("NEGATIVE_NET_PROFIT");
    expect(triggeredRuleIds).toContain("HIGH_FBA_RATIO");
    expect(triggeredRuleIds).toContain("LOW_RATING_RISK");
    expect(triggeredRuleIds).toContain("AMAZON_BUYBOX_RISK");
  });

  it("测试 9: 缺少事实数据时诚实返回 not_computable，绝不虚假误杀", () => {
    // 构造空事实
    const blankFact = fixtureFact({
      basic: {
        ...fixtureFact().basic,
        price: factField(null),
        rating: factField(null),
        reviewCount: factField(null),
      },
      market: {
        ...fixtureFact().market,
        buyboxSeller: factField(null),
      },
      profit: {
        ...fixtureFact().profit,
        fbaFee: factField(null),
        packageWeight: factField(null),
        packageDimensions: factField(null),
      },
      timeSeries: {
        price90dMin: factField(null),
        price90dAvg: factField(null),
        price360dMin: factField(null),
        bsr90dAvg: factField(null),
        bsrDrops90d: factField(null),
        buyBoxAmazonSharePercent: factField(null),
        dealCount90d: factField(null),
      },
      variationAnalysis: {
        childSales: factField(null),
        parentTotalSales: factField(null),
        currentAsinSalesShare: factField(null),
        isDominantVariation: factField(null),
        isMinorVariation: factField(null),
      },
      concentration: {
        brandCr5Share: factField(null),
        amazon1pShare: factField(null),
        sellerMarketShare: factField(null),
        sellerOriginDomesticRatio: factField(null),
      },
    });
    const facts = fixtureSnapshot(blankFact);
    const unitEconomics = calculateUnitEconomics({ facts, assumptions: null });

    const summary = evaluateDeterministicRiskGates({ facts, unitEconomics });

    expect(summary.status).toBe("passed");
    expect(summary.hasBlockingRisk).toBe(false);
    expect(summary.blockingReasons).toHaveLength(0);
    expect(summary.warningReasons).toHaveLength(0);

    // 无法计算的规则均必须标记为 not_computable
    for (const rule of summary.rules) {
      expect(rule.status).toBe("not_computable");
      expect(rule.reason).toContain("缺少");
    }
  });

  it("测试 10: 端到端集成测试（runResearchEngine + buildDecisionSummary + citationIndex）", async () => {
    const fact = fixtureFact();
    const baseInput: ResearchEngineInput = {
      schema: "research-engine-input.v1",
      taskId: "task-risk-integration",
      candidateId: "candidate-risk-integration",
      runId: "run-risk-integration",
      productFact: fact,
      sourceEvidenceRefs: [{
        refId: `evidence:${fact.sourceProof.evidenceId}`,
        source: fact.sourceProof.source,
        captureId: fact.sourceProof.captureId,
        evidenceId: fact.sourceProof.evidenceId,
        subjectKey: fact.subjectKey,
        capturedAt,
        contentHash: proofHash,
        sourceUrl: fact.sourceProof.sourceUrl,
      }],
      researchConfig: {
        locale: "zh-CN",
        focus: ["market", "competition", "voc", "differentiation"],
        maxTokens: 1000,
        timeoutMs: 5000,
      },
      economicAssumptions: {
        // 故意让商品单件严重亏损：售价 $35，采购 $40
        procurementCost: { amount: 40.0, currency: "USD" },
        shippingMode: "sea_fast",
        targetTacosRate: 0,
      },
    };

    const mockInvoker = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        executiveSummary: {
          analysis: { text: "AI生成研报摘要", evidenceRefs: [`evidence:${fact.sourceProof.evidenceId}`] },
        },
      },
      errorCode: null,
      providerCallStarted: true,
    });

    const reportGen = await runResearchEngine(baseInput, { synthesisInvoker: mockInvoker });
    const report = reportGen.report;

    // 1. 验证 report.riskAssessment.deterministicGate 成功生成且被阻断
    expect(report.riskAssessment.deterministicGate).toBeDefined();
    expect(report.riskAssessment.deterministicGate?.hasBlockingRisk).toBe(true);
    expect(report.riskAssessment.deterministicGate?.status).toBe("blocked");

    // 2. 验证 decisionSummary 联动：recommendedNextAction 强制置为 "暂停"
    expect(report.decisionSummary.recommendedNextAction).toBe("暂停");
    expect(report.decisionSummary.blockingRisks[0]).toContain("[一票否决]");
    expect(report.decisionSummary.blockingRisks[0]).toContain("单件净利润为负");

    // 3. 验证 citationIndex 可追溯性：RiskRule -> fieldPath -> citationIndex
    const blockingRule = report.riskAssessment.deterministicGate?.rules.find(
      (r) => r.ruleId === "NEGATIVE_NET_PROFIT",
    );
    expect(blockingRule).toBeDefined();
    // 规则的 sourceFields 包含底层事实 fieldPath
    expect(blockingRule?.sourceFields).toContain("facts.basic.price");
    expect(blockingRule?.sourceFields).toContain("facts.profit.fbaFee");
    // 这些 fieldPath 在 citationIndex 中能够精确查询到证据引用
    const priceCitation = report.citationIndex.find((c) => c.fieldPath === "facts.basic.price");
    expect(priceCitation).toBeDefined();
    expect(priceCitation?.source).toBe("fact");
    expect(priceCitation?.evidenceRefs[0].refId).toBe(`evidence:${fact.sourceProof.evidenceId}`);
    const fbaCitation = report.citationIndex.find((c) => c.fieldPath === "facts.profit.fbaFee");
    expect(fbaCitation).toBeDefined();
    expect(fbaCitation?.source).toBe("fact");
    expect(fbaCitation?.evidenceRefs[0].refId).toBe(`evidence:${fact.sourceProof.evidenceId}`);

    // 4. 验证历史无风控字段报告在 buildDecisionSummary 上的平稳降级
    const legacyReport = {
      ...report,
      riskAssessment: {
        analysis: report.riskAssessment.analysis,
        risks: report.riskAssessment.risks,
        // deterministicGate 缺失
      },
    };
    const legacySummary = buildDecisionSummary(legacyReport);
    expect(legacySummary).toBeDefined();
    expect(["继续研究", "补充数据", "暂停"]).toContain(legacySummary.recommendedNextAction);
  });

  it("测试 11: 边缘变体风险预警（MINOR_VARIATION_RISK -> WARNING）", () => {
    const factMinor = fixtureFact({
      variationAnalysis: {
        childSales: factField(50),
        parentTotalSales: factField(1250),
        currentAsinSalesShare: factField(0.04),
        isDominantVariation: factField(false),
        isMinorVariation: factField(true),
      },
    });
    const facts = fixtureSnapshot(factMinor);
    const unitEconomics = calculateUnitEconomics({ facts, assumptions: null });
    const summary = evaluateDeterministicRiskGates({ facts, unitEconomics });

    const rule = summary.rules.find((r) => r.ruleId === "MINOR_VARIATION_RISK");
    expect(rule).toBeDefined();
    expect(rule?.severity).toBe("WARNING");
    expect(rule?.status).toBe("triggered");
    expect(rule?.reason).toContain("当前 ASIN 为弱势非主力销售变体");
    expect(rule?.reason).toContain("销量可能寄生于父体 Listing");
    expect(rule?.sourceFields).toContain("facts.variationAnalysis.isMinorVariation");
  });

  it("测试 12: 亚马逊自营垄断预警（AMAZON_MONOPOLY_RISK -> WARNING）", () => {
    // 1) buyBoxAmazonSharePercent >= 40%
    const factBuyBox = fixtureFact({
      timeSeries: {
        ...fixtureFact().timeSeries!,
        buyBoxAmazonSharePercent: factField(45),
      },
    });
    const factsBuyBox = fixtureSnapshot(factBuyBox);
    const summaryBuyBox = evaluateDeterministicRiskGates({
      facts: factsBuyBox,
      unitEconomics: calculateUnitEconomics({ facts: factsBuyBox, assumptions: null }),
    });
    const ruleBB = summaryBuyBox.rules.find((r) => r.ruleId === "AMAZON_MONOPOLY_RISK");
    expect(ruleBB?.status).toBe("triggered");
    expect(ruleBB?.severity).toBe("WARNING");
    expect(ruleBB?.reason).toContain("90天自营 Buybox 占有率 45% >= 40%");
    expect(ruleBB?.reason).toContain("官方流量限制与价格压制风险");

    // 2) amazon1pShare >= 40%
    const fact1p = fixtureFact({
      concentration: {
        ...fixtureFact().concentration!,
        amazon1pShare: factField(0.55),
      },
    });
    const facts1p = fixtureSnapshot(fact1p);
    const summary1p = evaluateDeterministicRiskGates({
      facts: facts1p,
      unitEconomics: calculateUnitEconomics({ facts: facts1p, assumptions: null }),
    });
    const rule1p = summary1p.rules.find((r) => r.ruleId === "AMAZON_MONOPOLY_RISK");
    expect(rule1p?.status).toBe("triggered");
    expect(rule1p?.reason).toContain("卖家表自营市场份额 55.0% >= 40%");
  });

  it("测试 13: 历史价格战崩塌一票否决（PRICE_WAR_COLLAPSE_RISK -> BLOCK）", () => {
    // 正常售价 $35，采购 $10, FBA $6, 运费 $1.4 => breakEvenPrice 约为 $19.3
    // 但 90 天历史最低价仅为 $15.0 < breakEvenPrice
    const factPriceWar = fixtureFact({
      basic: {
        ...fixtureFact().basic,
        price: factField({ amount: 35.0, currency: "USD" }),
      },
      timeSeries: {
        ...fixtureFact().timeSeries!,
        price90dMin: factField(15.0),
      },
    });
    const facts = fixtureSnapshot(factPriceWar);
    const unitEconomics = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 10.0, currency: "USD" },
        shippingMode: "sea_fast",
        targetTacosRate: 0,
      },
    });
    const summary = evaluateDeterministicRiskGates({ facts, unitEconomics });

    expect(summary.status).toBe("blocked");
    expect(summary.hasBlockingRisk).toBe(true);
    const rule = summary.rules.find((r) => r.ruleId === "PRICE_WAR_COLLAPSE_RISK");
    expect(rule).toBeDefined();
    expect(rule?.severity).toBe("BLOCK");
    expect(rule?.status).toBe("triggered");
    expect(rule?.reason).toContain("[一票否决] 90天历史最低售价");
    expect(rule?.reason).toContain("已低于当前测算保本售价");
    expect(rule?.sourceFields).toContain("facts.timeSeries.price90dMin");
    expect(rule?.sourceFields).toContain("unitEconomics.deterministic.breakEvenPrice");
  });

  it("测试 14: 高频促销依赖风险预警（HIGH_DEAL_DEPENDENCY_RISK -> WARNING）", () => {
    const factDeal = fixtureFact({
      timeSeries: {
        ...fixtureFact().timeSeries!,
        dealCount90d: factField(8),
      },
    });
    const facts = fixtureSnapshot(factDeal);
    const summary = evaluateDeterministicRiskGates({
      facts,
      unitEconomics: calculateUnitEconomics({ facts, assumptions: null }),
    });

    const rule = summary.rules.find((r) => r.ruleId === "HIGH_DEAL_DEPENDENCY_RISK");
    expect(rule).toBeDefined();
    expect(rule?.severity).toBe("WARNING");
    expect(rule?.status).toBe("triggered");
    expect(rule?.reason).toContain("90天内秒杀促销频次达到 8 次 (>= 6 次)");
    expect(rule?.reason).toContain("严重依赖促销活动");
    expect(rule?.sourceFields).toContain("facts.timeSeries.dealCount90d");
  });

  it("测试 15: 品牌寡头垄断风险预警（BRAND_OLIGOPOLY_RISK -> WARNING）", () => {
    const factOligopoly = fixtureFact({
      concentration: {
        ...fixtureFact().concentration!,
        brandCr5Share: factField(0.78),
      },
    });
    const facts = fixtureSnapshot(factOligopoly);
    const summary = evaluateDeterministicRiskGates({
      facts,
      unitEconomics: calculateUnitEconomics({ facts, assumptions: null }),
    });

    const rule = summary.rules.find((r) => r.ruleId === "BRAND_OLIGOPOLY_RISK");
    expect(rule).toBeDefined();
    expect(rule?.severity).toBe("WARNING");
    expect(rule?.status).toBe("triggered");
    expect(rule?.reason).toContain("细分市场头部前5品牌份额 (CR5) 达到 78.0%");
    expect(rule?.reason).toContain("行业呈现高度寡头垄断");
    expect(rule?.sourceFields).toContain("facts.concentration.brandCr5Share");
  });
});

describe("V5.1 新增 5 大风险规则独立边界与契约完备性测试", () => {
  it("规则 MINOR_VARIATION_RISK: 契约、阈值边界与状态迁移 (true -> triggered, false -> passed, null -> not_computable)", () => {
    // 1. isMinorVariation: true -> triggered (WARNING)
    const factTriggered = fixtureFact({
      variationAnalysis: {
        childSales: factField(100),
        parentTotalSales: factField(2000),
        currentAsinSalesShare: factField(0.05),
        isDominantVariation: factField(false),
        isMinorVariation: factField(true),
      },
    });
    const summaryTriggered = evaluateDeterministicRiskGates({
      facts: fixtureSnapshot(factTriggered),
      unitEconomics: calculateUnitEconomics({ facts: fixtureSnapshot(factTriggered), assumptions: null }),
    });
    const ruleTriggered = summaryTriggered.rules.find((r) => r.ruleId === "MINOR_VARIATION_RISK");
    expect(ruleTriggered).toBeDefined();
    expect(ruleTriggered?.severity).toBe("WARNING");
    expect(ruleTriggered?.status).toBe("triggered");
    expect(ruleTriggered?.sourceFields).toEqual([
      "facts.variationAnalysis.isMinorVariation",
      "facts.variationAnalysis.currentAsinSalesShare",
    ]);
    expect(ruleTriggered?.evidenceRefs?.length ?? 0).toBeGreaterThan(0);
    expect(ruleTriggered?.reason).toContain("[严重预警] 当前 ASIN 为弱势非主力销售变体");

    // 2. isMinorVariation: false -> passed
    const factPassed = fixtureFact({
      variationAnalysis: {
        childSales: factField(800),
        parentTotalSales: factField(1000),
        currentAsinSalesShare: factField(0.8),
        isDominantVariation: factField(true),
        isMinorVariation: factField(false),
      },
    });
    const summaryPassed = evaluateDeterministicRiskGates({
      facts: fixtureSnapshot(factPassed),
      unitEconomics: calculateUnitEconomics({ facts: fixtureSnapshot(factPassed), assumptions: null }),
    });
    const rulePassed = summaryPassed.rules.find((r) => r.ruleId === "MINOR_VARIATION_RISK");
    expect(rulePassed?.status).toBe("passed");
    expect(rulePassed?.reason).toBeNull();
    expect(rulePassed?.evidenceRefs?.length ?? 0).toBeGreaterThan(0);

    // 3. isMinorVariation: null -> not_computable
    const factNull = fixtureFact({
      variationAnalysis: undefined,
    });
    const summaryNull = evaluateDeterministicRiskGates({
      facts: fixtureSnapshot(factNull),
      unitEconomics: calculateUnitEconomics({ facts: fixtureSnapshot(factNull), assumptions: null }),
    });
    const ruleNull = summaryNull.rules.find((r) => r.ruleId === "MINOR_VARIATION_RISK");
    expect(ruleNull?.status).toBe("not_computable");
    expect(ruleNull?.reason).toContain("缺少变体销售拆解数据");
  });

  it("规则 AMAZON_MONOPOLY_RISK: 契约、阈值边界与状态迁移 (BuyBox 40% / Amazon 1P 0.40)", () => {
    // 1. buyBoxAmazonSharePercent: 40% (临界触发) vs 39.9% (临界安全)
    const fact40 = fixtureFact({
      timeSeries: { ...fixtureFact().timeSeries!, buyBoxAmazonSharePercent: factField(40) },
      concentration: { ...fixtureFact().concentration!, amazon1pShare: factField(null) },
    });
    const summary40 = evaluateDeterministicRiskGates({
      facts: fixtureSnapshot(fact40),
      unitEconomics: calculateUnitEconomics({ facts: fixtureSnapshot(fact40), assumptions: null }),
    });
    const rule40 = summary40.rules.find((r) => r.ruleId === "AMAZON_MONOPOLY_RISK");
    expect(rule40?.severity).toBe("WARNING");
    expect(rule40?.status).toBe("triggered");
    expect(rule40?.reason).toContain("40% >= 40%");
    expect(rule40?.sourceFields).toEqual([
      "facts.timeSeries.buyBoxAmazonSharePercent",
      "facts.concentration.amazon1pShare",
    ]);
    expect(rule40?.evidenceRefs?.length ?? 0).toBeGreaterThan(0);

    const fact399 = fixtureFact({
      timeSeries: { ...fixtureFact().timeSeries!, buyBoxAmazonSharePercent: factField(39.9) },
      concentration: { ...fixtureFact().concentration!, amazon1pShare: factField(null) },
    });
    const summary399 = evaluateDeterministicRiskGates({
      facts: fixtureSnapshot(fact399),
      unitEconomics: calculateUnitEconomics({ facts: fixtureSnapshot(fact399), assumptions: null }),
    });
    const rule399 = summary399.rules.find((r) => r.ruleId === "AMAZON_MONOPOLY_RISK");
    expect(rule399?.status).toBe("passed");
    expect(rule399?.reason).toBeNull();

    // 2. amazon1pShare: 0.40 (临界触发) vs 0.39 (临界安全)
    const fact1p40 = fixtureFact({
      timeSeries: { ...fixtureFact().timeSeries!, buyBoxAmazonSharePercent: factField(null) },
      concentration: { ...fixtureFact().concentration!, amazon1pShare: factField(0.40) },
    });
    const summary1p40 = evaluateDeterministicRiskGates({
      facts: fixtureSnapshot(fact1p40),
      unitEconomics: calculateUnitEconomics({ facts: fixtureSnapshot(fact1p40), assumptions: null }),
    });
    const rule1p40 = summary1p40.rules.find((r) => r.ruleId === "AMAZON_MONOPOLY_RISK");
    expect(rule1p40?.status).toBe("triggered");
    expect(rule1p40?.reason).toContain("40.0% >= 40%");

    const fact1p39 = fixtureFact({
      timeSeries: { ...fixtureFact().timeSeries!, buyBoxAmazonSharePercent: factField(null) },
      concentration: { ...fixtureFact().concentration!, amazon1pShare: factField(0.39) },
    });
    const summary1p39 = evaluateDeterministicRiskGates({
      facts: fixtureSnapshot(fact1p39),
      unitEconomics: calculateUnitEconomics({ facts: fixtureSnapshot(fact1p39), assumptions: null }),
    });
    const rule1p39 = summary1p39.rules.find((r) => r.ruleId === "AMAZON_MONOPOLY_RISK");
    expect(rule1p39?.status).toBe("passed");
    expect(rule1p39?.reason).toBeNull();

    // 3. both null -> not_computable
    const factBothNull = fixtureFact({
      timeSeries: { ...fixtureFact().timeSeries!, buyBoxAmazonSharePercent: factField(null) },
      concentration: { ...fixtureFact().concentration!, amazon1pShare: factField(null) },
    });
    const summaryBothNull = evaluateDeterministicRiskGates({
      facts: fixtureSnapshot(factBothNull),
      unitEconomics: calculateUnitEconomics({ facts: fixtureSnapshot(factBothNull), assumptions: null }),
    });
    const ruleBothNull = summaryBothNull.rules.find((r) => r.ruleId === "AMAZON_MONOPOLY_RISK");
    expect(ruleBothNull?.status).toBe("not_computable");
    expect(ruleBothNull?.reason).toContain("缺少亚马逊自营时序占有率与卖家市场份额数据");
  });

  it("规则 PRICE_WAR_COLLAPSE_RISK: 契约、阈值边界与状态迁移 (< breakEvenPrice 触发 BLOCK，>= breakEvenPrice 通过)", () => {
    const baseFact = fixtureFact({
      basic: { ...fixtureFact().basic, price: factField({ amount: 35.0, currency: "USD" }) },
    });
    const ue = calculateUnitEconomics({
      facts: fixtureSnapshot(baseFact),
      assumptions: { procurementCost: { amount: 10.0, currency: "USD" }, shippingMode: "sea_fast", targetTacosRate: 0 },
    });
    const breakEven = ue.breakEvenPrice?.value?.amount;
    expect(typeof breakEven).toBe("number");
    const bep = breakEven!;

    // 1. price90dMin < bep (bep - 0.01) -> triggered (BLOCK)
    const factBelow = fixtureFact({
      basic: { ...fixtureFact().basic, price: factField({ amount: 35.0, currency: "USD" }) },
      timeSeries: { ...fixtureFact().timeSeries!, price90dMin: factField(Number((bep - 0.01).toFixed(2))) },
    });
    const summaryBelow = evaluateDeterministicRiskGates({
      facts: fixtureSnapshot(factBelow),
      unitEconomics: ue,
    });
    const ruleBelow = summaryBelow.rules.find((r) => r.ruleId === "PRICE_WAR_COLLAPSE_RISK");
    expect(ruleBelow?.severity).toBe("BLOCK");
    expect(ruleBelow?.status).toBe("triggered");
    expect(ruleBelow?.reason).toContain("[一票否决] 90天历史最低售价");
    expect(ruleBelow?.sourceFields).toEqual([
      "facts.timeSeries.price90dMin",
      "unitEconomics.deterministic.breakEvenPrice",
    ]);
    expect(ruleBelow?.evidenceRefs?.length ?? 0).toBeGreaterThan(0);

    // 2. price90dMin === bep -> passed (临界恰好保本未击穿)
    const factEqual = fixtureFact({
      basic: { ...fixtureFact().basic, price: factField({ amount: 35.0, currency: "USD" }) },
      timeSeries: { ...fixtureFact().timeSeries!, price90dMin: factField(bep) },
    });
    const summaryEqual = evaluateDeterministicRiskGates({
      facts: fixtureSnapshot(factEqual),
      unitEconomics: ue,
    });
    const ruleEqual = summaryEqual.rules.find((r) => r.ruleId === "PRICE_WAR_COLLAPSE_RISK");
    expect(ruleEqual?.status).toBe("passed");
    expect(ruleEqual?.reason).toBeNull();

    // 3. price90dMin > bep (bep + 1.0) -> passed
    const factAbove = fixtureFact({
      basic: { ...fixtureFact().basic, price: factField({ amount: 35.0, currency: "USD" }) },
      timeSeries: { ...fixtureFact().timeSeries!, price90dMin: factField(Number((bep + 1.0).toFixed(2))) },
    });
    const summaryAbove = evaluateDeterministicRiskGates({
      facts: fixtureSnapshot(factAbove),
      unitEconomics: ue,
    });
    const ruleAbove = summaryAbove.rules.find((r) => r.ruleId === "PRICE_WAR_COLLAPSE_RISK");
    expect(ruleAbove?.status).toBe("passed");
    expect(ruleAbove?.reason).toBeNull();

    // 4. price90dMin null -> not_computable
    const factNullPrice = fixtureFact({
      timeSeries: { ...fixtureFact().timeSeries!, price90dMin: factField(null) },
    });
    const summaryNullPrice = evaluateDeterministicRiskGates({
      facts: fixtureSnapshot(factNullPrice),
      unitEconomics: ue,
    });
    const ruleNullPrice = summaryNullPrice.rules.find((r) => r.ruleId === "PRICE_WAR_COLLAPSE_RISK");
    expect(ruleNullPrice?.status).toBe("not_computable");
    expect(ruleNullPrice?.reason).toContain("缺少 90 天历史最低价或保本售价");
  });

  it("规则 HIGH_DEAL_DEPENDENCY_RISK: 契约、阈值边界与状态迁移 (dealCount >= 6 触发，< 6 通过)", () => {
    // 1. dealCount90d: 6 (临界触发)
    const fact6 = fixtureFact({
      timeSeries: { ...fixtureFact().timeSeries!, dealCount90d: factField(6) },
    });
    const summary6 = evaluateDeterministicRiskGates({
      facts: fixtureSnapshot(fact6),
      unitEconomics: calculateUnitEconomics({ facts: fixtureSnapshot(fact6), assumptions: null }),
    });
    const rule6 = summary6.rules.find((r) => r.ruleId === "HIGH_DEAL_DEPENDENCY_RISK");
    expect(rule6?.severity).toBe("WARNING");
    expect(rule6?.status).toBe("triggered");
    expect(rule6?.reason).toContain("90天内秒杀促销频次达到 6 次 (>= 6 次)");
    expect(rule6?.sourceFields).toEqual(["facts.timeSeries.dealCount90d"]);
    expect(rule6?.evidenceRefs?.length ?? 0).toBeGreaterThan(0);

    // 2. dealCount90d: 5 (临界安全)
    const fact5 = fixtureFact({
      timeSeries: { ...fixtureFact().timeSeries!, dealCount90d: factField(5) },
    });
    const summary5 = evaluateDeterministicRiskGates({
      facts: fixtureSnapshot(fact5),
      unitEconomics: calculateUnitEconomics({ facts: fixtureSnapshot(fact5), assumptions: null }),
    });
    const rule5 = summary5.rules.find((r) => r.ruleId === "HIGH_DEAL_DEPENDENCY_RISK");
    expect(rule5?.status).toBe("passed");
    expect(rule5?.reason).toBeNull();

    // 3. dealCount90d: null -> not_computable
    const factNull = fixtureFact({
      timeSeries: { ...fixtureFact().timeSeries!, dealCount90d: factField(null) },
    });
    const summaryNull = evaluateDeterministicRiskGates({
      facts: fixtureSnapshot(factNull),
      unitEconomics: calculateUnitEconomics({ facts: fixtureSnapshot(factNull), assumptions: null }),
    });
    const ruleNull = summaryNull.rules.find((r) => r.ruleId === "HIGH_DEAL_DEPENDENCY_RISK");
    expect(ruleNull?.status).toBe("not_computable");
    expect(ruleNull?.reason).toContain("缺少 90 天秒杀促销频次数据");
  });

  it("规则 BRAND_OLIGOPOLY_RISK: 契约、阈值边界与状态迁移 (brandCr5Share >= 0.70 触发，< 0.70 通过)", () => {
    // 1. brandCr5Share: 0.70 (临界触发)
    const fact70 = fixtureFact({
      concentration: { ...fixtureFact().concentration!, brandCr5Share: factField(0.70) },
    });
    const summary70 = evaluateDeterministicRiskGates({
      facts: fixtureSnapshot(fact70),
      unitEconomics: calculateUnitEconomics({ facts: fixtureSnapshot(fact70), assumptions: null }),
    });
    const rule70 = summary70.rules.find((r) => r.ruleId === "BRAND_OLIGOPOLY_RISK");
    expect(rule70?.severity).toBe("WARNING");
    expect(rule70?.status).toBe("triggered");
    expect(rule70?.reason).toContain("达到 70.0% (>= 70%)");
    expect(rule70?.sourceFields).toEqual(["facts.concentration.brandCr5Share"]);
    expect(rule70?.evidenceRefs?.length ?? 0).toBeGreaterThan(0);

    // 2. brandCr5Share: 0.69 (临界安全)
    const fact69 = fixtureFact({
      concentration: { ...fixtureFact().concentration!, brandCr5Share: factField(0.69) },
    });
    const summary69 = evaluateDeterministicRiskGates({
      facts: fixtureSnapshot(fact69),
      unitEconomics: calculateUnitEconomics({ facts: fixtureSnapshot(fact69), assumptions: null }),
    });
    const rule69 = summary69.rules.find((r) => r.ruleId === "BRAND_OLIGOPOLY_RISK");
    expect(rule69?.status).toBe("passed");
    expect(rule69?.reason).toBeNull();

    // 3. brandCr5Share: null -> not_computable
    const factNull = fixtureFact({
      concentration: { ...fixtureFact().concentration!, brandCr5Share: factField(null) },
    });
    const summaryNull = evaluateDeterministicRiskGates({
      facts: fixtureSnapshot(factNull),
      unitEconomics: calculateUnitEconomics({ facts: fixtureSnapshot(factNull), assumptions: null }),
    });
    const ruleNull = summaryNull.rules.find((r) => r.ruleId === "BRAND_OLIGOPOLY_RISK");
    expect(ruleNull?.status).toBe("not_computable");
    expect(ruleNull?.reason).toContain("缺少品牌集中度 CR5 数据");
  });
});
