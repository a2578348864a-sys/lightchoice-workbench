/**
 * Validation Brief 只读 ViewModel（页面渲染与 Markdown 导出的唯一数据源）
 *
 * 架构红线：
 * 1. 纯函数、纯只读投影：只消费已有研报 / 正式 VOC 快照 / 商业可行性视图，不新增事实层、零写操作。
 * 2. 页面与 Markdown 必须消费同一份 ViewModel —— 禁止两套业务判断规则。
 * 3. 证据强度只能来自 @/lib/research/vocThresholds 的权威阈值，禁止「高频」「普遍」「多数用户」等无据强度词。
 * 4. 缺失即缺失：无 BSR 就显示缺失，不得声称已采集；ESTIMATED 不得混入「已确认事实」。
 * 5. 失效人工决策必须阻断：不得用旧决策冒充当前已批准状态。
 */

import {
  buildCommercialFeasibility,
  type BuildCommercialFeasibilityInput,
  type CommercialFactItem,
  type CommercialFeasibilityView,
  type FieldSourceState,
  type HumanDecisionGate,
  type VocSignalItem,
} from "./commercialFeasibility";
import { describeVocThemeStrength, type VocThemeStrength } from "./vocThresholds";

export const DECISION_STALE_MESSAGE = "研究或证据已更新，原人工决策需要重新确认。";

/** 未取得商品专项证据时的最小通用核实建议（明确标注为模板参考，不代表本商品专项任务） */
export const TEMPLATE_VERIFICATION_TASKS: readonly { title: string; detail: string }[] = [
  {
    title: "确认实际采购报价与阶梯价格",
    detail: "向供应商索取出厂含税阶梯报价（模板参考；本商品尚无正式 VOC 专项任务）。取得真实凭证前不得预估成本。",
  },
  {
    title: "确认起订量与交期",
    detail: "确认最小起订量（MOQ）与交货周期，用于评估首批试错资金占用（模板参考）。",
  },
  {
    title: "确认出厂包装规格与装箱数",
    detail: "索取单件包装长宽高重与外箱装箱数，用于测算尾程与头程费用（模板参考）。",
  },
];

export type ValidationBriefTaskSource =
  | "voc_improvement"
  | "research_next_step"
  | "supplier_checkpoint"
  | "sample_unknown"
  | "commercial_gap"
  | "template";

export const TASK_SOURCE_LABELS: Record<ValidationBriefTaskSource, string> = {
  voc_improvement: "正式 VOC 改进需求",
  research_next_step: "正式 VOC 下一步研究建议",
  supplier_checkpoint: "供应商/验货核实项",
  sample_unknown: "样本局限（待补充证据）",
  commercial_gap: "商业数据缺口",
  template: "模板参考（无商品专项数据）",
};

export type ValidationBriefTask = {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly source: ValidationBriefTaskSource;
  readonly sourceLabel: string;
  /** 来源主题的提及次数（null = 无主题级计数） */
  readonly mentionCount: number | null;
  readonly evidenceRefs: readonly string[];
};

export type ValidationBriefDirection = {
  readonly direction: string;
  readonly premise: string;
  readonly state: "待验证";
  readonly basisStrength: VocThemeStrength | null;
  readonly basisMentionCount: number | null;
  readonly caveat: string | null;
};

export type ValidationBriefFactGroup = {
  readonly available: readonly CommercialFactItem[];
  readonly estimated: readonly CommercialFactItem[];
  readonly missing: readonly CommercialFactItem[];
};

export type ValidationBriefVoc = {
  readonly state: FieldSourceState;
  readonly independentReviewCount: number | null;
  readonly themeMentionCount: number;
  readonly themeCount: number;
  readonly summary: string;
  readonly positive: readonly VocSignalItem[];
  readonly negative: readonly VocSignalItem[];
};

export type ValidationBriefViewModel = {
  readonly asin: string;
  readonly title: string;
  readonly roleLabel: string;
  readonly decision: {
    readonly gate: HumanDecisionGate;
    readonly gateLabel: string;
    readonly staleBlocked: boolean;
    readonly staleReason: string | null;
    readonly staleMessage: string | null;
  };
  readonly direction: ValidationBriefDirection;
  readonly facts: ValidationBriefFactGroup;
  /** 研报摘要：AI 解释层（非事实证据），单独呈现，不得混入已确认事实 */
  readonly researchInterpretation: string | null;
  readonly voc: ValidationBriefVoc;
  readonly dataGaps: readonly { field: string; category: string; impact: string }[];
  readonly tasks: readonly ValidationBriefTask[];
  /** 商品专项任务数（VOC 派生）。为 0 表示本商品无专项证据，已回退模板参考 */
  readonly productSpecificTaskCount: number;
  readonly taskFallbackUsed: boolean;
  readonly markdown: string;
};

