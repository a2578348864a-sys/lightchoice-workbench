export const HISTORY_METRICS: Record<string, { label: string; unit: string; monthly: boolean }> = {
  monthlySales: { label: "月销量", unit: "件 / 月 · 第三方估算", monthly: true },
  reviewGrowth: { label: "评分增长", unit: "条 / 月", monthly: true },
  reviewRate: { label: "留评率", unit: "%", monthly: true },
  monthlyRevenue: { label: "月销售额", unit: "USD / 月 · 第三方估算", monthly: true },
  avgPrice: { label: "月平均标价", unit: "USD", monthly: true },
  price: { label: "观察标价", unit: "USD", monthly: false },
  rating: { label: "评分", unit: "星", monthly: false },
  reviewCount: { label: "累计评分数", unit: "条", monthly: false },
  bsr: { label: "BSR 排名", unit: "名", monthly: false },
};
export const historyMetricKey = (field: string) => field.replace(/^(?:sellersprite\.traffic|keepa\.window)\./u, "");

/** View-only calendar gaps. No interpolation, aggregation, zero filling or evidence mutation. */
export function historyChartPoints(points: readonly { date: string; value: number }[], monthly: boolean) {
  const result = points.filter((point) => Number.isFinite(Date.parse(point.date)) && Number.isFinite(point.value))
    .map((point) => ({ timestamp: Date.parse(point.date), value: point.value as number | null })).sort((a, b) => a.timestamp - b.timestamp);
  if (!monthly || result.length < 2) return result;
  const observedMonths = new Set(result.map((point) => new Date(point.timestamp).toISOString().slice(0, 7)));
  const first = new Date(result[0].timestamp), last = result.at(-1)!.timestamp;
  const gaps: typeof result = [];
  for (let date = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1), months = 0; date <= last && months < 600; months += 1) {
    const month = new Date(date).toISOString().slice(0, 7);
    if (!observedMonths.has(month)) gaps.push({ timestamp: date, value: null });
    const current = new Date(date); date = Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1);
  }
  // Retain every original point, including multiple observations within one month.
  return [...result, ...gaps].sort((a, b) => a.timestamp - b.timestamp);
}
