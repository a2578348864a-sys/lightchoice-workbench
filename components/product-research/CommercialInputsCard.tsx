"use client";

import { useEffect, useMemo, useState } from "react";
import { buildAccessHeaders } from "@/lib/client/accessToken";

type Currency = "CNY" | "USD";
type WeightUnit = "kg" | "lb" | "oz" | "g";
type DimensionUnit = "cm" | "in";
type ShippingMode = "sea_fast" | "sea_economy" | "air_express" | "custom_rate";
type PlatformFeeNature = "official_reference" | "user_scenario";
type ComplianceStatus = "not_reviewed" | "reviewed_ok" | "issues_found";

export type CommercialInputsForm = {
  targetSellingPriceValue: string;
  targetSellingPriceCurrency: Currency;
  purchasePriceValue: string;
  purchasePriceCurrency: Currency;
  moq: string;
  logisticsValue: string;
  logisticsCurrency: Currency;
  packageWeightValue: string;
  packageWeightUnit: WeightUnit;
  packageLength: string;
  packageWidth: string;
  packageHeight: string;
  packageDimensionUnit: DimensionUnit;
  shippingRatePerKg: string;
  shippingMode: ShippingMode;
  fbaFeeValue: string;
  fbaFeeCurrency: Currency;
  commissionRatePercent: string;
  adCostRatePercent: string;
  exchangeRate: string;
  platformFeeNature: PlatformFeeNature;
  platformFeeSourceNote: string;
  platformFeeEffectiveDate: string;
  complianceStatus: ComplianceStatus;
  complianceNote: string;
};

const EMPTY: CommercialInputsForm = {
  targetSellingPriceValue: "",
  targetSellingPriceCurrency: "USD",
  purchasePriceValue: "",
  purchasePriceCurrency: "CNY",
  moq: "",
  logisticsValue: "",
  logisticsCurrency: "CNY",
  packageWeightValue: "",
  packageWeightUnit: "kg",
  packageLength: "",
  packageWidth: "",
  packageHeight: "",
  packageDimensionUnit: "cm",
  shippingRatePerKg: "",
  shippingMode: "custom_rate",
  fbaFeeValue: "",
  fbaFeeCurrency: "USD",
  commissionRatePercent: "",
  adCostRatePercent: "",
  exchangeRate: "",
  platformFeeNature: "user_scenario",
  platformFeeSourceNote: "",
  platformFeeEffectiveDate: "",
  complianceStatus: "not_reviewed",
  complianceNote: "",
};

type Loaded = { ok: boolean; inputs?: Record<string, unknown>; stale?: boolean; storageVersion?: unknown };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function money(value: unknown): { value?: number; currency?: string } | null {
  const raw = record(value);
  return raw ? { value: raw.value as number | undefined, currency: raw.currency as string | undefined } : null;
}

function numText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/** 比例（0–1）→ 百分比字符串（15 = 15%）。 */
function ratioText(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return String(Math.round(value * 1_000_000) / 10_000);
}

function currencyOf(value: string | undefined, fallback: Currency): Currency {
  return value === "USD" ? "USD" : value === "CNY" ? "CNY" : fallback;
}

