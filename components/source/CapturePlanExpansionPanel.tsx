"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  confirmCaptureExpansion,
  fetchCaptureExpansionPreview,
  recoverStalledCaptureExpansion,
  type CaptureExpansionConfirmResult,
  type CaptureExpansionRecovery,
  type CaptureExpansionPreviewResult,
} from "@/lib/client/capturePlanExpansionClient";
import type { MarketCaptureExpansionPreview } from "@/lib/sourceLayer/captureStrategy/marketCaptureExpansion";
import { HARD_MAX_AUTHORIZED_ITEMS } from "@/lib/sourceLayer/captureBudgetConstants";

export type CapturePlanExpansionPanelProps = {
  batchId: string;
  batchCapacity: number;
  onExpansionComplete?: () => void | Promise<void>;
  previewer?: typeof fetchCaptureExpansionPreview;
  confirmer?: typeof confirmCaptureExpansion;
};

function blockerMessage(preview: MarketCaptureExpansionPreview): string | null {
  switch (preview.blocker) {
    case "run_missing": return "请先确认原始采集计划。 / Confirm the initial capture plan first.";
    case "run_state_unknown": return "任务状态未知，暂不能扩充。 / Run state is unknown; expansion is blocked.";
    case "run_still_running": return "原 Run 仍在运行或等待执行。请先完成它，或暂停并等待执行器确认退出。 / Finish or safely pause the current Run first.";
    case "executor_not_confirmed_stopped": return "执行器尚未确认退出。请等待退出回执后再扩充。 / Wait for a confirmed executor exit.";
    case "target_below_current_scope": return "目标总数不能小于当前商品数或旧 Run 授权范围。 / Target cannot be below current products or prior authorization.";
    case "target_not_greater_than_current": return "目标总数等于当前商品数，无需扩充。 / Target already matches the batch size.";
    case "target_limit_exceeded": return `单次扩充的目标上限为 ${HARD_MAX_AUTHORIZED_ITEMS} 件。 / Maximum target: ${HARD_MAX_AUTHORIZED_ITEMS}.`;
    case "search_navigation_unknown": return "批次缺少可核验的搜索页回执，为避免重复访问已阻止扩充。 / Search page history is unverifiable; expansion is blocked.";
    case "search_page_budget_exceeded": return "剩余搜索页预算不足以达到该目标。 / Remaining search page budget is insufficient.";
    case "search_page_budget_exhausted": return "搜索页预算已用完。 / Search page budget is exhausted.";
    case "expansion_in_progress": return "已有扩充操作正在处理，请刷新读取结果。 / An expansion is already in progress.";
    default: return null;
  }
}

