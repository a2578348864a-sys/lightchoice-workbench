import "server-only";

import type {
  DeterministicRiskGateSummary,
  DeterministicRiskRuleId,
  DeterministicRiskRuleResult,
  DeterministicRiskSeverity,
  ResearchEvidenceRef,
  ResearchFactField,
  ResearchFactSnapshot,
} from "@/lib/research/researchContracts";
import {
  calculateChargeableWeightKg,
  type UnitEconomicsCalculationResult,
} from "./unitEconomicsCalculator";

/**
 * 阈值常量配置（确定性硬规则，严禁由大模型临时发明或变动）
 */
export const RISK_THRESHOLDS = {
  /** 极低毛利率阈值 (15%) */
  LOW_GROSS_MARGIN_THRESHOLD: 0.15,
  /** 高 FBA 运费占比阈值 (40%) */
  HIGH_FBA_RATIO_THRESHOLD: 0.4,
  /** 买家低评分阈值 (3.8 分) */
  LOW_RATING_THRESHOLD: 3.8,
  /** 买家低评分需满足的最小样本量 (30 评) */
  LOW_RATING_MIN_REVIEWS: 30,
  /** 超重阈值 (20 lb 约等于 9.0718 kg) */
  OVERSIZE_WEIGHT_KG_THRESHOLD: 9.0718,
  /** 超长单边尺寸阈值 (18 in 约等于 45.72 cm) */
  OVERSIZE_DIMENSION_CM_THRESHOLD: 45.72,
  /** V5.1 Phase 2: 亚马逊自营时序 Buybox 占有率阈值 (40%) */
  AMAZON_BUYBOX_SHARE_THRESHOLD: 40,
  /** V5.1 Phase 2: 亚马逊自营卖家市场份额阈值 (40% / 0.4) */
  AMAZON_1P_MARKET_SHARE_THRESHOLD: 0.4,
  /** V5.1 Phase 2: 高频秒杀促销次数阈值 (6 次) */
  HIGH_DEAL_COUNT_THRESHOLD: 6,
  /** V5.1 Phase 2: 细分市场头部品牌 CR5 集中度阈值 (70% / 0.7) */
  BRAND_CR5_SHARE_THRESHOLD: 0.7,
} as const;

function mergeMetricRefs(
  ...fields: readonly (ResearchFactField<unknown> | undefined)[]
): ResearchEvidenceRef[] {
  const seen = new Set<string>();
  const output: ResearchEvidenceRef[] = [];
  for (const field of fields) {
    if (!field || !Array.isArray(field.evidenceRefs)) continue;
    for (const ref of field.evidenceRefs) {
      if (!seen.has(ref.refId)) {
        seen.add(ref.refId);
        output.push(ref);
      }
    }
  }
  return output;
}

/**
 * 规则 1: NEGATIVE_NET_PROFIT (BLOCK)
 * 单件净利润为负时触发一票否决
 */
function evaluateNegativeNetProfit(
  unitEconomics: UnitEconomicsCalculationResult,
): DeterministicRiskRuleResult {
  const ruleId: DeterministicRiskRuleId = "NEGATIVE_NET_PROFIT";
  const severity: DeterministicRiskSeverity = "BLOCK";
  const sourceFields = [
    "unitEconomics.deterministic.netProfit",
    "facts.basic.price",
    "facts.profit.fbaFee",
    "facts.profit.packageDimensions",
    "facts.profit.packageWeight",
  ];
  const evidenceRefs = unitEconomics.netProfit?.evidenceRefs ?? [];

  if (unitEconomics.netProfit?.status === "available" && unitEconomics.netProfit.value !== null) {
    const netProfitAmount = unitEconomics.netProfit.value.amount;
    const currency = unitEconomics.netProfit.value.currency;
    if (netProfitAmount < 0) {
      return {
        ruleId,
        severity,
        status: "triggered",
        reason: `[一票否决] 单件净利润为负 (${netProfitAmount} ${currency})，每售出一件将产生实质性亏损失血。`,
        sourceFields,
        evidenceRefs,
      };
    }
    return {
      ruleId,
      severity,
      status: "passed",
      reason: null,
      sourceFields,
      evidenceRefs,
    };
  }

  return {
    ruleId,
    severity,
    status: "not_computable",
    reason: "缺少单件净利润测算结果，无法判定净利润亏损风险。",
    sourceFields,
    evidenceRefs,
  };
}

