"use client";

import React from "react";
import { AlertTriangle, Calculator, CheckCircle2, HelpCircle, Info, Lock } from "lucide-react";
import type { UnitEconomicsView, UnitEconomicsViewLine, UnitEconomicsViewMetric } from "@/lib/research/researchContracts";

export interface UnitEconomicsResultCardProps {
  readonly view: UnitEconomicsView | null;
  readonly compactProvenance?: boolean;
}

const NATURE_LABEL: Record<string, string> = {
  CONFIRMED_REFERENCE: "来源引用",
  USER_INPUT: "用户输入",
  ESTIMATED: "估算",
  MISSING: "缺失",
};

const NATURE_CLASS: Record<string, string> = {
  CONFIRMED_REFERENCE: "text-emerald-700 bg-emerald-50 border-emerald-200",
  USER_INPUT: "text-sky-700 bg-sky-50 border-sky-200",
  ESTIMATED: "text-amber-700 bg-amber-50 border-amber-200",
  MISSING: "text-slate-500 bg-slate-100 border-slate-200",
};

function NatureBadge({ nature }: { nature: string }) {
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[12px] font-semibold tracking-wider ${NATURE_CLASS[nature] ?? NATURE_CLASS.MISSING}`}>
      {NATURE_LABEL[nature] ?? nature}
    </span>
  );
}

export function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null || !Number.isFinite(amount)) return "—";
  const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : "";
  return `${symbol}${amount.toFixed(2)}${symbol ? "" : ` ${currency ?? ""}`}`.trim();
}

export function formatRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(2)}%`;
}

/** 旧快照和当前接口均可能携带“净利”标签；部分费用被排除时只在展示层明确口径。 */
function metricLabel(metric: UnitEconomicsViewMetric, partialCostBasis: boolean): string {
  if (!partialCostBasis) return metric.label;
  const labels: Record<string, string> = {
    netProfit: "单件预计利润（仅已计费用）",
    netMargin: "预计利润率（仅已计费用）",
    roi: "ROI（仅已计费用 / 到岸成本）",
    breakEvenPrice: "参考保本售价（仅已计费用）",
  };
  return labels[metric.key] ?? metric.label;
}

function formulaNote(note: string, partialCostBasis: boolean): string {
  if (!partialCostBasis) return note;
  if (note.startsWith("净利 =")) return note.replace("净利 =", "预计利润（仅已计费用） =");
  if (note.startsWith("保本售价 =")) return note.replace("保本售价 =", "参考保本售价（仅已计费用） =");
  if (note === "ROI = 净利 ÷ 到岸成本") return "ROI（仅已计费用） = 预计利润 ÷ 到岸成本";
  return note;
}

function MetricRow({ metric, currency, partialCostBasis }: { metric: UnitEconomicsViewMetric; currency: string | null; partialCostBasis: boolean }) {
  const available = metric.status === "available" && metric.value !== null;
  return (
    <div
      data-testid={`ue-metric-${metric.key}`}
      className={`rounded-lg border p-2.5 flex flex-col justify-between ${available ? "border-slate-200 bg-white" : "border-dashed border-slate-300 bg-slate-50/80"}`}
    >
      <span className="text-[13px] text-slate-500">{metricLabel(metric, partialCostBasis)}</span>
      <span className={`mt-1 text-sm font-bold ${available ? "text-slate-900" : "text-slate-400 italic"}`}>
        {available
          ? metric.unit === "usd"
            ? formatMoney(metric.value, currency)
            : formatRatio(metric.value)
          : "不可计算"}
      </span>
      {!available && metric.reason ? (
        <span className="mt-1 text-[12px] leading-snug text-amber-700">{metric.reason}</span>
      ) : null}
    </div>
  );
}

function CostLine({ line, currency }: { line: UnitEconomicsViewLine; currency: string | null }) {
  return (
    <div data-testid={`ue-cost-${line.key}`} className="flex items-start justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-semibold text-slate-700">{line.label}</span>
          <NatureBadge nature={line.nature} />
        </div>
        {line.note ? <span className="mt-0.5 block text-[12px] leading-snug text-slate-500">{line.note}</span> : null}
        {line.source ? <span className="mt-0.5 block font-mono text-[12px] text-slate-400">来源：{line.source}</span> : null}
      </div>
      <span className="shrink-0 text-xs font-bold text-slate-900">{formatMoney(line.amountUsd, currency)}</span>
    </div>
  );
}

