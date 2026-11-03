import {
  type ProductBrief,
  type ProductBriefComparisonRow,
  type ProductBriefConfirmationItem,
  type ProductBriefSpecRow,
  type ProductBriefStatus,
  type ProductBriefVerificationItem,
} from "./contract";

/**
 * 04 需求单编辑模型（纯函数，无 I/O）。
 *
 * 只处理「人工可编辑」的字段；来源事实（成本上限、FBA、基准商品、研报结论）
 * 永远从 ProductBrief 读取，不进入草稿，避免编辑态把来源事实写成人工输入。
 */

export type BriefSectionId = "definition" | "product" | "economics" | "confirmation" | "validation";

export const BRIEF_SECTIONS: readonly { id: BriefSectionId; label: string }[] = [
  { id: "definition", label: "项目定义" },
  { id: "product", label: "产品方案" },
  { id: "economics", label: "成本与可行性" },
  { id: "confirmation", label: "待确认事项" },
  { id: "validation", label: "验证计划" },
] as const;

export type BriefDraft = {
  targetUser: string;
  positioning: string;
  targetPrice: string;
  targetMarginPct: string;
  referralFee: string;
  logistics: string;
  estimatedTax: string;
  otherKnownCosts: string;
  specifications: ProductBriefSpecRow[];
  confirmationItems: ProductBriefConfirmationItem[];
  benchmarkComparison: ProductBriefComparisonRow[];
  verificationPlan: ProductBriefVerificationItem[];
};

export const DRAFT_FIELDS: Record<keyof BriefDraft, { label: string; section: BriefSectionId }> = {
  targetUser: { label: "目标用户", section: "definition" },
  positioning: { label: "产品定位", section: "definition" },
  targetPrice: { label: "目标售价", section: "economics" },
  targetMarginPct: { label: "目标毛利率", section: "economics" },
  referralFee: { label: "平台佣金", section: "economics" },
  logistics: { label: "物流", section: "economics" },
  estimatedTax: { label: "估算税费", section: "economics" },
  otherKnownCosts: { label: "其他已知成本", section: "economics" },
  specifications: { label: "规格方向（整组）", section: "product" },
  confirmationItems: { label: "待确认事项（整组）", section: "confirmation" },
  benchmarkComparison: { label: "竞品对照（整组）", section: "product" },
  verificationPlan: { label: "验证计划（整组）", section: "validation" },
};

export const DRAFT_FIELD_KEYS = Object.keys(DRAFT_FIELDS) as (keyof BriefDraft)[];

