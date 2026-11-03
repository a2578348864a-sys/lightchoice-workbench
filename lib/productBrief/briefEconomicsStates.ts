import type { ProductBrief, ProductBriefEconomicOrigin, ProductBriefEconomicsProvenance } from "./contract";

/**
 * 04 经济性字段的**状态口径**（唯一来源，页面与 Markdown 共用）。
 *
 * 真实缺陷（P5-v4 发现）：决策摘要写「目标毛利率尚未填写 / referral fee 尚未提供 / 物流成本尚未提供」，
 * 而经济性章节却显示「毛利率 35% / referral fee 2.38 / 物流 1.2」。
 * 根因不是读取错误，而是摘要当时读的是 `brief.missingValidation`——那是**生成时的缺失快照**，
 * 用户后来填了值，快照不会自动更新。于是同一份文档里出现两种互相矛盾的说法。
 *
 * 本模块只做既有事实的分状态呈现，不新建经济性模型、不重算、不填数：
 *   EFFECTIVE        当前有效值（值存在且来源绑定未失效）
 *   SAVED_UNVERIFIED 历史保存值（值存在，但来源/有效性尚不能确认——如估算来源、或绑定已失效）
 *   MISSING          当前缺失（没有值，且当前规则需要它）
 *   NOT_COMPUTABLE   派生结果不可计算（采购成本上限）
 */

export type EconomicsFieldState = "EFFECTIVE" | "SAVED_UNVERIFIED" | "MISSING" | "NOT_COMPUTABLE";

export type EconomicsFieldView = {
  readonly key: "targetPrice" | "targetMarginPct" | "referralFee" | "fbaFee" | "logistics" | "estimatedTax" | "otherKnownCosts" | "purchaseCostCeiling";
  readonly label: string;
  /** 面向用户的展示值：有值就显示数值，没有就写「未提供」。 */
  readonly display: string;
  readonly state: EconomicsFieldState;
  readonly stateLabel: string;
  /** 来源性质（人工输入 / 商品事实 / 研究估算 / 未提供）。 */
  readonly source: string;
  readonly note: string;
};

/** 采购成本上限的**粗略上界**：只用已保存值算，缺失项按 0 计（会高估），不是正式上限。 */
export type CostCeilingUpperBound = {
  readonly value: number;
  readonly currency: string;
  readonly missingInputs: readonly string[];
  readonly note: string;
};

export type EconomicsStateView = {
  /** 当前可用于判断的字段（EFFECTIVE）。 */
  readonly effective: readonly EconomicsFieldView[];
  /** 当前缺口 / 不可直接沿用（MISSING、SAVED_UNVERIFIED、NOT_COMPUTABLE）。 */
  readonly gaps: readonly EconomicsFieldView[];
  readonly fields: readonly EconomicsFieldView[];
  readonly ceiling: EconomicsFieldView;
  /** 缺项时的粗略上界（帮助判断"还能不能做"，不是正式结论）。 */
  readonly upperBound: CostCeilingUpperBound | null;
  /** 一句话口径，放在摘要里，避免用户以为「缺失」等于「从来没填」。 */
  readonly summaryLine: string;
};

const ORIGIN_LABELS: Readonly<Record<ProductBriefEconomicOrigin, string>> = {
  USER_INPUT: "人工输入",
  PRODUCT_FACT: "商品事实（已持久化）",
  RESEARCH_ESTIMATE: "研究估算",
  MISSING: "未提供",
};

type FieldSpec = {
  readonly key: Exclude<EconomicsFieldView["key"], "purchaseCostCeiling">;
  readonly label: string;
  readonly unit: "money" | "percent";
};

const FIELD_SPECS: readonly FieldSpec[] = [
  { key: "targetPrice", label: "目标售价", unit: "money" },
  { key: "targetMarginPct", label: "目标毛利率", unit: "percent" },
  { key: "referralFee", label: "平台佣金", unit: "money" },
  { key: "fbaFee", label: "FBA 费用", unit: "money" },
  { key: "logistics", label: "物流成本", unit: "money" },
  { key: "estimatedTax", label: "估算税费", unit: "money" },
  { key: "otherKnownCosts", label: "其他已知成本", unit: "money" },
];

function formatValue(value: number | null, unit: FieldSpec["unit"], currency: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "未提供";
  return unit === "percent" ? `${value}%` : `${value} ${currency}`;
}

