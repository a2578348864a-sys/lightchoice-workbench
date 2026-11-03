"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Database,
  FileText,
  GitBranch,
  Layers,
  Loader2,
  LockKeyhole,
  MessageSquareText,
  Minus,
  Package,
  Plus,
  RefreshCw,
  ScanLine,
  ShieldAlert,
  Sparkles,
  Telescope,
} from "lucide-react";

import { buildAccessHeaders } from "@/lib/client/accessToken";
import {
  confirmCapturePlan,
  fetchCapturePlan,
  type CapturePlanConfirmResult,
  type CapturePlanExistingRun,
} from "@/lib/client/capturePlanClient";
import {
  BASIC_CAPTURE_MODULE_IDS,
  BASIC_CAPTURE_MODULE_LABELS,
  MARKET_CAPTURE_MODULE_LABELS,
  MARKET_CAPTURE_STRATEGY_LABELS,
  SUPPLEMENTAL_CAPTURE_MODULE_IDS,
  classifyMarketCapturePlanModules,
  type MarketCaptureModuleId,
  type MarketCapturePlan,
  type MarketCapturePlanEntry,
  type MarketCaptureStrategyId,
  type MarketModulePlanStatus,
} from "@/lib/sourceLayer/captureStrategy/marketCapturePlan";
import type { ModuleCoverageSummaryEntry } from "@/lib/sourceLayer/moduleCoverageSummary";
import { BATCH_CAPTURE_RUN_STATUS_LABELS } from "@/lib/sourceLayer/batchCaptureRunPresentation";
import {
  describeCapturePlanExecutionState,
  shortRunErrorReason,
  type CaptureEnvironmentProbe,
} from "@/components/source/CapturePlanPanel";
import styles from "./capture-mission-control.module.css";

type Notice = { tone: "info" | "success" | "error"; message: string } | null;

export type CaptureMissionPlanProps = {
  batchId: string;
  batchName: string;
  marketplace: string | null;
  sourceLabel: string;
  batchCapacity: number;
  moduleCoverage?: readonly ModuleCoverageSummaryEntry[];
  existingRunStatus?: string | null;
  defaultStrategyId?: MarketCaptureStrategyId;
  onConfirmed?: (result: Extract<CapturePlanConfirmResult, { ok: true }>) => void;
  onOpenSingleAsin?: () => void;
  /** 将服务端批量执行范围回报给驾驶舱外壳，用于顶部阶段标签。 */
  onExecutionScope?: (blocked: boolean) => void;
  /** 测试注入；默认使用真实 capture-plan 客户端。 */
  previewer?: typeof fetchCapturePlan;
  confirmer?: typeof confirmCapturePlan;
  environmentProber?: () => Promise<CaptureEnvironmentProbe>;
};

const TERMINAL_RUN_STATUSES = new Set(["CANCELLED", "FAILED"]);
const MAX_TARGET = 200;

const MODE_CARDS: Array<{
  id: MarketCaptureStrategyId;
  name: string;
  technicalName: string;
  description: string;
  bullets: readonly string[];
  icon: ReactNode;
}> = [
  {
    id: "quick_market_scan",
    name: "快速扫描",
    technicalName: "快速市场扫描",
    description: "优先补齐关键资料，适合初步判断。",
    bullets: ["详情与变体全量", "搜索与评论按分层抽样"],
    icon: <ScanLine size={19} />,
  },
  {
    id: "full_market_capture",
    name: "深度采集",
    technicalName: "完整市场采集",
    description: "尽可能补齐当前可执行的研究资料。",
    bullets: ["覆盖 8 类资料矩阵", "仅自动执行已接线模块"],
    icon: <Telescope size={19} />,
  },
];

const MODULE_ICONS: Record<(typeof BASIC_CAPTURE_MODULE_IDS)[number], ReactNode> = {
  amazon_search_market: <Package size={18} />,
  amazon_detail: <FileText size={18} />,
  variation: <GitBranch size={18} />,
  review_voc: <MessageSquareText size={18} />,
};

const MODULE_SHORT_LABELS: Record<(typeof BASIC_CAPTURE_MODULE_IDS)[number], string> = {
  amazon_search_market: "商品样本",
  amazon_detail: "商品详情",
  variation: "变体结构",
  review_voc: "买家评论",
};

const PLAN_STATUS_LABELS: Record<MarketModulePlanStatus, string> = {
  scheduled_auto: "本轮执行",
  scheduled_sampled: "分段抽样执行",
  requires_source_input: "需来源输入",
  not_auto_wired: "未自动接线",
  not_scheduled: "本轮不安排",
};

