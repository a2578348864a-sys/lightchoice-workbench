"use client";

import { useCallback, useEffect, useState } from "react";

import { buildAccessHeaders } from "@/lib/client/accessToken";

type CaptureModule = "reverse_asin" | "keyword_mining_trend";
type CaptureJobStatus = "PENDING" | "RUNNING" | "PAUSED" | "COMPLETE" | "PARTIAL" | "FAILED" | "CANCELLED";
type CaptureCursor = { page: number; scrollY: number; scrollTarget?: "document" | "table" } | null;
type CaptureCounters = {
  reportedTotalRows: number | null;
  accessibleRows: number | null;
  capturedUniqueRows: number;
  structuredValidRows: number;
  persistedEvidenceRows: number;
  unavailableRows: number | null;
};
type CaptureDiagnostics = {
  actualVisibleRows: number;
  duplicatesRejected: number;
  rejectedRows: number;
  windowsProcessed: number;
  cursorRestored?: boolean | null;
};
type CaptureJob = {
  jobId: string;
  module: CaptureModule;
  status: CaptureJobStatus;
  query: Record<string, string>;
  windowBudget: number;
  cursor: CaptureCursor;
  persistedRowKeys?: readonly string[];
  evidenceRefs?: readonly string[];
  counters: CaptureCounters;
  diagnostics?: CaptureDiagnostics;
  limitationReason: string;
  lastErrorCode: string | null;
  leaseExpiresAt?: string | null;
};
type ApiPayload = {
  ok?: boolean;
  data?: { captureJob?: CaptureJob };
  error?: { code?: string; message?: string };
};
type CaptureEnvironmentPayload = {
  ok?: boolean;
  data?: { cdpReachable?: boolean; nextAction?: string; browserIdentity?: string | null };
};

const JOB_STORAGE_KEY = "lightchoice-v5-sellersprite-visible-job";
export function marketCaptureStorageKey(scanId: string | undefined, captureModule: CaptureModule, asin: string, keyword: string) {
  return scanId ? `${JOB_STORAGE_KEY}:${scanId}:${captureModule}:${captureModule === "reverse_asin" ? asin.toUpperCase() : keyword.normalize("NFC").trim().toLocaleLowerCase()}` : JOB_STORAGE_KEY;
}
const MODULE_URL: Record<CaptureModule, string> = {
  reverse_asin: "https://www.sellersprite.com/v3/keyword-reverse/",
  keyword_mining_trend: "https://www.sellersprite.com/v3/keyword-miner/",
};
const ASIN_PATTERN = /^[A-Z0-9]{10}$/u;

function metric(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : "未报告";
}

function moduleLabel(module: CaptureModule): string {
  return module === "reverse_asin" ? "竞品反查" : "关键词挖掘";
}

/**
 * CDP 前置禁用判定（纯函数）：服务端只读预检明确不可达时才提前禁用「开始采集」；
 * 预检失败/未返回（null/undefined）保持 fail-open；prepare 按钮不受影响。
 */
export function shouldDisableSellerSpriteCapture(input: {
  canCapture: boolean;
  cdpReachable?: boolean | null;
}): boolean {
  return !input.canCapture || input.cdpReachable === false;
}

