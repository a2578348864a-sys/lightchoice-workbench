import {
  isVerifiedNarrative,
  type DecisionChecklistItem,
  type DecisionChecklistStatus,
  type DeterministicRiskGateSummary,
  type ResearchDecisionSummary,
  type ResearchNarrative,
  type ResearchNextAction,
  type ResearchReport,
  type ResearchReportCore,
} from "./researchContracts";

/**
 * P0-DC：决策摘要只读取报告的确定性子集
 * （facts + unitEconomics.deterministic + riskAssessment.deterministicGate），
 * 叙事字段（marketOpportunity/competitionInsight/riskAssessment 分析文本）可选，
 * 缺失时按空降级。完整 ResearchReportCore / ResearchReport 结构上满足本类型，
 * researchEngine / researchPacketBuilder 的既有调用零改动。
 */
export type DecisionSummaryInput = {
  readonly facts: ResearchReportCore["facts"];
  readonly unitEconomics: Pick<ResearchReportCore["unitEconomics"], "facts" | "deterministic"> & {
    readonly analysis?: ResearchNarrative;
  };
  readonly riskAssessment: {
    readonly analysis?: ResearchNarrative | null;
    readonly risks?: readonly ResearchNarrative[];
    readonly deterministicGate?: DeterministicRiskGateSummary;
  };
  readonly marketOpportunity?: {
    readonly analysis?: ResearchNarrative;
  };
  readonly competitionInsight?: {
    readonly analysis?: ResearchNarrative;
  };
};

type FactFieldLike = {
  readonly value: unknown;
  readonly status: string;
};

function textOf(value: { readonly text: string | null } | null | undefined): string | null {
  const text = value?.text?.normalize("NFC").trim();
  return text ? text.slice(0, 600) : null;
}

/**
 * JEV-002：只有携带可追溯引用的叙述才能进入决策摘要。
 *
 * 兼容历史报告：若对象没有 evidenceRefs 字段（旧形态），保持原行为。
 */
function verifiedTextOf(value: ResearchNarrative | null | undefined): string | null {
  if (!value) return null;
  if (Array.isArray(value.evidenceRefs)) {
    return isVerifiedNarrative(value) ? textOf(value) : null;
  }
  return textOf(value);
}

function uniqueTexts(values: readonly (string | null | undefined)[], limit: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const text = value?.normalize("NFC").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text.slice(0, 600));
    if (output.length >= limit) break;
  }
  return output;
}

function isMissing(field: FactFieldLike | undefined): boolean {
  return !field || field.status === "missing" || field.value === null || field.value === undefined;
}

function missingInformation(report: DecisionSummaryInput): string[] {
  const fields: readonly [string, FactFieldLike][] = [
    ["当前售价", report.facts.basic.price],
    ["BSR", report.facts.market.bsr],
    ["月销量估计", report.facts.market.monthlySalesEstimate],
    ["月销售额估计", report.facts.market.monthlyRevenueEstimate],
    ["评分", report.facts.basic.rating],
    ["评论数", report.facts.basic.reviewCount],
    ["五点描述", report.facts.basic.bulletPoints],
    ["包装重量", report.facts.profit.packageWeight],
    ["包装尺寸", report.facts.profit.packageDimensions],
    ["FBA 费用", report.facts.profit.fbaFee],
  ];
  const missing = fields.filter(([, field]) => isMissing(field)).map(([label]) => label);
  if (report.unitEconomics.deterministic.grossProfit.status !== "available") {
    missing.push("采购成本、头程物流与其他经营成本");
  }
  return uniqueTexts(missing, 12);
}

function marketSignalCount(report: DecisionSummaryInput): number {
  return [
    report.facts.basic.price,
    report.facts.market.bsr,
    report.facts.market.monthlySalesEstimate,
    report.facts.market.monthlyRevenueEstimate,
  ].filter((field) => !isMissing(field)).length;
}

function summaryPriority(report: DecisionSummaryInput, missing: readonly string[]): ResearchDecisionSummary["researchPriority"] {
  const signals = marketSignalCount(report);
  if (signals >= 3 && missing.length <= 4) return "P1";
  if (signals >= 1) return "P2";
  return "P3";
}

/**
 * RDO-3: 解释 recommendedNextAction 的直接来源与驱动原因。
 * 覆盖：
 * - 暂停：BLOCK 风险 / 已存在风险
 * - 补充数据：missingInformation
 * - 继续研究：无阻断 / 有或无 warning
 */
