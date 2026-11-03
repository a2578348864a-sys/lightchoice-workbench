"use client";

import { useMemo } from "react";
import type { MarketCitation, MarketIntelligence, MarketIntelligenceSample, KeywordSignal, SupplementarySource } from "@/lib/marketScan/intelligence";
import styles from "./MarketIntelligencePanel.module.css";

export type EvidenceHit =
  | { kind: "review"; review: MarketIntelligence["reviews"][number] }
  | { kind: "sample"; sample: MarketIntelligenceSample; role: "locked" | "brand" }
  | { kind: "keyword"; row: KeywordSignal }
  | { kind: "source"; source: SupplementarySource }
  | { kind: "signal"; signal: MarketIntelligence["productSignals"][number] }
  | { kind: "trend"; trend: MarketIntelligence["trends"][number] }
  | { kind: "detail"; detail: NonNullable<MarketIntelligence["productDetails"]>[number] }
  | { kind: "category"; category: NonNullable<MarketIntelligence["category"]> };

export type EvidenceLookup = Map<string, EvidenceHit[]>;

const number = (value: number | null | undefined) => value === null || value === undefined ? "未知" : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const time = (value: string) => value.length >= 16 ? `${value.slice(0, 10)} ${value.slice(11, 16)} UTC` : value;
const asinOf = (subjectKey: string) => subjectKey.split(":").at(-1) ?? subjectKey;
const natureName: Record<string, string> = { source_observed: "来源观察", provider_estimate: "第三方估算", provider_observed: "第三方观察", review_observation: "评论观察", calculation: "数据计算", inference: "AI 推断", unknown: "来源性质未知" };
const moduleName: Record<string, string> = { review_voc: "买家声音", keyword_mining_trend: "关键词挖掘", reverse_asin: "反查 ASIN", sellersprite_product_market: "商品与市场深度", historical_trend: "历史趋势", variation: "变体结构" };
const limitationName: Record<string, string> = {
  visible_dom_window_only: "仅采集当前可见页面窗口数据",
  visible_rows_are_not_total_rows: "当前可见行数不代表全量行数",
  public_top_reviews_only: "仅包含公开展示的前排评论子集，不代表全部评论",
  single_snapshot_not_time_series: "单次快照观察，不构成历史时间序列",
};
const formatLimitation = (limit: string) => limitationName[limit] ?? limit;

/** Build a human-readable index from the same saved evidence that the report cites. */
export function buildEvidenceLookup(data: MarketIntelligence): EvidenceLookup {
  const lookup: EvidenceLookup = new Map();
  const add = (id: string | undefined, hit: EvidenceHit) => {
    if (!id) return;
    const current = lookup.get(id) ?? [];
    current.push(hit);
    lookup.set(id, current);
  };
  for (const sample of data.samples) {
    add(sample.evidence.id, { kind: "sample", sample, role: "locked" });
    add(sample.brandEvidence?.id, { kind: "sample", sample, role: "brand" });
  }
  for (const review of data.reviews) add(review.evidence.id, { kind: "review", review });
  for (const row of data.keywords) add(row.evidence.id, { kind: "keyword", row });
  for (const source of data.sources) add(source.evidence.id, { kind: "source", source });
  for (const signal of data.productSignals) add(signal.evidence.id, { kind: "signal", signal });
  for (const trend of data.trends) add(trend.evidence.id, { kind: "trend", trend });
  for (const detail of data.productDetails ?? []) {
    for (const citation of detail.supplementalEvidence ?? []) add(citation.id, { kind: "detail", detail });
  }
  if (data.category) add(data.category.evidence.id, { kind: "category", category: data.category });
  return lookup;
}

function Translation({ review, data }: { review: MarketIntelligence["reviews"][number]; data: MarketIntelligence }) {
  const translated = review.id ? data.translations?.[`review:${review.id}`] : undefined;
  return translated
    ? <><p className={styles.evidenceText}>{translated.text}</p><small>中文译文 · {translated.model} · 与 AI 摘要分开标记</small><details><summary>查看英文原文</summary><p lang="en" className={styles.evidenceText}>{review.title ? `${review.title}\n` : ""}{review.text}</p></details></>
    : <><small>尚无缓存译文 · 原文如下（可在买家声音区主动翻译）</small><p lang="en" className={styles.evidenceText}>{review.title ? `${review.title}\n` : ""}{review.text}</p></>;
}

