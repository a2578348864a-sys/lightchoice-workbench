import { describe, expect, it } from "vitest";
import type {
  ResearchEvidenceRef,
  ResearchFactSnapshot,
  ResearchReportCore,
} from "./researchContracts";
import {
  buildActionReasons,
  buildDecisionChecklist,
  buildDecisionSummary,
  decisionSummaryOf,
} from "./decisionSummary";
import { calculateUnitEconomics } from "@/lib/server/research/unitEconomicsCalculator";
import { evaluateDeterministicRiskGates } from "@/lib/server/research/riskGateEvaluator";

const capturedAt = "2026-09-25T00:00:00.000Z";
const proofHash = "a".repeat(64);

const dummyRef: ResearchEvidenceRef = {
  refId: "evidence:ev-test-01",
  source: "sellersprite_plugin",
  captureId: "cap-test-01",
  evidenceId: "ev-test-01",
  subjectKey: "amazon:US:B0TEST001",
  capturedAt,
  contentHash: proofHash,
  sourceUrl: "https://www.amazon.com/dp/B0TEST001",
};

function factField<T>(value: T | null) {
  return {
    value,
    status: value === null ? ("missing" as const) : ("present" as const),
    source: "sellersprite_plugin" as const,
    confidence: value === null ? 0 : 1,
    capturedAt,
    rawProofHash: proofHash,
    evidenceRefs: [dummyRef],
  };
}

