import "server-only";

import type {
  ProductPackageDimensions,
  ProductPackageWeight,
  ProductPrice,
} from "@/lib/sourceLayer/fact/types";
import type {
  EconomicAssumptionsInput,
  EconomicMetricMetadata,
  EconomicMetricNature,
  EconomicMetricState,
  EconomicShippingMode,
  ResearchDeterministicMetric,
  ResearchEvidenceRef,
  ResearchFactField,
  ResearchFactSnapshot,
  UnitEconomicsCostBreakdown,
  UnitEconomicsInputMetadata,
} from "@/lib/research/researchContracts";

export type UnitEconomicsCalculationResult = {
  readonly knownRevenueAfterFbaFee: ResearchDeterministicMetric<ProductPrice>;
  readonly grossProfit: ResearchDeterministicMetric<ProductPrice>;
  readonly grossMargin: ResearchDeterministicMetric<number>;
  readonly netProfit: ResearchDeterministicMetric<ProductPrice>;
  readonly netMargin: ResearchDeterministicMetric<number>;
  readonly roi: ResearchDeterministicMetric<number>;
  readonly breakEvenPrice: ResearchDeterministicMetric<ProductPrice>;
  /** V5.1 Phase 2: 历史破位价抗压净利润 */
  readonly stressNetProfit?: ResearchDeterministicMetric<ProductPrice>;
  /** V5.1 Phase 2: 历史破位价抗压毛利率 */
  readonly stressMargin?: ResearchDeterministicMetric<number>;
  readonly costBreakdown: UnitEconomicsCostBreakdown | null;
  readonly assumptionsUsed: EconomicAssumptionsInput | null;
  readonly inputMetadata: UnitEconomicsInputMetadata;
  /** V6：本次测算实际采用的售价（用户目标价或来源事实售价）；无法确定时为 null。 */
  readonly effectiveSellingPrice: ProductPrice | null;
  /**
   * V6：本次测算明确**未纳入**的成本项（中文标签）。
   * 只要该数组非空，结果就是「部分成本口径」，展示层不得称为完整净利润。
   */
  readonly excludedCosts: readonly string[];
  /** V6：补齐对应输入后即可纳入的未计费用（当前仅平台佣金）。 */
  readonly conditionalExcludedCosts: readonly string[];
  /** V6：本模型始终不纳入的费用（与输入是否补齐无关）。 */
  readonly alwaysExcludedCosts: readonly string[];
  /** V6：是否为部分成本口径（= excludedCosts 非空）。 */
  readonly partialCostBasis: boolean;
  /** V6：是否纳入了平台佣金。 */
  readonly commissionIncluded: boolean;
  /** V6：头程费用的计算口径；未计算时为 null。 */
  readonly freightBasis: "chargeable_weight" | "per_unit" | null;
  /** V6：计费重（仅按计费重口径时有值；按单件头程费用口径时为 null）。 */
  readonly chargeableWeightKg: number | null;
};

export const DEFAULT_EXCHANGE_RATE = 7.2;

export const SHIPPING_RATES_PER_KG: Record<EconomicShippingMode, number> = {
  sea_fast: 2.5,
  sea_economy: 1.5,
  air_express: 7.5,
  custom_rate: 2.5,
};

/** 任何一次测算都必须显式登记的「未纳入」成本项。禁止用 0 假装已纳入。 */
const ALWAYS_EXCLUDED_COSTS: readonly string[] = [
  "退货与售后损失",
  "关税与进口税",
  "仓储费（月度仓储/长期仓储）",
  "其他经营费用（如检测、认证、保险）",
];

const COMMISSION_COST_LABEL = "平台佣金（Amazon 佣金/推荐费）";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function marketplaceOf(subjectKey: string): string | null {
  const parts = subjectKey.split(":");
  return parts.length >= 3 && parts[0] === "amazon" ? parts[1] || null : null;
}

function normalizeNature(value: string | undefined, hasValue: boolean): EconomicMetricNature {
  if (!hasValue) return "MISSING";
  if (value === "user_input") return "USER_INPUT";
  if (value === "estimate") return "ESTIMATED";
  if (value === "derived") return "ESTIMATED";
  return "CONFIRMED_REFERENCE";
}