function ReviewEvidence({ review, data }: { review: MarketIntelligence["reviews"][number]; data: MarketIntelligence }) {
  const subjects = review.subjectKeys ?? [review.subjectKey];
  return <div className={styles.evidenceCard}>
    <div className={styles.evidenceHead}><strong>评论证据 · {review.rating ?? "未评分"} 星</strong><span>{subjects.map(asinOf).join("、")}</span></div>
    <Translation review={review} data={data} />
    <p className={styles.evidenceLimit}>能支持：这条评论直接表达的内容。不能支持：其他买家或全体买家的发生率；本次输入是低星优先的非随机子集。</p>
    <details className={styles.tech}><summary>来源与时间</summary><p>评论 ID：{review.id ?? "未提供"} · 观察时间：{time(review.evidence.capturedAt)} · 性质：{natureName[review.evidence.nature] ?? review.evidence.nature}</p><p>证据版本：{review.evidence.id}</p>{review.evidence.sourceUrl && <a href={review.evidence.sourceUrl} target="_blank" rel="noreferrer">打开来源</a>}</details>
  </div>;
}

function SampleEvidence({ sample, role, data }: { sample: MarketIntelligenceSample; role: "locked" | "brand"; data: MarketIntelligence }) {
  const translated = data.translations?.[`title:${sample.subjectKey}`];
  const detail = data.productDetails?.find((entry) => entry.subjectKey === sample.subjectKey)?.facts;
  return <div className={styles.evidenceCard}>
    <div className={styles.evidenceHead}><strong>{role === "brand" ? "品牌证据" : "商品锁定观察"} · {sample.asin}</strong><span>{sample.brand ? `品牌 ${sample.brand}` : "品牌未知"}</span></div>
    <p className={styles.evidenceText}>{translated?.text ?? sample.title ?? "标题未提供"}</p>
    {translated && <details><summary>查看英文原标题</summary><p lang="en">{sample.title}</p></details>}
    <div className={styles.evidenceGrid}>
      <span>价格</span><b>{number(sample.price)} {sample.priceCurrency ?? "币种未知"}</b>
      <span>评分</span><b>{number(sample.rating)} / 5</b>
      <span>评论量</span><b>{number(sample.reviewCount)} 条</b>
      <span>BSR</span><b>{number(sample.bsr ?? detail?.bsr ?? null)}</b>
    </div>
    <p className={styles.evidenceLimit}>能支持：该商品在锁定版本中的字段观察。不能支持：全市场份额、销量或最新状态；缺失字段保持未知。</p>
    <details className={styles.tech}><summary>来源与时间</summary><p>观察时间：{time(sample.evidence.capturedAt)} · 性质：{natureName[sample.evidence.nature] ?? sample.evidence.nature} · 版本：{sample.evidence.version ?? "不可变附件"}</p><p>证据版本：{sample.evidence.id}</p>{sample.evidence.sourceUrl && <a href={sample.evidence.sourceUrl} target="_blank" rel="noreferrer">打开来源</a>}</details>
  </div>;
}

function KeywordEvidence({ rows, data }: { rows: KeywordSignal[]; data: MarketIntelligence }) {
  const shown = rows.slice(0, 3);
  return <div className={styles.evidenceCard}>
    <div className={styles.evidenceHead}><strong>关键词证据 · {rows.length} 行</strong><span>{rows[0]?.subjectKey.startsWith("sellersprite:") ? "已绑定的查询证据" : "商品/查询级来源"}</span></div>
    <div className={styles.miniTable}>
      {shown.map((row) => {
        const growth = row.metrics.searchVolumeGrowth;
        return <div key={`${row.keyword}:${row.evidence.id}`} className={styles.miniRow}>
          <b>{row.keyword}</b>
          <span>搜索量 {number(row.searchVolume)}</span>
          <span>增长率 {growth?.value === null || growth?.value === undefined ? "未知" : `${(growth.value * 100).toFixed(2)}%`}</span>
        </div>;
      })}
    </div>
    <p className={styles.evidenceLimit}>能支持：该来源在观察时的第三方估算。不能支持：Amazon 确认销量、市场规模或长期趋势；不同关键词搜索量不能相加。</p>
    <details className={styles.tech}><summary>来源与时间</summary>{shown.map((row, index) => <p key={`${row.evidence.id}:${row.keyword}:${index}`}>{row.keyword} · {row.subjectKey} · {time(row.evidence.capturedAt)} · {row.evidence.id}</p>)}{shown[0]?.evidence.sourceUrl && <a href={shown[0].evidence.sourceUrl} target="_blank" rel="noreferrer">打开来源</a>}</details>
  </div>;
}