export function buildActionReasons(
  action: ResearchNextAction,
  core: DecisionSummaryInput,
  missing: readonly string[],
  blockingRisks: readonly string[],
): string[] {
  const deterministicGate = core.riskAssessment.deterministicGate;

  if (action === "暂停") {
    if (deterministicGate?.hasBlockingRisk && deterministicGate.blockingReasons.length > 0) {
      return [...deterministicGate.blockingReasons];
    }
    if (blockingRisks.length > 0) {
      return ["市场核心信号完全缺失且已存在风险预警，暂缓深度调研投入。"];
    }
    return ["存在严重商业或数据风险，建议暂停。"];
  }

  if (action === "补充数据") {
    const preview = missing.length > 0 ? `：${missing.slice(0, 4).join("、")}${missing.length > 4 ? " 等" : ""}` : "";
    return [`核心决策数据缺失（共 ${missing.length} 项${preview}），不足以支撑选品结论，请先补充数据。`];
  }

  // action === "继续研究"
  const warnings = deterministicGate?.warningReasons ?? [];
  if (warnings.length > 0) {
    return [
      "基础市场信号完整且未触发硬阻断，但存在潜在预警需关注：",
      ...warnings,
    ];
  }

  return ["核心市场信号完整，经确定性门禁筛查未发现硬性阻断风险，建议推进深度调研。"];
}

/**
 * RDO-3: 决策前必备 8 项核心指标核对清单。
 * 固定 8 项：
 * 1. profit_margin: 单件利润与毛利率
 * 2. fba_ratio: FBA 费用占比
 * 3. customer_rating: 买家评分风险
 * 4. buybox_competition: Buy Box 竞争
 * 5. logistics_size: 尺寸重量物流
 * 6. price_stability: 价格稳定性与历史抗压（联动 PRICE_WAR_COLLAPSE_RISK、HIGH_DEAL_DEPENDENCY_RISK 与 stressNetProfit）
 * 7. variation_health: 变体动销健康度（联动 MINOR_VARIATION_RISK 与 currentAsinSalesShare）
 * 8. market_structure: 市场结构与竞争壁垒（联动 AMAZON_MONOPOLY_RISK 与 BRAND_OLIGOPOLY_RISK）
 *
 * 状态枚举：passed | blocked | warning | missing
 */
