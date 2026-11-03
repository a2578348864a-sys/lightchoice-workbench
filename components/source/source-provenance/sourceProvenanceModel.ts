/**
 * T04 · 资料与来源的纯展示投影。
 *
 * 两个口径必须始终分开：
 * - 本轮运行口径：BatchCaptureRun 的商品处理 x/y、资料证据 x/y 单元（来自 T03 快照）；
 * - 批次覆盖口径：按商品 × 模块的 evidenceCount/itemCount（可能包含历史复用）。
 * 本层不合并、不重算、不生成假时间线；没有真实时间戳就返回空事件。
 */
import type { ModuleCoverageSummaryEntry, ModuleCoverageTotals } from "@/lib/sourceLayer/moduleCoverageSummary";
import type { ProductModuleStatus } from "@/lib/sourceLayer/moduleStatusPresentation";
import type { BatchCaptureRunSnapshot } from "@/lib/sourceLayer/batchCaptureRunSnapshot";
import { MODULE_STATUS_LABELS, moduleAttemptMessage } from "@/components/source/batch-workspace/modulePresentation";

export type ProvenanceItemModule = {
  module: string;
  label: string;
  status: ProductModuleStatus;
  capturedAt: string | null;
  evidenceId: string | null;
  contentHash: string | null;
  limitations: string[];
  errorCode: string | null;
  retryable: boolean | null;
  latestAttempt: {
    status: string;
    message: string;
    errorCode: string | null;
    attemptedAt: string;
  } | null;
};

export type ProvenanceItem = {
  id: string;
  asin: string;
  title?: string | null;
  archivedAt?: string | null;
  evidenceRefs?: string[];
  moduleCoverage?: ProvenanceItemModule[];
};

export const PROVENANCE_BASIC_MODULES = [
  "amazon_detail",
  "amazon_search_market",
  "variation",
  "review_voc",
] as const;

export const PROVENANCE_SUPPLEMENTARY_MODULES = [
  "sellersprite_product_market",
  "reverse_asin",
  "keyword_mining_trend",
  "historical_trend",
] as const;

export const PROVENANCE_MODULE_LABELS: Record<string, string> = {
  amazon_detail: "Amazon 商品详情",
  amazon_search_market: "Amazon 搜索市场",
  variation: "父子变体",
  review_voc: "评论与买家声音",
  sellersprite_product_market: "卖家精灵商品市场",
  reverse_asin: "反查 ASIN",
  keyword_mining_trend: "关键词挖掘与趋势",
  historical_trend: "历史趋势",
};

export const PROVENANCE_BATCH_STATUS_LABELS: Record<string, string> = {
  ready: "可执行",
  processing: "处理中",
  blocked: "受阻",
  invalid: "无效",
  not_created: "未创建",
  archived: "已归档",
};

export type CoverageRowStatus =
  | "complete"
  | "partial"
  | "limited"
  | "human"
  | "blocked"
  | "receipt_only"
  | "not_collected"
  | "not_in_scope"
  | "scope_unknown";

export type ProvenanceCoverageRow = {
  module: string;
  label: string;
  basic: boolean;
  itemCount: number;
  evidenceCount: number;
  executedCount: number;
  percent: number;
  status: CoverageRowStatus;
  statusLabel: string;
  tone: "ok" | "warn" | "fail" | "off";
  counts: {
    complete: number;
    partial: number;
    noData: number;
    limited: number;
    blocked: number;
    human: number;
    notCollected: number;
    receiptOnly: number;
  };
  note: string | null;
};

const EMPTY_ENTRY = (module: string, itemCount: number): ModuleCoverageSummaryEntry => ({
  module,
  label: PROVENANCE_MODULE_LABELS[module] ?? module,
  itemCount,
  executedCount: 0,
  evidenceCount: 0,
  receiptOnlyCount: 0,
  completeCount: 0,
  partialCount: 0,
  noDataCount: 0,
  limitedCount: 0,
  blockedCount: 0,
  humanActionCount: 0,
  notCollectedCount: itemCount,
});

