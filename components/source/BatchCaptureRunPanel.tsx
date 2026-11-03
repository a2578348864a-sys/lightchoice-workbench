"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Eye, Loader2, Pause, Play, RefreshCw, RotateCcw, Square } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  fetchBatchCaptureRun,
  postBatchCaptureRunAction,
  type BatchCaptureRunAction,
} from "@/lib/client/batchCaptureRunClient";
import {
  describeBatchCaptureRun,
  BATCH_CAPTURE_EVIDENCE_DESTINATION,
  BATCH_CAPTURE_MODULE_LABELS,
  type BatchCaptureDeepResearchItems,
  type BatchCaptureGapCategory,
  type BatchCaptureRunTone,
  type BatchCaptureRunView,
  type BatchCaptureSampleGate,
} from "@/lib/sourceLayer/batchCaptureRunPresentation";
import type { BatchCaptureRunSnapshot } from "@/lib/sourceLayer/batchCaptureRunSnapshot";
import { CaptureConsoleView } from "@/components/source/capture-console/CaptureConsoleView";
import {
  buildConsoleModel,
  type ConsoleIssueAction,
  type ConsoleScrollTarget,
} from "@/components/source/capture-console/captureConsoleModel";
import consoleStyles from "@/components/source/capture-console/capture-console.module.css";

const POLL_INTERVAL_MS = 3_000;
const EXTERNAL_EVIDENCE_ENDPOINT = "/api/source-layer/batch-capture/external-evidence";

/** 合同字符串：面板的可访问名称（源码契约测试读取本文件）。 */
export const CAPTURE_CONSOLE_ARIA_LABEL = "采集进度 / Capture Progress";

/** 无运行时的引导文案；CaptureTaskWorkspace 与本面板共用同一份事实。 */
export const CAPTURE_NO_RUN_GUIDANCE = {
  title: "尚未创建采集任务",
  body: "请在上方【市场采集计划 / Capture Plan】选择策略并确认；确认后任务会自动创建并开始执行，无需在这里再次创建。",
  planHint: "计划确认是唯一创建入口；本面板不会在后台自动开始采集。",
} as const;

/** 只读接口返回的单个主体（商品级 ASIN 主体或查询级 subjectKey）。 */
export type ExternalEvidenceSubjectView = {
  subjectKey: string;
  module: string;
  attachmentCount: number;
  latestCapturedAt: string | null;
};

export type ExternalEvidenceView = {
  batchId: string;
  runId: string | null;
  subjects: ExternalEvidenceSubjectView[];
  totals: {
    subjectCount: number;
    checkedSubjectCount: number;
    attachmentCount: number;
    productSubjectCount: number;
    productAttachmentCount: number;
    querySubjectCount: number;
    queryAttachmentCount: number;
    failedSubjectCount: number;
    failures: Array<{ subjectKey: string; module: string | null; message: string }>;
  };
};

const GAP_TONES: Record<BatchCaptureGapCategory, BatchCaptureRunTone> = {
  batch_query_not_executed: "blue",
  source_switch_disabled: "amber",
  human_input_required: "slate",
  product_capture_failed: "rose",
  product_field_incomplete: "amber",
  product_not_captured: "slate",
};

/**
 * 只读读取「已有手工附件」。只在用户点击时调用；不轮询、不自动请求、不触发任何采集。
 * 鉴权/错误形状照同目录只读路由：`{ ok, data | error }`。
 */
async function fetchBatchCaptureExternalEvidence(batchId: string): Promise<ExternalEvidenceView> {
  const response = await fetch(
    `${EXTERNAL_EVIDENCE_ENDPOINT}?batchId=${encodeURIComponent(batchId)}`,
    { method: "GET", headers: { accept: "application/json" }, cache: "no-store" },
  );
  const payload = await response.json().catch(() => null) as
    | { ok?: boolean; data?: ExternalEvidenceView; error?: { message?: string } }
    | null;
  if (!response.ok || !payload?.ok || !payload.data) {
    throw new Error(payload?.error?.message ?? `读取已有手工附件失败（HTTP ${response.status}）。`);
  }
  return payload.data;
}

export type BatchCaptureRunLegacyJobSummary = { status: string; total: number; processed: number } | null;

export type BatchCaptureRunPanelProps = {
  presentation?: "full" | "workspace";
  batchId: string;
  /** 该批次可用的商品数量上限（用于把授权数量夹紧到真实可用范围）。 */
  availableItemCount?: number | null;
  /** 旧详情补齐任务的只读摘要：仅用于「历史只读」提示，不作为主进度。 */
  legacyJob?: BatchCaptureRunLegacyJobSummary;
  /** 服务端权威的市场研究样本门槛（来自批次 validProductSet）。 */
  sampleGate?: BatchCaptureSampleGate;
  /** 服务端权威的商品深研就绪计数（来自条目 usageStatus）。 */
  deepResearchItems?: BatchCaptureDeepResearchItems;
  /** 测试可注入；默认使用真实 API 客户端。 */
  fetcher?: (batchId: string, init?: { signal?: AbortSignal }) => Promise<Awaited<ReturnType<typeof fetchBatchCaptureRun>>>;
  actor?: (batchId: string, action: BatchCaptureRunAction, options?: {
    maxSlices?: number;
    allowRetry?: boolean;
    query?: { category: string; filters?: Record<string, string> };
    keywordMiningQuery?: { seedKeyword: string; conditions?: Record<string, string> };
    authorizedItemLimit?: number;
    allowedModules?: string[];
    maxItemsPerAdvance?: number;
    recovery?: { runId: string; runGeneration: number; executionEpoch: number; reason: string };
  }) => Promise<Awaited<ReturnType<typeof postBatchCaptureRunAction>>>;
  /** 测试可注入；默认调用只读 API（仅在用户点击「查看已有手工附件」后请求，不自动加载）。 */
  externalEvidenceFetcher?: (batchId: string) => Promise<ExternalEvidenceView>;
  /** 把「该批次是否存在自动采集执行器」回报给父组件，用于把旧详情补齐入口降级为历史只读。 */
  onRunResolved?: (hasRun: boolean) => void;
  /** 把完整 tri-state 快照回报给父组件（摘要/历史共用同一权威）。 */
  onSnapshot?: (snapshot: BatchCaptureRunSnapshot) => void;
  /**
   * 外部刷新令牌：父组件在「计划确认创建任务」等事件后递增该值，
   * 面板随即重新读取权威状态——不需要用户手动点击「刷新状态」或重进页面。
   * 只触发只读重载，绝不自动推进或恢复采集。
   */
  refreshToken?: number;
  /** 本轮计划面板（折叠）；由 CaptureTaskWorkspace 传入，保持唯一创建入口。 */
  planSlot?: ReactNode;
  /** 执行明细与技术说明（折叠）；由 CaptureTaskWorkspace 传入。 */
  techSlot?: ReactNode;
  /** 「查看计划」：由父组件展开计划面板并滚动到它。 */
  onOpenPlan?: () => void;
};

