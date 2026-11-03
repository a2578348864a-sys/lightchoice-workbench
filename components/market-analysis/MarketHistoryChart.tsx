"use client";

import { useId, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { MarketIntelligence } from "@/lib/marketScan/intelligence";
import { HISTORY_METRICS, historyChartPoints, historyMetricKey } from "./marketTrendPresentation";
import visual from "./MarketResearchVisual.module.css";

export function MarketHistoryChart({ data, subjects }: { data: MarketIntelligence; subjects: string[] }) {
  const series = data.trends.filter((trend) => subjects.includes(trend.subjectKey) && !trend.field.startsWith("keepa.window.") && trend.points.length > 1);
  const keys = [...new Set(series.map((trend) => trend.subjectKey))];
  const [selected, setSelected] = useState(keys[0] ?? "");
  const currentSubject = keys.includes(selected) ? selected : keys[0];
  const subjectSeries = series.filter((trend) => trend.subjectKey === currentSubject);
  const [metric, setMetric] = useState("sellersprite.traffic.monthlySales");
  const trend = subjectSeries.find((entry) => entry.field === metric) ?? subjectSeries.find((entry) => historyMetricKey(entry.field) === "monthlySales") ?? subjectSeries[0];
  const config = trend ? HISTORY_METRICS[historyMetricKey(trend.field)] ?? { label: historyMetricKey(trend.field), unit: "来源未注明", monthly: false } : null;
  const monthly = config?.monthly ?? false;
  const points = useMemo(() => trend ? historyChartPoints(trend.points, monthly) : [], [trend, monthly]);
  const gradient = useId().replace(/:/gu, "");
  if (!trend || !config) return <p>暂无可用单品历史序列；不影响继续核对已保存事实。</p>;
  const actual = points.filter((point) => point.value !== null);
  if (!actual.length) return <p>已保存序列没有可用的日期与数值；无法绘制历史变化。</p>;
  const latest = actual.at(-1)!;
  const format = (value: number) => `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${config.unit === "%" ? "%" : ""}`;
  return <section className={visual.historyPanel} aria-label="单品历史主图" data-history-subject={trend.subjectKey} data-history-field={trend.field}>
    <div className={visual.historyHeader}>
      <div><span className={visual.eyebrow}>单品历史 · {trend.subjectKey.split(":").at(-1)}</span><h3>{config.label}</h3><strong className={visual.historyValue}>{format(latest.value!)}<small>{config.unit === "%" ? "最近观察" : config.unit}</small></strong></div>
      <label>查看商品<select value={currentSubject} onChange={(event) => setSelected(event.target.value)} aria-label="历史商品">{keys.map((key) => <option key={key} value={key}>{key.split(":").at(-1)}</option>)}</select></label>
    </div>
    <div className={visual.metricTabs} role="group" aria-label="历史指标切换">{subjectSeries.map((entry) => <button type="button" key={entry.field} aria-pressed={entry.field === trend.field} onClick={() => setMetric(entry.field)}>{HISTORY_METRICS[historyMetricKey(entry.field)]?.label ?? historyMetricKey(entry.field)}</button>)}</div>
    <div className={visual.historyCanvas} role="img" aria-label={`${trend.subjectKey} ${config.label}，单位 ${config.unit}，${trend.points.length} 个原始日期点`}>
      <ResponsiveContainer width="100%" height={300}>
        <AreaChart data={points} margin={{ top: 22, right: 18, bottom: 6, left: 12 }}>
          <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3b9b75" stopOpacity={0.32} /><stop offset="95%" stopColor="#3b9b75" stopOpacity={0.02} /></linearGradient></defs>
          <CartesianGrid vertical={false} stroke="#dce8df" strokeDasharray="3 5" />
          <XAxis dataKey="timestamp" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(value) => new Date(value).toISOString().slice(0, 7)} axisLine={false} tickLine={false} minTickGap={65} tick={{ fontSize: 12, fill: "#60756b" }} />
          <YAxis width={62} axisLine={false} tickLine={false} tickFormatter={(value) => config.unit === "%" ? `${value}%` : Math.abs(value) >= 10000 ? `${value / 10000}万` : String(value)} tick={{ fontSize: 12, fill: "#60756b" }} domain={["auto", "auto"]} />
          <Tooltip labelFormatter={(value) => new Date(Number(value)).toISOString().slice(0, 10)} formatter={(value) => [format(Number(value)), `${config.label} · ${config.unit}`]} contentStyle={{ border: "1px solid #d3e4d9", borderRadius: 12, padding: 14, boxShadow: "0 8px 32px #173c3020" }} />
          <Area type="linear" dataKey="value" name={config.label} stroke="#25845f" strokeWidth={2.5} fill={`url(#${gradient})`} connectNulls={false} dot={{ r: 2.5, fill: "#25845f", stroke: "white", strokeWidth: 1 }} activeDot={{ r: 5, fill: "#145a41", stroke: "white", strokeWidth: 3 }} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
    <div className={visual.historyFooter}><span><i />{config.label} · {config.unit}</span><span>{new Date(actual[0].timestamp).toISOString().slice(0, 10)} — {new Date(latest.timestamp).toISOString().slice(0, 10)} · 原始 {trend.points.length} 点{points.some((point) => point.value === null) ? " · 缺失月份断开" : ""}</span></div>
    <details className={visual.subtleDisclosure}><summary>来源与日期口径</summary><p>单款历史不代表全市场；日期为来源观察月份 / 日期。月表与不规则观察保持原记录，不插值、不补零；留评率采用来源已保存的百分数，不重复乘100。</p><p>{trend.evidence.nature === "provider_estimate" ? "第三方估算" : "第三方来源观察"} · 采集 {trend.evidence.capturedAt} · {trend.evidence.id}</p>{trend.evidence.sourceUrl && <a href={trend.evidence.sourceUrl} target="_blank" rel="noreferrer">打开已保存来源页面</a>}</details>
  </section>;
}
