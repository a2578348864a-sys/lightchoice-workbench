/**
 * Product Workflow Recovery 的统一阶段解析器。
 *
 * 这里只读取已经存在的计数与人工决策投影，不创建业务事实，也不替代
 * Market Gate / Product Gate 的写入权威。首页、导航和各详情页只引用这一
 * 份阶段命名与下一步动作，避免把旧的 OpportunityCandidate 流程重新带回主链。
 */

export const WORKFLOW_STAGES = [
  "MARKET_CAPTURE",
  "MARKET_RESEARCH",
  "MARKET_DECISION",
  "BENCHMARK_SELECTION",
  "PRODUCT_RESEARCH",
  "PRODUCT_DECISION",
  "PRODUCT_BRIEF",
] as const;

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

export type WorkflowFacts = {
  readonly sourceBatchCount: number;
  readonly sourceItemCount: number;
  readonly marketScanCount: number;
  readonly marketSampleCount: number;
  readonly marketDecisionPendingCount: number;
  readonly marketProceedCount: number;
  readonly representativeCount: number;
  readonly researchTaskCount: number;
  readonly productDecisionCount: number;
  readonly productGateProceedCount: number;
  readonly productBriefCount: number;
};

export type WorkflowAction = {
  readonly type: WorkflowStage;
  readonly title: string;
  readonly description: string;
  readonly href: string;
  readonly ctaLabel: string;
};

export type WorkflowStageMeta = {
  readonly stage: WorkflowStage;
  readonly label: string;
  /** 英文辅助名：中文优先展示，英文仅作辅助识别。 */
  readonly labelEn: string;
  readonly description: string;
  readonly href: string;
};

export const WORKFLOW_STAGE_META: Record<WorkflowStage, WorkflowStageMeta> = {
  MARKET_CAPTURE: {
    stage: "MARKET_CAPTURE",
    label: "01 市场采集",
    labelEn: "Market Capture",
    description: "采集并冻结一批可追溯的市场商品证据。",
    href: "/source",
  },
  MARKET_RESEARCH: {
    stage: "MARKET_RESEARCH",
    label: "02 市场研究",
    labelEn: "Market Research",
    description: "在同一 MarketScan 内查看市场规模、价格、竞争与样本。",
    href: "/market-analysis",
  },
  MARKET_DECISION: {
    stage: "MARKET_DECISION",
    label: "市场闸门",
    labelEn: "Market Gate",
    description: "由人工决定市场是否值得继续投入研究。",
    href: "/market-analysis",
  },
  BENCHMARK_SELECTION: {
    stage: "BENCHMARK_SELECTION",
    label: "代表商品选择",
    labelEn: "Benchmark Selection",
    description: "在已通过市场闸门（Market Gate）的扫描中确认 1 到 N 个代表商品。",
    href: "/market-analysis",
  },
  PRODUCT_RESEARCH: {
    stage: "PRODUCT_RESEARCH",
    label: "03 商品深研",
    labelEn: "Product Research",
    description: "基于冻结的市场代表或快速通道 ASIN 形成商品研报。",
    href: "/research",
  },
  PRODUCT_DECISION: {
    stage: "PRODUCT_DECISION",
    label: "商品闸门",
    labelEn: "Product Gate",
    description: "基于事实、证据与研究结果做出继续、补证、暂缓或放弃决策。",
    href: "/research?view=needs_decision",
  },
  PRODUCT_BRIEF: {
    stage: "PRODUCT_BRIEF",
    label: "04 产品开发需求单",
    labelEn: "Product Brief",
    description: "把研究事实、买家声音与比较证据整理成可审阅的产品开发需求单。",
    href: "/product-brief",
  },
};

