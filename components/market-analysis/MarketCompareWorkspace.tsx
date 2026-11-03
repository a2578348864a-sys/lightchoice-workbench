"use client";
import { useState, type ReactNode } from "react";
import type { MarketIntelligence, MarketIntelligenceReport, MarketIntelligenceSample } from "@/lib/marketScan/intelligence";
import { ProductImage } from "@/components/source-layer/ProductImage";
import { trustedSampleImageUrl, type SavedRepresentativeItem } from "./MarketResearchReport";
import { MarketProductComparison } from "./MarketProductComparison";
import { MarketHistoryChart } from "./MarketHistoryChart";
import { COMPARISON_FIELDS, DIFFERENCE_LABELS, compareField, comparisonCell, type ComparisonField } from "./marketComparisonPresentation";
import type { EvidenceLookup } from "./MarketReportEvidence";
import { MarketSectionFindings } from "./MarketAreaShell";
import styles from "./MarketCompareWorkspace.module.css";

const number = (n: number | null | undefined) => n == null ? "未知" : n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const asinOf = (subjectKey: string) => subjectKey.split(":").at(-1) ?? subjectKey;
const MATRIX_FIELDS: ComparisonField[] = ["price", "rating", "reviews", "dimensions", "material", "weight"];

/**
 * 02 商品对比区（P1-02 视觉返工）：商品头 + 差异矩阵 + 建议与交接 一体化对比工作区。
 * 临时对比只改变本页事实表；正式代表、市场闸门与商品研究交接沿用原有状态，不在此处写入。
 */
