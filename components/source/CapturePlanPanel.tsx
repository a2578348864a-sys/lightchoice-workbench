"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CapturePlanExpansionPanel } from "@/components/source/CapturePlanExpansionPanel";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import {
  confirmCapturePlan,
  fetchCapturePlan,
  type CapturePlanConfirmResult,
  type CapturePlanExistingRun,
  type CapturePlanPreviewResult,
} from "@/lib/client/capturePlanClient";
import { BATCH_CAPTURE_RUN_STATUS_LABELS } from "@/lib/sourceLayer/batchCaptureRunPresentation";
import {
  MARKET_CAPTURE_MODULE_LABELS,
  MARKET_CAPTURE_STRATEGY_DESCRIPTIONS,
  MARKET_CAPTURE_STRATEGY_IDS,
  MARKET_CAPTURE_STRATEGY_LABELS,
  BASIC_CAPTURE_MODULE_IDS,
  BASIC_CAPTURE_MODULE_LABELS,
  SUPPLEMENTAL_CAPTURE_MODULE_IDS,
  classifyMarketCapturePlanModules,
  type MarketCaptureModuleId,
  type MarketCapturePlan,
  type MarketCaptureStrategyId,
  type MarketModulePlanStatus,
} from "@/lib/sourceLayer/captureStrategy/marketCapturePlan";

/**
 * 市场采集计划面板：策略选择 → 计划预览（八模块矩阵 / 预算 / 受限原因）→ 一次确认。
 *
 * 设计约束：
 * - 只展示服务端权威计划；页面不自行推算预算或模块覆盖；
 * - 「计划待确认 / 计划已确认 / 任务已创建 / 执行器已启动 / 等待执行条件 / 需要人工处理 /
 *   已停止 / 执行器状态未知 / 已取得证据」是**互相独立**的状态，不合并成一个「成功」；
 * - **Capture Run 的控制状态不等于真实来源采集状态**：执行器启动仅表示控制流程开始，
 *   真实采集进度与证据始终以「批次自动采集」面板的回执与 Evidence 为准；
 * - 未自动接线的模块如实显示为「未自动接线 / 需来源输入」，不显示为已完成；
 * - 已创建任务绑定原计划指纹：切换策略仅预览，不能悄悄修改正在运行的任务，也不能扩大原授权预算；
 * - 本组件被市场采集与商品深研共用，因此不接受业务专属的写死文案。
 */

const STATUS_LABELS: Record<MarketModulePlanStatus, string> = {
  scheduled_auto: "本轮执行",
  scheduled_sampled: "分段抽样执行",
  requires_source_input: "需来源输入",
  not_auto_wired: "未自动接线",
  not_scheduled: "本轮不安排",
};

const STATUS_TONES: Record<MarketModulePlanStatus, "emerald" | "blue" | "amber" | "slate"> = {
  scheduled_auto: "emerald",
  scheduled_sampled: "blue",
  requires_source_input: "amber",
  not_auto_wired: "amber",
  not_scheduled: "slate",
};

/**
 * 确认后的执行状态表述（A3：Mock / 执行器启动 / 等待条件必须与真实采集成功分开）。
 *
 * 铁律：`driveStarted` 只证明控制流程被启动，**不证明**任何真实 Amazon 商品采集成功；
 * 真正的完成状态来自可信 Evidence 与模块回执（由「批次自动采集」面板展示）。
 */
export function describeCapturePlanExecutionState(input: {
  created: boolean;
  runStatus: string | null;
  driveStarted: boolean;
  driveError: string | null;
}): { label: string; note: string } {
  if (input.driveError) {
    return {
      label: "任务已创建（执行器未启动）",
      note: `执行器未能启动（${shortRunErrorReason(input.driveError)}）；已创建的任务不会丢失，真实采集尚未开始。可稍后重试，或在下方面板手动推进。`,
    };
  }
  if (!input.created) {
    return {
      label: "任务已存在（幂等复用）",
      note: "该批次已按同一计划创建过任务；本次为幂等复用，没有重复创建，也没有扩大授权。",
    };
  }
  if (input.driveStarted) {
    return {
      label: "任务已创建，执行器已启动",
      note: "执行器已启动仅表示控制流程开始；真实来源采集进度与证据以「批次自动采集」面板回执为准，未取得证据的模块不会显示为已完成。",
    };
  }
  return {
    label: "任务已创建（等待执行条件）",
    note: "任务已创建但执行器尚未启动；满足执行条件后自动推进，或可在下方面板手动推进。",
  };
}

