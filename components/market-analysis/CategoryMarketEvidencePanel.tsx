"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Layers, Loader2, Link2, HelpCircle, Unlink } from "lucide-react";

type Metric = {
  key: string;
  label: string;
  value: number | null;
  nature: "provider_estimate";
  unit: "count" | "currency" | "rating" | "percent";
  usableForMetrics: boolean;
  anomaly: "out_of_range_percent" | "negative_value" | null;
};

type Row = { segment: string; metrics: Metric[]; warnings: string[] };

type Summary = {
  subjectKey: string;
  nodeId: string;
  batchId: string;
  label: string;
  query: string;
  marketplace: string;
  capturedAt: string;
  rowCount: number;
  amazonConfirmed: false;
  providerProductCount: number | null;
};

type ScopeAssessment = {
  level: "range_matched" | "category_related" | "possible_mismatch" | "unknown";
  evidenceTopCategory: string | null;
  sampleCategoryTop: string | null;
  sampleCategoryMatchCount: number;
  sampleCategoryTotal: number;
  segments: Array<{
    segment: string;
    keywords: string[];
    matchedSampleCount: number;
    sampleTotal: number;
    supported: boolean;
  }>;
  reason: string;
};

type Detail = Summary & {
  sourceUrl: string;
  sourceProvider: string;
  rows: Row[];
  ageDays: number | null;
  observedHeaders: string[] | null;
  hasAnomalousMetrics: boolean;
};

type View = {
  scanId: string;
  marketplace: string;
  resourceVersion: string;
  linked: Detail | null;
  available: Summary[];
  status: "linked" | "not_linked" | "linked_evidence_missing" | "no_evidence";
  notice: string;
  scopeAssessment: ScopeAssessment | null;
  availableScopeAssessments: Record<string, ScopeAssessment>;
};

const SCOPE_META: Record<ScopeAssessment["level"], { label: string; tone: string; icon: typeof CheckCircle2 }> = {
  range_matched: { label: "范围匹配", tone: "border-emerald-300 bg-emerald-50 text-emerald-900", icon: CheckCircle2 },
  category_related: { label: "大类相关，细分待确认", tone: "border-amber-300 bg-amber-50 text-amber-900", icon: AlertTriangle },
  possible_mismatch: { label: "范围可能不一致", tone: "border-rose-300 bg-rose-50 text-rose-900", icon: AlertTriangle },
  unknown: { label: "无法判断范围", tone: "border-slate-300 bg-slate-50 text-slate-700", icon: HelpCircle },
};