export function SellerSpriteKeywordCapturePanel({ initialModule = "reverse_asin", initialAsin = "", initialKeyword = "", researchScanId, embedded=false, onEvidenceReady, environmentReadiness }: { environmentReadiness?: CaptureEnvironmentPayload["data"] | null; embedded?:boolean; onEvidenceReady?:(subjectKey:string)=>Promise<void>; initialModule?: CaptureModule; initialAsin?: string; initialKeyword?: string; researchScanId?: string } = {}) {
  const [module, setModule] = useState<CaptureModule>(initialModule);
  const [subjectAsin, setSubjectAsin] = useState(initialAsin);
  const [seedKeyword, setSeedKeyword] = useState(initialKeyword);
  const [windowBudget, setWindowBudget] = useState(1);
  const [job, setJob] = useState<CaptureJob | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [cdpReachable, setCdpReachable] = useState<boolean | null>(null);
  const [cdpNextAction, setCdpNextAction] = useState("");
  const storageKey = marketCaptureStorageKey(researchScanId, initialModule, initialAsin, initialKeyword);

  const post = useCallback(async (body: Record<string, unknown>): Promise<ApiPayload> => {
    const response = await fetch("/api/source-layer/acquire/sellersprite-visible", {
      method: "POST",
      headers: { ...buildAccessHeaders(), "content-type": "application/json" },
      body: JSON.stringify({...body,...(researchScanId?{researchScanId}:{})}),
      cache: "no-store",
    });
    const payload = await response.json() as ApiPayload;
    const updatedJob = payload.data?.captureJob;
    if (updatedJob) {
      setJob(updatedJob);
      sessionStorage.setItem(storageKey, updatedJob.jobId);
      setWindowBudget(updatedJob.windowBudget);
    }
    if (!response.ok || payload.ok === false) {
      setError({
        code: payload.error?.code || "SELLERSPRITE_CAPTURE_REQUEST_FAILED",
        message: payload.error?.message || "SellerSprite 采集请求未完成；请先核对当前持久任务状态。",
      });
    }
    return payload;
  }, [storageKey,researchScanId]);

  useEffect(() => {
    let active = true;
    const savedJobId = sessionStorage.getItem(storageKey);
    if (!savedJobId) {
      setRestoring(false);
      return () => { active = false; };
    }

    void (async () => {
      try {
        const payload = await post({ action: "status", jobId: savedJobId });
        if (!active) return;
        const restoredJob = payload.data?.captureJob;
        if (!restoredJob) return;
        setModule(restoredJob.module);
        setWindowBudget(restoredJob.windowBudget);
        const asin = restoredJob.query.subjectKey?.match(/amazon:US:([A-Z0-9]{10})$/u)?.[1] ?? "";
        setSubjectAsin(asin);
        setSeedKeyword(restoredJob.query.seedKeyword ?? "");
        setNotice("已恢复上次采集任务的查询条件与进度；不会自动开始新的采集。");
      } catch {
        if (active) setError({ code: "CAPTURE_JOB_RESTORE_NETWORK_ERROR", message: "无法读取上次任务状态；没有发起页面采集。" });
      } finally {
        if (active) setRestoring(false);
      }
    })();
    return () => { active = false; };
  }, [post, storageKey]);

  // 挂载时只读预检一次 CDP 可达性：不可达则提前禁用「开始采集」；超时/失败静默 fail-open。
  useEffect(() => {
    if (environmentReadiness !== undefined) {
      setCdpReachable(environmentReadiness?.cdpReachable === undefined ? null : environmentReadiness.cdpReachable && environmentReadiness.browserIdentity !== "foreign");
      setCdpNextAction(environmentReadiness?.browserIdentity === "foreign" ? "连接到的不是工作台专用浏览器，请启动专用实例。" : environmentReadiness?.nextAction ?? "");
      return;
    }
    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 1500);
    void (async () => {
      try {
        const response = await fetch("/api/source-layer/capture-environment", {
          headers: buildAccessHeaders(),
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json() as CaptureEnvironmentPayload;
        if (!active || !response.ok || !payload.ok || typeof payload.data?.cdpReachable !== "boolean") return;
        setCdpReachable(payload.data.cdpReachable);
        if (typeof payload.data.nextAction === "string") setCdpNextAction(payload.data.nextAction);
      } catch {
        // 预检失败不禁用按钮（fail-open），既有错误展示保持不变。
      } finally {
        window.clearTimeout(timer);
      }
    })();
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [environmentReadiness]);

  useEffect(() => {
    if (!capturing || !job?.jobId) return;
    let active = true;
    const timer = window.setInterval(() => {
      void post({ action: "status", jobId: job.jobId }).catch(() => {
        if (active) setNotice("运行请求仍在等待；最近一次任务状态读取暂不可用。")
      });
    }, 900);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [capturing, job?.jobId, post]);

  function requestIdentity() {
    const asin = subjectAsin.trim().toUpperCase();
    if (module === "reverse_asin") {
      if (!ASIN_PATTERN.test(asin)) throw new Error("反查ASIN需要明确的10位美国站商品身份。");
      return {
        module,
        sourceUrl: MODULE_URL[module],
        subjectKey: `amazon:US:${asin}`,
        identity: { asin },
        queryInput: { module, targetAsin: asin, marketplace: "US" },
        windowBudget,
      };
    }
    const keyword = seedKeyword.normalize("NFC").trim();
    if (!keyword || keyword.length > 120) throw new Error("请输入 1 到 120 个字符的 Keyword Mining 种子关键词。");
    return {
      module,
      sourceUrl: MODULE_URL[module],
      subjectKey: "sellersprite-query:auto",
      identity: { keyword },
      queryInput: { module, seedKeyword: keyword, marketplace: "US" },
      windowBudget,
    };
  }

  async function prepareJob() {
    setError(null);
    setNotice("");
    let request: ReturnType<typeof requestIdentity>;
    try {
      request = requestIdentity();
    } catch (cause) {
      setError({ code: "SELLERSPRITE_CAPTURE_INPUT_INVALID", message: cause instanceof Error ? cause.message : "查询输入无效。" });
      return;
    }
    setPreparing(true);
    try {
      const payload = await post({ ...request, action: "prepare" });
      if (payload.ok && payload.data?.captureJob) {
        setNotice("采集任务已创建并保存。请点击「开始采集（下一段）」才会真正打开页面读取数据。");
      }
    } catch (cause) {
      setError({ code: "SELLERSPRITE_CAPTURE_PREPARE_NETWORK_ERROR", message: cause instanceof Error ? cause.message : "无法创建采集任务。" });
    } finally {
      setPreparing(false);
    }
  }

  async function runWindow(recheck = false) {
    setError(null);
    setNotice("");
    let request: ReturnType<typeof requestIdentity>;
    try {
      request = requestIdentity();
    } catch (cause) {
      setError({ code: "SELLERSPRITE_CAPTURE_INPUT_INVALID", message: cause instanceof Error ? cause.message : "查询输入无效。" });
      return;
    }
    setCapturing(true);
    setNotice("正在采集一段可见结果；结束后会保存进度。暂停/取消会在下一个保存点生效。");
    try {
      const payload = await post({ ...request, ...(recheck ? { action: "recheck", jobId: job?.jobId, windowBudget: 1 } : {}) });
      if (payload.ok && payload.data?.captureJob) {
        const completedJob = payload.data.captureJob;
        setNotice(completedJob.status === "PARTIAL" && completedJob.limitationReason === "budget_stop"
          ? "本段预算已用完；断点已保存，可显式执行下一窗口。"
          : completedJob.status === "COMPLETE" ? "页面可见分页已结束，任务状态为 COMPLETE。"
            : completedJob.status === "PARTIAL" && completedJob.limitationReason === "source_limit_declared"
              ? (completedJob.counters.persistedEvidenceRows > 0
                ? "页面声明套餐访问受限；本次可见结果已保存并停止继续访问。"
                : "页面声明套餐访问受限；保留已有结果并停止继续访问。")
              : "本轮状态已保存，请按下方覆盖计数核对结果。");
      }
    } catch (cause) {
      setError({
        code: "SELLERSPRITE_CAPTURE_RUN_NETWORK_ERROR",
        message: cause instanceof Error ? cause.message : "采集请求未能连接工作台；请刷新任务状态后再重试。",
      });
    } finally {
      setCapturing(false);
    }
  }

  async function performAction(action: "status" | "pause" | "resume" | "cancel") {
    if (!job) return;
    setError(null);
    setActionBusy(true);
    try {
      const payload = await post({ action, jobId: job.jobId });
      const updated = payload.data?.captureJob;
      if (payload.ok && updated) {
        setNotice(action === "resume" ? "任务已恢复为待执行；请显式执行下一窗口。"
          : action === "pause" ? "暂停请求已保存；在途窗口会在下一个检查点停下。"
            : action === "cancel" ? "取消状态已保存；已经持久化的 Evidence 仍保留。"
              : "已读取最新持久任务状态。");
      }
    } catch (cause) {
      setError({
        code: "CAPTURE_JOB_ACTION_NETWORK_ERROR",
        message: cause instanceof Error ? cause.message : "任务操作未能连接工作台；请刷新持久状态。",
      });
    } finally {
      setActionBusy(false);
    }
  }

  function startNewQuery() {
    sessionStorage.removeItem(storageKey);
    setJob(null);
    setSubjectAsin("");
    setSeedKeyword("");
    setError(null);
    setNotice("旧任务仍保留在 SQLite；此面板现在可创建另一条查询。");
  }

  const queryLocked = restoring || preparing || capturing || Boolean(job);
  const canRun = Boolean(job) && !capturing && !preparing
    && (job?.status === "PENDING" || job?.status === "PARTIAL" || job?.status === "FAILED")
    && job?.limitationReason !== "source_limit_declared";
  const cdpBlocked = canRun && cdpReachable === false;
  const runDisabled = shouldDisableSellerSpriteCapture({ canCapture: canRun, cdpReachable });
  const cursorRestored = job?.diagnostics?.cursorRestored;

  const sourceLimited = job?.limitationReason === "source_limit_declared";
  const savedRows = job?.counters.persistedEvidenceRows ?? 0;
  const jobLabel = job?.status === "RUNNING" ? "采集中" : sourceLimited ? (savedRows ? "已有结果 · 来源受限" : "本次快照无可用结果 · 来源受限") : job?.status === "PARTIAL" ? (savedRows ? "已有部分结果" : "尚无可用结果") : job?.status === "COMPLETE" ? "已保存可见结果" : job?.status === "PAUSED" ? "已暂停" : job?.status === "CANCELLED" ? "已取消" : job?.status === "FAILED" ? "采集未完成" : "待采集";
  const working = preparing || capturing || actionBusy || restoring;

  return (
    <section className="space-y-5" aria-label={moduleLabel(module)} data-testid="sellersprite-depth-capture-panel">
      {!embedded && <header><h2 className="text-lg font-semibold">{moduleLabel(module)}</h2><p className="text-sm text-slate-500">关键词查询与正式商品样本二者保持独立。</p></header>}
      {job && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 px-4 py-3" data-testid="sellersprite-depth-job">
        <strong>{jobLabel}</strong><span>本次快照已保存 <b>{savedRows}</b> 条 · 保留 {job.evidenceRefs?.length ?? 0} 份来源引用</span>
      </div>}
      {restoring && <p role="status">正在读取上次任务…</p>}
      <fieldset disabled={queryLocked} className="space-y-4">
        {!embedded && <label className="block">采集什么<select id="sellersprite-depth-module" data-testid="sellersprite-depth-module" value={module} onChange={e=>setModule(e.target.value as CaptureModule)} className="mt-2 w-full rounded-lg border p-3"><option value="reverse_asin">竞品反查</option><option value="keyword_mining_trend">关键词挖掘</option></select></label>}
        {module === "reverse_asin" ? <label className="block" htmlFor="sellersprite-depth-subject-asin">商品 ASIN（美国站）<input id="sellersprite-depth-subject-asin" data-testid="sellersprite-depth-subject-asin" value={subjectAsin} maxLength={10} autoComplete="off" onChange={e=>setSubjectAsin(e.target.value.toUpperCase())} className="mt-2 w-full rounded-lg border p-3"/></label>
          : <label className="block" htmlFor="sellersprite-depth-seed-keyword">种子关键词<input id="sellersprite-depth-seed-keyword" data-testid="sellersprite-depth-seed-keyword" value={seedKeyword} maxLength={120} autoComplete="off" onChange={e=>setSeedKeyword(e.target.value)} className="mt-2 w-full rounded-lg border p-3"/></label>}
      </fieldset>
      {error && <div role="alert" className="rounded-lg bg-rose-50 p-3 text-rose-900" data-testid="sellersprite-depth-error"><p>{error.message}</p><details><summary>错误详情</summary><code>{error.code}</code></details></div>}
      {sourceLimited && <p className="rounded-lg bg-amber-50 p-3 text-amber-900">来源声明套餐访问限制。权限或会话恢复后，可重新核验并读取 1 段；仍受限就停止，旧记录保留。</p>}
      {cdpBlocked && <p role="status" className="text-amber-800" data-testid="sellersprite-depth-cdp-blocked">SellerSprite CDP 不可达：先启动专用浏览器并登录{cdpNextAction && <span className="block text-sm">{cdpNextAction}</span>}</p>}
      {notice && !notice.startsWith("已恢复上次") && !notice.startsWith("已读取最新") && <p role="status" className="text-sm text-slate-600">{notice}</p>}
      <div className="flex flex-wrap items-center gap-3" data-testid="sellersprite-depth-actions">
        {!job ? <button type="button" data-testid="sellersprite-depth-prepare" disabled={working} onClick={()=>void prepareJob()}>{preparing ? "正在准备…" : "准备采集"}</button>
          : sourceLimited ? <button type="button" data-testid="sellersprite-depth-recheck" disabled={working || cdpReachable===false || (job.status==="RUNNING" && (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt)>Date.now()))} onClick={()=>void runWindow(true)}>重新核验并读取 1 段</button>
          : job.status==="PAUSED" ? <button type="button" data-testid="sellersprite-depth-resume" disabled={working} onClick={()=>void performAction("resume")}>恢复任务</button>
          : ["PENDING","PARTIAL","FAILED"].includes(job.status) ? <button type="button" data-testid="sellersprite-depth-run" data-cdp-blocked={cdpBlocked?"true":"false"} disabled={runDisabled || actionBusy} onClick={()=>void runWindow()}>{capturing ? "正在采集…" : "开始采集（下一段）"}</button> : null}
        {job && <button type="button" data-testid="sellersprite-depth-refresh" disabled={actionBusy} onClick={()=>void performAction("status")}>刷新进度</button>}
        {job?.status==="RUNNING" && <button type="button" data-testid="sellersprite-depth-pause" disabled={actionBusy} onClick={()=>void performAction("pause")}>暂停</button>}
        {Boolean(job?.evidenceRefs?.length) && onEvidenceReady && <button type="button" disabled={working} onClick={()=>{setActionBusy(true);void onEvidenceReady(job!.query.subjectKey).then(()=>setNotice("已关联并刷新当前研究。"),e=>setError({code:"RESEARCH_BIND_FAILED",message:e.message??"关联未完成，可重试关联，无需重复采集。"})).finally(()=>setActionBusy(false));}}>关联已有结果</button>}
      </div>
      <details className="rounded-xl border border-slate-200 p-4" data-testid="sellersprite-depth-advanced">
        <summary className="cursor-pointer text-sm text-slate-600">采集范围与任务详情</summary>
        <div className="mt-4 space-y-3 text-sm" data-testid="sellersprite-depth-job-details">
          <label className="block">本次采集范围（1–20 段）<input type="number" min={1} max={20} step={1} value={windowBudget} disabled={working||job?.status==="RUNNING"||job?.status==="COMPLETE"||sourceLimited} onChange={e=>setWindowBudget(Math.max(1,Math.min(20,Number(e.target.value)||1)))} data-testid="sellersprite-depth-window-budget" className="ml-3 w-20 rounded border p-2"/></label>
          <p>只读取账号可见数据；页面报告总量不代表已取得数量。关闭弹窗保留任务，不自动开始新的采集。</p>
          {job && <>
            <p>任务 {job.jobId} · 来源限制：{job.limitationReason}</p>
            <dl className="grid grid-cols-2 gap-2">
              <Metric label="当前页可见行" value={metric(job.diagnostics?.actualVisibleRows)}/>
              <Metric label="本快照去重行" value={metric(job.counters.capturedUniqueRows)}/>
              <Metric label="来源报告总量" value={metric(job.counters.reportedTotalRows)}/>
              <Metric label="来源可访问行" value={metric(job.counters.accessibleRows)}/>
              <Metric label="有效解析行" value={metric(job.counters.structuredValidRows)}/>
              <Metric label="已保存可用行" value={metric(job.counters.persistedEvidenceRows)}/>
              <Metric label="未开放行" value={metric(job.counters.unavailableRows)}/>
              <Metric label="已拒绝重复行" value={metric(job.diagnostics?.duplicatesRejected)}/>
            </dl>
            <p>断点恢复（CursorRestored）：{cursorRestored===true?"已恢复":cursorRestored===false?"恢复失败":cursorRestored===null?"无断点":"旧任务未记录恢复结果"}</p>
            {job.lastErrorCode && <p>最近错误：{job.lastErrorCode}</p>}
            <div className="flex gap-3">
              {["RUNNING","PENDING","PAUSED","PARTIAL"].includes(job.status) && <button type="button" data-testid="sellersprite-depth-cancel" disabled={actionBusy} onClick={()=>void performAction("cancel")}>取消任务</button>}
              <button type="button" data-testid="sellersprite-depth-new-query" disabled={working||job.status==="RUNNING"} onClick={startNewQuery}>新建查询</button>
            </div>
          </>}
        </div>
      </details>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="mt-0.5 font-semibold text-slate-900">{value}</dd>
    </div>
  );
}