/**
 * 规则 2: LOW_GROSS_MARGIN (WARNING)
 * 毛利率低于 15% 时触发严重预警
 */
function evaluateLowGrossMargin(
  unitEconomics: UnitEconomicsCalculationResult,
): DeterministicRiskRuleResult {
  const ruleId: DeterministicRiskRuleId = "LOW_GROSS_MARGIN";
  const severity: DeterministicRiskSeverity = "WARNING";
  const sourceFields = [
    "unitEconomics.deterministic.grossMargin",
    "facts.basic.price",
    "facts.profit.fbaFee",
    "facts.profit.packageDimensions",
    "facts.profit.packageWeight",
  ];
  const evidenceRefs = unitEconomics.grossMargin?.evidenceRefs ?? [];

  if (
    unitEconomics.grossMargin?.status === "available"
    && typeof unitEconomics.grossMargin.value === "number"
  ) {
    const margin = unitEconomics.grossMargin.value;
    if (margin < RISK_THRESHOLDS.LOW_GROSS_MARGIN_THRESHOLD) {
      const marginPct = (margin * 100).toFixed(1);
      const thresholdPct = (RISK_THRESHOLDS.LOW_GROSS_MARGIN_THRESHOLD * 100).toFixed(1);
      return {
        ruleId,
        severity,
        status: "triggered",
        reason: `[严重预警] 毛利率过低 (${marginPct}% < ${thresholdPct}%)，抗风险、退货损耗与营销降价空间严重不足。`,
        sourceFields,
        evidenceRefs,
      };
    }
    return {
      ruleId,
      severity,
      status: "passed",
      reason: null,
      sourceFields,
      evidenceRefs,
    };
  }

  return {
    ruleId,
    severity,
    status: "not_computable",
    reason: "缺少毛利率测算结果，无法判定毛利率红线风险。",
    sourceFields,
    evidenceRefs,
  };
}

/**
 * 规则 3: HIGH_FBA_RATIO (WARNING)
 * FBA 费用占售价比例达到或超过 40% 时触发严重预警
 */
function evaluateHighFbaRatio(
  facts: ResearchFactSnapshot,
): DeterministicRiskRuleResult {
  const ruleId: DeterministicRiskRuleId = "HIGH_FBA_RATIO";
  const severity: DeterministicRiskSeverity = "WARNING";
  const sourceFields = ["facts.profit.fbaFee", "facts.basic.price"];
  const evidenceRefs = mergeMetricRefs(facts.profit.fbaFee, facts.basic.price);

  const priceVal = facts.basic.price?.value;
  const fbaFeeVal = facts.profit.fbaFee?.value;
  const sameCurrency = priceVal?.currency
    && fbaFeeVal?.currency
    && priceVal.currency.toUpperCase() === fbaFeeVal.currency.toUpperCase();

  if (
    priceVal
    && fbaFeeVal
    && sameCurrency
    && Number.isFinite(priceVal.amount)
    && priceVal.amount > 0
    && Number.isFinite(fbaFeeVal.amount)
    && fbaFeeVal.amount >= 0
  ) {
    const ratio = fbaFeeVal.amount / priceVal.amount;
    if (ratio >= RISK_THRESHOLDS.HIGH_FBA_RATIO_THRESHOLD) {
      const ratioPct = (ratio * 100).toFixed(1);
      const thresholdPct = (RISK_THRESHOLDS.HIGH_FBA_RATIO_THRESHOLD * 100).toFixed(1);
      return {
        ruleId,
        severity,
        status: "triggered",
        reason: `[严重预警] FBA 履约费用占售价比例畸高 (${ratioPct}% >= ${thresholdPct}%)，运费与平台抽成严重侵蚀商品收益。`,
        sourceFields,
        evidenceRefs,
      };
    }
    return {
      ruleId,
      severity,
      status: "passed",
      reason: null,
      sourceFields,
      evidenceRefs,
    };
  }

  return {
    ruleId,
    severity,
    status: "not_computable",
    reason: "缺少商品有效售价或 FBA 费用数据，无法判定 FBA 费占比风险。",
    sourceFields,
    evidenceRefs,
  };
}