export function BatchCaptureRunPanel({
  batchId, availableItemCount = null, legacyJob = null, sampleGate = null, deepResearchItems = null,
  fetcher, actor, externalEvidenceFetcher, onRunResolved, onSnapshot, refreshToken = 0,
  planSlot, techSlot, onOpenPlan,
}: BatchCaptureRunPanelProps) {
  const load = fetcher ?? fetchBatchCaptureRun;
  const act = actor ?? postBatchCaptureRunAction;
  const [run, setRun] = useState<BatchCaptureRunView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<BatchCaptureRunAction | null>(null);
  const [notice, setNotice] = useState<{ tone: "info" | "success" | "error"; message: string } | null>(null);
  const [productMarketCategory, setProductMarketCategory] = useState("");
  const [keywordMiningSeed, setKeywordMiningSeed] = useState("");
  const [recoveryReason, setRecoveryReason] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /**
   * 已有手工附件：按需加载（点击才请求）。`idle` 表示从未请求过，
   * 绝不因为面板刷新或出现 run 就自动读取，也不参与任何轮询。
   */
  const [externalEvidence, setExternalEvidence] = useState<ExternalEvidenceView | null>(null);
  const [externalEvidenceState, setExternalEvidenceState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [externalEvidenceError, setExternalEvidenceError] = useState<string | null>(null);
  const alive = useRef(true);
  const onSnapshotRef = useRef(onSnapshot);

  const reload = useCallback(async () => {
    const result = await load(batchId);
    if (!alive.current) return;
    if (result.ok) {
      setRun(result.run);
      setState("ready");
      setErrorMessage(null);
      onSnapshotRef.current?.(result.run
        ? { state: "present", run: result.run, view: describeBatchCaptureRun({ run: result.run }), at: Date.now() }
        : { state: "absent", at: Date.now() });
    } else {
      setState("error");
      setErrorMessage(result.errorMessage);
      onSnapshotRef.current?.({ state: "error", message: result.errorMessage, at: Date.now() });
    }
  }, [batchId, load]);

  // 父级每次渲染都会新建 onSnapshot；用最新引用回报，避免 reload 身份变化触发读取循环。
  useEffect(() => { onSnapshotRef.current = onSnapshot; });

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => { alive.current = false; };
  }, [reload]);

  // batchId 变化时清空上一批次的按需附件结果，避免把 A 批次的附件显示在 B 批次上。
  useEffect(() => {
    setExternalEvidence(null);
    setExternalEvidenceState("idle");
    setExternalEvidenceError(null);
  }, [batchId]);

  /** 按需读取已有手工附件：只在用户点击按钮时调用，不轮询、不自动触发。 */
  const loadExternalEvidence = useCallback(async () => {
    setExternalEvidenceState("loading");
    setExternalEvidenceError(null);
    try {
      const result = await (externalEvidenceFetcher ?? fetchBatchCaptureExternalEvidence)(batchId);
      if (!alive.current) return;
      setExternalEvidence(result);
      setExternalEvidenceState("ready");
    } catch (error) {
      if (!alive.current) return;
      setExternalEvidenceError(error instanceof Error ? error.message : "读取已有手工附件失败。");
      setExternalEvidenceState("error");
    }
  }, [batchId, externalEvidenceFetcher]);

  /**
   * 外部刷新令牌：计划面板确认创建任务后由父组件递增。
   * 目的：创建前 run 为 null（轮询不启动），创建后本面板必须立即读到新任务，
   * 而不是停留在「尚未创建」直到用户手动刷新。
   */
  useEffect(() => {
    if (!refreshToken) return;
    void reload();
  }, [refreshToken, reload]);

  useEffect(() => {
    if (!run) return;
    if (run.status !== "RUNNING" && run.status !== "WAITING") return;
    const timer = setInterval(() => { void reload(); }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [run, reload]);

  const onAction = useCallback(async (
    action: BatchCaptureRunAction,
    options?: {
      query?: { category: string; filters?: Record<string, string> };
      keywordMiningQuery?: { seedKeyword: string; conditions?: Record<string, string> };
    },
  ) => {
    setBusy(action);
    setNotice(null);
    try {
      const result = await act(batchId, action, options);
      if (!alive.current) return;
      if (result.ok) {
        if (result.run) setRun(result.run);
        setState("ready");
        const drive = "drive" in result ? result.drive : null;
        if (drive && drive.errorCode && !drive.started && !drive.alreadyRunning) {
          setNotice({ tone: "error", message: drive.message || `执行器未启动（${drive.errorCode}）。` });
          setErrorMessage(drive.message || null);
        } else {
          setErrorMessage(null);
          setNotice({
            tone: "success",
            message: action === "prepare_product_market_query"
              ? "类目查询任务已记录；此操作没有打开浏览器。商品单元仍须各自取得并通过来源 Evidence 校验。"
              : action === "prepare_keyword_mining_query"
                ? "seedKeyword 查询任务已记录；关键词级结果不会自动复制或关联到批次 ASIN。"
              : action === "drive"
              ? "已请求推进批次；进度以服务端持久化状态为准。"
              : action === "pause" ? "已请求暂停；当前执行不会伪造完成。"
                : action === "resume" ? "已请求继续；若执行器未启动，下方会显示真实原因。"
                  : action === "cancel" ? "已中止该批次；不会自动执行其他任务。"
                    : action === "retry"
                      ? drive?.alreadyRunning
                        ? "已授权重试；执行器已在推进，未重复启动。"
                        : drive?.started
                          ? "重试已授权，执行器已启动，只推进符合条件的失败单元。"
                          : "已重置符合条件的失败单元；执行器未启动（服务端未进入可自动推进状态）。请以下方状态与回执为准，不是已开始采集。"
                      : "已授权有界重试未达上限的可重试失败。",
          });
        }
        await reload();
      } else {
        setNotice({ tone: "error", message: result.errorMessage });
        setErrorMessage(result.errorMessage);
        // 重试失败也必须回读服务端状态（门禁拒绝后按钮条件可能已变化）。
        if (action === "retry" || action === "resume" || action === "recover_stalled_execution") {
          await reload();
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "操作失败，请刷新后以服务端状态为准。";
      if (alive.current) {
        setNotice({ tone: "error", message });
        setErrorMessage(message);
        await reload().catch(() => undefined);
      }
    } finally {
      // 无论成功/失败/异常/卸载竞态，都要尝试解除 busy，避免按钮永久禁用。
      setBusy(null);
    }
  }, [act, batchId, reload]);

  const view = describeBatchCaptureRun({ run, legacyJob, sampleGate, deepResearchItems });
  const p = view.progress;
  const consoleModel = buildConsoleModel({ view, run });
  // 分诊条目已在面板中按「类型 + 恢复条件」展示；gaps 里剩余的是权限/人工/一致性等其他限制。
  const triageGapTexts = new Set(view.gapTriage.map((gap) => gap.text));
  const otherGaps = view.gaps.filter((gap) => !triageGapTexts.has(gap));
  const externalEvidenceSubjects = externalEvidence
    ? externalEvidence.subjects.filter((subject) => subject.attachmentCount > 0)
    : [];
  // D2-1B：没有任何执行痕迹时不展示 0/0 指标网格（任务已创建 ≠ 已有结果）。
  const progressMade =
    p.uniqueItemsVisited > 0 ||
    p.autoCellsTerminal > 0 ||
    p.validEvidenceCells > 0 ||
    p.failedCells > 0 ||
    p.completedModules > 0;

  const onRecover = useCallback(async () => {
    const target = view.recoveryTarget;
    setNotice(null);
    if (!target) return;
    if (recoveryReason.trim().length < 8) {
      setNotice({ tone: "error", message: "人工确认必须填写 8 字以上的核对原因（例如已核对旧采集进程不再存活）。" });
      return;
    }
    setBusy("recover_stalled_execution");
    try {
      const result = await act(batchId, "recover_stalled_execution", {
        recovery: { ...target, reason: recoveryReason.trim() },
      });
      if (!alive.current) return;
      if (result.ok) {
        if (result.run) setRun(result.run);
        setNotice({ tone: "success", message: "已人工确认执行器状态并解除阻塞；已合法保存的证据保持不变。" });
        setRecoveryReason("");
        await reload();
      } else {
        setNotice({ tone: "error", message: result.errorMessage });
        setErrorMessage(result.errorMessage);
        await reload();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "人工确认失败，请刷新后重试。";
      if (alive.current) {
        setNotice({ tone: "error", message });
        setErrorMessage(message);
        await reload().catch(() => undefined);
      }
    } finally {
      setBusy(null);
    }
  }, [act, batchId, recoveryReason, reload, view.recoveryTarget]);

  useEffect(() => {
    if (state === "ready") onRunResolved?.(view.hasRun);
  }, [state, view.hasRun, onRunResolved]);

  const scrollToId = useCallback((id: string) => {
    const node = document.getElementById(id);
    if (node) node.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const openAdvancedAndScroll = useCallback((target?: ConsoleScrollTarget) => {
    setAdvancedOpen(true);
    // 等 details 展开后再测量位置。
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (target === "gaps") scrollToId("capture-console-gaps");
      else if (target === "recovery") scrollToId("capture-console-recovery");
      else scrollToId("capture-console-advanced");
    }));
  }, [scrollToId]);

  const onIssueAction = useCallback((action: ConsoleIssueAction) => {
    if (action.kind === "retry") { void onAction("retry"); return; }
    if (action.kind === "resume") { void onAction("resume"); return; }
    if (action.target === "issues") { scrollToId("capture-console-issues"); return; }
    if (action.target === "plan") {
      if (onOpenPlan) onOpenPlan();
      else scrollToId("capture-task-plan-details");
      return;
    }
    openAdvancedAndScroll(action.target);
  }, [onAction, onOpenPlan, openAdvancedAndScroll, scrollToId]);

  const openPlan = useCallback(() => {
    if (onOpenPlan) {
      onOpenPlan();
      return;
    }
    scrollToId("capture-task-plan-details");
  }, [onOpenPlan, scrollToId]);

  if (state === "loading" && !run) {
    return (
      <section data-testid="batch-capture-run-panel" className={consoleStyles.root}>
        <div className={consoleStyles.noRun} role="status">
          <p className={consoleStyles.noRunKicker}>读取中</p>
          <p className={consoleStyles.noRunTitle}>正在读取本轮采集</p>
          <p className={consoleStyles.noRunBody}>
            <Loader2 className="mr-1.5 inline size-4 animate-spin" />
            正在读取服务端持久化的运行状态与证据统计…
          </p>
        </div>
      </section>
    );
  }

  if (state === "error" && !run) {
    return (
      <section data-testid="batch-capture-run-panel" className={consoleStyles.root}>
        <div className={consoleStyles.noRun} role="alert">
          <p className={consoleStyles.noRunKicker}>读取失败</p>
          <p className={consoleStyles.noRunTitle}>执行记录暂不可读</p>
          <p className={consoleStyles.noRunBody}>{errorMessage || "请重新读取服务端状态。"}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void reload()}>
            重新读取
          </Button>
        </div>
      </section>
    );
  }

  if (!run) {
    return (
      <section data-testid="batch-capture-run-panel" className={consoleStyles.root}>
        <div className={consoleStyles.noRun} role="status">
          <p className={consoleStyles.noRunKicker}>尚未开始</p>
          <p className={consoleStyles.noRunTitle}>{CAPTURE_NO_RUN_GUIDANCE.title}</p>
          <p className={consoleStyles.noRunBody}>{CAPTURE_NO_RUN_GUIDANCE.body}</p>
          <p className={consoleStyles.noRunHint}>{CAPTURE_NO_RUN_GUIDANCE.planHint}</p>
        </div>
        {planSlot}
      </section>
    );
  }

  const executorUnknown = view.executorState === "unknown_needs_confirmation";
  const terminal = ["COMPLETED", "CANCELLED", "FAILED"].includes(view.status ?? "");
  const localEnvBlocked = view.hasRun && view.lastErrorCode === "LOCAL_ENVIRONMENT_REQUIRED" && !terminal;

  // 主操作严格按状态与真实门禁映射；不显示「看起来能点」的按钮。
  type PrimaryKind = "pause" | "resume" | "drive" | "retry" | "refresh" | "plan";
  let primaryKind: PrimaryKind;
  if (executorUnknown) primaryKind = "refresh";
  else if (view.status === "RUNNING" || view.status === "WAITING") primaryKind = view.actions.canPause ? "pause" : "refresh";
  else if (view.status === "PAUSED" || view.status === "HUMAN_REQUIRED") {
    primaryKind = view.actions.canResume ? "resume" : view.actions.canDrive ? "drive" : "refresh";
  } else if (view.status === "PARTIAL") {
    primaryKind = view.actions.canRetry ? "retry" : view.actions.canDrive ? "drive" : "refresh";
  } else if (view.status === "COMPLETED") primaryKind = "refresh";
  else if (view.status === "FAILED" || view.status === "CANCELLED") primaryKind = "plan";
  else primaryKind = "plan";

  const primaryLabel: Record<PrimaryKind, string> = {
    pause: "暂停采集",
    resume: "继续采集",
    drive: view.status === "PAUSED" ? "继续自动采集" : "开始自动采集",
    retry: "重试失败单元",
    refresh: "刷新状态",
    plan: "配置采集计划",
  };
  const primaryTestId: Record<PrimaryKind, string> = {
    pause: "batch-capture-run-pause",
    resume: "batch-capture-run-resume",
    drive: "batch-capture-run-drive",
    retry: "batch-capture-run-retry",
    refresh: "batch-capture-run-refresh",
    plan: "capture-console-open-plan",
  };

  const runPrimary = () => {
    if (primaryKind === "plan") { openPlan(); return; }
    if (primaryKind === "refresh") { void reload(); return; }
    void onAction(primaryKind === "pause" ? "pause" : primaryKind === "resume" ? "resume" : primaryKind === "drive" ? "drive" : "retry");
  };
  const primaryBusy = primaryKind === "pause" ? busy === "pause"
    : primaryKind === "resume" ? busy === "resume"
      : primaryKind === "drive" ? busy === "drive"
        : primaryKind === "retry" ? busy === "retry"
          : state === "loading";

  const secondary: Array<{ kind: "pause" | "resume" | "retry"; label: string; testId: string; icon: ReactNode }> = [];
  if (view.actions.canPause && primaryKind !== "pause") {
    secondary.push({ kind: "pause", label: "暂停", testId: "batch-capture-run-pause", icon: <Pause className="size-3.5" /> });
  }
  if (view.actions.canResume && primaryKind !== "resume" && !(view.status === "PAUSED" && primaryKind === "drive")) {
    secondary.push({ kind: "resume", label: "继续", testId: "batch-capture-run-resume", icon: <Play className="size-3.5" /> });
  }
  if (view.actions.canRetry && primaryKind !== "retry") {
    secondary.push({ kind: "retry", label: "重试", testId: "batch-capture-run-retry", icon: <RotateCcw className="size-3.5" /> });
  }

  const footer = (
    <footer className={consoleStyles.foot} data-testid="capture-console-footer">
      <span className={consoleStyles.footNote}>以证据为准 · 不改变任何门禁</span>
      <div className={consoleStyles.footActions}>
        {view.actions.canCancel ? (
          <button
            type="button"
            className={`${consoleStyles.btn} ${consoleStyles.btnGhost}`}
            data-testid="batch-capture-run-cancel"
            onClick={() => { void onAction("cancel"); }}
            disabled={busy !== null}
            title="中止后历史运行与已保存证据保留"
          >
            <Square className="size-3.5" />中止
          </button>
        ) : null}
        {primaryKind !== "refresh" ? (
          <button
            type="button"
            className={`${consoleStyles.btn} ${consoleStyles.btnIcon}`}
            data-testid="batch-capture-run-refresh"
            aria-label="重新读取批次自动采集状态"
            title="重新读取服务端状态"
            onClick={() => { void reload(); }}
            disabled={busy !== null}
          >
            {state === "loading" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </button>
        ) : null}
        {secondary.map((action) => (
          <button
            key={action.kind}
            type="button"
            className={consoleStyles.btn}
            data-testid={action.testId}
            onClick={() => { void onAction(action.kind); }}
            disabled={busy !== null}
          >
            {busy === action.kind ? <Loader2 className="size-3.5 animate-spin" /> : action.icon}
            {action.label}
          </button>
        ))}
        <button
          type="button"
          className={`${consoleStyles.btn} ${consoleStyles.btnPrimary}`}
          data-testid={primaryTestId[primaryKind]}
          onClick={runPrimary}
          disabled={busy !== null || primaryBusy}
          title={view.actions.disabledReason ?? undefined}
        >
          {primaryBusy ? <Loader2 className="size-4 animate-spin" /> : primaryKind === "pause" ? <Pause className="size-4" />
            : primaryKind === "resume" || primaryKind === "drive" ? <Play className="size-4" />
              : primaryKind === "retry" ? <RotateCcw className="size-4" />
                : primaryKind === "refresh" ? <RefreshCw className="size-4" />
                  : <Play className="size-4" />}
          {primaryLabel[primaryKind]}
        </button>
      </div>
    </footer>
  );

  const noticeNode = notice ? (
    <p
      role={notice.tone === "error" ? "alert" : "status"}
      data-testid="batch-capture-run-notice"
      className={consoleStyles.advancedBlock}
      data-tone={notice.tone === "error" ? "fail" : notice.tone === "success" ? "info" : undefined}
      style={{ marginTop: 10 }}
    >
      {notice.message}
    </p>
  ) : null;

  const errorNode = state === "error" && errorMessage ? (
    <p role="alert" data-testid="batch-capture-run-error" className={consoleStyles.advancedBlock} data-tone="fail" style={{ marginTop: 10 }}>
      {errorMessage}
    </p>
  ) : null;

  const topAlert = (
    <>
      {localEnvBlocked ? (
        <div
          data-testid="batch-capture-run-local-env-blocked"
          className={consoleStyles.advancedBlock}
          data-tone="warn"
          style={{ marginTop: 10 }}
        >
          <p style={{ fontWeight: 700 }}>本地采集未启用：该任务当前无法自动推进（任务与授权已保留）</p>
          <p style={{ marginTop: 4 }}>
            执行器已被「本地采集未启用」门禁拒绝（LOCAL_ENVIRONMENT_REQUIRED），未执行任何真实来源采集；
            这不代表任务失败，也不代表采到了数据。下一步：启用本地采集（可在页面顶部「采集环境」诊断中查看当前状态）
            后，点击「开始自动采集」继续；授权 {run.authorizedItemLimit ?? "—"} 件商品不会丢失。
          </p>
        </div>
      ) : null}

      {!view.statusConsistency.consistent ? (
        <div
          role="alert"
          data-testid="batch-capture-run-consistency"
          className={consoleStyles.advancedBlock}
          data-tone="fail"
          style={{ marginTop: 10 }}
        >
          <p style={{ fontWeight: 700 }}>状态与持久化单元不一致</p>
          <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>
            {view.statusConsistency.issues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        </div>
      ) : null}

      {executorUnknown ? (
        <div
          data-testid="batch-capture-run-executor-unknown"
          data-executor-state={view.executorState}
          id="capture-console-recovery"
          className={consoleStyles.advancedBlock}
          data-tone="fail"
          style={{ marginTop: 10 }}
        >
          <p style={{ fontWeight: 700 }}>{view.executorStateLabel}</p>
          <p style={{ marginTop: 2 }}>{view.executorStateHint}</p>
          {view.recoveryTarget ? (
            <>
              <p className={consoleStyles.code} data-testid="batch-capture-run-recovery-target" style={{ marginTop: 6 }}>
                运行 {view.recoveryTarget.runId.slice(0, 8)} · 第 {view.recoveryTarget.runGeneration} 次运行 · 执行代次 {view.recoveryTarget.executionEpoch}
              </p>
              <label style={{ display: "block", marginTop: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>核对原因（必填，8 字以上）</span>
                <input
                  type="text"
                  data-testid="batch-capture-run-recovery-reason"
                  value={recoveryReason}
                  onChange={(event) => setRecoveryReason(event.target.value)}
                  placeholder="例如：已核对旧采集进程不再存活，浏览器会话已释放"
                  className={consoleStyles.inlineInput}
                />
              </label>
              <button
                type="button"
                data-testid="batch-capture-run-recovery-confirm"
                className={consoleStyles.inlineButton}
                style={{ marginTop: 8 }}
                onClick={() => { void onRecover(); }}
                disabled={busy !== null || recoveryReason.trim().length < 8}
                title="仅在确认旧采集进程确实不再存活后使用；该操作只解除阻塞，不删除任何已保存证据"
              >
                {busy === "recover_stalled_execution" ? <Loader2 className="mr-1.5 inline size-3.5 animate-spin" /> : null}
                人工确认旧执行器已退出并解除阻塞
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );

  const metrics = view.hasRun && progressMade ? (
    <>
      <div className={consoleStyles.metricGrid}>
        <div><span>{p.labels.uniqueItems}</span><b>{p.uniqueItemsVisited} / {p.itemsInBatch}</b></div>
        <div><span>{p.labels.deepProcessed}</span><b>{p.deepProcessedItems} / {p.itemsInBatch}</b></div>
        <div><span>{p.labels.autoExecution}</span><b>{p.autoCellsTerminal} / {p.autoCellsTotal}</b></div>
        <div><span>{p.labels.evidenceCoverage}</span><b>{p.validEvidenceCells} / {p.totalCells}</b></div>
        <div><span>本代次新采集单元（不含复用）</span><b>{p.capturedCells}</b></div>
        <div><span>复用已有有效证据</span><b>{p.reusedEvidenceCells}</b></div>
        <div><span>{p.labels.fieldCompleteness}</span><b>{p.fieldCompleteCells} / {p.capturedCells}</b></div>
        <div><span>{p.labels.moduleCoverage}</span><b>{p.completedModules} / {p.totalModules}</b></div>
        <div><span>{p.labels.navigation}</span><b>{p.navigation.used} / {p.navigation.limit}</b></div>
        <div><span>导航剩余 / 预留</span><b>{p.navigation.remaining} / {p.navigation.reserved}</b></div>
      </div>
      <p style={{ marginTop: 6 }}>
        待处理 {p.pendingCells} · 部分数据 {p.partialCells} · 需人工 {p.humanCells} · 失败 {p.failedCells} · 未接入 {p.sourceLimitedCells}
        <span style={{ color: "#7b9188" }}>
          （各项含义不同，均不代表「全部数据已采齐」。本代次新采集 {p.capturedCells} 单元、其中字段完整 {p.fieldCompleteCells}；
          复用已有有效证据 {p.reusedEvidenceCells} 单元未重复采集，不计入字段完整度分母。）
        </span>
      </p>
    </>
  ) : view.hasRun ? (
    <p data-testid="batch-capture-run-no-progress">
      任务已创建，尚未产生执行进度。用「{view.status === "PAUSED" ? "继续" : "开始"}自动采集」按授权推进本批次。
    </p>
  ) : null;

  const advanced = (
    <>
      <div className={consoleStyles.advancedBlock}>
        <h4>执行统计与口径</h4>
        <div style={{ marginTop: 6 }}>{metrics}</div>
      </div>

      {view.current ? (
        <p data-testid="batch-capture-run-current">
          当前推进目标（按持久化断点推导）：<span className={consoleStyles.mono}>{view.current.asin}</span> · {view.current.moduleLabel}
        </p>
      ) : null}

      {run.allowedModules.includes("sellersprite_product_market") ? (
        <section data-testid="batch-capture-product-market-query" className={consoleStyles.advancedBlock} data-tone="info">
          <h5>卖家精灵商品市场 · 查询级任务</h5>
          <p style={{ marginTop: 3 }}>
            类目结果保存在独立查询主体中，不会完成下方任一 ASIN × 模块单元，也不会自动进入 Research。
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 8, marginTop: 8 }}>
            <label style={{ flex: "1 1 220px", fontSize: 13, fontWeight: 600 }} htmlFor={`batch-capture-product-market-category-${batchId}`}>
              SellerSprite 类目
              <input
                id={`batch-capture-product-market-category-${batchId}`}
                value={productMarketCategory}
                onChange={(event) => setProductMarketCategory(event.target.value)}
                maxLength={120}
                disabled={busy !== null}
                placeholder="例如 Kitchen & Dining"
                className={consoleStyles.inlineInput}
                data-testid="batch-capture-product-market-category"
              />
            </label>
            <Button
              variant="outline" size="sm"
              data-testid="batch-capture-product-market-prepare"
              onClick={() => { void onAction("prepare_product_market_query", { query: { category: productMarketCategory.normalize("NFC").trim() } }); }}
              disabled={!productMarketCategory.normalize("NFC").trim() || busy !== null}
              title="只保存类目查询条件，不打开 SellerSprite 页面"
            >
              仅准备查询任务
            </Button>
          </div>
          <p style={{ marginTop: 6, fontSize: 12.5, color: "#7b9188" }}>
            真实来源执行默认关闭。推进时会先核验本批每个商品的基础 Evidence；任一缺失或身份/哈希异常都会在浏览器导航前阻止查询。
          </p>
          {view.productMarketQueries.length === 0 ? (
            <p style={{ marginTop: 6 }}>尚未建立类目查询任务；准备任务本身不会访问 SellerSprite。</p>
          ) : view.productMarketQueries.map((query) => (
            <div key={query.queryId} data-testid="batch-capture-product-market-query-result" className={consoleStyles.advancedBlock} style={{ marginTop: 6 }}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: 700 }}>US · {query.category}</span>
                <Badge tone={query.status === "captured" ? "emerald" : query.status === "human_required" || query.status === "blocked" ? "amber" : query.status === "failed" ? "rose" : "slate"} size="sm">
                  {query.status === "pending" ? "等待有界推进" : query.status === "captured" ? "查询级 Evidence 已保存" : query.status === "partial" ? "部分查询结果" : query.status === "blocked" ? "前置条件阻止" : query.status === "human_required" ? "需要人工处理" : "查询失败"}
                </Badge>
                <span style={{ color: "#6d8579" }}>可见商品行 {query.rowsObserved} · 身份验证关联 {query.productAssociations.length}</span>
              </div>
              {query.querySubjectKey && <p className={consoleStyles.code} style={{ marginTop: 4 }}>查询主体：{query.querySubjectKey}</p>}
              {query.evidenceAttachmentId && (
                <p className={consoleStyles.code} style={{ marginTop: 2 }}>V3 查询 Evidence 附件：{query.evidenceAttachmentId} · SHA-256 {query.evidenceContentHash}</p>
              )}
              {query.errorCode && <p style={{ marginTop: 4, color: "#8a5c10" }}>{query.errorCode}</p>}
              {query.productAssociations.length > 0 && (
                <div className={consoleStyles.tableWrap} style={{ marginTop: 6 }}>
                  <table className={consoleStyles.table}>
                    <thead><tr><th>验证关联的 ASIN</th><th>查询行键</th><th>基础商品 Evidence</th></tr></thead>
                    <tbody>{query.productAssociations.map((link) => (
                      <tr key={`${query.queryId}-${link.asin}`}>
                        <td className={consoleStyles.mono}>{link.asin}</td>
                        <td className={consoleStyles.mono}>{link.rowKey} · {link.rowContentHash.slice(0, 12)}</td>
                        <td className={consoleStyles.mono}>v{link.baseEvidenceVersion} · {link.baseEvidenceId} · {link.baseEvidenceContentHash.slice(0, 12)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
              <p style={{ marginTop: 4, fontSize: 12.5, color: "#7b9188" }}>
                该查询及其商品行关联独立于 ASIN 模块完成度；没有改变商品证据版本、Research 资格或下方矩阵状态。
              </p>
            </div>
          ))}
        </section>
      ) : null}

      {run.allowedModules.includes("keyword_mining_trend") ? (
        <section data-testid="batch-capture-keyword-mining-query" className={consoleStyles.advancedBlock} data-tone="info">
          <h5>卖家精灵关键词挖掘</h5>
          <p style={{ marginTop: 3 }}>
            查询主体按 seedKeyword 单独标识（sellersprite:US:keyword-mining:&lt;queryFingerprint&gt;）。
            EvidenceStore 已支持查询主体的写入与只读读取；真实来源执行仍受 SellerSprite 关键词挖掘 BCR 开关
            与本机会话控制，开关关闭时不会打开浏览器。
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 8, marginTop: 8 }}>
            <label style={{ flex: "1 1 220px", fontSize: 13, fontWeight: 600 }} htmlFor={`batch-capture-keyword-mining-seed-${batchId}`}>
              seedKeyword
              <input
                id={`batch-capture-keyword-mining-seed-${batchId}`}
                value={keywordMiningSeed}
                onChange={(event) => setKeywordMiningSeed(event.target.value)}
                maxLength={160}
                disabled={busy !== null}
                placeholder="例如 silicone baking mat"
                className={consoleStyles.inlineInput}
                data-testid="batch-capture-keyword-mining-seed"
              />
            </label>
            <Button
              variant="outline" size="sm"
              data-testid="batch-capture-keyword-mining-prepare"
              onClick={() => { void onAction("prepare_keyword_mining_query", { keywordMiningQuery: { seedKeyword: keywordMiningSeed.normalize("NFC").trim() } }); }}
              disabled={!keywordMiningSeed.normalize("NFC").trim() || busy !== null}
              title="只保存 seedKeyword 查询条件，不打开 SellerSprite 页面"
            >
              仅准备关键词查询
            </Button>
          </div>
          {view.keywordMiningQueries?.length ? view.keywordMiningQueries.map((query) => (
            <div key={query.queryId} data-testid="batch-capture-keyword-mining-query-result" className={consoleStyles.advancedBlock} style={{ marginTop: 6 }}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: 700 }}>US · {query.seedKeyword}</span>
                <Badge tone={query.status === "captured" ? "emerald" : query.status === "blocked" || query.status === "human_required" ? "amber" : query.status === "failed" ? "rose" : "slate"} size="sm">
                  {query.status === "pending" ? "等待有界推进" : query.status === "captured" ? "关键词查询 Evidence 已保存" : query.status === "blocked" ? "来源暂时阻止" : query.status === "human_required" ? "需要人工处理" : "查询失败"}
                </Badge>
                <span style={{ color: "#6d8579" }}>关键词级可见行 {query.rowsObserved} · ASIN 关联 0</span>
              </div>
              <p className={consoleStyles.code} style={{ marginTop: 4 }}>查询主体：{query.querySubjectKey} · fingerprint {query.queryFingerprint?.slice(0, 16)}</p>
              {query.evidenceAttachmentId && <p className={consoleStyles.code} style={{ marginTop: 2 }}>V3 附件：{query.evidenceAttachmentId} · SHA-256 {query.evidenceContentHash}</p>}
              {query.errorCode && <p style={{ marginTop: 4, color: "#8a5c10" }}>{query.errorCode}</p>}
            </div>
          )) : <p style={{ marginTop: 6 }}>尚未建立 seedKeyword 查询；准备任务不会访问 SellerSprite，也不会改变 ASIN×模块矩阵。</p>}
        </section>
      ) : null}

      <section
        data-testid="batch-capture-external-evidence"
        data-loaded={externalEvidenceState}
        className={consoleStyles.advancedBlock}
      >
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <h5>已有手工附件（只读）</h5>
            <p style={{ marginTop: 3 }}>
              读取 EvidenceStore 里已经存在的反查 ASIN / 历史趋势 / 查询级附件。点击按钮后才请求一次，
              不轮询、不触发采集，也不计入自动采集单元或研究资格。
            </p>
          </div>
          <Button
            variant="outline" size="sm"
            data-testid="batch-capture-external-evidence-load"
            onClick={() => { void loadExternalEvidence(); }}
            disabled={busy !== null || externalEvidenceState === "loading" || !batchId.trim()}
            title="只读：不会打开浏览器、不会写入 EvidenceStore、不会改变任何采集单元状态"
          >
            {externalEvidenceState === "loading"
              ? <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              : <Eye className="mr-1.5 size-3.5" />}
            {externalEvidenceState === "loading" ? "读取中…" : "查看已有手工附件"}
          </Button>
        </div>

        {externalEvidenceState === "error" && externalEvidenceError ? (
          <p role="alert" data-testid="batch-capture-external-evidence-error" style={{ marginTop: 6, color: "#9a3a30" }}>
            {externalEvidenceError}
          </p>
        ) : null}

        {externalEvidence ? (
          <div style={{ marginTop: 6 }}>
            <p data-testid="batch-capture-external-evidence-summary" style={{ fontWeight: 700 }}>
              已有 {externalEvidence.totals.attachmentCount} 个附件（未计入自动采集单元）
            </p>
            <p style={{ marginTop: 3 }}>
              商品级（反查 ASIN / 历史趋势）：{externalEvidence.totals.productAttachmentCount} 个附件，涉及 {externalEvidence.totals.productSubjectCount} 个主体；
              查询级（商品市场 / 关键词挖掘）：{externalEvidence.totals.queryAttachmentCount} 个附件，涉及 {externalEvidence.totals.querySubjectCount} 个查询主体。
              已检查 {externalEvidence.totals.checkedSubjectCount} 个主体
              {externalEvidence.totals.failedSubjectCount > 0
                ? `，其中 ${externalEvidence.totals.failedSubjectCount} 个读取失败（不影响其他主体）`
                : ""}。
            </p>
            <p style={{ marginTop: 6, color: "#8a5c10" }}>
              仅可查看、当前不进入研究消费。查询级证据（sellersprite:* 主体）不进入 ResearchInputBundle；
              商品级附件按既有边界进入研究输入，是否已被研报实际消费需在研究侧另行核对。
            </p>
            {externalEvidenceSubjects.length ? (
              <div className={consoleStyles.tableWrap} style={{ marginTop: 6, maxHeight: 220, overflow: "auto" }}>
                <table className={consoleStyles.table}>
                  <thead><tr><th>主体</th><th>模块</th><th>附件数</th><th>最新采集时间</th></tr></thead>
                  <tbody>
                    {externalEvidenceSubjects.map((subject) => (
                      <tr key={`${subject.module}:${subject.subjectKey}`} data-testid="batch-capture-external-evidence-subject">
                        <td className={consoleStyles.mono} style={{ maxWidth: 320, wordBreak: "break-all" }}>{subject.subjectKey}</td>
                        <td>{BATCH_CAPTURE_MODULE_LABELS[subject.module] ?? subject.module}</td>
                        <td className="num">{subject.attachmentCount}</td>
                        <td>{subject.latestCapturedAt ? new Date(subject.latestCapturedAt).toLocaleString("zh-CN") : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p style={{ marginTop: 6 }}>当前没有已保存的手工附件。</p>
            )}
            {externalEvidence.totals.failedSubjectCount > 0 ? (
              <details style={{ marginTop: 6 }}>
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>读取失败明细（fail-soft，不影响其他主体）</summary>
                <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>
                  {externalEvidence.totals.failures.map((failure) => (
                    <li key={`${failure.module ?? "subject"}:${failure.subjectKey}`} style={{ wordBreak: "break-all" }}>
                      {failure.subjectKey}
                      {failure.module ? ` · ${BATCH_CAPTURE_MODULE_LABELS[failure.module] ?? failure.module}` : ""} · {failure.message}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
      </section>

      <div data-testid="batch-capture-run-module-matrix" className={consoleStyles.tableWrap}>
        <table className={consoleStyles.table}>
          <thead>
            <tr>
              <th>模块</th>
              <th>接线状态</th>
              <th>执行</th>
              <th>数据质量</th>
              <th>有效证据</th>
              <th title="分母排除本轮复用已有证据、未重新校验字段完整性的单元">字段完整（本轮采集）</th>
              <th>待处理/人工/失败</th>
            </tr>
          </thead>
          <tbody>
            {view.moduleMatrix.map((row) => (
              <tr key={row.module} data-testid={`batch-capture-run-module-${row.module}`} data-wiring={row.wiring} data-executed={row.executed ? "true" : "false"}>
                <td>{row.label}</td>
                <td>
                  <Badge
                    tone={row.wiring === "auto_wired" ? "emerald" : row.wiring === "search_phase" ? "blue" : row.wiring === "source_permission" ? "rose" : "amber"}
                    size="sm"
                    data-testid={`batch-capture-run-wiring-${row.module}`}
                  >
                    {row.wiringLabel}
                  </Badge>
                </td>
                <td>
                  {row.executed
                    ? <span>{row.handlingLabel}</span>
                    : <span style={{ color: "#8a5c10" }} data-testid={`batch-capture-run-notexecuted-${row.module}`}>{row.handlingLabel}</span>}
                </td>
                <td><Badge tone={row.dataQualityTone} size="sm">{row.dataQualityLabel}</Badge></td>
                <td className="num">{row.validEvidenceCount} / {row.itemsTotal}</td>
                <td className="num">
                  {row.fieldCompleteEligible === 0
                    ? <span title="该模块本轮全部复用已有证据，未重新校验字段完整性">—（全部复用）</span>
                    : `${row.itemsFieldComplete} / ${row.fieldCompleteEligible}`}
                </td>
                <td className="num">{row.itemsPending} / {row.itemsHuman} / {row.itemsFailed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div id="capture-console-gaps" data-testid="batch-capture-run-gaps" className={consoleStyles.advancedBlock}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
          <h4>缺口与限制（按类型分诊）</h4>
          <span style={{ fontSize: 12.5, color: "#8ba096" }}>分类只影响文案与恢复条件，不改变任何计数</span>
        </div>
        {view.gapTriage.length ? (
          <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
            {view.gapTriage.map((gap, index) => (
              <li
                key={`${gap.category}:${gap.module ?? "batch"}:${gap.reasonCode ?? index}`}
                data-testid={`batch-capture-run-gap-${gap.category}-${gap.module ?? "batch"}`}
                data-gap-category={gap.category}
                style={{ display: "flex", alignItems: "flex-start", gap: 6 }}
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" style={{ color: "#d97706" }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                    <Badge tone={GAP_TONES[gap.category]} size="sm">{gap.categoryLabel}</Badge>
                    {gap.module ? (
                      <span style={{ fontSize: 12.5, color: "#8ba096" }}>
                        {BATCH_CAPTURE_MODULE_LABELS[gap.module] ?? gap.module}
                        {gap.scope === "batch_query" ? " · 批次级" : ""}
                      </span>
                    ) : null}
                  </div>
                  <p style={{ marginTop: 2 }}>{gap.detail}</p>
                  <p style={{ marginTop: 1, fontSize: 12.5, color: "#7b9188" }}>恢复条件：{gap.recovery}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {otherGaps.length ? (
          <ul style={{ margin: "6px 0 0", paddingLeft: 16 }}>
            {otherGaps.map((gap) => <li key={gap}>{gap}</li>)}
          </ul>
        ) : null}
      </div>

      <div data-testid="batch-capture-evidence-destination" className={consoleStyles.advancedBlock} data-tone="info">
        <h5>证据去向（不声明「已消费」）</h5>
        <p style={{ marginTop: 3 }}>{BATCH_CAPTURE_EVIDENCE_DESTINATION.queryLevel}</p>
        <p style={{ marginTop: 2 }}>{BATCH_CAPTURE_EVIDENCE_DESTINATION.productLevel}</p>
      </div>

      <div data-testid="batch-capture-run-research" className={consoleStyles.advancedBlock}>
        <h5>研究资格（分层，各自独立判定）</h5>
        <ul style={{ margin: "5px 0 0", paddingLeft: 16, display: "grid", gap: 4 }}>
          <li data-testid="batch-capture-run-research-candidacy">
            <span style={{ fontWeight: 600 }}>① 证据消费候选资格：</span>
            {view.researchEligibility.evidenceCandidacy.satisfied ? "具备" : "不具备"} —— {view.researchEligibility.evidenceCandidacy.reason}
          </li>
          <li data-testid="batch-capture-run-research-sample">
            <span style={{ fontWeight: 600 }}>② 市场研究样本门槛：</span>
            {view.researchEligibility.marketSampleGate.known
              ? (view.researchEligibility.marketSampleGate.satisfied ? "已满足" : "未满足")
              : "未知"} —— {view.researchEligibility.marketSampleGate.reason}
          </li>
          <li data-testid="batch-capture-run-research-deep">
            <span style={{ fontWeight: 600 }}>③ 商品深研就绪：</span>
            {view.researchEligibility.deepResearchReadiness.known
              ? `${view.researchEligibility.deepResearchReadiness.readyItems} / ${view.researchEligibility.deepResearchReadiness.totalItems}`
              : "未知"} —— {view.researchEligibility.deepResearchReadiness.reason}
          </li>
          <li data-testid="batch-capture-run-research-consumption">
            <span style={{ fontWeight: 600 }}>④ 研报是否已消费：</span>未验证 —— {view.researchEligibility.researchReportConsumption.reason}
          </li>
        </ul>
        <p style={{ marginTop: 5, color: "#7b9188" }}>
          搜索样本完成：{view.searchSampleComplete ? "是" : "否"} · 商品深度采集完成：{view.detailCaptureComplete ? "是" : "否"}
        </p>
      </div>

      {view.pausePhase !== "none" ? (
        <div data-testid="batch-capture-run-pause-phase" data-pause-phase={view.pausePhase} className={consoleStyles.advancedBlock} data-tone="warn">
          <h5>{view.pausePhaseLabel}</h5>
          <p style={{ marginTop: 3 }}>
            事实核对 —— {view.pauseFacts.cancelRequested ? "中止" : "暂停"}请求已接收：
            {(view.pauseFacts.cancelRequested || view.pauseFacts.requested) ? "是" : "否"} ·
            在途 Worker 已停止：{view.pauseFacts.workerStopped ? "是" : "否"} ·
            运行租约已释放：{view.pauseFacts.leaseReleased ? "是" : "否"}
          </p>
          {view.pauseHint ? <p style={{ marginTop: 2 }}>{view.pauseHint}</p> : null}
        </div>
      ) : null}

      {view.legacyJobNotice ? (
        <p role="note" data-testid="batch-capture-run-legacy-notice" className={consoleStyles.advancedBlock} data-tone="warn">
          {view.legacyJobNotice}
        </p>
      ) : null}

      {techSlot}
    </>
  );

  return (
    <CaptureConsoleView
      model={consoleModel}
      ariaLabel={CAPTURE_CONSOLE_ARIA_LABEL}
      error={errorNode}
      notice={noticeNode}
      topAlert={topAlert}
      planSlot={planSlot}
      advanced={advanced}
      footer={footer}
      busy={busy !== null}
      advancedOpen={advancedOpen}
      onAdvancedOpenChange={setAdvancedOpen}
      onIssueAction={onIssueAction}
      onOpenPlan={openPlan}
      onOpenAdvanced={openAdvancedAndScroll}
    />
  );
}
