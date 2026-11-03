import "server-only";

export type CommercialInputCurrency = "CNY" | "USD";
export type CommercialComplianceStatus = "not_reviewed" | "reviewed_ok" | "issues_found";
/** V6：包装重量单位（仅包装毛重）。 */
export type CommercialWeightUnit = "kg" | "lb" | "oz" | "g";
/** V6：包装尺寸单位。 */
export type CommercialDimensionUnit = "cm" | "in";
/** V6：头程计费模式（按计费重口径时使用）。 */
export type CommercialShippingMode = "sea_fast" | "sea_economy" | "air_express" | "custom_rate";
/** V6：平台费率性质——官方引用 vs 用户情景假设。 */
export type CommercialPlatformFeeNature = "official_reference" | "user_scenario";

/**
 * 人工商业输入（存储位置：`candidateAnalysisContext.commercialInputs`）。
 *
 * 语义纪律（V6）：
 * - 这里的每个数值都是**用户输入**：要么是已核实的人工报价，要么是明确标记的情景假设。
 *   它们不构成 Amazon 来源事实，不得写入正式 ProductFact。
 * - `packageWeight` / `packageDimensions` 只接受**包装**参数；商品本体净重/净尺寸不得代填。
 * - `fbaFee` / `commissionRate` 属于平台费用：缺少可靠来源时必须标 `platformFeeNature =
 *   "user_scenario"`，结果按情景测算呈现，不得冒充官方准确费用。
 * - 0 是合法值（例如佣金率为 0 的站点、免头程），不得当成空值。
 */
export type CommercialInputs = {
  /** 单件采购价（value ≥ 0；currency 默认 CNY；0 是合法值，不得当成空值） */
  purchasePrice?: { value: number; currency: CommercialInputCurrency };
  /** MOQ：必须为正整数 */
  moq?: number;
  /** 单件头程物流费用（用户直接给出时按单件计，跳过计费重推导） */
  logisticsCost?: { value: number; currency: CommercialInputCurrency };
  /** 合规核对状态与依据备注（备注 ≤ 500 字符） */
  compliance?: { status: CommercialComplianceStatus; note?: string };
  /** V6：目标销售价格（情景假设；缺省时使用商品事实售价） */
  targetSellingPrice?: { value: number; currency: CommercialInputCurrency };
  /** V6：单件包装重量（仅包装毛重） */
  packageWeight?: { value: number; unit: CommercialWeightUnit };
  /** V6：单件包装尺寸 */
  packageDimensions?: { length: number; width: number; height: number; unit: CommercialDimensionUnit };
  /** V6：头程计费模式（与 shippingRatePerKg 搭配，按计费重口径） */
  shippingMode?: CommercialShippingMode;
  /** V6：头程单价（每公斤，按计费重口径） */
  shippingRatePerKg?: number;
  /** V6：FBA 配送费用 */
  fbaFee?: { value: number; currency: CommercialInputCurrency };
  /** V6：Amazon 平台佣金率（0–1 比例） */
  commissionRate?: number;
  /** V6：广告费用假设（目标 TACoS，0–1 比例） */
  adCostRate?: number;
  /** V6：汇率（CNY→USD，必须为正数） */
  exchangeRate?: number;
  /** V6：平台费率性质；缺省按 user_scenario 处理 */
  platformFeeNature?: CommercialPlatformFeeNature;
  /** V6：平台费率来源说明（≤ 200 字符） */
  platformFeeSourceNote?: string;
  /** V6：平台费率生效日期（YYYY-MM-DD） */
  platformFeeEffectiveDate?: string;
};

const CURRENCIES: ReadonlySet<string> = new Set(["CNY", "USD"]);
const COMPLIANCE_STATUSES: ReadonlySet<string> = new Set(["not_reviewed", "reviewed_ok", "issues_found"]);
const WEIGHT_UNITS: ReadonlySet<string> = new Set(["kg", "lb", "oz", "g"]);
const DIMENSION_UNITS: ReadonlySet<string> = new Set(["cm", "in"]);
const SHIPPING_MODES: ReadonlySet<string> = new Set(["sea_fast", "sea_economy", "air_express", "custom_rate"]);
const PLATFORM_FEE_NATURES: ReadonlySet<string> = new Set(["official_reference", "user_scenario"]);
const NOTE_MAX_CHARS = 500;
const SOURCE_NOTE_MAX_CHARS = 200;
const EFFECTIVE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "purchasePrice",
  "moq",
  "logisticsCost",
  "compliance",
  "targetSellingPrice",
  "packageWeight",
  "packageDimensions",
  "shippingMode",
  "shippingRatePerKg",
  "fbaFee",
  "commissionRate",
  "adCostRate",
  "exchangeRate",
  "platformFeeNature",
  "platformFeeSourceNote",
  "platformFeeEffectiveDate",
]);