function metadataState(
  metadata: Partial<Omit<EconomicMetricMetadata, "state">> | undefined,
  hasValue: boolean,
  now = new Date(),
): EconomicMetricState {
  if (!hasValue || !metadata?.marketplace || !metadata.effectiveDate || !metadata.source
    || !metadata.metricNature || metadata.metricNature === "MISSING" || !metadata.currency) {
    return "MISSING";
  }
  const timestamp = Date.parse(metadata.effectiveDate);
  if (Number.isNaN(timestamp)) return "MISSING";
  const staleAfterDays = typeof (metadata as { staleAfterDays?: number }).staleAfterDays === "number"
    ? (metadata as { staleAfterDays: number }).staleAfterDays
    : 180;
  if (staleAfterDays >= 0 && now.getTime() - timestamp > staleAfterDays * 86_400_000) return "STALE_REFERENCE";
  return "READY";
}

function buildMetadata(
  input: Partial<Omit<EconomicMetricMetadata, "state">> | undefined,
  fallback: Partial<Omit<EconomicMetricMetadata, "state">>,
  hasValue: boolean,
): EconomicMetricMetadata {
  const merged = { ...fallback, ...input };
  return {
    marketplace: merged.marketplace ?? null,
    effectiveDate: merged.effectiveDate ?? null,
    source: merged.source ?? null,
    metricNature: merged.metricNature ?? (hasValue ? "USER_INPUT" : "MISSING"),
    currency: merged.currency ?? null,
    state: metadataState(merged, hasValue),
  };
}

function missingMetric<T>(reason: string, refs: readonly ResearchEvidenceRef[] = []): ResearchDeterministicMetric<T> {
  return { value: null, status: "not_computable", evidenceRefs: refs, reason };
}

function mergeMetricRefs(...fields: readonly (ResearchFactField<unknown> | undefined)[]): ResearchEvidenceRef[] {
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

function convertWeightToKg(value: number, unit: string): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  switch (unit.toLowerCase()) {
    case "kg":
      return value;
    case "g":
      return value / 1000;
    case "lb":
      return value * 0.45359237;
    case "oz":
      return value * 0.02834952;
    default:
      return null;
  }
}

function convertDimensionsToVolumeCm3(
  length: number,
  width: number,
  height: number,
  unit: string,
): number | null {
  if (
    !Number.isFinite(length) || length <= 0
    || !Number.isFinite(width) || width <= 0
    || !Number.isFinite(height) || height <= 0
  ) {
    return null;
  }
  const isInch = unit.toLowerCase() === "in";
  const factor = isInch ? 2.54 : 1.0;
  return (length * factor) * (width * factor) * (height * factor);
}

/**
 * 计费重推导。只接受**包装**重量与**包装**尺寸；
 * 商品本体净重/净尺寸（itemWeight/itemDimensions）永远不参与，也不得代填。
 */
export function computeChargeableWeight(
  packageWeight: ProductPackageWeight | null | undefined,
  packageDimensions: ProductPackageDimensions | null | undefined,
  shippingMode: EconomicShippingMode = "sea_fast",
): {
  readonly chargeableWeightKg: number | null;
  readonly actualWeightKg: number | null;
  readonly volumeWeightKg: number | null;
} {
  const actualWeightKg = packageWeight ? convertWeightToKg(packageWeight.value, packageWeight.unit) : null;
  const volumeCm3 = packageDimensions
    ? convertDimensionsToVolumeCm3(
        packageDimensions.length,
        packageDimensions.width,
        packageDimensions.height,
        packageDimensions.unit,
      )
    : null;

  const divisor = shippingMode === "air_express" ? 5000 : 6000;
  const volumeWeightKg = volumeCm3 ? volumeCm3 / divisor : null;

  let chargeableWeightKg: number | null = null;
  if (actualWeightKg !== null && volumeWeightKg !== null) {
    chargeableWeightKg = Math.max(actualWeightKg, volumeWeightKg);
  } else if (actualWeightKg !== null) {
    chargeableWeightKg = actualWeightKg;
  } else if (volumeWeightKg !== null) {
    chargeableWeightKg = volumeWeightKg;
  }

  return {
    chargeableWeightKg: chargeableWeightKg !== null ? round4(chargeableWeightKg) : null,
    actualWeightKg: actualWeightKg !== null ? round4(actualWeightKg) : null,
    volumeWeightKg: volumeWeightKg !== null ? round4(volumeWeightKg) : null,
  };
}