/**
 * V6 单位经济性只读结果卡片。
 *
 * 只呈现确定性计算结果与来源性质；不产生任何商业建议，
 * 不自动设置 PROCEED、不写 Human Decision、不生成 Product Brief。
 */
export function UnitEconomicsResultCard({ view, compactProvenance = false }: UnitEconomicsResultCardProps) {
  if (!view) {
    return (
      <section data-testid="unit-economics-result" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex items-center gap-2">
          <Calculator className="size-4 text-emerald-600" />
          <h3 className="text-sm font-bold text-slate-900">商业成本与利润测算结果</h3>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          当前商品尚无可用的确定性事实投影，暂时无法组装测算结果。
        </p>
      </section>
    );
  }

  const available = view.status === "available";
  const fixedRateNote = view.inputProvenance.find((line) => line.key === "exchangeRate" && line.source === "internal_fixed_assumption")?.note;
  const ProvenanceContainer = compactProvenance ? "details" : "div";
  const ProvenanceHeading = compactProvenance ? "summary" : "span";

  return (
    <section data-testid="unit-economics-result" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2">
          <Calculator className="size-4 text-emerald-600" />
          <h3 className="text-sm font-bold text-slate-900">商业成本与利润测算结果</h3>
          <span
            data-testid="ue-status"
            className={`rounded px-2 py-0.5 font-mono text-[12px] font-bold tracking-wider ${
              available ? "bg-emerald-600 text-white" : "bg-amber-100 text-amber-800 border border-amber-300"
            }`}
          >
            {available ? "已计算" : "不可计算"}
          </span>
          {available && view.isPartialCostBasis ? (
            <span data-testid="ue-partial-badge" className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[12px] font-semibold text-amber-800">
              部分成本口径（非完整净利润）
            </span>
          ) : null}
        </div>
        <span className="text-[13px] text-slate-400">
          确定性计算 · 零 AI 调用 · 币种 {view.currency ?? "未知"}
        </span>
      </div>

      {available && fixedRateNote ? (
        <p data-testid="ue-fixed-rate-note" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          {fixedRateNote}
        </p>
      ) : null}

      {!available ? (
        <div className="space-y-2">
          <div className="flex items-start gap-2 rounded-lg border border-dashed border-amber-300 bg-amber-50/50 p-3">
            <HelpCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <div className="space-y-1">
              <p className="text-xs font-semibold text-amber-900">当前输入不足以计算单位经济性，未提供的成本不会按 0 补足。</p>
              <ul data-testid="ue-reasons" className="space-y-1 text-[13px] leading-relaxed text-amber-800">
                {(view.reasons.length > 0 ? view.reasons : ["缺少必要的成本与费率输入。"]).map((reason, index) => (
                  <li key={index} className="flex items-start gap-1.5">
                    <span className="font-bold">•</span>
                    <span>{reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {(() => {
            const missing = view.inputProvenance.filter((line) => line.nature === "MISSING");
            if (!missing.length) return null;
            return (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <span className="text-[13px] font-semibold text-slate-600">仍缺的输入（在下方表单填写后保存）：</span>
                <div data-testid="ue-missing-inputs" className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                  {missing.map((line) => (
                    <div key={line.key} className="rounded border border-slate-200 bg-white px-2 py-1.5">
                      <span className="block text-[12px] text-slate-500">{line.label}</span>
                      <span className="mt-0.5 block"><NatureBadge nature={line.nature} /></span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 space-y-2">
              <span className="text-[13px] font-bold uppercase tracking-wider text-slate-500">售价与成本构成</span>
              <div data-testid="ue-selling-price" className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] font-semibold text-slate-700">{view.sellingPrice.label}</span>
                  <NatureBadge nature={view.sellingPrice.nature} />
                </div>
                <span className="text-xs font-bold text-slate-900">{formatMoney(view.sellingPrice.amountUsd, view.currency)}</span>
              </div>
              <div className="space-y-2">
                {view.costLines.map((line) => <CostLine key={line.key} line={line} currency={view.currency} />)}
              </div>
              <div className="flex items-center justify-between rounded-lg bg-slate-900 px-2.5 py-2">
                <span className="text-[13px] font-semibold text-white">单件成本合计</span>
                <span data-testid="ue-total-cost" className="text-sm font-bold text-white">{formatMoney(view.totalUnitCostUsd, view.currency)}</span>
              </div>
            </div>

            <div className="space-y-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 space-y-2">
                <span className="text-[13px] font-bold uppercase tracking-wider text-slate-500">利润与保本</span>
                <div className="grid grid-cols-2 gap-2">
                  {view.metrics.map((metric) => <MetricRow key={metric.key} metric={metric} currency={view.currency} partialCostBasis={view.isPartialCostBasis} />)}
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-3 space-y-2">
                <span className="text-[13px] font-bold uppercase tracking-wider text-slate-500">计算依据（可复算）</span>
                <ul data-testid="ue-formula-notes" className="space-y-1 text-[13px] leading-relaxed text-slate-600">
                  {view.formulaNotes.map((note, index) => (
                    <li key={index} className="flex items-start gap-1.5">
                      <Info className="mt-0.5 size-3 shrink-0 text-slate-400" />
                      <span>{formulaNote(note, view.isPartialCostBasis)}</span>
                    </li>
                  ))}
                </ul>
                <div className="text-[12px] text-slate-400">
                  头程口径：{view.freightBasis === "per_unit" ? "按单件头程费用直接计" : view.freightBasis === "chargeable_weight" ? `按计费重 ${view.chargeableWeightKg ?? "—"} kg` : "未使用"}
                  {" · "}平台佣金：{view.commissionIncluded ? "已纳入" : "未纳入"}
                </div>
              </div>
            </div>
          </div>

        </>
      )}

      <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-3 space-y-2">
        <div className="flex items-center gap-1.5">
          <AlertTriangle className="size-3.5 text-amber-600" />
          <span className="text-[13px] font-bold text-amber-900">
            {available ? "本次测算未纳入的费用（不得视为完整净利润）" : "本次测算未纳入的费用"}
          </span>
        </div>
        <div data-testid="ue-excluded-costs" className="space-y-1.5">
          {view.conditionalExcludedCosts.length ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] text-amber-800">补齐对应输入后会纳入：</span>
              {view.conditionalExcludedCosts.map((cost) => (
                <span key={cost} data-testid="ue-conditional-cost" className="rounded border border-amber-300 bg-white px-2 py-0.5 text-[12px] text-amber-900">{cost}</span>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] text-amber-800">本模型始终不纳入：</span>
            {view.alwaysExcludedCosts.map((cost) => (
              <span key={cost} className="rounded border border-amber-300 bg-white px-2 py-0.5 text-[12px] text-amber-900">{cost}</span>
            ))}
          </div>
        </div>
      </div>

      <ProvenanceContainer className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 space-y-2" data-testid="ue-provenance-details">
        <ProvenanceHeading className="cursor-pointer text-[13px] font-semibold text-slate-600">输入来源性质登记</ProvenanceHeading>
        <div data-testid="ue-provenance" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {view.inputProvenance.map((line) => (
            <div key={line.key} className="rounded border border-slate-200 bg-white px-2 py-1.5">
              <div className="flex items-center justify-between gap-1">
                <span className="text-[12px] text-slate-500">{line.label}</span>
                <NatureBadge nature={line.nature} />
              </div>
              <span className="mt-0.5 block font-mono text-[12px] text-slate-400">
                {line.source ?? "无来源"} · {line.effectiveDate ? line.effectiveDate.slice(0, 10) : "无生效日期"}
              </span>
            </div>
          ))}
        </div>
      </ProvenanceContainer>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-indigo-200 bg-indigo-50/50 p-3">
        <div className="flex items-center gap-2">
          <Lock className="size-3.5 text-indigo-700" />
          <span className="text-[13px] font-semibold text-indigo-950">
            本结果为辅助决策的确定性计算，不构成立项建议，也不会自动推进人工决策。
          </span>
        </div>
        <span className="flex items-center gap-1 text-[12px] font-semibold text-rose-600">
          <CheckCircle2 className="size-3" />
          人工决策保持独立
        </span>
      </div>
    </section>
  );
}

export default UnitEconomicsResultCard;
