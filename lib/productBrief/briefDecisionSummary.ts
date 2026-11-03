import type { ProductBrief, ProductBriefStatus } from "./contract";
import { buildEconomicsStateView, type EconomicsStateView } from "./briefEconomicsStates";
import type { ImprovementPlan } from "@/lib/research/improvementPlan";
import { suggestedVerificationText } from "@/lib/research/improvementPlan";

/**
 * 04 需求单「决策摘要」——页面与 Markdown 导出的**同一份**计算来源。
 *
 * 为什么需要它：需求单正文很全，但用户打开后要先读完整研究过程才知道「现在能做什么」。
 * 本模块只做**既有事实的重排**，不新增状态机、不写库、不调用模型：
 *   - 文档状态来自 `brief.status`（DRAFT / READY / APPROVED，人工选择的文档生命周期状态）；
 *   - 研究验证状态来自改良假设派生结果（存在反证 / 单条线索 / 缺验证动作 / 只有问题陈述）；
 *   - 人工立项状态只认 `brief.status === "APPROVED"` + 批准门禁（成本测算）结果；
 *   - 商业条件来自 `buildEconomicsStateView`（当前值 / 历史保存值 / 缺失 / 不可计算四态）。
 *
 * P5-v4 修正：三类待办必须分开——产品问题验证、商业可行性确认、供应商确认。
 * 之前把「目标毛利率未填」这类商业缺口混进「下一步建议」，读者会误以为是产品验证动作。
 */

export type BriefDecisionTone = "ok" | "warn" | "blocked" | "neutral";

export type BriefDecisionLevel = {
  readonly key: "document" | "research" | "human";
  readonly label: string;
  readonly value: string;
  readonly note: string;
  readonly tone: BriefDecisionTone;
};

export type BriefDecisionProblem = {
  readonly text: string;
  readonly source: string;
  readonly isHypothesis: boolean;
  readonly verified: string;
  readonly counter: string;
  readonly evidenceRefs: string;
  readonly actionable: boolean;
};

/** 待办分组：三类互不冒充。 */
export type BriefTodoGroup = {
  readonly items: readonly string[];
  readonly note: string;
  /** RESEARCH = 研报已给出；TEMPLATE = 规则模板，未经人工确认；MIXED = 两者都有。 */
  readonly sourceKind: "RESEARCH" | "TEMPLATE" | "MIXED" | "NONE";
};

export type BriefDecisionSummary = {
  readonly headline: string;
  readonly headlineBasis: string;
  readonly tone: BriefDecisionTone;
  readonly levels: readonly BriefDecisionLevel[];
  readonly productProblems: readonly BriefDecisionProblem[];
  readonly productProblemNote: string | null;
  readonly keyUnknowns: readonly string[];
  readonly keyUnknownsSource: string;
  /** 产品问题验证（问题是否存在 / 怀疑原因 / 如何验证）。 */
  readonly verification: BriefTodoGroup;
  /** 商业可行性确认（值不值得开发：售价 / 毛利 / 平台费 / FBA / 物流 / 成本上限）。 */
  readonly business: BriefTodoGroup;
  /** 供应商确认（能否制造、代价多少）。 */
  readonly supplier: BriefTodoGroup;
  /** 兼容字段：等于 verification.items（历史调用方使用）。 */
  readonly nextActions: readonly string[];
  readonly nextActionsNote: string;
  readonly stopConditions: readonly string[];
  readonly stopConditionsNote: string | null;
  readonly economics: EconomicsStateView;
  readonly caliberNotes: readonly string[];
};

const DOCUMENT_LABELS: Readonly<Record<ProductBriefStatus, { value: string; note: string; tone: BriefDecisionTone }>> = {
  DRAFT: { value: "草稿（DRAFT）", note: "仍在整理，尚未进入人工评审。文档状态不代表研究已验证。", tone: "neutral" },
  READY: { value: "待评审（READY）", note: "文档内容可供人工评审；READY 不代表已通过立项评审，也不代表成本 / 供应链已验证。", tone: "warn" },
  APPROVED: { value: "已批准（APPROVED）", note: "人工在文档上标记批准；仅表示可进入开发评估，不等于供应商、成本或量产已就绪。", tone: "ok" },
};