export function calculateChargeableWeightKg(
  facts: ResearchFactSnapshot,
  shippingMode: EconomicShippingMode = "sea_fast",
): {
  readonly chargeableWeightKg: number | null;
  readonly actualWeightKg: number | null;
  readonly volumeWeightKg: number | null;
} {
  // 1. 计费实重只使用包装重量；单品净重不是发货包装重量。
  // 2. 体积重只使用包装尺寸；商品本体尺寸不能代表发货外箱尺寸。
  return computeChargeableWeight(
    facts.profit.packageWeight?.value ?? null,
    facts.profit.packageDimensions?.value ?? null,
    shippingMode,
  );
}

/**
 * V6 有效输入字段：统一承载「事实优先、用户假设兜底」两种来源。
 * `metricNature` 直接决定展示层的来源性质，禁止把用户假设写成 CONFIRMED_REFERENCE。
 */
type EffectiveField<T> = {
  readonly value: T | null;
  readonly present: boolean;
  readonly source: string | null;
  readonly capturedAt: string | null;
  readonly metricNature: EconomicMetricNature;
  readonly evidenceRefs: readonly ResearchEvidenceRef[];
};

function fromFactField<T>(field: ResearchFactField<T> | undefined): EffectiveField<T> {
  const hasValue = !!field && field.status === "present" && field.value !== null;
  return {
    value: field?.value ?? null,
    present: hasValue,
    source: field?.source ?? null,
    capturedAt: field?.capturedAt ?? null,
    metricNature: normalizeNature(field?.metricNature, hasValue),
    evidenceRefs: field?.evidenceRefs ?? [],
  };
}

function fromUserInput<T>(value: T | null, capturedAt: string): EffectiveField<T> {
  return {
    value,
    present: value !== null,
    source: "user_input",
    capturedAt,
    metricNature: value !== null ? "USER_INPUT" : "MISSING",
    evidenceRefs: [],
  };
}

/** 事实优先；事实缺失时才回落到用户输入。 */
function preferFact<T>(fact: EffectiveField<T>, user: EffectiveField<T> | null): EffectiveField<T> {
  if (fact.present) return fact;
  if (user && user.present) return user;
  return fact;
}

function effectiveMetadata(
  field: EffectiveField<unknown>,
  currency: string | null,
  marketplace: string | null,
): EconomicMetricMetadata {
  return buildMetadata({
    marketplace,
    effectiveDate: field.capturedAt,
    source: field.source,
    metricNature: field.metricNature,
    currency,
  }, {}, field.present);
}

/**
 * RDO-1 / V6 纯函数确定性测算引擎。
 * 严禁把测算逻辑交由 AI 提示词猜测。
 * 保证无输入时 100% 保持历史降级行为。
 *
 * V6 扩展（全部向后兼容）：
 * - 目标售价 / 包装重量 / 包装尺寸 / FBA 费用 / 单件头程费用可由用户情景假设提供，
 *   但**事实优先**：已核验事实存在时永不使用用户值。
 * - 新增平台佣金（可选）。未提供佣金时公式与历史完全一致。
 * - 明确登记「未纳入」成本项，避免把部分成本测算当作完整净利润。
 */
