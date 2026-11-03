import {
  type CanonicalDecisionStatus,
  toCanonicalDecisionStatus,
} from "./v5DecisionStatus";

/**
 * User-facing 7-Stage Business Model for LightChoice Decision Workspace
 *
 * MAPPING PRINCIPLES:
 * 1. archived -> "archived" (已归档)
 * 2. Canonical PROCEED -> "proceed" (已推进)
 * 3. Canonical VALIDATE_MORE -> "validate_more" (需补充验证)
 * 4. Canonical PAUSE -> "pause" (暂缓)
 * 5. Canonical DROP -> "drop" (已放弃)
 * 6. No final decision + formal decision prerequisites met -> "needs_decision" (待决策)
 * 7. Rest (unfinalized research / candidate / missing prerequisites) -> "ready" (待准备)
 */
export type BusinessStage =
  | "ready"
  | "needs_decision"
  | "proceed"
  | "validate_more"
  | "pause"
  | "drop"
  | "archived";

export type V5BusinessStage = BusinessStage;
export type V5BusinessStageTab = "all" | BusinessStage;

export interface BusinessStageMeta {
  readonly stage: BusinessStage;
  readonly label: string;
  readonly badgeText: string;
  readonly description: string;
  readonly tone: "slate" | "amber" | "emerald" | "blue" | "indigo" | "rose";
}

export const BUSINESS_STAGES: Record<BusinessStage, BusinessStageMeta> = {
  ready: {
    stage: "ready",
    label: "待准备",
    badgeText: "待准备",
    description: "商品处于采集或研究准备阶段，尚未生成完整研报",
    tone: "slate",
  },
  needs_decision: {
    stage: "needs_decision",
    label: "待决策",
    badgeText: "待决策",
    description: "正式研报与证据已就绪，等待您的商业拍板",
    tone: "amber",
  },
  proceed: {
    stage: "proceed",
    label: "已推进",
    badgeText: "已推进",
    description: "已决定继续推进研究与需求讨论，不等于立项批准",
    tone: "emerald",
  },
  validate_more: {
    stage: "validate_more",
    label: "需补充验证",
    badgeText: "需补充验证",
    description: "关键证据不足，待补充事实后再做决断",
    tone: "blue",
  },
  pause: {
    stage: "pause",
    label: "暂缓",
    badgeText: "暂缓",
    description: "商品策略暂缓，持续观察市场时机",
    tone: "indigo",
  },
  drop: {
    stage: "drop",
    label: "已放弃",
    badgeText: "已放弃",
    description: "风险过高或不符合选品标准，正式淘汰",
    tone: "rose",
  },
  archived: {
    stage: "archived",
    label: "已归档",
    badgeText: "已归档",
    description: "历史研究记录已归档保存",
    tone: "slate",
  },
} as const;

export const BUSINESS_STAGE_TABS: ReadonlyArray<{
  readonly key: "all" | BusinessStage;
  readonly label: string;
  readonly stage?: BusinessStage;
}> = [
  { key: "all", label: "全部" },
  { key: "ready", label: "待准备", stage: "ready" },
  { key: "needs_decision", label: "待决策", stage: "needs_decision" },
  { key: "proceed", label: "已推进", stage: "proceed" },
  { key: "validate_more", label: "需补充验证", stage: "validate_more" },
  { key: "pause", label: "暂缓", stage: "pause" },
  { key: "drop", label: "已放弃", stage: "drop" },
  { key: "archived", label: "已归档", stage: "archived" },
] as const;

export interface ResolveBusinessStageInput {
  readonly isArchived?: boolean | null;
  readonly archivedAt?: string | Date | null;
  readonly myChoice?: {
    readonly choice?: string | null;
    readonly canonicalStatus?: CanonicalDecisionStatus | string | null;
    readonly hubStatus?: string | null;
    readonly scope?: string | null;
  } | null;
  readonly dbStatus?: string | null;
  // Decision prerequisites
  readonly taskId?: string | null;
  readonly isLegacy?: boolean | null;
  readonly reportHash?: string | null;
  readonly deepseekAvailable?: boolean | null;
  readonly hasFormalReport?: boolean | null;
}

/**
 * Universal business stage resolver across Home, Research List, and Research Detail.
 */
export function resolveBusinessStage(input: ResolveBusinessStageInput): BusinessStage {
  // 1. Archived check
  if (input.isArchived || input.archivedAt) {
    return "archived";
  }

  // 2. Canonical Human Decision check
  const choice = input.myChoice;
  if (choice || input.dbStatus) {
    const canonical = toCanonicalDecisionStatus({
      myChoice: choice,
      dbStatus: input.dbStatus,
    });

    if (canonical === "PROCEED") return "proceed";
    if (canonical === "DROP") return "drop";
    if (canonical === "PAUSE") return "pause";
    if (canonical === "VALIDATE_MORE" || canonical === "LEGACY_NEED_INFO_AMBIGUOUS") {
      return "validate_more";
    }
  }

  // 3. No final decision made yet: check decision prerequisites
  // Prerequisites: real taskId, not legacy, has formal report or deepseek report ready
  const hasTaskId = Boolean(input.taskId);
  const isNotLegacy = !input.isLegacy;
  const hasReport = Boolean(
    input.hasFormalReport || input.reportHash || input.deepseekAvailable
  );

  if (hasTaskId && isNotLegacy && hasReport) {
    return "needs_decision";
  }

  return "ready";
}

export function getBusinessStageMeta(stage: BusinessStage): BusinessStageMeta {
  return BUSINESS_STAGES[stage] ?? BUSINESS_STAGES.ready;
}
