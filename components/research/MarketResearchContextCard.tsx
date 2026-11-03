"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import type { MarketIntelligence } from "@/lib/marketScan/intelligence";
import { readOpportunityResearchSnapshot } from "@/lib/marketScan/opportunityResearch";

/** A market report is contextual advice. It never becomes this ASIN's ProductFact. */
export function MarketResearchContextCard({ scanId, opportunityResearch, representativeNote }: { scanId: string; opportunityResearch?: unknown; representativeNote?: string | null }) {
  const [data, setData] = useState<MarketIntelligence | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/market-analysis/${encodeURIComponent(scanId)}/intelligence`, { headers: buildAccessHeaders(), cache: "no-store", signal: controller.signal }).then(async (response) => {
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error("market_context_unavailable");
      setData(body.data);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [scanId]);
  const report = data?.reports.at(-1);
  const brief = readOpportunityResearchSnapshot(opportunityResearch);
  return <aside className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-3.5 text-sm" aria-label="市场研究上下文">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold text-emerald-950">来源市场的研究上下文</h3><Link className="text-[11px] text-emerald-700 underline" href={`/market-analysis/${encodeURIComponent(scanId)}#market-intelligence`}>返回 02 查看证据</Link></div>
    <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
      <p className="text-[11px] text-slate-500">市场建议，不转成商品事实，也不代替人工决定。</p>
      <details className="min-w-0">
        <summary className="cursor-pointer text-[11px] font-medium text-emerald-800">展开市场摘要与证据</summary>
    {brief ? <section className="mt-4 space-y-4" data-testid="adopted-opportunity-research">
      <h4 className="font-semibold text-emerald-950">人工选择时保存的研究目的</h4>
      {data && <p className={brief.inputHash === data.inputHash ? "text-slate-600" : "text-amber-800"}>{brief.inputHash === data.inputHash ? "与当前市场证据一致" : "来源市场证据已变化：以下保留选择时的快照，请回到 02 复核；不会自动改写。"}</p>}
      <p className="whitespace-pre-line leading-relaxed">{representativeNote || brief.recommendation.rationale}</p>
      <div><b>03 优先验证的问题</b><ul className="mt-2 list-disc space-y-2 pl-5">{brief.recommendation.researchQuestions.map((question) => <li key={question}>{question}</li>)}</ul></div>
      {brief.opportunities.map((opportunity) => <details key={opportunity.id} className="rounded-lg border border-emerald-100 bg-white p-3"><summary className="cursor-pointer font-medium">{opportunity.title} · 待验证假设</summary><div className="mt-3 space-y-3 leading-relaxed"><p>{opportunity.hypothesis}</p><p><b>场景：</b>{opportunity.scenario}</p><p><b>反对依据：</b>{opportunity.counterEvidence?.join("；") || "未登记明确反证，仍需核查"}</p><p><b>否定或调整条件：</b>{opportunity.rejectionConditions?.join("；")}</p><p><b>未知与开发条件：</b>{[...opportunity.unverified, ...(opportunity.developmentConstraints ?? [])].join("；")}</p></div></details>)}
      <details><summary className="cursor-pointer text-slate-600">选择时的报告与证据（{brief.evidence.length} 项）</summary><p className="mt-2 break-all text-xs">{brief.reportId} · {brief.generatedAt}</p><ul className="mt-2 space-y-2 text-xs">{brief.evidence.map((evidence) => <li key={evidence.id} className="break-all">{evidence.evidenceId} · {evidence.capturedAt} · {evidence.nature} · {evidence.contentHash}</li>)}</ul></details>
      <p className="text-xs text-slate-500">这里保存的是研究建议与人工选择依据。成本、性能、工艺和供应条件尚未因此获得验证。</p>
    </section> : representativeNote ? <p className="mt-3 whitespace-pre-line leading-relaxed"><b>人工选择理由：</b>{representativeNote}</p> : null}
    {error ? <p className="mt-2 text-amber-700">当前无法读取市场上下文，请回到来源市场重试。商品事实仍按原有证据合同读取。</p> : !data ? <p className="mt-2 text-slate-500">正在读取来源市场…</p> : report ? <><p className="mt-3 font-medium">{data.scanName} · {report.inputHash === data.inputHash ? "与当前市场证据一致" : "市场研报已过期，请在 02 重新生成"}</p><p className="mt-2 leading-relaxed">{report.summary.text}</p><p className="mt-2 break-all text-xs text-slate-500">研报 {report.id} · {report.generatedAt} · 引用 {report.summary.citations.join("、") || "未知项无引用"}</p></> : <p className="mt-3 text-slate-600">{data.scanName}：尚无真实市场 AI 研报。{data.provider.message}</p>}
      </details>
    </div>
  </aside>;
}
