import { describe, expect, it, vi } from "vitest";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import type { ResearchEngineInput } from "@/lib/research/researchContracts";
import {
  calculateChargeableWeightKg,
  calculateUnitEconomics,
} from "./unitEconomicsCalculator";
import { runResearchEngine } from "./researchEngine";

const capturedAt = "2026-09-25T00:00:00.000Z";
const proofHash = "b".repeat(64);

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
    subjectKey: "amazon:US:B0TEST9999",
    sourceProof: {
      source: "sellersprite_plugin",
      captureId: "cap-99",
      evidenceId: "ev-cap-99-unit-economics",
      subjectKey: "amazon:US:B0TEST9999",
      capturedAt,
      contentHash: proofHash,
      sourceUrl: "https://www.amazon.com/dp/B0TEST9999",
      operator: "owner:v1",
    },
    basic: {
      asin: factField("B0TEST9999"),
      title: factField("测试商品标题"),
      image: factField("https://images.example.test/product.jpg"),
      brand: factField("测试品牌"),
      category: factField("Kitchen"),
      price: factField({ amount: 30.0, currency: "USD" }),
      rating: factField(4.5),
      reviewCount: factField(500),
      bulletPoints: factField(["五点描述"]),
    },
    market: {
      bsr: factField(500),
      monthlySalesEstimate: factField(300),
      monthlyRevenueEstimate: factField({ amount: 9000, currency: "USD" }),
      launchedDate: factField("2024-01-01"),
    },
    profit: {
      packageWeight: factField({ value: 0.5, unit: "kg" }),
      packageDimensions: factField({ length: 20, width: 15, height: 10, unit: "cm" }),
      fbaFee: factField({ amount: 5.0, currency: "USD" }),
    },
    ...overrides,
  };
}

function fixtureSnapshot(fact: ProductFact = fixtureFact()) {
  const proofRef = {
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
      asin: { ...fact.basic.asin, evidenceRefs: [proofRef] },
      title: { ...fact.basic.title, evidenceRefs: [proofRef] },
      image: { ...fact.basic.image, evidenceRefs: [proofRef] },
      brand: { ...fact.basic.brand, evidenceRefs: [proofRef] },
      category: { ...fact.basic.category, evidenceRefs: [proofRef] },
      price: { ...fact.basic.price, evidenceRefs: [proofRef] },
      rating: { ...fact.basic.rating, evidenceRefs: [proofRef] },
      reviewCount: { ...fact.basic.reviewCount, evidenceRefs: [proofRef] },
      bulletPoints: { ...fact.basic.bulletPoints, evidenceRefs: [proofRef] },
    },
    market: {
      bsr: { ...fact.market.bsr, evidenceRefs: [proofRef] },
      monthlySalesEstimate: { ...fact.market.monthlySalesEstimate, evidenceRefs: [proofRef] },
      monthlyRevenueEstimate: { ...fact.market.monthlyRevenueEstimate, evidenceRefs: [proofRef] },
      launchedDate: { ...fact.market.launchedDate, evidenceRefs: [proofRef] },
      subCategoryBsr: { value: null, status: "missing" as const, source: fact.sourceProof.source, confidence: 0, capturedAt, rawProofHash: proofHash, evidenceRefs: [proofRef] },
      dateFirstAvailable: { value: null, status: "missing" as const, source: fact.sourceProof.source, confidence: 0, capturedAt, rawProofHash: proofHash, evidenceRefs: [proofRef] },
      buyboxSeller: { value: null, status: "missing" as const, source: fact.sourceProof.source, confidence: 0, capturedAt, rawProofHash: proofHash, evidenceRefs: [proofRef] },
      fulfillmentType: { value: null, status: "missing" as const, source: fact.sourceProof.source, confidence: 0, capturedAt, rawProofHash: proofHash, evidenceRefs: [proofRef] },
      estimatedGrossMargin: { value: null, status: "missing" as const, source: fact.sourceProof.source, confidence: 0, capturedAt, rawProofHash: proofHash, evidenceRefs: [proofRef] },
      listingQualityScore: { value: null, status: "missing" as const, source: fact.sourceProof.source, confidence: 0, capturedAt, rawProofHash: proofHash, evidenceRefs: [proofRef] },
    },
    profit: {
      packageWeight: { ...fact.profit.packageWeight, evidenceRefs: [proofRef] },
      packageDimensions: { ...fact.profit.packageDimensions, evidenceRefs: [proofRef] },
      fbaFee: { ...fact.profit.fbaFee, evidenceRefs: [proofRef] },
      itemWeight: { value: null, status: "missing" as const, source: fact.sourceProof.source, confidence: 0, capturedAt, rawProofHash: proofHash, evidenceRefs: [proofRef] },
      itemDimensions: { value: null, status: "missing" as const, source: fact.sourceProof.source, confidence: 0, capturedAt, rawProofHash: proofHash, evidenceRefs: [proofRef] },
    },
    keywordEvidence: {
      topKeywords: { value: null, status: "missing" as const, source: fact.sourceProof.source, confidence: 0, capturedAt, rawProofHash: proofHash, evidenceRefs: [proofRef] },
    },
  };
}