function numberInputValue(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * 旧版需求单没有对照表 / 验证计划时，用与页面一致的空行兜底。
 * 必须是确定性的：草稿基线、脏检查与保存都走同一份兜底，避免“刚打开就显示未保存”。
 */
export function defaultComparisonRows(brief: ProductBrief): ProductBriefComparisonRow[] {
  if (brief.benchmarkComparison?.rows) return [...brief.benchmarkComparison.rows];
  const firstBenchmark = brief.benchmarks[0];
  const note = firstBenchmark && firstBenchmark.role !== "fast_track" ? `对照基准：${firstBenchmark.asin}` : null;
  return ([["cmp_price", "价格"], ["cmp_rating", "评分"], ["cmp_reviews", "评论数"], ["cmp_selling_point", "核心卖点差异"]] as const).map(
    ([id, label]) => ({ id, label, ours: null, theirs: null, nature: "ASSUMPTION" as const, note }),
  );
}

export function defaultVerificationPlan(brief: ProductBrief): ProductBriefVerificationItem[] {
  if (brief.verificationPlan) return [...brief.verificationPlan];
  return brief.missingValidation.map((item, index) => ({ id: `v_${index + 1}`, item, method: "", timing: "", status: "pending" as const }));
}

export function draftFromBrief(brief: ProductBrief): BriefDraft {
  return {
    targetUser: brief.targetUser?.text ?? "",
    positioning: brief.positioning?.text ?? "",
    targetPrice: numberInputValue(brief.economics.targetPrice),
    targetMarginPct: numberInputValue(brief.economics.targetMarginPct),
    referralFee: numberInputValue(brief.economics.referralFee),
    logistics: numberInputValue(brief.economics.logistics),
    estimatedTax: numberInputValue(brief.economics.estimatedTax),
    otherKnownCosts: numberInputValue(brief.economics.otherKnownCosts),
    specifications: [...(brief.specifications ?? [])],
    confirmationItems: [...(brief.confirmationItems ?? [])],
    benchmarkComparison: defaultComparisonRows(brief),
    verificationPlan: defaultVerificationPlan(brief),
  };
}

/** 保存补丁：字段白名单与服务端 route 接受的键完全一致。 */
export function draftToPatch(draft: BriefDraft, baseline?: ProductBrief) {
  const numberOrNull = (value: string) => (value.trim() ? Number(value) : null);
  const assumption = (text: string) => (text.trim() ? { text: text.trim(), nature: "ASSUMPTION" as const, evidenceRefs: [] as string[] } : null);
  type EconomicKey = "targetPrice" | "targetMarginPct" | "referralFee" | "logistics" | "estimatedTax" | "otherKnownCosts";
  const economic = (key: EconomicKey): Partial<Pick<ProductBrief["economics"], EconomicKey>> => {
    const value = numberOrNull(draft[key]);
    return !baseline || value !== baseline.economics[key] ? { [key]: value } : {};
  };
  return {
    ...economic("targetPrice"),
    ...economic("targetMarginPct"),
    ...economic("referralFee"),
    ...economic("logistics"),
    ...economic("estimatedTax"),
    ...economic("otherKnownCosts"),
    targetUser: assumption(draft.targetUser),
    specifications: draft.specifications.filter((row) => row.label.trim() && row.value.trim()),
    confirmationItems: draft.confirmationItems.filter((row) => row.item.trim()),
    benchmarkComparison: { rows: draft.benchmarkComparison.filter((row) => row.label.trim()) },
    verificationPlan: draft.verificationPlan.filter((row) => row.item.trim()),
    positioning: assumption(draft.positioning),
  };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function draftIsDirtyAgainst(draft: BriefDraft, base: BriefDraft): boolean {
  return DRAFT_FIELD_KEYS.some((key) => !same(draft[key], base[key]));
}

export function draftIsDirty(draft: BriefDraft, brief: ProductBrief): boolean {
  return draftIsDirtyAgainst(draft, draftFromBrief(brief));
}

/** 哪些章节还有未保存输入（用于章节标记与保存按钮）。 */
export function dirtySections(draft: BriefDraft, brief: ProductBrief): Set<BriefSectionId> {
  return dirtySectionsAgainst(draft, draftFromBrief(brief));
}

export function dirtySectionsAgainst(draft: BriefDraft, base: BriefDraft): Set<BriefSectionId> {
  const sections = new Set<BriefSectionId>();
  for (const key of DRAFT_FIELD_KEYS) {
    if (!same(draft[key], base[key])) sections.add(DRAFT_FIELDS[key].section);
  }
  return sections;
}

export type DraftChange = {
  key: keyof BriefDraft;
  label: string;
  section: BriefSectionId;
  local: BriefDraft[keyof BriefDraft];
  remote: BriefDraft[keyof BriefDraft];
  localChanged: boolean;
  remoteChanged: boolean;
  conflict: boolean;
};

/**
 * 相对「编辑起点草稿 base」比对本地草稿与服务器最新草稿 latest。
 * 只列出真正发生变化的字段；两边都改且值不同 => 冲突，必须由人工选择。
 */
export function draftChanges(base: BriefDraft, draft: BriefDraft, latest: BriefDraft = base): DraftChange[] {
  return DRAFT_FIELD_KEYS.map((key) => {
    const localChanged = !same(draft[key], base[key]);
    const remoteChanged = !same(latest[key], base[key]);
    return {
      key,
      ...DRAFT_FIELDS[key],
      local: draft[key],
      remote: latest[key],
      localChanged,
      remoteChanged,
      conflict: localChanged && remoteChanged && !same(draft[key], latest[key]),
    };
  }).filter((row) => row.localChanged || row.remoteChanged);
}

export type ConflictChoices = Partial<Record<keyof BriefDraft, "local" | "remote">>;

/**
 * 生成以 latest 为基础的新草稿：冲突字段按人工选择保留本地或远端，
 * 只有本地修改的字段保留本地输入，只有远端修改的字段采用远端。
 * 任一冲突字段未选择时返回 null —— 不做静默覆盖，也不做按行合并。
 */
export function resolveDraft(base: BriefDraft, draft: BriefDraft, latest: BriefDraft, choices: ConflictChoices): BriefDraft | null {
  const result = { ...latest };
  for (const row of draftChanges(base, draft, latest)) {
    if (row.conflict && !choices[row.key]) return null;
    if (row.localChanged && (!row.conflict || choices[row.key] === "local")) {
      Object.assign(result, { [row.key]: row.local });
    }
  }
  return result;
}

/** 人工可读的差异摘要（整组字段只显示条数，不逐行 diff）。 */
export function describeDraftValue(key: keyof BriefDraft, value: BriefDraft[keyof BriefDraft]): string {
  if (typeof value === "string") return value.trim() ? value : "（空）";
  const list = value as readonly unknown[];
  return `${list.length} 条`;
}

/**
 * 判断「提交结果未确认」是否其实已经成功：服务器版本前进、状态一致，
 * 且按提交快照重放后与服务器内容一致。用于超时/断网后的回读确认。
 */
export function saveLikelyApplied(base: ProductBrief, submitted: BriefDraft, status: ProductBriefStatus, latest: ProductBrief): boolean {
  if (latest.revision <= base.revision) return false;
  if (latest.status !== status) return false;
  const numberOrNull = (value: string) => value.trim() ? Number(value) : null;
  const autoFeeInvalidated = base.economics.provenance?.referralFee?.source === "candidateAnalysisContext.commercialInputs.commissionRate"
    && numberOrNull(submitted.targetPrice) !== base.economics.targetPrice
    && numberOrNull(submitted.referralFee) === base.economics.referralFee;
  const expected = autoFeeInvalidated ? { ...submitted, referralFee: "" } : submitted;
  return !draftIsDirty(expected, latest);
}
