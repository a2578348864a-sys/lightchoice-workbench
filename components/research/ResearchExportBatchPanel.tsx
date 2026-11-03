"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import { buildResearchExportBatch } from "@/lib/research/exportBatch";
import type {
  ResearchExportRecord,
  ResearchExportBatch,
} from "@/lib/research/researchContracts";
import type { LarkBaseRecord } from "@/lib/research/larkMapping";
import type {
  LarkPreflightResult,
  LarkSyncBatchResult,
} from "@/lib/integrations/lark/types";

const SELECTION_STORAGE_KEY = "research-export-batch-v1-selection";

type BatchPreviewData = {
  readonly count: number;
  readonly items: readonly ResearchExportRecord[];
  readonly larkRecords: readonly LarkBaseRecord[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Preflight 未就绪时的可读缺口说明。
 * 必须同时暴露「缺少必须字段」「缺少写入字段」「字段类型不兼容」三类，
 * 不允许把写入字段缺失静默掉。
 */
export function describePreflightGap(preflight: LarkPreflightResult): { title: string; detail: string } {
  const requiredMissing = preflight.missingFields ?? [];
  const writeMissing = preflight.missingWriteFields ?? [];
  const incompatible = preflight.incompatibleFields ?? [];

  let title = "⚠️ 飞书多维表格 · 字段类型不兼容";
  if (requiredMissing.length > 0) {
    title = "⚠️ 飞书多维表格 · 表结构缺少必须字段";
  } else if (writeMissing.length > 0) {
    title = "⚠️ 飞书多维表格 · 表结构缺少写入字段";
  }

  const parts: string[] = [];
  if (requiredMissing.length > 0) parts.push(`缺少必须字段：${requiredMissing.join(", ")}`);
  if (writeMissing.length > 0) parts.push(`缺少写入字段：${writeMissing.join(", ")}`);
  if (incompatible.length > 0) {
    parts.push(
      `类型不兼容：${incompatible
        .map((field) => `${field.fieldName}(${field.actualType} → ${field.expectedType})`)
        .join(", ")}`,
    );
  }
  return { title, detail: parts.join("；") };
}

function taskIdsFromListPayload(value: unknown): string[] {
  if (!isRecord(value) || value.ok !== true) return [];
  const records = Array.isArray(value.records)
    ? value.records
    : isRecord(value.data) && Array.isArray(value.data.items)
      ? value.data.items
      : [];
  return records
    .filter(isRecord)
    .map((record) => (typeof record.id === "string" ? record.id.trim() : ""))
    .filter(Boolean);
}

function parseBatchPreview(value: unknown): BatchPreviewData | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) return null;
  const data = value.data;
  if (!Number.isSafeInteger(data.count) || !Array.isArray(data.items) || !Array.isArray(data.larkRecords)) return null;
  return data as unknown as BatchPreviewData;
}

function readStoredSelection(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(SELECTION_STORAGE_KEY) || "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function previewForSelection(data: BatchPreviewData, selectedIds: readonly string[]): BatchPreviewData {
  const selected = new Set(selectedIds);
  const items: ResearchExportRecord[] = [];
  const larkRecords: LarkBaseRecord[] = [];
  data.items.forEach((item, index) => {
    if (!selected.has(item.taskId)) return;
    items.push(item);
    const larkRecord = data.larkRecords[index];
    if (larkRecord) larkRecords.push(larkRecord);
  });
  return { count: items.length, items, larkRecords };
}

function shortHash(value: string): string {
  return value.length > 16 ? `${value.slice(0, 16)}…` : value;
}

function productLabel(item: ResearchExportRecord): string {
  return item.product.title || item.product.asin || item.taskId;
}