function rowStatus(
  entry: ModuleCoverageSummaryEntry,
  basic: boolean,
  runScopeKnown: boolean,
  allowedModules: readonly string[] | null,
): { status: CoverageRowStatus; label: string; tone: ProvenanceCoverageRow["tone"]; note: string | null } {
  if (!basic && runScopeKnown && allowedModules && !allowedModules.includes(entry.module)) {
    return {
      status: "not_in_scope",
      label: "未纳入本轮",
      tone: "off",
      note: "补充来源需在采集计划中单独授权",
    };
  }
  if (entry.itemCount > 0 && entry.notCollectedCount === entry.itemCount) {
    return { status: "not_collected", label: "未采集", tone: "off", note: "尚未采集该类资料" };
  }
  if (entry.limitedCount > 0) {
    return { status: "limited", label: "受限", tone: "warn", note: "存在来源或页面限制" };
  }
  if (entry.humanActionCount > 0) {
    return { status: "human", label: "需人工", tone: "warn", note: "存在需要人工处理的单元" };
  }
  if (entry.blockedCount > 0) {
    return { status: "blocked", label: "受阻", tone: "fail", note: "存在受阻单元" };
  }
  if (entry.partialCount > 0 || entry.noDataCount > 0) {
    return { status: "partial", label: "部分完成", tone: "warn", note: "存在部分完成或无有效字段的单元" };
  }
  if (entry.evidenceCount === entry.itemCount && entry.completeCount === entry.itemCount) {
    return { status: "complete", label: "完整", tone: "ok", note: null };
  }
  if (entry.evidenceCount > 0) {
    return { status: "partial", label: "部分有证据", tone: "warn", note: "只有部分商品取得了证据" };
  }
  if (entry.receiptOnlyCount > 0) {
    return { status: "receipt_only", label: "仅回执", tone: "warn", note: "执行过，但没有证据附件" };
  }
  return {
    status: runScopeKnown ? "not_collected" : "scope_unknown",
    label: runScopeKnown ? "未采集" : "范围未知",
    tone: "off",
    note: runScopeKnown ? "尚未采集该类资料" : "本轮运行范围尚未读取",
  };
}

/** 固定八模块顺序：基础 4 类在前，补充 4 类在后；缺失模块补 0 行，不从列表消失。 */
export function buildCoverageRows(input: {
  summary: readonly ModuleCoverageSummaryEntry[];
  activeItemCount: number;
  runScopeKnown: boolean;
  allowedModules: readonly string[] | null;
}): { basic: ProvenanceCoverageRow[]; supplementary: ProvenanceCoverageRow[] } {
  const byModule = new Map(input.summary.map((entry) => [entry.module, entry]));
  const build = (module: string, basic: boolean): ProvenanceCoverageRow => {
    const entry = byModule.get(module) ?? EMPTY_ENTRY(module, input.activeItemCount);
    const state = rowStatus(entry, basic, input.runScopeKnown, input.allowedModules);
    return {
      module,
      label: PROVENANCE_MODULE_LABELS[module] ?? entry.label,
      basic,
      itemCount: entry.itemCount,
      evidenceCount: entry.evidenceCount,
      executedCount: entry.executedCount,
      percent: entry.itemCount > 0 ? Math.round((entry.evidenceCount / entry.itemCount) * 100) : 0,
      status: state.status,
      statusLabel: state.label,
      tone: state.tone,
      counts: {
        complete: entry.completeCount,
        partial: entry.partialCount,
        noData: entry.noDataCount,
        limited: entry.limitedCount,
        blocked: entry.blockedCount,
        human: entry.humanActionCount,
        notCollected: entry.notCollectedCount,
        receiptOnly: entry.receiptOnlyCount,
      },
      note: state.note,
    };
  };
  return {
    basic: PROVENANCE_BASIC_MODULES.map((module) => build(module, true)),
    supplementary: PROVENANCE_SUPPLEMENTARY_MODULES.map((module) => build(module, false)),
  };
}