const PLAN_STATUS_TONES: Record<MarketModulePlanStatus, "plan" | "sample" | "warn" | "idle"> = {
  scheduled_auto: "plan",
  scheduled_sampled: "sample",
  requires_source_input: "warn",
  not_auto_wired: "warn",
  not_scheduled: "idle",
};

function describeRunControlStatus(status: string | null): string {
  if (!status) return "未知";
  const label = (BATCH_CAPTURE_RUN_STATUS_LABELS as Record<string, string | undefined>)[status];
  return label ?? `未知状态（${status}）`;
}

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

function batchTheme(batchName: string): string {
  const parts = batchName.split("·").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[1];
  return batchName.trim() || "当前批次";
}

function shortReason(reason: string | null | undefined): string {
  const text = (reason ?? "").trim();
  if (!text) return "";
  return text.length > 92 ? `${text.slice(0, 92)}…` : text;
}

function targetLabel(entry: MarketCapturePlanEntry | undefined, plan: MarketCapturePlan | null): string {
  if (!entry || !plan) return "—";
  if (entry.querySubjectKind === "asin" || entry.budget.plannedItems > 0) {
    return `${entry.sampled ? "抽样 " : ""}${entry.budget.plannedItems} 件`;
  }
  return `${entry.budget.plannedQueries} 次查询`;
}