function actionFor(stage: WorkflowStage): WorkflowAction {
  const meta = WORKFLOW_STAGE_META[stage];
  const actions: Record<WorkflowStage, Omit<WorkflowAction, "type">> = {
    MARKET_CAPTURE: {
      title: "先采集一批市场商品",
      description: "导入或采集可追溯的商品证据，作为后续市场研究的输入。",
      href: meta.href,
      ctaLabel: "进入市场采集 ➔",
    },
    MARKET_RESEARCH: {
      title: "创建市场研究",
      description: "使用已冻结的商品批次创建 MarketScan，查看真实样本与指标。",
      href: meta.href,
      ctaLabel: "进入市场研究 ➔",
    },
    MARKET_DECISION: {
      title: "完成市场闸门决策",
      description: "先记录市场是否值得继续投入；系统不会替你做市场通过判断。",
      href: meta.href,
      ctaLabel: "处理市场闸门 ➔",
    },
    BENCHMARK_SELECTION: {
      title: "确认代表商品",
      description: "在通过市场闸门的同一批市场样本中确认基准、新进入者或痛点样本。",
      href: meta.href,
      ctaLabel: "选择代表商品 ➔",
    },
    PRODUCT_RESEARCH: {
      title: "进入商品深研",
      description: "查看或发起正式商品研究；没有市场绑定的快速 ASIN 会明确显示「快速通道」。",
      href: meta.href,
      ctaLabel: "进入商品深研 ➔",
    },
    PRODUCT_DECISION: {
      title: "完成商品闸门决策",
      description: "研究结果已具备决策入口，请在商品闸门中做出人工商业决断。",
      href: meta.href,
      ctaLabel: "处理商品闸门 ➔",
    },
    PRODUCT_BRIEF: {
      title: "形成产品开发需求单",
      description: "将通过商品闸门的研究事实整理成可编辑、可打印的产品开发需求单。",
      href: meta.href,
      ctaLabel: "进入产品开发需求单 ➔",
    },
  };
  return { type: stage, ...actions[stage] };
}

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function resolveWorkflowStage(facts: WorkflowFacts): { stage: WorkflowStage; action: WorkflowAction } {
  // 已经存在 Product Brief 时，工作台应把用户带到需求单复核/编辑，而不是退回研究列表。
  // 文案必须区分：「查看已有草稿」vs「已通过商品闸门后形成需求单」。
  // 仅存在 Brief、没有 PROCEED 时，通常是 VALIDATE_MORE 等非终裁状态下的历史草稿，
  // 不能暗示已经具备生成/推进条件。
  if (positive(facts.productBriefCount) || positive(facts.productGateProceedCount)) {
    const stage: WorkflowStage = "PRODUCT_BRIEF";
    const base = actionFor(stage);
    if (positive(facts.productBriefCount) && !positive(facts.productGateProceedCount)) {
      return {
        stage,
        action: {
          ...base,
          title: "查看产品开发需求单",
          description:
            "已有需求单草稿。若 03 商品闸门仍为「需补充验证」或证据已过期，请先补齐证据并重新确认，再决定是否推进。",
          ctaLabel: "打开需求单复核 ➔",
        },
      };
    }
    if (positive(facts.productBriefCount) && positive(facts.productGateProceedCount)) {
      return {
        stage,
        action: {
          ...base,
          title: "查看产品开发需求单",
          description: "已有可编辑的需求单。若来源研究版本变化，请先在 03 重新确认后再保存。",
          ctaLabel: "打开产品开发需求单 ➔",
        },
      };
    }
    return { stage, action: base };
  }
  if (positive(facts.productDecisionCount)) {
    const stage = "PRODUCT_DECISION";
    return { stage, action: actionFor(stage) };
  }
  if (positive(facts.researchTaskCount)) {
    const stage = "PRODUCT_RESEARCH";
    return { stage, action: actionFor(stage) };
  }
  if (positive(facts.marketDecisionPendingCount)) {
    const stage = "MARKET_DECISION";
    return { stage, action: actionFor(stage) };
  }
  if (positive(facts.marketProceedCount) && facts.representativeCount === 0) {
    const stage = "BENCHMARK_SELECTION";
    return { stage, action: actionFor(stage) };
  }
  if (positive(facts.marketScanCount) || positive(facts.marketSampleCount)) {
    const stage = "MARKET_RESEARCH";
    return { stage, action: actionFor(stage) };
  }
  if (positive(facts.sourceBatchCount) || positive(facts.sourceItemCount)) {
    const stage = "MARKET_CAPTURE";
    return { stage, action: actionFor(stage) };
  }
  const stage = "MARKET_CAPTURE";
  return { stage, action: actionFor(stage) };
}

