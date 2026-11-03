"use client";

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { AlertCircle, ArrowRight, CheckCircle2, ChevronDown, Database, FileCheck2, Fingerprint, Globe2, Layers, Loader2, LockKeyhole, PackageCheck, RefreshCw, Search, ShieldCheck } from "lucide-react";
import styles from "./AmazonCapturePanel.module.css";

import { buildAccessHeaders } from "@/lib/client/accessToken";
import {
  AUTO_CAPTURE_MODULE_COUNT,
  deriveNavigationBudget,
} from "@/lib/sourceLayer/captureBudgetConstants";
import {
  amazonCaptureFailureGuidance,
  classifyAmazonCaptureFailure,
  formatAmazonCaptureRequestFailure,
  resolveAmazonCaptureOutcome,
  type AmazonCaptureFailureKind,
} from "@/components/source-layer/amazonCaptureOutcome";

/**
 * 授权商品数量：快捷档位 5/10/30/60，或自定义整数（1–HARD_MAX）。
 * 两种模式互斥，最终都只提交同一个 `authorizedItemLimit` 字段。
 * 默认取最小档（5），避免一次误点就采集大批量商品。
 */
export const AUTHORIZED_ITEM_OPTIONS = [5, 10, 30, 60] as const;
export const DEFAULT_AUTHORIZED_ITEM_LIMIT = 5 as const;
/** 本阶段产品上限；>200 的需求以后单独评估。与 `HARD_MAX_AUTHORIZED_ITEMS` 保持一致。 */
export const AUTHORIZED_ITEM_MAX = 200 as const;

/** 由授权上限推导搜索预算：页数 = ceil(上限/每页经验值)，最多 10 页；样本上限 = 授权上限。 */
export function deriveSearchBudget(authorizedItemLimit: number): { pages: number; maxAppearances: number } {
  return {
    pages: Math.min(10, Math.max(1, Math.ceil(authorizedItemLimit / 30))),
    maxAppearances: authorizedItemLimit,
  };
}

/** 自定义数量的校验：返回错误文案或 null。 */
export function validateCustomLimit(raw: string): string | null {
  if (!/^\d+$/u.test(raw.trim())) return "请输入 1–200 之间的整数。";
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1) return "请输入 1–200 之间的整数。";
  if (value > AUTHORIZED_ITEM_MAX) return `本阶段最多支持 ${AUTHORIZED_ITEM_MAX} 件；更大的需求请单独评估。`;
  return null;
}

export type AmazonCaptureMode = "detail" | "search";

type AmazonCapturePanelProps = {
  onCaptured: (message: string) => void;
  onRefresh: () => void;
  initialMode?: AmazonCaptureMode;
  onModeChange?: (mode: AmazonCaptureMode) => void;
  showModeSelector?: boolean;
  showHeading?: boolean;
};

type PreflightState = {
  loading: boolean;
  status: "US_READY" | "NON_US_EXIT" | "UNKNOWN" | "PROXY_INVALID" | "IDLE";
  exitCountry: string | null;
  exitCountryName: string | null;
  proxyConfigured: boolean;
  proxyProtocol: string | null;
  message: string | null;
};

type AmazonSessionReadinessStatus =
  | "ACQUISITION_DISABLED"
  | "IDLE"
  | "CHECKING"
  | "ERROR"
  | "SESSION_READY"
  | "SESSION_NOT_READY"
  | "PREFLIGHT_BLOCKED"
  | "BROWSER_UNAVAILABLE";

type AmazonSessionReadinessState = {
  loading: boolean;
  status: AmazonSessionReadinessStatus;
  sessionReady: boolean;
  browserLaunched: boolean;
  errorCode: string | null;
  message: string | null;
  delivery: "US" | "NON_US" | "UNKNOWN" | null;
  language: string | null;
};

type CaptureResponse = {
  ok?: boolean;
  data?: {
    status?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    partial?: boolean;
    operationId?: string;
    productBatchHandoff?: { itemCount?: number | null } | null;
    authorizedItemLimit?: number | null;
    traceId?: string | null;
    plan?: { totalObservationCount?: number; emptyResultReason?: string | null } | null;
    captures?: Array<{ capture?: { readyCount?: number } }>;
    capture?: { readyCount?: number } | null;
  };
  error?: { code?: string; message?: string; status?: string; traceId?: string };
};