describe("历史低价压力测算", () => {
  it("按历史低价计算佣金及毛利率，净利同样使用该价格", () => {
    const base = fixtureSnapshot();
    const missing = { ...base.basic.price, value: null, status: "missing" as const };
    const facts = { ...base, timeSeries: {
      price90dMin: { ...base.basic.price, value: 20 },
      price90dAvg: missing, price360dMin: missing, bsr90dAvg: missing,
      bsrDrops90d: missing, buyBoxAmazonSharePercent: missing, dealCount90d: missing,
    } };
    const result = calculateUnitEconomics({
      facts,
      assumptions: { procurementCost: { amount: 4, currency: "USD" }, shippingMode: "sea_fast", targetTacosRate: 0.1, commissionRate: 0.15 },
    });
    // 到岸 5.25、FBA 5、历史价佣金 3、广告 2。
    expect(result.stressMargin?.value).toBe(0.3375);
    expect(result.stressNetProfit?.value).toEqual({ amount: 4.75, currency: "USD" });
  });
});

describe("RDO-1 Unit Economics 测算引擎测试", () => {
  it("测试 1: 输入完整成本（USD），精准验证利润与保本公式", () => {
    const facts = fixtureSnapshot();
    // 售价 $30.00, FBA $5.00, 实重 0.5kg, 体积 20*15*10cm = 3000cm3 / 6000 = 0.5kg
    // chargeableWeight = 0.5kg
    // shippingMode: sea_fast ($2.5/kg) => shipping = 0.5 * 2.5 = $1.25
    // procurementCost: $4.00 USD => landedCost = 4.00 + 1.25 = $5.25
    // targetTacosRate: 0.10 (10%) => adCost = 30 * 0.10 = $3.00
    // totalCost = landedCost(5.25) + fba(5.00) + ad(3.00) = $13.25
    // grossProfit = 30.00 - 5.25 - 5.00 = $19.75
    // grossMargin = 19.75 / 30.00 = 0.6583
    // netProfit = 30.00 - 13.25 = $16.75
    // netMargin = 16.75 / 30.00 = 0.5583
    // breakEvenPrice = (5.25 + 5.00) / (1 - 0.10) = 10.25 / 0.90 = $11.39
    const result = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 4.0, currency: "USD" },
        shippingMode: "sea_fast",
        targetTacosRate: 0.1,
      },
    });

    expect(result.knownRevenueAfterFbaFee.value).toEqual({ amount: 25.0, currency: "USD" });
    expect(result.grossProfit.status).toBe("available");
    expect(result.grossProfit.value).toEqual({ amount: 19.75, currency: "USD" });
    expect(result.grossMargin.value).toBe(0.6583);
    expect(result.netProfit.status).toBe("available");
    expect(result.netProfit.value).toEqual({ amount: 16.75, currency: "USD" });
    expect(result.netMargin.value).toBe(0.5583);
    expect(result.roi.value).toBe(3.1905);
    expect(result.inputMetadata.targetTacosRate.metricNature).toBe("USER_INPUT");
    expect(result.breakEvenPrice.status).toBe("available");
    expect(result.breakEvenPrice.value).toEqual({ amount: 11.39, currency: "USD" });

    expect(result.costBreakdown).toEqual({
      procurementCostUsd: 4.0,
      shippingUsd: 1.25,
      landedCostUsd: 5.25,
      fbaFeeUsd: 5.0,
      adCostUsd: 3.0,
      totalCostUsd: 13.25,
    });
  });

  it("测试 2: 没有输入时，完全保持旧逻辑（grossProfit 为 null）", () => {
    const facts = fixtureSnapshot();
    const result = calculateUnitEconomics({ facts, assumptions: null });

    expect(result.knownRevenueAfterFbaFee.value).toEqual({ amount: 25.0, currency: "USD" });
    expect(result.grossProfit.value).toBeNull();
    expect(result.grossProfit.status).toBe("not_computable");
    expect(result.grossProfit.reason).toContain("缺少成本数据");
    expect(result.grossMargin.status).toBe("not_computable");
    expect(result.netProfit.status).toBe("not_computable");
    expect(result.breakEvenPrice.status).toBe("not_computable");
    expect(result.costBreakdown).toBeNull();
  });

  it("测试 3: CNY 采购成本折算为 USD 汇率测试", () => {
    const facts = fixtureSnapshot();
    // procurementCost: 36 CNY, exchangeRate: 7.2 => procurementCostUsd = 36 / 7.2 = $5.00
    // shippingMode: sea_economy ($1.5/kg) * 0.5kg = $0.75
    // landedCost = 5.00 + 0.75 = $5.75
    const result = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 36.0, currency: "CNY" },
        exchangeRate: 7.2,
        shippingMode: "sea_economy",
        targetTacosRate: 0,
      },
    });

    expect(result.costBreakdown?.procurementCostUsd).toBe(5.0);
    expect(result.costBreakdown?.shippingUsd).toBe(0.75);
    expect(result.costBreakdown?.landedCostUsd).toBe(5.75);
    expect(result.grossProfit.value).toEqual({ amount: 19.25, currency: "USD" });
  });

  it("测试 4: 抛货体积重判定测试（大体积商品按体积重计费）", () => {
    const fact = fixtureFact({
      profit: {
        packageWeight: factField({ value: 1.0, unit: "lb" }), // 1 lb = 0.4536 kg
        // 10 x 8 x 6 in => 25.4 x 20.32 x 15.24 cm = 7865.79 cm3
        // sea_fast (divisor 6000) => 7865.79 / 6000 = 1.3110 kg
        // chargeableWeight should be max(0.4536, 1.3110) = 1.3110 kg
        packageDimensions: factField({ length: 10, width: 8, height: 6, unit: "in" }),
        fbaFee: factField({ amount: 6.0, currency: "USD" }),
      },
    });
    const facts = fixtureSnapshot(fact);

    const weightInfo = calculateChargeableWeightKg(facts, "sea_fast");
    expect(weightInfo.actualWeightKg).toBe(0.4536);
    expect(weightInfo.volumeWeightKg).toBe(1.311);
    expect(weightInfo.chargeableWeightKg).toBe(1.311);

    const result = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 2.0, currency: "USD" },
        shippingMode: "sea_fast", // rate: 2.5 => shipping = 1.311 * 2.5 = 3.28
        targetTacosRate: 0,
      },
    });

    expect(result.costBreakdown?.shippingUsd).toBe(3.28);
    expect(result.costBreakdown?.landedCostUsd).toBe(5.28);
  });

  it("测试 5: 非法负数输入与异常参数降级拦截", () => {
    const facts = fixtureSnapshot();

    // 负数采购成本
    const resNegativeProcurement = calculateUnitEconomics({
      facts,
      assumptions: { procurementCost: { amount: -5.0, currency: "USD" } },
    });
    expect(resNegativeProcurement.grossProfit.status).toBe("not_computable");
    expect(resNegativeProcurement.grossProfit.reason).toContain("不能为负数");

    // 负数广告费率
    const resNegativeTacos = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 5.0, currency: "USD" },
        targetTacosRate: -0.1,
      },
    });
    expect(resNegativeTacos.grossProfit.status).toBe("not_computable");
    expect(resNegativeTacos.grossProfit.reason).toContain("不能为负数");

    // 负数汇率
    const resNegativeRate = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 35.0, currency: "CNY" },
        exchangeRate: -7.2,
      },
    });
    expect(resNegativeRate.grossProfit.status).toBe("not_computable");
    expect(resNegativeRate.grossProfit.reason).toContain("汇率必须为正数");

    // 广告费率 >= 100% 导致无法保本
    const resOverTacos = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 5.0, currency: "USD" },
        shippingMode: "sea_fast",
        targetTacosRate: 1.05,
      },
    });
    expect(resOverTacos.grossProfit.status).toBe("available");
    expect(resOverTacos.breakEvenPrice.status).toBe("not_computable");
    expect(resOverTacos.breakEvenPrice.reason).toContain("超过 100%");
  });

  it("测试 6: Research Engine 端到端接入与 reportHash 变化测试", async () => {
    const fact = fixtureFact();
    const baseInput: ResearchEngineInput = {
      schema: "research-engine-input.v1",
      taskId: "task-economic-test",
      candidateId: "candidate-economic-test",
      runId: "run-economic-test",
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
    };

    const mockInvoker = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        executiveSummary: {
          analysis: { text: "研报摘要", evidenceRefs: [`evidence:${fact.sourceProof.evidenceId}`] },
        },
      },
      errorCode: null,
      providerCallStarted: true,
    });

    // 1. 无假设运行
    const reportGenNoAssumptions = await runResearchEngine(baseInput, { synthesisInvoker: mockInvoker });
    expect(reportGenNoAssumptions.report.unitEconomics.deterministic.grossProfit.status).toBe("not_computable");
    expect(reportGenNoAssumptions.report.decisionSummary.missingInformation).toContain("采购成本、头程物流与其他经营成本");

    // 2. 有假设运行
    const inputWithAssumptions: ResearchEngineInput = {
      ...baseInput,
      economicAssumptions: {
        procurementCost: { amount: 5.0, currency: "USD" },
        shippingMode: "sea_fast",
        targetTacosRate: 0.12,
      },
    };

    const reportGenWithAssumptions = await runResearchEngine(inputWithAssumptions, { synthesisInvoker: mockInvoker });
    expect(reportGenWithAssumptions.report.unitEconomics.deterministic.grossProfit.status).toBe("available");
    expect(reportGenWithAssumptions.report.unitEconomics.deterministic.grossProfit.value).toEqual({ amount: 18.75, currency: "USD" });
    expect(reportGenWithAssumptions.report.unitEconomics.deterministic.netProfit?.status).toBe("available");
    expect(reportGenWithAssumptions.report.unitEconomics.deterministic.costBreakdown?.landedCostUsd).toBe(6.25);

    // 3. 校验 missingInformation 不再包含缺少采购成本提示
    expect(reportGenWithAssumptions.report.decisionSummary.missingInformation).not.toContain("采购成本、头程物流与其他经营成本");

    // 4. 强校验 reportHash 必然发生变化，且受 CAS 保护
    expect(reportGenWithAssumptions.reportHash).not.toBe(reportGenNoAssumptions.reportHash);
    expect(typeof reportGenWithAssumptions.reportHash).toBe("string");
    expect(reportGenWithAssumptions.reportHash.length).toBe(64);
  });

  it("测试 7: 物流规格缺失时（无 packageWeight/packageDimensions/itemWeight/itemDimensions），禁止默认 shippingUsd=0，全部返回 not_computable", () => {
    // 构造规格全空的商品事实
    const factWithoutSpecs = fixtureFact({
      profit: {
        packageWeight: factField(null),
        packageDimensions: factField(null),
        fbaFee: factField({ amount: 5.0, currency: "USD" }),
      },
    });
    const facts = fixtureSnapshot(factWithoutSpecs);

    const result = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 5.0, currency: "USD" },
        shippingMode: "sea_fast",
        targetTacosRate: 0,
      },
    });

    // 校验：不能擅自默认 shippingUsd = 0 并计算出虚假利润
    expect(result.grossProfit.status).toBe("not_computable");
    expect(result.grossProfit.value).toBeNull();
    expect(result.grossProfit.reason).toContain("缺少包装重量和包装尺寸");
    expect(result.grossMargin.status).toBe("not_computable");
    expect(result.netProfit.status).toBe("not_computable");
    expect(result.netMargin.status).toBe("not_computable");
    expect(result.breakEvenPrice.status).toBe("not_computable");
    expect(result.costBreakdown).toBeNull();
  });

  it("商品净重和单品尺寸不能替代包装数据计算头程计费重", () => {
    const fact = fixtureFact({
      profit: {
        packageWeight: factField(null),
        packageDimensions: factField(null),
        fbaFee: factField({ amount: 5, currency: "USD" }),
        itemWeight: factField({ value: 0.4, unit: "kg" }),
        itemDimensions: factField({ length: 20, width: 10, height: 5, unit: "cm" }),
      },
    });
    const snapshot = fixtureSnapshot(fact);
    const result = calculateChargeableWeightKg({
      ...snapshot,
      profit: {
        ...snapshot.profit,
        itemWeight: { ...fact.profit.itemWeight!, evidenceRefs: [] },
        itemDimensions: { ...fact.profit.itemDimensions!, evidenceRefs: [] },
      },
    });

    expect(result).toEqual({ chargeableWeightKg: null, actualWeightKg: null, volumeWeightKg: null });
  });

  it("测试 8: price 与 fbaFee 币种不一致时（如 USD 与 CAD/EUR），禁止直接相减，必须返回 not_computable", () => {
    // 构造售价为 USD 但 FBA 费用为 EUR 的事实
    const factCurrencyMismatch = fixtureFact({
      basic: {
        asin: factField("B0TEST9999"),
        title: factField("测试商品标题"),
        image: factField("https://images.example.test/product.jpg"),
        brand: factField("测试品牌"),
        category: factField("Kitchen"),
        price: factField({ amount: 30.0, currency: "USD" }),
        rating: factField(4.5),
        reviewCount: factField(500),
        bulletPoints: factField(["五点描述"]),
      },
      profit: {
        packageWeight: factField({ value: 0.5, unit: "kg" }),
        packageDimensions: factField({ length: 20, width: 15, height: 10, unit: "cm" }),
        fbaFee: factField({ amount: 5.0, currency: "EUR" }), // 币种不一致！
      },
    });
    const facts = fixtureSnapshot(factCurrencyMismatch);

    const result = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 5.0, currency: "USD" },
        shippingMode: "sea_fast",
        targetTacosRate: 0,
      },
    });

    expect(result.knownRevenueAfterFbaFee.status).toBe("not_computable");
    expect(result.knownRevenueAfterFbaFee.value).toBeNull();
    expect(result.grossProfit.status).toBe("not_computable");
    expect(result.grossProfit.value).toBeNull();
    expect(result.grossProfit.reason).toContain("币种 (USD) 与 FBA 费用币种 (EUR) 不一致");
    expect(result.netProfit.status).toBe("not_computable");
    expect(result.costBreakdown).toBeNull();
  });

  it("R4-B：缺少广告费率不默认按 0，且过期引用显式 fail-closed", () => {
    const facts = fixtureSnapshot();
    const missingRate = calculateUnitEconomics({
      facts,
      assumptions: { procurementCost: { amount: 5, currency: "USD" }, shippingMode: "sea_fast" },
    });
    expect(missingRate.grossProfit.status).toBe("not_computable");
    expect(missingRate.inputMetadata.targetTacosRate.metricNature).toBe("MISSING");
    expect(missingRate.grossProfit.reason).toContain("不默认按 0");

    const stale = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 5, currency: "USD" },
        shippingMode: "sea_fast",
        targetTacosRate: 0.1,
        metadata: {
          procurementCost: {
            marketplace: "US",
            effectiveDate: "2024-01-01T00:00:00.000Z",
            source: "old_supplier_quote",
            metricNature: "CONFIRMED_REFERENCE",
            currency: "USD",
          },
        },
      },
    });
    expect(stale.grossProfit.status).toBe("not_computable");
    expect(stale.inputMetadata.procurementCost.state).toBe("STALE_REFERENCE");
    expect(stale.grossProfit.reason).toContain("STALE_REFERENCE");
  });
});

