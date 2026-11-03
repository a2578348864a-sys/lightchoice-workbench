"use client";

import { useEffect, useState } from "react";
import { buildAccessHeaders } from "@/lib/client/accessToken";

export type SellerSpriteClipboardTable = {
  headers: string[];
  rows: Array<Array<string | null>>;
};

export type SellerSpriteClipboardParseResult =
  | { ok: true; table: SellerSpriteClipboardTable }
  | { ok: false; error: string };

/**
 * Parse the TSV representation produced by copying a visible SellerSprite
 * table.  This deliberately accepts only a header row plus tab-separated
 * rows; it does not infer columns or reinterpret comma-separated text.
 */
export function parseSellerSpriteClipboardTable(value: string): SellerSpriteClipboardParseResult {
  const lines = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return { ok: false, error: "请粘贴包含表头和至少一行数据的 SellerSprite 官方表格。" };
  }

  const headerCells = lines[0].split("\t").map((cell) => cell.trim());
  if (headerCells.length < 2 || headerCells.some((cell) => !cell)) {
    return { ok: false, error: "无法识别表头：请从官方表格复制，列之间必须保留 Tab 分隔。" };
  }
  if (headerCells.length > 100) {
    return { ok: false, error: "表格列数超过允许上限，已停止解析。" };
  }

  const rows: Array<Array<string | null>> = [];
  for (const line of lines.slice(1)) {
    if (!line.includes("\t")) {
      return { ok: false, error: "数据行不是 Tab 分隔格式，已停止解析，避免错列。" };
    }
    const cells = line.split("\t").map((cell) => cell.trim());
    while (cells.length > headerCells.length && cells[cells.length - 1] === "") cells.pop();
    if (cells.length > headerCells.length) {
      return { ok: false, error: "数据行列数与表头不一致，已停止解析，避免错列。" };
    }
    if (!cells.some((cell) => cell.length > 0)) continue;
    rows.push(Array.from({ length: headerCells.length }, (_, index) => cells[index] || null));
  }
  if (rows.length === 0) {
    return { ok: false, error: "表格中没有可保存的数据行。" };
  }
  if (rows.length > 500) {
    return { ok: false, error: "数据行超过允许上限，已停止解析。" };
  }
  return { ok: true, table: { headers: headerCells, rows } };
}

type StorageVersion = { resultJsonHash: string; updatedAt: string };

export function SellerSpriteReportCaptureCard({
  taskId,
  asin,
  storageVersion,
  existingReportType,
  existingReportTypes,
  existingRowCount = 0,
  onSaved,
}: {
  taskId: string;
  asin: string | null;
  storageVersion: StorageVersion | null;
  existingReportType?: string | null;
  existingReportTypes?: string[];
  existingRowCount?: number;
  onSaved: () => void;
}) {
  const [asinInput, setAsinInput] = useState(asin ?? "");
  const [sourceRef, setSourceRef] = useState("");
  const [sourceMethod, setSourceMethod] = useState<"sellersprite_page_manual_tsv" | "sellersprite_official_xlsx">("sellersprite_page_manual_tsv");
  const [tableText, setTableText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setAsinInput(asin ?? "");
  }, [asin]);

  async function save() {
    setError(null);
    setNotice(null);
    if (!storageVersion) {
      setError("任务版本信息尚未就绪，请刷新后重试。未发送保存请求。");
      return;
    }
    const normalizedAsin = asinInput.trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(normalizedAsin)) {
      setError("请填写当前任务绑定的 10 位 ASIN。");
      return;
    }
    const parsed = parseSellerSpriteClipboardTable(tableText);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const normalizedSourceRef = sourceRef.trim();
    if (!normalizedSourceRef) {
      setError("请填写 SellerSprite 官方面板或官方导出文件的来源引用。");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/keyword-evidence`, {
        method: "POST",
        headers: { ...buildAccessHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          action: "save_sellersprite_report",
          asin: normalizedAsin,
          sourceRef: normalizedSourceRef,
          sourceMethod,
          headers: parsed.table.headers,
          rows: parsed.table.rows,
          expectedStorageVersion: storageVersion,
        }),
      });
      const body = await response.json().catch(() => null) as {
        ok?: boolean;
        error?: { message?: string };
        data?: { evidence?: { rows?: unknown[] }; saved?: string[] };
      } | null;
      if (!response.ok || body?.ok !== true) {
        setError(body?.error?.message ?? "SellerSprite 关键词证据保存失败，请检查来源和表头后重试。");
        return;
      }
      setTableText("");
      setNotice(`已保存 ${body.data?.saved?.length ?? body.data?.evidence?.rows?.length ?? 0} 条 SellerSprite 关键词证据。`);
      onSaved();
    } catch {
      setError("网络错误，关键词证据尚未保存，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50/40 p-4" data-testid="sellersprite-report-capture-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-bold text-slate-900">SellerSprite 官方关键词证据</h4>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            先在 SellerSprite 官方面板或官方导出中人工确认数据，再把可见表格复制到这里。系统只做表头校验和结构映射，不调用 SellerSprite API、不猜测缺失值。
          </p>
        </div>
        {existingRowCount > 0 || (existingReportTypes?.length ?? 0) > 0 ? (
          <span className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[13px] font-semibold text-emerald-700">
            已保存 {existingRowCount} 条{existingReportTypes && existingReportTypes.length > 0
              ? ` · ${existingReportTypes.join("、")}`
              : existingReportType ? ` · ${existingReportType}` : ""}
          </span>
        ) : null}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-slate-700">
          绑定 ASIN
          <input
            value={asinInput}
            onChange={(event) => setAsinInput(event.target.value)}
            placeholder="例如 B0GFCZTRKL"
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 font-mono text-sm"
            data-testid="sellersprite-report-asin"
          />
        </label>
        <label className="block text-xs font-medium text-slate-700">
          来源引用
          <input
            value={sourceRef}
            onChange={(event) => setSourceRef(event.target.value)}
            placeholder="官方面板 URL 或导出文件名"
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm"
            data-testid="sellersprite-report-source-ref"
          />
        </label>
        <label className="block text-xs font-medium text-slate-700 sm:col-span-2">
          来源形态
          <select
            value={sourceMethod}
            onChange={(event) => setSourceMethod(event.target.value as typeof sourceMethod)}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm"
            data-testid="sellersprite-report-source-method"
          >
            <option value="sellersprite_page_manual_tsv">SellerSprite 官方页面人工 TSV</option>
            <option value="sellersprite_official_xlsx">SellerSprite 官方 XLSX 导出</option>
          </select>
        </label>
      </div>

      <label className="mt-3 block text-xs font-medium text-slate-700">
        粘贴官方表格（第一行为表头，列之间必须是 Tab）
        <textarea
          value={tableText}
          onChange={(event) => setTableText(event.target.value)}
          placeholder="keyword\t...\nwood cutting board\t..."
          rows={6}
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 font-mono text-xs leading-5"
          data-testid="sellersprite-report-table"
        />
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !storageVersion}
          className="inline-flex h-8 items-center rounded-lg bg-amber-600 px-3 text-xs font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="sellersprite-report-save"
        >
          {busy ? "保存中…" : "保存官方关键词证据"}
        </button>
        {!storageVersion ? <span className="text-[13px] text-slate-500">任务版本加载中…</span> : null}
      </div>
      {notice ? <p className="mt-2 text-xs font-semibold text-emerald-700" role="status">{notice}</p> : null}
      {error ? <p className="mt-2 text-xs text-rose-700" role="alert">{error}</p> : null}
    </section>
  );
}
