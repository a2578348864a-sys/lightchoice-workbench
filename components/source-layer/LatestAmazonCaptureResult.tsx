"use client";
import { useCallback, useEffect, useState } from "react";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import type { getLatestAmazonCaptureSummary } from "@/lib/server/latestAmazonCaptureSummary";
type Summary = Awaited<ReturnType<typeof getLatestAmazonCaptureSummary>>;
export function LatestAmazonCaptureResult({ refreshKey = 0 }: { refreshKey?: number }) {
  const [summary, setSummary] = useState<Summary>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/source-layer/latest-amazon-capture", { cache: "no-store", headers: buildAccessHeaders() });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error("read_failed");
      setSummary(body.data); setError(null);
    } catch { setError("已保存的 Amazon 证据暂时无法读取，请重新读取；无需重复采集。"); }
  }, []);
  useEffect(() => { void load(); }, [load, refreshKey]);
  if (error) return <p role="alert" className="text-xs text-amber-800">{error} <button onClick={() => void load()} className="underline">重新读取</button></p>;
  if (!summary) return null;
  return <section data-testid="latest-amazon-capture-result" aria-label="最近保存的 Amazon 来源证据" className="rounded-xl border border-sky-200 bg-sky-50/60 p-4 text-xs text-slate-700">
    <h2 className="text-sm font-semibold text-slate-950">最近保存的 Amazon 来源证据</h2>
    <p className="mt-2 font-medium">{summary.title || summary.asin}</p>
    <p className="mt-1">ASIN：{summary.asin} · 品牌：{summary.brand || "未提供"} · 价格：{summary.price ? `${summary.price.currency} ${summary.price.amount}` : "未提供"}</p>
    <p className="mt-1">评分：{summary.rating ?? "未提供"} · 评论数：{summary.reviewCount ?? "未提供"}</p>
    <p className="mt-1">{summary.sourceLabel} · 来源时间：{new Date(summary.capturedAt).toLocaleString("zh-CN")}</p>
    <p className="mt-1 text-slate-500">刷新后从已保存证据读取。这里展示历史快照，不能代表本轮所有入口均已采集成功。</p>
  </section>;
}