/**
 * 规则 4: LOW_RATING_RISK (WARNING)
 * 买家评分低于 3.8 且评论数达到 30 条样本时触发严重客诉预警
 */
function evaluateLowRatingRisk(
  facts: ResearchFactSnapshot,
): DeterministicRiskRuleResult {
  const ruleId: DeterministicRiskRuleId = "LOW_RATING_RISK";
  const severity: DeterministicRiskSeverity = "WARNING";
  const sourceFields = ["facts.basic.rating", "facts.basic.reviewCount"];
  const evidenceRefs = mergeMetricRefs(facts.basic.rating, facts.basic.reviewCount);

  const rating = facts.basic.rating?.value;
  const reviewCount = facts.basic.reviewCount?.value;

  if (
    rating !== null
    && rating !== undefined
    && Number.isFinite(rating)
    && reviewCount !== null
    && reviewCount !== undefined
    && Number.isFinite(reviewCount)
  ) {
    if (
      rating < RISK_THRESHOLDS.LOW_RATING_THRESHOLD
      && reviewCount >= RISK_THRESHOLDS.LOW_RATING_MIN_REVIEWS
    ) {
      return {
        ruleId,
        severity,
        status: "triggered",
        reason: `[口碑预警] 商品买家评分过低 (${rating} < ${RISK_THRESHOLDS.LOW_RATING_THRESHOLD}，评论数 ${reviewCount})。建议结合原始评论调查原因；评分和评论数不能证明缺陷频率、客诉严重程度或退货率。`,
        sourceFields,
        evidenceRefs,
      };
    }
    return {
      ruleId,
      severity,
      status: "passed",
      reason: null,
      sourceFields,
      evidenceRefs,
    };
  }

  return {
    ruleId,
    severity,
    status: "not_computable",
    reason: "缺少商品买家评分或有效评论数，无法判定口碑与客诉风险。",
    sourceFields,
    evidenceRefs,
  };
}

/**
 * 规则 5: AMAZON_BUYBOX_RISK (WARNING)
 * Buybox 卖家包含 Amazon 时触发官方自营垄断预警
 */
function evaluateAmazonBuyboxRisk(
  facts: ResearchFactSnapshot,
): DeterministicRiskRuleResult {
  const ruleId: DeterministicRiskRuleId = "AMAZON_BUYBOX_RISK";
  const severity: DeterministicRiskSeverity = "WARNING";
  const sourceFields = ["facts.market.buyboxSeller"];
  const evidenceRefs = mergeMetricRefs(facts.market.buyboxSeller);

  const seller = facts.market.buyboxSeller?.value;

  if (typeof seller === "string" && seller.trim().length > 0) {
    if (seller.toLowerCase().includes("amazon")) {
      return {
        ruleId,
        severity,
        status: "triggered",
        reason: `[严重预警] Buybox 卖家为亚马逊自营 (${seller.trim()})，第三方卖家抢占购物车困难且极易遭遇官方流量与价格压制。`,
        sourceFields,
        evidenceRefs,
      };
    }
    return {
      ruleId,
      severity,
      status: "passed",
      reason: null,
      sourceFields,
      evidenceRefs,
    };
  }

  return {
    ruleId,
    severity,
    status: "not_computable",
    reason: "缺少 Buybox 卖家归属事实，无法判定亚马逊自营垄断风险。",
    sourceFields,
    evidenceRefs,
  };
}

/**
 * 规则 6: OVERSIZE_LOGISTICS_RISK (WARNING)
 * 计费重超 20 lb (9.07kg) 或单边最长边超 18 in (45.72cm) 时触发大件仓储物流预警
 */
