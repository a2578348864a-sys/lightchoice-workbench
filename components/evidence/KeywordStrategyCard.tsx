"use client";

import { useMemo } from "react";
import { buildKeywordBriefDraft } from "./keywordBriefDraft";

/** 关键词策略摘要（只读）：Listing 已退役，不再提供「确认关键词方案 / 保存到 Listing」入口。 */
export function KeywordStrategyCard({
  rows,
  productName,
  evidenceCount,
  reportType,
  capturedAt,
  hasPending = false,
  pendingKeywordCount,
  hasPendingExpired = false,
  pendingPanel,
  rawEvidence,
}: {
  rows: Array<{ keyword: string | null; rowNumber?: number }>;
  productName?: string | null;
  evidenceCount: number;
  reportType?: string | null;
  capturedAt?: string | null;
  hasPending?: boolean;
  pendingKeywordCount?: number;
  hasPendingExpired?: boolean;
  pendingPanel?: React.ReactNode;
  rawEvidence?: { reportType: string; capturedAt: string; rows: Array<{ rowNumber: number; keyword: string; fields: Record<string, unknown> }> } | null;
}) {
  const recommended = useMemo(() => buildKeywordBriefDraft(rows, productName), [rows, productName]);

  const status = hasPendingExpired
    ? "状态：本次预览已失效"
    : hasPending
      ? `状态：已采集 ${pendingKeywordCount ?? 0} 条关键词 · 待保存证据`
      : evidenceCount > 0
        ? `状态：已采集 ${evidenceCount} 条关键词证据`
        : "状态：待采集";

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="keyword-strategy-card">
      <div className="min-w-0">
        <h4 className="text-sm font-bold text-slate-900">关键词策略</h4>
        <p className="mt-1 text-xs text-slate-500" data-testid="kw-status">{status}</p>
      </div>

      <div className="mt-3 space-y-2 text-sm text-slate-700" data-testid="kw-summary">
        <p>
          <span className="text-slate-500">推荐主关键词：</span>
          {recommended?.primaryKeyword ?? <span className="text-slate-400">尚无相关度足够的主关键词</span>}
        </p>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="kw-supporting-tags">
          <span className="text-xs text-slate-500">辅助词：</span>
          {(recommended?.supportingKeywords ?? []).slice(0, 5).map((word) => (
            <span key={word} className="rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-xs text-teal-700">{word}</span>
          ))}
        </div>
        <p className="text-xs text-slate-500" data-testid="kw-counts">
          证据 {evidenceCount} 条
          {reportType ? " · 报告 " + reportType : ""}
          {capturedAt ? " · 采集 " + capturedAt.slice(0, 10) : " · 数据期：尚未取得"}
        </p>
      </div>

      {rawEvidence && rawEvidence.rows.length > 0 ? (
        <details className="mt-3" data-testid="kw-raw-report">
          <summary className="cursor-pointer text-xs font-medium text-slate-700">查看原始关键词资料</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-1.5 pr-2 font-medium">关键词</th>
                  {Object.keys((rawEvidence.rows[0]?.fields as Record<string, unknown>) ?? {}).slice(0, 4).map((key) => (
                    <th key={key} className="px-2 py-1.5 font-medium">{key}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rawEvidence.rows.slice(0, 20).map((row) => (
                  <tr key={row.rowNumber} className="border-b border-slate-100">
                    <td className="py-1.5 pr-2 font-medium text-slate-900">{row.keyword}</td>
                    {Object.keys((rawEvidence.rows[0]?.fields as Record<string, unknown>) ?? {}).slice(0, 4).map((key) => (
                      <td key={key} className="px-2 py-1.5 text-slate-700">{String((row.fields as Record<string, unknown>)[key] ?? "")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      {pendingPanel ? (
        <div className="mt-3 border-t border-slate-100 pt-3" data-testid="kw-pending-slot">
          {pendingPanel}
        </div>
      ) : null}
    </section>
  );
}