describe("V6 用户情景假设接入单位经济性引擎", () => {
  it("用户提供的包装重量/尺寸可补齐缺失事实，并标记为 USER_INPUT", () => {
    const factWithoutPackaging = fixtureFact({
      profit: {
        packageWeight: factField(null),
        packageDimensions: factField(null),
        fbaFee: factField({ amount: 5.0, currency: "USD" }),
      },
    });
    const facts = fixtureSnapshot(factWithoutPackaging);

    // 事实缺失 → 历史行为：不可计算
    const withoutUser = calculateUnitEconomics({
      facts,
      assumptions: { procurementCost: { amount: 4, currency: "USD" }, shippingMode: "sea_fast", targetTacosRate: 0 },
    });
    expect(withoutUser.grossProfit.status).toBe("not_computable");

    // 用户补齐包装参数 → 可计算
    const withUser = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 4, currency: "USD" },
        shippingMode: "sea_fast",
        targetTacosRate: 0,
        packageWeight: { value: 500, unit: "g" },
        packageDimensions: { length: 20, width: 15, height: 10, unit: "cm" },
      },
    });
    expect(withUser.grossProfit.status).toBe("available");
    expect(withUser.inputMetadata.packageWeight.metricNature).toBe("USER_INPUT");
    expect(withUser.chargeableWeightKg).toBe(0.5);
    expect(withUser.costBreakdown?.shippingUsd).toBe(1.25);
    expect(withUser.freightBasis).toBe("chargeable_weight");
  });

  it("事实优先：已核验事实存在时用户值不覆盖事实", () => {
    const facts = fixtureSnapshot(); // 事实：包装 0.5kg / FBA $5
    const result = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 4, currency: "USD" },
        shippingMode: "sea_fast",
        targetTacosRate: 0,
        packageWeight: { value: 5, unit: "kg" },
        fbaFee: { amount: 99, currency: "USD" },
      },
    });
    expect(result.inputMetadata.packageWeight.metricNature).toBe("CONFIRMED_REFERENCE");
    expect(result.inputMetadata.fbaFee.metricNature).toBe("CONFIRMED_REFERENCE");
    expect(result.costBreakdown?.fbaFeeUsd).toBe(5.0);
    expect(result.chargeableWeightKg).toBe(0.5);
  });

  it("平台佣金：提供时纳入成本与保本售价公式；缺省时公式与历史完全一致并显式登记未纳入", () => {
    const facts = fixtureSnapshot();
    const base = calculateUnitEconomics({
      facts,
      assumptions: { procurementCost: { amount: 4, currency: "USD" }, shippingMode: "sea_fast", targetTacosRate: 0.1 },
    });
    expect(base.commissionIncluded).toBe(false);
    expect(base.costBreakdown?.commissionUsd).toBeUndefined();
    expect(base.breakEvenPrice.value).toEqual({ amount: 11.39, currency: "USD" });
    expect(base.excludedCosts).toContain("平台佣金（Amazon 佣金/推荐费）");
    // 佣金属于「补齐后即可纳入」，不能与「模型始终不纳入」混为一组
    expect(base.conditionalExcludedCosts).toEqual(["平台佣金（Amazon 佣金/推荐费）"]);
    expect(base.alwaysExcludedCosts).not.toContain("平台佣金（Amazon 佣金/推荐费）");
    expect(base.alwaysExcludedCosts.length).toBeGreaterThan(0);
    expect(base.partialCostBasis).toBe(true);

    const withCommission = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 4, currency: "USD" },
        shippingMode: "sea_fast",
        targetTacosRate: 0.1,
        commissionRate: 0.15,
      },
    });
    // 售价 30，佣金 = 4.50；到岸 5.25；FBA 5.00；广告 3.00
    expect(withCommission.commissionIncluded).toBe(true);
    expect(withCommission.costBreakdown?.commissionUsd).toBe(4.5);
    expect(withCommission.costBreakdown?.totalCostUsd).toBe(17.75);
    expect(withCommission.grossProfit.value).toEqual({ amount: 15.25, currency: "USD" });
    expect(withCommission.netProfit.value).toEqual({ amount: 12.25, currency: "USD" });
    // 保本 = (5.25 + 5.00) / (1 - 0.10 - 0.15) = 10.25 / 0.75 = 13.67
    expect(withCommission.breakEvenPrice.value).toEqual({ amount: 13.67, currency: "USD" });
    expect(withCommission.excludedCosts).not.toContain("平台佣金（Amazon 佣金/推荐费）");
    expect(withCommission.conditionalExcludedCosts).toEqual([]);
  });

  it("用户直接给出的单件头程费用按单件计入，跳过计费重推导", () => {
    const facts = fixtureSnapshot();
    const result = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 4, currency: "USD" },
        targetTacosRate: 0,
        unitLogisticsCost: { amount: 3.5, currency: "USD" },
      },
    });
    expect(result.freightBasis).toBe("per_unit");
    expect(result.chargeableWeightKg).toBeNull();
    expect(result.costBreakdown?.shippingUsd).toBe(3.5);
    expect(result.costBreakdown?.landedCostUsd).toBe(7.5);
    expect(result.inputMetadata.shippingRate.metricNature).toBe("USER_INPUT");
  });

  it("目标售价覆盖事实售价并标记 USER_INPUT；缺少广告费率仍 fail-closed", () => {
    const facts = fixtureSnapshot();
    const result = calculateUnitEconomics({
      facts,
      assumptions: {
        procurementCost: { amount: 4, currency: "USD" },
        shippingMode: "sea_fast",
        targetTacosRate: 0,
        targetSellingPrice: { amount: 20, currency: "USD" },
      },
    });
    expect(result.effectiveSellingPrice).toEqual({ amount: 20, currency: "USD" });
    expect(result.inputMetadata.sellingPrice.metricNature).toBe("USER_INPUT");
    // 到岸 5.25 + FBA 5.00 + 广告 0 = 10.25
    expect(result.costBreakdown?.totalCostUsd).toBe(10.25);

    const missingAd = calculateUnitEconomics({
      facts,
      assumptions: { procurementCost: { amount: 4, currency: "USD" }, shippingMode: "sea_fast" },
    });
    expect(missingAd.grossProfit.status).toBe("not_computable");
    expect(missingAd.grossProfit.reason).toContain("不默认按 0");
  });

  it("非法用户输入被拦截（负佣金率 / 非正包装重量 / 负单件头程费用）", () => {
    const facts = fixtureSnapshot();
    const base = { procurementCost: { amount: 4, currency: "USD" as const }, shippingMode: "sea_fast" as const, targetTacosRate: 0 };

    expect(calculateUnitEconomics({ facts, assumptions: { ...base, commissionRate: -0.1 } }).grossProfit.reason)
      .toContain("佣金率不能为负数");
    expect(calculateUnitEconomics({ facts, assumptions: { ...base, packageWeight: { value: 0, unit: "kg" } } }).grossProfit.reason)
      .toContain("包装重量必须为正数");
    expect(calculateUnitEconomics({ facts, assumptions: { ...base, unitLogisticsCost: { amount: -1, currency: "USD" } } }).grossProfit.reason)
      .toContain("单件头程物流费用不能为负数");
  });
});