export function CaptureMissionPlan({
  batchId,
  batchName,
  marketplace,
  sourceLabel,
  batchCapacity,
  moduleCoverage = [],
  existingRunStatus = null,
  defaultStrategyId = "full_market_capture",
  onConfirmed,
  onOpenSingleAsin,
  onExecutionScope,
  previewer = fetchCapturePlan,
  confirmer = confirmCapturePlan,
  environmentProber = defaultEnvironmentProbe,
}: CaptureMissionPlanProps) {
  const [strategyId, setStrategyId] = useState<MarketCaptureStrategyId>(defaultStrategyId);
  const [targetCount, setTargetCount] = useState<number>(() => Math.max(1, batchCapacity || 1));
  const [plan, setPlan] = useState<MarketCapturePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState<Extract<CapturePlanConfirmResult, { ok: true }> | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [existingRun, setExistingRun] = useState<CapturePlanExistingRun | null>(null);
  const [existingRunReadFailed, setExistingRunReadFailed] = useState(false);
  const [scopeAllowed, setScopeAllowed] = useState<boolean | null>(null);
  const [supplementalModules, setSupplementalModules] = useState<MarketCaptureModuleId[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [environment, setEnvironment] = useState<CaptureEnvironmentProbe>(null);

  const aliveRef = useRef(true);
  const loadSeqRef = useRef(0);
  const userEditedTargetRef = useRef(false);
  /** 防重复提交：状态更新是异步的，必须在事件入口用同步 ref 兜底。 */
  const submittingRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void environmentProber().then((result) => {
      if (!cancelled) setEnvironment(result);
    });
    return () => { cancelled = true; };
  }, [environmentProber, batchId]);

  // 批次商品异步加载：用户尚未手动改过数量时，跟随真实容量收敛。
  useEffect(() => {
    if (userEditedTargetRef.current) return;
    if (batchCapacity < 1) return;
    setTargetCount((current) => (current === 1 ? batchCapacity : current));
  }, [batchCapacity]);

  const load = useCallback(async (signal?: AbortSignal) => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    const result = await previewer({
      batchId,
      strategyId,
      marketTargetItemCount: targetCount,
      supplementalModules,
      signal,
    });
    if (signal?.aborted || seq !== loadSeqRef.current || !aliveRef.current) return;
    setLoading(false);
    if (!result.ok) {
      setPlan(null);
      setPlanError(result.errorMessage);
      setScopeAllowed(null);
      onExecutionScope?.(false);
      return;
    }
    setPlan(result.plan);
    setPlanError(null);
    setExistingRun(result.existingRun);
    setExistingRunReadFailed(result.existingRunReadFailed);
    // 以服务端返回为准；缺失一律按不可执行处理（fail-closed）。
    const allowed = result.acquisition?.batchCaptureScopeAllowed === true;
    setScopeAllowed(allowed);
    onExecutionScope?.(!allowed);
  }, [batchId, previewer, strategyId, supplementalModules, targetCount, onExecutionScope]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void load(controller.signal); }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  const previousRunTerminal = existingRun !== null && TERMINAL_RUN_STATUSES.has(existingRun.status);
  const locked = Boolean(existingRun?.planFingerprint && !previousRunTerminal) || confirmation !== null;
  const boundToCurrentPlan = locked && plan !== null && existingRun?.planFingerprint === plan.planFingerprint;
  const previewingOtherPlan = locked && plan !== null && Boolean(existingRun?.planFingerprint) && existingRun?.planFingerprint !== plan.planFingerprint;
  const lockedStrategyLabel = existingRun?.planStrategyId
    ? MARKET_CAPTURE_STRATEGY_LABELS[existingRun.planStrategyId as MarketCaptureStrategyId] ?? existingRun.planStrategyId
    : null;
  const capacity = plan?.batchCapacity ?? Math.max(1, batchCapacity);
  const scopeBlocked = scopeAllowed === false;
  const scopeUnknown = scopeAllowed === null;
  const effectiveCount = scopeBlocked ? 0 : (plan?.authorizedItemCount ?? targetCount);
  const footerCount = scopeBlocked ? targetCount : effectiveCount;
  const moduleCounts = useMemo(() => (plan ? classifyMarketCapturePlanModules(plan) : null), [plan]);
  const maxTarget = plan?.budget.hardMaxAuthorizedItems ?? MAX_TARGET;

  const setTarget = (next: number) => {
    userEditedTargetRef.current = true;
    const safe = Number.isFinite(next) ? Math.round(next) : 1;
    setTargetCount(Math.max(1, Math.min(MAX_TARGET, safe)));
  };

  const currentMode = MODE_CARDS.find((card) => card.id === strategyId) ?? MODE_CARDS[1];
  const theme = batchTheme(batchName);
  const market = (marketplace || "US").toUpperCase();
  const titleVerb = existingRun || batchCapacity > 0 ? "准备补齐" : "准备开始";
  const coveragePercent = scopeUnknown || capacity < 1
    ? 0
    : Math.max(0, Math.min(100, Math.round((effectiveCount / capacity) * 100)));
  const overCapacity = targetCount > capacity;

  const confirmPlan = async () => {
    if (!plan || confirming || submittingRef.current || locked || existingRunReadFailed || scopeAllowed !== true || previewingOtherPlan) return;
    submittingRef.current = true;
    setConfirming(true);
    setNotice(null);
    const result = await confirmer({
      batchId,
      strategyId,
      marketTargetItemCount: targetCount,
      supplementalModules,
      planFingerprint: plan.planFingerprint,
    });
    setConfirming(false);
    submittingRef.current = false;
    if (!result.ok) {
      setNotice({ tone: "error", message: result.errorMessage });
      return;
    }
    setConfirmation(result);
    const execution = describeCapturePlanExecutionState(result);
    setNotice({
      tone: result.driveError ? "info" : "success",
      message: result.driveError
        ? `采集任务已创建，但执行器未启动（${shortRunErrorReason(result.driveError)}）。任务不会丢失，可稍后刷新状态或重试。`
        : result.created
          ? `${execution.label}。真实采集进度以执行回执与证据为准，本页不会伪造进度。`
          : "该批次已按同一计划创建过任务；本次为幂等复用，没有重复创建。",
    });
    onConfirmed?.(result);
  };

  const primaryDisabled = confirming || loading || !plan || locked || previewingOtherPlan || existingRunReadFailed || scopeBlocked || scopeUnknown;
  const primaryLabel = confirming
    ? "正在创建采集任务…"
    : loading && !plan
      ? "正在读取计划…"
      : planError
        ? "计划未就绪"
        : existingRunReadFailed
          ? "任务状态未知，暂不能确认"
          : scopeBlocked
            ? "当前暂不能批量采集"
            : scopeUnknown
              ? "正在确认执行范围…"
            : boundToCurrentPlan
              ? "已确认（任务已创建）"
              : previewingOtherPlan
                ? "仅预览，不可确认"
                : locked
                  ? "已有采集任务"
                  : effectiveCount > 0 && batchCapacity > 0
                    ? "确认并开始补充采集"
                    : "确认并开始采集";
  const footerStatus = scopeBlocked
    ? "执行受限"
    : existingRunReadFailed
      ? "状态未知"
      : locked
        ? "已有任务"
        : confirming
          ? "提交中"
          : plan && !loading
            ? "可执行"
            : "准备中";

  const evidenceNodes = BASIC_CAPTURE_MODULE_IDS.map((moduleId) => {
    const entry = plan?.entries.find((item) => item.module === moduleId);
    const coverage = moduleCoverage.find((item) => item.module === moduleId);
    const hasEvidence = (coverage?.evidenceCount ?? 0) > 0;
    const executed = (coverage?.executedCount ?? 0) > 0;
    if (planError && !plan) {
      return { moduleId, entry, coverage, label: "计划未读取", detail: "服务端计划读取失败，未伪造覆盖", tone: "fail" as const };
    }
    if (!plan) {
      return { moduleId, entry, coverage, label: "读取中", detail: "正在读取服务端权威计划", tone: "loading" as const };
    }
    if (hasEvidence) {
      return {
        moduleId,
        entry,
        coverage,
        label: "已有证据",
        detail: `${coverage?.evidenceCount ?? 0}/${coverage?.itemCount ?? capacity} 件已有有效证据`,
        tone: "ok" as const,
      };
    }
    if (executed) {
      return {
        moduleId,
        entry,
        coverage,
        label: "已执行",
        detail: `${coverage?.executedCount ?? 0} 件已执行，尚无可用证据`,
        tone: "warn" as const,
      };
    }
    if (!entry) {
      return { moduleId, entry, coverage, label: "本轮不安排", detail: "未纳入本轮计划", tone: "idle" as const };
    }
    if (entry.status === "scheduled_auto") {
      return {
        moduleId,
        entry,
        coverage,
        label: "本轮采集",
        detail: `${plan.authorizedItemCount} 件按计划采集`,
        tone: "plan" as const,
      };
    }
    if (entry.status === "scheduled_sampled") {
      return {
        moduleId,
        entry,
        coverage,
        label: "本轮抽样",
        detail: `分段抽样 ${entry.budget.plannedItems} 件`,
        tone: "sample" as const,
      };
    }
    if (entry.status === "requires_source_input") {
      return { moduleId, entry, coverage, label: "需来源输入", detail: shortReason(entry.reason), tone: "warn" as const };
    }
    if (entry.status === "not_auto_wired") {
      return { moduleId, entry, coverage, label: "暂不可自动执行", detail: shortReason(entry.reason), tone: "warn" as const };
    }
    return { moduleId, entry, coverage, label: "本轮不安排", detail: shortReason(entry.reason) || "未纳入本轮计划", tone: "idle" as const };
  });

  return (
    <div className={styles.plan}>
      <div className={styles.planScroll}>
        <section className={styles.hero} data-scope={scopeBlocked ? "blocked" : "ready"} aria-labelledby="capture-mission-hero-title">
          <div className={styles.heroGlow} aria-hidden="true" />
          <div className={styles.heroGrid}>
            <div className={styles.heroCopy}>
              <p className={styles.heroKicker}>
                <Sparkles size={13} aria-hidden="true" />
                Capture Mission Control
              </p>
              <h1 id="capture-mission-hero-title" className={styles.heroTitle} data-testid="capture-mission-hero-title">
                {scopeBlocked
                  ? "批量采集当前受限"
                  : <>{titleVerb} <strong className={styles.heroNumber}>{effectiveCount}</strong> 件商品的市场资料</>}
              </h1>
              <p className={styles.heroSub} data-testid="capture-mission-hero-sub">
                {scopeBlocked ? `目标 ${targetCount} 件 · ` : ""}Amazon {market} · {theme} · 当前批次
              </p>
              <div className={styles.heroChips}>
                <span className={styles.heroChip}><Database size={13} />本批可用 {capacity} 件</span>
                <span className={styles.heroChip}><Layers size={13} />基础 4 类资料</span>
                <span className={styles.heroChip} data-tone={scopeBlocked ? "warn" : scopeUnknown ? "idle" : "ok"}>
                  {scopeBlocked ? <LockKeyhole size={13} /> : scopeUnknown ? <Loader2 size={13} className={styles.spin} /> : <Check size={13} />}
                  {scopeBlocked ? "批量执行受限" : scopeUnknown ? "正在确认执行范围" : "当前可执行"}
                </span>
              </div>
            </div>

            <div className={styles.orbit} aria-hidden="true">
              <span className={styles.orbitRingOne} />
              <span className={styles.orbitRingTwo} />
              <span className={styles.orbitCore}><Telescope size={22} /></span>
              <span className={styles.orbitDot} data-pos="a" />
              <span className={styles.orbitDot} data-pos="b" />
              <span className={styles.orbitDot} data-pos="c" />
              <span className={styles.orbitDot} data-pos="d" />
            </div>
          </div>

          <div className={styles.heroFoot}>
            <div className={styles.coverageRing} style={{ "--p": `${coveragePercent}%` } as CSSProperties}>
              <div className={styles.coverageRingInner}>
                <b>{scopeUnknown ? "—" : effectiveCount}</b>
                <span>/ {capacity}</span>
              </div>
            </div>
            <div className={styles.heroFootCopy}>
              <p className={styles.heroFootTitle}>
                {scopeBlocked
                  ? "当前授权范围不允许批量执行"
                  : scopeUnknown
                    ? "正在读取服务端授权范围"
                    : `本次授权覆盖 ${coveragePercent}% 本批商品`}
              </p>
              <p className={styles.heroFootNote}>
                {scopeBlocked
                  ? "当前实例只允许单 ASIN 采集；批量计划不会被提交。"
                  : overCapacity
                    ? `目标 ${targetCount} 件，其中 ${targetCount - capacity} 件超出本批容量，本次不会处理。`
                    : "计划确认后才会创建任务；执行器启动不等于资料完整，真实结果以证据为准。"}
              </p>
            </div>
            <div className={styles.heroSource}>
              <span>来源</span>
              <b>{sourceLabel}</b>
              <small>{existingRunStatus ? `已有任务：${existingRunStatus}` : "尚未创建自动采集任务"}</small>
            </div>
          </div>
        </section>

        {scopeBlocked ? (
          <div className={styles.scopeBanner} role="alert" data-testid="capture-mission-scope-notice">
            <span className={styles.bannerIcon}><ShieldAlert size={17} /></span>
            <div>
              <b>当前暂不能批量采集</b>
              <p>
                正式实例的运行范围为「仅单 ASIN 详情采集」（V5_ACQUISITION_SCOPE=single_asin_only）。批量计划、自动扩充与执行器已被服务端关闭。
                这是服务端授权限制，页面不会绕过。
              </p>
            </div>
            {onOpenSingleAsin ? (
              <button type="button" className={styles.bannerAction} onClick={onOpenSingleAsin}>
                去单 ASIN 采集 <ArrowRight size={13} />
              </button>
            ) : null}
          </div>
        ) : null}

        {existingRunReadFailed ? (
          <div className={styles.alertBanner} data-tone="warn" role="alert" data-testid="capture-mission-run-unknown">
            <CircleAlert size={16} />
            <span>采集任务回执读取失败，当前无法确认是否已有任务。为避免越权，本轮确认暂不可用。</span>
          </div>
        ) : null}

        {locked ? (
          <div className={styles.alertBanner} data-tone={previousRunTerminal ? "info" : "warn"} data-testid="capture-mission-locked">
            <LockKeyhole size={16} />
            <span>
              {previousRunTerminal
                ? `上一个任务${describeRunControlStatus(existingRun?.status ?? null)}；重新确认会创建新的运行代次，历史与已保存证据保留，原授权不会自动扩大。`
                : `已有采集任务：${describeRunControlStatus(existingRun?.status ?? existingRunStatus)}${lockedStrategyLabel ? `（策略：${lockedStrategyLabel}）` : ""}。此处切换策略/数量仅用于预览，不能扩大原授权。`}
            </span>
          </div>
        ) : null}

        {planError ? (
          <div className={styles.alertBanner} data-tone="error" role="alert" data-testid="capture-mission-plan-error">
            <CircleAlert size={16} />
            <span>{planError}</span>
            <button type="button" className={styles.bannerAction} onClick={() => { void load(); }}>重试</button>
          </div>
        ) : null}

        {notice ? (
          <p className={styles.notice} data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"} data-testid="capture-mission-notice">
            {notice.message}
          </p>
        ) : null}

        <div className={styles.modeLayout}>
          <section className={styles.section} aria-labelledby="capture-mission-mode-title">
            <header className={styles.sectionHead}>
              <div>
                <p className={styles.sectionKicker}>01 · 采集模式</p>
                <h3 id="capture-mission-mode-title" className={styles.sectionTitle}>选择采集模式</h3>
              </div>
              <span className={styles.sectionHint}>服务端策略合同</span>
            </header>

            <div className={styles.modeGrid} role="radiogroup" aria-label="采集模式">
              {MODE_CARDS.map((card) => {
                const selected = strategyId === card.id;
                return (
                  <label
                    key={card.id}
                    className={styles.modeCard}
                    data-selected={selected ? "true" : "false"}
                    data-disabled={locked || confirming ? "true" : "false"}
                    data-testid={`capture-mission-mode-${card.id === "quick_market_scan" ? "quick" : "full"}`}
                  >
                    <input
                      type="radio"
                      name={`capture-mission-strategy-${batchId}`}
                      className={styles.modeRadio}
                      checked={selected}
                      disabled={locked || confirming}
                      onChange={() => { setStrategyId(card.id); }}
                    />
                    <span className={styles.modeIcon} data-tone={card.id === "quick_market_scan" ? "sample" : "plan"}>{card.icon}</span>
                    <span className={styles.modeCheck} aria-hidden="true"><Check size={13} /></span>
                    <span className={styles.modeName}>{card.name}</span>
                    <span className={styles.modeTechnical}>{card.technicalName}</span>
                    <span className={styles.modeDescription}>{card.description}</span>
                    <span className={styles.modeBullets}>
                      {card.bullets.map((bullet) => <span key={bullet}><i aria-hidden="true" />{bullet}</span>)}
                    </span>
                    <span className={styles.modeFoot}>
                      {selected && moduleCounts
                        ? `基础 ${Math.min(4, plan?.entries.length ?? 4)} 项 · 自动 ${moduleCounts.subsequentAuto} 项${supplementalModules.length ? ` + 补充 ${supplementalModules.length} 项` : ""}`
                        : card.id === "quick_market_scan"
                          ? "基础 4 项 · 搜索/评论抽样"
                          : "基础 4 项 + 补充 4 项可选"}
                    </span>
                  </label>
                );
              })}
            </div>
            <p className={styles.modeNote}>
              深度采集表示「尽可能补齐」，不保证 8 类资料全部成功；未接线或需来源输入的模块会如实标注。
            </p>
          </section>

          <section className={styles.section} aria-labelledby="capture-mission-count-title">
            <header className={styles.sectionHead}>
              <div>
                <p className={styles.sectionKicker}>02 · SCOPE</p>
                <h3 id="capture-mission-count-title" className={styles.sectionTitle}>本次采集数量</h3>
              </div>
              <span className={styles.sectionHint}>{capacity} 件可用</span>
            </header>

            <div className={styles.quantityCard}>
              <div className={styles.quantityValue} aria-live="polite">
                <b>{targetCount}</b><span>件商品</span>
              </div>
              <div className={styles.quantityControls}>
                <button
                  type="button"
                  className={styles.stepButton}
                  aria-label="减少采集数量"
                  data-testid="capture-mission-target-decrease"
                  disabled={locked || confirming || targetCount <= 1}
                  onClick={() => { setTarget(targetCount - 1); }}
                ><Minus size={15} /></button>
                <input
                  type="number"
                  min={1}
                  max={Math.max(maxTarget, 1)}
                  step={1}
                  inputMode="numeric"
                  aria-label="本次采集商品数量"
                  className={styles.quantityInput}
                  data-testid="capture-mission-target"
                  value={targetCount}
                  disabled={locked || confirming}
                  onChange={(event) => { setTarget(Number(event.target.value)); }}
                />
                <button
                  type="button"
                  className={styles.stepButton}
                  aria-label="增加采集数量"
                  data-testid="capture-mission-target-increase"
                  disabled={locked || confirming || targetCount >= Math.max(maxTarget, 1)}
                  onClick={() => { setTarget(targetCount + 1); }}
                ><Plus size={15} /></button>
              </div>
              <input
                type="range"
                min={1}
                max={Math.max(1, Math.min(maxTarget, Math.max(capacity, 1)))}
                step={1}
                value={Math.min(targetCount, Math.max(1, capacity))}
                aria-label="采集数量范围"
                className={styles.range}
                disabled={locked || confirming}
                onChange={(event) => { setTarget(Number(event.target.value)); }}
              />
              <div className={styles.quickTargets}>
                {[10, 20, capacity].filter((value, index, array) => value >= 1 && value <= Math.max(capacity, 1) && array.indexOf(value) === index).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={styles.quickTarget}
                    data-active={targetCount === value ? "true" : "false"}
                    disabled={locked || confirming}
                    onClick={() => { userEditedTargetRef.current = true; setTargetCount(value); }}
                  >
                    {value === capacity ? `全部 ${value} 件` : `${value} 件`}
                  </button>
                ))}
              </div>
              <p className={styles.quantityHint}>
                本批可用 {capacity} 件 · 单次上限 {maxTarget} 件
                {plan ? ` · 预计 ${plan.batching.plannedRuns} 轮` : ""}
              </p>
              {overCapacity ? (
                <p className={styles.quantityWarn} data-testid="capture-mission-over-capacity">
                  超出本批可覆盖范围，超出部分本次不会处理，也不会被算作完成。
                </p>
              ) : null}
            </div>
          </section>
        </div>

        <section className={styles.evidenceSection} aria-labelledby="capture-mission-evidence-title">
          <header className={styles.sectionHead}>
            <div>
              <p className={styles.sectionKicker}>03 · 证据流转</p>
              <h3 id="capture-mission-evidence-title" className={styles.sectionTitle}>计划采集的资料</h3>
            </div>
            <span className={styles.sectionHint}>
              {plan ? `${moduleCounts?.subsequentAuto ?? 0} 项后续可自动执行` : "读取服务端权威计划"}
            </span>
          </header>

          <div className={styles.flow} data-testid="capture-mission-evidence-flow">
            {evidenceNodes.map((node, index) => (
              <div className={styles.flowItem} key={node.moduleId}>
                <article
                  className={styles.evidenceNode}
                  data-tone={node.tone}
                  data-testid={`capture-mission-evidence-${node.moduleId}`}
                >
                  <span className={styles.evidenceIcon} aria-hidden="true">{MODULE_ICONS[node.moduleId]}</span>
                  <span className={styles.evidenceLabel}>{MODULE_SHORT_LABELS[node.moduleId]}</span>
                  <span className={styles.evidenceTechnical}>{BASIC_CAPTURE_MODULE_LABELS[node.moduleId]}</span>
                  <span className={styles.evidenceStatus}>{node.label}</span>
                  <p className={styles.evidenceDetail}>{node.detail}</p>
                </article>
                {index < evidenceNodes.length - 1 ? <span className={styles.flowConnector} aria-hidden="true"><i /></span> : null}
              </div>
            ))}
          </div>

          <div className={styles.flowFoot}>
            <span><i className={styles.liveDot} aria-hidden="true" />计划状态来自服务端；执行器启动仅代表控制流程开始</span>
            <button type="button" className={styles.textButton} onClick={() => setAdvancedOpen((value) => !value)} data-testid="capture-mission-advanced-toggle">
              {advancedOpen ? "收起高级设置与来源限制" : "高级设置与来源限制"}
              {advancedOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>

          {advancedOpen ? (
            <div className={styles.advanced} data-testid="capture-mission-advanced">
              <div className={styles.advancedGrid}>
                <section className={styles.advancedCard}>
                  <h4>补充能力 · 需来源输入</h4>
                  <p className={styles.advancedNote}>默认不纳入；勾选后会进入本轮计划指纹，确认前请再核对来源限制。</p>
                  <div className={styles.supplementalGrid}>
                    {SUPPLEMENTAL_CAPTURE_MODULE_IDS.map((moduleId) => {
                      const checked = supplementalModules.includes(moduleId);
                      return (
                        <label key={moduleId} className={styles.supplementalCard} data-checked={checked ? "true" : "false"}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={locked || confirming}
                            data-testid={`capture-mission-supplemental-${moduleId}`}
                            onChange={(event) => {
                              setSupplementalModules((current) => event.target.checked
                                ? [...new Set([...current, moduleId])]
                                : current.filter((item) => item !== moduleId));
                            }}
                          />
                          <span className={styles.supplementalCheck} aria-hidden="true"><Check size={11} /></span>
                          <span className={styles.supplementalName}>{MARKET_CAPTURE_MODULE_LABELS[moduleId as MarketCaptureModuleId]}</span>
                          <span className={styles.supplementalHint}>需来源会话 / 导出文件</span>
                        </label>
                      );
                    })}
                  </div>
                </section>

                <section className={styles.advancedCard}>
                  <h4>当前可用能力</h4>
                  <dl className={styles.metricList}>
                    <div><dt>计划策略</dt><dd>{plan?.strategyLabel ?? MARKET_CAPTURE_STRATEGY_LABELS[strategyId]}</dd></div>
                    <div><dt>自动可执行</dt><dd>{plan?.autoExecutableModuleCount ?? "—"} / {plan?.entries.length ?? 8} 个模块</dd></div>
                    <div><dt>执行范围</dt><dd>{scopeAllowed === true ? "批量 + 单 ASIN" : "仅单 ASIN"}</dd></div>
                    <div><dt>本地采集</dt><dd>{environment === null ? "未探测" : environment.enabled ? "已启用" : "未启用"}</dd></div>
                  </dl>
                  {environment !== null && !environment.enabled ? (
                    <p className={styles.advancedWarn}>本地采集未启用：确认后会创建任务并绑定计划，但执行器不会启动；启用后可继续。</p>
                  ) : null}
                </section>
              </div>

              {plan ? (
                <>
                  <section className={styles.advancedCard}>
                    <h4>本轮能力明细</h4>
                    <div className={styles.tableWrap}>
                      <table className={styles.table}>
                        <thead>
                          <tr><th>模块</th><th>计划状态</th><th>目标覆盖</th><th>预算</th><th>前置 / 限制</th></tr>
                        </thead>
                        <tbody>
                          {plan.entries.map((entry) => (
                            <tr key={entry.module}>
                              <td>{entry.label}</td>
                              <td><span className={styles.statusTag} data-tone={PLAN_STATUS_TONES[entry.status]}>{PLAN_STATUS_LABELS[entry.status]}</span></td>
                              <td>{entry.targetCoverage}</td>
                              <td>{targetLabel(entry, plan)}</td>
                              <td>{entry.requiresBefore.length ? `需先完成：${entry.requiresBefore.map((id) => MARKET_CAPTURE_MODULE_LABELS[id as MarketCaptureModuleId]).join("、")}` : entry.sourcePermission ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>

                  <div className={styles.advancedGrid}>
                    <section className={styles.advancedCard}>
                      <h4>执行预算与轮次</h4>
                      <dl className={styles.metricList}>
                        <div><dt>市场目标</dt><dd>{plan.marketTargetItemCount} 件</dd></div>
                        <div><dt>本次授权</dt><dd>{plan.authorizedItemCount} 件</dd></div>
                        <div><dt>预计轮次</dt><dd>{plan.batching.plannedRuns} 轮</dd></div>
                        <div><dt>每轮商品预算</dt><dd>{plan.budget.maxItemsPerAdvance} 件</dd></div>
                        <div><dt>导航预算</dt><dd>{plan.budget.navigationLimit} 次</dd></div>
                        <div><dt>搜索页数</dt><dd>{plan.budget.searchPages} 页</dd></div>
                      </dl>
                      <p className={styles.fingerprint}>计划指纹 <code>{plan.planFingerprint}</code></p>
                    </section>

                    <section className={styles.advancedCard}>
                      <h4>确认内容与前置条件</h4>
                      <ul className={styles.checkList}>
                        {plan.confirmationItems.map((item) => <li key={item}><Check size={12} />{item}</li>)}
                      </ul>
                      {plan.preconditions.length ? (
                        <ul className={styles.checkList} data-tone="warn">
                          {plan.preconditions.map((item) => <li key={item}><CircleAlert size={12} />{item}</li>)}
                        </ul>
                      ) : null}
                      {plan.notCovered.length ? (
                        <div className={styles.coverageGap}>
                          <b>本轮未覆盖</b>
                          {plan.notCovered.map((item) => <span key={item.module}>{item.label}：{item.reason}</span>)}
                        </div>
                      ) : null}
                    </section>
                  </div>
                </>
              ) : (
                <p className={styles.advancedNote}>计划尚未读取成功，暂不展示预算、矩阵与指纹。</p>
              )}

              <div className={styles.advancedActions}>
                <button type="button" className={styles.ghostButton} onClick={() => { void load(); }} disabled={loading || confirming} data-testid="capture-mission-refresh">
                  {loading ? <Loader2 size={14} className={styles.spin} /> : <RefreshCw size={14} />}
                  重新读取计划
                </button>
                <span>高级信息只读；策略、数量和补充能力仍由服务端计划推导。</span>
              </div>
            </div>
          ) : null}
        </section>

        {plan && loading ? <p className={styles.refreshing} role="status">正在同步服务端计划…</p> : null}
      </div>

      <footer className={styles.footer} data-testid="capture-mission-footer">
        <div className={styles.footerSummary}>
          <span className={styles.footerStatus} data-tone={scopeBlocked ? "warn" : locked ? "info" : "ok"}>
            {scopeBlocked ? <LockKeyhole size={12} /> : locked ? <LockKeyhole size={12} /> : <Check size={12} />}
            {footerStatus}
          </span>
          <div>
            <p className={styles.footerMain}>
              <b>{footerCount} 件商品</b>
              <span>·</span>
              <span>{currentMode.name}</span>
              <span>·</span>
              <span>{scopeBlocked ? "当前暂不能批量采集" : "当前可执行范围"}</span>
            </p>
            <p className={styles.footerSub}>
              授权 {scopeBlocked ? 0 : scopeUnknown ? "读取中" : effectiveCount} 件 · 本批可用 {capacity} 件
              {plan ? ` · 预计 ${plan.batching.plannedRuns} 轮` : ""}
              {overCapacity ? ` · ${targetCount - capacity} 件超出本批` : ""}
            </p>
          </div>
        </div>
        <div className={styles.footerActions}>
          {scopeBlocked && onOpenSingleAsin ? (
            <button type="button" className={styles.footerLink} onClick={onOpenSingleAsin}>
              单 ASIN 采集 <ArrowRight size={13} />
            </button>
          ) : null}
          <button
            type="button"
            className={styles.primaryButton}
            data-testid="capture-mission-primary"
            disabled={primaryDisabled}
            onClick={() => { void confirmPlan(); }}
            title={primaryDisabled ? primaryLabel : undefined}
          >
            {confirming ? <Loader2 size={16} className={styles.spin} /> : primaryDisabled ? <LockKeyhole size={15} /> : null}
            {primaryLabel}
            {!primaryDisabled && !confirming ? <ArrowRight size={16} /> : null}
          </button>
        </div>
      </footer>
    </div>
  );
}