export function formatProvenanceDateTime(value: string | null | undefined): string {
  if (!value) return "时间未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未记录";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatProvenanceShortTime(value: string | null | undefined): string {
  if (!value) return "时间未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未记录";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function latestEvidenceAt(items: readonly ProvenanceItem[]): string | null {
  let latest: number | null = null;
  for (const item of items) {
    if (item.archivedAt) continue;
    for (const entry of item.moduleCoverage ?? []) {
      if (!entry.capturedAt) continue;
      const ms = Date.parse(entry.capturedAt);
      if (Number.isFinite(ms) && (latest === null || ms > latest)) latest = ms;
    }
  }
  return latest === null ? null : new Date(latest).toISOString();
}

export type ProvenanceProblemChip = {
  key: string;
  label: string;
  tone: "warn" | "fail" | "off";
  detail: string;
};

export type BatchProvenanceSummary = {
  totalItems: number;
  activeItems: number;
  archivedItems: number;
  moduleCount: number;
  evidenceModules: number;
  evidenceCells: number;
  totalCells: number;
  lastEvidenceAt: string | null;
  lastEvidenceLabel: string;
  runScope: {
    known: boolean;
    label: string;
    detail: string | null;
    tone: "ok" | "warn" | "fail" | "off";
  };
  problemChips: ProvenanceProblemChip[];
  hasProblems: boolean;
  scopeNote: string;
};

export function buildBatchProvenanceSummary(input: {
  items: readonly ProvenanceItem[];
  summary: readonly ModuleCoverageSummaryEntry[];
  totals: ModuleCoverageTotals;
  rows: { basic: ProvenanceCoverageRow[]; supplementary: ProvenanceCoverageRow[] };
  captureRunSnapshot?: BatchCaptureRunSnapshot | null;
}): BatchProvenanceSummary {
  const active = input.items.filter((item) => !item.archivedAt);
  const last = latestEvidenceAt(input.items);
  const snapshot = input.captureRunSnapshot;

  let runScope: BatchProvenanceSummary["runScope"];
  if (snapshot?.state === "present") {
    const progress = snapshot.view.progress;
    runScope = {
      known: true,
      label: `本轮运行 商品处理 ${progress.uniqueItemsVisited}/${progress.itemsInBatch} · 资料证据 ${progress.validEvidenceCells}/${progress.totalCells} 单元`,
      detail: snapshot.view.statusLabel,
      tone: snapshot.view.tone === "rose" ? "fail" : snapshot.view.tone === "amber" ? "warn" : "ok",
    };
  } else if (snapshot?.state === "absent") {
    runScope = { known: false, label: "本轮没有自动采集运行", detail: "已成功读取，确认无运行", tone: "off" };
  } else if (snapshot?.state === "error") {
    runScope = { known: false, label: "本轮运行状态读取失败", detail: "读取失败不是无任务", tone: "fail" };
  } else if (snapshot?.state === "created") {
    runScope = { known: false, label: "本轮任务已创建，状态读取中", detail: null, tone: "warn" };
  } else {
    runScope = { known: false, label: "本轮运行状态尚未读取", detail: null, tone: "off" };
  }

  const allRows = [...input.rows.basic, ...input.rows.supplementary];
  const chips: ProvenanceProblemChip[] = [];
  const add = (key: string, label: string, tone: ProvenanceProblemChip["tone"], modules: string[]) => {
    if (modules.length === 0) return;
    chips.push({ key, label: `${label} ${modules.length} 类`, tone, detail: modules.join("、") });
  };
  add("partial", "部分完成", "warn", allRows.filter((row) => row.counts.partial > 0 || row.counts.noData > 0).map((row) => row.label));
  add("limited", "受限", "warn", allRows.filter((row) => row.counts.limited > 0).map((row) => row.label));
  add("human", "需人工", "warn", allRows.filter((row) => row.counts.human > 0).map((row) => row.label));
  add("blocked", "受阻", "fail", allRows.filter((row) => row.counts.blocked > 0).map((row) => row.label));
  add("not_collected", "未采集", "off", allRows.filter((row) => row.status === "not_collected").map((row) => row.label));
  add("not_in_scope", "未纳入本轮", "off", allRows.filter((row) => row.status === "not_in_scope").map((row) => row.label));

  const scopeNote = snapshot?.state === "present"
    ? `105/120 是本轮运行单元口径；${input.totals.evidenceCells}/${input.totals.totalCells} 是按商品×模块的覆盖口径（含历史复用）。两者不能直接比较。`
    : snapshot?.state === "absent"
      ? `本轮没有自动采集运行；${input.totals.evidenceCells}/${input.totals.totalCells} 是按商品×模块的覆盖口径（含历史复用），不代表本轮运行证据单元。`
      : snapshot?.state === "error"
        ? `本轮运行状态读取失败，不能当作无任务；${input.totals.evidenceCells}/${input.totals.totalCells} 是按商品×模块的覆盖口径（含历史复用）。`
        : `本轮运行口径尚未读取；${input.totals.evidenceCells}/${input.totals.totalCells} 是按商品×模块的覆盖口径（含历史复用），不代表本轮运行证据单元。`;

  return {
    totalItems: input.items.length,
    activeItems: active.length,
    archivedItems: input.items.length - active.length,
    moduleCount: 8,
    evidenceModules: input.summary.filter((entry) => entry.evidenceCount > 0).length,
    evidenceCells: input.totals.evidenceCells,
    totalCells: input.totals.totalCells,
    lastEvidenceAt: last,
    lastEvidenceLabel: last ? formatProvenanceDateTime(last) : "暂无有依据的更新时间",
    runScope,
    problemChips: chips,
    hasProblems: chips.length > 0,
    scopeNote,
  };
}

export type ProvenanceEvent = {
  id: string;
  at: string;
  tone: "ok" | "warn" | "fail" | "info";
  title: string;
  detail: string;
  module: string;
  itemId: string;
  asin: string;
  evidenceId: string | null;
  canViewEvidence: boolean;
};

const HUMAN_STATUSES: ReadonlySet<ProductModuleStatus> = new Set([
  "HUMAN_ACTION_REQUIRED",
  "FAILED_HUMAN",
  "LOGIN_REQUIRED",
  "EXTENSION_REQUIRED",
  "PLAN_LIMITED",
]);

/** 只从真实 capturedAt / attemptedAt 生成事件；同一模块同一商品取较新的那个。 */
export function buildProvenanceTimeline(
  items: readonly ProvenanceItem[],
  limit = 8,
): { events: ProvenanceEvent[]; total: number } {
  const events: ProvenanceEvent[] = [];
  for (const item of items) {
    if (item.archivedAt) continue;
    for (const entry of item.moduleCoverage ?? []) {
      const capturedMs = entry.capturedAt ? Date.parse(entry.capturedAt) : Number.NaN;
      const attemptedMs = entry.latestAttempt?.attemptedAt ? Date.parse(entry.latestAttempt.attemptedAt) : Number.NaN;
      const capturedValid = Number.isFinite(capturedMs);
      const attemptedValid = Number.isFinite(attemptedMs);
      const moduleLabel = PROVENANCE_MODULE_LABELS[entry.module] ?? entry.label ?? entry.module;

      if (capturedValid && (!attemptedValid || capturedMs >= attemptedMs)) {
        events.push({
          id: `${item.id}:${entry.module}:captured:${entry.capturedAt}`,
          at: entry.capturedAt as string,
          tone: "ok",
          title: "已保存证据",
          detail: `${moduleLabel} · ${item.asin}`,
          module: entry.module,
          itemId: item.id,
          asin: item.asin,
          evidenceId: entry.evidenceId,
          canViewEvidence: Boolean(entry.evidenceId),
        });
        continue;
      }

      if (attemptedValid) {
        const attempt = entry.latestAttempt!;
        const human = HUMAN_STATUSES.has(entry.status);
        const failed = attempt.status === "failed" || Boolean(attempt.errorCode);
        events.push({
          id: `${item.id}:${entry.module}:attempt:${attempt.attemptedAt}`,
          at: attempt.attemptedAt,
          tone: human ? "warn" : failed ? "fail" : "info",
          title: human ? "需要人工处理" : failed ? "采集尝试未完成" : "采集尝试记录",
          detail: `${moduleLabel} · ${item.asin} · ${moduleAttemptMessage(attempt.message, attempt.errorCode)}`,
          module: entry.module,
          itemId: item.id,
          asin: item.asin,
          evidenceId: entry.evidenceId,
          canViewEvidence: Boolean(entry.evidenceId),
        });
      }
    }
  }
  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { events: events.slice(0, limit), total: events.length };
}

/** 供面板显示模块状态中文；不在本层改状态。 */
export function moduleStatusLabel(status: ProductModuleStatus): string {
  return MODULE_STATUS_LABELS[status] ?? status;
}