export function calculateUnitEconomics(input: {
  readonly facts: ResearchFactSnapshot;
  readonly assumptions?: EconomicAssumptionsInput | null;
  /** 商品所在市场（US/UK…）。缺省时从证据引用推断；用于平台费率的适用市场登记。 */
  readonly marketplace?: string | null;
}): UnitEconomicsCalculationResult {
  const { facts, assumptions } = input;
  const now = new Date();
  const nowIso = now.toISOString();

  const factPrice = fromFactField(facts.basic.price);
  const factFbaFee = fromFactField(facts.profit.fbaFee);
  const factPkgWeight = fromFactField(facts.profit.packageWeight);
  const factPkgDims = fromFactField(facts.profit.packageDimensions);

  const refs = mergeMetricRefs(
    facts.basic.price,
    facts.profit.fbaFee,
    facts.profit.packageWeight,
    facts.profit.packageDimensions,
  );
  const marketplace = input.marketplace ?? marketplaceOf(refs[0]?.subjectKey ?? "");

  const userPrice = assumptions?.targetSellingPrice
    ? fromUserInput(assumptions.targetSellingPrice, nowIso)
    : null;
  const userFbaFee = assumptions?.fbaFee ? fromUserInput(assumptions.fbaFee, nowIso) : null;
  const userPkgWeight = assumptions?.packageWeight ? fromUserInput(assumptions.packageWeight, nowIso) : null;
  const userPkgDims = assumptions?.packageDimensions ? fromUserInput(assumptions.packageDimensions, nowIso) : null;
  const userUnitLogistics = assumptions?.unitLogisticsCost
    ? fromUserInput(assumptions.unitLogisticsCost, nowIso)
    : null;

  // 目标售价：用户显式设定时覆盖事实售价（情景测算）；否则使用事实售价。
  const priceField = userPrice?.present ? userPrice : factPrice;
  const fbaFeeField = preferFact(factFbaFee, userFbaFee);
  const pkgWeightField = preferFact(factPkgWeight, userPkgWeight);
  const pkgDimsField = preferFact(factPkgDims, userPkgDims);

  const priceVal = priceField.value;
  const fbaFeeVal = fbaFeeField.value;

  const commissionRate = assumptions?.commissionRate;
  const commissionProvided = typeof commissionRate === "number";
  // 两类未纳入必须分开：佣金是「补齐后即可纳入」，其余是「模型始终不纳入」。
  const conditionalExcludedCosts: string[] = commissionProvided ? [] : [COMMISSION_COST_LABEL];
  const alwaysExcludedCosts: string[] = [...ALWAYS_EXCLUDED_COSTS];
  const excludedCosts: string[] = [...conditionalExcludedCosts, ...alwaysExcludedCosts];

  // 即使其他必填项缺失而无法计算，也要保留已填写输入的来源；
  // 否则页面会把用户已经保存的字段错误列为「仍缺的输入」。
  const partialInputMetadata = (
    provided: boolean,
    metadata: Partial<Omit<EconomicMetricMetadata, "state">> | undefined,
    currency: string | null,
  ) => provided
    ? buildMetadata(metadata, { marketplace, effectiveDate: nowIso, source: "user_input", metricNature: "USER_INPUT", currency }, true)
    : buildMetadata(undefined, {}, false);
  const hasShippingInput = Boolean(userUnitLogistics?.present)
    || assumptions?.shippingMode !== undefined
    || assumptions?.customShippingRatePerKg !== undefined;
  const usesInternalShippingRate = !userUnitLogistics?.present
    && assumptions?.shippingMode !== undefined
    && (assumptions.shippingMode !== "custom_rate" || assumptions.customShippingRatePerKg === undefined);
  const emptyMetadata: UnitEconomicsInputMetadata = {
    sellingPrice: effectiveMetadata(priceField, priceVal?.currency ?? null, marketplace),
    procurementCost: partialInputMetadata(Boolean(assumptions?.procurementCost), assumptions?.metadata?.procurementCost, assumptions?.procurementCost?.currency ?? null),
    shippingRate: usesInternalShippingRate
      ? buildMetadata(undefined, { marketplace, effectiveDate: nowIso, source: "internal_shipping_rate_table", metricNature: "ESTIMATED", currency: "USD" }, true)
      : partialInputMetadata(hasShippingInput, assumptions?.metadata?.shippingRate, userUnitLogistics?.value?.currency ?? "USD"),
    packageWeight: effectiveMetadata(pkgWeightField, "kg", marketplace),
    packageDimensions: effectiveMetadata(pkgDimsField, "cm", marketplace),
    fbaFee: effectiveMetadata(fbaFeeField, fbaFeeVal?.currency ?? null, marketplace),
    commissionRate: partialInputMetadata(commissionProvided, assumptions?.metadata?.commissionRate, priceVal?.currency ?? null),
    targetTacosRate: partialInputMetadata(assumptions?.targetTacosRate !== undefined, assumptions?.metadata?.targetTacosRate, priceVal?.currency ?? null),
    exchangeRate: partialInputMetadata(assumptions?.exchangeRate !== undefined, assumptions?.metadata?.exchangeRate, "CNY/USD"),
  };

  // 1. 已知扣除 FBA 后的金额（历史既有逻辑保持不变）
  const sameCurrency = priceVal?.currency
    && fbaFeeVal?.currency
    && priceVal.currency.toUpperCase() === fbaFeeVal.currency.toUpperCase();

  const knownRevenueAfterFbaFee = sameCurrency
    && priceVal
    && fbaFeeVal
    && Number.isFinite(priceVal.amount)
    && Number.isFinite(fbaFeeVal.amount)
    ? {
        amount: round2(priceVal.amount - fbaFeeVal.amount),
        currency: priceVal.currency,
      }
    : null;

  const knownRevenueMetric: ResearchDeterministicMetric<ProductPrice> = {
    value: knownRevenueAfterFbaFee,
    status: knownRevenueAfterFbaFee ? "available" : "not_computable",
    evidenceRefs: refs,
    reason: knownRevenueAfterFbaFee
      ? null
      : "缺少售价、FBA 费或统一币种，无法计算已知扣除 FBA 后金额。",
  };

  const fallbackNotComputable = (reason: string): UnitEconomicsCalculationResult => ({
    knownRevenueAfterFbaFee: knownRevenueMetric,
    grossProfit: {
      value: null,
      status: "not_computable",
      evidenceRefs: refs,
      reason,
    },
    grossMargin: {
      value: null,
      status: "not_computable",
      evidenceRefs: refs,
      reason,
    },
    netProfit: {
      value: null,
      status: "not_computable",
      evidenceRefs: refs,
      reason,
    },
    netMargin: {
      value: null,
      status: "not_computable",
      evidenceRefs: refs,
      reason,
    },
    roi: missingMetric(reason, refs),
    breakEvenPrice: {
      value: null,
      status: "not_computable",
      evidenceRefs: refs,
      reason,
    },
    stressNetProfit: {
      value: null,
      status: "not_computable",
      evidenceRefs: refs,
      reason,
    },
    stressMargin: {
      value: null,
      status: "not_computable",
      evidenceRefs: refs,
      reason,
    },
    costBreakdown: null,
    assumptionsUsed: null,
    inputMetadata: emptyMetadata,
    effectiveSellingPrice: priceVal
      ? { amount: priceVal.amount, currency: priceVal.currency }
      : null,
    excludedCosts,
    conditionalExcludedCosts,
    alwaysExcludedCosts,
    partialCostBasis: excludedCosts.length > 0,
    commissionIncluded: false,
    freightBasis: null,
    chargeableWeightKg: null,
  });

  // 2. 检查是否有有效输入（无输入保持旧逻辑）
  if (!assumptions || !assumptions.procurementCost) {
    return fallbackNotComputable("缺少成本数据，暂无法估算利润");
  }

  // 3. 校验输入合法性（非法负数、非法汇率等）
  const procurementCost = assumptions.procurementCost;
  if (!Number.isFinite(procurementCost.amount) || procurementCost.amount < 0) {
    return fallbackNotComputable("成本测算参数无效：采购成本不能为负数或非法数值。");
  }
  if (assumptions.customShippingRatePerKg !== undefined && assumptions.customShippingRatePerKg < 0) {
    return fallbackNotComputable("成本测算参数无效：自定义运费单价不能为负数。");
  }
  if (assumptions.targetTacosRate !== undefined && assumptions.targetTacosRate < 0) {
    return fallbackNotComputable("成本测算参数无效：目标广告费率不能为负数。");
  }
  if (assumptions.exchangeRate !== undefined && assumptions.exchangeRate <= 0) {
    return fallbackNotComputable("成本测算参数无效：汇率必须为正数。");
  }
  if (commissionProvided && (!Number.isFinite(commissionRate) || commissionRate < 0)) {
    return fallbackNotComputable("成本测算参数无效：平台佣金率不能为负数或非法数值。");
  }
  if (userUnitLogistics && userUnitLogistics.value && userUnitLogistics.value.amount < 0) {
    return fallbackNotComputable("成本测算参数无效：单件头程物流费用不能为负数。");
  }
  if (assumptions.packageWeight && assumptions.packageWeight.value <= 0) {
    return fallbackNotComputable("成本测算参数无效：包装重量必须为正数。");
  }
  if (assumptions.packageDimensions
    && (assumptions.packageDimensions.length <= 0
      || assumptions.packageDimensions.width <= 0
      || assumptions.packageDimensions.height <= 0)) {
    return fallbackNotComputable("成本测算参数无效：包装尺寸各边必须为正数。");
  }

  if (assumptions.targetTacosRate === undefined) {
    return fallbackNotComputable("缺少目标广告费率；不默认按 0 计算广告成本。\n");
  }

  // 4. 检查基础事实（售价与 FBA 费）
  if (!priceVal || !Number.isFinite(priceVal.amount) || priceVal.amount <= 0) {
    return fallbackNotComputable("缺少有效商品售价，无法计算利润。");
  }
  if (!fbaFeeVal || !Number.isFinite(fbaFeeVal.amount) || fbaFeeVal.amount < 0) {
    return fallbackNotComputable("缺少有效 FBA 费用，无法计算利润。");
  }
  if (!sameCurrency) {
    return fallbackNotComputable(
      `商品售价币种 (${priceVal.currency}) 与 FBA 费用币种 (${fbaFeeVal.currency}) 不一致，无法计算利润。`,
    );
  }

  const currency = priceVal.currency.toUpperCase();
  const exchangeRate = assumptions.exchangeRate && assumptions.exchangeRate > 0
    ? assumptions.exchangeRate
    : DEFAULT_EXCHANGE_RATE;

  // 采购成本折算为 USD
  const procurementCostUsd = procurementCost.currency === "CNY"
    ? round2(procurementCost.amount / exchangeRate)
    : round2(procurementCost.amount);

  // 5. 头程费用：优先「用户直接给出的单件头程费用」，否则按计费重 × 单价推导。
  let shippingUsd: number;
  let freightBasis: "chargeable_weight" | "per_unit";
  let chargeableWeightKg: number | null = null;
  let shippingRateNature: EconomicMetricNature = "ESTIMATED";
  let shippingRateSource = "internal_shipping_rate_table";
  let shippingRateCurrency = "USD";

  if (userUnitLogistics?.present && userUnitLogistics.value) {
    freightBasis = "per_unit";
    shippingRateNature = "USER_INPUT";
    shippingRateSource = "user_input";
    shippingRateCurrency = userUnitLogistics.value.currency;
    shippingUsd = userUnitLogistics.value.currency === "CNY"
      ? round2(userUnitLogistics.value.amount / exchangeRate)
      : round2(userUnitLogistics.value.amount);
  } else {
    if (assumptions.shippingMode === undefined) {
      return fallbackNotComputable("缺少头程物流计费模式；不默认套用物流费率。\n");
    }
    freightBasis = "chargeable_weight";
    const shippingMode: EconomicShippingMode = assumptions.shippingMode;
    const shippingRatePerKg = shippingMode === "custom_rate"
      ? (assumptions.customShippingRatePerKg ?? SHIPPING_RATES_PER_KG.custom_rate)
      : SHIPPING_RATES_PER_KG[shippingMode];
    if (shippingMode === "custom_rate" && assumptions.customShippingRatePerKg !== undefined) {
      shippingRateNature = "USER_INPUT";
      shippingRateSource = "user_input";
    }

    const weightInfo = computeChargeableWeight(pkgWeightField.value, pkgDimsField.value, shippingMode);
    if (weightInfo.chargeableWeightKg === null) {
      return fallbackNotComputable(
        "缺少包装重量和包装尺寸，无法确定计费重以计算头程运费与到岸成本。",
      );
    }
    chargeableWeightKg = weightInfo.chargeableWeightKg;
    shippingUsd = round2(weightInfo.chargeableWeightKg * shippingRatePerKg);
  }

  // 到岸成本 = 采购 + 头程
  const landedCostUsd = round2(procurementCostUsd + shippingUsd);
  const fbaFeeUsd = round2(fbaFeeVal.amount);

  // 广告成本
  const targetTacosRate = assumptions.targetTacosRate;
  const adCostUsd = round2(priceVal.amount * targetTacosRate);

  // 平台佣金（仅在用户提供佣金率时纳入；缺省时不按 0 计入公式，但已在 excludedCosts 明确列出）
  const commissionUsd = commissionProvided ? round2(priceVal.amount * commissionRate) : 0;

  // 总经营成本
  const totalCostUsd = round2(landedCostUsd + fbaFeeUsd + adCostUsd + commissionUsd);

  // 毛利 = 售价 - 到岸成本 - FBA 费用 - 平台佣金
  const grossProfitUsd = round2(priceVal.amount - landedCostUsd - fbaFeeUsd - commissionUsd);
  const grossMarginVal = round4(grossProfitUsd / priceVal.amount);

  // 净利 = 售价 - 总成本
  const netProfitUsd = round2(priceVal.amount - totalCostUsd);
  const netMarginVal = round4(netProfitUsd / priceVal.amount);

  // 保本售价 P：P - landedCost - fbaFee - P * (tacos + commission) = 0
  // P * (1 - tacos - commission) = landedCost + fbaFee
  const variableRateTotal = targetTacosRate + (commissionProvided ? commissionRate : 0);
  let breakEvenPriceMetric: ResearchDeterministicMetric<ProductPrice>;
  if (variableRateTotal >= 1.0) {
    breakEvenPriceMetric = {
      value: null,
      status: "not_computable",
      evidenceRefs: refs,
      reason: "目标广告费率（含平台佣金）达到或超过 100%，无法实现盈亏平衡。",
    };
  } else {
    const breakEvenAmount = round2((landedCostUsd + fbaFeeUsd) / (1.0 - variableRateTotal));
    breakEvenPriceMetric = {
      value: { amount: breakEvenAmount, currency },
      status: "available",
      evidenceRefs: refs,
      reason: null,
    };
  }

  // V5.1 Phase 2: 历史价格压力测试 (Stress Test)
  // 如果 facts.timeSeries.price90dMin 存在，使用历史最低价重新计算单件净利润与毛利率
  const price90dMinField = facts.timeSeries?.price90dMin;
  const price90dMinVal = price90dMinField?.value;
  let stressNetProfitMetric: ResearchDeterministicMetric<ProductPrice>;
  let stressMarginMetric: ResearchDeterministicMetric<number>;

  if (
    typeof price90dMinVal === "number"
    && Number.isFinite(price90dMinVal)
    && price90dMinVal > 0
  ) {
    const extraRefs = price90dMinField?.evidenceRefs ?? [];
    const seenRefs = new Set<string>();
    const stressRefs: ResearchEvidenceRef[] = [];
    for (const ref of [...refs, ...extraRefs]) {
      if (!seenRefs.has(ref.refId)) {
        seenRefs.add(ref.refId);
        stressRefs.push(ref);
      }
    }
    // 历史破位价下的毛利与毛利率 (毛利 = 最低售价 - 到岸成本 - FBA费用 - 佣金)
    const stressCommissionUsd = commissionProvided ? round2(price90dMinVal * commissionRate) : 0;
    const stressGrossProfitUsd = round2(price90dMinVal - landedCostUsd - fbaFeeUsd - stressCommissionUsd);
    const stressMarginVal = round4(stressGrossProfitUsd / price90dMinVal);

    // 历史破位价下的广告与净利
    const stressAdCostUsd = round2(price90dMinVal * targetTacosRate);
    const stressTotalCostUsd = round2(landedCostUsd + fbaFeeUsd + stressAdCostUsd + stressCommissionUsd);
    const stressNetProfitUsd = round2(price90dMinVal - stressTotalCostUsd);

    stressNetProfitMetric = {
      value: { amount: stressNetProfitUsd, currency },
      status: "available",
      evidenceRefs: stressRefs,
      reason: null,
    };
    stressMarginMetric = {
      value: stressMarginVal,
      status: "available",
      evidenceRefs: stressRefs,
      reason: null,
    };
  } else {
    stressNetProfitMetric = {
      value: null,
      status: "not_computable",
      evidenceRefs: refs,
      reason: "缺少 90 天历史最低售价（price90dMin），无法进行历史价格抗压净利润测算。",
    };
    stressMarginMetric = {
      value: null,
      status: "not_computable",
      evidenceRefs: refs,
      reason: "缺少 90 天历史最低售价（price90dMin），无法进行历史价格抗压毛利率测算。",
    };
  }

  const costBreakdown: UnitEconomicsCostBreakdown = {
    procurementCostUsd,
    shippingUsd,
    landedCostUsd,
    fbaFeeUsd,
    adCostUsd,
    ...(commissionProvided ? { commissionUsd } : {}),
    totalCostUsd,
  };

  const assumptionMetadata = assumptions.metadata;
  const exchangeRateRequired = procurementCost.currency === "CNY" || userUnitLogistics?.value?.currency === "CNY";
  const exchangeRateProvided = assumptions.exchangeRate !== undefined;
  const inputMetadata: UnitEconomicsInputMetadata = {
    sellingPrice: effectiveMetadata(priceField, priceVal.currency, marketplace),
    procurementCost: buildMetadata(assumptionMetadata?.procurementCost, {
      marketplace,
      effectiveDate: nowIso,
      source: "user_input",
      metricNature: "USER_INPUT",
      currency: procurementCost.currency,
    }, true),
    shippingRate: buildMetadata(shippingRateSource === "internal_shipping_rate_table" ? undefined : assumptionMetadata?.shippingRate, {
      marketplace,
      effectiveDate: nowIso,
      source: shippingRateSource,
      metricNature: shippingRateNature,
      currency: shippingRateCurrency,
    }, true),
    packageWeight: effectiveMetadata(pkgWeightField, pkgWeightField.value?.unit ?? "kg", marketplace),
    packageDimensions: effectiveMetadata(pkgDimsField, pkgDimsField.value?.unit ?? "cm", marketplace),
    fbaFee: effectiveMetadata(fbaFeeField, fbaFeeVal.currency, marketplace),
    commissionRate: commissionProvided
      ? buildMetadata(assumptionMetadata?.commissionRate, {
          marketplace,
          effectiveDate: nowIso,
          source: "user_input",
          metricNature: "USER_INPUT",
          currency: priceVal.currency,
        }, true)
      : buildMetadata(undefined, {}, false),
    targetTacosRate: buildMetadata(assumptionMetadata?.targetTacosRate, {
      marketplace,
      effectiveDate: nowIso,
      source: "user_input",
      metricNature: "USER_INPUT",
      currency: priceVal.currency,
    }, true),
    exchangeRate: exchangeRateRequired || exchangeRateProvided
      ? buildMetadata(exchangeRateProvided ? assumptionMetadata?.exchangeRate : undefined, {
          marketplace,
          effectiveDate: nowIso,
          source: exchangeRateProvided ? "user_input" : "internal_fixed_assumption",
          metricNature: exchangeRateProvided ? "USER_INPUT" : "ESTIMATED",
          currency: "CNY/USD",
        }, true)
      : buildMetadata(undefined, {}, false),
  };

  const staleOrMissing = Object.entries(inputMetadata)
    // 人民币采购或人民币单件头程均需要汇率；佣金可选。
    .filter(([key]) => key !== "exchangeRate" || exchangeRateRequired)
    .filter(([key]) => key !== "commissionRate" || commissionProvided)
    // 包装重量/尺寸的存在性由「缺少包装重量和包装尺寸」检查负责，不参与就绪判定。
    .filter(([key]) => key !== "packageWeight" && key !== "packageDimensions")
    .filter(([, value]) => value.state !== "READY");
  if (staleOrMissing.length > 0) {
    const details = staleOrMissing.map(([key, value]) => `${key}:${value.state}`).join("，");
    return {
      ...fallbackNotComputable(`单位经济学输入不可用：${details}。`),
      inputMetadata,
    };
  }

  const roiVal = landedCostUsd > 0 ? round4(netProfitUsd / landedCostUsd) : null;
  const roiMetric: ResearchDeterministicMetric<number> = roiVal === null
    ? missingMetric("到岸成本为 0，无法计算 ROI。", refs)
    : { value: roiVal, status: "available", evidenceRefs: refs, reason: null };

  return {
    knownRevenueAfterFbaFee: knownRevenueMetric,
    grossProfit: {
      value: { amount: grossProfitUsd, currency },
      status: "available",
      evidenceRefs: refs,
      reason: null,
    },
    grossMargin: {
      value: grossMarginVal,
      status: "available",
      evidenceRefs: refs,
      reason: null,
    },
    netProfit: {
      value: { amount: netProfitUsd, currency },
      status: "available",
      evidenceRefs: refs,
      reason: null,
    },
    netMargin: {
      value: netMarginVal,
      status: "available",
      evidenceRefs: refs,
      reason: null,
    },
    roi: roiMetric,
    breakEvenPrice: breakEvenPriceMetric,
    stressNetProfit: stressNetProfitMetric,
    stressMargin: stressMarginMetric,
    costBreakdown,
    assumptionsUsed: assumptions,
    inputMetadata,
    effectiveSellingPrice: { amount: priceVal.amount, currency: priceVal.currency },
    excludedCosts,
    conditionalExcludedCosts,
    alwaysExcludedCosts,
    partialCostBasis: excludedCosts.length > 0,
    commissionIncluded: commissionProvided,
    freightBasis,
    chargeableWeightKg,
  };
}