export const ROLE_DISPLAY_MAP: Record<string, string> = {
  benchmark: "基准品 (Benchmark)",
  newcomer: "新晋品 (Newcomer)",
  pain_point: "痛点品 (Pain Point)",
};

export function roleLabelOf(role: string | null | undefined): string {
  if (!role) return "未指定角色";
  return ROLE_DISPLAY_MAP[role.toLowerCase()] ?? role;
}

export const HUMAN_DECISION_GATE_LABELS: Record<HumanDecisionGate, string> = {
  PENDING: "待审核 (PENDING)",
  PROCEED: "已继续推进 (PROCEED)",
  VALIDATE_MORE: "需补充验证 (VALIDATE_MORE)",
  PAUSE: "暂缓观察 (PAUSE)",
  DROP: "已放弃 (DROP)",
  WATCH: "待明确语义 (WATCH)",
};

function normalizeForDedupe(text: string): string {
  return text.replace(/[\s，。；、：:,.（）()【】\[\]「」"'"'\-—_/]/g, "").toLowerCase();
}

function themeLabelOf(signal: VocSignalItem): string {
  return signal.text.split("：")[0] || signal.text;
}

/** 取提及次数最高的信号（同次数按文本升序，保证确定性） */
function pickTopSignal(signals: readonly VocSignalItem[]): VocSignalItem | null {
  if (signals.length === 0) return null;
  return [...signals].sort((a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0) || a.text.localeCompare(b.text))[0];
}

/**
 * 验证方向派生：措辞严格绑定证据强度，禁止无据强度词。
 */
function buildDirection(view: CommercialFeasibilityView): ValidationBriefDirection {
  const { buyerVoc, aiInferences } = view;
  const hasFormalVoc = buyerVoc.state === "AVAILABLE";
  const topNegative = pickTopSignal(buyerVoc.negativeSignals);
  const topPositive = pickTopSignal(buyerVoc.positiveSignals);

  if (!hasFormalVoc && aiInferences.length === 0) {
    return {
      direction: "暂无明确产品机会验证方向（等待正式买家反馈或研报数据补齐）",
      premise: "尚无充分的正式 VOC 分析或研报机会点支持",
      state: "待验证",
      basisStrength: null,
      basisMentionCount: null,
      caveat: null,
    };
  }

  if (topNegative) {
    const strength = describeVocThemeStrength(topNegative.reviewCount ?? 0);
    return {
      direction: `针对「${themeLabelOf(topNegative)}」——${strength.evidencePhrase}；存在体验与稳定性优化验证方向`,
      premise: `正式 VOC 分析：独立评论 ${buyerVoc.independentReviewCount ?? "未记录"} 条、主题提及 ${buyerVoc.themeMentionCount} 次；该主题提及 ${topNegative.reviewCount ?? 0} 次（strength=${strength.strength}）。`,
      state: "待验证",
      basisStrength: strength.strength,
      basisMentionCount: topNegative.reviewCount ?? 0,
      caveat: strength.caveat,
    };
  }

  if (topPositive) {
    const strength = describeVocThemeStrength(topPositive.reviewCount ?? 0);
    return {
      direction: `在保持「${themeLabelOf(topPositive)}」正向认可的前提下，探索成本与包装效率优化方向`,
      premise: `正式 VOC 分析：独立评论 ${buyerVoc.independentReviewCount ?? "未记录"} 条、主题提及 ${buyerVoc.themeMentionCount} 次；正向主题「${themeLabelOf(topPositive)}」提及 ${topPositive.reviewCount ?? 0} 次（strength=${strength.strength}）。`,
      state: "待验证",
      basisStrength: strength.strength,
      basisMentionCount: topPositive.reviewCount ?? 0,
      caveat: strength.caveat,
    };
  }

  return {
    direction: "存在基础品类体验优化与性能对标验证方向",
    premise: "来自市场基础属性与定位推断，缺乏深度原声验证",
    state: "待验证",
    basisStrength: null,
    basisMentionCount: null,
    caveat: "本方向无正式 VOC 主题支撑，属定位推断，须补充原声证据。",
  };
}

function groupFacts(facts: readonly CommercialFactItem[]): ValidationBriefFactGroup {
  return {
    available: facts.filter((f) => f.state === "AVAILABLE"),
    estimated: facts.filter((f) => f.state === "ESTIMATED"),
    missing: facts.filter((f) => f.state === "DATA_MISSING"),
  };
}

/**
 * 商品级验证任务派生（优先级：VOC 专项 → 供应商核实 → 商业缺口）。
 * 每项必须可溯源到已有正式数据；无来源的内容一律不生成。
 */
function buildTasks(
  input: BuildCommercialFeasibilityInput,
  view: CommercialFeasibilityView,
): { tasks: ValidationBriefTask[]; productSpecificTaskCount: number } {
  const voc = input.vocImprovementInsights ?? null;
  const tasks: ValidationBriefTask[] = [];
  const seen = new Set<string>();
  const usedThemeLabels = new Set<string>();

  const push = (task: ValidationBriefTask) => {
    const key = normalizeForDedupe(`${task.title}${task.detail}`);
    if (seen.has(key)) return;
    // 同一来源主题不重复生成（改进需求已覆盖该主题时跳过对应核实项）
    seen.add(key);
    tasks.push(task);
  };

  const productStart = tasks.length;

  // 1) 正式 VOC 改进需求（服务端仅从 recurring 主题派生，带证据锚点）
  for (const requirement of (voc?.requirements ?? []).slice(0, 3)) {
    usedThemeLabels.add(normalizeForDedupe(requirement.sourceThemeLabel));
    push({
      id: `voc-improvement-${requirement.id}`,
      title: `改进方向核实：${requirement.sourceThemeLabel}`,
      detail: `${requirement.requirement}（来源：${describeVocThemeStrength(requirement.reviewCount).evidencePhrase}）。此为待验证方向，非已确定改进方案。`,
      source: "voc_improvement",
      sourceLabel: TASK_SOURCE_LABELS.voc_improvement,
      mentionCount: requirement.reviewCount,
      evidenceRefs: requirement.evidenceRefs ?? [],
    });
  }

  // 2) 正式 VOC 下一步研究建议（商品级）
  for (const [index, step] of (voc?.nextResearchSteps ?? []).slice(0, 3).entries()) {
    push({
      id: `voc-next-step-${index}`,
      title: `补充证据核实：${step.slice(0, 24)}${step.length > 24 ? "…" : ""}`,
      detail: `${step}（来源：正式 VOC 分析 nextResearchSteps）`,
      source: "research_next_step",
      sourceLabel: TASK_SOURCE_LABELS.research_next_step,
      mentionCount: null,
      evidenceRefs: [],
    });
  }

  // 3) 供应商 / 验货核实项（服务端从痛点主题派生，带证据锚点与提及数）
  for (const checkpoint of (voc?.checkpoints ?? []).slice(0, 3)) {
    if (usedThemeLabels.has(normalizeForDedupe(checkpoint.sourceThemeLabel))) continue;
    push({
      id: `supplier-checkpoint-${checkpoint.id}`,
      title: `供应商/验货核实：${checkpoint.sourceThemeLabel}`,
      detail: `${checkpoint.checkpoint}。只核实「是否存在该问题」，不得据此指定材料、厚度或工艺方案。`,
      source: "supplier_checkpoint",
      sourceLabel: TASK_SOURCE_LABELS.supplier_checkpoint,
      mentionCount: checkpoint.reviewCount,
      evidenceRefs: checkpoint.evidenceRefs ?? [],
    });
  }

  // 4) 样本局限（正式 VOC 明确声明的「本样本无法证明什么」）
  for (const [index, unknown] of (voc?.unknowns ?? []).slice(0, 2).entries()) {
    push({
      id: `sample-unknown-${index}`,
      title: "样本局限待补充",
      detail: `${unknown}（来源：正式 VOC 分析 unknowns）`,
      source: "sample_unknown",
      sourceLabel: TASK_SOURCE_LABELS.sample_unknown,
      mentionCount: null,
      evidenceRefs: [],
    });
  }

  const productSpecificTaskCount = tasks.length - productStart;

  // 无任何商品专项证据（正式 VOC 派生）时：只用最小通用核实建议，并明确标为模板参考，
  // 不与通用商业缺口任务重复堆叠。
  if (productSpecificTaskCount === 0) {
    return {
      tasks: TEMPLATE_VERIFICATION_TASKS.map((item, index) => ({
        id: `template-${index}`,
        title: item.title,
        detail: item.detail,
        source: "template" as const,
        sourceLabel: TASK_SOURCE_LABELS.template,
        mentionCount: null,
        evidenceRefs: [],
      })),
      productSpecificTaskCount,
    };
  }

  // 5) 商业数据缺口 → 针对性核实任务（只提出「要核实什么」，不填任何数值）
  for (const gap of view.commercialAssessment.dataGaps.slice(0, 4)) {
    push({
      id: `commercial-gap-${normalizeForDedupe(gap.field)}`,
      title: `商务核实：${gap.field}`,
      detail: `须向供应商/平台核实「${gap.field}」的实际数值（${gap.impact}）。在取得真实凭证前不得预估或填入估算值。`,
      source: "commercial_gap",
      sourceLabel: TASK_SOURCE_LABELS.commercial_gap,
      mentionCount: null,
      evidenceRefs: [],
    });
  }

  return { tasks: tasks.slice(0, 12), productSpecificTaskCount };
}

function buildMarkdown(view: ValidationBriefViewModel): string {
  const lines: string[] = [];
  lines.push("# 产品验证需求单（Validation Brief）");
  lines.push("> 阶段性质：前置验证工作底稿 · 仅供商务询价核实 · 非正式立项通知");
  lines.push(`> 人工决策状态：${view.decision.gateLabel} · 商品 ASIN：${view.asin}`);
  if (view.decision.staleBlocked) {
    lines.push(`> ⚠ ${view.decision.staleMessage ?? DECISION_STALE_MESSAGE}（staleReason=${view.decision.staleReason ?? "unknown"}）`);
    lines.push("> 本需求单不可作为当前已批准状态使用。");
  }
  lines.push("");

  lines.push("## 一、商品基础档案");
  lines.push(`- 商品 ASIN：${view.asin}`);
  lines.push(`- 商品名称：${view.title || "无标题"}`);
  lines.push(`- 代表样本角色：${view.roleLabel}`);
  lines.push("");

  lines.push("## 二、当前机会验证方向");
  lines.push(`- 验证方向：${view.direction.direction}`);
  lines.push(`- 推导依据：${view.direction.premise}`);
  lines.push(`- 证据强度：${view.direction.basisStrength ?? "无正式 VOC 主题支撑"}`);
  if (view.direction.caveat) lines.push(`- 强度限定：${view.direction.caveat}`);
  lines.push(`- 验证状态：${view.direction.state}`);
  lines.push("- 声明说明：AI 推断，非事实证据，需要人工验证");
  lines.push("");

  lines.push("## 三、已确认事实证据（按来源状态严格分层）");
  lines.push("### 3.1 已确认事实 (AVAILABLE)");
  if (view.facts.available.length === 0) lines.push("- 无");
  for (const fact of view.facts.available) lines.push(`- ${fact.label}：${fact.displayValue}${fact.note ? `（${fact.note}）` : ""}`);
  lines.push("### 3.2 来源明确的估算 (ESTIMATED · 不计入已确认事实)");
  if (view.facts.estimated.length === 0) lines.push("- 无");
  for (const fact of view.facts.estimated) lines.push(`- ${fact.label}：${fact.displayValue}${fact.note ? `（${fact.note}）` : ""}`);
  lines.push("### 3.3 缺失 / 无法验证 (DATA_MISSING)");
  if (view.facts.missing.length === 0) lines.push("- 无");
  for (const fact of view.facts.missing) lines.push(`- ${fact.label}：缺失${fact.note ? `（${fact.note}）` : ""}`);
  lines.push("");

  if (view.researchInterpretation) {
    lines.push("## 三·附 研究解释（AI 研报摘要 · 非事实证据）");
    lines.push(view.researchInterpretation);
    lines.push("");
  }

  lines.push("## 四、买家声音 (VOC) 信号");
  if (view.voc.state === "AVAILABLE") {
    lines.push(`- 独立评论数：${view.voc.independentReviewCount ?? "未随分析快照记录"} 条`);
    lines.push(`- 主题提及次数：${view.voc.themeMentionCount} 次（同一评论可属多个主题，不等于独立样本数）`);
    lines.push("- 正向认可信号：");
    if (view.voc.positive.length === 0) lines.push("  - 无");
    for (const signal of view.voc.positive) {
      lines.push(`  - ${signal.text}（${describeVocThemeStrength(signal.reviewCount ?? 0).evidencePhrase}）`);
    }
    lines.push("- 负向痛点信号：");
    if (view.voc.negative.length === 0) lines.push("  - 无");
    for (const signal of view.voc.negative) {
      lines.push(`  - ${signal.text}（${describeVocThemeStrength(signal.reviewCount ?? 0).evidencePhrase}）`);
    }
  } else {
    lines.push("- 暂无正式 VOC 数据（不等于没有评论证据：已合法采集的评论由 VOC 层投影；禁止 AI 补充臆测痛点）");
  }
  lines.push("");

  lines.push("## 五、商业与供应链缺口（为什么当前不能直接进入开发）");
  view.dataGaps.forEach((gap, index) => {
    lines.push(`${index + 1}. ${gap.field}（${gap.category}）— ${gap.impact}`);
  });
  lines.push("");

  lines.push("## 六、下一步供应商与商务验证任务");
  if (view.taskFallbackUsed) {
    lines.push("> 本商品暂无正式 VOC 专项验证数据，以下为最小通用核实建议（模板参考，不代表本商品专项任务）。");
  }
  view.tasks.forEach((task, index) => {
    const mention = task.mentionCount === null ? "" : `，提及 ${task.mentionCount} 次`;
    lines.push(`${index + 1}. **${task.title}**［来源：${task.sourceLabel}${mention}］`);
    lines.push(`   ${task.detail}`);
  });
  lines.push("");

  lines.push("---");
  lines.push("注：本需求单用于前置验证链路闭环，不代表正式产品立项；所有商务条款须以真实合同及样品检验为准。");
  return lines.join("\n");
}

export type BuildValidationBriefViewInput = {
  asin: string;
  title?: string | null;
  role?: string | null;
  /** 研报执行摘要（AI 解释层） */
  summary?: string | null;
  /** 已构建的商业可行性视图（优先使用，避免重复计算） */
  feasibilityView?: CommercialFeasibilityView;
  /** 或传入原始输入自行构建 */
  input?: BuildCommercialFeasibilityInput;
};

/**
 * 构建 Validation Brief 只读 ViewModel —— 页面渲染与 Markdown 导出共用。
 */
export function buildValidationBriefView(brief: BuildValidationBriefViewInput): ValidationBriefViewModel {
  const view = brief.feasibilityView
    ?? (brief.input
      ? buildCommercialFeasibility(brief.input)
      : buildCommercialFeasibility({
        asin: brief.asin,
        title: brief.title,
        marketProvenance: brief.role ? { role: brief.role } : undefined,
      }));

  const effectiveRole = brief.role || view.role || null;
  const gate = view.commercialAssessment.decisionSupport.currentGate;
  const staleBlocked = view.commercialAssessment.decisionSupport.decisionStale;
  const staleReason = view.commercialAssessment.decisionSupport.decisionStaleReason;
  const summary = (brief.summary ?? "").trim();

  const { tasks, productSpecificTaskCount } = buildTasks(brief.input ?? { asin: brief.asin }, view);

  const model: ValidationBriefViewModel = {
    asin: brief.asin,
    title: brief.title ?? "",
    roleLabel: roleLabelOf(effectiveRole),
    decision: {
      gate,
      gateLabel: HUMAN_DECISION_GATE_LABELS[gate] ?? gate,
      staleBlocked,
      staleReason,
      staleMessage: staleBlocked ? DECISION_STALE_MESSAGE : null,
    },
    direction: buildDirection(view),
    facts: groupFacts(view.confirmedFacts),
    researchInterpretation: summary.length > 0 ? summary : null,
    voc: {
      state: view.buyerVoc.state,
      independentReviewCount: view.buyerVoc.independentReviewCount,
      themeMentionCount: view.buyerVoc.themeMentionCount,
      themeCount: view.buyerVoc.themeCount,
      summary: view.buyerVoc.summary,
      positive: view.buyerVoc.positiveSignals,
      negative: view.buyerVoc.negativeSignals,
    },
    dataGaps: view.commercialAssessment.dataGaps.map((gap) => ({ field: gap.field, category: gap.category, impact: gap.impact })),
    tasks,
    productSpecificTaskCount,
    taskFallbackUsed: productSpecificTaskCount === 0,
    markdown: "",
  };

  return { ...model, markdown: buildMarkdown(model) };
}
