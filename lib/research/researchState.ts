/**
 * E-1B：研究任务的真实进度（派生口径，不持久化）。
 *
 * 背景：市场研究 → 商品深研的 handoff 只写 `factHash/evidenceHash`，`report` 仍为 null；
 * `resolveBusinessStage` 在没有 report 时会 fallback 成 `ready`，列表于是把「还没开始研究」
 * 显示成「已准备/进行中」，用户点开却没有任何报告。
 *
 * 这里用真实产物区分三态，供列表/详情展示；**不改变** businessStage、counts 或任何写入。
 */
export type ResearchProgressState = "report_ready" | "in_progress" | "not_started";

export type ResearchProgressInput = {
  /** 是否已有正式研报（v5Research.report 存在）。 */
  hasReport: boolean;
  /** 研究修订号；advisory 成功后会递增。 */
  researchRevision?: number | null;
  /** 任务里是否已有产品开发需求单。 */
  hasProductBrief?: boolean;
  /** 是否已有人工决策（临时或最终）。 */
  hasDecision?: boolean;
};

export function deriveResearchState(input: ResearchProgressInput): ResearchProgressState {
  if (input.hasReport) return "report_ready";
  const revision = typeof input.researchRevision === "number" ? input.researchRevision : 0;
  if (revision > 0 || input.hasProductBrief || input.hasDecision) return "in_progress";
  return "not_started";
}

export const RESEARCH_PROGRESS_LABELS: Record<ResearchProgressState, string> = {
  report_ready: "已有研究报告",
  in_progress: "研究进行中",
  not_started: "未开始研究",
};
