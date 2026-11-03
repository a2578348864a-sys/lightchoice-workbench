import "server-only";

import type { CommercialInputs } from "@/lib/server/commercialInputs";
import type {
  EconomicAssumptionsInput,
  EconomicMetricNature,
  ResearchFactSnapshot,
  UnitEconomicsView,
  UnitEconomicsViewLine,
  UnitEconomicsViewMetric,
} from "@/lib/research/researchContracts";
import { calculateUnitEconomics, DEFAULT_EXCHANGE_RATE, SHIPPING_RATES_PER_KG } from "@/lib/server/research/unitEconomicsCalculator";

/**
 * V6 单位经济性场景映射层（纯函数）。
 *
 * 职责单一：
 * 1. 把人工保存的 `CommercialInputs` 映射为计算引擎的 `EconomicAssumptionsInput`；
 * 2. 把确定性计算结果投影为只读展示契约 `UnitEconomicsView`。
 *
 * 纪律：
 * - 用户输入一律标 `USER_INPUT`（或用户声明的官方来源 `CONFIRMED_REFERENCE`），
 *   绝不写成 Amazon 来源事实。
 * - 没有任何经济性字段时返回 `null`，保持「无输入 = 历史降级行为」不变。
 * - 本层不产生任何商业建议，不写 Human Decision，不生成 Product Brief。
 */

const ECONOMIC_FIELD_KEYS: readonly (keyof CommercialInputs)[] = [
  "purchasePrice",
  "logisticsCost",
  "targetSellingPrice",
  "packageWeight",
  "packageDimensions",
  "shippingMode",
  "shippingRatePerKg",
  "fbaFee",
  "commissionRate",
  "adCostRate",
  "exchangeRate",
];

export function hasEconomicInputs(inputs: CommercialInputs): boolean {
  return ECONOMIC_FIELD_KEYS.some((key) => inputs[key] !== undefined);
}

/** 用户声明的平台费率来源性质 → 计算引擎的来源性质。 */
function platformFeeNature(nature: CommercialInputs["platformFeeNature"]): EconomicMetricNature {
  return nature === "official_reference" ? "CONFIRMED_REFERENCE" : "USER_INPUT";
}