function toForm(inputs: Record<string, unknown>): CommercialInputsForm {
  const selling = money(inputs.targetSellingPrice);
  const price = money(inputs.purchasePrice);
  const logistics = money(inputs.logisticsCost);
  const fba = money(inputs.fbaFee);
  const weight = record(inputs.packageWeight);
  const dims = record(inputs.packageDimensions);
  const compliance = record(inputs.compliance);
  const nature = inputs.platformFeeNature === "official_reference" ? "official_reference" : "user_scenario";
  const shippingMode = (["sea_fast", "sea_economy", "air_express", "custom_rate"] as const)
    .includes(inputs.shippingMode as never)
    ? inputs.shippingMode as ShippingMode
    : "custom_rate";
  const weightUnit = (["kg", "lb", "oz", "g"] as const).includes(weight?.unit as never)
    ? weight?.unit as WeightUnit
    : "kg";
  const dimUnit = (["cm", "in"] as const).includes(dims?.unit as never) ? dims?.unit as DimensionUnit : "cm";
  return {
    targetSellingPriceValue: numText(selling?.value),
    targetSellingPriceCurrency: currencyOf(selling?.currency, "USD"),
    purchasePriceValue: numText(price?.value),
    purchasePriceCurrency: currencyOf(price?.currency, "CNY"),
    moq: numText(inputs.moq),
    logisticsValue: numText(logistics?.value),
    logisticsCurrency: currencyOf(logistics?.currency, "CNY"),
    packageWeightValue: numText(weight?.value),
    packageWeightUnit: weightUnit,
    packageLength: numText(dims?.length),
    packageWidth: numText(dims?.width),
    packageHeight: numText(dims?.height),
    packageDimensionUnit: dimUnit,
    shippingRatePerKg: numText(inputs.shippingRatePerKg),
    shippingMode,
    fbaFeeValue: numText(fba?.value),
    fbaFeeCurrency: currencyOf(fba?.currency, "USD"),
    commissionRatePercent: ratioText(inputs.commissionRate),
    adCostRatePercent: ratioText(inputs.adCostRate),
    exchangeRate: numText(inputs.exchangeRate),
    platformFeeNature: nature,
    platformFeeSourceNote: typeof inputs.platformFeeSourceNote === "string" ? inputs.platformFeeSourceNote : "",
    platformFeeEffectiveDate: typeof inputs.platformFeeEffectiveDate === "string" ? inputs.platformFeeEffectiveDate : "",
    complianceStatus: (["not_reviewed", "reviewed_ok", "issues_found"] as const).includes(compliance?.status as never)
      ? compliance?.status as ComplianceStatus
      : "not_reviewed",
    complianceNote: typeof compliance?.note === "string" ? compliance.note : "",
  };
}