const CALIBER_NOTES: readonly string[] = [
  "「确认事实」= 已持久化的商品事实字段（页面/来源读取），不等于供应商或性能已验证。",
  "估算值（月销量、月销售额、预估 FBA 费、毛利率等）是来源估算，不等于真实值。",
  "来源冲突保留并列，不做择一；缺失字段保持缺失，不填 0、不猜数值。",
  "旧快照缺少来源语义时只做展示层降级说明，不改写历史数据。",
  "「生成时缺失清单」是需求单生成那一刻的快照；后来补填的值以当前经济性字段为准。",
];

function textOf(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function buildBriefDecisionSummary(input: {
  readonly brief: ProductBrief | null;
  readonly plan: ImprovementPlan | null;
  readonly stale: boolean;
  readonly staleReason?: string | null;
  readonly approvalBlockedReason?: string | null;
}): BriefDecisionSummary {
  const { brief, plan, stale } = input;
  const approvalBlocked = textOf(input.approvalBlockedReason ?? null);
  const economics = buildEconomicsStateView(brief, { stale, approvalBlockedReason: approvalBlocked });

  // ── 三层状态 ─────────────────────────────────────────────
  const documentLevel: BriefDecisionLevel = brief
    ? {
        key: "document",
        label: "文档状态",
        value: DOCUMENT_LABELS[brief.status].value,
        note: DOCUMENT_LABELS[brief.status].note,
        tone: DOCUMENT_LABELS[brief.status].tone,
      }
    : { key: "document", label: "文档状态", value: "尚无需求单", note: "需先在 04 从当前研究生成需求单。", tone: "neutral" };

  const researchLevel: BriefDecisionLevel = {
    key: "research",
    label: "研究验证状态",
    value: plan ? plan.statusLabel : "无可派生的研究结论",
    note: plan
      ? `${plan.statusReason}${plan.items.length ? `（可改良性：${plan.actionabilityCounts.map((entry) => `${entry.label}×${entry.count}`).join("、")}）` : ""}`
      : "尚未加载到可用的研究结论，无法判断证据是否充分。",
    tone: !plan
      ? "neutral"
      : plan.status === "READY_FOR_LOW_COST_VALIDATION"
        ? "warn"
        : plan.status === "NO_PRODUCT_ACTIONABLE_CAUSE" || plan.status === "NO_ACTIONABLE_CAUSE"
          ? "neutral"
          : "warn",
  };

  const humanLevel: BriefDecisionLevel = {
    key: "human",
    label: "人工立项状态",
    value: !brief
      ? "无人工立项记录"
      : brief.status === "APPROVED"
        ? "人工已在文档上标记批准"
        : "无人工立项记录（文档未标记批准）",
    note: !brief
      ? "未生成需求单前不存在立项依据。"
      : brief.status === "APPROVED"
        ? "批准受成本测算门禁约束；仍不等于生产或采购授权。"
        : approvalBlocked
          ? `批准门禁未通过：${approvalBlocked}`
          : "成本测算已可计算；是否批准由人工决定。",
    tone: brief?.status === "APPROVED" ? "ok" : "neutral",
  };

  // ── 当前决策状态（只用既有事实组合，不新增状态机）──────────
  let headline: string;
  let headlineBasis: string;
  let tone: BriefDecisionTone = "warn";
  if (!brief) {
    headline = "尚未生成需求单：当前没有可评审的开发方案。";
    headlineBasis = "依据：04 需求单不存在。";
    tone = "neutral";
  } else if (stale) {
    headline = "来源已变化：当前需求单只读，需回 03 更新研究后再判断。";
    headlineBasis = `依据：来源绑定失效（${input.staleReason ?? "RESEARCH_OR_MARKET_BINDING_CHANGED"}）；经济性字段为历史保存值，不能直接沿用。`;
    tone = "blocked";
  } else if (!plan || !plan.items.length) {
    headline = "暂不具备立项依据：研报没有可执行的改良方向。";
    headlineBasis = "依据：研究结论为空，无法派生问题或原因。";
    tone = "neutral";
  } else if (plan.status === "NO_PRODUCT_ACTIONABLE_CAUSE") {
    headline = "仅有市场 / 运营层原因，不构成立项依据；应回到 02 市场研究。";
    headlineBasis = "依据：三态判断全部为非产品问题。";
    tone = "neutral";
  } else if (plan.status === "MIXED_NEEDS_HUMAN_SPLIT") {
    headline = "假设混合产品与市场因素，需人工拆分后才能判断是否具备立项条件。";
    headlineBasis = "依据：三态判断为混合/不确定。";
  } else if (plan.status === "NEEDS_MORE_EVIDENCE") {
    headline = "需补充关键证据：现有产品问题缺少可追溯线索。";
    headlineBasis = "依据：可用条目的支持线索为 0。";
  } else if (plan.status === "OBSERVATION_ONLY") {
    headline = "仅有问题陈述、缺原因假设：可先做低成本验证，但尚不具备立项依据。";
    headlineBasis = "依据：v5 综合研报没有逐项原因假设与验证动作。";
  } else if (plan.status === "NEEDS_VERIFICATION") {
    headline = "需先做区分性验证：存在反证、单条线索或缺少验证动作，不能直接立项。";
    headlineBasis = "依据：研究层存在未区分证据或没有验证动作。";
  } else {
    headline = "可考虑低成本验证（≠ 立项 ≠ 可下发生产）。";
    headlineBasis = "依据：至少一条产品问题具备多条支持线索与验证动作。";
    tone = "warn";
  }
  // 商业条件也是结论的一部分：即使研究层可验证，商业缺口未补齐时不能说"可立项"。
  if (brief && !stale && economics.gaps.length) {
    headlineBasis += ` 商业条件：${economics.gaps.length} 项仍需补齐或确认（${economics.gaps.map((field) => field.label).slice(0, 3).join("、")}）。`;
  }
  if (approvalBlocked && !stale && brief) {
    headlineBasis += ` 批准门禁：${approvalBlocked}`;
  }

  // ── 主要产品问题（只取产品问题，非产品/混合不进首屏）──────
  const items = plan?.items ?? [];
  const productItems = items.filter((item) => item.productActionable);
  const productProblems: BriefDecisionProblem[] = productItems.slice(0, 3).map((item) => ({
    text: item.hypothesis,
    source: item.inputKind === "CAUSE_HYPOTHESIS" ? "研报原因假设（v1 深度研报）" : "研报 VOC 问题陈述（v5 综合研报）",
    isHypothesis: true,
    verified: item.inputKind === "CAUSE_HYPOTHESIS"
      ? `未验证（研究层只给出假设；验证动作 ${item.verificationTasks.length} 项）`
      : "未验证（研报只做观察陈述，没有原因结论与验证动作）",
    counter: item.evidence.counterCount > 0
      ? `有 ${item.evidence.counterCount} 条反证线索（需先区分）`
      : item.inputKind === "CAUSE_HYPOTHESIS"
        ? "研报未给出反证线索（缺失不等于没有）"
        : "该研报无逐条反证字段（缺失不等于没有）",
    evidenceRefs: item.inputKind === "CAUSE_HYPOTHESIS"
      ? `支持线索 ${item.evidence.supportingCount} 条 / 未知 ${item.evidence.unknownCount} 条`
      : `引用 ${item.evidence.supportingCount} 条`,
    actionable: true,
  }));
  const nonProductCount = items.length - productItems.length;
  const productProblemNote = !productProblems.length
    ? "当前没有可识别的产品问题；不在此处虚构产品缺陷。"
    : nonProductCount > 0
      ? `另有 ${nonProductCount} 项非产品 / 混合判断未列入首屏（市场问题应回 02，混合问题需人工拆分）。`
      : null;

  // ── 三类待办 ─────────────────────────────────────────────
  // ① 产品问题验证：优先研报已给动作；没有则给规则模板并明确标注「未经人工确认」。
  const researchActions = items.flatMap((item) => item.verificationTasks.map((task) => `${task.label}：${task.task}`));
  const templateActions = productItems
    .flatMap((item) => item.missingVerificationCategories.slice(0, 2).map((category) => {
      const suggestion = suggestedVerificationText(category);
      return suggestion ? `【${category === "review_recheck" ? "复核买家反馈" : category === "competitor_comparison" ? "对比竞品" : "建议验证"}】${suggestion}` : null;
    }))
    .filter((value): value is string => Boolean(value));
  const verificationItems = researchActions.length ? researchActions.slice(0, 4) : templateActions.slice(0, 3);
  const verification: BriefTodoGroup = {
    items: verificationItems,
    sourceKind: researchActions.length ? "RESEARCH" : templateActions.length ? "TEMPLATE" : "NONE",
    note: researchActions.length
      ? "来自研报已给出的验证动作；未包含需要采购、检测或供应商配合的新增要求。"
      : templateActions.length
        ? "规则模板，未经人工确认：研报没有给出验证动作，这些是把问题变成可验证问题的最小动作，不是研究结论。"
        : "研报与需求单都没有给出可执行的验证动作，需人工补充后再判断。",
  };

  // ② 商业可行性确认：用当前经济性状态，不用生成时快照。
  // 商业条件要同时显示「已有什么」和「缺什么」：只列缺口会让用户以为已有值不存在。
  const businessItems = [
    ...economics.fields.map((field) => `${field.label}：${field.display}｜${field.stateLabel}`),
    ...(economics.upperBound
      ? [`采购成本上限粗略上界：${economics.upperBound.value} ${economics.upperBound.currency}（未扣 ${economics.upperBound.missingInputs.join("、") || "—"}，会高估；不是正式上限）`]
      : []),
  ];
  const business: BriefTodoGroup = {
    items: businessItems,
    sourceKind: economics.gaps.length ? "MIXED" : "NONE",
    note: economics.gaps.length
      ? `${economics.summaryLine}${economics.upperBound ? ` ${economics.upperBound.note}` : ""} 这些是「值不值得开发」的条件，不是产品性能验证动作。`
      : "商业条件已具备有效值；是否立项仍由人工决定（成本上限可计算 ≠ 可以立项）。",
  };

  // ③ 供应商确认：只列需求单已持久化的待确认事项，不编造能力/报价/交期。
  const confirmation = (brief?.confirmationItems ?? []).filter((row) => row.status === "待确认");
  const supplier: BriefTodoGroup = {
    items: confirmation.slice(0, 5).map((row) => `${row.item}${row.reason ? `（${row.reason}）` : ""}`),
    sourceKind: confirmation.length ? "RESEARCH" : "NONE",
    note: confirmation.length
      ? "这些是需求单生成时列出的供应商待确认事项；供应商能力、报价、交期、MOQ 仍为未知，除非已有合法证据。"
      : "需求单没有列出供应商确认事项，需人工补充；不要假定供应商已具备该能力。",
  };

  // ── 关键未知（用当前事实；生成时快照不再当作当前缺失）────────
  const planUnknowns = items.flatMap((item) => item.unknowns).filter(Boolean);
  const economicsGapLabels = economics.gaps.map((field) => `${field.label}：${field.display}（${field.stateLabel}）`);
  const keyUnknowns = (planUnknowns.length ? planUnknowns : economicsGapLabels).slice(0, 3);
  const keyUnknownsSource = planUnknowns.length
    ? "来自研报逐条未知事项"
    : economicsGapLabels.length
      ? "研报未提供逐条未知事项；以下来自当前经济性缺口（实时计算，不是生成时快照）"
      : "研报与经济性字段都没有列出未知；需人工补充。";

  // ── 停止条件（只提炼研报已有内容）────────────────────────
  const alternatives = brief?.researchAlternatives ?? [];
  const stopConditions = alternatives
    .map((line) => line.text)
    .filter((text) => /停止|放弃|保留现状|不做|退出|暂不/.test(text))
    .slice(0, 3);
  const stopConditionsNote = stopConditions.length
    ? null
    : "尚未形成明确停止条件，需人工补充（研报未给出「什么情况下应放弃」）。";

  return {
    headline,
    headlineBasis,
    tone,
    levels: [documentLevel, researchLevel, humanLevel],
    productProblems,
    productProblemNote,
    keyUnknowns,
    keyUnknownsSource,
    verification,
    business,
    supplier,
    nextActions: verification.items,
    nextActionsNote: verification.note,
    stopConditions,
    stopConditionsNote,
    economics,
    caliberNotes: CALIBER_NOTES,
  };
}