function effectiveDateIso(inputs: CommercialInputs, now: Date): string {
  const declared = inputs.platformFeeEffectiveDate;
  if (declared) {
    const parsed = Date.parse(`${declared}T00:00:00.000Z`);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return now.toISOString();
}

/**
 * 把人工商业输入映射为计算假设。
 * 无任何经济性字段时返回 `null`（保持历史 null 行为，不做任何默认值）。
 */
export function buildEconomicAssumptions(
  inputs: CommercialInputs,
  opts: { marketplace?: string | null; now?: Date } = {},
): EconomicAssumptionsInput | null {
  if (!hasEconomicInputs(inputs)) return null;
  const now = opts.now ?? new Date();
  const marketplace = opts.marketplace ?? null;
  const feeNature = platformFeeNature(inputs.platformFeeNature);
  const feeSource = inputs.platformFeeSourceNote
    ?? (inputs.platformFeeNature === "official_reference" ? "official_fee_schedule" : "user_scenario_input");
  const feeEffectiveDate = effectiveDateIso(inputs, now);

  const assumptions: { -readonly [K in keyof EconomicAssumptionsInput]: EconomicAssumptionsInput[K] } = {};

  if (inputs.purchasePrice) {
    assumptions.procurementCost = {
      amount: inputs.purchasePrice.value,
      currency: inputs.purchasePrice.currency,
    };
  }
  if (inputs.targetSellingPrice) {
    assumptions.targetSellingPrice = {
      amount: inputs.targetSellingPrice.value,
      currency: inputs.targetSellingPrice.currency,
    };
  }
  if (inputs.packageWeight) {
    assumptions.packageWeight = { value: inputs.packageWeight.value, unit: inputs.packageWeight.unit };
  }
  if (inputs.packageDimensions) {
    assumptions.packageDimensions = {
      length: inputs.packageDimensions.length,
      width: inputs.packageDimensions.width,
      height: inputs.packageDimensions.height,
      unit: inputs.packageDimensions.unit,
    };
  }
  // 头程口径二选一：用户直接给出单件头程费用 → 按单件计；否则按计费重 × 单价推导。
  if (inputs.logisticsCost) {
    assumptions.unitLogisticsCost = {
      amount: inputs.logisticsCost.value,
      currency: inputs.logisticsCost.currency,
    };
  } else if (inputs.shippingMode !== undefined || inputs.shippingRatePerKg !== undefined) {
    assumptions.shippingMode = inputs.shippingMode ?? "custom_rate";
    if (inputs.shippingRatePerKg !== undefined) {
      assumptions.customShippingRatePerKg = inputs.shippingRatePerKg;
    }
  }
  if (inputs.fbaFee) {
    assumptions.fbaFee = { amount: inputs.fbaFee.value, currency: inputs.fbaFee.currency };
  }
  if (inputs.commissionRate !== undefined) {
    assumptions.commissionRate = inputs.commissionRate;
  }
  if (inputs.adCostRate !== undefined) {
    assumptions.targetTacosRate = inputs.adCostRate;
  }
  if (inputs.exchangeRate !== undefined) {
    assumptions.exchangeRate = inputs.exchangeRate;
  }

  assumptions.metadata = {
    procurementCost: {
      marketplace,
      effectiveDate: now.toISOString(),
      source: "user_input",
      metricNature: "USER_INPUT",
      currency: inputs.purchasePrice?.currency ?? "CNY",
    },
    shippingRate: {
      marketplace,
      effectiveDate: now.toISOString(),
      source: "user_input",
      metricNature: "USER_INPUT",
      currency: inputs.logisticsCost?.currency ?? "USD",
    },
    fbaFee: {
      marketplace,
      effectiveDate: feeEffectiveDate,
      source: feeSource,
      metricNature: feeNature,
      currency: inputs.fbaFee?.currency ?? "USD",
    },
    commissionRate: {
      marketplace,
      effectiveDate: feeEffectiveDate,
      source: feeSource,
      metricNature: feeNature,
      currency: inputs.targetSellingPrice?.currency ?? "USD",
    },
    targetTacosRate: {
      marketplace,
      effectiveDate: now.toISOString(),
      source: "user_input",
      metricNature: "USER_INPUT",
      currency: inputs.targetSellingPrice?.currency ?? "USD",
    },
  };

  return assumptions;
}

const METRIC_LABELS: Record<string, { label: string; unit: "usd" | "ratio" }> = {
  grossProfit: { label: "毛利", unit: "usd" },
  grossMargin: { label: "毛利率", unit: "ratio" },
  netProfit: { label: "单件预计利润（净）", unit: "usd" },
  netMargin: { label: "预计利润率（净）", unit: "ratio" },
  roi: { label: "ROI（对到岸成本）", unit: "ratio" },
  breakEvenPrice: { label: "保本售价", unit: "usd" },
};

function lineOf(
  key: string,
  label: string,
  amountUsd: number | null,
  meta: { metricNature: EconomicMetricNature; source: string | null; effectiveDate: string | null; state: string },
  note: string | null,
): UnitEconomicsViewLine {
  return {
    key,
    label,
    amountUsd,
    nature: meta.metricNature,
    source: meta.source,
    effectiveDate: meta.effectiveDate,
    state: meta.state as UnitEconomicsViewLine["state"],
    note,
  };
}

function metricOf(
  key: keyof typeof METRIC_LABELS,
  metric: { value: unknown; status: string; reason: string | null },
): UnitEconomicsViewMetric {
  const meta = METRIC_LABELS[key];
  const raw = metric.value as { amount?: number } | number | null;
  const value = raw === null || raw === undefined
    ? null
    : typeof raw === "number"
      ? raw
      : typeof raw.amount === "number"
        ? raw.amount
        : null;
  return {
    key,
    label: meta.label,
    value,
    unit: meta.unit,
    status: metric.status === "available" ? "available" : "not_computable",
    reason: metric.reason,
  };
}

export function buildUnitEconomicsView(input: {
  readonly facts: ResearchFactSnapshot;
  readonly assumptions: EconomicAssumptionsInput | null;
  readonly marketplace?: string | null;
  readonly now?: Date;
}): UnitEconomicsView {
  const now = input.now ?? new Date();
  const result = calculateUnitEconomics({
    facts: input.facts,
    assumptions: input.assumptions,
    marketplace: input.marketplace ?? null,
  });
  const meta = result.inputMetadata;
  const available = result.costBreakdown !== null;
  const currency = result.costBreakdown
    ? result.netProfit.value?.currency ?? result.grossProfit.value?.currency ?? null
    : result.knownRevenueAfterFbaFee.value?.currency ?? null;

  const sellingPrice = lineOf(
    "sellingPrice",
    "商品售价",
    result.effectiveSellingPrice ? result.effectiveSellingPrice.amount : null,
    meta.sellingPrice,
    meta.sellingPrice.metricNature === "CONFIRMED_REFERENCE" ? "来源事实售价" : "用户设定的目标售价（情景）",
  );

  const costLines: UnitEconomicsViewLine[] = [];
  if (result.costBreakdown) {
    const b = result.costBreakdown;
    costLines.push(
      lineOf("procurementCost", "单件采购成本", b.procurementCostUsd, meta.procurementCost, "用户输入（人工报价或情景假设）"),
      lineOf("shipping", "包装与头程成本", b.shippingUsd, meta.shippingRate,
        result.freightBasis === "per_unit"
          ? "按单件头程费用直接计入（未使用计费重推导）"
          : `按计费重 ${result.chargeableWeightKg ?? "—"} kg × 单价推导${meta.shippingRate.source === "internal_shipping_rate_table" && input.assumptions?.shippingMode ? `；内置费率 ${SHIPPING_RATES_PER_KG[input.assumptions.shippingMode]} USD/kg，非供应商报价` : ""}`),
      lineOf("landedCost", "到岸成本合计", b.landedCostUsd, meta.procurementCost, "采购成本 + 头程成本"),
      lineOf("fbaFee", "FBA 配送费用", b.fbaFeeUsd, meta.fbaFee,
        meta.fbaFee.metricNature === "CONFIRMED_REFERENCE" ? "来源事实或用户声明的官方费率" : "用户输入的情景假设（非官方确认）"),
      lineOf("adCost", "广告及其他费用", b.adCostUsd, meta.targetTacosRate, "售价 × 目标广告费率"),
      lineOf("totalCost", "单件成本合计", b.totalCostUsd, meta.procurementCost,
        result.commissionIncluded ? "到岸成本 + FBA + 广告 + 佣金" : "到岸成本 + FBA + 广告（佣金未提供，未纳入）"),
    );
    if (typeof b.commissionUsd === "number") {
      costLines.splice(3, 0, lineOf(
        "commission",
        "平台佣金",
        b.commissionUsd,
        meta.commissionRate,
        meta.commissionRate.metricNature === "CONFIRMED_REFERENCE"
          ? "用户声明的官方费率来源"
          : "用户输入的情景假设（非官方确认）",
      ));
    }
  }

  const metrics: UnitEconomicsViewMetric[] = [
    metricOf("grossProfit", result.grossProfit),
    metricOf("grossMargin", result.grossMargin),
    metricOf("netProfit", result.netProfit),
    metricOf("netMargin", result.netMargin),
    metricOf("roi", result.roi),
    metricOf("breakEvenPrice", result.breakEvenPrice),
  ];

  const inputProvenance: UnitEconomicsViewLine[] = [
    lineOf("sellingPrice", "商品售价", null, meta.sellingPrice, null),
    lineOf("procurementCost", "单件采购成本", null, meta.procurementCost, null),
    lineOf("shippingRate", "头程费用口径", null, meta.shippingRate, null),
    lineOf("packageWeight", "包装重量", null, meta.packageWeight, null),
    lineOf("packageDimensions", "包装尺寸", null, meta.packageDimensions, null),
    lineOf("fbaFee", "FBA 配送费用", null, meta.fbaFee, null),
    lineOf("commissionRate", "平台佣金率", null, meta.commissionRate, null),
    lineOf("targetTacosRate", "目标广告费率", null, meta.targetTacosRate, null),
    lineOf("exchangeRate", "汇率", null, meta.exchangeRate,
      meta.exchangeRate.source === "internal_fixed_assumption"
        ? `未填写时使用 ${DEFAULT_EXCHANGE_RATE} CNY/USD 的内置固定假设，非实时汇率。`
        : null),
  ];

  const reasons = Array.from(new Set(
    metrics
      .map((m) => m.reason)
      .filter((reason): reason is string => typeof reason === "string" && reason.trim().length > 0),
  ));

  const formulaNotes: string[] = available && result.costBreakdown
    ? [
        `到岸成本 = 采购成本 + 头程成本 = ${result.costBreakdown.procurementCostUsd} + ${result.costBreakdown.shippingUsd} = ${result.costBreakdown.landedCostUsd} ${currency ?? ""}`.trim(),
        `毛利 = 售价 − 到岸成本 − FBA 费用${result.commissionIncluded ? " − 平台佣金" : ""}`,
        `净利 = 售价 − 单件成本合计（含广告费用${result.commissionIncluded ? "与平台佣金" : ""}）`,
        `保本售价 = (到岸成本 + FBA 费用) ÷ (1 − 目标广告费率${result.commissionIncluded ? " − 平台佣金率" : ""})`,
        "ROI = 净利 ÷ 到岸成本",
      ]
    : [];

  return {
    schema: "unit-economics-view.v1",
    status: available ? "available" : "not_computable",
    currency,
    computedAt: now.toISOString(),
    isPartialCostBasis: result.partialCostBasis,
    excludedCosts: result.excludedCosts,
    conditionalExcludedCosts: result.conditionalExcludedCosts,
    alwaysExcludedCosts: result.alwaysExcludedCosts,
    commissionIncluded: result.commissionIncluded,
    freightBasis: result.freightBasis,
    chargeableWeightKg: result.chargeableWeightKg,
    sellingPrice,
    costLines,
    totalUnitCostUsd: result.costBreakdown?.totalCostUsd ?? null,
    metrics,
    inputProvenance,
    reasons,
    formulaNotes,
  };
}
