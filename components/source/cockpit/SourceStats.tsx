"use client";

import { useMemo } from "react";
import { Bar, BarChart, Tooltip, XAxis } from "recharts";
import { Database, FileStack, FlaskConical, Target } from "lucide-react";
import { NumberTicker } from "@/components/hifi-v6/cockpit/NumberTicker";
import { ChartContainer, ChartTooltipCard } from "@/components/hifi-v6/cockpit/ChartPrimitives";
import styles from "./SourceCockpit.module.css";

export type StatBatch = {
  id: string;
  createdAt: string;
  itemCount: number;
  rawCount?: number;
  acceptedCount: number;
  validSampleCount?: number;
  marketScan?: { id: string } | null;
  validProductSet?: { isSufficient: boolean } | null;
};

function dayKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * 采集统计：只使用 /api/source/batches 返回的真实批次字段。
 * 没有可靠字段的指标（例如实时进度、估算销量）不展示。
 */
export function SourceStats({
  batches,
  minimumRequired,
  loading,
}: {
  batches: StatBatch[];
  minimumRequired: number;
  loading: boolean;
}) {
  const stats = useMemo(() => {
    const totalProducts = batches.reduce((sum, batch) => sum + (batch.rawCount ?? batch.itemCount ?? 0), 0);
    const totalValid = batches.reduce((sum, batch) => sum + (batch.validSampleCount ?? batch.acceptedCount ?? 0), 0);
    const ready = batches.filter((batch) => {
      const valid = batch.validSampleCount ?? batch.acceptedCount ?? 0;
      return batch.validProductSet ? batch.validProductSet.isSufficient : valid >= minimumRequired;
    }).length;
    const linked = batches.filter((batch) => Boolean(batch.marketScan)).length;

    const today = new Date();
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - (6 - index));
      const key = dayKey(date.toISOString());
      return { key, label: `${date.getMonth() + 1}/${date.getDate()}`, count: 0 };
    });
    const index = new Map(days.map((day) => [day.key, day]));
    for (const batch of batches) {
      const bucket = index.get(dayKey(batch.createdAt));
      if (bucket) bucket.count += 1;
    }
    return { totalProducts, totalValid, ready, linked, days };
  }, [batches, minimumRequired]);

  const last7 = stats.days.reduce((sum, day) => sum + day.count, 0);

  const tiles = [
    {
      id: "batches",
      tone: "mint",
      icon: Database,
      label: "采集批次",
      value: batches.length,
      unit: "个",
      hint: `近 7 天新增 ${last7} 个`,
      chart: true,
    },
    {
      id: "products",
      tone: "cyan",
      icon: FileStack,
      label: "商品线索",
      value: stats.totalProducts,
      unit: "款",
      hint: `其中有效样本 ${stats.totalValid} 款`,
      chart: false,
    },
    {
      id: "ready",
      tone: "violet",
      icon: Target,
      label: "可建市场研究",
      value: stats.ready,
      unit: "个批次",
      hint: `有效样本门槛 ≥ ${minimumRequired} 款`,
      chart: false,
    },
    {
      id: "linked",
      tone: "amber",
      icon: FlaskConical,
      label: "已建市场研究",
      value: stats.linked,
      unit: "个批次",
      hint: stats.ready > stats.linked ? `另有 ${stats.ready - stats.linked} 个可建立` : "全部可建批次已关联",
      chart: false,
    },
  ];

  return (
    <section className={styles.statsRow} aria-label="采集统计" data-testid="capture-overview-strip">
      {tiles.map((tile) => {
        const Icon = tile.icon;
        return (
          <article key={tile.id} className={styles.statCard} data-tone={tile.tone}>
            <span className={styles.statLabel}>
              <Icon size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} aria-hidden="true" />
              {tile.label}
            </span>
            <span className={styles.statValue}>
              {loading ? "—" : <NumberTicker value={tile.value} immediate ariaLabel={`${tile.value}`} />}
              <small>{tile.unit}</small>
            </span>
            <span className={styles.statHint}>{tile.hint}</span>
            {tile.chart && !loading ? (
              <div className={styles.statChart}>
                <ChartContainer height={40} ariaLabel={`近 7 天批次：${stats.days.map((day) => `${day.label} ${day.count} 个`).join("，")}`}>
                  <BarChart data={stats.days} margin={{ top: 4, right: 0, left: 0, bottom: 0 }} barCategoryGap="22%">
                    <XAxis dataKey="label" hide />
                    <Tooltip
                      cursor={{ fill: "rgba(8,127,104,0.06)" }}
                      content={(props) => {
                        if (!props.active || !props.payload?.length) return null;
                        const point = props.payload[0]?.payload as { label?: string; count?: number } | undefined;
                        if (!point) return null;
                        return (
                          <ChartTooltipCard
                            title={point.label ?? ""}
                            rows={[{ key: "count", label: "新增批次", value: `${point.count ?? 0} 个`, color: "#087f68" }]}
                          />
                        );
                      }}
                    />
                    <Bar dataKey="count" fill="#0f8f74" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ChartContainer>
              </div>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