export function buildDecisionChecklist(core: DecisionSummaryInput): DecisionChecklistItem[] {
  const deterministicGate = core.riskAssessment.deterministicGate;
  const findRule = (ruleId: string) => deterministicGate?.rules.find((r) => r.ruleId === ruleId);

  // 1. 单件利润与毛利率 (联动 NEGATIVE_NET_PROFIT 与 LOW_GROSS_MARGIN)
  const profitRule = findRule("NEGATIVE_NET_PROFIT");
  const marginRule = findRule("LOW_GROSS_MARGIN");
  let profitStatus: DecisionChecklistStatus = "missing";
  let profitDetail = "缺少成本假设或关键事实，尚未完成单件利润与毛利率测算";

  if (profitRule?.status === "triggered") {
    profitStatus = "blocked";
    profitDetail = profitRule.reason ?? "单件净利润为负，产生实质性亏损";
  } else if (marginRule?.status === "triggered") {
    profitStatus = "warning";
    profitDetail = marginRule.reason ?? "毛利率低于红线预警阈值";
  } else if (profitRule?.status === "passed" && marginRule?.status === "passed") {
    profitStatus = "passed";
    profitDetail = "单件净利润与毛利率测算达标";
  } else {
    profitStatus = "missing";
    profitDetail = profitRule?.reason ?? marginRule?.reason ?? "缺少成本假设或关键事实，尚未完成单件利润与毛利率测算";
  }

  // 2. FBA 费用占比 (联动 HIGH_FBA_RATIO)
  const fbaRule = findRule("HIGH_FBA_RATIO");
  let fbaStatus: DecisionChecklistStatus = "missing";
  let fbaDetail = "缺少售价或 FBA 费用数据，无法核算 FBA 费用占比";

  if (fbaRule?.status === "triggered") {
    fbaStatus = "warning";
    fbaDetail = fbaRule.reason ?? "FBA 费用占售价比例过高";
  } else if (fbaRule?.status === "passed") {
    fbaStatus = "passed";
    fbaDetail = "FBA 费用占售价比例合理";
  } else {
    fbaStatus = "missing";
    fbaDetail = fbaRule?.reason ?? "缺少售价或 FBA 费用数据，无法核算 FBA 费用占比";
  }

  // 3. 买家评分风险 (联动 LOW_RATING_RISK)
  const ratingRule = findRule("LOW_RATING_RISK");
  let ratingStatus: DecisionChecklistStatus = "missing";
  let ratingDetail = "缺少评分或评论数事实数据，无法评估买家口碑风险";

  if (ratingRule?.status === "triggered") {
    ratingStatus = "warning";
    ratingDetail = ratingRule.reason ?? "买家评分过低，退货率与差评风险高";
  } else if (ratingRule?.status === "passed") {
    ratingStatus = "passed";
    ratingDetail = "买家口碑评分健康（高于 3.8 分）";
  } else {
    ratingStatus = "missing";
    ratingDetail = ratingRule?.reason ?? "缺少评分或评论数事实数据，无法评估买家口碑风险";
  }

  // 4. Buy Box 竞争 (联动 AMAZON_BUYBOX_RISK)
  const buyboxRule = findRule("AMAZON_BUYBOX_RISK");
  let buyboxStatus: DecisionChecklistStatus = "missing";
  let buyboxDetail = "缺少购物车卖家 (Buy Box Seller) 信息";

  if (buyboxRule?.status === "triggered") {
    buyboxStatus = "warning";
    buyboxDetail = buyboxRule.reason ?? "Amazon 官方自营自销竞争风险";
  } else if (buyboxRule?.status === "passed") {
    buyboxStatus = "passed";
    buyboxDetail = "非亚马逊自营垄断，第三方卖家有竞争空间";
  } else {
    buyboxStatus = "missing";
    buyboxDetail = buyboxRule?.reason ?? "缺少购物车卖家 (Buy Box Seller) 信息";
  }

  // 5. 尺寸重量物流 (联动 OVERSIZE_LOGISTICS_RISK)
  const sizeRule = findRule("OVERSIZE_LOGISTICS_RISK");
  let sizeStatus: DecisionChecklistStatus = "missing";
  let sizeDetail = "缺少包装尺寸或包装重量数据，无法核算物流超规风险";

  if (sizeRule?.status === "triggered") {
    sizeStatus = "warning";
    sizeDetail = sizeRule.reason ?? "超大尺寸或超重件物流风险";
  } else if (sizeRule?.status === "passed") {
    sizeStatus = "passed";
    sizeDetail = "尺寸与重量在标准件范围内，物流费率受控";
  } else {
    sizeStatus = "missing";
    sizeDetail = sizeRule?.reason ?? "缺少包装尺寸或包装重量数据，无法核算物流超规风险";
  }

  // 6. 价格稳定性与历史抗压 (联动 PRICE_WAR_COLLAPSE_RISK、HIGH_DEAL_DEPENDENCY_RISK、stressNetProfit 与 price90dMin)
  const priceCollapseRule = findRule("PRICE_WAR_COLLAPSE_RISK");
  const dealDepRule = findRule("HIGH_DEAL_DEPENDENCY_RISK");
  const stressNetProfit = core.unitEconomics.deterministic.stressNetProfit;
  const price90dMinField = core.facts.timeSeries?.price90dMin;
  const dealCountField = core.facts.timeSeries?.dealCount90d;

  let priceStabilityStatus: DecisionChecklistStatus = "missing";
  let priceStabilityDetail = "缺少90天时序价格或抗压测算数据，无法判定价格稳定性";

  if (priceCollapseRule?.status === "triggered") {
    priceStabilityStatus = "blocked";
    priceStabilityDetail = priceCollapseRule.reason ?? "历史最低价已击穿当前保本线，价格战将产生严重亏损";
  } else if (dealDepRule?.status === "triggered") {
    priceStabilityStatus = "warning";
    priceStabilityDetail = dealDepRule.reason ?? "90天秒杀促销频次过高，销量可能依赖低价促销";
  } else if (
    stressNetProfit?.status === "available"
    && stressNetProfit.value !== null
    && stressNetProfit.value.amount < 0
  ) {
    priceStabilityStatus = "warning";
    priceStabilityDetail = `历史最低售价下抗压净利润为负 (${stressNetProfit.value.amount} ${stressNetProfit.value.currency})，降价承压空间不足`;
  } else if (
    priceCollapseRule?.status === "passed"
    && dealDepRule?.status === "passed"
    && price90dMinField?.status === "present"
    && typeof price90dMinField.value === "number"
    && dealCountField?.status === "present"
    && typeof dealCountField.value === "number"
  ) {
    priceStabilityStatus = "passed";
    priceStabilityDetail = "90天历史售价稳定高于保本线，且促销频次正常，抗压测试达标";
  } else {
    priceStabilityStatus = "missing";
    if (priceCollapseRule?.status !== "passed" && dealDepRule?.status === "passed") {
      priceStabilityDetail = priceCollapseRule?.reason ?? "缺少90天历史最低售价数据，无法进行价格战抗压测试";
    } else if (priceCollapseRule?.status === "passed" && dealDepRule?.status !== "passed") {
      priceStabilityDetail = dealDepRule?.reason ?? "缺少90天秒杀促销频次数据，无法完整评估促销依赖风险";
    } else {
      priceStabilityDetail = "缺少90天时序价格或抗压测算数据，无法判定价格稳定性";
    }
  }

  // 7. 变体动销健康度 (联动 MINOR_VARIATION_RISK 与 currentAsinSalesShare)
  const minorVarRule = findRule("MINOR_VARIATION_RISK");
  const variationAnalysis = core.facts.variationAnalysis;
  const isMinorField = variationAnalysis?.isMinorVariation;
  const salesShareField = variationAnalysis?.currentAsinSalesShare;

  let varHealthStatus: DecisionChecklistStatus = "missing";
  let varHealthDetail = "缺少变体销量拆解数据，无法判定变体动销健康度";

  if (minorVarRule?.status === "triggered") {
    varHealthStatus = "warning";
    varHealthDetail = minorVarRule.reason ?? "当前 ASIN 为弱势非主力销售变体（销量占比 < 10%）";
  } else if (
    minorVarRule?.status === "passed"
    && isMinorField?.status === "present"
    && isMinorField.value === false
    && salesShareField?.status === "present"
    && typeof salesShareField.value === "number"
  ) {
    varHealthStatus = "passed";
    const shareText = ` (销量占比 ${(salesShareField.value * 100).toFixed(1)}%)`;
    varHealthDetail = `当前 ASIN 属于主力或健康销售变体${shareText}，动销能力良好`;
  } else {
    varHealthStatus = "missing";
    varHealthDetail = minorVarRule?.reason ?? "缺少变体销量拆解数据，无法判定变体动销健康度";
  }

  // 8. 市场结构与竞争壁垒 (联动 AMAZON_MONOPOLY_RISK 与 BRAND_OLIGOPOLY_RISK)
  const amazonMonopolyRule = findRule("AMAZON_MONOPOLY_RISK");
  const brandOligopolyRule = findRule("BRAND_OLIGOPOLY_RISK");
  const concentration = core.facts.concentration;
  const amazon1pField = concentration?.amazon1pShare;
  const brandCr5Field = concentration?.brandCr5Share;

  let marketStructStatus: DecisionChecklistStatus = "missing";
  let marketStructDetail = "缺少自营占有率或品牌集中度数据，无法判定市场结构风险";

  if (amazonMonopolyRule?.status === "triggered" || brandOligopolyRule?.status === "triggered") {
    marketStructStatus = "warning";
    const triggeredReasons = [amazonMonopolyRule?.reason, brandOligopolyRule?.reason]
      .filter((r): r is string => typeof r === "string" && r.length > 0);
    marketStructDetail = triggeredReasons.length > 0
      ? triggeredReasons.join("；")
      : (amazonMonopolyRule?.status === "triggered"
          ? (amazonMonopolyRule.reason ?? "亚马逊官方自营高比例垄断")
          : (brandOligopolyRule?.reason ?? "细分市场品牌集中度 CR5 畸高，寡头垄断壁垒严重"));
  } else {
    const isAmazonMonopolyPassed =
      amazonMonopolyRule?.status === "passed"
      && (
        (amazon1pField?.status === "present" && typeof amazon1pField.value === "number")
        || (core.facts.timeSeries?.buyBoxAmazonSharePercent?.status === "present" && typeof core.facts.timeSeries.buyBoxAmazonSharePercent.value === "number")
      );
    const isBrandOligopolyPassed =
      brandOligopolyRule?.status === "passed"
      && brandCr5Field?.status === "present"
      && typeof brandCr5Field.value === "number";

    if (isAmazonMonopolyPassed && isBrandOligopolyPassed) {
      marketStructStatus = "passed";
      marketStructDetail = "市场竞争格局健康，非官方自营或少数寡头极端垄断";
    } else {
      marketStructStatus = "missing";
      if (!isAmazonMonopolyPassed && isBrandOligopolyPassed) {
        marketStructDetail = amazonMonopolyRule?.reason ?? "缺少亚马逊自营占有率数据，无法完整判定市场结构风险";
      } else if (isAmazonMonopolyPassed && !isBrandOligopolyPassed) {
        marketStructDetail = brandOligopolyRule?.reason ?? "缺少细分市场品牌集中度 CR5 数据，无法完整判定市场结构风险";
      } else {
        marketStructDetail = "缺少自营占有率与品牌集中度数据，无法判定市场结构风险";
      }
    }
  }

  return [
    { key: "profit_margin", label: "单件利润与毛利率", status: profitStatus, detail: profitDetail },
    { key: "fba_ratio", label: "FBA 费用占比", status: fbaStatus, detail: fbaDetail },
    { key: "customer_rating", label: "买家评分风险", status: ratingStatus, detail: ratingDetail },
    { key: "buybox_competition", label: "Buy Box 竞争", status: buyboxStatus, detail: buyboxDetail },
    { key: "logistics_size", label: "尺寸重量物流", status: sizeStatus, detail: sizeDetail },
    { key: "price_stability", label: "价格稳定性与抗压", status: priceStabilityStatus, detail: priceStabilityDetail },
    { key: "variation_health", label: "变体动销健康度", status: varHealthStatus, detail: varHealthDetail },
    { key: "market_structure", label: "市场结构与竞争壁垒", status: marketStructStatus, detail: marketStructDetail },
  ];
}