export type ParseCommercialInputsResult =
  | { ok: true; inputs: CommercialInputs }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 严格校验：未知字段拒绝；数值有限；MOQ 正整数；备注长度限制；至少提供一个字段。 */
export function parseCommercialInputs(value: unknown): ParseCommercialInputsResult {
  if (!isRecord(value)) return { ok: false, error: "commercial_inputs_invalid" };
  for (const key of Object.keys(value)) {
    if (!ALLOWED_FIELDS.has(key)) return { ok: false, error: "unknown_field:" + key };
  }
  const inputs: CommercialInputs = {};

  if (value.purchasePrice !== undefined) {
    const price = parseMoney(value.purchasePrice, "purchasePrice");
    if (!price.ok) return price;
    inputs.purchasePrice = { value: price.value, currency: price.currency };
  }
  if (value.moq !== undefined) {
    if (typeof value.moq !== "number" || !Number.isInteger(value.moq) || value.moq < 1) {
      return { ok: false, error: "moq_positive_integer_required" };
    }
    inputs.moq = value.moq;
  }
  if (value.logisticsCost !== undefined) {
    const cost = parseMoney(value.logisticsCost, "logisticsCost");
    if (!cost.ok) return cost;
    inputs.logisticsCost = { value: cost.value, currency: cost.currency };
  }
  if (value.compliance !== undefined) {
    if (!isRecord(value.compliance) || typeof value.compliance.status !== "string"
      || !COMPLIANCE_STATUSES.has(value.compliance.status)) {
      return { ok: false, error: "compliance_status_invalid" };
    }
    const compliance: NonNullable<CommercialInputs["compliance"]> = {
      status: value.compliance.status as CommercialComplianceStatus,
    };
    if (value.compliance.note !== undefined) {
      if (typeof value.compliance.note !== "string") return { ok: false, error: "compliance_note_invalid" };
      const note = value.compliance.note.trim();
      if (note.length > NOTE_MAX_CHARS) return { ok: false, error: "compliance_note_too_long" };
      if (note) compliance.note = note;
    }
    inputs.compliance = compliance;
  }

  // ── V6 单位经济性情景输入 ────────────────────────────────────────────────
  if (value.targetSellingPrice !== undefined) {
    const price = parseMoney(value.targetSellingPrice, "targetSellingPrice");
    if (!price.ok) return price;
    inputs.targetSellingPrice = { value: price.value, currency: price.currency };
  }
  if (value.packageWeight !== undefined) {
    const weight = value.packageWeight;
    if (!isRecord(weight) || typeof weight.value !== "number" || !Number.isFinite(weight.value) || weight.value <= 0
      || typeof weight.unit !== "string" || !WEIGHT_UNITS.has(weight.unit)) {
      return { ok: false, error: "packageWeight_invalid" };
    }
    inputs.packageWeight = { value: weight.value, unit: weight.unit as CommercialWeightUnit };
  }
  if (value.packageDimensions !== undefined) {
    const dims = value.packageDimensions;
    const sides = isRecord(dims)
      ? [dims.length, dims.width, dims.height]
      : [];
    if (!isRecord(dims)
      || sides.some((side) => typeof side !== "number" || !Number.isFinite(side) || side <= 0)
      || typeof dims.unit !== "string" || !DIMENSION_UNITS.has(dims.unit)) {
      return { ok: false, error: "packageDimensions_invalid" };
    }
    inputs.packageDimensions = {
      length: dims.length as number,
      width: dims.width as number,
      height: dims.height as number,
      unit: dims.unit as CommercialDimensionUnit,
    };
  }
  if (value.shippingMode !== undefined) {
    if (typeof value.shippingMode !== "string" || !SHIPPING_MODES.has(value.shippingMode)) {
      return { ok: false, error: "shippingMode_invalid" };
    }
    inputs.shippingMode = value.shippingMode as CommercialShippingMode;
  }
  if (value.shippingRatePerKg !== undefined) {
    if (typeof value.shippingRatePerKg !== "number" || !Number.isFinite(value.shippingRatePerKg)
      || value.shippingRatePerKg < 0) {
      return { ok: false, error: "shippingRatePerKg_invalid" };
    }
    inputs.shippingRatePerKg = value.shippingRatePerKg;
  }
  if (value.fbaFee !== undefined) {
    const fee = parseMoney(value.fbaFee, "fbaFee");
    if (!fee.ok) return fee;
    inputs.fbaFee = { value: fee.value, currency: fee.currency };
  }
  if (value.commissionRate !== undefined) {
    if (typeof value.commissionRate !== "number" || !Number.isFinite(value.commissionRate)
      || value.commissionRate < 0 || value.commissionRate > 1) {
      return { ok: false, error: "commissionRate_out_of_range" };
    }
    inputs.commissionRate = value.commissionRate;
  }
  if (value.adCostRate !== undefined) {
    if (typeof value.adCostRate !== "number" || !Number.isFinite(value.adCostRate)
      || value.adCostRate < 0 || value.adCostRate > 1) {
      return { ok: false, error: "adCostRate_out_of_range" };
    }
    inputs.adCostRate = value.adCostRate;
  }
  if (value.exchangeRate !== undefined) {
    if (typeof value.exchangeRate !== "number" || !Number.isFinite(value.exchangeRate) || value.exchangeRate <= 0) {
      return { ok: false, error: "exchangeRate_invalid" };
    }
    inputs.exchangeRate = value.exchangeRate;
  }
  if (value.platformFeeNature !== undefined) {
    if (typeof value.platformFeeNature !== "string" || !PLATFORM_FEE_NATURES.has(value.platformFeeNature)) {
      return { ok: false, error: "platformFeeNature_invalid" };
    }
    inputs.platformFeeNature = value.platformFeeNature as CommercialPlatformFeeNature;
  }
  if (value.platformFeeSourceNote !== undefined) {
    if (typeof value.platformFeeSourceNote !== "string") return { ok: false, error: "platformFeeSourceNote_invalid" };
    const note = value.platformFeeSourceNote.trim();
    if (note.length > SOURCE_NOTE_MAX_CHARS) return { ok: false, error: "platformFeeSourceNote_too_long" };
    if (note) inputs.platformFeeSourceNote = note;
  }
  if (value.platformFeeEffectiveDate !== undefined) {
    if (typeof value.platformFeeEffectiveDate !== "string"
      || !EFFECTIVE_DATE_PATTERN.test(value.platformFeeEffectiveDate.trim())) {
      return { ok: false, error: "platformFeeEffectiveDate_invalid" };
    }
    inputs.platformFeeEffectiveDate = value.platformFeeEffectiveDate.trim();
  }

  if (Object.keys(inputs).length === 0) return { ok: false, error: "commercial_inputs_empty" };
  return { ok: true, inputs };
}