function optionalNumber(text: string): number | undefined {
  if (text.trim() === "") return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalRatio(text: string): number | undefined {
  const percent = optionalNumber(text);
  if (percent === undefined) return undefined;
  return Math.round((percent / 100) * 1_000_000) / 1_000_000;
}

function savedFields(form: CommercialInputsForm): { [key: string]: unknown } {
  const out: { [key: string]: unknown } = {};
  const selling = optionalNumber(form.targetSellingPriceValue);
  if (selling !== undefined) out.targetSellingPrice = { value: selling, currency: form.targetSellingPriceCurrency };
  const purchase = optionalNumber(form.purchasePriceValue);
  if (purchase !== undefined) out.purchasePrice = { value: purchase, currency: form.purchasePriceCurrency };
  const moq = optionalNumber(form.moq);
  if (moq !== undefined) out.moq = moq;
  const logistics = optionalNumber(form.logisticsValue);
  if (logistics !== undefined) out.logisticsCost = { value: logistics, currency: form.logisticsCurrency };

  const weight = optionalNumber(form.packageWeightValue);
  if (weight !== undefined) out.packageWeight = { value: weight, unit: form.packageWeightUnit };
  const length = optionalNumber(form.packageLength);
  const width = optionalNumber(form.packageWidth);
  const height = optionalNumber(form.packageHeight);
  if (length !== undefined || width !== undefined || height !== undefined) {
    if (length === undefined || width === undefined || height === undefined) return { __invalid: "packageDimensions_incomplete" };
    out.packageDimensions = { length, width, height, unit: form.packageDimensionUnit };
  }

  const ratePerKg = optionalNumber(form.shippingRatePerKg);
  if (ratePerKg !== undefined) {
    out.shippingRatePerKg = ratePerKg;
    out.shippingMode = form.shippingMode;
  }

  const fba = optionalNumber(form.fbaFeeValue);
  if (fba !== undefined) out.fbaFee = { value: fba, currency: form.fbaFeeCurrency };

  const commission = optionalRatio(form.commissionRatePercent);
  if (commission !== undefined) out.commissionRate = commission;
  const adCost = optionalRatio(form.adCostRatePercent);
  if (adCost !== undefined) out.adCostRate = adCost;

  const exchange = optionalNumber(form.exchangeRate);
  if (exchange !== undefined) out.exchangeRate = exchange;

  if (form.platformFeeNature !== "user_scenario") out.platformFeeNature = form.platformFeeNature;
  if (form.platformFeeSourceNote.trim() !== "") out.platformFeeSourceNote = form.platformFeeSourceNote.trim();
  if (form.platformFeeEffectiveDate.trim() !== "") out.platformFeeEffectiveDate = form.platformFeeEffectiveDate.trim();

  if (form.complianceStatus !== "not_reviewed" || form.complianceNote !== "") {
    out.compliance = {
      status: form.complianceStatus,
      ...(form.complianceNote !== "" ? { note: form.complianceNote } : {}),
    };
  }
  return out;
}

/** 客户端前置校验：只拦明显非法值，语义门禁仍由服务端与计算引擎负责。 */
function validate(form: CommercialInputsForm): string | null {
  const nonNegative: Array<[string, string]> = [
    ["目标销售价格", form.targetSellingPriceValue],
    ["单件采购价", form.purchasePriceValue],
    ["单件头程物流费用", form.logisticsValue],
    ["FBA 配送费用", form.fbaFeeValue],
    ["头程单价（每公斤）", form.shippingRatePerKg],
  ];
  for (const [label, text] of nonNegative) {
    const parsed = optionalNumber(text);
    if (text.trim() !== "" && (parsed === undefined || parsed < 0)) return `${label}必须是不小于 0 的数字。`;
  }
  const moq = optionalNumber(form.moq);
  if (form.moq.trim() !== "" && (moq === undefined || !Number.isInteger(moq) || moq < 1)) {
    return "MOQ 必须是正整数。";
  }
  const weight = optionalNumber(form.packageWeightValue);
  if (form.packageWeightValue.trim() !== "" && (weight === undefined || weight <= 0)) {
    return "包装重量必须是大于 0 的数字。";
  }
  for (const [label, text] of [["包装长度", form.packageLength], ["包装宽度", form.packageWidth], ["包装高度", form.packageHeight]] as const) {
    const parsed = optionalNumber(text);
    if (text.trim() !== "" && (parsed === undefined || parsed <= 0)) return `${label}必须是大于 0 的数字。`;
  }
  for (const [label, text] of [["平台佣金率", form.commissionRatePercent], ["广告费用假设", form.adCostRatePercent]] as const) {
    const parsed = optionalNumber(text);
    if (text.trim() !== "" && (parsed === undefined || parsed < 0 || parsed > 100)) {
      return `${label}请输入 0–100 的百分数。`;
    }
  }
  const exchange = optionalNumber(form.exchangeRate);
  if (form.exchangeRate.trim() !== "" && (exchange === undefined || exchange <= 0)) {
    return "汇率必须是大于 0 的数字。";
  }
  if (form.platformFeeEffectiveDate.trim() !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(form.platformFeeEffectiveDate.trim())) {
    return "平台费率生效日期请使用 YYYY-MM-DD 格式。";
  }
  return null;
}

/**
 * 商业成本与利润测算 · 人工输入表单（分次部分保存）。
 *
 * 纪律：只写入用户明确填写的字段；不自动重跑 AI、不替用户做决定。
 * 用户输入的是**情景假设或实询报价**，不是 Amazon 来源事实。
 */
export function commercialInputsSaveState(
  current: CommercialInputsForm,
  confirmed: CommercialInputsForm,
  state: { loaded: boolean; saving: boolean; error: string },
): { kind: "loading" | "load_error" | "saving" | "error" | "dirty" | "saved" | "empty"; label: string } {
  if (!state.loaded) return state.error
    ? { kind: "load_error", label: "资料读取失败" }
    : { kind: "loading", label: "正在读取已保存资料…" };
  if (state.saving) return { kind: "saving", label: "正在保存…" };
  if (state.error) return { kind: "error", label: "保存未完成 · 当前输入已保留" };
  if (JSON.stringify(current) !== JSON.stringify(confirmed)) return { kind: "dirty", label: "有未保存修改" };
  const hasSaved = Object.keys(savedFields(confirmed)).some((key) => key !== "__invalid");
  return hasSaved ? { kind: "saved", label: "已保存 · 未填写字段仍为待补" } : { kind: "empty", label: "暂无已保存资料" };
}

export function CommercialInputsCard({ taskId, onChanged }: { taskId: string; onChanged?: () => void }) {
  const [form, setForm] = useState<CommercialInputsForm>(EMPTY);
  const [confirmedForm, setConfirmedForm] = useState<CommercialInputsForm>(EMPTY);
  const [storageVersion, setStorageVersion] = useState<unknown>(null);
  const [stale, setStale] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoaded(false);
      setMessage("");
      setError("");
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/commercial-inputs`, {
          headers: { ...buildAccessHeaders() },
          cache: "no-store",
        });
        const json = await response.json().catch(() => null) as Loaded | null;
        if (cancelled) return;
        if (!response.ok || !json?.ok) throw new Error("load_failed");
        const confirmed = toForm(json.inputs ?? {});
        setForm(confirmed);
        setConfirmedForm(confirmed);
        setStorageVersion(json.storageVersion ?? null);
        setStale(json.stale === true);
        setLoaded(true);
      } catch {
        if (!cancelled) setError("资料读取失败，请稍后刷新。");
      }
    })();
    return () => { cancelled = true; };
  }, [taskId]);

  const saveState = useMemo(() => commercialInputsSaveState(form, confirmedForm, { loaded, saving, error }), [form, confirmedForm, loaded, saving, error]);

  function updateForm(update: (current: CommercialInputsForm) => CommercialInputsForm) {
    setForm(update);
    setMessage("");
    setError("");
  }

  async function save() {
    if (saving) return;
    const invalid = validate(form);
    if (invalid) { setError(invalid); return; }
    const newFields = savedFields(form);
    if (newFields.__invalid === "packageDimensions_incomplete") {
      setError("包装尺寸需要同时填写长、宽、高三个数值。");
      return;
    }
    if (Object.keys(newFields).length === 0) {
      setError("请至少填写一项资料后再保存。");
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/commercial-inputs`, {
        method: "PUT",
        headers: { ...buildAccessHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ ...newFields, storageVersion }),
      });
      const json = await response.json().catch(() => null) as Loaded & { error?: { code?: string; message?: string } } | null;
      if (response.status === 409) {
        setError("资料已被其它操作更新，请刷新后重试；不会覆盖他人保存。");
        return;
      }
      if (!response.ok || !json?.ok) {
        setError(json?.error?.message ?? "保存失败，请稍后重试。");
        return;
      }
      const confirmed = toForm(json.inputs ?? newFields);
      setForm(confirmed);
      setConfirmedForm(confirmed);
      setMessage("资料已保存；测算结果以重新读取的数据为准，未填字段仍为待补。");
      onChanged?.();
      // 同步服务端回传的新版本号：不刷新页面的下一次保存必须携带它（D0-003）。
      if (json && typeof json.storageVersion === "object" && json.storageVersion !== null) {
        setStorageVersion(json.storageVersion);
      }
      setStale(json.stale === true);
    } catch {
      setError("保存失败，请检查本地服务后重试。");
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "h-9 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-100 disabled:bg-slate-50 disabled:text-slate-500";
  const labelCls = "text-xs font-semibold text-slate-600";
  const groupCls = "rounded-xl border border-slate-200 bg-slate-50/50 p-3 space-y-3";
  const groupTitleCls = "text-[13px] font-bold uppercase tracking-wider text-slate-500";
  const disabled = !loaded || saving;

  return (
    <section id="formal-v2-cost-risk-evidence" data-testid="commercial-inputs-card" className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-slate-900">商业成本与利润测算（人工输入）</h3>
        <span role="status" aria-live="polite" data-testid="ci-save-state" data-state={saveState.kind} className={`text-sm font-semibold ${saveState.kind === "dirty" || saveState.kind === "error" ? "text-amber-800" : saveState.kind === "saved" ? "text-emerald-800" : "text-slate-600"}`}>{saveState.label}</span>
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-slate-500">
        这里填写的都是<strong className="font-semibold text-slate-700">用户输入的情景假设或实询报价</strong>，不是 Amazon 来源事实；
        系统只做确定性计算，不会替你做商业决定。包装重量与包装尺寸必须填<strong className="font-semibold text-slate-700">包装</strong>参数，
        不能用商品本体净重/净尺寸代替。
      </p>
      {stale ? (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700" data-testid="commercial-inputs-stale">
          该研究已完成：新填资料会按既有机制触发重新确认。
        </p>
      ) : null}

      <div className="mt-3 space-y-3">
        <fieldset className={groupCls} disabled={disabled}>
          <legend className={groupTitleCls}>商品与采购</legend>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="min-w-0">
              <span className={labelCls}>目标销售价格（留空 = 用商品当前售价）</span>
              <div className="mt-1 flex gap-2">
                <input data-testid="ci-target-price" type="number" min="0" step="0.01" value={form.targetSellingPriceValue}
                  onChange={(e) => updateForm((f) => ({ ...f, targetSellingPriceValue: e.target.value }))} placeholder="待补" className={inputCls} />
                <select aria-label="目标售价币种" value={form.targetSellingPriceCurrency}
                  onChange={(e) => updateForm((f) => ({ ...f, targetSellingPriceCurrency: e.target.value as Currency }))} className={inputCls}>
                  <option value="USD">USD</option><option value="CNY">CNY</option>
                </select>
              </div>
            </label>
            <label className="min-w-0">
              <span className={labelCls}>单件采购价</span>
              <div className="mt-1 flex gap-2">
                <input data-testid="ci-purchase-price" type="number" min="0" step="0.01" value={form.purchasePriceValue}
                  onChange={(e) => updateForm((f) => ({ ...f, purchasePriceValue: e.target.value }))} placeholder="待补（0 也是有效值）" className={inputCls} />
                <select aria-label="采购价币种" value={form.purchasePriceCurrency}
                  onChange={(e) => updateForm((f) => ({ ...f, purchasePriceCurrency: e.target.value as Currency }))} className={inputCls}>
                  <option value="CNY">CNY</option><option value="USD">USD</option>
                </select>
              </div>
            </label>
            <label className="min-w-0">
              <span className={labelCls}>MOQ（正整数）</span>
              <input data-testid="ci-moq" type="number" min="1" step="1" value={form.moq}
                onChange={(e) => updateForm((f) => ({ ...f, moq: e.target.value }))} placeholder="待补" className={`mt-1 ${inputCls}`} />
            </label>
          </div>
        </fieldset>

        <fieldset className={groupCls} disabled={disabled}>
          <legend className={groupTitleCls}>物流与包装</legend>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="min-w-0">
              <span className={labelCls}>单件头程物流费用（直接按单件计）</span>
              <div className="mt-1 flex gap-2">
                <input data-testid="ci-logistics" type="number" min="0" step="0.01" value={form.logisticsValue}
                  onChange={(e) => updateForm((f) => ({ ...f, logisticsValue: e.target.value }))} placeholder="待补" className={inputCls} />
                <select aria-label="物流币种" value={form.logisticsCurrency}
                  onChange={(e) => updateForm((f) => ({ ...f, logisticsCurrency: e.target.value as Currency }))} className={inputCls}>
                  <option value="CNY">CNY</option><option value="USD">USD</option>
                </select>
              </div>
              <span className="mt-1 block text-[12px] text-slate-400">填了该项即按单件计，不再用计费重推导。</span>
            </label>
            <label className="min-w-0">
              <span className={labelCls}>单件包装重量</span>
              <div className="mt-1 flex gap-2">
                <input data-testid="ci-package-weight" type="number" min="0" step="0.001" value={form.packageWeightValue}
                  onChange={(e) => updateForm((f) => ({ ...f, packageWeightValue: e.target.value }))} placeholder="待补" className={inputCls} />
                <select aria-label="包装重量单位" value={form.packageWeightUnit}
                  onChange={(e) => updateForm((f) => ({ ...f, packageWeightUnit: e.target.value as WeightUnit }))} className={inputCls}>
                  <option value="kg">kg</option><option value="g">g</option><option value="lb">lb</option><option value="oz">oz</option>
                </select>
              </div>
            </label>
            <div className="min-w-0">
              <span className={labelCls}>单件包装尺寸（长 × 宽 × 高）</span>
              <div className="mt-1 flex gap-1.5">
                <input aria-label="包装长度" data-testid="ci-package-length" type="number" min="0" step="0.01" value={form.packageLength}
                  onChange={(e) => updateForm((f) => ({ ...f, packageLength: e.target.value }))} placeholder="长" className={inputCls} />
                <input aria-label="包装宽度" data-testid="ci-package-width" type="number" min="0" step="0.01" value={form.packageWidth}
                  onChange={(e) => updateForm((f) => ({ ...f, packageWidth: e.target.value }))} placeholder="宽" className={inputCls} />
                <input aria-label="包装高度" data-testid="ci-package-height" type="number" min="0" step="0.01" value={form.packageHeight}
                  onChange={(e) => updateForm((f) => ({ ...f, packageHeight: e.target.value }))} placeholder="高" className={inputCls} />
                <select aria-label="包装尺寸单位" value={form.packageDimensionUnit}
                  onChange={(e) => updateForm((f) => ({ ...f, packageDimensionUnit: e.target.value as DimensionUnit }))} className={inputCls}>
                  <option value="cm">cm</option><option value="in">in</option>
                </select>
              </div>
            </div>
            <label className="min-w-0">
              <span className={labelCls}>头程单价（每公斤，按计费重口径）</span>
              <input data-testid="ci-shipping-rate" type="number" min="0" step="0.01" value={form.shippingRatePerKg}
                onChange={(e) => updateForm((f) => ({ ...f, shippingRatePerKg: e.target.value }))} placeholder="待补（留空则不用计费重口径）" className={`mt-1 ${inputCls}`} />
            </label>
            <label className="min-w-0">
              <span className={labelCls}>头程计费模式</span>
              <select data-testid="ci-shipping-mode" value={form.shippingMode}
                onChange={(e) => updateForm((f) => ({ ...f, shippingMode: e.target.value as ShippingMode }))} className={`mt-1 ${inputCls}`}>
                <option value="custom_rate">自定义单价（推荐）</option>
                <option value="sea_fast">海运快船（内置参考费率）</option>
                <option value="sea_economy">海运经济（内置参考费率）</option>
                <option value="air_express">空运快递（内置参考费率）</option>
              </select>
            </label>
          </div>
        </fieldset>

        <fieldset className={groupCls} disabled={disabled}>
          <legend className={groupTitleCls}>平台费用与经营假设</legend>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="min-w-0">
              <span className={labelCls}>FBA 配送费用</span>
              <div className="mt-1 flex gap-2">
                <input data-testid="ci-fba-fee" type="number" min="0" step="0.01" value={form.fbaFeeValue}
                  onChange={(e) => updateForm((f) => ({ ...f, fbaFeeValue: e.target.value }))} placeholder="待补" className={inputCls} />
                <select aria-label="FBA 费用币种" value={form.fbaFeeCurrency}
                  onChange={(e) => updateForm((f) => ({ ...f, fbaFeeCurrency: e.target.value as Currency }))} className={inputCls}>
                  <option value="USD">USD</option><option value="CNY">CNY</option>
                </select>
              </div>
            </label>
            <label className="min-w-0">
              <span className={labelCls}>Amazon 平台佣金率（%）</span>
              <input data-testid="ci-commission-rate" type="number" min="0" max="100" step="0.01" value={form.commissionRatePercent}
                onChange={(e) => updateForm((f) => ({ ...f, commissionRatePercent: e.target.value }))} placeholder="例如 15" className={`mt-1 ${inputCls}`} />
            </label>
            <label className="min-w-0">
              <span className={labelCls}>广告费用假设（目标 TACoS，%）</span>
              <input data-testid="ci-ad-cost-rate" type="number" min="0" max="100" step="0.01" value={form.adCostRatePercent}
                onChange={(e) => updateForm((f) => ({ ...f, adCostRatePercent: e.target.value }))} placeholder="例如 10" className={`mt-1 ${inputCls}`} />
              <span className="mt-1 block text-[12px] text-slate-400">系统不会默认按 0 计广告成本；留空则不出结果。</span>
            </label>
            <label className="min-w-0">
              <span className={labelCls}>汇率（CNY → USD）</span>
              <input data-testid="ci-exchange-rate" type="number" min="0" step="0.0001" value={form.exchangeRate}
                onChange={(e) => updateForm((f) => ({ ...f, exchangeRate: e.target.value }))} placeholder="例如 7.2" className={`mt-1 ${inputCls}`} />
            </label>
            <label className="min-w-0">
              <span className={labelCls}>平台费率性质</span>
              <select data-testid="ci-platform-fee-nature" value={form.platformFeeNature}
                onChange={(e) => updateForm((f) => ({ ...f, platformFeeNature: e.target.value as PlatformFeeNature }))} className={`mt-1 ${inputCls}`}>
                <option value="user_scenario">情景假设（我填的是估计值）</option>
                <option value="official_reference">官方来源引用（我已核对费率表）</option>
              </select>
            </label>
            <label className="min-w-0">
              <span className={labelCls}>平台费率来源说明</span>
              <input data-testid="ci-platform-fee-source" type="text" maxLength={200} value={form.platformFeeSourceNote}
                onChange={(e) => updateForm((f) => ({ ...f, platformFeeSourceNote: e.target.value }))} placeholder="例如 Amazon FBA 费率页 / 服务商报价单" className={`mt-1 ${inputCls}`} />
            </label>
            <label className="min-w-0">
              <span className={labelCls}>平台费率生效日期</span>
              <input data-testid="ci-platform-fee-date" type="date" value={form.platformFeeEffectiveDate}
                onChange={(e) => updateForm((f) => ({ ...f, platformFeeEffectiveDate: e.target.value }))} className={`mt-1 ${inputCls}`} />
            </label>
          </div>
        </fieldset>

        <fieldset className={groupCls} disabled={disabled}>
          <legend className={groupTitleCls}>合规</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="min-w-0">
              <span className={labelCls}>合规核对状态</span>
              <select data-testid="ci-compliance-status" value={form.complianceStatus}
                onChange={(e) => updateForm((f) => ({ ...f, complianceStatus: e.target.value as ComplianceStatus }))} className={`mt-1 ${inputCls}`}>
                <option value="not_reviewed">未核对</option>
                <option value="reviewed_ok">已核对，无问题</option>
                <option value="issues_found">有问题待处理</option>
              </select>
            </label>
            <label className="min-w-0">
              <span className={labelCls}>依据备注（≤500 字）</span>
              <textarea data-testid="ci-compliance-note" value={form.complianceNote} maxLength={500} rows={2}
                onChange={(e) => updateForm((f) => ({ ...f, complianceNote: e.target.value }))} placeholder="待补：说明依据来源"
                className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-100 disabled:bg-slate-50 disabled:text-slate-500" />
            </label>
          </div>
        </fieldset>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={saving || !loaded}
          className="linear-button-primary inline-flex h-9 items-center px-4 text-sm font-semibold disabled:opacity-50" data-testid="ci-save">
          {saving ? "保存中…" : "保存资料"}
        </button>
        {message ? <span role="status" className="text-sm font-semibold text-emerald-700" data-testid="ci-message">{message}</span> : null}
        {error ? <span role="alert" className="text-sm font-semibold text-rose-700" data-testid="ci-error">{error}</span> : null}
      </div>
    </section>
  );
}