/** 下一步建议关联的具体业务对象（D0-006：动作与展示对象必须同主体）。 */
export type WorkflowActionSubject = {
  readonly kind: "research" | "brief" | "market_scan";
  readonly subjectId: string;
  readonly asin: string | null;
  readonly title: string | null;
  readonly image: string | null;
};

export type WorkflowActionWithTarget = WorkflowAction & {
  readonly subject?: WorkflowActionSubject;
};

export type WorkflowActionCandidates = {
  /** 等待商品闸门决策的研究（needs_decision）。 */
  readonly decisionTargets: ReadonlyArray<{ taskId: string; asin: string; title: string | null; image: string | null }>;
  /** 有资格进入需求单的研究：已有 Brief，或已通过 Product Gate（proceed）。 */
  readonly briefTargets: ReadonlyArray<{
    taskId: string;
    asin: string;
    title: string | null;
    image: string | null;
    hasBrief: boolean;
    businessStage?: "needs_decision" | "ready" | "proceed" | "pause" | "validate_more" | "drop" | "archived" | string;
  }>;
  /** 待 Market Gate 决策的市场画像。 */
  readonly pendingScanTargets: ReadonlyArray<{ scanId: string; scanName: string }>;
  /** 已通过 Market Gate 的市场画像。 */
  readonly proceedScanTargets: ReadonlyArray<{ scanId: string; scanName: string }>;
};

/**
 * 为当前阶段动作绑定唯一目标对象与 URL。
 *
 * - 有合格对象 → href 带 taskId/scanId，subject 与动作同主体，前端展示该对象卡片；
 * - 没有合格对象 → 返回无 subject 的阶段性动作，前端只展示建议、不拼接任意商品。
 *   这样可以避免「展示 Koolstuffs 却跳进不带它上下文的需求单中心」的错位（D0-006）。
 */
export function resolveWorkflowActionTarget(
  stage: WorkflowStage,
  candidates: WorkflowActionCandidates,
  /** 可选：调用方已根据全局计数改写过的阶段动作（如「查看」而非「形成」）。 */
  baseAction?: WorkflowAction,
): WorkflowActionWithTarget {
  const action = baseAction ?? actionFor(stage);
  switch (stage) {
    case "PRODUCT_DECISION": {
      const target = candidates.decisionTargets[0];
      if (!target) return action;
      return {
        ...action,
        href: `/research/${encodeURIComponent(target.taskId)}`,
        subject: {
          kind: "research",
          subjectId: target.taskId,
          asin: target.asin,
          title: target.title,
          image: target.image,
        },
      };
    }
    case "PRODUCT_BRIEF": {
      // 优先级：已有 Brief 且已 PROCEED > 已有 Brief（含 VALIDATE_MORE 草稿）> 仅 PROCEED 待生成。
      const target =
        candidates.briefTargets.find((entry) => entry.hasBrief && entry.businessStage === "proceed") ??
        candidates.briefTargets.find((entry) => entry.hasBrief) ??
        candidates.briefTargets.find((entry) => entry.businessStage === "proceed");
      if (!target) return action;
      return {
        ...action,
        href: `/product-brief?taskId=${encodeURIComponent(target.taskId)}`,
        subject: {
          kind: "brief",
          subjectId: target.taskId,
          asin: target.asin,
          title: target.title,
          image: target.image,
        },
      };
    }
    case "MARKET_DECISION": {
      const target = candidates.pendingScanTargets[0];
      if (!target) return action;
      return {
        ...action,
        href: `/market-analysis/${encodeURIComponent(target.scanId)}`,
        subject: {
          kind: "market_scan",
          subjectId: target.scanId,
          asin: null,
          title: target.scanName,
          image: null,
        },
      };
    }
    case "BENCHMARK_SELECTION": {
      const target = candidates.proceedScanTargets[0];
      if (!target) return action;
      return {
        ...action,
        href: `/market-analysis/${encodeURIComponent(target.scanId)}`,
        subject: {
          kind: "market_scan",
          subjectId: target.scanId,
          asin: null,
          title: target.scanName,
          image: null,
        },
      };
    }
    default:
      return action;
  }
}
