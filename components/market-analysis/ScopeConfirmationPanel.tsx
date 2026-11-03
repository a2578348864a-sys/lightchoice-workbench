"use client";

import { useCallback, useMemo, useState } from "react";
import { CheckCircle2, CircleSlash, Filter, RefreshCw, Search, XCircle } from "lucide-react";

import { buildAccessHeaders } from "@/lib/client/accessToken";
import type { ScopeConfirmationRow, ScopeConfirmationSummary } from "@/lib/marketScan/scopeConfirmation";

type RowInput = {
  marketSampleKey: string;
  asin: string;
  subjectKey: string;
  resourceVersion: string;
  scopeReview: ScopeConfirmationRow | null;
};

const STATUS_META: Record<string, { label: string; tone: string }> = {
  IN_SCOPE: { label: "人工确认：符合范围", tone: "border-emerald-300 bg-emerald-50 text-emerald-800" },
  OUT_OF_SCOPE: { label: "人工确认：不符合范围", tone: "border-rose-300 bg-rose-50 text-rose-800" },
  UNREVIEWED: { label: "未确认", tone: "border-slate-300 bg-slate-50 text-slate-600" },
};

const FILTERS = [
  { id: "todo", label: "待确认" },
  { id: "in", label: "符合" },
  { id: "out", label: "不符合" },
  { id: "stale", label: "已过期" },
  { id: "all", label: "全部" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

function statusOf(row: RowInput): string {
  const review = row.scopeReview;
  return review?.reviewStale ? "STALE" : (review?.reviewStatus ?? "UNREVIEWED");
}

/**
 * 02 市场研究 · 人工研究范围确认（P3）。
 *
 * 业务契约不变：仍走 `POST /api/market-analysis/{id}/scope-confirmations`，
 * 每条携带 expectedVersion / expectedScopeRevision；409 只提示刷新，不覆盖他人修改。
 * 本轮只改前端呈现：默认只看「待确认」，提供搜索 / 筛选 / 批量确认，不再把 34 条操作铺满页面。
 */
export function ScopeConfirmationPanel({
  scanId,
  expectedScanHash,
  items,
  summary,
  onSaved,
}: {
  scanId: string;
  expectedScanHash: string;
  items: RowInput[];
  summary?: ScopeConfirmationSummary;
  onSaved: () => void | Promise<void>;
}) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<"IN_SCOPE" | "OUT_OF_SCOPE">("IN_SCOPE");
  const [draftReason, setDraftReason] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterId>("todo");
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [batchReason, setBatchReason] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);

  const submitOne = useCallback(async (
    row: RowInput,
    status: "IN_SCOPE" | "OUT_OF_SCOPE" | "UNREVIEWED",
    reason: string,
  ) => {
    setBusyKey(row.marketSampleKey);
    setNotice(null);
    try {
      const res = await fetch(`/api/market-analysis/${encodeURIComponent(scanId)}/scope-confirmations`, {
        method: "POST",
        headers: { ...buildAccessHeaders(), "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          expectedScanHash,
          items: [{
            marketSampleKey: row.marketSampleKey,
            asin: row.asin,
            subjectKey: row.subjectKey,
            status,
            reason,
            expectedVersion: row.resourceVersion,
            expectedScopeRevision: row.scopeReview?.scopeRevision ?? 0,
          }],
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const code = json?.error?.code ?? "";
        const message = code === "SCOPE_REVISION_CONFLICT" || code === "SAMPLE_VERSION_CONFLICT" || code === "MARKET_SNAPSHOT_STALE"
          ? "该样本已被其他操作更新或样本已变化，请刷新后重新核对（未覆盖对方修改）。"
          : (json?.error?.message ?? `保存失败 (${res.status})`);
        throw new Error(message);
      }
      setNotice({ type: "success", message: status === "UNREVIEWED" ? "已撤销该样本的范围确认。" : "已保存人工范围确认。" });
      setEditingKey(null);
      setDraftReason("");
      await onSaved();
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setBusyKey(null);
    }
  }, [expectedScanHash, onSaved, scanId]);

  /** 批量确认：一次请求提交多条，理由共用并标注为批量。 */
  const submitBatch = useCallback(async (status: "IN_SCOPE" | "OUT_OF_SCOPE") => {
    const keys = Object.keys(selected).filter((key) => selected[key]);
    const rows = items.filter((row) => keys.includes(row.marketSampleKey));
    if (rows.length === 0) return;
    const reason = batchReason.trim();
    if (!reason) {
      setNotice({ type: "error", message: "批量确认必须填写理由（会应用到所选的每一条）。" });
      return;
    }
    setBatchBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/market-analysis/${encodeURIComponent(scanId)}/scope-confirmations`, {
        method: "POST",
        headers: { ...buildAccessHeaders(), "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          expectedScanHash,
          items: rows.map((row) => ({
            marketSampleKey: row.marketSampleKey,
            asin: row.asin,
            subjectKey: row.subjectKey,
            status,
            reason: `批量确认：${reason}`,
            expectedVersion: row.resourceVersion,
            expectedScopeRevision: row.scopeReview?.scopeRevision ?? 0,
          })),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const code = json?.error?.code ?? "";
        const message = code === "SCOPE_REVISION_CONFLICT" || code === "SAMPLE_VERSION_CONFLICT" || code === "MARKET_SNAPSHOT_STALE"
          ? "所选样本中已有被其他操作更新的记录，请刷新后重新核对（未覆盖对方修改）。"
          : (json?.error?.message ?? `批量保存失败 (${res.status})`);
        throw new Error(message);
      }
      setNotice({ type: "success", message: `已批量确认 ${rows.length} 条。` });
      setSelected({});
      setBatchReason("");
      await onSaved();
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "批量保存失败" });
    } finally {
      setBatchBusy(false);
    }
  }, [batchReason, expectedScanHash, items, onSaved, scanId, selected]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((row) => {
      const status = statusOf(row);
      if (filter === "todo" && status !== "UNREVIEWED") return false;
      if (filter === "in" && status !== "IN_SCOPE") return false;
      if (filter === "out" && status !== "OUT_OF_SCOPE") return false;
      if (filter === "stale" && status !== "STALE") return false;
      if (!q) return true;
      return row.asin.toLowerCase().includes(q) || (row.scopeReview?.systemSubtype?.label ?? "").toLowerCase().includes(q);
    });
  }, [filter, items, query]);

  const shown = expanded ? visible : visible.slice(0, 8);
  const selectedCount = Object.keys(selected).filter((key) => selected[key]).length;
  const counts = useMemo(() => ({
    todo: items.filter((row) => statusOf(row) === "UNREVIEWED").length,
    in: items.filter((row) => statusOf(row) === "IN_SCOPE").length,
    out: items.filter((row) => statusOf(row) === "OUT_OF_SCOPE").length,
    stale: items.filter((row) => statusOf(row) === "STALE").length,
  }), [items]);

  return (
    <section
      className="lc-scope-panel"
      aria-label="人工研究范围确认"
      data-testid="scope-confirmation-panel"
    >
      <div className="lc-scope-head">
        <div>
          <h2>人工确认：这些商品是否符合本次研究范围？</h2>
          <p>这里先保存人工归属判断。保存本身不改变统计；再点击上方“正式应用已确认排除项”才会更新研究范围，并要求重新分析、确认市场判断。原始技术有效样本与来源保留，系统标题子类型仅供参考。</p>
        </div>
        {summary && (
          <div className="lc-scope-summary" data-testid="scope-confirmation-summary">
            <span className="is-in">有效符合 {summary.inScope}</span>
            <span className="is-out">有效不符合 {summary.outOfScope}</span>
            <span>未确认 {summary.unreviewed}{summary.revoked > 0 ? `（含已撤销 ${summary.revoked}）` : ""}</span>
            <span className="is-warn">历史过期 {summary.stale}</span>
          </div>
        )}
      </div>

      {notice && (
        <p className={`lc-scope-notice ${notice.type === "success" ? "is-ok" : "is-err"}`} role="status">
          {notice.message}
        </p>
      )}

      <div className="lc-scope-toolbar">
        <div className="lc-scope-search">
          <Search className="size-3.5" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 ASIN 或系统子类型…"
            aria-label="搜索范围确认样本"
          />
        </div>
        <div className="lc-scope-filters" role="group" aria-label="按确认状态筛选">
          <Filter className="size-3.5 text-slate-400" />
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => { setFilter(item.id); setExpanded(false); }}
              aria-pressed={filter === item.id}
              data-testid={`scope-filter-${item.id}`}
            >
              {item.label}
              <em>{item.id === "all" ? items.length : counts[item.id as keyof typeof counts] ?? 0}</em>
            </button>
          ))}
        </div>
      </div>

      {selectedCount > 0 && (
        <div className="lc-scope-batch" data-testid="scope-batch-bar">
          <span>已选 {selectedCount} 条</span>
          <input
            type="text"
            value={batchReason}
            onChange={(event) => setBatchReason(event.target.value)}
            placeholder="批量理由（必填，会应用到所选每一条）"
            maxLength={500}
          />
          <button type="button" disabled={batchBusy} onClick={() => void submitBatch("IN_SCOPE")} data-testid="scope-batch-in">批量确认符合</button>
          <button type="button" disabled={batchBusy} onClick={() => void submitBatch("OUT_OF_SCOPE")} data-testid="scope-batch-out">批量确认不符合</button>
          <button type="button" className="is-ghost" onClick={() => setSelected({})}>取消选择</button>
        </div>
      )}

      {shown.length === 0 ? (
        <p className="lc-scope-empty">当前筛选下没有样本。切换筛选条件或清除搜索试试。</p>
      ) : (
        <ul className="lc-scope-list">
          {shown.map((row) => {
            const review = row.scopeReview;
            const status = statusOf(row);
            const meta = STATUS_META[status] ?? { label: "历史确认已过期，需重新核对", tone: "border-amber-300 bg-amber-50 text-amber-900" };
            const editing = editingKey === row.marketSampleKey;
            const busy = busyKey === row.marketSampleKey;
            return (
              <li key={row.marketSampleKey} className="lc-scope-row" data-testid={`scope-row-${row.asin}`} data-selected={selected[row.marketSampleKey] ? "true" : undefined}>
                <label className="lc-scope-check">
                  <input
                    type="checkbox"
                    checked={Boolean(selected[row.marketSampleKey])}
                    onChange={(event) => setSelected((previous) => ({ ...previous, [row.marketSampleKey]: event.target.checked }))}
                    aria-label={`选择 ${row.asin}`}
                  />
                </label>
                <div className="lc-scope-row-main">
                  <div className="lc-scope-row-head">
                    <code>{row.asin}</code>
                    <span className={`lc-scope-status ${meta.tone}`} data-testid={`scope-status-${row.asin}`}>{meta.label}</span>
                    {review?.systemSubtype && <span className="lc-scope-hint">系统提示：{review.systemSubtype.label}</span>}
                    <div className="lc-scope-actions">
                      <button type="button" disabled={busy} onClick={() => { setEditingKey(row.marketSampleKey); setDraftStatus("IN_SCOPE"); setDraftReason(review?.review?.reason ?? ""); }}>
                        <CheckCircle2 className="size-3" />符合
                      </button>
                      <button type="button" className="is-out" disabled={busy} onClick={() => { setEditingKey(row.marketSampleKey); setDraftStatus("OUT_OF_SCOPE"); setDraftReason(review?.review?.reason ?? ""); }}>
                        <XCircle className="size-3" />不符合
                      </button>
                      {(status === "IN_SCOPE" || status === "OUT_OF_SCOPE") && (
                        <button type="button" className="is-ghost" disabled={busy} onClick={() => void submitOne(row, "UNREVIEWED", "")}>
                          <CircleSlash className="size-3" />撤销
                        </button>
                      )}
                    </div>
                  </div>
                  {editing && (
                    <div className="lc-scope-edit">
                      <textarea
                        value={draftReason}
                        onChange={(event) => setDraftReason(event.target.value)}
                        maxLength={500}
                        rows={2}
                        placeholder={draftStatus === "IN_SCOPE" ? "说明为什么符合本次研究范围（必填，≤500 字）" : "说明为什么不符合本次研究范围（必填，≤500 字）"}
                      />
                      <div className="lc-scope-edit-actions">
                        <button
                          type="button"
                          disabled={busy || draftReason.trim().length === 0}
                          onClick={() => void submitOne(row, draftStatus, draftReason.trim())}
                        >
                          {busy ? "保存中…" : draftStatus === "IN_SCOPE" ? "保存为符合" : "保存为不符合"}
                        </button>
                        <button type="button" className="is-ghost" onClick={() => setEditingKey(null)}>取消</button>
                        <span>{draftReason.trim().length}/500</span>
                      </div>
                    </div>
                  )}
                  {review?.reviewStale && review.review?.reason && (
                    <p className="lc-scope-stale-note">历史确认理由：{review.review.reason}（样本或研究目标已变化，需重新核对）</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="lc-scope-foot">
        {visible.length > shown.length ? (
          <button type="button" onClick={() => setExpanded(true)} data-testid="scope-expand">展开其余 {visible.length - shown.length} 条</button>
        ) : (
          <span className="lc-scope-count">共 {visible.length} 条（当前筛选）</span>
        )}
        <p className="lc-scope-hint-text">
          <RefreshCw className="mr-1 inline size-3" />
          保存后页面会重新读取；若提示冲突，请刷新后重新核对，不会自动覆盖他人的确认。
        </p>
      </div>
    </section>
  );
}
