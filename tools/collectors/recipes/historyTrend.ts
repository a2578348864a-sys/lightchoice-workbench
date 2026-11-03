/**
 * 这个旧入口只处理“来源选择决定”审计，不伪造趋势点。
 * Capture System V3 的正式历史采集入口是
 * `POST /api/source-layer/acquire/browser-visible`：当前账号可见的
 * DOM/图表/Tooltip 证据在该入口进入同一 EvidenceStore；没有真实时序点时，
 * 本入口仍然 fail-closed，不把截图或模型推断升级为结构化趋势。
 */

export type HistoryTrendSourceCandidate = {
  sourceId: string;
  sourceType: "official_api" | "official_export" | "manual";
  reliable: boolean;
  hasStructuredTimeSeries: boolean;
};

export type HistoryTrendDecision =
  | {
    status: "ready";
    code: "RELIABLE_SOURCE_AVAILABLE";
    sourceId: string;
    decidedAt: string;
  }
  | {
    status: "blocked";
    code: "NO_RELIABLE_SOURCE_IN_REPO";
    reason: string;
    decidedAt: string;
    candidates: ReadonlyArray<HistoryTrendSourceCandidate>;
  };

export function decideHistoryTrendSource(input: {
  candidates?: ReadonlyArray<HistoryTrendSourceCandidate>;
  decidedAt?: string;
}): HistoryTrendDecision {
  const decidedAt = input.decidedAt && !Number.isNaN(Date.parse(input.decidedAt))
    ? input.decidedAt
    : new Date().toISOString();
  const candidates = (input.candidates ?? []).filter((candidate) => (
    typeof candidate.sourceId === "string"
    && candidate.sourceId.trim().length > 0
    && (candidate.sourceType === "official_api" || candidate.sourceType === "official_export" || candidate.sourceType === "manual")
  ));
  const reliable = candidates.find((candidate) => candidate.reliable && candidate.hasStructuredTimeSeries);
  if (reliable) {
    return {
      status: "ready",
      code: "RELIABLE_SOURCE_AVAILABLE",
      sourceId: reliable.sourceId,
      decidedAt,
    };
  }
  return {
    status: "blocked",
    code: "NO_RELIABLE_SOURCE_IN_REPO",
    reason: "当前仓库没有可验证、结构化、可追溯的历史时序来源；不使用 OCR、截图推断或 AI 补齐趋势。",
    decidedAt,
    candidates,
  };
}
