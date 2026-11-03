import type { CanonicalDecisionStatus } from "@/lib/types/v5DecisionStatus";
import { toCanonicalDecisionStatus, getDecisionStatusDisplay } from "@/lib/types/v5DecisionStatus";
import { BUSINESS_STAGES, type V5BusinessStage } from "@/lib/types/v5BusinessStage";

export type ResearchFinding = {
  status: "CURRENT" | "HISTORICAL" | "NONE" | "NOT_STARTED";
  label: string;
  text: string | null;
  basis: string | null;
};

/** 服务端没给结构化发现时（旧响应/待生成任务）的兜底：只降级措辞，不编造结论。 */
export function researchFindingOf(row: ResearchListRow): ResearchFinding {
  // 报告被强度审查暂停采信时，优先展示报告状态；不能把报告原文继续当作当前发现。
  if (row.reportConsumptionBlocked) {
    return {
      status: "HISTORICAL",
      label: "报告暂停采信",
      text: null,
      basis: row.reportConsumptionNotice ?? "研报存在超过证据强度的结论，需复核后采信",
    };
  }
  // 来源失效优先于服务端可能仍标记为 CURRENT 的旧发现，避免历史结论被展示成当前结论。
  if (row.stale) {
    return { status: "HISTORICAL", label: "历史研报需复核", text: null, basis: "来源已变化，历史结论不能直接采信" };
  }
  if (row.finding) return row.finding;
  if (row.researchState === "not_started") {
    return { status: "NOT_STARTED", label: "尚未研究", text: null, basis: "还没有生成研报" };
  }
  const legacy = row.findingPreview?.trim();
  if (legacy) {
    return { status: "CURRENT", label: "核心发现", text: legacy, basis: "当前研报" };
  }
  return { status: "NONE", label: "暂无明确发现", text: null, basis: "没有可一句话概括的结论，完整内容见详情" };
}

/** 03 研究清单行：字段与服务端 /api/research 列表返回值一一对应，不补造。 */
export type ResearchListRow = {
  displayOnlyIdentity?: import("@/lib/product/researchDisplayIdentity").ResearchDisplayIdentity;
  taskId: string | null;
  candidateId: string;
  asin: string;
  researchRevision: number | null;
  businessStage?: V5BusinessStage;
  /**
   * E-1B：研究任务的真实进度（服务端派生，不写库）。
   * not_started = 只有任务壳（handoff 后尚未跑过研报），不能显示成「已准备/进入决策」。
   */
  researchState?: "report_ready" | "in_progress" | "not_started";
  /**
   * 列表「核心发现」投影（服务端只读派生）：status 决定措辞，text 为研报原文整句，
   * basis 说明依据；不再使用整段 summary 的字符截断。
   */
  finding?: ResearchFinding | null;
  /** 兼容字段：等于 finding.text，仅用于排序/旧数据兜底。 */
  findingPreview?: string | null;
  title: string | null;
  image: string | null;
  brand?: string | null;
  category?: string | null;
  price?: number | null;
  rating?: number | null;
  reviewCount?: number | null;
  marketplace: string;
  viewState:
    | "candidate_pending"
    | "in_progress"
    | "needs_choice"
    | "proceed"
    | "watch"
    | "drop"
    | "archived";
  myChoice: {
    choice: "PROCEED" | "WATCH" | "DROP" | null;
    canonicalStatus?: CanonicalDecisionStatus | null;
    hubStatus?: CanonicalDecisionStatus | null;
    scope: "FINAL" | "TEMPORARY" | null;
    chosenAt: string | null;
    reasonPreview: string | null;
  } | null;
  systemSuggestion: {
    status: "available" | "unavailable" | "failed" | "stale";
    composite: "recommend_proceed" | "watch_carefully" | "recommend_drop" | "no_suggestion";
    deepseekAvailable: boolean;
    jevStatus: "available" | "unavailable" | "failed";
    jevAtomicJudgmentSet: null;
  };
  stale: boolean;
  /** 研报强度审查结论（服务端详情/列表共用同一投影）；null 表示无审查结果。 */
  reportAuditVerdict?: "CONSISTENT" | "NEEDS_DOWNGRADE" | "BLOCKED" | "UNAVAILABLE" | null;
  /** true = 研报被暂停采信，人工决策/04 交接必须阻断。 */
  reportConsumptionBlocked?: boolean;
  reportConsumptionNotice?: string | null;
  archivedAt: string | null;
  updatedAt: string;
  resourceVersion?: string;
};

