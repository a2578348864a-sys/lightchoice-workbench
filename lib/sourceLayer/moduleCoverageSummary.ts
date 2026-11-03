import type { ProductModuleStatus } from "@/lib/sourceLayer/moduleStatusPresentation";

/**
 * Presentation-only derivation of per-module capture coverage.
 *
 * The core distinction: "executed" (the system tried, possibly with only an
 * attempt receipt) is NOT the same as "has evidence" (a real EvidenceStore
 * attachment exists). A module that was executed but produced no evidence must
 * never be presented as captured data.
 */

/** Minimal structural shape of one product's module coverage entry. */
export type ModuleCoverageEntryLike = {
  module: string;
  label: string;
  status: ProductModuleStatus;
  evidenceId: string | null;
  latestAttempt: unknown;
};

export type ModuleCoverageItemLike = {
  moduleCoverage?: ModuleCoverageEntryLike[];
};

/** Statuses that represent an external/human condition rather than captured data. */
export const MODULE_HUMAN_STATUSES: ProductModuleStatus[] = [
  "HUMAN_ACTION_REQUIRED",
  "FAILED_HUMAN",
  "LOGIN_REQUIRED",
  "EXTENSION_REQUIRED",
  "PLAN_LIMITED",
];

/** A module was executed when it is not NOT_COLLECTED, or it recorded an attempt (receipt). */
export function moduleWasExecuted(entry?: ModuleCoverageEntryLike): boolean {
  return Boolean(entry && (entry.status !== "NOT_COLLECTED" || entry.latestAttempt));
}

/** A module obtained data only when it carries a real EvidenceStore attachment ID. */
export function moduleHasEvidence(entry?: ModuleCoverageEntryLike): boolean {
  return Boolean(entry?.evidenceId);
}

export type ModuleCoverageSummaryEntry = {
  module: string;
  label: string;
  itemCount: number;
  executedCount: number;
  evidenceCount: number;
  receiptOnlyCount: number;
  completeCount: number;
  partialCount: number;
  noDataCount: number;
  limitedCount: number;
  blockedCount: number;
  humanActionCount: number;
  notCollectedCount: number;
};

export function summarizeSourceModuleCoverage(items: readonly ModuleCoverageItemLike[]): ModuleCoverageSummaryEntry[] {
  const modules = items.find((item) => item.moduleCoverage?.length)?.moduleCoverage ?? [];
  return modules.map((module) => {
    const forModule = items.map((item) => item.moduleCoverage?.find((entry) => entry.module === module.module));
    return {
      module: module.module,
      label: module.label,
      itemCount: items.length,
      executedCount: forModule.filter(moduleWasExecuted).length,
      evidenceCount: forModule.filter(moduleHasEvidence).length,
      receiptOnlyCount: forModule.filter((entry) => moduleWasExecuted(entry) && !moduleHasEvidence(entry)).length,
      completeCount: forModule.filter((entry) => entry?.status === "COMPLETE").length,
      partialCount: forModule.filter((entry) => entry?.status === "CAPTURED_PARTIAL").length,
      noDataCount: forModule.filter((entry) => entry?.status === "NO_DATA_WITH_EVIDENCE").length,
      limitedCount: forModule.filter((entry) => entry?.status === "AVAILABLE_WITH_LIMITATION").length,
      blockedCount: forModule.filter((entry) => entry?.status === "BLOCKED_WITH_EVIDENCE").length,
      humanActionCount: forModule.filter((entry) => Boolean(entry && MODULE_HUMAN_STATUSES.includes(entry.status))).length,
      notCollectedCount: forModule.filter((entry) => !moduleWasExecuted(entry)).length,
    };
  });
}

export type ModuleCoverageTotals = {
  moduleCount: number;
  totalCells: number;
  executedModules: number;
  evidenceModules: number;
  evidenceCells: number;
  receiptOnlyModules: number;
  receiptOnlyCells: number;
};

export function summarizeModuleCoverageTotals(summary: readonly ModuleCoverageSummaryEntry[]): ModuleCoverageTotals {
  return {
    moduleCount: summary.length,
    totalCells: summary.reduce((sum, entry) => sum + entry.itemCount, 0),
    executedModules: summary.filter((entry) => entry.executedCount > 0).length,
    evidenceModules: summary.filter((entry) => entry.evidenceCount > 0).length,
    evidenceCells: summary.reduce((sum, entry) => sum + entry.evidenceCount, 0),
    receiptOnlyModules: summary.filter((entry) => entry.receiptOnlyCount > 0).length,
    receiptOnlyCells: summary.reduce((sum, entry) => sum + entry.receiptOnlyCount, 0),
  };
}
