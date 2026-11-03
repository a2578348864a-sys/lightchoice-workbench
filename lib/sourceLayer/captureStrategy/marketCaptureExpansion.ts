import {
  deriveSearchPages,
  HARD_MAX_AUTHORIZED_ITEMS,
  HARD_MAX_SEARCH_PAGES,
} from "@/lib/sourceLayer/captureBudgetConstants";

export type MarketCaptureExpansionRunStatus =
  | "WAITING"
  | "RUNNING"
  | "PARTIAL"
  | "HUMAN_REQUIRED"
  | "COMPLETED"
  | "PAUSED"
  | "FAILED"
  | "CANCELLED";

export type MarketCaptureExpansionBlocker =
  | "run_missing"
  | "run_state_unknown"
  | "run_still_running"
  | "executor_not_confirmed_stopped"
  | "target_below_current_scope"
  | "target_not_greater_than_current"
  | "target_limit_exceeded"
  | "search_navigation_unknown"
  | "search_page_budget_exceeded"
  | "search_page_budget_exhausted"
  | "expansion_in_progress"
  | null;

export type MarketCaptureExpansionPreview = {
  batchId: string;
  currentItemCount: number;
  currentAuthorizedItemCount: number;
  targetTotal: number;
  maxAdditionalSearchCount: number;
  plannedAdditionalAuthorizationCount: number;
  searchNavigationUsed: number;
  searchNavigationKnown: boolean;
  searchStartPage: number;
  searchPageCount: number;
  searchPagesRemaining: number;
  validEvidenceCount: number;
  detailCompletedCount: number;
  runId: string | null;
  runGeneration: number | null;
  runVersion: number | null;
  runStatus: MarketCaptureExpansionRunStatus | null;
  expansionInProgress: boolean;
  canConfirm: boolean;
  blocker: MarketCaptureExpansionBlocker;
  planFingerprint: string;
};

export function deriveMarketCaptureExpansionCounts(input: {
  currentAsins: readonly string[];
  authorizedAsins: readonly string[];
  targetTotal: number;
  searchNavigationUsed: number | null;
  validEvidenceCount: number;
  detailCompletedAsins: readonly string[];
  run: {
    runId: string;
    runGeneration: number;
    version: number;
    status: MarketCaptureExpansionRunStatus;
    executionEpoch: number;
    acknowledgedEpoch: number;
    leaseOwner: string | null;
    leaseExpiresAt: string | null;
    expansionInProgress?: boolean;
  } | null;
  now?: number;
}): Omit<MarketCaptureExpansionPreview, "batchId" | "planFingerprint"> {
  const currentAsins = [...new Set(input.currentAsins.map((asin) => asin.trim().toUpperCase()).filter(Boolean))];
  const authorizedAsins = [...new Set(input.authorizedAsins.map((asin) => asin.trim().toUpperCase()).filter(Boolean))];
  const currentItemCount = currentAsins.length;
  const currentAuthorizedItemCount = authorizedAsins.length;
  const targetTotal = input.targetTotal;
  const maxAdditionalSearchCount = Math.max(0, targetTotal - currentItemCount);
  const plannedAdditionalAuthorizationCount = Math.max(0, targetTotal - currentAuthorizedItemCount);
  const searchNavigationKnown = input.searchNavigationUsed !== null;
  const searchNavigationUsed = input.searchNavigationUsed ?? 0;
  const searchStartPage = searchNavigationUsed + 1;
  const searchPageCount = maxAdditionalSearchCount > 0 ? deriveSearchPages(maxAdditionalSearchCount) : 0;
  const searchPagesRemaining = Math.max(0, HARD_MAX_SEARCH_PAGES - searchNavigationUsed);
  const run = input.run;
  const activeLease = Boolean(run?.leaseOwner && run.leaseExpiresAt
    && Date.parse(run.leaseExpiresAt) > (input.now ?? Date.now()));
  const executorUnconfirmed = Boolean(run && (run.executionEpoch > run.acknowledgedEpoch || activeLease));

  let blocker: MarketCaptureExpansionBlocker = null;
  if (!run) blocker = "run_missing";
  else if (run.expansionInProgress) blocker = "expansion_in_progress";
  else if (run.status === "RUNNING" || run.status === "WAITING") blocker = "run_still_running";
  else if (executorUnconfirmed) blocker = "executor_not_confirmed_stopped";
  else if (targetTotal < Math.max(currentItemCount, currentAuthorizedItemCount)) blocker = "target_below_current_scope";
  else if (targetTotal === currentItemCount) blocker = "target_not_greater_than_current";
  else if (!Number.isSafeInteger(targetTotal) || targetTotal < 1 || targetTotal > HARD_MAX_AUTHORIZED_ITEMS) blocker = "target_limit_exceeded";
  else if (!searchNavigationKnown) blocker = "search_navigation_unknown";
  else if (searchPageCount > searchPagesRemaining) blocker = "search_page_budget_exceeded";
  else if (maxAdditionalSearchCount > 0 && searchPagesRemaining === 0) blocker = "search_page_budget_exhausted";

  return {
    currentItemCount,
    currentAuthorizedItemCount,
    targetTotal,
    maxAdditionalSearchCount,
    plannedAdditionalAuthorizationCount,
    searchNavigationUsed,
    searchNavigationKnown,
    searchStartPage,
    searchPageCount,
    searchPagesRemaining,
    validEvidenceCount: Math.max(0, input.validEvidenceCount),
    detailCompletedCount: new Set(input.detailCompletedAsins.map((asin) => asin.toUpperCase())).size,
    runId: run?.runId ?? null,
    runGeneration: run?.runGeneration ?? null,
    runVersion: run?.version ?? null,
    runStatus: run?.status ?? null,
    expansionInProgress: run?.expansionInProgress === true,
    canConfirm: blocker === null,
    blocker,
  };
}
