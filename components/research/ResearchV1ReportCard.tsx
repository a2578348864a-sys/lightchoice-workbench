import type { ReactNode } from "react";
import type { V1ReportView } from "@/lib/research/v1ReportView";

/**
 * P2-04 读侧：v1 正式研报的只读展示卡。
 *
 * 只渲染服务端 `reportViewV1` 投影，不发请求、不写状态、不参与门禁。
 * 目的仅是消除「已有 v1 正式研报却显示尚无研报」的矛盾；高保真视觉仍按
 * Owner 指令延期，这里沿用现有页面样式做最小可读呈现。
 */
export function ResearchV1ReportCard({ view, stale }: { view: V1ReportView; stale: boolean }) {
  // 非权威（V1/V5 并存但无法确认当前报告）时不得标注「报告有效」。
  const authoritative = view.authoritative !== false;
  const section = (title: string, body: ReactNode) => (
    <div className="space-y-1">
      <h4 className="text-[13px] font-semibold text-slate-700">{title}</h4>
      <div className="space-y-1 text-[13px] leading-relaxed text-slate-600">{body}</div>
    </div>
  );
  const lines = (items: readonly string[], empty = "未提供") =>
    items.length ? <ul className="list-disc space-y-0.5 pl-5">{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="text-slate-400">{empty}</p>;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="research-v1-report-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[15px] font-bold text-slate-800">正式研报（v1 引擎）</h3>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${!authoritative ? "bg-amber-50 text-amber-700" : stale ? "bg-rose-50 text-rose-700" : view.bindingStatus === "unbound" ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`} data-testid="research-v1-report-validity">
            {!authoritative ? "非当前权威 · 待确认" : stale ? "来源已变化 · 需重新确认" : view.bindingStatus === "unbound" ? "未记录来源绑定 · 时效未知" : "报告有效"}
          </span>
          {view.generationStatus === "degraded" ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">生成降级</span> : null}
        </div>
        <p className="text-[11px] text-slate-500">
          报告 <code>{view.reportHash.slice(0, 12)}</code> · {view.generatedAt}
        </p>
      </header>
      {stale ? (
        <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-[12px] leading-relaxed text-rose-700" data-testid="research-v1-report-stale-notice">
          该研报引用的来源已变化：以下内容是历史记录，不会自动恢复旧人工决定；请重新确认研究后再使用。
        </p>
      ) : null}
      {!stale && view.bindingStatus === "unbound" ? (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-800" data-testid="research-v1-report-unbound-notice">
          该研报生成时没有记录事实/证据绑定，无法判断来源是否已变化；请按待验证内容使用，必要时重跑研究。
        </p>
      ) : null}
      <div className="mt-3 space-y-3">
        {view.auditStatus === "incomplete" ? <p role="status" data-testid="research-audit-incomplete">运行审计留存不完整，原始响应或解析轨迹可能缺失，请先核对再签收。</p> : null}
        {view.summary ? section("执行摘要", <p>{view.summary}</p>) : null}
        {view.keyPoints.length ? section("关键要点", lines(view.keyPoints)) : null}
        {view.marketOpportunity ? section("市场机会", <p>{view.marketOpportunity}</p>) : null}
        {view.competitionAnalysis ? section("竞争分析", <p>{view.competitionAnalysis}</p>) : null}
        {view.differentiationSuggestions.length ? section("差异化方向（待验证）", lines(view.differentiationSuggestions)) : null}
        {view.causalInvestigations.length ? section("逐项原因调查（AI 假设，需人工核实）", (
          <div className="space-y-2">
            {view.causalInvestigations.map((item, index) => (
              <div key={index} className="rounded-lg border border-slate-100 bg-slate-50/60 p-2">
                <p className="font-semibold text-slate-700" data-testid={`research-v1-cause-${index}`}>
                  原因 {index + 1}：{item.hypothesis || "（假设文本缺少可追溯证据，已降级）"}
                  <span className="ml-1 rounded bg-white px-1.5 py-0.5 text-[11px] font-semibold text-amber-700">待验证</span>
                  <span className="ml-1 text-[11px] text-slate-500">可信度 {item.confidence}</span>
                </p>
                {item.rationale ? <p className="mt-1 text-[12px] text-slate-600">为什么提出：{item.rationale}</p> : null}
                <p className="mt-1 text-[12px] text-slate-600">支持线索：{item.supportingEvidence.length ? item.supportingEvidence.join("；") : "未知"}</p>
                <p className="mt-0.5 text-[12px] text-slate-600">反证线索：{item.counterevidence.length ? item.counterevidence.join("；") : "未知"}</p>
                <p className="mt-0.5 text-[12px] text-slate-600">未知：{item.unknowns.length ? item.unknowns.join("；") : "未提供"}</p>
                <p className="mt-0.5 text-[12px] text-slate-600">验证：{item.verification.length ? item.verification.join("；") : "未提供"}</p>
              </div>
            ))}
          </div>
        )) : null}
        {view.causalHypotheses.length ? section("竞争性因果假设（待验证）", lines(view.causalHypotheses)) : null}
        {view.alternatives.length ? section("备选方案", lines(view.alternatives)) : null}
        {view.supportingEvidence.length ? section("支持当前解释的证据", lines(view.supportingEvidence)) : null}
        {view.counterevidence.length ? section("反证 / 可能推翻点", lines(view.counterevidence)) : null}
        {view.verificationItems.length ? section("验证与停止条件", lines(view.verificationItems)) : null}
        {view.vocAnalysis ? section("买家声音", <p>{view.vocAnalysis}</p>) : null}
        {view.painPoints.length ? section("VOC 痛点（证据待核实）", lines(view.painPoints)) : null}
        {view.riskAnalysis ? section("风险", <p>{view.riskAnalysis}</p>) : null}
        {view.risks.length ? section("风险清单", lines(view.risks)) : null}
        {view.riskVerificationItems.length ? section("风险验证事项", lines(view.riskVerificationItems)) : null}
        {view.unitEconomicsAnalysis ? section("单位经济性", <p>{view.unitEconomicsAnalysis}</p>) : null}
        {view.supplyChainAnalysis ? section("供应链", <p>{view.supplyChainAnalysis}</p>) : null}
        {view.unverifiedAssumptions.length ? section("未验证假设（不得当作事实）", lines(view.unverifiedAssumptions)) : null}
      </div>
    </section>
  );
}
