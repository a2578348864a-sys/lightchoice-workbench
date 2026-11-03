"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Loader2, RefreshCw, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { CapturePlanPanel } from "@/components/source/CapturePlanPanel";
import {
  BatchCaptureRunPanel,
  type BatchCaptureRunLegacyJobSummary,
} from "@/components/source/BatchCaptureRunPanel";
import { CaptureMissionShell, type MissionPhaseTone } from "@/components/source/capture-mission-control/CaptureMissionShell";
import { CaptureMissionPlan } from "@/components/source/capture-mission-control/CaptureMissionPlan";
import { BASIC_CAPTURE_MODULE_IDS, BASIC_CAPTURE_MODULE_LABELS } from "@/lib/sourceLayer/captureStrategy/marketCapturePlan";
import { fetchBatchCaptureRun } from "@/lib/client/batchCaptureRunClient";
import {
  BATCH_CAPTURE_EVIDENCE_DESTINATION,
  describeBatchCaptureRun,
} from "@/lib/sourceLayer/batchCaptureRunPresentation";
import type { BatchCaptureDeepResearchItems, BatchCaptureSampleGate } from "@/lib/sourceLayer/batchCaptureRunPresentation";
import type { BatchCaptureRunSnapshot } from "@/lib/sourceLayer/batchCaptureRunSnapshot";
import type { ModuleCoverageSummaryEntry } from "@/lib/sourceLayer/moduleCoverageSummary";
import styles from "@/components/source/capture-mission-control/capture-mission-control.module.css";

export type CaptureTaskWorkspaceProps = {
  batchId: string;
  batchName: string;
  marketplace: string | null;
  sourceLabel: string;
  batchCapacity: number;
  moduleCoverage?: readonly ModuleCoverageSummaryEntry[];
  sampleGate?: BatchCaptureSampleGate | null;
  deepResearchItems?: BatchCaptureDeepResearchItems | null;
  legacyJob?: BatchCaptureRunLegacyJobSummary;
  existingRunStatus?: string | null;
  refreshToken?: number;
  onClose: () => void;
  onConfirmed?: (result: { created: boolean; runStatus: string | null }) => void;
  onExpansionComplete?: () => void;
  onRunResolved?: (hasRun: boolean) => void;
  /** 把本次读取的完整 tri-state 快照回报给父组件（摘要/历史共用同一权威）。 */
  onSnapshot?: (snapshot: BatchCaptureRunSnapshot) => void;
  onOpenSingleAsin?: () => void;
  /** 仅在批次尚无市场研究且有效样本达门槛时传入；由父级执行既有创建合同。 */
  onCreateMarketScan?: () => void;
  supportsCapturePlan?: boolean;
};

/**
 * 「采集任务驾驶舱」信息架构：
 * 大尺寸沉浸式工作面板 → 任务 Hero → 模式/数量 → 证据流 → 高级范围
 * → 固定底部主操作；已有任务时复用真实 BatchCaptureRun 运行面板。
 *
 * 业务约束：
 * - 默认范围 = 四项基础能力；补充能力需显式勾选并进入服务端指纹。
 * - Run 控制状态 ≠ 真实证据结果；执行结束 ≠ 资料完整。
 * - 计划确认仍走唯一 capture-plan 合同；不创建第二套任务模型。
 */
