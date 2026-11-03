"use client";

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Tooltip, XAxis, YAxis } from "recharts";
import type { TooltipContentProps } from "recharts";
import { ArrowUpRight, Check, X } from "lucide-react";
import { ChartContainer, ChartTooltipCard, type TooltipRow } from "./ChartPrimitives";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import type { PriceBandView, PriceStructure } from "./cockpitModel";
import styles from "./cockpit.module.css";

const TONE_COLOR: Record<string, string> = {
  green: "var(--ck-green)",
  blue: "var(--ck-blue)",
  violet: "var(--ck-violet)",
  amber: "var(--ck-amber)",
};

export type PriceSamplePreview = {
  asin: string;
  title: string | null;
  imageUrl: string | null;
  price: number | null;
};

function pickBandId(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  if (typeof record.id === "string") return record.id;
  const payload = record.payload;
  if (payload && typeof payload === "object") {
    const id = (payload as Record<string, unknown>).id;
    if (typeof id === "string") return id;
  }
  return null;
}

function money(value: number | null): string {
  return value == null ? "未知" : `$${value.toFixed(2)}`;
}

export function PriceStructureCard({
  structure,
  activeBandId,
  matched,
  onSelectBand,
  onClearBand,
  onOpenSample,
  onEnterCompetition,
}: {
  structure: PriceStructure;
  activeBandId: string | null;
  matched: PriceSamplePreview[];
  onSelectBand: (id: string) => void;
  onClearBand: () => void;
  onOpenSample: (asin: string) => void;
  onEnterCompetition: (band: PriceBandView) => void;
}) {
  const reduced = usePrefersReducedMotion();
  const [hoverId, setHoverId] = useState<string | null>(null);
  const activeBand = structure.bands.find((band) => band.id === activeBandId) ?? null;
  const data = structure.bands.map((band) => ({
    id: band.id,
    name: band.axisLabel,
    count: band.count,
    share: Math.round(band.share * 100),
    range: band.rangeLabel,
    observed: band.observedMin != null && band.observedMax != null
      ? `${money(band.observedMin)}–${money(band.observedMax)}`
      : "该带无样本",
    tone: band.tone,
  }));

  const renderTooltip = (props: TooltipContentProps) => {
    if (!props.active || !props.payload?.length) return null;
    const point = props.payload[0]?.payload as Record<string, unknown> | undefined;
    if (!point) return null;
    const count = Number(point.count ?? 0);
    const share = Number(point.share ?? 0);
    const range = String(point.range ?? "");
    const observed = String(point.observed ?? "未知");
    const tone = String(point.tone ?? "green");
    const rows: TooltipRow[] = [
      { key: "count", label: "商品数量", value: `${count} 件`, color: TONE_COLOR[tone] },
      { key: "share", label: "占可计价样本", value: `${share}%`, muted: true },
      { key: "observed", label: "实际价格区间", value: observed, muted: true },
    ];
    return (
      <ChartTooltipCard
        title={`价格带 ${range}`}
        rows={rows}
        footer={`统计范围：当前 ${structure.pricedCount} 件可计价锁定样本（USD 包价）`}
      />
    );
  };

  return (
    <section className={`${styles.card} ${styles.priceCard}`} aria-labelledby="ck-price-title">
      <header className={styles.cardHead}>
        <div>
          <p className={styles.kicker}>包价分布</p>
          <h2 id="ck-price-title" className={styles.cardTitle}>市场价格结构</h2>
        </div>
        <div className={styles.headMeta}>
          <span className={styles.pill}>中位 {money(structure.median)}</span>
          <span className={styles.pill}>{money(structure.min)} – {money(structure.max)}</span>
        </div>
      </header>

      {structure.pricedCount === 0 ? (
        <div className={styles.emptyBlock} role="status">
          <strong>当前样本没有可用价格</strong>
          <p>{structure.sampleCount} 件锁定样本中 0 件可计价，不能计算价格结构；缺失不按 0 处理。</p>
        </div>
      ) : (
        <>
          <ChartContainer
            height={210}
            ariaLabel={`价格分带柱状图：${structure.bands.map((band) => `${band.rangeLabel} ${band.count} 件`).join("，")}`}
          >
            <BarChart data={data} margin={{ top: 22, right: 6, left: -18, bottom: 0 }} barCategoryGap="26%">
              <CartesianGrid strokeDasharray="4 6" vertical={false} stroke="rgba(23,43,39,0.09)" />
              <XAxis
                dataKey="name"
                tickLine={false}
                axisLine={false}
                dy={6}
                tick={{ fontSize: 12, fill: "var(--ck-muted)" }}
              />
              <YAxis
                allowDecimals={false}
                width={40}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 12, fill: "var(--ck-faint)" }}
              />
              <Tooltip cursor={{ fill: "rgba(8,127,104,0.06)" }} content={renderTooltip} />
              <Bar
                dataKey="count"
                radius={[10, 10, 4, 4]}
                maxBarSize={62}
                isAnimationActive={!reduced}
                animationDuration={620}
                onClick={(entry) => {
                  const id = pickBandId(entry);
                  if (id) onSelectBand(id);
                }}
                onMouseEnter={(entry) => setHoverId(pickBandId(entry))}
                onMouseLeave={() => setHoverId(null)}
                className={styles.priceBar}
              >
                {data.map((point) => {
                  const dimmed = activeBandId != null && activeBandId !== point.id;
                  const hovered = hoverId === point.id;
                  return (
                    <Cell
                      key={point.id}
                      fill={TONE_COLOR[point.tone]}
                      opacity={dimmed ? 0.32 : 1}
                      stroke={activeBandId === point.id ? "var(--ck-ink)" : hovered ? "rgba(23,43,39,0.28)" : "transparent"}
                      strokeWidth={activeBandId === point.id ? 2 : 1}
                    />
                  );
                })}
                <LabelList
                  dataKey="count"
                  position="top"
                  offset={8}
                  formatter={(value) => `${value ?? ""}`}
                  style={{ fontSize: 12.5, fontWeight: 700, fill: "var(--ck-ink)" }}
                />
              </Bar>
            </BarChart>
          </ChartContainer>

          <div className={styles.bandRow} role="group" aria-label="按价格带筛选样本">
            {structure.bands.map((band) => {
              const active = band.id === activeBandId;
              return (
                <button
                  key={band.id}
                  type="button"
                  className={styles.bandChip}
                  data-active={active ? "true" : undefined}
                  data-empty={band.count === 0 ? "true" : undefined}
                  aria-pressed={active}
                  onClick={() => (active ? onClearBand() : onSelectBand(band.id))}
                >
                  <span className={styles.bandDot} style={{ background: TONE_COLOR[band.tone] }} aria-hidden="true" />
                  {band.rangeLabel}
                  <em>{band.count}</em>
                  {active ? <Check size={12} aria-hidden="true" /> : null}
                </button>
              );
            })}
            {activeBand ? (
              <button type="button" className={styles.clearChip} onClick={onClearBand}>
                <X size={12} aria-hidden="true" />清除筛选
              </button>
            ) : null}
          </div>

          {activeBand ? (
            <div className={styles.bandResult} role="status">
              <div className={styles.bandResultHead}>
                <strong>{activeBand.rangeLabel} · {activeBand.count} 件</strong>
                <span>占可计价样本 {Math.round(activeBand.share * 100)}%{activeBand.count === 0 ? "（该带当前无样本）" : ""}</span>
              </div>
              {matched.length ? (
                <ul className={styles.sampleStrip}>
                  {matched.map((sample) => (
                    <li key={sample.asin}>
                      <button type="button" className={styles.sampleChip} onClick={() => onOpenSample(sample.asin)}>
                        <span className={styles.sampleThumb}>
                          {sample.imageUrl
                            ? <img src={sample.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                            : <span className={styles.sampleThumbEmpty} aria-hidden="true" />}
                        </span>
                        <span className={styles.sampleChipText}>
                          <strong>{sample.asin}</strong>
                          <small>{money(sample.price)}</small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.bandResultEmpty}>该价格带当前没有锁定样本；空带保留展示，不补数据。</p>
              )}
              {activeBand.filterLabel && activeBand.count > 0 ? (
                <button type="button" className={styles.inlineCta} onClick={() => onEnterCompetition(activeBand)}>
                  带着该筛选进入 02 市场竞争
                  <ArrowUpRight size={14} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          ) : null}

          <p className={styles.cardNote}>
            {activeBand
              ? "筛选只作用于本页展示；包价为包装单位价格，套装件数缺失时不能换算单位价。"
              : "点击柱形或价格带筛选正式样本；包价为包装单位价格，套装件数缺失时不能换算单位价。"}
          </p>
        </>
      )}
    </section>
  );
}