function parseMoney(value: unknown, field: string): { ok: true; value: number; currency: CommercialInputCurrency } | { ok: false; error: string } {
  if (!isRecord(value) || typeof value.value !== "number" || !Number.isFinite(value.value) || value.value < 0
    || typeof value.currency !== "string" || !CURRENCIES.has(value.currency)) {
    return { ok: false, error: field + "_invalid" };
  }
  return { ok: true, value: value.value, currency: value.currency as CommercialInputCurrency };
}

/** 存储位置：candidateAnalysisContext.commercialInputs（research-save 写入器拥有；
 * 该命名空间在证据指纹集内 → 完成研究后写入自动沿用既有 stale 重新确认机制）。 */
export const COMMERCIAL_INPUTS_STORAGE = "commercialInputs" as const;

export function readCommercialInputs(result: Record<string, unknown> | null | undefined): CommercialInputs {
  if (!isRecord(result) || !isRecord(result.candidateAnalysisContext)) return {};
  const stored = (result.candidateAnalysisContext as Record<string, unknown>).commercialInputs;
  const parsed = parseCommercialInputs(stored);
  return parsed.ok ? parsed.inputs : {};
}

export function applyCommercialInputsRecord(
  current: Readonly<Record<string, unknown>>,
  inputs: CommercialInputs,
): Record<string, unknown> {
  const context = isRecord(current.candidateAnalysisContext) ? current.candidateAnalysisContext : {};
  return {
    ...current,
    candidateAnalysisContext: { ...context, commercialInputs: inputs },
  };
}

export function isCompletedForInputs(result: unknown): boolean {
  if (!isRecord(result)) return false;
  const completion = isRecord(result.researchCompletion) ? result.researchCompletion : null;
  return completion?.schema === "research-completion.v1" && completion.status === "completed";
}