function SourceEvidence({ source }: { source: SupplementarySource }) {
  return <div className={styles.evidenceCard}>
    <div className={styles.evidenceHead}><strong>{source.label} · {source.status === "available" ? "可用" : source.status === "partial" ? "部分可用" : source.status === "blocked" ? "来源受限" : "不可用"}</strong><span>{source.scope === "query" ? "查询级" : "商品级"}</span></div>
    <p className={styles.evidenceText}>{source.reason}</p>
    {source.limitations.map((limit) => <p key={limit} className={styles.evidenceLimit}>{formatLimitation(limit)}</p>)}
    <details className={styles.tech}><summary>来源与时间</summary><p>{source.subjectKey} · {time(source.evidence.capturedAt)} · {natureName[source.evidence.nature] ?? source.evidence.nature}</p><p>证据版本：{source.evidence.id}</p>{source.evidence.sourceUrl && <a href={source.evidence.sourceUrl} target="_blank" rel="noreferrer">打开来源</a>}</details>
  </div>;
}

/** First layer is readable content; internal ids stay inside a further disclosure. */
export function EvidenceList({ ids, data, lookup, supports, limits }: { ids: string[]; data: MarketIntelligence; lookup: EvidenceLookup; supports?: string; limits?: string[] }) {
  const resolved = useMemo(() => ids.map((id) => ({ id, hits: lookup.get(id) ?? [] })), [ids, lookup]);
  if (!ids.length) return <p className={styles.note}>该结论未引用证据，按“证据不足”处理。</p>;
  return <div className={styles.evidenceList}>
    {supports && <p className={styles.evidencePurpose}>用于支持：{supports}</p>}
    {limits?.length ? <p className={styles.evidenceLimit}>结论限制：{limits.join("；")}</p> : null}
    {resolved.map(({ id, hits }) => {
      const reviews = hits.filter((hit): hit is Extract<EvidenceHit, { kind: "review" }> => hit.kind === "review").map((hit) => hit.review);
      const samples = hits.filter((hit): hit is Extract<EvidenceHit, { kind: "sample" }> => hit.kind === "sample");
      const keywords = hits.filter((hit): hit is Extract<EvidenceHit, { kind: "keyword" }> => hit.kind === "keyword");
      const sources = hits.filter((hit): hit is Extract<EvidenceHit, { kind: "source" }> => hit.kind === "source");
      const signals = hits.filter((hit): hit is Extract<EvidenceHit, { kind: "signal" }> => hit.kind === "signal");
      const trends = hits.filter((hit): hit is Extract<EvidenceHit, { kind: "trend" }> => hit.kind === "trend");
      const details = hits.filter((hit): hit is Extract<EvidenceHit, { kind: "detail" }> => hit.kind === "detail");
      const categories = hits.filter((hit): hit is Extract<EvidenceHit, { kind: "category" }> => hit.kind === "category");
      const hasReadable = reviews.length || samples.length || keywords.length || sources.length || signals.length || trends.length || details.length || categories.length;
      return <div key={id} className={styles.evidenceGroup}>
        {reviews.length ? <>{reviews.sort((a, b) => (a.rating ?? 6) - (b.rating ?? 6)).slice(0, 2).map((review) => <ReviewEvidence key={review.id ?? `${id}:${review.text.slice(0, 20)}`} review={review} data={data} />)}{reviews.length > 2 && <p className={styles.note}>同一附件共有 {reviews.length} 条评论观察；这里展示低星优先的 2 条，其余可在买家声音区核对。</p>}</> : null}
        {samples.map((hit) => <SampleEvidence key={`${hit.sample.subjectKey}:${hit.role}`} sample={hit.sample} role={hit.role} data={data} />)}
        {keywords.length ? <KeywordEvidence rows={keywords.map((hit) => hit.row)} data={data} /> : null}
        {!reviews.length && !keywords.length && sources.map((hit) => <SourceEvidence key={`${hit.source.module}:${hit.source.evidence.id}:${hit.source.subjectKey}`} source={hit.source} />)}
        {signals.map((hit) => <div key={hit.signal.evidence.id} className={styles.evidenceCard}>
          <div className={styles.evidenceHead}><strong>第三方商品观察</strong><span>{asinOf(hit.signal.subjectKey)}</span></div>
          <p className={styles.evidenceText}>{hit.signal.metrics.map((metric) => `${metric.metric}：${number(metric.value)}${metric.currency ? ` ${metric.currency}` : ""}（${natureName[metric.metricNature] ?? metric.metricNature}）`).join(" · ")}</p>
          <p className={styles.evidenceLimit}>能支持：该第三方页面在观察时的展示值。不能支持：Amazon 确认事实；与其他来源冲突时需并列阅读。</p>
          <details className={styles.tech}><summary>来源与时间</summary><p>{time(hit.signal.evidence.capturedAt)} · {hit.signal.evidence.id}</p>{hit.signal.evidence.sourceUrl && <a href={hit.signal.evidence.sourceUrl} target="_blank" rel="noreferrer">打开来源</a>}</details>
        </div>)}
        {trends.map((hit) => <div key={`${hit.trend.evidence.id}:${hit.trend.field}`} className={styles.evidenceCard}>
          <div className={styles.evidenceHead}><strong>历史数据 · {hit.trend.field}</strong><span>{hit.trend.points.length} 个日期点</span></div>
          <p className={styles.evidenceText}>{hit.trend.field.startsWith("keepa.window.") ? "Keepa 导出窗口统计；导入时间不是历史发生日期。" : "按真实日期序列展示；不同主体与指标分开阅读。"}</p>
          <p className={styles.evidenceLimit}>能支持：该序列在所示日期范围内的变化。不能支持：当前状态或未覆盖的日期；单点不能判断趋势。</p>
          <details className={styles.tech}><summary>来源与时间</summary><p>{time(hit.trend.evidence.capturedAt)} · {hit.trend.evidence.id}</p></details>
        </div>)}
        {details.map((hit) => <div key={`${hit.detail.subjectKey}:${id}`} className={styles.evidenceCard}>
          <div className={styles.evidenceHead}><strong>商品详情补充来源</strong><span>{asinOf(hit.detail.subjectKey)}</span></div>
          <p className={styles.evidenceText}>该商品的规格、材质或卖点来自补充详情附件；具体字段与时间在商品对比区展开。</p>
          <details className={styles.tech}><summary>来源与时间</summary><p>{hit.detail.subjectKey} · {hit.detail.evidence.id}</p>{[hit.detail.evidence, ...(hit.detail.supplementalEvidence ?? [])].map((ref) => <p key={ref.id}>{time(ref.capturedAt)} · {ref.id}</p>)}</details>
        </div>)}
        {categories.map((hit) => <div key={hit.category.evidence.id} className={styles.evidenceCard}>
          <div className={styles.evidenceHead}><strong>市场类目证据</strong><span>{hit.category.rows.length} 个细分</span></div>
          <p className={styles.evidenceText}>类目级第三方估算；不等于商品级事实，也不能替代本研究的正式样本统计。</p>
          <details className={styles.tech}><summary>来源与时间</summary><p>{time(hit.category.capturedAt)} · {hit.category.batchId}</p>{hit.category.sourceUrl && <a href={hit.category.sourceUrl} target="_blank" rel="noreferrer">打开来源</a>}</details>
        </div>)}
        {!hasReadable && <div className={styles.evidenceCard}>
          <div className={styles.evidenceHead}><strong>来源附件</strong><span>当前数据中未找到可读明细</span></div>
          <p className={styles.evidenceText}>该引用对应的来源不在当前读取范围，或只保存了附件索引。结论仍需按报告版本核对。</p>
          <details className={styles.tech}><summary>技术标识</summary><p>{id}</p></details>
        </div>}
      </div>;
    })}
  </div>;
}
