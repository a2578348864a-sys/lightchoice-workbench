export type WorkspaceCountSummary = {
  readonly source?: { readonly batchCount?: number; readonly itemCount?: number };
  readonly market?: { readonly scanCount?: number; readonly sampleCount?: number };
  readonly research?: { readonly taskCount?: number; readonly pendingCandidateCount?: number };
  readonly counts?: {
    readonly sourceBatches?: number;
    readonly sourceItems?: number;
    readonly marketScans?: number;
    readonly marketSamples?: number;
    readonly researchTotal?: number;
    readonly researchNeedsChoice?: number;
    readonly researchInProgress?: number;
    readonly choiceProceed?: number;
    readonly choiceWatch?: number;
    readonly choiceDrop?: number;
  };
  readonly pipeline?: {
    readonly source?: { readonly totalBatches?: number; readonly totalItems?: number };
    readonly market?: { readonly totalScans?: number; readonly totalSamples?: number };
    readonly research?: { readonly inProgress?: number; readonly needsChoice?: number };
    readonly choices?: { readonly proceed?: number; readonly watch?: number; readonly drop?: number };
  };
};

export type WorkspaceCounts = {
  readonly sourceBatches: number;
  readonly sourceItems: number;
  readonly marketScans: number;
  readonly marketSamples: number;
  readonly researchTotal: number;
  readonly researchInProgress: number;
  readonly researchNeedsDecision: number;
  readonly choiceProceed: number;
  readonly choiceWatch: number;
  readonly choiceDrop: number;
};

/** One consumer contract for Home and Sidebar; legacy ambiguous counters are intentionally ignored. */
export function projectWorkspaceCounts(data: WorkspaceCountSummary | null | undefined): WorkspaceCounts {
  return {
    sourceBatches: count(data?.counts?.sourceBatches, data?.pipeline?.source?.totalBatches, data?.source?.batchCount),
    sourceItems: count(data?.counts?.sourceItems, data?.pipeline?.source?.totalItems, data?.source?.itemCount),
    marketScans: count(data?.counts?.marketScans, data?.pipeline?.market?.totalScans, data?.market?.scanCount),
    marketSamples: count(data?.counts?.marketSamples, data?.pipeline?.market?.totalSamples, data?.market?.sampleCount),
    researchTotal: count(data?.counts?.researchTotal, data?.research?.taskCount),
    researchInProgress: count(data?.counts?.researchInProgress, data?.pipeline?.research?.inProgress),
    researchNeedsDecision: count(data?.counts?.researchNeedsChoice, data?.pipeline?.research?.needsChoice),
    choiceProceed: count(data?.counts?.choiceProceed, data?.pipeline?.choices?.proceed),
    choiceWatch: count(data?.counts?.choiceWatch, data?.pipeline?.choices?.watch),
    choiceDrop: count(data?.counts?.choiceDrop, data?.pipeline?.choices?.drop),
  };
}

function count(...values: Array<number | undefined>): number {
  const value = values.find((candidate) => typeof candidate === "number" && Number.isFinite(candidate));
  return value === undefined ? 0 : Math.max(0, Math.floor(value));
}
