"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, BarChart3, Loader2 } from "lucide-react";

import styles from "./ResearchCompetitorSnapshot.module.css";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import type { DeepResearchComparisonProjection } from "@/lib/research/deepResearchTypes";

function money(value: { amount: number; currency: string } | null): string {
  if (!value) return "—";
  const formatted = Number.isInteger(value.amount) ? value.amount.toFixed(0) : value.amount.toFixed(2);
  return value.currency.toUpperCase() === "USD" ? `$${formatted}` : `${value.currency} ${formatted}`;
}

/**
 * 上游 summary 常以维度名开头（「价格区间 …」「评分 4.6 vs …」），
 * 与前面的维度标签并列时会出现「价格 价格区间」这类重复；这里只去掉重复的词，不改数值与结论。
 */
function trimDimensionPrefix(summary: string, dimension: string): string {
  if (!summary.startsWith(dimension)) return summary;
  // 「价格区间 …」去掉维度名后剩「区间 …」，读起来仍重复，这里连衔接词一起去掉
  const rest = summary.slice(dimension.length).replace(/^[\s：:，,]+/, "").replace(/^(区间|为|约)/, "").trim();
  return rest.length > 0 ? rest : summary;
}

const LEVEL_LABEL: Record<string, { label: string; tone: "ok" | "warn" | "muted" }> = {
  comparable: { label: "可直接比较", tone: "ok" },
  spec_differs: { label: "规格口径不同", tone: "warn" },
  unknown: { label: "缺少关键事实", tone: "muted" },
};

/**
 * 03 证据与机会 · 竞品对照（内嵌快照）。
 *
 * 只复用正式 deep-analysis 投影里的 comparison 段，默认只展示
 * 商品 / 价格 / 包装数量 / 评分与评论 / 可比性；完整字段与限制走统一资料阅读器。
 * 没有代表商品时如实显示空状态，不补造对比。
 */
export function ResearchCompetitorSnapshot({
  taskId,
  onOpenDetail,
}: {
  taskId: string;
  onOpenDetail: () => void;
}) {
  const [comparison, setComparison] = useState<DeepResearchComparisonProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/research/${encodeURIComponent(taskId)}/deep-analysis`, {
        headers: buildAccessHeaders(),
        cache: "no-store",
        signal,
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.ok === false) {
        const code = typeof json?.error?.code === "string" ? json.error.code : "";
        const raw = typeof json?.error?.message === "string" ? json.error.message : "";
        // 来源绑定不完整是正常业务状态：给用户一句能理解的话，不把后端代码直接抛到界面上。
        if (response.status === 409 || /EVIDENCE_MISSING|not ready for research/i.test(`${code} ${raw}`)) {
          throw new Error("该商品的来源绑定还不完整，暂时取不到代表商品对照；补齐来源后这里会自动出现。");
        }
        throw new Error(raw || `读取竞品投影失败 (${response.status})`);
      }
      const payload = (json?.data ?? json) as { comparison?: DeepResearchComparisonProjection };
      setComparison(payload.comparison ?? null);
    } catch (caught) {
      if ((caught as Error)?.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "读取竞品投影失败");
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const rows = comparison?.rows ?? [];
  const differences = comparison?.differences ?? [];
  const limitations = comparison?.limitations ?? [];
  /**
   * 可比性结论只做聚合，不新增判定：直接读每行的 comparability.level / reason。
   * 缺包装数量或价格时一律说「不能直接比价」，不拿标题推断的数量算每件单价。
   */
  const comparableCount = rows.filter((row) => row.comparability.level === "comparable").length;
  const reasons = [...new Set(rows.map((row) => row.comparability.reason).filter(Boolean))];
  const verdict =
    rows.length === 0
      ? ""
      : comparableCount === rows.length
        ? `${rows.length} 个代表商品 · 可直接比价`
        : comparableCount > 0
          ? `${rows.length} 个代表商品 · ${comparableCount} 个可直接比价，其余不可比`
          : `${rows.length} 个代表商品 · 暂不能直接比价${reasons.length === 1 ? `（${reasons[0]}）` : ""}`;

  return (
    <section className={styles.wrap} aria-label="竞品对照" data-testid="competitor-snapshot">
      <header className={styles.head}>
        <div>
          <p className={styles.kicker}>
            <BarChart3 aria-hidden="true" />
            竞品对照 · 代表商品
          </p>
          <h3>哪些能直接比价、哪些规格不同</h3>
        </div>
        <button type="button" className={styles.detailBtn} onClick={onOpenDetail} data-testid="competitor-open-detail">
          完整竞品事实
          <ArrowRight aria-hidden="true" />
        </button>
      </header>

      {loading ? (
        <p className={styles.state}><Loader2 className={styles.spin} aria-hidden="true" />正在读取代表商品…</p>
      ) : error ? (
        <p className={styles.state} data-tone="error">{error}</p>
      ) : !comparison?.representativesSelected || rows.length === 0 ? (
        <p className={styles.state} data-tone="empty">
          还没有选定代表商品（基准商品 / 痛点样本 / 新进入者），因此没有可比的竞品事实。请先在 02 市场研究里选定代表商品并保存。
        </p>
      ) : (
        <>
          <p className={styles.verdict} data-tone={comparableCount > 0 ? "ok" : "muted"} data-testid="competitor-verdict">
            {verdict}
          </p>

          {differences.length > 0 ? (
            <ul className={styles.diffs} data-testid="competitor-differences">
              {differences.slice(0, 3).map((item) => (
                <li key={item.dimension}>
                  <strong>{item.dimension}</strong>
                  <span>{trimDimensionPrefix(item.summary, item.dimension)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.state} data-tone="empty">暂无可比维度上的事实差异；缺失字段不补齐。</p>
          )}

          <details className={styles.fold} data-testid="competitor-full-table">
            <summary>按商品查看完整字段（{rows.length} 个）</summary>
            <div className={styles.foldBody}>
              <div className={styles.tableWrap}>
                <table className={styles.table} data-testid="competitor-snapshot-table">
                  <thead>
                    <tr>
                      <th>代表商品</th>
                      <th>价格</th>
                      <th>包装数量</th>
                      <th>评分 / 评论</th>
                      <th>可比性</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const meta = LEVEL_LABEL[row.comparability.level] ?? LEVEL_LABEL.unknown;
                      return (
                        <tr key={row.asin} data-testid={`competitor-row-${row.asin}`}>
                          <td data-label="代表商品">
                            <strong>{row.roleLabel}</strong>
                            <span className={styles.asin}>{row.asin}</span>
                            {row.title ? <span className={styles.rowTitle}>{row.title}</span> : null}
                          </td>
                          <td data-label="价格">{money(row.price)}</td>
                          <td data-label="包装数量">
                            {row.packCount ? (
                              <span className={styles.stack}>
                                <b>{row.packCount.value} 件</b>
                                <em>标题推断</em>
                              </span>
                            ) : (
                              <span className={styles.stack}>
                                <b data-empty="true">缺失</b>
                                <em>不计每件单价</em>
                              </span>
                            )}
                          </td>
                          <td data-label="评分 / 评论">{row.rating ?? "—"} / {row.reviewCount ?? "—"}</td>
                          <td data-label="可比性">
                            <span className={styles.level} data-tone={meta.tone}>{meta.label}</span>
                            {reasons.length > 1 ? (
                              <span className={styles.levelReason}>{row.comparability.reason}</span>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {limitations.length > 0 ? (
                <div className={styles.limits}>
                  <p className={styles.limitsTitle}>比较限制</p>
                  <ul>
                    {limitations.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </details>
        </>
      )}
    </section>
  );
}