function createReportCore(
  factOverrides: Partial<{
    price: number | null;
    rating: number | null;
    reviewCount: number | null;
    bsr: number | null;
    monthlySalesEstimate: number | null;
    monthlyRevenueEstimate: number | null;
    buyboxSeller: string | null;
    packageWeightKg: number | null;
    packageDimensionsCm: { length: number; width: number; height: number } | null;
    fbaFee: number | null;
    timeSeries: null;
    variationAnalysis: null;
    concentration: null;
    price90dMin: number | null;
    price90dAvg: number | null;
    buyBoxAmazonSharePercent: number | null;
    dealCount90d: number | null;
    childSales: number | null;
    currentAsinSalesShare: number | null;
    isMinorVariation: boolean | null;
    brandCr5Share: number | null;
    amazon1pShare: number | null;
  }> = {},
  economicAssumptions?: {
    procurementCostAmount?: number;
    shippingMode?: "sea_fast" | "sea_economy" | "air_express" | "custom_rate";
    targetTacosRate?: number;
  },
): ResearchReportCore {
  const facts: ResearchFactSnapshot = {
    basic: {
      asin: factField("B0TEST001"),
      title: factField("测试商品标题"),
      image: factField("https://images.example.test/product.jpg"),
      brand: factField("TestBrand"),
      category: factField("Kitchen"),
      price: factField(
        factOverrides.price !== null && factOverrides.price !== undefined
          ? { amount: factOverrides.price, currency: "USD" }
          : factOverrides.price === null
            ? null
            : { amount: 35.0, currency: "USD" },
      ),
      rating: factField(factOverrides.rating !== undefined ? factOverrides.rating : 4.6),
      reviewCount: factField(factOverrides.reviewCount !== undefined ? factOverrides.reviewCount : 500),
      bulletPoints: factField(["卖点1", "卖点2"]),
    },
    market: {
      bsr: factField(factOverrides.bsr !== undefined ? factOverrides.bsr : 300),
      monthlySalesEstimate: factField(
        factOverrides.monthlySalesEstimate !== undefined ? factOverrides.monthlySalesEstimate : 800,
      ),
      monthlyRevenueEstimate: factField(
        factOverrides.monthlyRevenueEstimate !== null && factOverrides.monthlyRevenueEstimate !== undefined
          ? { amount: factOverrides.monthlyRevenueEstimate, currency: "USD" }
          : factOverrides.monthlyRevenueEstimate === null
            ? null
            : { amount: 28000, currency: "USD" },
      ),
      launchedDate: factField("2024-01-01"),
      subCategoryBsr: factField(20),
      dateFirstAvailable: factField("2024-01-01"),
      buyboxSeller: factField(
        factOverrides.buyboxSeller !== undefined ? factOverrides.buyboxSeller : "ThirdPartyMerchant",
      ),
      fulfillmentType: factField("FBA"),
      estimatedGrossMargin: factField(0.4),
      listingQualityScore: factField(8.5),
    },
    profit: {
      packageWeight: factField(
        factOverrides.packageWeightKg !== null && factOverrides.packageWeightKg !== undefined
          ? { value: factOverrides.packageWeightKg, unit: "kg" }
          : factOverrides.packageWeightKg === null
            ? null
            : { value: 0.8, unit: "kg" },
      ),
      packageDimensions: factField(
        factOverrides.packageDimensionsCm !== null && factOverrides.packageDimensionsCm !== undefined
          ? { ...factOverrides.packageDimensionsCm, unit: "cm" }
          : factOverrides.packageDimensionsCm === null
            ? null
            : { length: 25, width: 18, height: 12, unit: "cm" },
      ),
      fbaFee: factField(
        factOverrides.fbaFee !== null && factOverrides.fbaFee !== undefined
          ? { amount: factOverrides.fbaFee, currency: "USD" }
          : factOverrides.fbaFee === null
            ? null
            : { amount: 6.0, currency: "USD" },
      ),
      itemWeight: factField(null),
      itemDimensions: factField(null),
    },
    timeSeries: factOverrides.timeSeries !== null
      ? {
          price90dMin: factField(factOverrides.price90dMin !== undefined ? factOverrides.price90dMin : 32.0),
          price90dAvg: factField(factOverrides.price90dAvg !== undefined ? factOverrides.price90dAvg : 34.0),
          price360dMin: factField(30.0),
          bsr90dAvg: factField(300),
          bsrDrops90d: factField(25),
          buyBoxAmazonSharePercent: factField(
            factOverrides.buyBoxAmazonSharePercent !== undefined ? factOverrides.buyBoxAmazonSharePercent : 0,
          ),
          dealCount90d: factField(
            factOverrides.dealCount90d !== undefined ? factOverrides.dealCount90d : 1,
          ),
        }
      : undefined,
    variationAnalysis: factOverrides.variationAnalysis !== null
      ? {
          childSales: factField(factOverrides.childSales !== undefined ? factOverrides.childSales : 600),
          parentTotalSales: factField(800),
          currentAsinSalesShare: factField(
            factOverrides.currentAsinSalesShare !== undefined ? factOverrides.currentAsinSalesShare : 0.75,
          ),
          isDominantVariation: factField(true),
          isMinorVariation: factField(
            factOverrides.isMinorVariation !== undefined ? factOverrides.isMinorVariation : false,
          ),
        }
      : undefined,
    concentration: factOverrides.concentration !== null
      ? {
          brandCr5Share: factField(
            factOverrides.brandCr5Share !== undefined ? factOverrides.brandCr5Share : 0.45,
          ),
          amazon1pShare: factField(
            factOverrides.amazon1pShare !== undefined ? factOverrides.amazon1pShare : 0,
          ),
          sellerMarketShare: factField(0.2),
          sellerOriginDomesticRatio: factField(0.8),
        }
      : undefined,
    keywordEvidence: {
      topKeywords: factField([]),
    },
  };

  const assumptions = economicAssumptions
    ? {
        procurementCost: economicAssumptions.procurementCostAmount
          ? { amount: economicAssumptions.procurementCostAmount, currency: "USD" as const }
          : undefined,
        shippingMode: economicAssumptions.shippingMode ?? "sea_fast",
        targetTacosRate: economicAssumptions.targetTacosRate ?? 0.1,
      }
    : null;

  const unitEconomicsCalc = calculateUnitEconomics({ facts, assumptions });
  const deterministicGate = evaluateDeterministicRiskGates({ facts, unitEconomics: unitEconomicsCalc });

  return {
    schema: "research-report.v1",
    taskId: "task-test-01",
    candidateId: "cand-test-01",
    runId: "run-test-01",
    subjectKey: "amazon:US:B0TEST001",
    generatedAt: capturedAt,
    generationStatus: "completed",
    node: "synthesize_research",
    facts,
    executiveSummary: {
      analysis: { text: "综合执行摘要", evidenceRefs: [dummyRef] },
      keyPoints: [{ text: "要点1", evidenceRefs: [dummyRef] }],
    },
    marketOpportunity: {
      facts: {
        bsr: facts.market.bsr,
        monthlySalesEstimate: facts.market.monthlySalesEstimate,
        monthlyRevenueEstimate: facts.market.monthlyRevenueEstimate,
        launchedDate: facts.market.launchedDate,
        subCategoryBsr: facts.market.subCategoryBsr,
        dateFirstAvailable: facts.market.dateFirstAvailable,
        buyboxSeller: facts.market.buyboxSeller,
        fulfillmentType: facts.market.fulfillmentType,
        estimatedGrossMargin: facts.market.estimatedGrossMargin,
        listingQualityScore: facts.market.listingQualityScore,
      },
      analysis: { text: "市场机会分析详情", evidenceRefs: [dummyRef] },
    },
    competitionInsight: {
      analysis: { text: "竞品洞察详情", evidenceRefs: [dummyRef] },
      differentiationSuggestions: [{ text: "差异化建议", evidenceRefs: [dummyRef] }],
    },
    vocAnalysis: {
      analysis: { text: "VOC 洞察详情", evidenceRefs: [dummyRef] },
      painPoints: [{ text: "痛点分析", evidenceRefs: [dummyRef] }],
    },
    unitEconomics: {
      facts: {
        price: facts.basic.price,
        fbaFee: facts.profit.fbaFee,
        packageWeight: facts.profit.packageWeight,
        packageDimensions: facts.profit.packageDimensions,
        estimatedGrossMargin: facts.market.estimatedGrossMargin,
      },
      deterministic: {
        knownRevenueAfterFbaFee: unitEconomicsCalc.knownRevenueAfterFbaFee,
        grossProfit: unitEconomicsCalc.grossProfit,
        grossMargin: unitEconomicsCalc.grossMargin,
        netProfit: unitEconomicsCalc.netProfit,
        netMargin: unitEconomicsCalc.netMargin,
        breakEvenPrice: unitEconomicsCalc.breakEvenPrice,
        stressNetProfit: unitEconomicsCalc.stressNetProfit,
        stressMargin: unitEconomicsCalc.stressMargin,
        costBreakdown: unitEconomicsCalc.costBreakdown,
        assumptionsUsed: unitEconomicsCalc.assumptionsUsed,
      },
      analysis: { text: "利润测算分析", evidenceRefs: [dummyRef] },
    },
    supplyChain: {
      facts: {
        packageWeight: facts.profit.packageWeight,
        packageDimensions: facts.profit.packageDimensions,
        itemWeight: facts.profit.itemWeight,
        itemDimensions: facts.profit.itemDimensions,
      },
      analysis: { text: "供应链分析", evidenceRefs: [dummyRef] },
    },
    riskAssessment: {
      analysis: { text: "风险评估分析", evidenceRefs: [dummyRef] },
      risks: [{ text: "风险提示1", evidenceRefs: [dummyRef] }],
      deterministicGate,
    },
    citationIndex: [],
    unverifiedAssumptions: [],
    ai: {
      provider: "deepseek",
      status: "completed",
      errorCode: null,
    },
  };
}