/**
 * 根据报告中已经存在的字段与分析生成摘要。
 * 该函数不读取外部数据，不做利润/销量推测，也不把摘要解释成购买建议。
 */
export function buildDecisionSummary(report: DecisionSummaryInput): ResearchDecisionSummary {
  const core = report;
  const missing = missingInformation(core);
  // RDO-2: 提取确定性风险门禁结论（置顶硬阻断与预警规则）
  const deterministicGate = core.riskAssessment.deterministicGate;
  const deterministicBlocking = deterministicGate?.blockingReasons ?? [];
  const deterministicWarnings = deterministicGate?.warningReasons ?? [];

  const blockingRisks = uniqueTexts([
    ...deterministicBlocking,
    ...deterministicWarnings,
    ...(core.riskAssessment.risks ?? []).map((item) => verifiedTextOf(item)),
    verifiedTextOf(core.riskAssessment.analysis ?? null),
  ], 6);
  const keyReasons = uniqueTexts([
    verifiedTextOf(core.marketOpportunity?.analysis),
    verifiedTextOf(core.competitionInsight?.analysis),
    verifiedTextOf(core.riskAssessment.analysis ?? null),
  ], 5);
  const priority = summaryPriority(core, missing);
  const recommendedNextAction: ResearchDecisionSummary["recommendedNextAction"] =
    deterministicGate?.hasBlockingRisk
      ? "暂停"
      : missing.length >= 3
        ? "补充数据"
        : marketSignalCount(core) === 0 && blockingRisks.length > 0
          ? "暂停"
          : "继续研究";

  // RDO-3: 动作推荐原因与核对清单
  const actionReasons = buildActionReasons(recommendedNextAction, core, missing, blockingRisks);
  const checklist = buildDecisionChecklist(core);

  return {
    researchPriority: priority,
    recommendedNextAction,
    keyReasons,
    blockingRisks,
    missingInformation: missing,
    actionReasons,
    checklist,
  };
}

/** 读取新旧报告时的兼容辅助；不会改写旧 reportJson，也不会改变其 reportHash。 */
export function decisionSummaryOf(report: ResearchReport): ResearchDecisionSummary {
  return report.decisionSummary ?? buildDecisionSummary(report);
}
