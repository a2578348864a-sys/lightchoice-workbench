"use client";

import { AlertTriangle, CheckCircle2, HelpCircle, Layers3 } from "lucide-react";

import type { SampleHomogeneityReport, SampleSubtypeId } from "@/lib/marketScan/sampleHomogeneity";

const RISK_META: Record<SampleHomogeneityReport["mixedRisk"], {
  label: string;
  tone: string;
  icon: typeof AlertTriangle;
}> = {
  high: { label: "高混杂风险", tone: "border-rose-300 bg-rose-50 text-rose-900", icon: AlertTriangle },
  medium: { label: "中等混杂", tone: "border-amber-300 bg-amber-50 text-amber-900", icon: AlertTriangle },
  low: { label: "样本较集中", tone: "border-emerald-300 bg-emerald-50 text-emerald-900", icon: CheckCircle2 },
  insufficient: { label: "样本过少，无法判断", tone: "border-slate-300 bg-slate-50 text-slate-700", icon: HelpCircle },
};

/**
 * 02 市场研究 · 样本范围与混杂风险。
 *
 * 只展示确定性分类结果；类型筛选仅影响下方列表显示，不改变锁定样本与统计口径。
 */
export function MarketSampleScopePanel({
  report,
  activeSubtype,
  onSubtypeChange,
}: {
  report: SampleHomogeneityReport;
  activeSubtype: SampleSubtypeId | "all";
  onSubtypeChange: (next: SampleSubtypeId | "all") => void;
}) {
  const risk = RISK_META[report.mixedRisk];
  const RiskIcon = risk.icon;
  const maxCount = Math.max(1, ...report.groups.map((group) => group.count));

  return (
    <section
      id="sample-scope-section"
      aria-label="样本范围与混杂风险"
      data-testid="sample-scope-panel"
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-bold uppercase tracking-wider text-slate-400">样本范围</p>
          <h2 className="mt-1 flex flex-wrap items-center gap-2 text-lg font-bold text-slate-900">
            这批商品是不是同一个市场？
            <span className="text-sm font-medium text-slate-400">样本范围与混杂风险</span>
          </h2>
          <p className="mt-1 max-w-4xl text-[15px] leading-7 text-slate-600">{report.headline}</p>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-semibold ${risk.tone}`} data-testid="sample-scope-risk">
          <RiskIcon className="size-4" />
          {risk.label}
        </span>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="space-y-2">
          {report.groups.map((group) => {
            const active = activeSubtype === group.id;
            return (
              <button
                key={group.id}
                type="button"
                onClick={() => onSubtypeChange(active ? "all" : group.id)}
                aria-pressed={active}
                data-testid={`sample-scope-group-${group.id}`}
                className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                  active ? "border-emerald-400 bg-emerald-50/70" : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[15px] font-semibold text-slate-800">
                    {group.label}
                    <span className="ml-2 text-[13px] font-normal text-slate-400">{group.labelEn}</span>
                  </span>
                  <span className="shrink-0 text-[14px] font-semibold text-slate-700">
                    {group.count} 款 · {Math.round(group.share * 100)}%
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={`h-full rounded-full ${group.id === "unknown" ? "bg-slate-400" : "bg-emerald-500"}`}
                    style={{ width: `${Math.max(3, (group.count / maxCount) * 100)}%` }}
                  />
                </div>
                <div className="mt-1 truncate text-[12px] text-slate-400">{group.asins.slice(0, 6).join(" · ")}{group.asins.length > 6 ? " …" : ""}</div>
              </button>
            );
          })}
        </div>

        <div className="space-y-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
            <p className="flex items-center gap-1.5 text-[14px] font-semibold text-slate-800">
              <Layers3 className="size-4 text-slate-500" />
              怎么读这份分类
            </p>
            <ul className="mt-2 space-y-1.5 text-[14px] leading-6 text-slate-600">
              {report.caveats.map((caveat) => (
                <li key={caveat}>· {caveat}</li>
              ))}
            </ul>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-3 text-[14px] leading-6 text-slate-600">
            <p className="font-semibold text-slate-800">当前视图筛选</p>
            <p className="mt-1">
              {activeSubtype === "all"
                ? "未筛选，列表显示全部锁定样本。点击左侧任一类型可只看该类型商品。"
                : `正在只看「${report.groups.find((group) => group.id === activeSubtype)?.label ?? activeSubtype}」；筛选只影响列表显示，不改变本页统计口径。`}
            </p>
            {activeSubtype !== "all" ? (
              <button
                type="button"
                onClick={() => onSubtypeChange("all")}
                className="mt-2 inline-flex items-center rounded-lg border border-slate-300 px-2.5 py-1 text-[13px] font-semibold text-slate-700 hover:bg-slate-50"
              >
                清除类型筛选
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {report.mixedRisk === "high" ? (
        <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[14px] leading-6 text-rose-900" data-testid="sample-scope-warning">
          这批样本混合了多个细分市场。下方的价格中位数、竞争强度等指标是<strong>整批混合结果</strong>，
          不能直接作为某一具体产品（例如「硬质塑料收纳箱」或「抽屉分隔盒」）的确定结论。
          若要得到单一细分市场的结论，应使用相同关键词与筛选条件重新采集一批更聚焦的样本，另建市场研究。
        </p>
      ) : null}
    </section>
  );
}