export function CaptureTaskWorkspace({
  batchId,
  batchName,
  marketplace,
  sourceLabel,
  batchCapacity,
  moduleCoverage = [],
  sampleGate,
  deepResearchItems,
  legacyJob,
  existingRunStatus = null,
  refreshToken = 0,
  onClose,
  onConfirmed,
  onExpansionComplete,
  onRunResolved,
  onSnapshot,
  onOpenSingleAsin,
  onCreateMarketScan,
  supportsCapturePlan = true,
}: CaptureTaskWorkspaceProps) {
  const [overview, setOverview] = useState<{
    loading: boolean;
    hasRun: boolean;
    status: string | null;
    statusLabel: string;
    tone: "emerald" | "blue" | "amber" | "rose" | "slate";
    statusExplanation: string;
    authorizedItemLimit: number | null;
    lastErrorCode: string | null;
    canDrive: boolean;
    canPause: boolean;
    canResume: boolean;
    canCancel: boolean;
    primaryAction: { label: string; kind: "drive" | "resume" | "refresh" | "plan" } | null;
    gapText: string | null;
    runGeneration: number | null;
  }>({
    loading: true,
    hasRun: false,
    status: null,
    statusLabel: "读取中",
    tone: "slate",
    statusExplanation: "",
    authorizedItemLimit: null,
    lastErrorCode: null,
    canDrive: false,
    canPause: false,
    canResume: false,
    canCancel: false,
    primaryAction: null,
    gapText: null,
    runGeneration: null,
  });
  const [showPlanDetails, setShowPlanDetails] = useState(false);
  const [planScopeBlocked, setPlanScopeBlocked] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  /** 是否已完成过一次 overview 读取；只有首次才允许用骨架替换整块内容。 */
  const [loadedOnce, setLoadedOnce] = useState(false);
  const snapshotInitialized = useRef(false);

  const loadOverview = useCallback(async () => {
    setOverview((prev) => ({ ...prev, loading: true }));
    setOverviewError(null);
    if (!snapshotInitialized.current) {
      snapshotInitialized.current = true;
      onSnapshot?.({ state: "loading" });
    }
    try {
      const payload = await fetchBatchCaptureRun(batchId);
      if (!payload.ok) {
        setOverview((prev) => ({ ...prev, loading: false }));
        setLoadedOnce(true);
        setOverviewError(payload.errorMessage);
        // 读取失败不是「无任务」：必须回报 error，不能回传 false。
        onSnapshot?.({ state: "error", message: payload.errorMessage, at: Date.now() });
        return;
      }
      const run = payload.run;
      const view = describeBatchCaptureRun({
        run,
        sampleGate: sampleGate ?? undefined,
        deepResearchItems: deepResearchItems ?? undefined,
      });
      onSnapshot?.(run
        ? { state: "present", run, view, at: Date.now() }
        : { state: "absent", at: Date.now() });
      let primaryAction: { label: string; kind: "drive" | "resume" | "refresh" | "plan" } | null = null;
      if (!run) primaryAction = { label: "配置采集计划", kind: "plan" };
      else if (view.actions.canDrive) primaryAction = { label: view.status === "PAUSED" ? "继续自动采集" : "开始自动采集", kind: "drive" };
      else if (view.actions.canResume) primaryAction = { label: "处理后继续", kind: "resume" };
      else primaryAction = { label: "刷新任务状态", kind: "refresh" };

      setOverview({
        loading: false,
        hasRun: Boolean(run),
        status: run?.status ?? null,
        statusLabel: view.statusLabel,
        tone: view.tone,
        statusExplanation: view.statusExplanation,
        authorizedItemLimit: run?.authorizedItemLimit ?? null,
        lastErrorCode: view.lastErrorCode ?? null,
        canDrive: view.actions.canDrive,
        canPause: view.actions.canPause,
        canResume: view.actions.canResume,
        canCancel: view.actions.canCancel,
        primaryAction,
        gapText: view.completionHint ?? view.gaps[0] ?? null,
        runGeneration: view.runGeneration ?? null,
      });
      onRunResolved?.(Boolean(run));
      setLoadedOnce(true);
    } catch (error) {
      setOverview((prev) => ({ ...prev, loading: false }));
      setLoadedOnce(true);
      const message = error instanceof Error ? error.message : "读取采集任务状态失败";
      setOverviewError(message);
      onSnapshot?.({ state: "error", message, at: Date.now() });
    }
  }, [batchId, sampleGate, deepResearchItems, onRunResolved, onSnapshot]);

  // 父级每次渲染都会新建 sampleGate/onSnapshot；只按值键和最新引用触发，避免读取循环。
  const sampleGateKey = sampleGate
    ? `${sampleGate.sufficient ? 1 : 0}:${sampleGate.current}:${sampleGate.required}`
    : "none";
  const deepResearchKey = deepResearchItems
    ? `${deepResearchItems.ready}:${deepResearchItems.total}`
    : "none";
  const loadOverviewRef = useRef(loadOverview);
  useEffect(() => { loadOverviewRef.current = loadOverview; });
  useEffect(() => {
    void loadOverviewRef.current();
  }, [batchId, refreshToken, sampleGateKey, deepResearchKey]);

  const ended = overview.status === "COMPLETED" || overview.status === "CANCELLED" || overview.status === "FAILED" || overview.status === "PARTIAL";

  if (!supportsCapturePlan) {
    return null;
  }

  const phase: { label: string; tone: MissionPhaseTone } = overview.loading && !loadedOnce
    ? { label: "读取中", tone: "running" }
    : overviewError && !overview.hasRun
      ? { label: "状态未知", tone: "error" }
      : !overview.hasRun
        ? (planScopeBlocked ? { label: "执行受限", tone: "warn" } : { label: "准备采集", tone: "ready" })
        : overview.lastErrorCode === "LOCAL_ENVIRONMENT_REQUIRED" && !ended
          ? { label: "执行受限", tone: "warn" }
          : overview.status === "COMPLETED"
          ? { label: "已完成", tone: "done" }
          : overview.status === "FAILED" || overview.status === "CANCELLED"
            ? { label: ended ? "已结束" : "运行异常", tone: "warn" }
            : overview.status === "PARTIAL"
              ? { label: "部分完成", tone: "warn" }
              : overview.status === "HUMAN_REQUIRED"
                ? { label: "需人工处理", tone: "warn" }
                : overview.status === "PAUSED"
                  ? { label: "已暂停", tone: "warn" }
                  : { label: "采集运行中", tone: "running" };

  const shell = (children: ReactNode, padded = false) => (
    <CaptureMissionShell
      ariaLabel="采集任务驾驶舱"
      batchName={batchName}
      marketplace={marketplace}
      sourceLabel={sourceLabel}
      phaseLabel={phase.label}
      phaseTone={phase.tone}
      onClose={onClose}
      padded={padded}
    >
      {children}
    </CaptureMissionShell>
  );

  if (overview.loading && !overview.hasRun && !loadedOnce) {
    return shell(
      <div className={styles.missionLoading} role="status">
        <span className={styles.loadingOrb}><Loader2 size={22} className={styles.spin} /></span>
        <p>正在读取本轮采集与服务端计划…</p>
      </div>,
    );
  }

  if (overviewError && !overview.hasRun) {
    return shell(
      <div className={styles.missionError} role="alert">
        <span className={styles.loadingOrb}><ShieldAlert size={22} /></span>
        <h3>执行记录暂不可读</h3>
        <p>{overviewError}</p>
        <div>
          <Button variant="outline" size="sm" onClick={() => { void loadOverview(); }}>
            {overview.loading ? <Loader2 size={14} className={styles.spin} /> : <RefreshCw size={14} />}
            重新读取任务
          </Button>
        </div>
      </div>,
    );
  }

  if (!overview.hasRun) {
    return shell(
      <CaptureMissionPlan
        batchId={batchId}
        batchName={batchName}
        marketplace={marketplace}
        sourceLabel={sourceLabel}
        batchCapacity={batchCapacity}
        moduleCoverage={moduleCoverage}
        existingRunStatus={existingRunStatus}
        onConfirmed={(result) => {
          onConfirmed?.({ created: result.created, runStatus: result.runStatus });
          void loadOverview();
        }}
        onOpenSingleAsin={onOpenSingleAsin}
        onExecutionScope={setPlanScopeBlocked}
      />,
    );
  }

  const legacyPlanPanel = (
    <CapturePlanPanel
      batchId={batchId}
      batchCapacity={batchCapacity}
      existingRunStatus={existingRunStatus}
      onConfirmed={(result) => {
        onConfirmed?.({ created: result.created, runStatus: result.runStatus });
        void loadOverview();
      }}
      onExpansionComplete={() => {
        onExpansionComplete?.();
        void loadOverview();
      }}
    />
  );

  const planDetails = (
    <details
      id="capture-task-plan-details"
      data-testid="capture-task-plan-details"
      open={showPlanDetails}
      onToggle={(event) => setShowPlanDetails((event.target as HTMLDetailsElement).open)}
      className="rounded-xl border border-slate-200 bg-white"
    >
      <summary className="cursor-pointer px-3.5 py-2.5 text-sm font-bold text-slate-800">
        {ended ? "配置新一轮采集" : "查看本轮计划与授权范围"}
      </summary>
      <div className="border-t border-slate-100 p-3">
        {showPlanDetails ? legacyPlanPanel : null}
      </div>
    </details>
  );

  const techDetails = (
    <details data-testid="capture-task-tech-details" className="rounded-xl border border-slate-200 bg-white">
      <summary className="cursor-pointer px-3.5 py-2.5 text-sm font-semibold text-slate-700">
        执行明细与技术说明
      </summary>
      <div className="border-t border-slate-100 px-3.5 py-3 space-y-2 text-[13px] text-slate-600">
        <p>{BATCH_CAPTURE_EVIDENCE_DESTINATION.productLevel}</p>
        <p>{BATCH_CAPTURE_EVIDENCE_DESTINATION.queryLevel}</p>
        <p>
          基础能力口径：{BASIC_CAPTURE_MODULE_IDS.map((id) => BASIC_CAPTURE_MODULE_LABELS[id]).join("、")}。
          执行器启动仅表示控制流程开始；真实结果以证据附件为准。
        </p>
        {overview.lastErrorCode ? <p>最近错误码：{overview.lastErrorCode}</p> : null}
        <Button variant="outline" size="sm" onClick={() => { void loadOverview(); }}>
          重新读取权威状态
        </Button>
        {overview.canCancel ? (
          <p className="text-amber-800">
            中止动作位于运行面板；中止后历史运行与已保存证据保留。
          </p>
        ) : null}
      </div>
    </details>
  );

  return shell(
    <div className={styles.runSurface}>
      {ended ? (
        <div className={styles.runResultBar} data-testid="capture-mission-result-bar">
          <div>
            <b>{overview.statusLabel}</b>
            <span>
              {overview.authorizedItemLimit !== null ? `本轮授权 ${overview.authorizedItemLimit} 件` : "本轮授权范围读取中"}
              {" · "}
              {sampleGate?.sufficient === true
                ? `批次有效样本 ${sampleGate.current} / ${sampleGate.required}，已达到研究门槛（整个批次的研究资格，与本轮处理件数是两个口径）`
                : "批次有效样本与研究资格请以批次页合同为准"}
              {overview.status === "PARTIAL" ? " · 本轮任务部分完成，不代表本轮采集全部成功" : ""}
            </span>
          </div>
          <div className={styles.runResultActions}>
            {sampleGate?.sufficient === true && onCreateMarketScan ? (
              <button type="button" className={styles.runResearchButton} onClick={onCreateMarketScan} data-testid="capture-mission-create-research">
                建立市场研究 <ArrowRight size={13} />
              </button>
            ) : null}
            <button type="button" className={styles.runResultButton} onClick={onClose} data-testid="capture-mission-view-results">
              查看采集结果 <ArrowRight size={14} />
            </button>
          </div>
        </div>
      ) : null}

      <BatchCaptureRunPanel
        batchId={batchId}
        refreshToken={refreshToken}
        availableItemCount={batchCapacity}
        legacyJob={legacyJob}
        sampleGate={sampleGate}
        deepResearchItems={deepResearchItems ?? undefined}
        onRunResolved={(hasRun) => {
          onRunResolved?.(hasRun);
        }}
        onSnapshot={onSnapshot}
        planSlot={planDetails}
        techSlot={techDetails}
        onOpenPlan={() => {
          setShowPlanDetails(true);
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              document.getElementById("capture-task-plan-details")?.scrollIntoView({ behavior: "smooth", block: "start" });
            });
          });
        }}
      />
    </div>,
    true,
  );
}