function evaluateOversizeLogisticsRisk(
  facts: ResearchFactSnapshot,
): DeterministicRiskRuleResult {
  const ruleId: DeterministicRiskRuleId = "OVERSIZE_LOGISTICS_RISK";
  const severity: DeterministicRiskSeverity = "WARNING";
  const sourceFields = ["facts.profit.packageDimensions", "facts.profit.packageWeight"];
  const evidenceRefs = mergeMetricRefs(
    facts.profit.packageDimensions,
    facts.profit.packageWeight,
    facts.profit.itemDimensions,
    facts.profit.itemWeight,
  );

  const weightInfo = calculateChargeableWeightKg(facts);
  const pkgDims = facts.profit.packageDimensions?.value;
  const itmDims = facts.profit.itemDimensions?.value;
  // 物流规则只认「包装（外箱）尺寸」：商品本体尺寸不能代表发货外箱尺寸
  // （与 calculateChargeableWeightKg 的口径一致）。本体尺寸仅用于证据引用，
  // 不再作为包装尺寸的兜底，避免把本体尺寸误判成超大件物流结论。
  const dims = pkgDims ?? null;

  let maxDimCm: number | null = null;
  if (dims) {
    const isInch = dims.unit?.toLowerCase() === "in";
    const factor = isInch ? 2.54 : 1.0;
    const observedDimensions = [dims.length, dims.width, dims.height]
      .filter((dimension): dimension is number => typeof dimension === "number" && Number.isFinite(dimension));
    if (observedDimensions.length > 0) maxDimCm = Math.max(...observedDimensions) * factor;
  }

  if (weightInfo.chargeableWeightKg === null && maxDimCm === null) {
    return {
      ruleId,
      severity,
      status: "not_computable",
      reason: itmDims
        ? "仅有商品本体尺寸，缺少物流包装尺寸与包装重量；物流尺寸待验证，无法判定超大超重物流风险。"
        : "缺少商品重量与规格尺寸，无法判定超大超重物流风险。",
      sourceFields,
      evidenceRefs,
    };
  }

  const isOverweight = weightInfo.chargeableWeightKg !== null
    && weightInfo.chargeableWeightKg > RISK_THRESHOLDS.OVERSIZE_WEIGHT_KG_THRESHOLD;
  const isOversize = maxDimCm !== null
    && maxDimCm > RISK_THRESHOLDS.OVERSIZE_DIMENSION_CM_THRESHOLD;

  if (isOverweight || isOversize) {
    const issues: string[] = [];
    if (isOverweight && weightInfo.chargeableWeightKg !== null) {
      issues.push(`计费重 ${weightInfo.chargeableWeightKg.toFixed(2)}kg > ${RISK_THRESHOLDS.OVERSIZE_WEIGHT_KG_THRESHOLD}kg (20lb)`);
    }
    if (isOversize && maxDimCm !== null) {
      issues.push(`最长单边 ${maxDimCm.toFixed(1)}cm > ${RISK_THRESHOLDS.OVERSIZE_DIMENSION_CM_THRESHOLD}cm (18in)`);
    }

    return {
      ruleId,
      severity,
      status: "triggered",
      reason: `[严重预警] 商品属于超大超重物流大件 (${issues.join("，")})，头程海运与亚马逊仓储退货处理费高昂。`,
      sourceFields,
      evidenceRefs,
    };
  }

  return {
    ruleId,
    severity,
    status: "passed",
    reason: null,
    sourceFields,
    evidenceRefs,
  };
}

/**
 * 规则 7: MINOR_VARIATION_RISK (WARNING)
 * 当当前 ASIN 属于弱势非主力变体（isMinorVariation === true）时触发严重预警
 */
