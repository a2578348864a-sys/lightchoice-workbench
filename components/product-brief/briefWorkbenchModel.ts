import type { ProductBrief, ProductBriefStatus } from "@/lib/productBrief/contract";
import type { BriefDraft } from "@/lib/productBrief/briefEditing";

export type BriefListItem = {
  taskId: string;
  title: string | null;
  asin: string;
  status: ProductBriefStatus | string;
  revision: number;
  generatedAt: string;
  stale?: boolean;
  staleReason?: string | null;
  imageUrl?: string | null;
  brand?: string | null;
  researchRevision?: number;
  positioningText?: string | null;
  approvalBlocked?: string | null;
  missingCostCount?: number;
  syntheticSample?: boolean;
};

export type BriefDetailResponse = {
  brief: ProductBrief | null;
  history?: ProductBrief[];
  historyIntegrity?: "VALID" | "INVALID";
  stale: boolean;
  staleReason: string | null;
  resourceVersion?: string;
};

const STATUS_LABEL: Record<ProductBriefStatus, string> = {
  DRAFT: "草稿",
  READY: "待评审",
  APPROVED: "已批准",
};

export function statusLabelOf(status: ProductBriefStatus | string): string {
  return STATUS_LABEL[status as ProductBriefStatus] ?? "草稿";
}

export function statusTone(status: ProductBriefStatus | string): "ready" | "approved" | "draft" {
  if (status === "APPROVED") return "approved";
  if (status === "READY") return "ready";
  return "draft";
}

export function displayProductTitle(title: string | null | undefined, asin: string): string {
  if (!title) return `${asin} 产品开发方案`;
  const candidates = [
    title.split(" | ")[0],
    title.split(" with ")[0],
    title.split(",")[0],
  ].map((value) => value.trim()).filter((value) => value.length >= 12);
  return candidates.sort((a, b) => a.length - b.length)[0] ?? title;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

export function formatMoney(value: number | null, currency = "USD"): string {
  if (value === null || !Number.isFinite(value)) return "未提供";
  return `${currency} ${value.toFixed(2)}`;
}

export function shortHash(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 14 ? `${value.slice(0, 10)}…${value.slice(-4)}` : value;
}

export function sourceStateOf(data: Pick<BriefDetailResponse, "stale" | "staleReason"> | null): { label: string; tone: "ok" | "warn" } {
  if (!data?.stale) return { label: "来源有效", tone: "ok" };
  if (data.staleReason === "RESEARCH_REPORT_AUTHORITY_AMBIGUOUS") return { label: "报告权威未定", tone: "warn" };
  return { label: "来源已变化", tone: "warn" };
}

export function listSourceState(item: BriefListItem): { label: string; tone: "ok" | "warn" } {
  if (!item.stale) return { label: "来源有效", tone: "ok" };
  if (item.staleReason === "RESEARCH_REPORT_AUTHORITY_AMBIGUOUS") return { label: "报告权威未定", tone: "warn" };
  if (item.staleReason === "PRODUCT_GATE_PROCEED_REQUIRED") return { label: "商品闸门未通过", tone: "warn" };
  return { label: "来源已变化", tone: "warn" };
}

export function listNextStep(item: BriefListItem): string {
  if (item.stale) {
    if (item.staleReason === "RESEARCH_REPORT_AUTHORITY_AMBIGUOUS") return "报告权威未定 · 历史内容只读。";
    if (item.staleReason === "PRODUCT_GATE_PROCEED_REQUIRED") return "商品闸门尚未继续推进 · 当前只读。";
    return "来源已变化 · 历史内容只读。";
  }
  if (item.status === "APPROVED") return "已批准；继续修订会生成新版本。";
  if (item.status === "READY") {
    return item.approvalBlocked
      ? `待人工评审；批准条件：${shortApprovalReason(item.approvalBlocked)}。`
      : "可进入人工评审；打开查看批准条件。";
  }
  return "继续完善方案、规格与成本。";
}

export function shortApprovalReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (reason.includes("FBA")) return "缺少 FBA 费用";
  if (reason.startsWith("缺少目标价格")) return "缺少目标售价";
  if (reason.startsWith("缺少目标毛利率")) return "缺少目标毛利率";
  if (reason.startsWith("采购成本上限不可计算")) return "成本项不完整，采购上限不可计算";
  const first = reason.split("。")[0];
  return first.length > 34 ? `${first.slice(0, 34)}…` : first;
}

export type ResearchSummary = {
  label: string;
  text: string;
  tone: "fact" | "warn" | "empty";
  isolated: boolean;
};

export function researchSummaryOf(brief: ProductBrief): ResearchSummary {
  const pain = brief.corePainPoints[0];
  if (pain) return { label: "买家问题", text: pain.text, tone: "fact", isolated: false };
  const overview = brief.projectOverview;
  if (overview) {
    const isolated = /隔离|联调|不代表真实市场结论/.test(overview.text);
    return { label: isolated ? "研究来源自述" : "研究摘要", text: overview.text, tone: isolated ? "warn" : "fact", isolated };
  }
  return {
    label: "研究依据",
    text: "当前研究没有带合法引用的买家问题或研究摘要；这里不补写结论。",
    tone: "empty",
    isolated: false,
  };
}

export function evidenceRefsOf(brief: ProductBrief): string[] {
  const refs = new Set<string>();
  const add = (line: { evidenceRefs: readonly string[] } | null | undefined) => line?.evidenceRefs.forEach((ref) => refs.add(ref));
  add(brief.projectOverview);
  brief.corePainPoints.forEach(add);
  brief.differentiation.forEach(add);
  brief.specsDirection.forEach(add);
  brief.vocQaRedlines.forEach(add);
  brief.risks.forEach(add);
  brief.rationale.forEach(add);
  brief.userScenarios?.forEach(add);
  brief.vocRequirements?.forEach(add);
  brief.competitiveHypotheses?.forEach(add);
  brief.researchAlternatives?.forEach(add);
  brief.supportingEvidence?.forEach(add);
  brief.counterevidence?.forEach(add);
  brief.researchAssumptions?.forEach(add);
  brief.causalInvestigations?.forEach((item) => {
    add(item.hypothesis);
    add(item.rationale);
    item.supportingEvidence.forEach(add);
    item.counterevidence.forEach(add);
  });
  return [...refs];
}

export function evidenceReferenceCount(brief: ProductBrief): number {
  return evidenceRefsOf(brief).length;
}

export function missingCostFields(brief: ProductBrief, draft: BriefDraft | null): string[] {
  const value = (key: "targetPrice" | "targetMarginPct" | "referralFee" | "logistics" | "estimatedTax") =>
    draft ? draft[key].trim() : brief.economics[key] === null ? "" : String(brief.economics[key]);
  const missing: string[] = [];
  if (!value("targetPrice")) missing.push("目标售价");
  if (!value("targetMarginPct")) missing.push("目标毛利率");
  if (!value("referralFee")) missing.push("平台佣金");
  if (!value("logistics")) missing.push("物流费用");
  if (!value("estimatedTax")) missing.push("估算税费");
  if (brief.economics.fbaFee === null) missing.push("FBA 费用（只读来源）");
  return missing;
}
