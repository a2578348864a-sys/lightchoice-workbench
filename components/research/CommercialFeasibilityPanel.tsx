"use client";

import React, { useMemo } from "react";
import {
  ShieldCheck,
  AlertTriangle,
  Lightbulb,
  MessageSquare,
  HelpCircle,
  TrendingDown,
  Info,
  CheckCircle2,
  Lock,
} from "lucide-react";
import {
  buildCommercialFeasibility,
  type BuildCommercialFeasibilityInput,
  type FieldSourceState,
} from "@/lib/research/commercialFeasibility";
import { describeVocThemeStrength } from "@/lib/research/vocThresholds";

export interface CommercialFeasibilityPanelProps {
  input: BuildCommercialFeasibilityInput;
}

function StateBadge({ state, note }: { state: FieldSourceState; note?: string }) {
  if (state === "AVAILABLE") {
    return (
      <span
        title={note || "来源字段记录，不等于已确认事实（材料/工艺仍需供应商或实物确认）"}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[12px] font-semibold tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200"
      >
        <CheckCircle2 className="size-2.5 text-emerald-600" />
        来源记录
      </span>
    );
  }
  if (state === "ESTIMATED") {
    return (
      <span
        title={note || "推断/估算，需人工核实"}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[12px] font-semibold tracking-wider text-sky-700 bg-sky-50 border border-sky-200"
      >
        <Info className="size-2.5 text-sky-600" />
        推断
      </span>
    );
  }
  return (
    <span
      title={note || "数据缺失，禁止推断"}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[12px] font-semibold tracking-wider text-slate-500 bg-slate-100 border border-slate-200"
    >
      <HelpCircle className="size-2.5 text-slate-400" />
      缺失
    </span>
  );
}

