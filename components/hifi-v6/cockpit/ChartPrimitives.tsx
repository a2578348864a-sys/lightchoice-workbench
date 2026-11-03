"use client";

/**
 * 图表基元。
 * 结构移植 shadcn/ui Charts（ui.shadcn.com/docs/components/chart）：
 * - ChartContainer：固定高度的 ResponsiveContainer 外壳 + 图表级 CSS 变量；
 * - ChartTooltipCard：与 shadcn ChartTooltipContent 一致的提示卡结构（标题行 / 带色点的指标行 / 脚注）。
 * 本仓库未引入 shadcn 的 cn / cva，故用 CSS Module 落地同一视觉与信息层级，recharts 保持原库实现。
 */
import type { ReactNode } from "react";
import { ResponsiveContainer } from "recharts";
import styles from "./cockpit.module.css";

export function ChartContainer({
  height = 220,
  children,
  ariaLabel,
}: {
  height?: number;
  children: ReactNode;
  ariaLabel: string;
}) {
  return (
    <div className={styles.chartShell} style={{ height, minHeight: height }} role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

export type TooltipRow = {
  key: string;
  label: string;
  value: string;
  color?: string;
  muted?: boolean;
};

export function ChartTooltipCard({
  title,
  rows,
  footer,
}: {
  title: ReactNode;
  rows: TooltipRow[];
  footer?: ReactNode;
}) {
  return (
    <div className={styles.chartTooltip}>
      <div className={styles.chartTooltipTitle}>{title}</div>
      <div className={styles.chartTooltipRows}>
        {rows.map((row) => (
          <div key={row.key} className={styles.chartTooltipRow} data-muted={row.muted ? "true" : undefined}>
            <span className={styles.chartTooltipDot} style={{ background: row.color ?? "currentColor" }} aria-hidden="true" />
            <span className={styles.chartTooltipLabel}>{row.label}</span>
            <strong className={styles.chartTooltipValue}>{row.value}</strong>
          </div>
        ))}
      </div>
      {footer ? <div className={styles.chartTooltipFooter}>{footer}</div> : null}
    </div>
  );
}
