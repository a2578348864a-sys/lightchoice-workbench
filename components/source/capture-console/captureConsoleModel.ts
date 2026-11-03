/**
 * T03 采集控制台 · 纯展示投影（presentation-only）。
 *
 * 纪律：
 * 1) 所有数字都来自 BatchCaptureRunPresentation / BatchCaptureRun；本层只做命名、
 *    分组、状态词与文案，不新增计数、不推断缺失值、不生成 ETA。
 * 2) 「商品处理」与「资料证据」是两个口径，永远分开显示；
 *    处理 30/30 ≠ 证据 100%。
 * 3) 模块行按「有效证据 x / 该模块商品数」展示，四行基础能力之和与资料证据环同口径。
 * 4) 动作只反映 view.actions；本层不创造「看起来能点」的按钮。
 */
import type {
  BatchCaptureModuleRow,
  BatchCaptureRunPresentation,
  BatchCaptureRunStatus,
  BatchCaptureRunTone,
  BatchCaptureRunView,
} from "@/lib/sourceLayer/batchCaptureRunPresentation";

export type ConsoleIconName =
  | "search"
  | "detail"
  | "variation"
  | "review"
  | "market"
  | "reverse"
  | "keyword"
  | "trend";

export type ConsoleTone = "ok" | "run" | "warn" | "fail" | "idle";
export type ConsoleProgressState = "running" | "paused" | "blocked" | "completed" | "partial" | "idle";
export type ConsoleCapabilityTone = "done" | "run" | "queued" | "partial" | "failed" | "locked" | "human";

export type ConsoleScrollTarget = "issues" | "gaps" | "advanced" | "recovery" | "plan";

export type ConsoleIssueAction =
  | { kind: "scroll"; label: string; target: ConsoleScrollTarget }
  | { kind: "retry"; label: string }
  | { kind: "resume"; label: string };

export type ConsoleIssue = {
  id: string;
  tone: "warn" | "fail" | "info";
  title: string;
  description: string;
  action: ConsoleIssueAction | null;
};

export type ConsoleCapability = {
  module: string;
  name: string;
  icon: ConsoleIconName;
  /** 本轮计划是否授权该模块（来自 run.allowedModules）。 */
  allowed: boolean;
  tone: ConsoleCapabilityTone;
  stateLabel: string;
  /** 有效证据数（与资料证据环同口径）。 */
  evidenceCount: number;
  total: number;
  percent: number;
  /** 「完整 18 · 部分 12」这类二级事实。 */
  detail: string | null;
  /** 需要关注的一行，例如「10 件失败」。 */
  problem: string | null;
};

export type ConsoleHero = {
  tone: ConsoleTone;
  progressState: ConsoleProgressState;
  statusLabel: string;
  title: string;
  subtitle: string;
  suggestion: string | null;
  issueCount: number;
  issueLabel: string | null;
  runLabel: string | null;
  updatedLabel: string | null;
};

export type ConsoleProgress = {
  value: number;
  total: number;
  percent: number;
  state: ConsoleProgressState;
  stateWord: string;
  updatedLabel: string | null;
};

export type ConsoleEvidence = {
  value: number;
  total: number;
  percent: number;
  failed: number;
  partial: number;
};

export type ConsoleSample = {
  current: number | null;
  required: number;
  sufficient: boolean | null;
  label: string;
  note: string;
};

export type ConsolePlan = {
  scope: string;
  authorized: string;
  navigation: string;
  navigationDetail: string | null;
};

export type ConsoleModel = {
  hasRun: boolean;
  hero: ConsoleHero;
  progress: ConsoleProgress;
  evidence: ConsoleEvidence;
  sample: ConsoleSample;
  basic: ConsoleCapability[];
  supplementary: ConsoleCapability[];
  basicSummary: string;
  supplementarySummary: string;
  issues: ConsoleIssue[];
  plan: ConsolePlan;
  /** 无运行时给计划面板的引导文案。 */
  noRunGuidance: { title: string; body: string; planHint: string } | null;
};

type ModuleMeta = { name: string; icon: ConsoleIconName; basic: boolean };