describe("RDO-3: Decision Action Explainability + Decision Checklist", () => {
  it("测试场景 1：正常健康商品 -> 推荐'继续研究'且 Checklist 全项 passed", () => {
    // 售价 $35.0, 采购 $6.0, 运费约 $1.4, FBA $6.0 -> 净利润 ~$18.1, 毛利率 ~78.8%, FBA 占比 17.1%
    // 评分 4.6, BuyBox 第三方, 尺寸 25x18x12cm
    const core = createReportCore(
      {
        price: 35.0,
        fbaFee: 6.0,
        rating: 4.6,
        reviewCount: 600,
        buyboxSeller: "ThirdPartyStore",
        packageWeightKg: 0.8,
        packageDimensionsCm: { length: 25, width: 18, height: 12 },
      },
      {
        procurementCostAmount: 6.0,
        shippingMode: "sea_fast",
      },
    );

    const summary = buildDecisionSummary(core);

    // 1. 验证基础动作推荐
    expect(summary.recommendedNextAction).toBe("继续研究");
    expect(summary.researchPriority).toBe("P1");

    // 2. 验证动作驱动解释 (actionReasons)
    expect(summary.actionReasons).toBeDefined();
    expect(summary.actionReasons).toHaveLength(1);
    expect(summary.actionReasons![0]).toContain("核心市场信号完整，经确定性门禁筛查未发现硬性阻断风险");

    // 3. 验证 8 大关键核对项 (checklist)
    expect(summary.checklist).toBeDefined();
    expect(summary.checklist).toHaveLength(8);

    const checklistMap = new Map(summary.checklist!.map((item) => [item.key, item]));

    // profit_margin
    expect(checklistMap.get("profit_margin")?.status).toBe("passed");
    expect(checklistMap.get("profit_margin")?.label).toBe("单件利润与毛利率");

    // fba_ratio
    expect(checklistMap.get("fba_ratio")?.status).toBe("passed");
    expect(checklistMap.get("fba_ratio")?.label).toBe("FBA 费用占比");

    // customer_rating
    expect(checklistMap.get("customer_rating")?.status).toBe("passed");
    expect(checklistMap.get("customer_rating")?.label).toBe("买家评分风险");

    // buybox_competition
    expect(checklistMap.get("buybox_competition")?.status).toBe("passed");
    expect(checklistMap.get("buybox_competition")?.label).toBe("Buy Box 竞争");

    // logistics_size
    expect(checklistMap.get("logistics_size")?.status).toBe("passed");
    expect(checklistMap.get("logistics_size")?.label).toBe("尺寸重量物流");

    // price_stability
    expect(checklistMap.get("price_stability")?.status).toBe("passed");
    expect(checklistMap.get("price_stability")?.label).toBe("价格稳定性与抗压");

    // variation_health
    expect(checklistMap.get("variation_health")?.status).toBe("passed");
    expect(checklistMap.get("variation_health")?.label).toBe("变体动销健康度");

    // market_structure
    expect(checklistMap.get("market_structure")?.status).toBe("passed");
    expect(checklistMap.get("market_structure")?.label).toBe("市场结构与竞争壁垒");
  });

  it("测试场景 2：净利润亏损商品 -> 推荐'暂停'且 Checklist 包含 blocked 项", () => {
    // 售价 $12.0, 采购 $10.0, 运费 $1.4, FBA $5.0 -> 总成本 $17.6 > 售价 $12.0 -> 单件亏损 -$5.6
    const core = createReportCore(
      {
        price: 12.0,
        fbaFee: 5.0,
        rating: 4.5,
        reviewCount: 300,
        buyboxSeller: "ThirdPartyStore",
        packageWeightKg: 0.8,
        packageDimensionsCm: { length: 25, width: 18, height: 12 },
      },
      {
        procurementCostAmount: 10.0,
        shippingMode: "sea_fast",
      },
    );

    const summary = buildDecisionSummary(core);

    // 1. 验证阻断判定
    expect(summary.recommendedNextAction).toBe("暂停");

    // 2. 验证 actionReasons 准确反映一票否决原因
    expect(summary.actionReasons).toBeDefined();
    expect(summary.actionReasons![0]).toContain("[一票否决]");
    expect(summary.actionReasons![0]).toContain("单件净利润为负");

    // 3. 验证 checklist 中利润项为 blocked
    const checklistMap = new Map(summary.checklist!.map((item) => [item.key, item]));
    expect(checklistMap.get("profit_margin")?.status).toBe("blocked");
    expect(checklistMap.get("profit_margin")?.detail).toContain("单件净利润为负");
  });

  it("测试场景 3：核心数据缺失商品 -> 推荐'补充数据'且 Checklist 包含 missing 项", () => {
    // 缺失当前售价、FBA 费用、包装重量、包装尺寸，且无成本假设
    const core = createReportCore({
      price: null,
      fbaFee: null,
      packageWeightKg: null,
      packageDimensionsCm: null,
    });

    const summary = buildDecisionSummary(core);

    // 1. 验证动作推荐为补充数据
    expect(summary.recommendedNextAction).toBe("补充数据");

    // 2. 验证 actionReasons 准确指出缺失项概览
    expect(summary.actionReasons).toBeDefined();
    expect(summary.actionReasons![0]).toContain("核心决策数据缺失（共");
    expect(summary.actionReasons![0]).toContain("不足以支撑选品结论，请先补充数据。");

    // 3. 验证 checklist 中对应项标记为 missing
    const checklistMap = new Map(summary.checklist!.map((item) => [item.key, item]));
    expect(checklistMap.get("profit_margin")?.status).toBe("missing");
    expect(checklistMap.get("fba_ratio")?.status).toBe("missing");
    expect(checklistMap.get("logistics_size")?.status).toBe("missing");
  });

  it("测试场景 4：多个 warning 商品 -> Checklist 对应项显示 warning，并在 actionReasons 中详述", () => {
    // 构造触发多个预警规则：
    // 1. HIGH_FBA_RATIO: 售价 $15, FBA 费用 $7 (46.7% >= 40%)
    // 2. LOW_RATING_RISK: 评分 3.5 (< 3.8), 评论数 120 (>= 30)
    // 3. AMAZON_BUYBOX_RISK: buyboxSeller 为 "Amazon.com"
    // 4. OVERSIZE_LOGISTICS_RISK: 单边尺寸 50cm (> 45.72cm)
    const core = createReportCore(
      {
        price: 15.0,
        fbaFee: 7.0,
        rating: 3.5,
        reviewCount: 120,
        buyboxSeller: "Amazon.com",
        packageWeightKg: 1.2,
        packageDimensionsCm: { length: 50, width: 20, height: 10 },
      },
      {
        procurementCostAmount: 2.0,
        shippingMode: "sea_fast",
      },
    );

    const summary = buildDecisionSummary(core);

    // 验证动作为继续研究（无硬阻断），但给出详细 warning 解释
    expect(summary.recommendedNextAction).toBe("继续研究");
    expect(summary.actionReasons).toBeDefined();
    expect(summary.actionReasons![0]).toContain("基础市场信号完整且未触发硬阻断，但存在潜在预警需关注：");
    // actionReasons 后续条目列出了具体的 warning 列表
    expect(summary.actionReasons!.length).toBeGreaterThan(1);

    // 验证 checklist 中的多重 warning 状态
    const checklistMap = new Map(summary.checklist!.map((item) => [item.key, item]));
    expect(checklistMap.get("fba_ratio")?.status).toBe("warning");
    expect(checklistMap.get("customer_rating")?.status).toBe("warning");
    expect(checklistMap.get("buybox_competition")?.status).toBe("warning");
    expect(checklistMap.get("logistics_size")?.status).toBe("warning");
  });

  it("兼容性测试：decisionSummaryOf 针对老旧 reportJson 平稳运行", () => {
    const core = createReportCore({ price: 30.0, fbaFee: 5.0 });
    const fullReport = {
      ...core,
      decisionSummary: buildDecisionSummary(core),
    };

    const derived = decisionSummaryOf(fullReport);
    expect(derived.actionReasons).toBeDefined();
    expect(derived.checklist).toHaveLength(8);
  });

  it("测试场景 5 (Hardening)：部分 deterministicGate rules 缺失时，对应项必须 fail-closed 为 missing，严禁错误显示 passed", () => {
    const baseCore = createReportCore(
      {
        price: 35.0,
        fbaFee: 6.0,
        rating: 4.6,
        reviewCount: 600,
        buyboxSeller: "ThirdPartyStore",
        packageWeightKg: 0.8,
        packageDimensionsCm: { length: 25, width: 18, height: 12 },
      },
      {
        procurementCostAmount: 6.0,
        shippingMode: "sea_fast",
      },
    );

    // 模拟仅返回了 NEGATIVE_NET_PROFIT 和 LOW_GROSS_MARGIN 规则，
    // 其余 LOW_RATING_RISK, HIGH_FBA_RATIO, AMAZON_BUYBOX_RISK, OVERSIZE_LOGISTICS_RISK 规则全部在数组中缺失
    const partialRules = (baseCore.riskAssessment.deterministicGate?.rules ?? []).filter(
      (r) => r.ruleId === "NEGATIVE_NET_PROFIT" || r.ruleId === "LOW_GROSS_MARGIN",
    );

    const partialGateCore: ResearchReportCore = {
      ...baseCore,
      riskAssessment: {
        ...baseCore.riskAssessment,
        deterministicGate: {
          status: "passed",
          hasBlockingRisk: false,
          rules: partialRules,
          blockingReasons: [],
          warningReasons: [],
        },
      },
    };

    const summary = buildDecisionSummary(partialGateCore);
    const checklistMap = new Map(summary.checklist!.map((item) => [item.key, item]));

    // 1. 存在且 passed 的规则正常呈现 passed
    expect(checklistMap.get("profit_margin")?.status).toBe("passed");

    // 2. 缺失的 rules 必须全部 fail-closed 为 missing，严禁显示 passed
    expect(checklistMap.get("customer_rating")?.status).toBe("missing");
    expect(checklistMap.get("customer_rating")?.detail).toContain("无法评估买家口碑风险");

    expect(checklistMap.get("fba_ratio")?.status).toBe("missing");
    expect(checklistMap.get("fba_ratio")?.detail).toContain("无法核算 FBA 费用占比");

    expect(checklistMap.get("buybox_competition")?.status).toBe("missing");
    expect(checklistMap.get("buybox_competition")?.detail).toContain("缺少购物车卖家");

    expect(checklistMap.get("logistics_size")?.status).toBe("missing");
    expect(checklistMap.get("logistics_size")?.detail).toContain("无法核算物流超规风险");
  });

  it("测试场景 6 (数据异常与极端空态韧性)：ProductFact 字段全缺、Evidence 为空、rules 为空时系统不崩溃并安全降级", () => {
    // 构造极端空态 core
    const emptyFacts: ResearchFactSnapshot = {
      basic: {
        asin: factField(null),
        title: factField(null),
        image: factField(null),
        brand: factField(null),
        category: factField(null),
        price: factField(null),
        rating: factField(null),
        reviewCount: factField(null),
        bulletPoints: factField(null),
      },
      market: {
        bsr: factField(null),
        monthlySalesEstimate: factField(null),
        monthlyRevenueEstimate: factField(null),
        launchedDate: factField(null),
        subCategoryBsr: factField(null),
        dateFirstAvailable: factField(null),
        buyboxSeller: factField(null),
        fulfillmentType: factField(null),
        estimatedGrossMargin: factField(null),
        listingQualityScore: factField(null),
      },
      profit: {
        packageWeight: factField(null),
        packageDimensions: factField(null),
        fbaFee: factField(null),
        itemWeight: factField(null),
        itemDimensions: factField(null),
      },
      keywordEvidence: {
        topKeywords: factField([]),
      },
    };

    const emptyCore: ResearchReportCore = {
      schema: "research-report.v1",
      taskId: "task-empty",
      candidateId: "cand-empty",
      runId: "run-empty",
      subjectKey: "amazon:US:B0EMPTY",
      generatedAt: capturedAt,
      generationStatus: "degraded",
      node: "synthesize_research",
      facts: emptyFacts,
      executiveSummary: {
        analysis: { text: null, evidenceRefs: [] },
        keyPoints: [],
      },
      marketOpportunity: {
        facts: {
          bsr: emptyFacts.market.bsr,
          monthlySalesEstimate: emptyFacts.market.monthlySalesEstimate,
          monthlyRevenueEstimate: emptyFacts.market.monthlyRevenueEstimate,
          launchedDate: emptyFacts.market.launchedDate,
          subCategoryBsr: emptyFacts.market.subCategoryBsr,
          dateFirstAvailable: emptyFacts.market.dateFirstAvailable,
          buyboxSeller: emptyFacts.market.buyboxSeller,
          fulfillmentType: emptyFacts.market.fulfillmentType,
          estimatedGrossMargin: emptyFacts.market.estimatedGrossMargin,
          listingQualityScore: emptyFacts.market.listingQualityScore,
        },
        analysis: { text: null, evidenceRefs: [] },
      },
      competitionInsight: {
        analysis: { text: null, evidenceRefs: [] },
        differentiationSuggestions: [],
      },
      vocAnalysis: {
        analysis: { text: null, evidenceRefs: [] },
        painPoints: [],
      },
      unitEconomics: {
        facts: {
          price: emptyFacts.basic.price,
          fbaFee: emptyFacts.profit.fbaFee,
          packageWeight: emptyFacts.profit.packageWeight,
          packageDimensions: emptyFacts.profit.packageDimensions,
          estimatedGrossMargin: emptyFacts.market.estimatedGrossMargin,
        },
        deterministic: {
          knownRevenueAfterFbaFee: { value: null, status: "not_computable", evidenceRefs: [], reason: "缺失" },
          grossProfit: { value: null, status: "not_computable", evidenceRefs: [], reason: "缺失" },
        },
        analysis: { text: null, evidenceRefs: [] },
      },
      supplyChain: {
        facts: {
          packageWeight: emptyFacts.profit.packageWeight,
          packageDimensions: emptyFacts.profit.packageDimensions,
          itemWeight: emptyFacts.profit.itemWeight,
          itemDimensions: emptyFacts.profit.itemDimensions,
        },
        analysis: { text: null, evidenceRefs: [] },
      },
      riskAssessment: {
        analysis: { text: null, evidenceRefs: [] },
        risks: [],
        deterministicGate: {
          status: "passed",
          hasBlockingRisk: false,
          rules: [], // rules 为空
          blockingReasons: [],
          warningReasons: [],
        },
      },
      citationIndex: [],
      unverifiedAssumptions: [],
      ai: {
        provider: "deepseek",
        status: "degraded",
        errorCode: "DATA_EMPTY",
      },
    };

    // 执行应当完全不抛出异常，安全降级
    const summary = buildDecisionSummary(emptyCore);
    expect(summary).toBeDefined();
    expect(summary.recommendedNextAction).toBe("补充数据");
    expect(summary.researchPriority).toBe("P3");
    expect(summary.actionReasons![0]).toContain("核心决策数据缺失");

    // 所有 8 项 checklist 必须一律 fail-closed 为 missing
    expect(summary.checklist).toHaveLength(8);
    for (const item of summary.checklist!) {
      expect(item.status).toBe("missing");
    }
  });
});

