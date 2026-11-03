"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, RefreshCw, X } from "lucide-react";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import { Button } from "@/components/ui/Button";

type Preview = {
  subjectKey: string;
  asin: string;
  marketplace: string;
  title: string;
  image: string | null;
  price: { amount: number; currency: string } | null;
  capturedAt: string;
  evidenceVersion: number;
  contentHash: string;
  evidenceRef: string;
  hasConflict: boolean;
  estimatedFieldSummary: string[];
  alreadyReferenced: boolean;
  batchContext: string[];
};

export function PromoteEvidenceModal({ onPromoted }: { onPromoted?: () => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Preview[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function loadPreview() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/source/promotable-evidence", { headers: buildAccessHeaders(), cache: "no-store" });
      const json = await response.json().catch(() => null);
      if (!response.ok) throw new Error(json?.error?.message || "暂时无法读取可提档商品。");
      setItems(json?.data?.subjects ?? []);
      setSelected({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "暂时无法读取可提档商品。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) void loadPreview();
  }, [open]);

  async function promote() {
    const chosen = items.filter((item) => selected[item.subjectKey]);
    if (chosen.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/source/promote-evidence", {
        method: "POST",
        headers: {
          ...buildAccessHeaders(),
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          confirmed: true,
          bindings: chosen.map(({ subjectKey, evidenceVersion, contentHash }) => ({ subjectKey, evidenceVersion, contentHash })),
        }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) throw new Error(json?.error?.message || "提档失败，请刷新预览后重试。");
      const data = json?.data ?? {};
      setNotice(`已建立 ${data.created?.length ?? 0} 个商品引用，已存在 ${data.alreadyPresent?.length ?? 0} 个。`);
      onPromoted?.();
      await loadPreview();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提档失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        从已有采集资产提档
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" role="dialog" aria-modal="true" aria-label="从已有采集资产提档">
          <div className="max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-start justify-between border-b border-slate-200 p-5">
              <div>
                <h2 className="text-lg font-bold text-slate-900">从已有采集资产提档</h2>
                <p className="mt-1 text-xs text-slate-500">先预览并选择商品，确认后才会加入商品批次。</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label="关闭"><X className="size-5 text-slate-500" /></button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-5">
              {loading ? <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500"><Loader2 className="size-4 animate-spin" />正在读取可提档商品…</div> : items.length === 0 ? <p className="rounded-xl bg-slate-50 p-6 text-center text-sm text-slate-500">当前没有满足条件的商品资产。</p> : (
                <div className="space-y-2">
                  {items.map((item) => (
                    <label key={item.subjectKey} className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${selected[item.subjectKey] ? "border-emerald-400 bg-emerald-50/60" : "border-slate-200"}`}>
                      <input type="checkbox" className="mt-1 size-4 accent-emerald-600" checked={Boolean(selected[item.subjectKey])} onChange={(event) => setSelected((current) => ({ ...current, [item.subjectKey]: event.target.checked }))} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs font-bold text-slate-900">{item.asin}</span><span className="text-xs text-slate-500">版本 {item.evidenceVersion}</span>{item.alreadyReferenced && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[12px] text-slate-600">已有批次引用</span>}{item.hasConflict && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[12px] font-semibold text-amber-800">存在冲突，需确认</span>}</div>
                        <p className="mt-1 truncate text-sm text-slate-800">{item.title}</p>
                        <p className="mt-1 text-[13px] text-slate-500">{item.marketplace} · 采集于 {new Date(item.capturedAt).toLocaleString("zh-CN")} · {item.estimatedFieldSummary.length ? item.estimatedFieldSummary.join("、") : "已保留原始字段性质"}</p>
                      </div>
                      {selected[item.subjectKey] && <Check className="mt-1 size-4 shrink-0 text-emerald-600" />}
                    </label>
                  ))}
                </div>
              )}
              {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
              {notice && <p role="status" className="mt-3 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-700">{notice}</p>}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 p-4">
              <Button variant="ghost" size="sm" onClick={() => void loadPreview()} disabled={loading || busy}><RefreshCw className="mr-1.5 size-3.5" />刷新预览</Button>
              <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setOpen(false)}>取消</Button><Button variant="primary" size="sm" onClick={() => void promote()} disabled={busy || !items.some((item) => selected[item.subjectKey])}>{busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}确认并提档</Button></div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