export function CapturePlanExpansionPanel({
  batchId,
  batchCapacity,
  onExpansionComplete,
  previewer,
  confirmer,
}: CapturePlanExpansionPanelProps) {
  const previewRequest = previewer ?? fetchCaptureExpansionPreview;
  const confirmRequest = confirmer ?? confirmCaptureExpansion;
  const [targetText, setTargetText] = useState("1");
  const [preview, setPreview] = useState<MarketCaptureExpansionPreview | null>(null);
  const [localAcquisitionEnabled, setLocalAcquisitionEnabled] = useState<boolean | null>(null);
  const [expansionRecovery, setExpansionRecovery] = useState<CaptureExpansionRecovery | null>(null);
  const [recoveryProfileConfirmed, setRecoveryProfileConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [explicitlyConfirmed, setExplicitlyConfirmed] = useState(false);
  const [result, setResult] = useState<Extract<CaptureExpansionConfirmResult, { ok: true }> | null>(null);
  const [notice, setNotice] = useState<{ tone: "error" | "info"; message: string } | null>(null);
  const editedRef = useRef(false);
  const authorizationIdRef = useRef<string | null>(null);
  const targetTotal = Number(targetText);
  const validTarget = Number.isSafeInteger(targetTotal) && targetTotal >= 1 && targetTotal <= HARD_MAX_AUTHORIZED_ITEMS;

  const loadPreview = useCallback(async (signal?: AbortSignal) => {
    if (!validTarget) {
      setPreview(null);
      return;
    }
    setLoading(true);
    const loaded: CaptureExpansionPreviewResult = await previewRequest({ batchId, targetTotal, signal });
    if (signal?.aborted) return;
    setLoading(false);
    if (!loaded.ok) {
      setPreview(null);
      setNotice({ tone: "error", message: `${loaded.errorMessage} (${loaded.errorCode})` });
      return;
    }
    setPreview(loaded.preview);
    setLocalAcquisitionEnabled(loaded.localAcquisitionEnabled);
    setExpansionRecovery(loaded.expansionRecovery);
    setNotice(null);
  }, [batchId, previewRequest, targetTotal, validTarget]);

  useEffect(() => {
    const controller = new AbortController();
    void loadPreview(controller.signal);
    return () => controller.abort();
  }, [loadPreview]);

  useEffect(() => {
    if (editedRef.current || batchCapacity < 1) return;
    setTargetText(String(Math.min(HARD_MAX_AUTHORIZED_ITEMS, Math.max(1, batchCapacity + 25))));
  }, [batchCapacity]);

  const confirmExpansion = async () => {
    if (!preview?.canConfirm || !explicitlyConfirmed || busy) return;
    editedRef.current = true;
    setBusy(true);
    setNotice(null);
    const authorizationId = authorizationIdRef.current ?? globalThis.crypto.randomUUID();
    authorizationIdRef.current = authorizationId;
    const confirmed = await confirmRequest({
      batchId,
      targetTotal,
      planFingerprint: preview.planFingerprint,
      authorizationId,
    });
    setBusy(false);
    if (!confirmed.ok) {
      setNotice({ tone: "error", message: `${confirmed.errorMessage} (${confirmed.errorCode})` });
      return;
    }
    authorizationIdRef.current = null;
    setResult(confirmed);
    setExplicitlyConfirmed(false);
    setNotice({ tone: confirmed.searchStatus === "blocked" ? "info" : "info", message: confirmed.message });
    await onExpansionComplete?.();
    await loadPreview();
  };

  const recoverExpansion = async () => {
    if (!expansionRecovery?.available || !expansionRecovery.authorizationId || !recoveryProfileConfirmed || busy) return;
    setBusy(true);
    setNotice(null);
    const recovered = await recoverStalledCaptureExpansion({
      batchId,
      authorizationId: expansionRecovery.authorizationId,
      confirmProfileReleased: true,
    });
    setBusy(false);
    setRecoveryProfileConfirmed(false);
    if (!recovered.ok) {
      setNotice({ tone: "error", message: `${recovered.errorMessage} (${recovered.errorCode})` });
      return;
    }
    setNotice({ tone: "info", message: recovered.message });
    await onExpansionComplete?.();
    await loadPreview();
  };

  const blocker = preview ? blockerMessage(preview) : null;

  return (
    <section
      className="mt-3 space-y-2 rounded-xl border border-emerald-200 bg-emerald-50/40 p-3"
      data-testid="capture-plan-expansion"
      aria-label="扩充当前批次 / Expand current batch"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-slate-900">扩充当前批次 / Expand current batch</h4>
          <p className="mt-0.5 text-[13px] text-slate-600">
            原计划和授权保持不变；扩充会追加到同一批次，并建立独立授权代次。 / The original plan and authorization stay unchanged.
          </p>
        </div>
        <Badge tone={preview?.canConfirm ? "emerald" : "amber"} data-testid="capture-expansion-state">
          {loading ? "读取中 / Loading" : preview?.canConfirm ? "可确认 / Ready to confirm" : "等待条件 / Prerequisite needed"}
        </Badge>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-xs font-medium text-slate-700" htmlFor={`capture-expansion-target-${batchId}`}>
          目标总数 / Target total
          <input
            id={`capture-expansion-target-${batchId}`}
            data-testid="capture-expansion-target"
            type="number"
            min={1}
            max={HARD_MAX_AUTHORIZED_ITEMS}
            step={1}
            value={targetText}
            disabled={busy}
            onChange={(event) => {
              editedRef.current = true;
              setTargetText(event.target.value);
              setExplicitlyConfirmed(false);
              setResult(null);
              setNotice(null);
              authorizationIdRef.current = null;
            }}
            className="mt-1 block h-9 w-28 rounded-md border border-slate-300 bg-white px-2 text-sm disabled:bg-slate-100"
          />
        </label>
        <div className="min-w-[220px] flex-1 text-[13px] text-slate-700" data-testid="capture-expansion-count-summary">
          {preview
            ? <><strong>{preview.currentItemCount} → {preview.targetTotal}</strong> 件，本次最多新增 <strong>{preview.maxAdditionalSearchCount}</strong> 件。
              {preview.plannedAdditionalAuthorizationCount > preview.maxAdditionalSearchCount
                ? ` 另有 ${preview.plannedAdditionalAuthorizationCount - preview.maxAdditionalSearchCount} 件复用批次内既有授权范围。`
                : null}
            </>
            : `当前批次 ${batchCapacity} 件；输入目标后读取服务端计划。 / Current batch: ${batchCapacity}.`}
        </div>
        <Button
          variant="outline"
          size="sm"
          data-testid="capture-expansion-refresh"
          disabled={loading || busy || !validTarget}
          onClick={() => { void loadPreview(); }}
        >
          刷新预览 / Refresh
        </Button>
      </div>

      {preview ? (
        <dl className="grid gap-x-4 gap-y-1 rounded-lg border border-slate-200 bg-white/80 px-2.5 py-2 text-[13px] text-slate-600 sm:grid-cols-2" data-testid="capture-expansion-metrics">
          <div><dt className="inline font-medium text-slate-700">有效搜索证据 / Valid evidence:</dt> <dd className="inline">{preview.validEvidenceCount}</dd></div>
          <div><dt className="inline font-medium text-slate-700">详情完成 / Details completed:</dt> <dd className="inline">{preview.detailCompletedCount}/{preview.currentItemCount}</dd></div>
          <div><dt className="inline font-medium text-slate-700">搜索导航 / Search pages:</dt> <dd className="inline">{preview.searchNavigationUsed} used; {preview.searchPagesRemaining} remaining</dd></div>
          <div><dt className="inline font-medium text-slate-700">Run / 运行:</dt> <dd className="inline">{preview.runStatus ?? "未创建 / none"}{preview.runGeneration ? ` · generation ${preview.runGeneration}` : ""}</dd></div>
        </dl>
      ) : null}

      {!preview?.canConfirm && preview && blocker ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[13px] text-amber-900" role="status" data-testid="capture-expansion-blocker">
          {blocker}
        </p>
      ) : null}
      {expansionRecovery?.available ? (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-[13px] text-amber-950" data-testid="capture-expansion-recovery">
          <p className="font-semibold">发现中断的扩批交接 / Interrupted expansion handoff</p>
          <p>{expansionRecovery.message ?? "原扩充进程已停止。恢复只读取已保存检查点，不会重新访问搜索页。"}</p>
          {expansionRecovery.stage ? <p>检查点阶段：{expansionRecovery.stage}</p> : null}
          <label className="flex cursor-pointer items-start gap-2">
            <input type="checkbox" data-testid="capture-expansion-recovery-profile-checkbox" checked={recoveryProfileConfirmed}
              disabled={busy} onChange={(event) => setRecoveryProfileConfirmed(event.target.checked)} className="mt-0.5" />
            <span>我已在本机确认 Amazon 专用浏览器和 Profile 已关闭。系统不会删除 Profile 锁文件。</span>
          </label>
          <Button variant="outline" size="sm" data-testid="capture-expansion-recover"
            disabled={!recoveryProfileConfirmed || busy || loading} onClick={() => void recoverExpansion()}>
            {busy ? "正在核验已保存的 Evidence…" : "恢复已保存的扩批交接"}
          </Button>
        </div>
      ) : expansionRecovery?.manualReviewRequired ? (
        <p className="rounded-md border border-rose-300 bg-rose-50 px-2.5 py-2 text-[13px] text-rose-900" role="alert" data-testid="capture-expansion-recovery-required">
          该扩批检查点无法自动核验，系统已保留扩批锁且不会再次搜索。请按提示人工核对 Evidence 与导航回执后处理：{expansionRecovery.reason ?? "需要人工核对。"}
        </p>
      ) : null}
      {preview && (preview.runStatus === "HUMAN_REQUIRED" || preview.runStatus === "PAUSED") ? (
        <p className="rounded-md border border-sky-200 bg-sky-50 px-2.5 py-2 text-[13px] text-sky-900" data-testid="capture-expansion-preserve-pending">
          {preview.runStatus === "HUMAN_REQUIRED"
            ? "人工处理单元与未完成单元会保留；新代次不会自动启动，完成登录/验证并点击继续后再推进。 / Human and pending cells are preserved; resolve login and explicitly continue."
            : "暂停状态与未完成单元会保留；扩充后仍需明确点击继续。 / The paused state and unfinished cells are preserved; resume explicitly after expansion."}
        </p>
      ) : null}
      {localAcquisitionEnabled === false ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[13px] text-amber-900" data-testid="capture-expansion-environment-hint">
          本地采集未启用。确认可记录本次新增授权，但不会启动浏览器或执行器。 / Local acquisition is disabled; confirmation is recorded without starting a browser or executor.
        </p>
      ) : null}

      {preview?.canConfirm ? (
        <div className="space-y-2 rounded-lg border border-emerald-200 bg-white px-2.5 py-2">
          <label className="flex cursor-pointer items-start gap-2 text-[13px] text-slate-700">
            <input
              type="checkbox"
              data-testid="capture-expansion-confirm-checkbox"
              checked={explicitlyConfirmed}
              disabled={busy}
              onChange={(event) => setExplicitlyConfirmed(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              我确认将目标总数设为 {preview.targetTotal} 件，最多新增授权 {preview.maxAdditionalSearchCount} 个搜索结果，并允许按现有来源门禁访问后续搜索页。 / I authorize a target of {preview.targetTotal}, up to {preview.maxAdditionalSearchCount} new search results, subject to existing source gates.
            </span>
          </label>
          <Button
            variant="primary"
            size="sm"
            data-testid="capture-expansion-confirm"
            disabled={!explicitlyConfirmed || busy || loading}
            onClick={() => void confirmExpansion()}
          >
            {busy ? "正在追加并检查来源… / Expanding…" : "确认扩充当前批次 / Confirm expansion"}
          </Button>
        </div>
      ) : null}

      {result ? (
        <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[13px] text-slate-700" data-testid="capture-expansion-result">
          <p className="font-semibold">{result.batchItemCount}/{result.targetTotal} 件商品 · 有效证据 {result.validEvidenceCount} 件 · 详情完成 {result.detailCompletedCount} 件</p>
          <p className="mt-0.5">本次新增 {result.addedCount} 件；Run 状态：{result.runStatus ?? "未新建运行代次 / no new generation"}。</p>
          <p className="mt-0.5">{result.message}</p>
          {result.driveError ? <p className="mt-0.5 text-amber-800">执行器未启动 / Executor not started: {result.driveError}</p> : null}
        </div>
      ) : null}

      {notice ? (
        <p role={notice.tone === "error" ? "alert" : "status"}
          className={`rounded-md border px-2.5 py-2 text-[13px] ${notice.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-900" : "border-sky-200 bg-sky-50 text-sky-900"}`}
          data-testid="capture-expansion-notice">
          {notice.message}
        </p>
      ) : null}
    </section>
  );
}