export function MarketCompareWorkspace({
  data,
  stats,
  report,
  lookup,
  comparison,
  comparisonKeys,
  setSlot,
  onClear,
  onBringRepresentatives,
  missingTitleIds,
  busy,
  act,
  comparisonSetChanged,
  savedRepresentatives,
  reportStale,
  onOpenReport,
  onOpenDecision,
}: {
  data: MarketIntelligence;
  stats: NonNullable<MarketIntelligence["statistics"]>;
  report: MarketIntelligenceReport | undefined;
  lookup: EvidenceLookup;
  comparison: MarketIntelligenceSample[];
  comparisonKeys: string[];
  setSlot: (index: number, subjectKey: string) => void;
  onClear: () => void;
  onBringRepresentatives: () => void;
  missingTitleIds: string[];
  busy: boolean;
  act: (action: string, extra?: Record<string, unknown>) => Promise<void>;
  comparisonSetChanged: boolean;
  savedRepresentatives?: SavedRepresentativeItem[];
  reportStale?: boolean;
  onOpenReport: () => void;
  /** 打开「决策与交接」工作区；临时对比本身不写入任何正式状态。 */
  onOpenDecision?: () => void;
}) {
  const [fullOpen, setFullOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const subjects = new Set(stats.subjects);
  const roleNames: Record<string, string> = { benchmark: "标杆竞品", newcomer: "新进入者", pain_point: "痛点样本" };

  return (
    <div className={styles.area}>
      <header className={styles.head}>
        <div className={styles.headMain}>
          <span className={styles.kicker}>商品对比 · 临时 {comparison.length}/3 款</span>
          <h2>商品有哪些差异，值得带进商品研究吗？</h2>
          <p>临时对比只用于核对事实差异，不改变正式样本、已保存代表或商品研究交接。</p>
        </div>
        <div className={styles.headActions}>
          <button type="button" className={styles.ghost} disabled={!comparisonKeys.length} onClick={onBringRepresentatives}>带入当前代表选择</button>
          <button type="button" className={styles.ghost} onClick={onClear}>清空对比</button>
          <button
            type="button"
            className={styles.primary}
            onClick={() => {
              if (onOpenDecision) {
                onOpenDecision();
                return;
              }
              const target = document.getElementById("benchmark-selection-section");
              if (target instanceof HTMLDetailsElement) target.open = true;
              target?.scrollIntoView({ behavior: document.documentElement.dataset.lcCalm === "true" ? "auto" : "smooth", block: "start" });
            }}
          >
            去保存代表并交接商品研究 →
          </button>
        </div>
      </header>

      <div className={styles.stateBar}>
        <span>临时对比 <b>{comparison.length}/3</b></span>
        <span>已保存代表 <b>{savedRepresentatives?.length ?? 0}</b></span>
        <span data-warn={comparisonSetChanged || undefined}>报告对照集合 <b>{report?.comparisonSubjects?.length ? (comparisonSetChanged ? "与当前不同" : "与当前一致") : "未记录"}</b></span>
        <span>正式样本 <b>{stats.sampleCount}</b></span>
      </div>

      <section className={styles.board} aria-label="商品对比工作区">
        <div className={styles.boardHead}>
          {[0, 1, 2].map((index) => {
            const sample = comparison[index];
            const title = sample ? (data.translations?.[`title:${sample.subjectKey}`]?.text ?? sample.title ?? `${sample.brand ?? "品牌未知"} · ${sample.asin}`) : null;
            return (
              <article key={index} className={styles.headCard} data-empty={!sample || undefined}>
                <div className={styles.headImageWrap}>
                  {sample ? (
                    <ProductImage src={trustedSampleImageUrl(data, sample.subjectKey)} alt={`${sample.asin} 商品主图`} className={styles.headImage} placeholderLabel="暂无可信图片" testId={`market-compare-image-${sample.asin}`} />
                  ) : (
                    <span className={styles.headPlaceholder}>槽位 {index + 1} 未选择</span>
                  )}
                </div>
                {sample ? (
                  <>
                    <span className={styles.headBrand}>{sample.brand ?? "品牌未知"}</span>
                    <h3 className={styles.headTitle} title={title ?? undefined}>{title}</h3>
                    <p className={styles.headFacts}>
                      <b>{number(sample.price)}<small>{sample.priceCurrency ?? "币种未知"}</small></b>
                      <em>{number(sample.rating)} 星 · {number(sample.reviewCount)} 评价</em>
                    </p>
                  </>
                ) : <p className={styles.headEmptyNote}>选择一款商品加入对比</p>}
                <label className={styles.slotPick}>
                  <span>槽位 {index + 1}</span>
                  <select value={comparisonKeys[index] ?? ""} onChange={(event) => setSlot(index, event.target.value)} aria-label={`对比槽位 ${index + 1}`}>
                    <option value="">不选择</option>
                    {data.samples.filter((item) => subjects.has(item.subjectKey)).map((item) => (
                      <option key={item.subjectKey} value={item.subjectKey}>
                        {data.translations?.[`title:${item.subjectKey}`]?.text ?? `${item.brand ?? "品牌未知"} · ${item.asin}`}
                      </option>
                    ))}
                  </select>
                </label>
              </article>
            );
          })}
        </div>

        {comparison.length === 0 ? (
          <p className={styles.boardEmpty}>还没有选择对比商品。用上方槽位选择 1–3 款，或从下方代表列表带入。</p>
        ) : (
          <div className={styles.matrixWrap}>
            <table className={styles.matrix} aria-label="商品差异矩阵">
              <thead>
                <tr>
                  <th scope="col">维度</th>
                  {comparison.map((sample) => <th key={sample.subjectKey} scope="col">{sample.asin}</th>)}
                  <th scope="col">差异</th>
                </tr>
              </thead>
              <tbody>
                <tr className={styles.titleRow}>
                  <th scope="row"><b>商品标题</b><small>来源原文，完整显示，不截断</small></th>
                  {comparison.map((sample) => (
                    <td key={sample.subjectKey}>
                      {data.translations?.[`title:${sample.subjectKey}`]?.text ?? sample.title ?? "标题未知"}
                    </td>
                  ))}
                  <td />
                </tr>
                {MATRIX_FIELDS.map((field) => {
                  const state = compareField(data, comparison, field);
                  return (
                    <tr key={field} data-state={state}>
                      <th scope="row">
                        <b>{COMPARISON_FIELDS[field].label}</b>
                        <small>{COMPARISON_FIELDS[field].limit}</small>
                      </th>
                      {comparison.map((sample) => {
                        const cell = comparisonCell(data, sample, field);
                        return (
                          <td key={sample.subjectKey} data-conflict={cell.conflict || undefined}>
                            <span>{cell.display}</span>
                          </td>
                        );
                      })}
                      <td><span className={styles.diffBadge} data-state={state}>{DIFFERENCE_LABELS[state]}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className={styles.boardFoot}>
          <p>
            差异按来源字段逐项比较：标价 5%、评分 0.1 分以内视为接近；套装件数与计价单位未对齐时，标价差不等于性价比。
            未知与来源冲突不参与「不同」判定。
          </p>
          <button type="button" className={styles.ghost} disabled={busy || !data.provider.ready || !missingTitleIds.length} title={!data.provider.ready ? data.provider.message : !missingTitleIds.length ? "当前对比商品的标题均已有缓存译文，无需重复翻译。" : data.provider.message} onClick={() => void act("translate", { targetIds: missingTitleIds })}>
            翻译未译标题（{missingTitleIds.length}）
          </button>
        </div>
      </section>

      {comparisonSetChanged && (
        <p className={styles.warn}>
          当前三款与历史报告不同：当前 {comparison.map((sample) => sample.asin).join("、") || "未选择"}；报告记录 {(report?.comparisonSubjects ?? []).map(asinOf).join("、")}。事实表随选择切换，历史 AI 解释不自动重算。
        </p>
      )}

      <section className={styles.verdict} aria-label="对比结论与证据">
        <article>
          <h3>这一组对比的已存结论</h3>
          {report?.comparisonDifferences?.length ? (
            <ul>
              {report.comparisonDifferences.slice(0, 4).map((item) => (
                <li key={item.dimension}><b>{item.dimension}</b><span>{item.text}</span></li>
              ))}
            </ul>
          ) : (
            <p className={styles.verdictEmpty}>{report ? "这份报告没有记录结构化的对比差异；以左侧矩阵的字段事实为准。" : "还没有已存报告。矩阵是来源字段的直接对照，不是 AI 结论。"}</p>
          )}
        </article>
        <article>
          <h3>临时对比与正式代表是两件事</h3>
          <dl className={styles.handoff}>
            <div>
              <dt>临时对比（本页）</dt>
              <dd>{comparison.length}/3 款 · 只影响本页事实表</dd>
            </div>
            <div>
              <dt>正式代表（已保存）</dt>
              <dd>{savedRepresentatives?.length ?? 0} 款 · 角色与理由来自人工保存</dd>
            </div>
            <div>
              <dt>进入商品研究的条件</dt>
              <dd>市场判断通过 + 已保存代表符合门槛</dd>
            </div>
          </dl>
          <p className={styles.verdictNote}>
            {savedRepresentatives?.length
              ? `已保存 ${savedRepresentatives.slice(0, 3).map((item) => `${item.asin}（${roleNames[item.role] ?? item.role}）`).join("、")}${savedRepresentatives.length > 3 ? " 等" : ""}。角色、理由与商品研究交接在独立工作区完成。`
              : "尚未保存代表；先到「决策与交接」工作区勾选 1–50 款并填写角色与理由。"}
          </p>
          {onOpenDecision ? (
            <button type="button" className={styles.decisionLink} onClick={onOpenDecision}>
              打开「决策与交接」工作区 →
            </button>
          ) : null}
        </article>
      </section>

      <details className={styles.full} onToggle={(event) => setFullOpen(event.currentTarget.open)}>
        <summary>完整事实表（{MATRIX_FIELDS.length} 个维度逐项展开）与历史价格序列</summary>
        {fullOpen && (
          <>
            <MarketProductComparison comparison={comparison} data={data} report={report} />
            <div className={styles.legend}>
              <span>证据引用：</span>
              <small>每行维度只比较来源字段；缺失显示未知，冲突保留并列，不自动选择。</small>
            </div>
          </>
        )}
      </details>

      <details className={styles.full} onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
        <summary>这些商品的历史价格与排名序列</summary>
        {historyOpen && <div className={styles.historyBody}><MarketHistoryChart data={data} subjects={comparison.map((sample) => sample.subjectKey)} /></div>}
      </details>

      <MarketSectionFindings report={report} section="comparison" stale={Boolean(reportStale)} generatedAt={report?.generatedAt} onOpenReport={onOpenReport} />
    </div>
  );
}