/** 面板内使用的短名称；技术全名保留在高级信息（moduleMatrix.label）。 */
const MODULE_META: Record<string, ModuleMeta> = {
  amazon_search_market: { name: "Amazon 搜索", icon: "search", basic: true },
  amazon_detail: { name: "Amazon 详情", icon: "detail", basic: true },
  variation: { name: "父子变体", icon: "variation", basic: true },
  review_voc: { name: "评论 / 买家声音", icon: "review", basic: true },
  sellersprite_product_market: { name: "卖家精灵市场", icon: "market", basic: false },
  reverse_asin: { name: "反查 ASIN", icon: "reverse", basic: false },
  keyword_mining_trend: { name: "关键词挖掘", icon: "keyword", basic: false },
  historical_trend: { name: "历史趋势", icon: "trend", basic: false },
};

const BASIC_ORDER = ["amazon_detail", "variation", "review_voc", "amazon_search_market"] as const;
const SUPPLEMENTARY_ORDER = [
  "sellersprite_product_market",
  "reverse_asin",
  "keyword_mining_trend",
  "historical_trend",
] as const;

const STATUS_TONE: Record<BatchCaptureRunStatus, ConsoleTone> = {
  WAITING: "run",
  RUNNING: "run",
  PARTIAL: "warn",
  HUMAN_REQUIRED: "warn",
  COMPLETED: "ok",
  PAUSED: "warn",
  FAILED: "fail",
  CANCELLED: "idle",
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 快照时间：当天只显示 HH:mm，跨天显示 M/D HH:mm；无值返回 null（不编造）。 */
export function formatSnapshotTime(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return sameDay ? clock : `${date.getMonth() + 1}/${date.getDate()} ${clock}`;
}

export function formatSnapshotClock(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function percentOf(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function progressStateOf(status: BatchCaptureRunStatus | null, executorUnknown: boolean): ConsoleProgressState {
  if (!status) return "idle";
  if (executorUnknown) return "blocked";
  if (status === "RUNNING" || status === "WAITING") return "running";
  if (status === "PAUSED" || status === "HUMAN_REQUIRED") return "paused";
  if (status === "COMPLETED") return "completed";
  if (status === "PARTIAL") return "partial";
  return "blocked";
}

function capabilityState(
  row: BatchCaptureModuleRow,
  allowed: boolean,
): { tone: ConsoleCapabilityTone; label: string } {
  if (!allowed) return { tone: "locked", label: "未授权" };
  if (row.wiring === "not_wired") return { tone: "locked", label: "未接入" };
  if (row.wiring === "source_permission") return { tone: "locked", label: "来源受限" };
  if (!row.executed) return { tone: "queued", label: "未执行" };
  if (row.itemsHuman > 0) return { tone: "human", label: "需人工" };
  if (row.handlingLabel === "进行中") return { tone: "run", label: "进行中" };
  if (row.handlingLabel === "执行结束") {
    // 搜索阶段没有「字段完整」概念，用失败/部分判断即可。
    if (row.wiring === "search_phase") {
      return row.itemsFailed > 0
        ? { tone: "partial", label: "部分完成" }
        : { tone: "done", label: "已完成" };
    }
    if (row.itemsFailed > 0) {
      return row.validEvidenceCount > 0
        ? { tone: "partial", label: "部分完成" }
        : { tone: "failed", label: "失败" };
    }
    if (row.itemsPartial > 0 || row.itemsFieldComplete < row.itemsTotal) {
      return { tone: "partial", label: "部分完成" };
    }
    return { tone: "done", label: "已完成" };
  }
  if (row.handlingLabel === "需人工") return { tone: "human", label: "需人工" };
  return { tone: "queued", label: "排队" };
}

function capabilityDetail(row: BatchCaptureModuleRow): string | null {
  if (!row.executed) return null;
  if (row.wiring === "search_phase") return row.itemsTotal > 0 ? "搜索阶段完成" : null;
  const parts: string[] = [];
  if (row.itemsFieldComplete > 0) parts.push(`完整 ${row.itemsFieldComplete}`);
  if (row.itemsPartial > 0) parts.push(`部分 ${row.itemsPartial}`);
  if (row.itemsFailed > 0) parts.push(`失败 ${row.itemsFailed}`);
  if (row.itemsSkipped > 0) parts.push(`复用 ${row.itemsSkipped}`);
  return parts.length ? parts.join(" · ") : null;
}

function capabilityProblem(row: BatchCaptureModuleRow): string | null {
  if (!row.executed) return null;
  if (row.itemsFailed > 0) return `${row.itemsFailed} 件失败`;
  if (row.itemsPartial > 0) return `${row.itemsPartial} 件部分数据`;
  return null;
}

function buildCapability(row: BatchCaptureModuleRow, allowed: boolean): ConsoleCapability {
  const meta = MODULE_META[row.module] ?? { name: row.label, icon: "detail" as const, basic: true };
  const state = capabilityState(row, allowed);
  return {
    module: row.module,
    name: meta.name,
    icon: meta.icon,
    allowed,
    tone: state.tone,
    stateLabel: state.label,
    evidenceCount: row.validEvidenceCount,
    total: row.itemsTotal,
    percent: percentOf(row.validEvidenceCount, row.itemsTotal),
    detail: capabilityDetail(row),
    problem: capabilityProblem(row),
  };
}

function rowFor(view: BatchCaptureRunPresentation, module: string): BatchCaptureModuleRow | null {
  return view.moduleMatrix.find((row) => row.module === module) ?? null;
}

function isAllowed(run: BatchCaptureRunView | null, module: string, row: BatchCaptureModuleRow | null): boolean {
  if (!run) return false;
  // 搜索阶段模块不在 advance 白名单里；只要本轮有该模块结果，就视为已执行。
  if (module === "amazon_search_market") return Boolean(row && row.itemsTotal > 0);
  return run.allowedModules.includes(module);
}

function buildHero(
  view: BatchCaptureRunPresentation,
  progress: ConsoleProgress,
  issueCountFallback: number,
  now: Date,
): ConsoleHero {
  const status = view.status;
  const executorUnknown = view.executorState === "unknown_needs_confirmation";
  const tone = executorUnknown ? "fail" : status ? STATUS_TONE[status] : "idle";
  const runLabel = view.runGeneration ? `第 ${view.runGeneration} 次运行` : null;
  const updatedLabel = formatSnapshotTime(view.lastRunAt, now);

  let title: string;
  let subtitle: string;
  let suggestion: string | null = null;

  if (!view.hasRun) {
    title = "尚未开始采集";
    subtitle = "该批次还没有自动采集执行器；配置计划后才会创建任务。";
    suggestion = "配置采集计划";
  } else if (executorUnknown) {
    title = "执行器状态待确认";
    subtitle = view.executorStateHint ?? "旧执行器是否退出尚未确认；确认前不会启动冲突的新执行。";
    suggestion = "先核对旧采集进程，再人工确认";
  } else if (status === "RUNNING" || status === "WAITING") {
    title = status === "WAITING" ? "等待执行器启动" : "正在采集";
    subtitle = view.current
      ? `当前 ${view.current.asin} · ${view.current.moduleLabel}`
      : "执行器正在推进；进度以服务端持久化快照为准。";
    suggestion = view.actions.canPause ? "可暂停；进度以服务端快照为准" : null;
  } else if (status === "PAUSED") {
    title = "采集已暂停";
    subtitle = view.pauseHint ?? view.statusExplanation;
    suggestion = view.actions.canResume ? "确认环境后继续采集" : null;
  } else if (status === "HUMAN_REQUIRED") {
    title = "需要人工处理";
    subtitle = view.pauseHint ?? view.statusExplanation;
    suggestion = view.actions.canResume ? "在采集浏览器完成登录 / 验证后点继续" : null;
  } else if (status === "PARTIAL") {
    title = "本轮采集部分完成";
    const facts: string[] = [`本轮已处理 ${progress.value}/${progress.total} 件（本次授权范围）`];
    if (view.progress.failedCells > 0) facts.push(`${view.progress.failedCells} 个单元失败`);
    if (view.progress.partialCells > 0) facts.push(`${view.progress.partialCells} 个单元只有部分数据`);
    subtitle = `${facts.join("；")}。`;
    const gate = view.researchEligibility.marketSampleGate;
    if (gate.known && gate.satisfied === true && gate.current != null) {
      subtitle += `批次有效样本 ${gate.current}/${gate.required} 已达研究门槛——这是整个来源批次的研究资格，不代表本轮采集已全部成功。`;
    }
    suggestion = view.actions.canRetry
      ? "可重试未达上限的失败单元"
      : view.actions.retryExhaustedFailures
        ? "失败已达重试上限；可查看缺口或重新配置计划"
        : null;
  } else if (status === "COMPLETED") {
    title = view.completionHint ? "本轮自动采集已结束" : "本轮采集已完成";
    subtitle = view.completionHint
      ?? `本轮已处理 ${progress.value}/${progress.total} 件（本次授权范围）；本轮资料证据 ${view.progress.validEvidenceCells}/${view.progress.totalCells} 单元。`;
    suggestion = "如需补采，请重新确认计划创建新代次";
  } else if (status === "FAILED") {
    title = "本轮采集失败";
    subtitle = view.statusExplanation;
    suggestion = "如需继续，请重新确认计划";
  } else {
    title = "本轮采集已中止";
    subtitle = view.statusExplanation;
    suggestion = "如需继续，请重新确认计划";
  }

  const issueCount = view.progress.failedCells > 0
    ? view.progress.failedCells
    : issueCountFallback;
  const issueLabel = view.progress.failedCells > 0
    ? `${view.progress.failedCells} 个单元失败`
    : issueCount > 0
      ? `${issueCount} 项待处理`
      : null;

  return {
    tone,
    progressState: progress.state,
    statusLabel: view.statusLabel,
    title,
    subtitle,
    suggestion,
    issueCount,
    issueLabel,
    runLabel,
    updatedLabel,
  };
}

function buildIssues(
  view: BatchCaptureRunPresentation,
  basic: ConsoleCapability[],
): ConsoleIssue[] {
  const issues: ConsoleIssue[] = [];

  if (view.executorState === "unknown_needs_confirmation") {
    issues.push({
      id: "executor-unknown",
      tone: "fail",
      title: "执行器状态待确认",
      description: view.executorStateHint ?? "租约到期不等于执行器已停止；请先核对旧采集进程。",
      action: { kind: "scroll", label: "去确认", target: "recovery" },
    });
  }

  if (!view.statusConsistency.consistent) {
    issues.push({
      id: "status-consistency",
      tone: "fail",
      title: "状态与持久化单元不一致",
      description: view.statusConsistency.issues[0] ?? "服务端状态与单元矩阵不一致。",
      action: { kind: "scroll", label: "查看明细", target: "advanced" },
    });
  }

  if (view.status === "HUMAN_REQUIRED" && view.actions.canResume) {
    issues.push({
      id: "human-required",
      tone: "warn",
      title: "需要人工登录或验证",
      description: view.pauseHint ?? "存在需要人工处理的单元；完成后点「继续」。",
      action: { kind: "resume", label: "继续采集" },
    });
  }

  if (view.actions.retryExhaustedFailures && view.progress.failedCells > 0) {
    const failedRows = view.moduleMatrix
      .filter((row) => row.itemsFailed > 0)
      .map((row) => `${MODULE_META[row.module]?.name ?? row.label} ${row.itemsFailed}`);
    issues.push({
      id: "retry-exhausted",
      tone: "warn",
      title: `${view.progress.failedCells} 个单元失败 · 已达重试上限`,
      description: `${failedRows.length ? `集中在 ${failedRows.join("、")}；` : ""}失败单元已达到自动重试上限（3 次），系统不会无限重试。`,
      action: { kind: "scroll", label: "查看缺口", target: "gaps" },
    });
  } else if (view.actions.canRetry) {
    issues.push({
      id: "retryable",
      tone: "warn",
      title: "存在可重试的失败单元",
      description: "重试只推进未达重试上限的失败单元；已保存证据不会被删除。",
      action: { kind: "retry", label: "重试" },
    });
  }

  if (issues.length < 2 && view.gapTriage.length > 0) {
    const gap = view.gapTriage[0];
    issues.push({
      id: `gap-${gap.category}-${gap.module ?? "batch"}`,
      tone: gap.category === "product_capture_failed" ? "fail" : "warn",
      title: gap.categoryLabel,
      description: `${gap.detail} 恢复条件：${gap.recovery}`,
      action: { kind: "scroll", label: "查看", target: "gaps" },
    });
  }

  if (issues.length === 0 && basic.some((row) => row.tone === "partial" || row.tone === "failed")) {
    const affected = basic.filter((row) => row.tone === "partial" || row.tone === "failed");
    issues.push({
      id: "module-gaps",
      tone: "warn",
      title: `${affected.length} 项基础能力有缺口`,
      description: affected.map((row) => `${row.name}${row.problem ? `（${row.problem}）` : ""}`).join("、"),
      action: { kind: "scroll", label: "查看", target: "gaps" },
    });
  }

  return issues.slice(0, 2);
}

function buildPlan(run: BatchCaptureRunView | null): ConsolePlan {
  const scope = run?.allowedModules?.length
    ? run.allowedModules
        .map((module) => MODULE_META[module]?.name ?? module)
        .join(" · ")
    : "—";
  const authorized = run?.authorizedItemLimit != null ? `${run.authorizedItemLimit} 件` : "—";
  const budget = run?.navigationBudget;
  const navigation = budget ? `${budget.used} / ${budget.limit}` : "—";
  const navigationDetail = budget
    ? `剩余 ${Math.max(0, budget.limit - budget.used - budget.reserved)}（预留 ${budget.reserved}）`
    : null;
  return { scope, authorized, navigation, navigationDetail };
}

export function buildConsoleModel(input: {
  view: BatchCaptureRunPresentation;
  run: BatchCaptureRunView | null;
  now?: Date;
  noRunGuidance?: { title: string; body: string; planHint: string } | null;
}): ConsoleModel {
  const { view, run, now = new Date(), noRunGuidance } = input;
  const allowedModules = run?.allowedModules ?? [];
  const basicRows = BASIC_ORDER
    .map((module) => rowFor(view, module))
    .filter((row): row is BatchCaptureModuleRow => Boolean(row));
  const supplementaryRows = SUPPLEMENTARY_ORDER
    .map((module) => rowFor(view, module))
    .filter((row): row is BatchCaptureModuleRow => Boolean(row));

  const basic = basicRows.map((row) => buildCapability(row, isAllowed(run, row.module, row)));
  const supplementary = supplementaryRows.map((row) => buildCapability(row, isAllowed(run, row.module, row)));

  const progressState = progressStateOf(view.status, view.executorState === "unknown_needs_confirmation");
  const progress: ConsoleProgress = {
    value: view.progress.uniqueItemsVisited,
    total: view.progress.itemsInBatch,
    percent: percentOf(view.progress.uniqueItemsVisited, view.progress.itemsInBatch),
    state: progressState,
    stateWord: "",
    updatedLabel: formatSnapshotClock(view.lastRunAt),
  };
  /** 状态词固定携带「本轮」口径与分母，避免与「批次有效样本」混淆。 */
  const processedRange = `${progress.value}/${progress.total} 件`;
  progress.stateWord = progressState === "running"
    ? `本轮运行中 · 已处理 ${processedRange}`
    : progressState === "paused"
      ? `本轮已暂停 · 已处理 ${processedRange}`
      : progressState === "completed"
        ? `本轮已完成 · 已处理 ${processedRange}`
        : progressState === "partial"
          ? `本轮部分完成 · 已处理 ${processedRange}`
          : progressState === "blocked"
            ? `本轮已停止 · 已处理 ${processedRange}`
            : "尚未开始";

  const evidence: ConsoleEvidence = {
    value: view.progress.validEvidenceCells,
    total: view.progress.totalCells,
    percent: percentOf(view.progress.validEvidenceCells, view.progress.totalCells),
    failed: view.progress.failedCells,
    partial: view.progress.partialCells,
  };

  const gate = view.researchEligibility.marketSampleGate;
  const sample: ConsoleSample = gate.known && gate.current != null
    ? {
        current: gate.current,
        required: gate.required,
        sufficient: gate.satisfied,
        label: gate.satisfied ? "已达研究门槛" : "未达研究门槛",
        note: "整个来源批次满足研究条件的商品数；与本轮处理的件数是两个口径",
      }
    : {
        current: null,
        required: gate.required,
        sufficient: null,
        label: "等待服务端判定",
        note: "尚未取得权威样本门槛",
      };

  const completedBasic = basic.filter((row) => row.tone === "done").length;
  const gapBasic = basic.length - completedBasic;
  const basicSummary = !view.hasRun
    ? "本轮尚未开始"
    : gapBasic > 0
      ? `${completedBasic} 项完成 · ${gapBasic} 项需关注`
      : "4 项均已完成";
  const allowedSupplementary = supplementary.filter((row) => row.allowed).length;
  const supplementarySummary = !view.hasRun
    ? "本轮尚未开始"
    : allowedSupplementary === 0
      ? "4 项 · 本轮未授权"
      : `${allowedSupplementary} 项本轮已授权 · ${4 - allowedSupplementary} 项未授权`;

  const issues = view.hasRun ? buildIssues(view, basic) : [];
  const plan = buildPlan(run);

  return {
    hasRun: view.hasRun,
    hero: buildHero(view, progress, issues.length, now),
    progress,
    evidence,
    sample,
    basic,
    supplementary,
    basicSummary,
    supplementarySummary,
    issues,
    plan,
    noRunGuidance: view.hasRun
      ? null
      : noRunGuidance ?? {
          title: "尚未创建采集任务",
          body: "请在上方【市场采集计划 / Capture Plan】选择策略并确认；确认后任务会自动创建并开始执行，无需在这里再次创建。",
          planHint: "计划确认是唯一创建入口；本面板不会在后台自动开始采集。",
        },
  };
}