/**
 * Amazon 采集入口只传递用户意图，绝不接受客户端传入商品字段。
 * 页面读取、实体绑定、停止页判断和 Evidence 写入全部由服务端采集器完成。
 */
export function AmazonCapturePanel({ onCaptured, onRefresh, initialMode = "detail", onModeChange, showModeSelector = true, showHeading = true }: AmazonCapturePanelProps) {
  const inputId = useId();
  const resultRef = useRef<HTMLElement>(null);
  const searchOperationIdRef = useRef<string | null>(null);
  const [mode, setMode] = useState<AmazonCaptureMode>(initialMode);
  const [asin, setAsin] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [limitMode, setLimitMode] = useState<"preset" | "custom">("preset");
  const [presetLimit, setPresetLimit] = useState<number>(DEFAULT_AUTHORIZED_ITEM_LIMIT);
  const [customLimit, setCustomLimit] = useState<string>("80");
  const customLimitError = limitMode === "custom" ? validateCustomLimit(customLimit) : null;
  const authorizedItemLimit = limitMode === "custom"
    ? (customLimitError ? Number.NaN : Number(customLimit.trim()))
    : presetLimit;
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<CaptureResponse["data"] | null>(null);
  const [failureKind, setFailureKind] = useState<AmazonCaptureFailureKind>("unknown");
  useEffect(() => {
    if (result || error) resultRef.current?.scrollIntoView({ block: "nearest" });
  }, [result, error]);

  const [preflight, setPreflight] = useState<PreflightState>({
    loading: true,
    status: "IDLE",
    exitCountry: null,
    exitCountryName: null,
    proxyConfigured: false,
    proxyProtocol: null,
    message: null,
  });

  const [sessionReadiness, setSessionReadiness] = useState<AmazonSessionReadinessState>({
    loading: false,
    status: "IDLE",
    sessionReady: false,
    browserLaunched: false,
    errorCode: null,
    message: null,
    delivery: null,
    language: null,
  });

  const checkAmazonSessionReadiness = useCallback(async () => {
    setSessionReadiness((prev) => ({ ...prev, loading: true, status: "CHECKING" }));
    try {
      const response = await fetch("/api/source-layer/amazon-session-readiness", {
        headers: buildAccessHeaders(),
      });
      const payload = await response.json() as {
        ok?: boolean;
        data?: Omit<AmazonSessionReadinessState, "loading">;
        error?: { code?: string; message?: string };
      };
      if (response.ok && payload.ok && payload.data) {
        setSessionReadiness({ ...payload.data, loading: false });
      } else {
        setSessionReadiness({
          loading: false,
          status: "ERROR",
          sessionReady: false,
          browserLaunched: false,
          errorCode: payload.error?.code ?? "AMAZON_SESSION_READINESS_FAILED",
          message: payload.error?.message ?? "Amazon Session Readiness 未返回有效结果。",
          delivery: null,
          language: null,
        });
      }
    } catch {
      setSessionReadiness({
        loading: false,
        status: "ERROR",
        sessionReady: false,
        browserLaunched: false,
        errorCode: "AMAZON_SESSION_READINESS_FAILED",
        message: "Amazon Session Readiness 请求失败；未确认会话已就绪。",
        delivery: null,
        language: null,
      });
    }
  }, []);

  const checkPreflight = useCallback(async (includeSessionReadiness = false) => {
    setPreflight((prev) => ({ ...prev, loading: true }));
    if (includeSessionReadiness) {
      setSessionReadiness({
        loading: true,
        status: "CHECKING",
        sessionReady: false,
        browserLaunched: false,
        errorCode: null,
        message: "正在检查出口、浏览器和 Amazon US 会话。",
        delivery: null,
        language: null,
      });
    }
    try {
      const response = await fetch("/api/source-layer/amazon-preflight", {
        headers: buildAccessHeaders(),
      });
      const payload = await response.json() as {
        ok?: boolean;
        data?: {
          status?: PreflightState["status"];
          exitCountry?: string | null;
          exitCountryName?: string | null;
          proxyConfigured?: boolean;
          proxyProtocol?: string | null;
          errorCode?: string | null;
          message?: string | null;
        };
        error?: { code?: string; message?: string };
      };
      if (response.ok && payload.ok && payload.data) {
        const nextPreflight: PreflightState = {
          loading: false,
          status: payload.data.status ?? "UNKNOWN",
          exitCountry: payload.data.exitCountry ?? null,
          exitCountryName: payload.data.exitCountryName ?? null,
          proxyConfigured: Boolean(payload.data.proxyConfigured),
          proxyProtocol: payload.data.proxyProtocol ?? null,
          message: payload.data.message ?? null,
        };
        setPreflight(nextPreflight);
        if (includeSessionReadiness) {
          if (nextPreflight.status === "US_READY") {
            await checkAmazonSessionReadiness();
          } else {
            setSessionReadiness({
              loading: false,
              status: "PREFLIGHT_BLOCKED",
              sessionReady: false,
              browserLaunched: false,
              errorCode: payload.data.errorCode ?? "AMAZON_CAPTURE_PREFLIGHT_FAILED",
              message: payload.data.message ?? "美国出口检查未通过，未启动 Amazon 浏览器。",
              delivery: "UNKNOWN",
              language: null,
            });
          }
        }
      } else {
        setPreflight({
          loading: false,
          status: "UNKNOWN",
          exitCountry: null,
          exitCountryName: null,
          proxyConfigured: false,
          proxyProtocol: null,
          message: "预检服务暂未返回有效状态",
        });
        if (includeSessionReadiness) {
          setSessionReadiness({
            loading: false,
            status: "ERROR",
            sessionReady: false,
            browserLaunched: false,
            errorCode: payload.error?.code ?? "AMAZON_CAPTURE_PREFLIGHT_FAILED",
            message: payload.error?.message ?? "美国出口检查未返回有效结果。",
            delivery: null,
            language: null,
          });
        }
      }
    } catch {
      setPreflight({
        loading: false,
        status: "UNKNOWN",
        exitCountry: null,
        exitCountryName: null,
        proxyConfigured: false,
        proxyProtocol: null,
        message: "网络连接失败，未能完成出口预检",
      });
      if (includeSessionReadiness) {
        setSessionReadiness({
          loading: false,
          status: "ERROR",
          sessionReady: false,
          browserLaunched: false,
          errorCode: "AMAZON_CAPTURE_PREFLIGHT_FAILED",
          message: "网络连接失败，未能完成 Amazon 环境检查。",
          delivery: null,
          language: null,
        });
      }
    }
  }, [checkAmazonSessionReadiness]);

  useEffect(() => {
    void checkPreflight();
  }, [checkPreflight]);

  useEffect(() => {
    if (!busy) return;
    setElapsedSeconds(0);
    const timer = setInterval(() => setElapsedSeconds(seconds => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    setMode(initialMode);
    setError(null);
    setErrorDetails(null);
    setResult(null);
    setReceipt(null);
  }, [initialMode]);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setErrorDetails(null);
    setResult(null);
    setReceipt(null);
    setFailureKind("unknown");
    try {
      const endpoint = mode === "detail"
        ? "/api/source-layer/collect/amazon-detail"
        : "/api/source-layer/collect/amazon-search";
      const body = mode === "detail"
        ? { asin: asin.trim().toUpperCase() }
        : {
          query: query.trim(),
          authorizedItemLimit,
          ...deriveSearchBudget(authorizedItemLimit),
          operationId: searchOperationIdRef.current ?? (searchOperationIdRef.current = crypto.randomUUID()),
        };
      if (mode === "search" && (!Number.isSafeInteger(authorizedItemLimit) || authorizedItemLimit < 1)) {
        setError(`采集数量无效：${customLimitError ?? "请输入 1–200 之间的整数。"}`);
        setBusy(false);
        return;
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { ...buildAccessHeaders(), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as CaptureResponse;
      if (!response.ok || !payload.ok) {
        if (mode === "search" && !["PRODUCT_BATCH_HANDOFF_FAILED", "AMAZON_SEARCH_OPERATION_IN_PROGRESS", "AMAZON_SEARCH_OWNER_UNVERIFIED"].includes(payload.error?.code ?? "")) {
          searchOperationIdRef.current = null;
        }
        // 按服务端错误码区分用户状态：需要登录授权 / 需要人工确认 / 页面变化 / 网络失败 / 输入错误。
        const kind = classifyAmazonCaptureFailure(payload.error?.code);
        setFailureKind(kind);
        const guidance = amazonCaptureFailureGuidance(kind);
        setError(`${guidance.title}：${guidance.hint}`);
        setErrorDetails(`Amazon 采集未完成。\n状态：${payload.error?.status || "failed"}\n错误码：${payload.error?.code || "CAPTURE_REQUEST_FAILED"}\n原因：${payload.error?.message || "服务端未返回有效响应。"}\ntraceId：${payload.error?.traceId || "未提供"}`);
        return;
      }

      const outcome = resolveAmazonCaptureOutcome({
        status: payload.data?.status,
        mode,
        readyCount: payload.data?.capture?.readyCount,
        observationCount: payload.data?.plan?.totalObservationCount ?? payload.data?.captures?.length,
        uniqueProductCount: payload.data?.productBatchHandoff?.itemCount,
        targetCount: payload.data?.authorizedItemLimit,
        partial: payload.data?.partial,
        errorCode: payload.data?.errorCode ?? payload.error?.code,
        errorMessage: payload.data?.errorMessage ?? payload.error?.message,
        traceId: payload.data?.traceId,
      });
      if (!outcome.success) {
        if (mode === "search") searchOperationIdRef.current = null;
        const kind = classifyAmazonCaptureFailure(outcome.errorCode);
        setFailureKind(kind);
        const guidance = amazonCaptureFailureGuidance(kind);
        setResult(null);
        setError(`${outcome.message}\n${guidance.title}：${guidance.hint}`);
        setErrorDetails(`${outcome.message}\n状态：${outcome.status}\n错误码：${outcome.errorCode}\n原因：${outcome.errorMessage}\ntraceId：${outcome.traceId}`);
        return;
      }
      setResult(outcome.message);
      setReceipt(payload.data ?? null);
      if (mode === "search") searchOperationIdRef.current = null;
      onCaptured(outcome.message);
      onRefresh();
    } catch (caught) {
      setFailureKind("network");
      setError("网络连接未完成，请检查网络后重试。采集结果尚未确认。");
      setErrorDetails(formatAmazonCaptureRequestFailure(caught));
    } finally {
      setBusy(false);
    }
  }

  const hasInput = mode === "detail"
    ? /^[A-Z0-9]{10}$/.test(asin.trim().toUpperCase())
    : query.trim().length > 0;
  const knownSessionBlocked = !sessionReadiness.loading && !sessionReadiness.sessionReady
    && !["IDLE", "CHECKING"].includes(sessionReadiness.status);
  const canSubmit = hasInput && preflight.status === "US_READY" && !preflight.loading
    && !sessionReadiness.loading && !knownSessionBlocked && (mode !== "search" || !customLimitError);
  const networkReady = !preflight.loading && preflight.status === "US_READY";
  const sessionLabel = sessionReadiness.loading ? "核验中" : sessionReadiness.sessionReady ? "已通过" : sessionReadiness.status === "IDLE" ? "待核验" : "需处理";
  const networkLabel = preflight.loading ? "检查中" : networkReady ? "美国出口" : preflight.status === "NON_US_EXIT" ? "非美国出口" : preflight.status === "PROXY_INVALID" ? "配置异常" : "尚未确认";
  const blockingReason = preflight.loading ? "正在检查网络出口…"
    : !networkReady ? preflight.status === "NON_US_EXIT" ? "当前出口非美国，采集已禁用。请切换美国节点后重新检查。" : preflight.status === "PROXY_INVALID" ? "代理配置异常，请修复后重新检查。" : "尚未确认美国出口，请重新检查网络。"
    : sessionReadiness.loading ? "正在核验 Amazon 会话…"
    : knownSessionBlocked ? sessionReadiness.status === "ACQUISITION_DISABLED" ? "当前环境未开放采集，请先确认采集授权。" : sessionReadiness.message || "会话尚未通过核验，请处理后重新检查。"
    : !hasInput ? mode === "search" ? "输入关键词，选择本次采集数量。" : "输入一个 10 位 ASIN，开始补录商品事实。"
    : customLimitError && mode === "search" ? customLimitError
    : sessionReadiness.sessionReady ? "环境检查已通过，实际结果以来源页面与服务端校验为准。" : "美国出口已通过；会话、登录与页面权限将在提交后继续核验。";
  const resultTone = result ? receipt?.partial ? "partial" : "success" : ["human_confirmation", "login_required"].includes(failureKind) ? "human" : "error";
  const resultTitle = result ? receipt?.partial ? "已保存部分结果" : "采集结果已保存" : resultTone === "human" ? "需要你处理" : "本次采集未完成";
  const savedCount = mode === "search" ? receipt?.productBatchHandoff?.itemCount : receipt?.capture?.readyCount;

  return (
    <section className={styles.workspace} data-mode={mode} data-testid="amazon-capture-workspace" aria-busy={busy}>
      {showModeSelector && <div className={styles.modeSwitch} role="group" aria-label="Amazon 采集方式">
        {([["detail", "单 ASIN 补录"], ["search", "关键词市场"]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={mode === value} disabled={busy}
          onClick={() => { setMode(value); onModeChange?.(value); setError(null); setResult(null); setReceipt(null); }}>{label}</button>)}
      </div>}
      <header className={styles.intro}>
        <span className={styles.eyebrow}><Globe2 size={14} aria-hidden="true" /> AMAZON US <i /> {mode === "search" ? "市场样本" : "商品事实"}</span>
        {showHeading && <p className={styles.contextTitle}>{mode === "search" ? "关键词市场采集" : "商品事实采集"}</p>}
        <h3>{mode === "search" ? <>从一个关键词，<em>找到一批商品。</em></> : <>一个 ASIN，<em>补齐商品事实。</em></>}</h3>
        <p>{mode === "search" ? "从 Amazon 搜索结果取得商品样本，整理成可检阅的采集批次。" : "读取单个商品页面的可见信息，保留来源与真实缺口。"}</p>
      </header>
      <form onSubmit={event => { event.preventDefault(); if (canSubmit && !busy) void submit(); }}>
        <div className={styles.body}>
          <div className={styles.controls}>
            <div className={styles.inputSection}>
              <label htmlFor={inputId} className={styles.label}>{mode === "search" ? "你想了解哪个市场？" : "要补录哪件商品？"}</label>
              <div className={styles.commandInput} data-valid={hasInput}>
                <span className={styles.inputIcon}>{mode === "search" ? <Search size={23} aria-hidden="true" /> : <Fingerprint size={25} aria-hidden="true" />}</span>
                <input id={inputId} aria-describedby={`${inputId}-hint`} value={mode === "search" ? query : asin} disabled={busy}
                  onChange={event => mode === "search" ? setQuery(event.target.value) : setAsin(event.target.value)}
                  placeholder={mode === "search" ? "例如 insulated water bottle" : "B0XXXXXXXX"} autoComplete="off" spellCheck={false}
                  aria-invalid={mode === "detail" && asin.trim().length > 0 && !hasInput} inputMode="text" data-testid="amazon-capture-input" />
                {hasInput && <CheckCircle2 size={18} aria-label="输入格式有效" className={styles.validIcon} />}
                <span className={styles.inputMarket}>US</span>
              </div>
              <p id={`${inputId}-hint`} className={styles.hint}>{mode === "search" ? "使用原始关键词即可，不会调用翻译或付费 AI。" : asin.trim().length > 0 && !hasInput ? "ASIN 应为 10 位字母或数字，请检查后重试。" : "仅支持美国站 · 10 位字母或数字"}</p>
            </div>
            {mode === "search" && <fieldset className={styles.quantity} disabled={busy} data-testid="authorized-item-limit-control">
              <legend className={styles.label}>这次采集多少？<span>授权上限，按实际结果保存</span></legend>
              <div className={styles.segments} style={{ "--quota-index": limitMode === "custom" ? 4 : AUTHORIZED_ITEM_OPTIONS.indexOf(presetLimit as typeof AUTHORIZED_ITEM_OPTIONS[number]) } as CSSProperties}>
                <span className={styles.quotaIndicator} aria-hidden="true" />
                {AUTHORIZED_ITEM_OPTIONS.map(option => <label key={option}>
                  <input type="radio" name={`${inputId}-limit`} value={option} checked={limitMode === "preset" && presetLimit === option}
                    onChange={() => { setLimitMode("preset"); setPresetLimit(option); }} data-testid={`limit-preset-${option}`} />
                  <span><b>{option}</b><small>件</small></span>
                </label>)}
                <label><input type="radio" name={`${inputId}-limit`} checked={limitMode === "custom"} onChange={() => setLimitMode("custom")} data-testid="limit-mode-custom" /><span>自定义</span></label>
              </div>
              {limitMode === "custom" && <div className={styles.customQuantity}>
                <label htmlFor={`${inputId}-custom`}>自定义数量</label><input id={`${inputId}-custom`} type="number" min={1} max={AUTHORIZED_ITEM_MAX} step={1} inputMode="numeric" value={customLimit}
                  onChange={event => setCustomLimit(event.target.value)} data-testid="authorized-item-limit-custom" aria-invalid={Boolean(customLimitError)} aria-describedby={customLimitError ? `${inputId}-limit-error` : undefined} /><span>件 · 1–{AUTHORIZED_ITEM_MAX}</span>
                {customLimitError && <p id={`${inputId}-limit-error`} role="alert" data-testid="authorized-item-limit-error">{customLimitError}</p>}
              </div>}
            </fieldset>}
            <section className={styles.readiness} aria-label="采集条件">
              <div className={styles.sectionHeading}><span className={styles.label}>采集前检查</span><button type="button" onClick={() => void checkPreflight(true)} disabled={busy || preflight.loading || sessionReadiness.loading} data-testid="capture-recheck"><RefreshCw size={14} className={preflight.loading || sessionReadiness.loading ? styles.spin : undefined} aria-hidden="true" />重新检查</button></div>
              <div className={styles.conditions}>
                <div data-tone={networkReady ? "ok" : preflight.loading ? "pending" : "warn"}><Globe2 size={17} aria-hidden="true" /><span>网络出口</span><b data-testid="capture-network-status">{networkLabel}</b></div>
                <div data-tone={sessionReadiness.sessionReady ? "ok" : sessionReadiness.status === "IDLE" || sessionReadiness.loading ? "pending" : "warn"} data-testid="amazon-session-readiness"><ShieldCheck size={17} aria-hidden="true" /><span>Amazon 会话</span><b>{sessionLabel}</b></div>
                <div data-tone={sessionReadiness.status === "ACQUISITION_DISABLED" ? "warn" : "pending"}><LockKeyhole size={17} aria-hidden="true" /><span>采集授权</span><b>{sessionReadiness.status === "ACQUISITION_DISABLED" ? "未开放" : "服务端核验"}</b></div>
              </div>
              <p className={styles.readinessNote}>重新检查可能打开专用浏览器，不会自动开始采集。</p>
            </section>
          </div>
          {mode === "search" && <aside className={styles.destination} aria-label="采集成果说明">
            <div className={styles.destinationSymbol} aria-hidden="true"><Layers size={30} /><span /><span /></div>
            <span className={styles.destinationEyebrow}>采集后，得到什么</span>
            <h4>一批商品，<br />一份可追溯的起点。</h4>
            <p>最多 <b>{Number.isFinite(authorizedItemLimit) ? authorizedItemLimit : "—"}</b> 件不同商品<br />按来源实际可得结果保存</p>
            <ul><li><PackageCheck size={17} aria-hidden="true" /><span>商品样本<small>图片、标题与可见属性</small></span></li><li><FileCheck2 size={17} aria-hidden="true" /><span>资料与证据<small>取得情况、来源和真实缺口</small></span></li><li><Database size={17} aria-hidden="true" /><span>批次工作区<small>看图、比较数据、继续检阅</small></span></li></ul>
            <div className={styles.destinationFoot}>不保证满额；建立研究仍需通过原有门禁。</div>
          </aside>}
        </div>
        {mode === "detail" && <div className={styles.singleOutcome}><FileCheck2 size={19} aria-hidden="true" /><span><b>补录商品事实</b><small>取得情况与来源证据一并保留；不会自动加入市场研究样本。</small></span></div>}
        {(result || error) && <section ref={resultRef} className={styles.result} data-tone={resultTone} data-testid="amazon-capture-result" role={error ? "alert" : "status"}>
          <span className={styles.resultIcon}>{result ? <CheckCircle2 size={23} aria-hidden="true" /> : <AlertCircle size={23} aria-hidden="true" />}</span>
          <div><div className={styles.resultHeading}><h4>{resultTitle}</h4>{result && typeof savedCount === "number" && <strong>{savedCount}<small>{mode === "search" ? " 件商品" : " 条可用事实"}</small></strong>}</div>
            <p>{result || error}</p>
            {receipt?.partial && <p className={styles.partialNext}>已保存成果会保留；先查看缺口与受阻原因，再决定下一步。</p>}
            {errorDetails && <details><summary>查看错误详情</summary><pre>{errorDetails}</pre></details>}
          </div>
        </section>}
        {busy && <div className={styles.running} role="status" aria-live="polite" data-testid="amazon-capture-wait"><span className={styles.shine} aria-hidden="true" /><Loader2 size={20} className={styles.spin} aria-hidden="true" /><div><strong>正在等待来源与服务端返回</strong><p>已等待 {elapsedSeconds} 秒 · 结果尚未确认，请勿重复提交。</p></div></div>}
        <div className={styles.footer}>
          <p data-testid="capture-availability" role="status" aria-live="polite" data-blocked={!canSubmit && hasInput}><span className={styles.availabilityDot} />{blockingReason}</p>
          <button type="submit" className={styles.submit} disabled={busy || !canSubmit} data-testid="amazon-capture-submit">
            {busy ? <Loader2 size={18} className={styles.spin} aria-hidden="true" /> : mode === "search" ? <Search size={18} aria-hidden="true" /> : <PackageCheck size={18} aria-hidden="true" />}
            {busy ? "等待采集结果" : mode === "search" ? "开始采集市场样本" : "采集这件商品"}{!busy && <ArrowRight size={17} aria-hidden="true" />}
          </button>
        </div>
      </form>
      <details className={styles.advanced} data-testid="capture-advanced">
        <summary>范围、预算与高级信息<ChevronDown size={14} aria-hidden="true" /></summary>
        <div className={styles.advancedBody}>
          {mode === "search" && !customLimitError && <p data-testid="authorized-item-limit-notice">本次批准最多 {authorizedItemLimit} 件不同商品；搜索范围 {deriveSearchBudget(authorizedItemLimit).pages} 页、最多 {deriveSearchBudget(authorizedItemLimit).maxAppearances} 条样本。采集模块：Amazon 搜索市场 + 商品详情 / 父子变体 / 评论与 VOC；运行预算每次最多 5 件，最多 {deriveNavigationBudget(authorizedItemLimit, AUTO_CAPTURE_MODULE_COUNT, deriveSearchBudget(authorizedItemLimit).pages)} 次主动页面导航（与搜索阶段共享，不含页面内部跳转）。服务端按同一上限校验。</p>}
          <p>美国站范围不变；网络出口：{networkReady ? "美国 · 已通过检查" : networkLabel}。{preflight.message}</p>
          <p>实际采集：出口通过不代表登录、配送地区、语言和页面可读性全部通过。</p>
          <p>会话状态：{sessionReadiness.errorCode ?? sessionReadiness.status}；{sessionReadiness.browserLaunched ? "Chrome/Edge 已启动" : "未确认浏览器已启动"}。{sessionReadiness.message}</p>
          {sessionReadiness.sessionReady && <p>配送地区：{sessionReadiness.delivery ?? "UNKNOWN"} · 语言：{sessionReadiness.language || "UNKNOWN"}</p>}
          {receipt && <p>操作编号：{receipt.operationId || "未提供"} · 追踪号：{receipt.traceId || "未提供"} · 来源状态：{receipt.status || "未提供"}</p>}
          <p>登录、验证码和平台许可不会被自动绕过；有证据不代表资料全部完整。</p>
        </div>
      </details>
    </section>
  );
}
