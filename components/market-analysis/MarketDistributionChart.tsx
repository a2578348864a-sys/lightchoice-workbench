"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import styles from "./MarketIntelligencePanel.module.css";

/** Shared distribution rendering; denominators and bins always come from saved research statistics. */
export function MarketDistributionChart({ title, bins, denominator, note, color = "#2563eb", height = 175, readable = false }: {
  title: string; bins: { label: string; count: number }[]; denominator: number;
  note: string; color?: string; height?: number; readable?: boolean;
}) {
  return <article className={styles.chart}>
    <div className={styles.chartHead}><h3>{title}</h3><span>有效样本 {denominator.toLocaleString("zh-CN")}</span></div>
    <p className={styles.chartNote}>{note}</p>
    {denominator ? <>
      <div role="img" aria-label={`${title}：${bins.map((bin) => `${bin.label} ${bin.count}`).join("，")}`}>
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={bins} margin={readable ? { top: 10, right: 12, bottom: 12, left: 0 } : undefined}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e8edf3" />
            <XAxis dataKey="label" tick={{ fontSize: readable ? 13 : 11 }} interval={readable ? 0 : undefined} />
            <YAxis allowDecimals={false} width={readable ? 40 : 28} tick={{ fontSize: readable ? 13 : 11 }} />
            <Tooltip /><Bar isAnimationActive={false} dataKey="count" name={readable ? "商品数" : "数量"} fill={color} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className={styles.chartValues}>
        <summary>查看分箱数值与口径</summary>
        <p>分母 {denominator}；{note}。缺失值不按 0 计入。</p>
        {bins.map((bin) => <p key={bin.label}>{bin.label}：{bin.count}</p>)}
      </details>
    </> : <p className={styles.emptyState}>当前证据不足，不能计算此分布。</p>}
  </article>;
}
