"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";

import { buildAccessHeaders } from "@/lib/client/accessToken";
import { CategoryMarketQualityNotice } from "./CategoryMarketQualityNotice";

type CategoryMarketResultBatch = {
  category: { nodeId: string; label: string };
  capturedAt: string;
  rowCount: number;
  rows: Array<{
    segment: { value: string };
    monthlyTotalSales: { value: number | null };
    averagePriceUsd: { value: number | null };
    returnRatePercent: { value: number | null };
  }>;
};

type ApiEnvelope<T> = {
  ok?: boolean;
  data?: T;
  error?: { message?: string };
};

export function LatestCategoryMarketCaptureResult() {
  const [batch, setBatch] = useState<CategoryMarketResultBatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadLatest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/source-layer/category-market/latest", {
        headers: buildAccessHeaders(),
        cache: "no-store",
      });
      const payload = await response.json() as ApiEnvelope<{ batch: CategoryMarketResultBatch } | null>;
      if (!response.ok || !payload.ok) {
        setError(payload.error?.message || "读取最近一次类目市场结果失败，请重试。");
        return;
      }
      setBatch(payload.data?.batch ?? null);
    } catch {
      setError("连接工作台失败，最近一次类目市场结果尚未加载。请检查服务后重试。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  if (loading) {
    return <p role="status" className="text-xs text-slate-500">正在恢复最近一次类目市场结果…</p>;
  }

  if (error) {
    return (
      <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        <span className="inline-flex items-center gap-2"><AlertCircle className="size-4 shrink-0" />{error}</span>
        <button type="button" onClick={() => void loadLatest()} className="inline-flex shrink-0 items-center gap-1 font-semibold underline underline-offset-2">
          <RefreshCw className="size-3" />重试读取
        </button>
      </div>
    );
  }

  if (!batch) return null;

  return (
    <section aria-label="最近一次类目市场结果" data-testid="latest-category-market-result" className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-emerald-950">最近一次类目市场结果已恢复</h2>
          <p className="mt-1 text-xs text-emerald-900">刷新后仍从来源证据读取，无需重新搜索或采集。</p>
          <p className="mt-1 text-xs text-emerald-900">
            {batch.category.label || "SellerSprite 类目"} · {formatCount(batch.rowCount)} 条市场细分 · {new Date(batch.capturedAt).toLocaleString("zh-CN")}
          </p>
        </div>
        <span className="text-[13px] text-emerald-800">SellerSprite 第三方估算 · 非 Amazon 确认</span>
      </div>

      <CategoryMarketQualityNotice rows={batch.rows} />
      <div className="overflow-x-auto rounded-lg border border-emerald-100 bg-white">
        <table className="min-w-full text-left text-[13px]">
          <thead className="bg-emerald-50 text-emerald-900">
            <tr>
              <th className="px-3 py-2 font-semibold">市场细分</th>
              <th className="px-3 py-2 font-semibold">月总销量（估算）</th>
              <th className="px-3 py-2 font-semibold">平均价格（估算）</th>
              <th className="px-3 py-2 font-semibold">退货率（估算）</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-emerald-50 text-slate-700">
            {batch.rows.slice(0, 10).map((row, index) => (
              <tr key={`${row.segment.value}-${index}`}>
                <td className="px-3 py-2 font-medium">{row.segment.value || "未命名细分"}</td>
                <td className="px-3 py-2">{formatEstimate(row.monthlyTotalSales.value)}</td>
                <td className="px-3 py-2">{formatCurrencyEstimate(row.averagePriceUsd.value)}</td>
                <td className="px-3 py-2">{formatPercentEstimate(row.returnRatePercent.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {batch.rows.length > 10 && <p className="border-t border-emerald-50 px-3 py-2 text-[12px] text-slate-500">显示前 10 条；批次共保存 {formatCount(batch.rowCount)} 条。</p>}
      </div>
    </section>
  );
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}

function formatEstimate(value: number | null): string {
  return value === null ? "未提供" : formatCount(value);
}

function formatCurrencyEstimate(value: number | null): string {
  return value === null ? "未提供" : new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercentEstimate(value: number | null): string {
  return value === null ? "未提供" : `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value)}%`;
}
