export type SellerSpriteCaptureTraversalState = {
  readonly page: number;
  readonly scrollY: number;
  readonly scrollTarget: "document" | "table" | null;
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly hasNextPage: boolean | null;
  readonly nextPageDisabled: boolean | null;
  readonly sourceLimitDeclared: boolean;
  readonly reportedTotalRows: number | null;
};

export type SellerSpriteCaptureTraversalDecision =
  | { readonly action: "scroll"; readonly limitationReason: "unknown" }
  | { readonly action: "next_page"; readonly limitationReason: "unknown" }
  | { readonly action: "complete"; readonly limitationReason: "query_finished" }
  | { readonly action: "stop"; readonly status: "PARTIAL"; readonly limitationReason: "source_limit_declared" | "budget_stop" | "unknown" };

export function decideSellerSpriteCaptureTraversal(input: {
  readonly state: SellerSpriteCaptureTraversalState;
  readonly capturedUniqueRows: number;
  readonly newUniqueRowsInWindow?: number;
  readonly windowsProcessed: number;
  readonly maxWindows: number;
}): SellerSpriteCaptureTraversalDecision {
  const { state } = input;
  const reportedTotalMatches = state.reportedTotalRows !== null
    && input.capturedUniqueRows === state.reportedTotalRows;
  if (state.sourceLimitDeclared) return { action: "stop", status: "PARTIAL", limitationReason: "source_limit_declared" };
  const budgetExhausted = input.windowsProcessed >= input.maxWindows;
  // 整页滚动范围可能来自筛选器、图表等页面内容，并不代表结果表是虚拟列表。
  // 若该文档滚动窗口没有增加唯一行且可见分页仍可继续，优先走分页；这不表示来源结束。
  if (state.scrollTarget === "document" && state.hasNextPage === true && input.newUniqueRowsInWindow === 0) {
    return budgetExhausted
      ? { action: "stop", status: "PARTIAL", limitationReason: "budget_stop" }
      : { action: "next_page", limitationReason: "unknown" };
  }
  if (state.scrollTarget && state.scrollHeight > state.clientHeight && state.scrollY + state.clientHeight < state.scrollHeight - 1) {
    return budgetExhausted
      ? { action: "stop", status: "PARTIAL", limitationReason: "budget_stop" }
      : { action: "scroll", limitationReason: "unknown" };
  }
  if (state.hasNextPage === true) {
    return budgetExhausted
      ? { action: "stop", status: "PARTIAL", limitationReason: "budget_stop" }
      : { action: "next_page", limitationReason: "unknown" };
  }
  if (state.nextPageDisabled === true) {
    return state.reportedTotalRows === null || reportedTotalMatches
      ? { action: "complete", limitationReason: "query_finished" }
      : { action: "stop", status: "PARTIAL", limitationReason: "unknown" };
  }
  if (state.scrollTarget && state.scrollHeight <= state.clientHeight) {
    return reportedTotalMatches
      ? { action: "complete", limitationReason: "query_finished" }
      : { action: "stop", status: "PARTIAL", limitationReason: "unknown" };
  }
  if (state.scrollTarget && state.scrollY + state.clientHeight >= state.scrollHeight - 1) {
    return reportedTotalMatches
      ? { action: "complete", limitationReason: "query_finished" }
      : { action: "stop", status: "PARTIAL", limitationReason: "unknown" };
  }
  if (budgetExhausted) return { action: "stop", status: "PARTIAL", limitationReason: "budget_stop" };
  return { action: "stop", status: "PARTIAL", limitationReason: "unknown" };
}