describe("V5.1 Phase 2 Decision Wiring: 7 核心决策验证场景", () => {
  it("场景 1: 正常健康商品 -> stressNetProfit 正常测算且为正，8 项 checklist 全绿 passed", () => {
    const core = createReportCore(
      {
        price: 35.0,
        fbaFee: 6.0,
        rating: 4.6,
        reviewCount: 600,
        buyboxSeller: "ThirdPartyStore",
        packageWeightKg: 0.8,
        packageDimensionsCm: { length: 25, width: 18, height: 12 },
        price90dMin: 32.0,
        price90dAvg: 34.0,
        buyBoxAmazonSharePercent: 0,
        dealCount90d: 1,
        childSales: 600,
        currentAsinSalesShare: 0.75,
        isMinorVariation: false,
        brandCr5Share: 0.45,
        amazon1pShare: 0,
      },
      {
        procurementCostAmount: 6.0,
        shippingMode: "sea_fast",
        targetTacosRate: 0.1,
      },
    );

    // 1. 验证 RDO-1 历史最低价抗压测算
    expect(core.unitEconomics.deterministic.stressNetProfit).toBeDefined();
    expect(core.unitEconomics.deterministic.stressNetProfit?.status).toBe("available");
    expect(core.unitEconomics.deterministic.stressNetProfit?.value?.amount).toBeGreaterThan(0);
    expect(core.unitEconomics.deterministic.stressMargin?.status).toBe("available");
    expect(core.unitEconomics.deterministic.stressMargin?.value).toBeGreaterThan(0);

    // 2. 验证 RDO-2 门禁状态
    expect(core.riskAssessment.deterministicGate?.status).toBe("passed");
    expect(core.riskAssessment.deterministicGate?.hasBlockingRisk).toBe(false);

    // 3. 验证 RDO-3 Checklist 全 8 项 passed
    const summary = buildDecisionSummary(core);
    expect(summary.recommendedNextAction).toBe("继续研究");
    expect(summary.checklist).toHaveLength(8);
    for (const item of summary.checklist!) {
      expect(item.status).toBe("passed");
    }
  });

  it("场景 2: 历史最低价破位亏损 -> 触发 PRICE_WAR_COLLAPSE_RISK (BLOCK)，price_stability 判定为 blocked", () => {
    // 正常售价 $35，采购 $10, FBA $6, 运费 $1.4 => breakEvenPrice ~$18.25
    // 历史 90 天最低价跌至 $14.0 (< 18.25)
    const core = createReportCore(
      {
        price: 35.0,
        fbaFee: 6.0,
        price90dMin: 14.0,
      },
      {
        procurementCostAmount: 10.0,
        shippingMode: "sea_fast",
      },
    );

    expect(core.riskAssessment.deterministicGate?.status).toBe("blocked");
    expect(core.riskAssessment.deterministicGate?.hasBlockingRisk).toBe(true);
    const rule = core.riskAssessment.deterministicGate?.rules.find((r) => r.ruleId === "PRICE_WAR_COLLAPSE_RISK");
    expect(rule?.status).toBe("triggered");
    expect(rule?.severity).toBe("BLOCK");

    const summary = buildDecisionSummary(core);
    expect(summary.recommendedNextAction).toBe("暂停");
    const checklistMap = new Map(summary.checklist!.map((item) => [item.key, item]));
    expect(checklistMap.get("price_stability")?.status).toBe("blocked");
    expect(checklistMap.get("price_stability")?.detail).toContain("保本售价");
  });

  it("场景 3: 弱势边缘变体 -> 触发 MINOR_VARIATION_RISK (WARNING)，variation_health 判定为 warning", () => {
    const core = createReportCore({
      isMinorVariation: true,
      currentAsinSalesShare: 0.03,
    });

    const rule = core.riskAssessment.deterministicGate?.rules.find((r) => r.ruleId === "MINOR_VARIATION_RISK");
    expect(rule?.status).toBe("triggered");
    expect(rule?.severity).toBe("WARNING");

    const summary = buildDecisionSummary(core);
    const checklistMap = new Map(summary.checklist!.map((item) => [item.key, item]));
    expect(checklistMap.get("variation_health")?.status).toBe("warning");
    expect(checklistMap.get("variation_health")?.detail).toContain("弱势非主力");
  });

  it("场景 4: 亚马逊自营占比过高 -> 触发 AMAZON_MONOPOLY_RISK (WARNING)，market_structure 判定为 warning", () => {
    // 1) 90天 Buybox 亚马逊自营占比 50% (>= 40%)
    const coreBuyBox = createReportCore({
      buyBoxAmazonSharePercent: 50,
    });
    const summaryBB = buildDecisionSummary(coreBuyBox);
    const mapBB = new Map(summaryBB.checklist!.map((item) => [item.key, item]));
    expect(mapBB.get("market_structure")?.status).toBe("warning");
    expect(mapBB.get("market_structure")?.detail).toContain("自营");

    // 2) 卖家表亚马逊自营份额 45% (>= 40%)
    const core1p = createReportCore({
      amazon1pShare: 0.45,
    });
    const summary1p = buildDecisionSummary(core1p);
    const map1p = new Map(summary1p.checklist!.map((item) => [item.key, item]));
    expect(map1p.get("market_structure")?.status).toBe("warning");
    expect(map1p.get("market_structure")?.detail).toContain("自营");
  });

  it("场景 5: 高频促销依赖 -> 触发 HIGH_DEAL_DEPENDENCY_RISK (WARNING)，price_stability 判定为 warning", () => {
    const core = createReportCore({
      dealCount90d: 8, // >= 6 次
    });

    const rule = core.riskAssessment.deterministicGate?.rules.find((r) => r.ruleId === "HIGH_DEAL_DEPENDENCY_RISK");
    expect(rule?.status).toBe("triggered");
    expect(rule?.severity).toBe("WARNING");

    const summary = buildDecisionSummary(core);
    const checklistMap = new Map(summary.checklist!.map((item) => [item.key, item]));
    expect(checklistMap.get("price_stability")?.status).toBe("warning");
    expect(checklistMap.get("price_stability")?.detail).toContain("秒杀促销频次");
  });

  it("场景 6: 品牌高度寡头垄断 -> 触发 BRAND_OLIGOPOLY_RISK (WARNING)，market_structure 判定为 warning", () => {
    const core = createReportCore({
      brandCr5Share: 0.78, // >= 0.7
    });

    const rule = core.riskAssessment.deterministicGate?.rules.find((r) => r.ruleId === "BRAND_OLIGOPOLY_RISK");
    expect(rule?.status).toBe("triggered");
    expect(rule?.severity).toBe("WARNING");

    const summary = buildDecisionSummary(core);
    const checklistMap = new Map(summary.checklist!.map((item) => [item.key, item]));
    expect(checklistMap.get("market_structure")?.status).toBe("warning");
    expect(checklistMap.get("market_structure")?.detail).toContain("CR5");
  });

  it("场景 7: 所有新事实字段全部缺失 -> fail-closed 为 missing，严禁错误 default 为 passed", () => {
    const coreMissing = createReportCore({
      price90dMin: null,
      price90dAvg: null,
      buyBoxAmazonSharePercent: null,
      dealCount90d: null,
      childSales: null,
      currentAsinSalesShare: null,
      isMinorVariation: null,
      brandCr5Share: null,
      amazon1pShare: null,
    });

    // 1. stressNetProfit 必须诚实为 not_computable
    expect(coreMissing.unitEconomics.deterministic.stressNetProfit?.status).toBe("not_computable");
    expect(coreMissing.unitEconomics.deterministic.stressMargin?.status).toBe("not_computable");

    // 2. 对应规则全部为 not_computable
    const rules = coreMissing.riskAssessment.deterministicGate?.rules ?? [];
    const minorRule = rules.find((r) => r.ruleId === "MINOR_VARIATION_RISK");
    const amzMonopolyRule = rules.find((r) => r.ruleId === "AMAZON_MONOPOLY_RISK");
    const priceWarRule = rules.find((r) => r.ruleId === "PRICE_WAR_COLLAPSE_RISK");
    const dealRule = rules.find((r) => r.ruleId === "HIGH_DEAL_DEPENDENCY_RISK");
    const cr5Rule = rules.find((r) => r.ruleId === "BRAND_OLIGOPOLY_RISK");

    expect(minorRule?.status).toBe("not_computable");
    expect(amzMonopolyRule?.status).toBe("not_computable");
    expect(priceWarRule?.status).toBe("not_computable");
    expect(dealRule?.status).toBe("not_computable");
    expect(cr5Rule?.status).toBe("not_computable");

    // 3. 3 项新增 Checklist 必须全部 fail-closed 为 missing，严禁误报 passed
    const summary = buildDecisionSummary(coreMissing);
    const checklistMap = new Map(summary.checklist!.map((item) => [item.key, item]));
    expect(checklistMap.get("price_stability")?.status).toBe("missing");
    expect(checklistMap.get("variation_health")?.status).toBe("missing");
    expect(checklistMap.get("market_structure")?.status).toBe("missing");
  });

  it("场景 8: 市场结构双维度校验 - 一个维度通过、另一个维度缺失时必须 fail-closed 为 missing，严禁整体通过", () => {
    // 8a: 亚马逊自营份额通过 (0.10)，但缺少品牌集中度 CR5 -> 必须为 missing，不能因自营通过而误判 passed
    const coreMissingCr5 = createReportCore({
      amazon1pShare: 0.10,
      brandCr5Share: null,
    });
    const summaryMissingCr5 = buildDecisionSummary(coreMissingCr5);
    const mapMissingCr5 = new Map(summaryMissingCr5.checklist!.map((item) => [item.key, item]));
    expect(mapMissingCr5.get("market_structure")?.status).toBe("missing");
    expect(mapMissingCr5.get("market_structure")?.detail).toContain("品牌集中度 CR5 数据");

    // 8b: 品牌集中度 CR5 通过 (0.45)，但缺少亚马逊自营数据 -> 必须为 missing
    const coreMissingAmz = createReportCore({
      amazon1pShare: null,
      buyBoxAmazonSharePercent: null,
      brandCr5Share: 0.45,
    });
    const summaryMissingAmz = buildDecisionSummary(coreMissingAmz);
    const mapMissingAmz = new Map(summaryMissingAmz.checklist!.map((item) => [item.key, item]));
    expect(mapMissingAmz.get("market_structure")?.status).toBe("missing");
    expect(mapMissingAmz.get("market_structure")?.detail).toContain("亚马逊自营");

    // 8c: 亚马逊自营触发预警 (0.50)，即使 CR5 缺失，也必须呈现 warning 风险
    const coreTriggeredAmz = createReportCore({
      amazon1pShare: 0.50,
      brandCr5Share: null,
    });
    const summaryTriggeredAmz = buildDecisionSummary(coreTriggeredAmz);
    const mapTriggeredAmz = new Map(summaryTriggeredAmz.checklist!.map((item) => [item.key, item]));
    expect(mapTriggeredAmz.get("market_structure")?.status).toBe("warning");

    // 8d: 品牌集中度触发预警 (0.75)，即使亚马逊自营缺失，也必须呈现 warning 风险
    const coreTriggeredCr5 = createReportCore({
      amazon1pShare: null,
      buyBoxAmazonSharePercent: null,
      brandCr5Share: 0.75,
    });
    const summaryTriggeredCr5 = buildDecisionSummary(coreTriggeredCr5);
    const mapTriggeredCr5 = new Map(summaryTriggeredCr5.checklist!.map((item) => [item.key, item]));
    expect(mapTriggeredCr5.get("market_structure")?.status).toBe("warning");
  });

  it("场景 9: 价格稳定性双维度校验 - 一个维度通过、另一个维度缺失时必须 fail-closed 为 missing，严禁整体通过", () => {
    // 9a: 历史最低售价通过 ($32 > 保本线)，但缺少秒杀促销频次 -> missing
    const coreMissingDeal = createReportCore(
      {
        price90dMin: 32.0,
        dealCount90d: null,
      },
      {
        procurementCostAmount: 10.0,
        shippingMode: "sea_fast",
      },
    );
    const summaryMissingDeal = buildDecisionSummary(coreMissingDeal);
    const mapMissingDeal = new Map(summaryMissingDeal.checklist!.map((item) => [item.key, item]));
    expect(mapMissingDeal.get("price_stability")?.status).toBe("missing");
    expect(mapMissingDeal.get("price_stability")?.detail).toContain("秒杀促销频次");

    // 9b: 秒杀促销频次通过 (1次)，但缺少 90 天历史最低价 -> missing
    const coreMissingPrice = createReportCore({
      price90dMin: null,
      dealCount90d: 1,
    });
    const summaryMissingPrice = buildDecisionSummary(coreMissingPrice);
    const mapMissingPrice = new Map(summaryMissingPrice.checklist!.map((item) => [item.key, item]));
    expect(mapMissingPrice.get("price_stability")?.status).toBe("missing");
    expect(mapMissingPrice.get("price_stability")?.detail).toContain("历史最低价");
  });

  it("场景 10: 变体动销健康度 - 缺少销售占比或弱势标识时必须 fail-closed 为 missing", () => {
    // 10a: isMinorVariation 为 false，但缺少 currentAsinSalesShare -> missing
    const coreMissingShare = createReportCore({
      isMinorVariation: false,
      currentAsinSalesShare: null,
    });
    const summaryMissingShare = buildDecisionSummary(coreMissingShare);
    const mapMissingShare = new Map(summaryMissingShare.checklist!.map((item) => [item.key, item]));
    expect(mapMissingShare.get("variation_health")?.status).toBe("missing");

    // 10b: 缺少 isMinorVariation -> missing
    const coreMissingMinor = createReportCore({
      isMinorVariation: null,
      currentAsinSalesShare: 0.6,
    });
    const summaryMissingMinor = buildDecisionSummary(coreMissingMinor);
    const mapMissingMinor = new Map(summaryMissingMinor.checklist!.map((item) => [item.key, item]));
    expect(mapMissingMinor.get("variation_health")?.status).toBe("missing");
  });
});