/**
 * 错误码 → 简短中文原因（用于「（原因）」句式），未知码保留原始码以便排查。
 * 与「批次自动采集」面板的 ERROR_REASON_LABELS 同一语义，只是句式更短。
 */
export function shortRunErrorReason(code: string): string {
  if (code === "LOCAL_ENVIRONMENT_REQUIRED") return "本地采集未启用";
  if (code === "BATCH_CAPTURE_JOB_BUSY") return "已有执行器在推进该批次";
  if (code === "BATCH_CAPTURE_LEASE_BUSY") return "采集执行租约被占用";
  if (code === "BATCH_CAPTURE_CAS_CONFLICT") return "状态已被其他操作更新";
  return code;
}

/** 采集环境探测结果：enabled 为 null 表示未知（探测失败），不得猜测。 */
export type CaptureEnvironmentProbe = { enabled: boolean } | null;

/** 默认环境探测：只读 GET，不启动浏览器、不触发采集；失败时返回 null（不显示提示）。 */
async function defaultEnvironmentProbe(): Promise<CaptureEnvironmentProbe> {
  try {
    const response = await fetch("/api/source-layer/capture-environment", {
      method: "GET",
      cache: "no-store",
      headers: buildAccessHeaders(),
    });
    const payload = await response.json() as { ok?: boolean; data?: { amazon?: { enabled?: unknown } } };
    if (!response.ok || payload.ok !== true) return null;
    const enabled = payload.data?.amazon?.enabled;
    return typeof enabled === "boolean" ? { enabled } : null;
  } catch {
    return null;
  }
}

/** 运行控制状态 → 中文标签；未知状态码原样透出，不猜测。 */
export function describeRunControlStatus(status: string | null): string {
  if (!status) return "未知";
  const label = (BATCH_CAPTURE_RUN_STATUS_LABELS as Record<string, string | undefined>)[status];
  return label ?? `未知状态（${status}）`;
}

export type CapturePlanPanelProps = {
  batchId: string;
  /** 批次可用商品数（来自批次摘要，仅用于展示；服务端会重新推导权威容量）。 */
  batchCapacity: number;
  /** 默认策略：完整市场采集为主要模式。 */
  defaultStrategyId?: MarketCaptureStrategyId;
  /** 默认市场目标数量。 */
  defaultTargetItemCount?: number;
  /** 已存在运行时的状态摘要（由 BatchCaptureRun 面板提供，避免两处状态打架）。 */
  existingRunStatus?: string | null;
  /** 预览结果变化时通知父组件（用于刷新批次状态）。 */
  onPlanLoaded?: (plan: MarketCapturePlan) => void;
  /** 确认成功后通知父组件刷新运行状态。 */
  onConfirmed?: (result: Extract<CapturePlanConfirmResult, { ok: true }>) => void;
  /** 扩充确认完成后刷新批次商品与 Run 状态。 */
  onExpansionComplete?: () => void | Promise<void>;
  /** 测试注入：预览。 */
  previewer?: typeof fetchCapturePlan;
  /** 测试注入：确认。 */
  confirmer?: typeof confirmCapturePlan;
  /** 测试注入：采集环境探测（默认只读 GET capture-environment）。 */
  environmentProber?: () => Promise<CaptureEnvironmentProbe>;
};

/** 计划 ↔ 任务绑定状态（A4：已创建任务必须绑定原计划指纹，切换策略不得篡改它）。 */
type CapturePlanTaskLock =
  | { kind: "none" }
  | { kind: "unknown_read_failed" }
  | {
      kind: "locked";
      source: "server" | "session";
      fingerprint: string;
      strategyId: string | null;
      authorizedItemCount: number | null;
      runStatus: string | null;
    };