function sourceOf(provenance: ProductBriefEconomicsProvenance | undefined, key: FieldSpec["key"]): { label: string; origin: ProductBriefEconomicOrigin } {
  const entry = provenance?.[key];
  const origin: ProductBriefEconomicOrigin = entry?.origin ?? "MISSING";
  return { label: ORIGIN_LABELS[origin], origin };
}

export function buildEconomicsStateView(
  brief: ProductBrief | null,
  options: { readonly stale?: boolean; readonly approvalBlockedReason?: string | null } = {},
): EconomicsStateView {
  const stale = options.stale === true;
  const currency = brief?.economics.currency ?? "USD";

  const fields: EconomicsFieldView[] = FIELD_SPECS.map((spec) => {
    const raw = brief ? brief.economics[spec.key] : null;
    const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    const { label: sourceLabel, origin } = sourceOf(brief?.economics.provenance, spec.key);
    const display = formatValue(value, spec.unit, currency);
    if (value === null) {
      return {
        key: spec.key,
        label: spec.label,
        display,
        state: "MISSING",
        stateLabel: "当前缺失",
        source: sourceLabel,
        note: "当前没有该输入，相关测算不能据此得出结果。",
      };
    }
    if (stale) {
      return {
        key: spec.key,
        label: spec.label,
        display,
        state: "SAVED_UNVERIFIED",
        stateLabel: "历史保存值（当前有效性待确认）",
        source: sourceLabel,
        note: `需求单保存过 ${spec.label} ${display}，但研究/证据来源已变化，不能直接沿用，需先回 03 更新研究再确认。`,
      };
    }
    if (origin === "MISSING") {
      // 旧需求单没有记录 provenance：值存在，但「谁填的、是否仍然有效」无法确认。
      return {
        key: spec.key,
        label: spec.label,
        display,
        state: "SAVED_UNVERIFIED",
        stateLabel: "历史保存值（来源未记录）",
        source: "来源未记录",
        note: `需求单保存过 ${spec.label} ${display}，但旧版本未记录来源，需人工确认后再用于立项判断（不能当作「当前缺失」，也不能当作已确认）。`,
      };
    }
    if (origin === "RESEARCH_ESTIMATE" || origin === "PRODUCT_FACT") {
      return {
        key: spec.key,
        label: spec.label,
        display,
        state: "SAVED_UNVERIFIED",
        stateLabel: "已有来源值（非人工确认）",
        source: sourceLabel,
        note: `该值来自${sourceLabel}，不是人工确认的开发目标；用于立项判断前需人工确认。`,
      };
    }
    return {
      key: spec.key,
      label: spec.label,
      display,
      state: "EFFECTIVE",
      stateLabel: "已有有效值",
      source: sourceLabel,
      note: `${sourceLabel}，当前可用于测算。`,
    };
  });

  const ceilingRaw = brief?.economics.purchaseCostCeiling ?? null;
  const ceiling: EconomicsFieldView = ceilingRaw && ceilingRaw.status === "COMPUTED" && typeof ceilingRaw.value === "number"
    ? {
        key: "purchaseCostCeiling",
        label: "采购成本上限",
        display: `${ceilingRaw.value} ${ceilingRaw.currency ?? currency}`,
        state: stale ? "SAVED_UNVERIFIED" : "EFFECTIVE",
        stateLabel: stale ? "历史保存值（当前有效性待确认）" : "已有有效值",
        source: "按已保存参数计算",
        note: stale ? "计算基于已保存参数，但来源绑定已失效，需重新确认后再使用。" : ceilingRaw.formula,
      }
    : {
        key: "purchaseCostCeiling",
        label: "采购成本上限",
        display: "不可计算",
        state: "NOT_COMPUTABLE",
        stateLabel: "当前不可计算",
        source: "测算",
        note: ceilingRaw?.reason ?? options.approvalBlockedReason ?? "缺少必要测算输入。",
      };

  // 粗略上界：售价 − 已知费用 − 目标利润；缺失项按 0 计入（因此是**上界**，会高估）。
  const priceValue = brief?.economics.targetPrice ?? null;
  const marginValue = brief?.economics.targetMarginPct ?? null;
  const known = ["referralFee", "fbaFee", "logistics", "estimatedTax", "otherKnownCosts"] as const;
  const missingInputs = known.filter((key) => (brief?.economics[key] ?? null) === null).map((key) => FIELD_SPECS.find((spec) => spec.key === key)?.label ?? key);
  const knownCostSum = known.reduce((sum, key) => sum + (brief?.economics[key] ?? 0), 0);
  const upperBound: CostCeilingUpperBound | null = priceValue !== null && marginValue !== null && priceValue > 0
    ? {
        value: Math.round((priceValue - knownCostSum - (priceValue * marginValue) / 100) * 100) / 100,
        currency,
        missingInputs,
        note: `粗略上界：仅用已保存值计算，${missingInputs.length ? `缺失项（${missingInputs.join("、")}）按 0 计因此会高估` : "费用项已齐"}；这不是采购成本上限，也不能据此定价或立项。`,
      }
    : null;

  const allFields = [...fields, ceiling];
  const gaps = allFields.filter((field) => field.state !== "EFFECTIVE");
  const effective = allFields.filter((field) => field.state === "EFFECTIVE");

  const summaryLine = gaps.length === 0
    ? "商业条件：全部测算输入已有有效值。"
    : stale
      ? `商业条件：${gaps.filter((field) => field.state === "SAVED_UNVERIFIED").length} 项存在历史保存值但来源已失效，${gaps.filter((field) => field.state === "MISSING").length} 项当前缺失；不能据此判断可立项。`
      : `商业条件：${effective.length} 项已有值，${gaps.length} 项仍需补齐或确认（${gaps.map((field) => field.label).slice(0, 4).join("、")}）。`;

  return { effective, gaps, fields: allFields, ceiling, upperBound, summaryLine };
}

