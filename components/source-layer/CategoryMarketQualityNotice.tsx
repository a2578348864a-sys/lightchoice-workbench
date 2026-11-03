type QualityRow = {
  monthlyTotalSales: { value: number | null };
  fieldCoverage?: { missingColumns: string[]; unavailableFields: string[]; availableMetricCount: number; totalMetricCount: number };
};

/** Read-only projection: never rewrites warnings or values in historical Evidence. */
export function CategoryMarketQualityNotice({ rows }: { rows: readonly QualityRow[] }) {
  const quality = rows.map(row => {
    if (row.fieldCoverage) return row.fieldCoverage;
    const metrics = Object.values(row).filter(value => typeof value === "object" && value !== null && "nature" in value) as { value: number | null }[];
    return { missingColumns: [], unavailableFields: [], availableMetricCount: metrics.filter(metric => metric.value !== null).length,
      totalMetricCount: metrics.length };
  });
  const partial = quality.filter(row => row.availableMetricCount > 0 && row.availableMetricCount < row.totalMetricCount).length;
  const unavailable = quality.filter(row => row.availableMetricCount === 0).length;
  const missingColumns = [...new Set(quality.flatMap(row => row.missingColumns))];
  const labels: Record<string, string> = { averagePriceUsd: "平均价格", returnRatePercent: "退货率", sample: "样本数量",
    monthlyTotalSales: "月总销量", topMonthlyAverageSales: "头部月均销量", topMonthlyAverageRevenueUsd: "头部月均销售额",
    averageReviewAndRating: "评分数与星级", averageTopBsr: "头部 BSR", averageSellerCount: "卖家数", sellerType: "卖家结构",
    concentration: "集中度", newProducts: "新品数量与占比", totalProductCount: "商品总数" };
  if (!partial && !unavailable && !missingColumns.length) return null;
  return <div data-testid="category-market-quality" className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
    <p>字段覆盖：{partial} 行部分指标未提供；{unavailable} 行全部数值指标不可用。缺失值保持“未提供”。</p>
    {missingColumns.length ? <p className="mt-1">该快照未映射的列：{missingColumns.map(column => labels[column] ?? "其他市场指标").join("、")}。</p> : null}
    {rows.some(row => !row.fieldCoverage) ? <p className="mt-1">历史快照未记录逐列缺失原因；以上按已保存数值展示，原始证据保持不变。</p> : null}
  </div>;
}