export function CapturePlanPanel({
  batchId,
  batchCapacity,
  defaultStrategyId = "full_market_capture",
  defaultTargetItemCount,
  existingRunStatus = null,
  onPlanLoaded,
  onConfirmed,
  onExpansionComplete,
  previewer,
  confirmer,
  environmentProber,
}: CapturePlanPanelProps) {
  const preview = previewer ?? fetchCapturePlan;
  const confirm = confirmer ?? confirmCapturePlan;
  const probeEnvironment = environmentProber ?? defaultEnvironmentProbe;

  const [strategyId, setStrategyId] = useState<MarketCaptureStrategyId>(defaultStrategyId);
  /**
   * 默认市场目标数量 = 当前批次可用商品数。
   *
   * 为什么不是固定默认值：用户的心智是「把这批商品采完」。若默认只填 1 件，
   * 用户看到「目标 1 件」却以为自己会采完整批，属于误导性默认值。
   * 这里以批次容量为默认，用户仍可手动改小或改大（服务端会按硬上限裁剪并如实报告）。
   */
  const [targetCount, setTargetCount] = useState<number>(() => {
    if (typeof defaultTargetItemCount === "number" && defaultTargetItemCount > 0) return defaultTargetItemCount;
    return Math.max(1, batchCapacity || 1);
  });
  const [plan, setPlan] = useState<MarketCapturePlan | null>(null);
  /** 本轮补充能力选择（默认空 = 仅四项基础能力）。 */
  const [supplementalModules, setSupplementalModules] = useState<MarketCaptureModuleId[]>([]);
  const [showSupplemental, setShowSupplemental] = useState(false);
  const [batchContext, setBatchContext] = useState<{
    batchCapacity: number;
    searchNavigationKnown: boolean;
  }>({ batchCapacity: 0, searchNavigationKnown: true });
  const [existingRun, setExistingRun] = useState<CapturePlanExistingRun | null>(null);
  const [existingRunReadFailed, setExistingRunReadFailed] = useState(false);
  /** 服务端实际生效的批量采集能力；null = 尚未从预览接口拿到（按禁用处理，避免误点）。 */
  const [batchScopeAllowed, setBatchScopeAllowed] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<{ tone: "info" | "success" | "error"; message: string } | null>(null);
  const [confirmation, setConfirmation] = useState<Extract<CapturePlanConfirmResult, { ok: true }> | null>(null);
  const [showMatrix, setShowMatrix] = useState(false);
  const [environment, setEnvironment] = useState<CaptureEnvironmentProbe>(null);
  const loadedRef = useRef(false);
  // D2-1C：目标数量从初始回退值收敛到批次容量时会连发两次预览；
  // 无序号守卫时慢的旧请求（易 409）会覆盖新结果，导致面板空白。
  const loadSeqRef = useRef(0);
  const aliveRef = useRef(true);

  /**
   * 采集环境探测（只读）：计划确认前让用户看到「当前本地采集未启用」这一真实限制，
   * 而不是确认后才在运行面板发现执行器被门禁阻止。
   * 探测失败（null）时保持未知、不显示任何断言。
   */
  const refreshEnvironment = useCallback(async () => {
    const result = await probeEnvironment();
    if (!aliveRef.current) return;
    setEnvironment(result);
  }, [probeEnvironment]);

  useEffect(() => {
    aliveRef.current = true;
    void refreshEnvironment();
    return () => { aliveRef.current = false; };
  }, [refreshEnvironment, batchId]);

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!batchId) return;
    const seq = ++loadSeqRef.current;
    setLoading(true);
    const result: CapturePlanPreviewResult = await preview({
      batchId,
      strategyId,
      marketTargetItemCount: targetCount,
      supplementalModules,
    });
    if (seq !== loadSeqRef.current) return; // 过期响应：已有更新请求在途，弃用旧结果
    setLoading(false);
    if (!result.ok) {
      setPlan(null);
      setNotice({ tone: "error", message: result.errorMessage });
      return;
    }
    setPlan(result.plan);
    setBatchContext({
      batchCapacity: result.batchContext.batchCapacity,
      searchNavigationKnown: result.batchContext.searchNavigationKnown,
    });
    setExistingRun(result.existingRun);
    setExistingRunReadFailed(result.existingRunReadFailed);
    // 以服务端返回为准，不在前端推断权限。
    setBatchScopeAllowed(result.acquisition?.batchCaptureScopeAllowed ?? false);
    setNotice(null);
    onPlanLoaded?.(result.plan);
    if (!options.silent) loadedRef.current = true;
  }, [batchId, preview, strategyId, targetCount, supplementalModules, onPlanLoaded]);

  useEffect(() => {
    void load({ silent: true });
    // 批次、策略或目标数量变化时重新取权威计划。
  }, [load]);

  /**
   * 批次商品是异步加载的：面板首次挂载时 batchCapacity 往往还是 0/未知。
   * 此时不能把「目标 1 件」当成用户的选择并一直保留 —— 那会让用户以为采完整批。
   * 因此仅在「用户尚未手动改过目标」且「目标当前仍是初始回退值」时，跟随批次容量收敛。
   */
  const userEditedTargetRef = useRef(false);
  useEffect(() => {
    if (userEditedTargetRef.current) return;
    if (typeof defaultTargetItemCount === "number" && defaultTargetItemCount > 0) return;
    if (batchCapacity < 1) return;
    setTargetCount((current) => (current === 1 ? batchCapacity : current));
  }, [batchCapacity, defaultTargetItemCount]);

  /**
   * 任务锁定（A4）：
   * - 服务端已存在绑定计划的 Run → 锁定，切换策略仅预览；
   * - **终态（已中止/失败）不锁定**：运行面板明确引导「请在上方重新确认创建新代次」，
   *   若这里仍锁定，确认按钮会被禁用，用户被锁死在「无法重建」的矛盾状态（D2-1E 修复）；
   *   服务端 start 对 CANCELLED/FAILED 一律创建新代次，不会复用旧代次；
   * - 本会话刚确认 → 同样锁定（刷新后由服务端 existingRun 接管）；
   * - Run 回执读取失败 → 未知，不得显示成「计划待确认」，也不假装没有任务。
   */
  const previousRunTerminal = existingRun !== null
    && (existingRun.status === "CANCELLED" || existingRun.status === "FAILED");
  const taskLock: CapturePlanTaskLock = useMemo(() => {
    if (existingRunReadFailed) return { kind: "unknown_read_failed" };
    if (existingRun?.planFingerprint && !previousRunTerminal) {
      return {
        kind: "locked",
        source: "server",
        fingerprint: existingRun.planFingerprint,
        strategyId: existingRun.planStrategyId,
        authorizedItemCount: existingRun.authorizedItemLimit,
        runStatus: existingRun.status,
      };
    }
    if (confirmation) {
      return {
        kind: "locked",
        source: "session",
        fingerprint: confirmation.plan.planFingerprint,
        strategyId: confirmation.plan.strategyId,
        authorizedItemCount: confirmation.plan.authorizedItemCount,
        runStatus: confirmation.runStatus,
      };
    }
    return { kind: "none" };
  }, [confirmation, existingRun, existingRunReadFailed, previousRunTerminal]);

  const isLocked = taskLock.kind === "locked";
  const boundToCurrentPlan = isLocked && plan !== null && taskLock.fingerprint === plan.planFingerprint;
  const previewingOtherPlan = isLocked && plan !== null && taskLock.fingerprint !== plan.planFingerprint;
  const confirmedStrategyLabel = isLocked && taskLock.strategyId
    ? MARKET_CAPTURE_STRATEGY_LABELS[taskLock.strategyId as MarketCaptureStrategyId] ?? taskLock.strategyId
    : null;

  const moduleCounts = useMemo(
    () => (plan ? classifyMarketCapturePlanModules(plan) : null),
    [plan],
  );

  const confirmPlan = async () => {
    if (!plan) return;
    // A4：已有任务绑定其他计划时，前端不提供确认入口（服务端同样会拒绝冲突 Run）。
    if (previewingOtherPlan) {
      setNotice({
        tone: "error",
        message: "当前预览的计划与已确认任务不同；已确认任务不会被修改，请刷新后以服务端状态为准。",
      });
      return;
    }
    setConfirming(true);
    const result = await confirm({
      batchId,
      strategyId,
      marketTargetItemCount: targetCount,
      supplementalModules,
      planFingerprint: plan.planFingerprint,
    });
    setConfirming(false);
    if (!result.ok) {
      setNotice({ tone: "error", message: result.errorMessage });
      return;
    }
    setConfirmation(result);
    setNotice({
      tone: result.driveError ? "info" : "success",
      message: result.driveError
        ? `采集任务已创建，但执行器未启动（${shortRunErrorReason(result.driveError)}）。可稍后重试，已创建的任务不会丢失。`
        : result.created
          ? "采集计划已确认，任务已创建并按计划自动分批推进；真实采集进度以执行回执与证据为准。"
          : "该批次已按同一计划创建过任务；本次为幂等复用，没有重复创建。",
    });
    onConfirmed?.(result);
  };

  const autoEntries = plan?.entries.filter((entry) => entry.autoExecutable && entry.status !== "not_scheduled") ?? [];
  const limitedEntries = plan?.entries.filter((entry) => !entry.autoExecutable && entry.status !== "not_scheduled") ?? [];

  const stateBadge = (() => {
    if (taskLock.kind === "unknown_read_failed") return "采集任务状态未知（回执读取失败）";
    if (isLocked) return `已有采集任务：${describeRunControlStatus(taskLock.runStatus)}`;
    if (previousRunTerminal && existingRun) {
      return `上一个任务${describeRunControlStatus(existingRun.status)}，可重新确认`;
    }
    if (existingRunStatus) return `已有采集任务（${existingRunStatus}）`;
    return "计划待确认";
  })();

  return (
    <section
      data-testid="capture-plan-panel"
      className="rounded-xl border border-slate-200 bg-white p-3.5"
      aria-label="市场采集计划"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-800">市场采集计划 / Capture Plan</h3>
          <p className="mt-0.5 text-[13px] text-slate-500">
            选择策略并确认一次，系统按计划自动分批采集；计划未确认前不会采集任何商品。
          </p>
        </div>
        <Badge
          tone={isLocked ? "blue" : taskLock.kind === "unknown_read_failed" ? "amber" : "amber"}
          data-testid="capture-plan-state-badge"
        >
          {stateBadge}
        </Badge>
      </header>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <fieldset className="min-w-0">
          <legend className="text-xs font-medium text-slate-600">采集策略</legend>
          <div className="mt-1.5 space-y-1.5">
            {MARKET_CAPTURE_STRATEGY_IDS.map((id) => (
              <label
                key={id}
                className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-xs ${
                  strategyId === id ? "border-slate-800 bg-slate-50" : "border-slate-200 bg-white hover:border-slate-300"
                }`}
              >
                <input
                  type="radio"
                  name={`capture-strategy-${batchId}`}
                  className="mt-0.5"
                  checked={strategyId === id}
                  disabled={confirming}
                  onChange={() => { setStrategyId(id); }}
                  data-testid={`capture-strategy-${id}`}
                />
                <span className="min-w-0">
                  <span className="block font-semibold text-slate-800">{MARKET_CAPTURE_STRATEGY_LABELS[id]}</span>
                  <span className="mt-0.5 block text-[13px] leading-snug text-slate-500">
                    {MARKET_CAPTURE_STRATEGY_DESCRIPTIONS[id]}
                  </span>
                  {isLocked && taskLock.strategyId === id ? (
                    <span className="mt-0.5 block text-[13px] font-medium text-blue-700">当前已确认策略</span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
          {isLocked ? (
            <p data-testid="capture-plan-preview-only-hint" className="mt-1.5 rounded-md border border-sky-200 bg-sky-50 px-2 py-1.5 text-[13px] text-sky-900">
              已有已确认的采集任务。此处切换策略仅用于预览，不影响当前任务，也不能通过前端切换扩大原授权预算。
            </p>
          ) : null}
          <p data-testid="capture-plan-four-basic-hint" className="mt-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-[13px] text-slate-700">
            业务默认覆盖四项基础能力：商品样本、商品信息、变体结构、评论材料。
            SellerSprite 深度 / 反查 / 关键词 / 历史趋势属于补充能力，仅在计划中明确授权后才执行。
          </p>
        </fieldset>

        <div className="min-w-0 space-y-2">
          <label className="block text-xs font-medium text-slate-600" htmlFor={`capture-target-${batchId}`}>
            市场目标数量（商品）
          </label>
          <div className="flex items-center gap-2">
            <input
              id={`capture-target-${batchId}`}
              data-testid="capture-target-count"
              type="number"
              min={1}
              max={200}
              step={1}
              value={targetCount}
              disabled={confirming || isLocked}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                userEditedTargetRef.current = true;
                setTargetCount(Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1);
              }}
              className="h-8 w-24 rounded-md border border-slate-300 px-2 text-sm disabled:bg-slate-100 disabled:text-slate-500"
            />
            <span className="text-[13px] text-slate-500">
              当前批次可用 <strong data-testid="capture-batch-capacity">{batchCapacity}</strong> 件
              {plan ? ` · 本次授权 ${plan.authorizedItemCount} 件` : null}
            </span>
          </div>
          {isLocked ? (
            <p data-testid="capture-plan-target-locked" className="text-[13px] text-slate-500">
              目标数量已随已确认任务锁定
              {isLocked && taskLock.authorizedItemCount !== null ? `（授权 ${taskLock.authorizedItemCount} 件）` : ""}；
              调整目标需先中止当前任务并按新计划重新确认。
            </p>
          ) : null}
          {plan && plan.authorizedItemCount < plan.marketTargetItemCount ? (
            <p data-testid="capture-plan-authorized-less-than-target" className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[13px] text-amber-900">
              本次授权 {plan.authorizedItemCount} 件少于市场目标 {plan.marketTargetItemCount} 件；
              未覆盖的部分不会在本次采集中处理，也不会被算作已完成。
            </p>
          ) : null}
          {plan && plan.deferredItemCount > 0 ? (
            <p data-testid="capture-plan-deferred" className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[13px] text-amber-900">
              有 {plan.deferredItemCount} 件不在本次范围内（超出单批容量或授权上限）。跨批次聚合当前未支持，不会被静默截断。
            </p>
          ) : null}
          {plan && plan.batching.itemsAwaitingSourceSamples > 0 ? (
            <p data-testid="capture-plan-awaiting-source" className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[13px] text-amber-900">
              市场目标 {plan.marketTargetItemCount} 件，本批次最多覆盖 {Math.min(plan.marketTargetItemCount, plan.batchCapacity)} 件，
              剩余 {plan.batching.itemsAwaitingSourceSamples} 件尚无来源商品，需要新增符合相同市场范围的样本；
              当前不支持跨批次自动聚合，不会拼成统一市场报告。
            </p>
          ) : null}
          {plan && plan.batching.note ? (
            <p data-testid="capture-plan-batching" className="text-[13px] text-slate-500">{plan.batching.note}</p>
          ) : null}
        </div>
      </div>

      {plan && moduleCounts ? (
        <div className="mt-3 space-y-2">
          <div
            data-testid="capture-plan-module-summary"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[13px] text-slate-600"
          >
            <span data-testid="capture-plan-basic-scope">
              本轮范围：四项基础能力 <strong className="font-bold text-slate-900">{Math.min(4, plan.entries.length)} 项</strong>
              {supplementalModules.length > 0 ? ` + 补充能力 ${supplementalModules.length} 项` : "（未添加补充能力）"}
            </span>
            <span data-testid="capture-plan-search-phase">
              搜索阶段：<strong className="font-bold text-slate-900">{moduleCounts.searchPhase} 项</strong>
            </span>
            <span data-testid="capture-plan-subsequent-auto">
              后续可自动采集：<strong className="font-bold text-slate-900">{moduleCounts.subsequentAuto} 项</strong>
            </span>
            <span className="text-slate-400">服务端权威计划 · 页面不可改写范围</span>
          </div>

          {/* 四项基础能力：简洁状态列表 */}
          <ul data-testid="capture-plan-basic-list" className="space-y-1">
            {BASIC_CAPTURE_MODULE_IDS.map((moduleId) => {
              const entry = plan.entries.find((item) => item.module === moduleId);
              return (
                <li key={moduleId} className="flex flex-wrap items-start gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[13px]">
                  <span className="font-semibold text-slate-800">{BASIC_CAPTURE_MODULE_LABELS[moduleId]}</span>
                  {entry ? (
                    <>
                      <Badge tone={STATUS_TONES[entry.status]}>{STATUS_LABELS[entry.status]}</Badge>
                      <span className="min-w-0 flex-1 text-slate-600">{entry.targetCoverage}</span>
                    </>
                  ) : (
                    <span className="text-slate-500">未纳入本轮计划</span>
                  )}
                </li>
              );
            })}
          </ul>

          {/* 补充能力：默认收起，明确选择 */}
          <details
            open={showSupplemental}
            onToggle={(event) => setShowSupplemental((event.target as HTMLDetailsElement).open)}
            className="rounded-lg border border-slate-200 bg-white"
            data-testid="capture-plan-supplemental"
          >
            <summary className="cursor-pointer px-2.5 py-2 text-[13px] font-semibold text-slate-800">
              添加补充能力（默认不纳入）
              <span className="ml-2 font-normal text-slate-500">
                {supplementalModules.length > 0 ? `已选 ${supplementalModules.length} 项` : "未选择"}
              </span>
            </summary>
            <div className="border-t border-slate-100 px-2.5 py-2 space-y-1.5">
              <p className="text-[13px] text-slate-500">
                补充能力需要对应来源会话或导出文件；未选择时不会进入本轮授权。选择后会更新计划指纹，确认前需再核对范围。
              </p>
              {SUPPLEMENTAL_CAPTURE_MODULE_IDS.map((moduleId) => (
                <label key={moduleId} className="flex items-start gap-2 text-[13px] text-slate-700">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={supplementalModules.includes(moduleId)}
                    disabled={isLocked}
                    data-testid={`capture-plan-supplemental-${moduleId}`}
                    onChange={(event) => {
                      setSupplementalModules((current) => event.target.checked
                        ? [...new Set([...current, moduleId])]
                        : current.filter((item) => item !== moduleId));
                    }}
                  />
                  <span>
                    <span className="font-medium">{MARKET_CAPTURE_MODULE_LABELS[moduleId as MarketCaptureModuleId]}</span>
                    <span className="text-slate-500"> · 需来源输入，不会默认自动完成</span>
                  </span>
                </label>
              ))}
              {isLocked ? (
                <p className="text-[13px] text-amber-800">已有已确认任务时不能更改本轮补充能力范围。</p>
              ) : null}
            </div>
          </details>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              data-testid="capture-plan-toggle-matrix"
              onClick={() => setShowMatrix((value) => !value)}
            >
              {showMatrix ? "收起本轮能力明细" : "查看本轮能力明细"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="capture-plan-refresh"
              disabled={loading || confirming}
              onClick={() => { void load(); void refreshEnvironment(); }}
            >
              {loading ? "读取中…" : "刷新计划"}
            </Button>
            <Button
              variant="primary"
              size="sm"
              data-testid="capture-plan-confirm"
              disabled={confirming || loading || !plan || isLocked || batchScopeAllowed !== true}
              onClick={() => void confirmPlan()}
            >
              {confirming
                ? "正在确认…"
                : batchScopeAllowed === false
                  ? "当前实例仅允许单 ASIN 采集"
                  : boundToCurrentPlan
                  ? "已确认（任务已创建）"
                  : previewingOtherPlan
                    ? "仅预览，不可确认"
                    : "确认计划并创建任务"}
            </Button>
          </div>

          {batchScopeAllowed === false ? (
            <p data-testid="capture-plan-scope-notice" className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[13px] text-amber-900">
              当前实例的运行范围是「仅单 ASIN 详情采集」（V5_ACQUISITION_SCOPE=single_asin_only），批量采集、自动扩充与执行器已被服务端关闭，因此不能确认批量计划。单 ASIN 采集请使用 01 页的「商品事实采集（ASIN）」入口。
            </p>
          ) : null}
          {previewingOtherPlan ? (
            <p data-testid="capture-plan-preview-notice" className="rounded-md border border-sky-200 bg-sky-50 px-2 py-1.5 text-[13px] text-sky-900">
              正在预览「{plan.strategyLabel}」：仅预览，不影响当前已确认任务
              {confirmedStrategyLabel ? `（已确认策略：${confirmedStrategyLabel}）` : ""}。
            </p>
          ) : null}

          {!isLocked && previousRunTerminal && existingRun ? (
            <p data-testid="capture-plan-previous-terminal-hint" className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[13px] text-amber-900">
              上一个任务{describeRunControlStatus(existingRun.status)}。重新确认将创建
              <strong className="font-semibold">新的运行代次</strong>（历史代次与已保存证据保留），
              不会复用或恢复旧代次；原授权不会自动扩大。
            </p>
          ) : null}

          {environment !== null && !environment.enabled ? (
            <p data-testid="capture-plan-environment-hint" className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-[13px] text-amber-900">
              当前本地采集未启用：确认计划后任务会创建并绑定计划，但不会自动执行采集；
              任务与授权会保留，启用本地采集后可继续执行。当前状态可在页面顶部「采集环境」诊断中查看。
            </p>
          ) : null}

          {showMatrix ? (
            <div data-testid="capture-plan-matrix" className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full min-w-[720px] border-collapse text-[13px]">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">模块</th>
                    <th className="px-2 py-1.5 text-left font-medium">计划状态</th>
                    <th className="px-2 py-1.5 text-left font-medium">目标覆盖</th>
                    <th className="px-2 py-1.5 text-left font-medium">查询主体</th>
                    <th className="px-2 py-1.5 text-left font-medium">预算</th>
                    <th className="px-2 py-1.5 text-left font-medium">前置 / 限制</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.entries.map((entry) => (
                    <tr key={entry.module} className="border-t border-slate-100 align-top" data-testid={`capture-plan-row-${entry.module}`}>
                      <td className="px-2 py-1.5 font-medium text-slate-800">{entry.label}</td>
                      <td className="px-2 py-1.5">
                        <Badge tone={STATUS_TONES[entry.status]}>{STATUS_LABELS[entry.status]}</Badge>
                      </td>
                      <td className="px-2 py-1.5 text-slate-600">{entry.targetCoverage}</td>
                      <td className="px-2 py-1.5 text-slate-600">{QUERY_SUBJECT_LABELS[entry.querySubjectKind]}</td>
                      <td className="px-2 py-1.5 text-slate-600">
                        {entry.querySubjectKind === "asin" || entry.budget.plannedItems > 0
                          ? `${entry.budget.plannedItems} 件`
                          : `${entry.budget.plannedQueries} 次查询`}
                        {entry.sampled ? <span className="ml-1 text-blue-700">（分段抽样）</span> : null}
                      </td>
                      <td className="px-2 py-1.5 text-slate-500">
                        {entry.requiresBefore.length
                          ? `需先完成：${entry.requiresBefore.map((id) => MARKET_CAPTURE_MODULE_LABELS[id as MarketCaptureModuleId]).join("、")}`
                          : entry.sourcePermission ?? "—"}
                        {entry.sampleNote ? <span className="mt-0.5 block text-slate-400">{entry.sampleNote}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-2" data-testid="capture-plan-entry-groups">
            <div className="rounded-lg border border-emerald-100 bg-emerald-50/50 px-2.5 py-2 text-[13px] text-emerald-900">
              <p className="font-semibold">本轮纳入（{autoEntries.length}）</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {autoEntries.map((entry) => (
                  <li key={entry.module}>
                    {MARKET_CAPTURE_MODULE_LABELS[entry.module as MarketCaptureModuleId]}
                    {entry.sampled ? `（分段抽样 ${entry.budget.plannedItems} 件）` : ""}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[13px] text-slate-700">
              <p className="font-semibold">本轮不纳入 / 需来源输入（{limitedEntries.length}）</p>
              {limitedEntries.length === 0 ? (
                <p className="mt-1 text-slate-500">未选择任何补充能力。</p>
              ) : (
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {limitedEntries.map((entry) => (
                    <li key={entry.module}>
                      {MARKET_CAPTURE_MODULE_LABELS[entry.module as MarketCaptureModuleId]}：{entry.reason}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-slate-500">未纳入的补充能力不会进入本轮 allowedModules。</p>
            </div>
          </div>

          <details className="rounded-lg border border-slate-200 bg-white px-2.5 py-2" data-testid="capture-plan-budget-details">
            <summary className="cursor-pointer text-xs font-semibold text-slate-700">技术预算与执行限制</summary>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[13px] text-slate-600">
              <li data-testid="capture-plan-navigation">
                共享导航预算上限 {plan.budget.navigationLimit} 次（按本运行代次的授权数量单独计算，搜索阶段已用 {plan.budget.navigationUsedAtStart} 次；上一代次已用额度不累加）。
              </li>
              <li>每轮商品预算 {plan.budget.maxItemsPerAdvance} 件；单次授权硬上限 {plan.budget.hardMaxAuthorizedItems} 件。</li>
              <li>搜索阶段每页 {plan.budget.searchItemsPerPage} 件，本次计划搜索页数 {plan.budget.searchPages} 页。</li>
              <li>自动可执行模块 {plan.autoExecutableModuleCount}/{plan.entries.length}（本轮已纳入计划的模块）。</li>
            </ul>
          </details>

          <details className="rounded-lg border border-slate-200 bg-white px-2.5 py-2" data-testid="capture-plan-confirmation-items">
            <summary className="cursor-pointer text-xs font-semibold text-slate-700">确认内容与前置条件</summary>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[13px] text-slate-600">
              {plan.confirmationItems.map((item) => <li key={item}>{item}</li>)}
            </ul>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[13px] text-slate-500">
              {plan.preconditions.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </details>
        </div>
      ) : null}

      {notice ? (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          data-testid="capture-plan-notice"
          className={`mt-2 rounded-lg border p-2 text-xs ${
            notice.tone === "error"
              ? "border-rose-200 bg-rose-50 text-rose-900"
              : notice.tone === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : "border-amber-200 bg-amber-50 text-amber-900"
          }`}
        >
          {notice.message}
        </p>
      ) : null}

      {confirmation ? (
        <dl className="mt-2 grid gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[13px] text-slate-600 sm:grid-cols-2" data-testid="capture-plan-confirmed">
          <div><dt className="inline font-medium text-slate-700">计划已确认：</dt><dd className="inline">{confirmation.plan.strategyLabel}</dd></div>
          <div><dt className="inline font-medium text-slate-700">授权商品：</dt><dd className="inline">{confirmation.plan.authorizedItemCount} 件</dd></div>
          <div><dt className="inline font-medium text-slate-700">任务已创建：</dt><dd className="inline">{confirmation.created ? "是（新代次）" : "否（幂等复用已有任务）"}</dd></div>
          <div>
            <dt className="inline font-medium text-slate-700">当前运行状态：</dt>
            <dd className="inline" data-testid="capture-plan-run-status">
              {describeCapturePlanExecutionState(confirmation).label}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="inline font-medium text-slate-700">状态说明：</dt>
            <dd className="inline" data-testid="capture-plan-run-status-note">
              {describeCapturePlanExecutionState(confirmation).note}
            </dd>
          </div>
        </dl>
      ) : null}
      <CapturePlanExpansionPanel
        batchId={batchId}
        batchCapacity={batchCapacity}
        onExpansionComplete={onExpansionComplete}
      />
    </section>
  );
}

const QUERY_SUBJECT_LABELS: Record<string, string> = {
  asin: "商品（ASIN）",
  market_query: "市场 / 类目查询",
  keyword_query: "关键词查询",
  user_supplied_file: "用户提供文件",
};