function formatValue(metric: Metric): string {
  if (metric.value === null) return "暂无数据";
  if (metric.unit === "currency") return `$${metric.value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (metric.unit === "percent") return `${metric.value.toFixed(1)}%`;
  if (metric.unit === "rating") return metric.value.toFixed(2);
  return metric.value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * 02 市场研究 · 类目市场观察。
 *
 * 只展示 SellerSprite 类目级第三方估算，不参与本页样本指标计算；
 * 绑定必须由用户显式选择；若来源批次商品类目与所选类目没有交集（或无法证明相关），
 * 必须由用户勾选确认范围差异后才能绑定。
 */
export function CategoryMarketEvidencePanel({
  scanId,
  resourceVersion,
  onBound,
}: {
  scanId: string;
  resourceVersion: string;
  onBound?: (next: unknown) => void;
}) {
  const [view, setView] = useState<View | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [scopeAcknowledged, setScopeAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/market-analysis/${encodeURIComponent(scanId)}/category-evidence`, { cache: "no-store" });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? payload?.message ?? `读取失败（HTTP ${res.status}）`);
      setView(payload?.data ?? payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取类目市场证据失败。");
    } finally {
      setLoading(false);
    }
  }, [scanId]);

  useEffect(() => { void load(); }, [load]);

  const bind = useCallback(async (subjectKey: string | null, acknowledgeScopeWarning: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/market-analysis/${encodeURIComponent(scanId)}/category-evidence`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `category-evidence:${scanId}:${subjectKey ?? "unbind"}:${Date.now()}`,
        },
        body: JSON.stringify({ subjectKey, acknowledgeScopeWarning, expectedVersion: resourceVersion }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? payload?.message ?? `保存失败（HTTP ${res.status}）`);
      setSelected("");
      setScopeAcknowledged(false);
      await load();
      onBound?.(payload?.data ?? payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存类目市场证据绑定失败。");
    } finally {
      setBusy(false);
    }
  }, [load, onBound, resourceVersion, scanId]);

  const linked = view?.linked ?? null;
  const options = useMemo(() => view?.available ?? [], [view]);
  const selectedSummary = options.find((item) => item.subjectKey === selected) ?? null;
  const selectedAssessment = selected ? view?.availableScopeAssessments?.[selected] ?? null : null;
  const linkedAssessment = view?.scopeAssessment ?? null;
  // 只有「细分范围匹配」才允许直接绑定；其余三种都要求人工确认范围差异。
  const needsScopeConfirmation = Boolean(selectedAssessment && selectedAssessment.level !== "range_matched");

  // 本批次所有细分段都缺的展示指标：明确告诉用户是「该批次未提供」，而不是我们没算。
  const missingColumns = useMemo(() => {
    if (!linked) return [] as string[];
    const columns = [
      { key: "sampleProductCount", label: "样本商品数" },
      { key: "monthlyTotalSales", label: "月总销量" },
      { key: "averagePriceUsd", label: "平均售价" },
      { key: "averageRating", label: "平均评分" },
      { key: "productConcentrationPercent", label: "商品集中度" },
    ];
    return columns
      .filter((column) => linked.rows.every((row) => !row.metrics.some((metric) => metric.key === column.key)))
      .map((column) => column.label);
  }, [linked]);

  return (
    <section
      id="category-market-evidence-section"
      aria-label="类目市场观察"
      data-testid="category-market-evidence"
      className="rounded-2xl border border-violet-200 bg-violet-50/40 p-5 shadow-xs"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
            <Layers className="size-5 text-violet-600" />
            类目市场观察
            <span className="text-sm font-medium text-slate-400">类目市场依据</span>
          </h2>
          <p className="mt-1 max-w-3xl text-[15px] leading-7 text-slate-600">
            来自 SellerSprite 的类目级第三方估算。它独立于本页商品样本统计，只作为市场参考，不参与任何商品事实或样本指标计算。
          </p>
        </div>
        {linked ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void bind(null, false)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Unlink className="size-4" />}
            解除绑定
          </button>
        ) : null}
      </div>

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-[15px] text-slate-500">
          <Loader2 className="size-4 animate-spin" /> 正在读取类目市场证据…
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[15px] text-rose-900" role="alert">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {!loading && view ? (
        <div className="mt-4 space-y-4">
          <p className="rounded-xl border border-violet-200/70 bg-white px-4 py-2.5 text-[15px] leading-6 text-slate-600">
            {view.notice}
          </p>

          {linked ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="text-sm font-medium text-slate-500">类目</div>
                  <div className="mt-1 text-[15px] font-semibold text-slate-900">{linked.label || "未命名类目"}</div>
                  <div className="mt-1 text-[13px] text-slate-400">节点 {linked.nodeId} · 站点 {linked.marketplace}</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="text-sm font-medium text-slate-500">采集时间</div>
                  <div className="mt-1 text-[15px] font-semibold text-slate-900">{formatDate(linked.capturedAt)}</div>
                  <div className="mt-1 text-[13px] text-slate-400">
                    {linked.ageDays === null ? "时效未知" : `距今 ${linked.ageDays} 天`}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="text-sm font-medium text-slate-500">来源</div>
                  <div className="mt-1 text-[15px] font-semibold text-slate-900">{linked.sourceProvider}</div>
                  <div className="mt-1 text-[13px] text-slate-400">第三方估算 · 非 Amazon 确认</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="text-sm font-medium text-slate-500">类目商品数（估算）</div>
                  <div className="mt-1 text-[15px] font-semibold text-slate-900">
                    {linked.providerProductCount === null ? "暂无数据" : linked.providerProductCount.toLocaleString("en-US")}
                  </div>
                  <div className="mt-1 text-[13px] text-slate-400">共 {linked.rowCount} 个细分段</div>
                </div>
              </div>

              {linkedAssessment ? (
                <div
                  className={`rounded-xl border px-4 py-3 text-[14px] leading-6 ${SCOPE_META[linkedAssessment.level].tone}`}
                  data-testid="category-evidence-scope"
                >
                  <p className="flex items-center gap-1.5 font-semibold">
                    {(() => {
                      const Icon = SCOPE_META[linkedAssessment.level].icon;
                      return <Icon className="size-4" />;
                    })()}
                    与当前研究的范围关系：{SCOPE_META[linkedAssessment.level].label}
                  </p>
                  <p className="mt-1">{linkedAssessment.reason}</p>
                  {linkedAssessment.segments.length > 0 ? (
                    <ul className="mt-2 space-y-0.5 text-[13px]">
                      {linkedAssessment.segments.map((segment) => (
                        <li key={segment.segment} className="opacity-90">
                          · 「{segment.segment}」：{segment.matchedSampleCount}/{segment.sampleTotal} 款样本标题命中（仅相关性提示）
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="mt-1 text-[13px] opacity-80">
                    该判断只使用「来源批次的结构化类目路径与类目事实」与「所选类目路径」比对，标题命中率仅作相关性提示，不能证明同一细分市场。
                    只有「{SCOPE_META.range_matched.label}」才表示已有结构化细分类目证据；其余三种都需人工确认。
                  </p>
                </div>
              ) : null}

              {linked.hasAnomalousMetrics ? (
                <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-[14px] leading-6 text-rose-900" data-testid="category-evidence-anomaly">
                  本批次存在超出字段合理范围的数值（例如百分比不在 0–100）。这些值会保留原始数值与来源引用供追溯，
                  但已标记为<strong>不可用于指标计算</strong>，系统不会用它们做汇总、排序或研究结论。
                </p>
              ) : null}

              <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                <table className="w-full min-w-[720px] border-collapse text-left text-[15px]">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-sm font-semibold text-slate-600">
                      <th className="px-3 py-2.5">细分段</th>
                      <th className="px-3 py-2.5">样本商品</th>
                      <th className="px-3 py-2.5">月总销量（估算）</th>
                      <th className="px-3 py-2.5">平均售价</th>
                      <th className="px-3 py-2.5">平均评分</th>
                      <th className="px-3 py-2.5">商品集中度</th>
                    </tr>
                  </thead>
                  <tbody>
                    {linked.rows.map((row, index) => {
                      const pick = (key: string) => row.metrics.find((metric) => metric.key === key) ?? null;
                      const cell = (key: string) => {
                        const metric = pick(key);
                        if (!metric) return <span className="text-slate-400">暂无数据</span>;
                        const text = formatValue(metric);
                        if (!metric.usableForMetrics) {
                          return (
                            <span className="font-medium text-rose-700" title={metric.anomaly === "out_of_range_percent" ? "百分比超出 0–100% 合理范围，不可用于指标计算" : "数值为负，不可用于指标计算"}>
                              {text}
                              <span className="ml-1 text-[12px]">（来源值异常）</span>
                            </span>
                          );
                        }
                        return <span className="text-slate-700">{text}</span>;
                      };
                      return (
                        <tr key={`${row.segment}-${index}`} className="border-b border-slate-100 last:border-0">
                          <td className="px-3 py-2.5 font-medium text-slate-800">{row.segment || "未标注细分段"}</td>
                          <td className="px-3 py-2.5">{cell("sampleProductCount")}</td>
                          <td className="px-3 py-2.5">{cell("monthlyTotalSales")}</td>
                          <td className="px-3 py-2.5">{cell("averagePriceUsd")}</td>
                          <td className="px-3 py-2.5">{cell("averageRating")}</td>
                          <td className="px-3 py-2.5">{cell("productConcentrationPercent")}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {missingColumns.length > 0 ? (
                <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-[14px] leading-6 text-amber-900">
                  本批次未提供：{missingColumns.join("、")}。这些列在采集时就缺失，系统保持「暂无数据」，不推算、不补 0。
                </p>
              ) : null}

              <p className="text-[13px] leading-6 text-slate-500">
                证据主体 <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[12px]">{linked.subjectKey}</code>；
                批次 {linked.batchId}。以上数值均为 SellerSprite 估算，缺失项保持「暂无数据」，不补 0、不换算。
              </p>
            </>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              {options.length === 0 ? (
                <p className="text-[15px] leading-7 text-slate-600">
                  证据库中还没有可绑定的类目市场证据。请到 <span className="font-semibold">01 市场采集 → 类目市场</span> 采集类目指标后再回来绑定。
                </p>
              ) : (
                <div className="space-y-3">
                  <label htmlFor="category-evidence-select" className="block text-[15px] font-semibold text-slate-800">
                    选择要绑定的类目市场证据
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <select
                      id="category-evidence-select"
                      value={selected}
                      onChange={(event) => { setSelected(event.target.value); setScopeAcknowledged(false); }}
                      className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-[15px] text-slate-800"
                    >
                      <option value="">请选择已采集的类目证据…</option>
                      {options.map((item) => (
                        <option key={item.subjectKey} value={item.subjectKey}>
                          {item.label}（{item.nodeId}）· {formatDate(item.capturedAt)}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={busy || !selected || (needsScopeConfirmation && !scopeAcknowledged)}
                      onClick={() => void bind(selected, scopeAcknowledged)}
                      className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-[15px] font-semibold text-white shadow-sm hover:bg-violet-500 disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
                      绑定到此研究
                    </button>
                  </div>

                  {selectedSummary ? (
                    <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-[14px] leading-6 text-slate-700">
                      <p className="font-semibold text-slate-900">绑定前请核对</p>
                      <p className="mt-1">
                        类目：{selectedSummary.label} · 节点 {selectedSummary.nodeId} · 站点 {selectedSummary.marketplace}；
                        采集于 {formatDate(selectedSummary.capturedAt)}；来源 SellerSprite；
                        共 {selectedSummary.rowCount} 个细分段。
                      </p>
                      <p className="mt-1 text-slate-500">绑定只影响本页展示，不改变样本快照与统计口径。</p>
                    </div>
                  ) : null}

                  {selectedAssessment ? (
                    <div className={`rounded-xl border px-4 py-3 text-[14px] leading-6 ${SCOPE_META[selectedAssessment.level].tone}`}>
                      <p className="flex items-center gap-1.5 font-semibold">
                        {(() => {
                          const Icon = SCOPE_META[selectedAssessment.level].icon;
                          return <Icon className="size-4" />;
                        })()}
                        范围评估：{SCOPE_META[selectedAssessment.level].label}
                      </p>
                      <p className="mt-1">{selectedAssessment.reason}</p>
                      {selectedAssessment.segments.length > 0 ? (
                        <ul className="mt-2 space-y-0.5 text-[13px]">
                          {selectedAssessment.segments.map((segment) => (
                            <li key={segment.segment}>
                              · 「{segment.segment}」：{segment.matchedSampleCount}/{segment.sampleTotal} 款样本标题命中（仅相关性提示）
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}

                  {needsScopeConfirmation ? (
                    <label className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-[14px] leading-6 text-amber-950">
                      <input
                        type="checkbox"
                        checked={scopeAcknowledged}
                        onChange={(event) => setScopeAcknowledged(event.target.checked)}
                        className="mt-1 size-4 shrink-0"
                        data-testid="category-evidence-scope-ack"
                      />
                      <span>
                        我已知当前<strong>只有一级类目相交或无法证实细分范围</strong>，仍将该类别作为<strong>参考观察</strong>绑定，
                        不会把它当作本研究的商品事实、需求证据，也不会把这两种不同层级的关系当成同一市场。
                      </span>
                    </label>
                  ) : null}
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