export function researchCardChoiceLabel(choice: ResearchListRow["myChoice"]): string {
  if (!choice || (!choice.choice && !choice.canonicalStatus)) return "尚未保存人工决定";
  const canonical = toCanonicalDecisionStatus({ myChoice: choice });
  if (!canonical || canonical === "PENDING") return "尚未保存人工决定";
  const display = getDecisionStatusDisplay(canonical);
  return (choice.scope === "FINAL" ? "人工决定：" : "临时观察：") + display.label;
}

export function researchCardSystemSuggestionLabel(suggestion: ResearchListRow["systemSuggestion"]): string {
  if (suggestion.status === "stale") return "需更新（来源已变化）";
  if (suggestion.status === "failed") return "读取失败";
  if (suggestion.status !== "available") return "暂无系统建议";
  if (suggestion.composite === "recommend_proceed") return "建议推进";
  if (suggestion.composite === "watch_carefully") return "谨慎观察";
  if (suggestion.composite === "recommend_drop") return "建议放弃";
  return "无明确建议";
}

export type ResearchCardTone = "ok" | "warn" | "risk" | "muted";

/** 卡片上的唯二状态：研究阶段（真实业务阶段）+ 数据新鲜度（需复核）。 */
export function researchCardStatusOf(row: ResearchListRow): { label: string; tone: ResearchCardTone } {
  if (row.archivedAt) return { label: "已归档", tone: "muted" };
  if (row.researchState === "not_started") return { label: "未开始研究", tone: "muted" };
  if (row.researchState === "in_progress") return { label: "研究进行中", tone: "warn" };
  const stage = row.businessStage ? BUSINESS_STAGES[row.businessStage] : null;
  // 报告被暂停采信/需降级时优先展示报告状态，不能继续显示成可执行的「待决策」。
  if (row.reportConsumptionBlocked) {
    return { label: stage ? `报告暂停采信 · ${stage.label}` : "报告暂停采信", tone: "risk" };
  }
  if (row.reportAuditVerdict === "NEEDS_DOWNGRADE") {
    return { label: stage ? `报告需复核 · ${stage.label}` : "报告需复核", tone: "warn" };
  }
  if (row.reportAuditVerdict === "UNAVAILABLE") {
    return { label: "报告审查不可用", tone: "warn" };
  }
  if (row.stale) {
    return { label: stage ? `需重新确认 · ${stage.label}` : "需重新确认", tone: "warn" };
  }
  if (!stage) return { label: "待决策", tone: "warn" };
  switch (stage.stage) {
    case "needs_decision":
      return { label: stage.label, tone: "warn" };
    case "proceed":
      return { label: stage.label, tone: "ok" };
    case "validate_more":
      return { label: stage.label, tone: "warn" };
    case "pause":
      return { label: stage.label, tone: "warn" };
    case "drop":
      return { label: stage.label, tone: "risk" };
    case "archived":
      return { label: stage.label, tone: "muted" };
    case "ready":
    default:
      return { label: stage.label, tone: "muted" };
  }
}

/** 每张卡只有一个主按钮：文案与目标由真实业务状态决定，跳转目标与旧版保持一致。 */
export function researchCardCtaOf(row: ResearchListRow): { label: string; href: string; muted: boolean } {
  if (!row.taskId) return { label: "待生成任务", href: "/source", muted: true };
  const href = "/research/" + encodeURIComponent(row.taskId);
  if (row.researchState === "not_started") return { label: "开始研究", href, muted: false };
  if (row.reportConsumptionBlocked || row.reportAuditVerdict === "NEEDS_DOWNGRADE" || row.reportAuditVerdict === "UNAVAILABLE" || row.stale) {
    return { label: "复核研究", href, muted: false };
  }
  if (row.myChoice?.choice) return { label: "查看研究", href, muted: false };
  return { label: "进入决策", href, muted: false };
}

export function researchCardPriceLabel(row: ResearchListRow): string | null {
  if (row.price === null || row.price === undefined || !Number.isFinite(row.price)) return null;
  const symbol = row.marketplace === "US" ? "$" : row.marketplace === "UK" || row.marketplace === "GB" ? "£" : row.marketplace === "DE" ? "€" : "";
  return `${symbol}${row.price.toFixed(2)}`;
}