function evaluateMinorVariationRisk(
  facts: ResearchFactSnapshot,
): DeterministicRiskRuleResult {
  const ruleId: DeterministicRiskRuleId = "MINOR_VARIATION_RISK";
  const severity: DeterministicRiskSeverity = "WARNING";
  const sourceFields = [
    "facts.variationAnalysis.isMinorVariation",
    "facts.variationAnalysis.currentAsinSalesShare",
  ];
  const evidenceRefs = mergeMetricRefs(
    facts.variationAnalysis?.isMinorVariation,
    facts.variationAnalysis?.currentAsinSalesShare,
  );

  const isMinor = facts.variationAnalysis?.isMinorVariation?.value;
  const salesShare = facts.variationAnalysis?.currentAsinSalesShare?.value;

  if (typeof isMinor === "boolean") {
    if (isMinor === true) {
      const shareText =
        typeof salesShare === "number" ? ` (销量占比 ${(salesShare * 100).toFixed(1)}%)` : "";
      return {
        ruleId,
        severity,
        status: "triggered",
        reason: `[严重预警] 当前 ASIN 为弱势非主力销售变体${shareText}，销量可能寄生于父体 Listing，真实独立动销与变现能力存疑。`,
        sourceFields,
        evidenceRefs,
      };
    }
    return {
      ruleId,
      severity,
      status: "passed",
      reason: null,
      sourceFields,
      evidenceRefs,
    };
  }

  return {
    ruleId,
    severity,
    status: "not_computable",
    reason: "缺少变体销售拆解数据（isMinorVariation），无法判定弱势子体风险。",
    sourceFields,
    evidenceRefs,
  };
}

/**
 * 规则 8: AMAZON_MONOPOLY_RISK (WARNING)
 * 当 90天自营 Buybox 占比 >= 40% 或卖家市场份额 amazon1pShare >= 0.4 时触发自营垄断预警
 */
function evaluateAmazonMonopolyRisk(
  facts: ResearchFactSnapshot,
): DeterministicRiskRuleResult {
  const ruleId: DeterministicRiskRuleId = "AMAZON_MONOPOLY_RISK";
  const severity: DeterministicRiskSeverity = "WARNING";
  const sourceFields = [
    "facts.timeSeries.buyBoxAmazonSharePercent",
    "facts.concentration.amazon1pShare",
  ];
  const evidenceRefs = mergeMetricRefs(
    facts.timeSeries?.buyBoxAmazonSharePercent,
    facts.concentration?.amazon1pShare,
  );

  const buyboxShare = facts.timeSeries?.buyBoxAmazonSharePercent?.value;
  const amazon1p = facts.concentration?.amazon1pShare?.value;

  const hasBuyboxShare = typeof buyboxShare === "number" && Number.isFinite(buyboxShare);
  const hasAmazon1p = typeof amazon1p === "number" && Number.isFinite(amazon1p);

  if (!hasBuyboxShare && !hasAmazon1p) {
    return {
      ruleId,
      severity,
      status: "not_computable",
      reason: "缺少亚马逊自营时序占有率与卖家市场份额数据，无法判定自营垄断风险。",
      sourceFields,
      evidenceRefs,
    };
  }

  const isBuyboxTriggered =
    hasBuyboxShare && buyboxShare >= RISK_THRESHOLDS.AMAZON_BUYBOX_SHARE_THRESHOLD;
  const is1pTriggered =
    hasAmazon1p && amazon1p >= RISK_THRESHOLDS.AMAZON_1P_MARKET_SHARE_THRESHOLD;

  if (isBuyboxTriggered || is1pTriggered) {
    const reasons: string[] = [];
    if (isBuyboxTriggered) reasons.push(`90天自营 Buybox 占有率 ${buyboxShare}% >= 40%`);
    if (is1pTriggered) reasons.push(`卖家表自营市场份额 ${(amazon1p * 100).toFixed(1)}% >= 40%`);
    return {
      ruleId,
      severity,
      status: "triggered",
      reason: `[严重预警] 亚马逊自营占有率过高 (${reasons.join("；")})，第三方卖家面临严重的官方流量限制与价格压制风险。`,
      sourceFields,
      evidenceRefs,
    };
  }

  return {
    ruleId,
    severity,
    status: "passed",
    reason: null,
    sourceFields,
    evidenceRefs,
  };
}