export function CommercialFeasibilityPanel({ input }: CommercialFeasibilityPanelProps) {
  const view = useMemo(() => buildCommercialFeasibility(input), [input]);

  const productFacts = view.confirmedFacts.filter((f) => f.category === "product");
  const marketFacts = view.confirmedFacts.filter((f) => f.category === "market");
  const costFacts = view.confirmedFacts.filter((f) => f.category === "logistics_cost");

  return (
    <div
      data-testid="commercial-feasibility-panel"
      className="rounded-2xl border border-indigo-100 bg-linear-to-b from-indigo-50/30 to-white p-5 shadow-xs space-y-6"
    >
      {/* 模块顶部标题 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-indigo-100/80 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-xs">
              <ShieldCheck className="size-4" />
            </span>
            <h2 className="text-base font-bold text-slate-900 tracking-tight">
              商业可行性与产品机会评估
            </h2>
            {view.role && (
              <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[13px] font-medium text-indigo-800">
                代表样本角色：{view.role}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            四层物理隔离展示：严谨分离事实、买家反馈、AI推断与商业风险。坚持数据源诚实，无商业评分，禁止自动立项。
          </p>
        </div>
        <div className="flex items-center gap-2 text-[13px] text-slate-500 bg-white/80 rounded-lg px-2.5 py-1 border border-slate-200/80">
          <span className="font-semibold text-slate-700">来源状态说明：</span>
          <StateBadge state="AVAILABLE" />
          <StateBadge state="ESTIMATED" />
          <StateBadge state="DATA_MISSING" />
        </div>
      </div>

      {/* 第一层：已确认事实 Confirmed Facts */}
      <section
        data-testid="feasibility-confirmed-facts"
        className="rounded-xl border border-slate-200/90 bg-white p-4.5 shadow-xs space-y-4"
      >
        <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
          <div className="flex items-center gap-2">
            <span className="inline-block size-2 rounded-full bg-emerald-500" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
              第一层 · 商品与市场资料
            </h3>
          </div>
          <span className="text-[13px] text-slate-400">按各字段标注来源记录、推断或缺失</span>
        </div>

        {/* 商品属性事实 */}
        <div>
          <span className="text-[13px] font-semibold text-slate-500 block mb-2">商品层属性事实：</span>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {productFacts.map((fact) => (
              <div key={fact.key} className="rounded-lg bg-slate-50/70 p-2.5 border border-slate-100 flex flex-col justify-between">
                <div className="flex items-center justify-between gap-1 mb-1">
                  <span className="text-[13px] text-slate-500">{fact.label}</span>
                  <StateBadge state={fact.state} note={fact.note} />
                </div>
                <div className="text-xs font-semibold text-slate-800 truncate" title={String(fact.displayValue)}>
                  {fact.displayValue}
                </div>
                {fact.note && fact.state !== "AVAILABLE" && (
                  <p className="mt-1 text-[11px] leading-snug text-slate-500">{fact.note}</p>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 市场与竞争事实 */}
        <div className="pt-2 border-t border-slate-100">
          <span className="text-[13px] font-semibold text-slate-500 block mb-2">市场与定位事实：</span>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {marketFacts.map((fact) => (
              <div key={fact.key} className="rounded-lg bg-slate-50/70 p-2.5 border border-slate-100 flex flex-col justify-between">
                <div className="flex items-center justify-between gap-1 mb-1">
                  <span className="text-[13px] text-slate-500">{fact.label}</span>
                  <StateBadge state={fact.state} note={fact.note} />
                </div>
                <div className="text-xs font-semibold text-slate-800 truncate" title={String(fact.displayValue)}>
                  {fact.displayValue}
                </div>
                {fact.note && fact.state !== "AVAILABLE" && (
                  <p className="mt-1 text-[11px] leading-snug text-slate-500">{fact.note}</p>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 物流与供应链成本真实状态 */}
        <div className="pt-2 border-t border-slate-100">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[13px] font-semibold text-slate-500">物流与供应链底价事实（严禁臆测）：</span>
            <span className="text-[12px] text-rose-600 bg-rose-50 px-2 py-0.5 rounded border border-rose-100">
              缺失项一律诚实标记 DATA_MISSING，不填零、不伪造
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {costFacts.map((fact) => (
              <div
                key={fact.key}
                className={`rounded-lg p-2.5 border flex flex-col justify-between ${
                  fact.state === "DATA_MISSING" ? "bg-slate-50/90 border-dashed border-slate-300" : "bg-slate-50/70 border-slate-100"
                }`}
              >
                <div className="flex items-center justify-between gap-1 mb-1">
                  <span className="text-[13px] text-slate-500">{fact.label}</span>
                  <StateBadge state={fact.state} note={fact.note} />
                </div>
                <div
                  className={`text-xs font-semibold truncate ${
                    fact.state === "DATA_MISSING" ? "text-slate-400 italic" : "text-slate-800"
                  }`}
                  title={String(fact.displayValue)}
                >
                  {fact.displayValue}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 第二层：买家真实原声 Buyer VOC */}
      <section
        data-testid="feasibility-buyer-voc"
        className="rounded-xl border border-slate-200/90 bg-white p-4.5 shadow-xs space-y-3"
      >
        <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
          <div className="flex items-center gap-2">
            <span className="inline-block size-2 rounded-full bg-blue-500" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
              第二层 · 买家真实原声反馈 (Buyer Voice / VOC)
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-slate-400">
              独立评论 {view.buyerVoc.independentReviewCount ?? "未知"} 条 · 主题提及 {view.buyerVoc.themeMentionCount} 次（{view.buyerVoc.themeCount} 主题）
            </span>
            <StateBadge state={view.buyerVoc.state} note="仅正式 VOC 分析来源可标记 AVAILABLE；AI 研报摘要不计入" />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* 正向声音 */}
          <div data-testid="voc-positive-box" className="rounded-lg bg-emerald-50/50 p-3 border border-emerald-100 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-800">
              <CheckCircle2 className="size-3.5 text-emerald-600" />
              <span>买家正向认可信号</span>
            </div>
            {view.buyerVoc.positiveSignals.length > 0 ? (
              <ul className="space-y-1.5 text-xs text-emerald-900/90">
                {view.buyerVoc.positiveSignals.map((sig, idx) => (
                  <li key={idx} className="flex items-start gap-1.5">
                    <span className="text-emerald-500 font-bold">•</span>
                    <span>
                      {sig.text}
                      <span className="ml-1 text-[12px] text-emerald-700">
                        （{describeVocThemeStrength(sig.reviewCount ?? 0).evidencePhrase}）
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-400 italic">
                {view.buyerVoc.state === "DATA_MISSING"
                  ? "尚无正式 VOC 分析记录（本层不消费 AI 研报摘要）；不等于商品没有评论证据——已合法采集的评论请见「VOC 痛点」层。"
                  : "当前样本暂未提取出高置信正向主题。"}
              </p>
            )}
          </div>

          {/* 负向痛点 */}
          <div data-testid="voc-negative-box" className="rounded-lg bg-amber-50/50 p-3 border border-amber-100 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800">
              <AlertTriangle className="size-3.5 text-amber-600" />
              <span>买家差评痛点与体验瑕疵</span>
            </div>
            {view.buyerVoc.negativeSignals.length > 0 ? (
              <ul className="space-y-1.5 text-xs text-amber-900/90">
                {view.buyerVoc.negativeSignals.map((sig, idx) => (
                  <li key={idx} className="flex items-start gap-1.5">
                    <span className="text-amber-500 font-bold">•</span>
                    <span>
                      {sig.text}
                      <span className="ml-1 text-[12px] text-amber-700">
                        （{describeVocThemeStrength(sig.reviewCount ?? 0).evidencePhrase}）
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-400 italic">
                {view.buyerVoc.state === "DATA_MISSING"
                  ? "尚无正式 VOC 分析记录（本层不消费 AI 研报摘要）；不等于商品没有评论证据——已合法采集的评论请见「VOC 痛点」层。"
                  : "当前公开置顶评论中未发现复现级负向痛点。"}
              </p>
            )}
          </div>
        </div>

        <p className="text-xs text-slate-500 bg-slate-50 p-2.5 rounded-lg border border-slate-100">
          <span className="font-semibold text-slate-700">需求强度总结：</span> {view.buyerVoc.summary}
        </p>
      </section>

      {/* 第三层：AI 分析推断与假设 AI Inferences */}
      <section
        data-testid="feasibility-ai-inferences"
        className="rounded-xl border border-slate-200/90 bg-white p-4.5 shadow-xs space-y-3"
      >
        <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
          <div className="flex items-center gap-2">
            <span className="inline-block size-2 rounded-full bg-purple-500" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
              第三层 · AI 分析推断与差异化假设 (AI Inferences)
            </h3>
          </div>
          <span className="text-[12px] text-purple-700 bg-purple-50 px-2 py-0.5 rounded border border-purple-200">
            算法推断 · 非事实证据 · 须经人工验证
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {view.aiInferences.length > 0 ? (
            view.aiInferences.map((inf) => (
              <div key={inf.id} className="rounded-lg bg-purple-50/30 border border-purple-100 p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-purple-950 flex items-center gap-1">
                    <Lightbulb className="size-3 text-purple-600" />
                    {inf.title}
                  </span>
                  <StateBadge state={inf.state} />
                </div>
                <p className="text-xs text-slate-700 leading-relaxed">{inf.inference}</p>
                <div className="text-[12px] text-slate-400 pt-1 border-t border-purple-100/60 flex items-center gap-1">
                  <Info className="size-2.5 text-slate-400" />
                  <span>推断依据：{inf.premise}</span>
                </div>
              </div>
            ))
          ) : (
            <div className="col-span-full rounded-lg border border-dashed border-purple-200 bg-purple-50/30 p-4 text-center">
              <p className="text-xs font-semibold text-purple-900">
                暂无有商品证据支撑的产品机会推断——【待验证】
              </p>
              <p className="text-[13px] text-slate-500 mt-1">
                本层不生成默认产品方案（不预设加厚规格、玻璃纤维结构等无依据推断）；需研报或正式分析产出后展示。
              </p>
            </div>
          )}
        </div>
      </section>

      {/* 第四层：商业风险与数据缺口 Commercial Risks & Data Gaps */}
      <section
        data-testid="feasibility-risks-and-gaps"
        className="rounded-xl border border-slate-200/90 bg-white p-4.5 shadow-xs space-y-4"
      >
        <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
          <div className="flex items-center gap-2">
            <span className="inline-block size-2 rounded-full bg-rose-500" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
              第四层 · 商业风险与决策缺口 (Risks & Data Gaps)
            </h3>
          </div>
          <span className="text-[13px] font-semibold text-rose-600 bg-rose-50 px-2 py-0.5 rounded border border-rose-200">
            研究建议与人工决策独立呈现
          </span>
        </div>

        {/* 机会与风险概览 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-lg bg-slate-50 p-3 border border-slate-100 space-y-1.5">
            <span className="text-xs font-semibold text-slate-700 flex items-center gap-1">
              <CheckCircle2 className="size-3.5 text-indigo-600" />
              市场吸引力与需求判断
            </span>
            <p className="text-xs text-slate-600 leading-relaxed">
              {view.commercialAssessment.marketAttractiveness}
            </p>
          </div>
          <div className="rounded-lg bg-slate-50 p-3 border border-slate-100 space-y-1.5">
            <span className="text-xs font-semibold text-slate-700 flex items-center gap-1">
              <Lightbulb className="size-3.5 text-amber-600" />
              产品改进方向可解决性
            </span>
            <p className="text-xs text-slate-600 leading-relaxed">
              {view.commercialAssessment.improvementOpportunity}
            </p>
          </div>
        </div>

        {/* 商业风险列表 */}
        <div>
          <span className="text-[13px] font-semibold text-slate-500 block mb-2">已识别重大商业风险：</span>
          <div className="space-y-2">
            {view.commercialAssessment.commercialRisks.map((risk) => (
              <div
                key={risk.id}
                className="flex items-start gap-2.5 rounded-lg border border-rose-100 bg-rose-50/40 p-2.5 text-xs text-rose-950"
              >
                <AlertTriangle className="size-4 shrink-0 text-rose-500 mt-0.5" />
                <div className="space-y-0.5">
                  <span className="font-bold">{risk.title}</span>
                  <p className="text-rose-900/80 text-[13px] leading-relaxed">{risk.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 数据缺口清单 */}
        <div>
          <span className="text-[13px] font-semibold text-slate-500 block mb-2">
            商业判断中仍需核实的资料：
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {view.commercialAssessment.dataGaps.map((gap, idx) => (
              <div
                key={idx}
                className="rounded-lg border border-dashed border-amber-300 bg-amber-50/30 p-2.5 flex flex-col justify-between"
              >
                <div className="flex items-center justify-between gap-1 mb-1">
                  <span className="text-xs font-bold text-amber-950">{gap.field}</span>
                  <StateBadge state={gap.state} />
                </div>
                <div className="text-[13px] text-amber-800/80 leading-relaxed">
                  <span className="text-amber-600 font-medium">影响：</span>
                  {gap.impact}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 人工决策与系统建议分离呈现 */}
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-3.5 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Lock className="size-4 text-indigo-700" />
              <span className="text-xs font-bold text-indigo-950">
                人工决策（Human Decision · 只读投影）
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span
                data-testid="human-decision-gate"
                className={`rounded font-mono text-[12px] px-2 py-0.5 font-bold tracking-wider ${
                  view.commercialAssessment.decisionSupport.decisionStale
                    ? "bg-amber-100 text-amber-900"
                    : view.commercialAssessment.decisionSupport.humanDecided
                    ? "bg-indigo-600 text-white"
                    : "bg-slate-300 text-slate-700"
                }`}
              >
                {view.commercialAssessment.decisionSupport.currentGate}
              </span>
              <span className="rounded bg-violet-600 text-white font-mono text-[12px] px-2 py-0.5 font-bold tracking-wider">
                研究建议 {input.recommendedNextAction ?? "暂不可用"}
              </span>
            </div>
          </div>
          <p className="text-[13px] text-indigo-800">
            {view.commercialAssessment.decisionSupport.humanDecisionDisplay}
          </p>
          <p className="text-xs text-indigo-900 font-medium leading-relaxed">
            <span className="font-semibold">证据与成本限制：</span>
            {view.commercialAssessment.decisionSupport.recommendation}
          </p>
          <div className="text-[13px] text-indigo-700/80 pt-1.5 border-t border-indigo-200/60 flex items-center justify-between">
            <span>{view.commercialAssessment.decisionSupport.nextActionNote}</span>
            <span className="font-semibold text-rose-600">禁止自动推进 PROCEED</span>
          </div>
        </div>
      </section>
    </div>
  );
}