function downloadBatch(batch: ResearchExportBatch) {
  const blob = new Blob([JSON.stringify(batch, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "research-export.json";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Research 列表中的批量导出与飞书多维表格同步面板。
 *
 * 页面从 task list 获取候选 taskId，由服务端过滤出有效 ResearchReport；
 * 同步操作直接请求 /api/research-export/lark-sync，以 ASIN 为业务主键幂等写入飞书，零 AI 重新生成。
 */
export function ResearchExportBatchPanel() {
  const [available, setAvailable] = useState<BatchPreviewData>({ count: 0, items: [], larkRecords: [] });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<BatchPreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState("");

  // 飞书 Preflight 状态
  const [preflight, setPreflight] = useState<LarkPreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);

  // 飞书同步状态
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<LarkSyncBatchResult | null>(null);
  const [syncError, setSyncError] = useState("");

  const hydratedSelection = useRef(false);

  const loadPreflight = useCallback(async () => {
    setPreflightLoading(true);
    try {
      const response = await fetch("/api/research-export/lark-preflight", {
        cache: "no-store",
        headers: { ...buildAccessHeaders() },
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.ok && isRecord(payload) && isRecord(payload.data)) {
        setPreflight(payload.data as unknown as LarkPreflightResult);
      }
    } catch {
      // 预检失败降级处理
    } finally {
      setPreflightLoading(false);
    }
  }, []);

  const loadAvailable = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const taskResponse = await fetch("/api/tasks?scope=product-research&limit=50&offset=0", {
        cache: "no-store",
        headers: { ...buildAccessHeaders() },
      });
      const taskPayload: unknown = await taskResponse.json().catch(() => null);
      if (!taskResponse.ok) throw new Error("task_list_failed");
      const taskIds = taskIdsFromListPayload(taskPayload);
      if (taskIds.length === 0) {
        const empty = { count: 0, items: [], larkRecords: [] } as const;
        setAvailable(empty);
        setSelectedIds([]);
        setPreview(null);
        hydratedSelection.current = true;
        return;
      }

      const params = new URLSearchParams();
      taskIds.forEach((taskId) => params.append("taskId", taskId));
      const batchResponse = await fetch(`/api/research-export/batch-preview?${params.toString()}`, {
        cache: "no-store",
        headers: { ...buildAccessHeaders() },
      });
      const batchPayload: unknown = await batchResponse.json().catch(() => null);
      const batch = parseBatchPreview(batchPayload);
      if (!batchResponse.ok || !batch) {
        const message =
          isRecord(batchPayload) && isRecord(batchPayload.error) && typeof batchPayload.error.message === "string"
            ? batchPayload.error.message
            : "批量研究导出列表读取失败。";
        throw new Error(message);
      }

      const availableIds = new Set(batch.items.map((item) => item.taskId));
      const restoredIds = readStoredSelection().filter((taskId) => availableIds.has(taskId));
      setAvailable(batch);
      setSelectedIds(restoredIds);
      setPreview(restoredIds.length > 0 ? previewForSelection(batch, restoredIds) : null);
      hydratedSelection.current = true;
    } catch (loadError) {
      setError(
        loadError instanceof Error && loadError.message !== "task_list_failed"
          ? loadError.message
          : "批量研究导出列表暂时无法读取，请刷新后重试。",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAvailable();
    void loadPreflight();
  }, [loadAvailable, loadPreflight]);

  useEffect(() => {
    if (!hydratedSelection.current) return;
    try {
      window.localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(selectedIds));
    } catch {
      // 本地存储不可用时不影响导出主流程。
    }
  }, [selectedIds]);

  function toggleSelection(taskId: string) {
    setSelectedIds((current) => {
      const next = current.includes(taskId)
        ? current.filter((id) => id !== taskId)
        : [...current, taskId];
      setPreview(null);
      setSyncResult(null);
      setSyncError("");
      return next;
    });
  }

  async function generatePreview() {
    if (selectedIds.length === 0 || previewLoading) return;
    setPreviewLoading(true);
    setError("");
    setSyncResult(null);
    setSyncError("");
    try {
      const params = new URLSearchParams();
      selectedIds.forEach((taskId) => params.append("taskId", taskId));
      const response = await fetch(`/api/research-export/batch-preview?${params.toString()}`, {
        cache: "no-store",
        headers: { ...buildAccessHeaders() },
      });
      const payload: unknown = await response.json().catch(() => null);
      const data = parseBatchPreview(payload);
      if (!response.ok || !data) {
        const message =
          isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string"
            ? payload.error.message
            : "批量导出预览生成失败。";
        throw new Error(message);
      }
      setPreview(data);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "批量导出预览生成失败。请重试。");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleSyncToLark() {
    if (selectedIds.length === 0 || syncing) return;
    setSyncing(true);
    setSyncError("");
    setSyncResult(null);

    try {
      const response = await fetch("/api/research-export/lark-sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAccessHeaders(),
        },
        body: JSON.stringify({ taskIds: selectedIds }),
      });

      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const errorMsg =
          isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string"
            ? payload.error.message
            : "同步到飞书多维表格失败，请稍后重试。";
        setSyncError(errorMsg);
        return;
      }

      const result = payload.data as LarkSyncBatchResult;
      setSyncResult(result);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "网络连接失败，同步未完成。");
    } finally {
      setSyncing(false);
    }
  }

  const preflightGap = preflight && !preflight.writable ? describePreflightGap(preflight) : null;

  return (
    <section
      className="surface-card border border-indigo-200/80 bg-indigo-50/30 p-5 sm:p-6"
      data-testid="research-export-batch-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700">
              研究批量导出 V1
            </span>
            <span
              className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-700"
              data-testid="research-export-batch-count"
            >
              已完成研究 {available.count} 个商品
            </span>
          </div>
          <h2 className="mt-2 text-lg font-semibold text-slate-950">批量导出与多维表格同步</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
            勾选已生成 ResearchReport 的商品，可下载标准化 JSON 研报包，或一键单向同步至飞书多维表格。以 ASIN 为主键保证幂等，零 AI 重新生成。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void loadAvailable();
              void loadPreflight();
            }}
            disabled={loading || previewLoading || syncing}
            className="linear-button inline-flex h-10 items-center justify-center px-3 text-sm font-semibold disabled:opacity-50"
            data-testid="research-export-batch-refresh"
          >
            {loading ? "读取中…" : "刷新列表"}
          </button>
        </div>
      </div>

      {/* 飞书连接状态 Preflight Banner */}
      <div className="mt-4 rounded-xl border bg-white p-3.5 text-xs shadow-xs" data-testid="lark-preflight-banner">
        {preflightLoading ? (
          <p className="text-slate-500">正在检查飞书多维表格连接状态…</p>
        ) : !preflight || !preflight.configured ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex size-2 rounded-full bg-slate-400" />
              <span className="font-semibold text-slate-800">飞书多维表格 · 尚未配置连接</span>
            </div>
            <span className="text-slate-500">
              需配置环境变量：{preflight?.missingConfigKeys?.join(", ") || "LARK_APP_ID, LARK_APP_SECRET, LARK_BASE_APP_TOKEN, LARK_BASE_TABLE_ID"}
            </span>
          </div>
        ) : !preflight.connected ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-rose-700">
            <div className="flex items-center gap-2">
              <span className="inline-flex size-2 rounded-full bg-rose-500" />
              <span className="font-semibold">飞书多维表格 · 连接失败</span>
            </div>
            <span>{preflight.errorMessage || "请检查 App ID 与 Secret 权限配置"}</span>
          </div>
        ) : !preflight.writable ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-amber-800">
            <div className="flex items-center gap-2">
              <span className="inline-flex size-2 rounded-full bg-amber-500" />
              <span className="font-semibold">{preflightGap?.title ?? "⚠️ 飞书多维表格 · 表结构未就绪"}</span>
            </div>
            <span data-testid="lark-preflight-gap-detail">{preflightGap?.detail ?? ""}</span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 text-emerald-800">
            <div className="flex items-center gap-2">
              <span className="inline-flex size-2 rounded-full bg-emerald-500" />
              <span className="font-semibold">✅ 飞书多维表格 · 已连接并就绪</span>
            </div>
            <span className="text-slate-500">
              Base: <code className="font-mono text-[13px] text-slate-700">{preflight.appToken}</code> · Table:{" "}
              <code className="font-mono text-[13px] text-slate-700">{preflight.tableId}</code>
            </span>
          </div>
        )}
      </div>

      {error ? (
        <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700" data-testid="research-export-batch-error">
          {error}
        </p>
      ) : null}
      {loading ? <p className="mt-4 text-sm text-slate-500">正在读取已完成 Research…</p> : null}

      {!loading && available.items.length === 0 ? (
        <p className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-500" data-testid="research-export-batch-empty">
          暂无可导出的已完成 Research。请先在商品任务中生成 ResearchReport。
        </p>
      ) : null}

      {available.items.length > 0 ? (
        <>
          <div className="mt-5 grid gap-3" data-testid="research-export-batch-items">
            {available.items.map((item) => (
              <label
                key={item.taskId}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${
                  selectedIds.includes(item.taskId)
                    ? "border-indigo-300 bg-white shadow-xs"
                    : "border-slate-200 bg-white/70 hover:border-indigo-200"
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(item.taskId)}
                  onChange={() => toggleSelection(item.taskId)}
                  className="mt-1 size-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  aria-label={`选择 ${productLabel(item)}`}
                  data-testid={`research-export-batch-checkbox-${item.taskId}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-sm font-semibold text-slate-900">{productLabel(item)}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[13px] font-semibold text-slate-600">
                      {item.research.priority}
                    </span>
                  </span>
                  <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                    <span>ASIN：{item.product.asin || "缺失"}</span>
                    <span>任务：{item.taskId}</span>
                    <span>Hash：{shortHash(item.evidence.reportHash)}</span>
                  </span>
                </span>
              </label>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void generatePreview()}
              disabled={selectedIds.length === 0 || previewLoading || syncing}
              className="linear-button-primary inline-flex h-10 items-center justify-center px-4 text-sm font-semibold disabled:opacity-50"
              data-testid="research-export-batch-preview"
            >
              {previewLoading ? "生成预览中…" : `生成导出预览（${selectedIds.length}）`}
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedIds([]);
                setPreview(null);
                setSyncResult(null);
                setSyncError("");
              }}
              disabled={selectedIds.length === 0 || previewLoading || syncing}
              className="linear-button inline-flex h-10 items-center justify-center px-3 text-sm font-semibold disabled:opacity-50"
              data-testid="research-export-batch-clear"
            >
              清空选择
            </button>
          </div>
        </>
      ) : null}

      {/* 导出与飞书同步操作区 */}
      {preview && preview.count > 0 ? (
        <section className="mt-5 rounded-2xl border border-indigo-200 bg-white p-4 sm:p-5" data-testid="research-export-batch-preview">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-indigo-700">导出与同步准备</p>
              <h3 className="mt-1 text-base font-semibold text-slate-950">已选择 {preview.count} 个商品</h3>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                将同步 {preview.count} 个商品 · 新增/更新由 ASIN 自动判断
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => downloadBatch(buildResearchExportBatch({ items: preview.items }))}
                className="linear-button inline-flex h-10 items-center justify-center px-3.5 text-xs font-semibold"
                data-testid="research-export-batch-download"
              >
                下载 JSON 文件
              </button>

              <button
                type="button"
                onClick={() => void handleSyncToLark()}
                disabled={syncing || selectedIds.length === 0}
                className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-indigo-600 px-4 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:opacity-50"
                data-testid="research-export-lark-sync-btn"
              >
                {syncing ? (
                  <>
                    <span className="inline-block size-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    正在同步到飞书…
                  </>
                ) : (
                  <>
                    <span>🚀</span> 同步选中商品到飞书 ({selectedIds.length})
                  </>
                )}
              </button>
            </div>
          </div>

          {/* 同步结果展示卡片 */}
          {syncError ? (
            <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-xs font-medium text-rose-800" data-testid="research-export-lark-sync-error">
              <p className="font-bold">❌ 同步请求失败</p>
              <p className="mt-1">{syncError}</p>
            </div>
          ) : null}

          {syncResult ? (
            <div
              className={`mt-4 rounded-xl border p-4 text-xs ${
                syncResult.blockedReason
                  ? "border-amber-200 bg-amber-50 text-amber-900"
                  : syncResult.failed > 0
                    ? "border-rose-200 bg-rose-50 text-rose-900"
                    : "border-emerald-200 bg-emerald-50 text-emerald-900"
              }`}
              data-testid="research-export-lark-sync-result"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-current/10 pb-2">
                <span className="text-sm font-bold">
                  {syncResult.blockedReason ? "⚠️ 同步已安全拦截" : "🎉 同步完成"}
                </span>
                <span className="font-mono text-[13px]">
                  总计: {syncResult.total} · 新增: {syncResult.created} · 更新: {syncResult.updated} · 失败: {syncResult.failed}
                </span>
              </div>

              {syncResult.blockedReason ? (
                <p className="mt-2 text-xs leading-5">
                  拦截原因：<code>{syncResult.blockedReason}</code>。请检查服务器环境变量凭据配置。
                </p>
              ) : null}

              {syncResult.results.length > 0 ? (
                <div className="mt-3 space-y-1.5 max-h-48 overflow-auto">
                  {syncResult.results.map((r, idx) => (
                    <div key={`${r.taskId}-${idx}`} className="flex items-center justify-between rounded bg-white/70 px-2.5 py-1 text-[13px]">
                      <span className="font-mono">{r.asin || r.taskId}</span>
                      <span className="flex items-center gap-2">
                        <span
                          className={`rounded px-1.5 py-0.5 font-semibold ${
                            r.action === "created"
                              ? "bg-emerald-100 text-emerald-800"
                              : r.action === "updated"
                                ? "bg-blue-100 text-blue-800"
                                : "bg-rose-100 text-rose-800"
                          }`}
                        >
                          {r.action === "created" ? "已新增" : r.action === "updated" ? "已更新" : "失败"}
                        </span>
                        {r.errorMessage ? <span className="text-rose-600">{r.errorMessage}</span> : null}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <details className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3" data-testid="research-export-batch-details">
            <summary className="cursor-pointer text-xs font-semibold text-slate-700">
              展开查看批量导出 JSON 数据结构 ({preview.items.length} 条)
            </summary>
            <pre className="mt-3 max-h-72 overflow-auto rounded-lg bg-slate-950 p-3 text-xs leading-5 text-slate-100" data-testid="research-export-batch-json">
              {JSON.stringify({ count: preview.count, items: preview.items, larkRecords: preview.larkRecords }, null, 2)}
            </pre>
          </details>
        </section>
      ) : null}
    </section>
  );
}