/**
 * 生成时快照 → 当前状态的对照标注。
 *
 * 真实问题（P5-v5）：`missingValidation` / `verificationPlan` 里的
 * 「目标毛利率尚未由人工填写」是**生成时**的缺失记录；用户后来填了 35%，
 * 这句话仍然留在正文与导出里，于是和「② 商业可行性确认：35%｜历史保存值」互相打脸。
 * 这里只做标注，不删历史记录、也不把历史值升级成有效值。
 */
const SNAPSHOT_FIELD_PATTERNS: readonly { readonly pattern: RegExp; readonly key: EconomicsFieldView["key"] }[] = [
  { pattern: /目标售价|售价.*(未|确认)/u, key: "targetPrice" },
  { pattern: /毛利率/u, key: "targetMarginPct" },
  { pattern: /referral\s*fee|平台佣金|平台费|佣金/u, key: "referralFee" },
  { pattern: /FBA/u, key: "fbaFee" },
  { pattern: /物流|头程/u, key: "logistics" },
  { pattern: /税费/u, key: "estimatedTax" },
  { pattern: /其他已知成本/u, key: "otherKnownCosts" },
];

export type SnapshotAnnotation = {
  /** 原文（历史记录，不改写）。 */
  readonly text: string;
  /** 命中的经济性字段；null 表示未命中（与当前数值无关的待验证项）。 */
  readonly fieldKey: EconomicsFieldView["key"] | null;
  /** 该字段当前状态的可读描述；null 表示未命中。 */
  readonly current: string | null;
  /** true 表示「生成时列为缺失，但现在已有值」——必须在界面上显式说明，避免被当成当前缺失。 */
  readonly superseded: boolean;
};

export function annotateSnapshotItem(text: string, view: EconomicsStateView): SnapshotAnnotation {
  const hit = SNAPSHOT_FIELD_PATTERNS.find((entry) => entry.pattern.test(text));
  if (!hit) return { text, fieldKey: null, current: null, superseded: false };
  const field = view.fields.find((entry) => entry.key === hit.key) ?? null;
  if (!field) return { text, fieldKey: hit.key, current: null, superseded: false };
  const superseded = field.state === "EFFECTIVE" || field.state === "SAVED_UNVERIFIED";
  return {
    text,
    fieldKey: hit.key,
    current: `${field.label}：${field.display}｜${field.stateLabel}`,
    superseded,
  };
}

/** 给历史快照条目生成一行可读说明（未命中或仍然缺失时不写「已保存」）。 */
export function snapshotAnnotationNote(annotation: SnapshotAnnotation): string | null {
  if (!annotation.current) return null;
  return annotation.superseded
    ? `生成时快照（当时列为缺失）；当前：${annotation.current}`
    : `生成时快照；当前：${annotation.current}`;
}