/**
 * 规则 9: PRICE_WAR_COLLAPSE_RISK (BLOCK)
 * 当 90天历史最低价低于当前测算保本售价时触发一票否决
 */
function evaluatePriceWarCollapseRisk(
  facts: ResearchFactSnapshot,
  unitEconomics: UnitEconomicsCalculationResult,
): DeterministicRiskRuleResult {
  const ruleId: DeterministicRiskRuleId = "PRICE_WAR_COLLAPSE_RISK";
  const severity: DeterministicRiskSeverity = "BLOCK";
  const sourceFields = [
    "facts.timeSeries.price90dMin",
    "unitEconomics.deterministic.breakEvenPrice",
  ];
  const breakEvenRefs = unitEconomics.breakEvenPrice?.evidenceRefs ?? [];
  const factRefs = mergeMetricRefs(facts.timeSeries?.price90dMin);
  const seenRefs = new Set<string>();
  const evidenceRefs: ResearchEvidenceRef[] = [];
  for (const ref of [...factRefs, ...breakEvenRefs]) {
    if (!seenRefs.has(ref.refId)) {
      seenRefs.add(ref.refId);
      evidenceRefs.push(ref);
    }
  }

  const price90dMin = facts.timeSeries?.price90dMin?.value;
  const breakEvenPrice = unitEconomics.breakEvenPrice?.value?.amount;
  const currency = unitEconomics.breakEvenPrice?.value?.currency ?? "USD";

  if (
    typeof price90dMin !== "number"
    || !Number.isFinite(price90dMin)
    || typeof breakEvenPrice !== "number"
    || !Number.isFinite(breakEvenPrice)
  ) {
    return {
      ruleId,
      severity,
      status: "not_computable",
      reason: "缺少 90 天历史最低价或保本售价，无法判定历史价格击穿保本线风险。",
      sourceFields,
      evidenceRefs,
    };
  }

  if (price90dMin < breakEvenPrice) {
    return {
      ruleId,
      severity,
      status: "triggered",
      reason: `[一票否决] 90天历史最低售价 (${price90dMin} ${currency}) 已低于当前测算保本售价 (${breakEvenPrice} ${currency})，历史促销或价格战时期每售出一件将产生实质性亏损。`,
      sourceFields,
      evidenceRefs,
    };
  }

  return {
    ruleId,
    severity,
    status: "passed",
    reason: null,
    sourceFields,
    evidenceRefs,
  };
}

/**
 * 规则 10: HIGH_DEAL_DEPENDENCY_RISK (WARNING)
 * 当 90天内秒杀促销频次 >= 6 次时触发严重促销依赖预警
 */
function evaluateHighDealDependencyRisk(
  facts: ResearchFactSnapshot,
): DeterministicRiskRuleResult {
  const ruleId: DeterministicRiskRuleId = "HIGH_DEAL_DEPENDENCY_RISK";
  const severity: DeterministicRiskSeverity = "WARNING";
  const sourceFields = ["facts.timeSeries.dealCount90d"];
  const evidenceRefs = mergeMetricRefs(facts.timeSeries?.dealCount90d);

  const dealCount = facts.timeSeries?.dealCount90d?.value;

  if (typeof dealCount !== "number" || !Number.isFinite(dealCount)) {
    return {
      ruleId,
      severity,
      status: "not_computable",
      reason: "缺少 90 天秒杀促销频次数据，无法判定促销依赖风险。",
      sourceFields,
      evidenceRefs,
    };
  }

  if (dealCount >= RISK_THRESHOLDS.HIGH_DEAL_COUNT_THRESHOLD) {
    return {
      ruleId,
      severity,
      status: "triggered",
      reason: `[严重预警] 90天内秒杀促销频次达到 ${dealCount} 次 (>= ${RISK_THRESHOLDS.HIGH_DEAL_COUNT_THRESHOLD} 次)，销量与排名可能严重依赖促销活动，自然动销能力存疑。`,
      sourceFields,
      evidenceRefs,
    };
  }

  return {
    ruleId,
    severity,
    status: "passed",
    reason: null,
    sourceFields,
    evidenceRefs,
  };
}

/**
 * 规则 11: BRAND_OLIGOPOLY_RISK (WARNING)
 * 当品牌集中度 CR5 >= 0.7 (70%) 时触发严重品牌寡头垄断预警
 */
function evaluateBrandOligopolyRisk(
  facts: ResearchFactSnapshot,
): DeterministicRiskRuleResult {
  const ruleId: DeterministicRiskRuleId = "BRAND_OLIGOPOLY_RISK";
  const severity: DeterministicRiskSeverity = "WARNING";
  const sourceFields = ["facts.concentration.brandCr5Share"];
  const evidenceRefs = mergeMetricRefs(facts.concentration?.brandCr5Share);

  const cr5 = facts.concentration?.brandCr5Share?.value;

  if (typeof cr5 !== "number" || !Number.isFinite(cr5)) {
    return {
      ruleId,
      severity,
      status: "not_computable",
      reason: "缺少品牌集中度 CR5 数据，无法判定头部品牌垄断壁垒风险。",
      sourceFields,
      evidenceRefs,
    };
  }

  if (cr5 >= RISK_THRESHOLDS.BRAND_CR5_SHARE_THRESHOLD) {
    return {
      ruleId,
      severity,
      status: "triggered",
      reason: `[严重预警] 细分市场头部前5品牌份额 (CR5) 达到 ${(cr5 * 100).toFixed(1)}% (>= ${(RISK_THRESHOLDS.BRAND_CR5_SHARE_THRESHOLD * 100).toFixed(0)}%)，行业呈现高度寡头垄断，新进入品牌获客成本与广告竞价门槛极高。`,
      sourceFields,
      evidenceRefs,
    };
  }

  return {
    ruleId,
    severity,
    status: "passed",
    reason: null,
    sourceFields,
    evidenceRefs,
  };
}

/**
 * RDO-2: 纯函数确定性风险门禁引擎。
 * 输入：Facts 快照与 UnitEconomics 计算结果。
 * 输出：DeterministicRiskGateSummary（包含 11 大确定性规则判定与阻断汇总）。
 * 严格保持确定性，严禁调用 AI，严禁任何随机性。
 */
export function evaluateDeterministicRiskGates(input: {
  readonly facts: ResearchFactSnapshot;
  readonly unitEconomics: UnitEconomicsCalculationResult;
}): DeterministicRiskGateSummary {
  const { facts, unitEconomics } = input;

  const rules: DeterministicRiskRuleResult[] = [
    evaluateNegativeNetProfit(unitEconomics),
    evaluatePriceWarCollapseRisk(facts, unitEconomics),
    evaluateLowGrossMargin(unitEconomics),
    evaluateHighFbaRatio(facts),
    evaluateLowRatingRisk(facts),
    evaluateAmazonBuyboxRisk(facts),
    evaluateAmazonMonopolyRisk(facts),
    evaluateMinorVariationRisk(facts),
    evaluateHighDealDependencyRisk(facts),
    evaluateBrandOligopolyRisk(facts),
    evaluateOversizeLogisticsRisk(facts),
  ];

  const blockingRules = rules.filter((r) => r.severity === "BLOCK" && r.status === "triggered");
  const warningRules = rules.filter((r) => r.severity === "WARNING" && r.status === "triggered");

  const hasBlockingRisk = blockingRules.length > 0;
  const blockingReasons = blockingRules
    .map((r) => r.reason)
    .filter((reason): reason is string => typeof reason === "string" && reason.length > 0);
  const warningReasons = warningRules
    .map((r) => r.reason)
    .filter((reason): reason is string => typeof reason === "string" && reason.length > 0);

  let status: DeterministicRiskGateSummary["status"] = "passed";
  if (hasBlockingRisk) {
    status = "blocked";
  } else if (warningReasons.length > 0) {
    status = "warning";
  }

  return {
    status,
    hasBlockingRisk,
    rules,
    blockingReasons,
    warningReasons,
  };
}
