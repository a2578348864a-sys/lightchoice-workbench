"use client";
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import type { MarketIntelligence, MarketIntelligenceReport, KeywordSignal } from "@/lib/marketScan/intelligence";
import { marketKeywordCategory } from "@/lib/marketScan/intelligence";
import { EvidenceList, type EvidenceLookup } from "./MarketReportEvidence";
import { MarketSectionFindings } from "./MarketAreaShell";
import styles from "./MarketDemandWorkspace.module.css";

const metricNames: Record<string, string> = { searchVolumeGrowth: "月搜索量增长率", spr: "SPR（来源指标）", titleDensity: "标题密度", estimatedMonthlyPurchase: "月购买量估算", trafficShare: "流量占比", searchVolume: "搜索量", monthlySearches: "月搜索量", monthlySales: "月销量估算", organicRank: "自然排名", sponsoredRank: "广告排名", adRank: "广告排名", clickShare: "点击占比", conversionShare: "转化占比", cpc: "每次点击费用", competition: "竞争指标", searchTrend: "搜索趋势", price: "价格", bsr: "BSR排名", reviewCount: "评论量", rating: "评分", estimatedTraffic: "预估流量" };
const natureNames: Record<string, string> = { fact: "来源观察", estimate: "第三方估算", calculation: "数据计算", inference: "AI 推断", unknown: "目前未知", provider_estimate: "第三方估算", provider_observed: "第三方观察", source_observed: "来源观察" };
const number = (n: number | null | undefined) => n == null ? "未知" : n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const time = (value: string) => value.length >= 16 ? `${value.slice(0, 10)} ${value.slice(11, 16)} UTC` : value;
const asinOf = (subjectKey: string) => subjectKey.split(":").at(-1) ?? subjectKey;
const splitKeyword = (raw: string) => {
  const withBadge = raw.match(/^(.+?)\s+AC\s+([\u3400-\u9fff].*)$/u);
  if (withBadge) return { english: withBadge[1].trim(), translation: withBadge[2].trim(), badge: "AC" };
  const bilingual = raw.match(/^([^\u3400-\u9fff]+?)\s+([\u3400-\u9fff].+)$/u);
  if (bilingual) return { english: bilingual[1].trim(), translation: bilingual[2].trim(), badge: null };
  return { english: raw, translation: null, badge: null };
};
const formatMetric = (key: string, metric: { value: number | null; unit: string }) => {
  if (metric.value === null) return "—";
  if (metric.unit === "percent" || metric.unit === "percentage" || metric.unit === "ratio") return `${(metric.value * 100).toFixed(2)}%`;
  if (key === "reviewCount") return `${number(metric.value)} 条`;
  if (key === "bsr" || metric.unit === "rank") return `${number(metric.value)} 名`;
  if (metric.unit === "count" || key === "spr" || key === "titleDensity" || key === "competition") return number(metric.value);
  if (metric.unit === "USD") return `${number(metric.value)} USD`;
  if (metric.unit === "index") return `${number(metric.value)}（指数）`;
  return number(metric.value);
};

type Source = "market" | "competitor";
type SortKey = "keyword" | "primary" | "secondary" | "growth";

/**
 * 02 关键词与需求区（第二次视觉返工）：数据表是主角，右侧解释是辅助。
 * A（种子词查询）与 B（ASIN 反查）严格分开：切换数据源不丢表格上下文，指标不混分母。
 */
export function MarketDemandWorkspace({
  data,
  stats,
  lookup,
  query,
  onQueryChange,
  source,
  onSourceChange,
  onCapture,
  report,
  reportStale,
  onOpenReport,
}: {
  data: MarketIntelligence;
  stats: NonNullable<MarketIntelligence["statistics"]>;
  lookup: EvidenceLookup;
  query: string;
  onQueryChange: (value: string) => void;
  source: Source;
  onSourceChange: (value: Source) => void;
  onCapture: (module: "keyword_mining_trend" | "reverse_asin" | "historical_trend") => void;
  report?: MarketIntelligenceReport;
  reportStale?: boolean;
  onOpenReport: () => void;
}) {
  const [sort, setSort] = useState<SortKey>("primary");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState("");
  const subjects = useMemo(() => new Set(stats.subjects), [stats.subjects]);
  const scoped = useMemo(
    () => data.keywords.filter((keyword) => subjects.has(keyword.subjectKey) || (keyword.subjectKey.startsWith("sellersprite:") && data.queryBindings.includes(keyword.subjectKey))),
    [data.keywords, data.queryBindings, subjects],
  );
  const matches = (keyword: KeywordSignal) => keyword.keyword.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const marketRows = scoped.filter((keyword) => marketKeywordCategory(keyword.module) === "market_keyword_demand" && matches(keyword));
  const competitorRows = scoped.filter((keyword) => marketKeywordCategory(keyword.module) === "competitor_traffic_keyword" && subjects.has(keyword.subjectKey) && matches(keyword));
  const unclassified = scoped.filter((keyword) => marketKeywordCategory(keyword.module) === null);
  const rows = source === "market" ? marketRows : competitorRows;

  const primaryOf = (row: KeywordSignal) => source === "market" ? row.searchVolume : row.metrics.trafficShare?.value ?? null;
  const secondaryOf = (row: KeywordSignal) => source === "market"
    ? row.metrics.estimatedMonthlyPurchase?.value ?? null
    : row.metrics.estimatedTraffic?.value ?? null;
  const growthOf = (row: KeywordSignal) => row.metrics.searchVolumeGrowth?.value ?? null;

  const sorted = useMemo(() => {
    const value = (row: KeywordSignal) => {
      if (sort === "keyword") return splitKeyword(row.keyword).english;
      if (sort === "secondary") return secondaryOf(row) ?? -1;
      if (sort === "growth") return growthOf(row) ?? -1;
      return primaryOf(row) ?? -1;
    };
    return [...rows].sort((a, b) => {
      const av = value(a), bv = value(b);
      if (typeof av === "string" || typeof bv === "string") return dir === "asc" ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
      return dir === "asc" ? av - bv : bv - av;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort, dir, source]);

  const active = sorted.find((row) => row.keyword === selected);
  const label = active ? splitKeyword(active.keyword) : null;
  const rank = active ? sorted.findIndex((row) => row.keyword === active.keyword) + 1 : 0;
  const activeSecondary = active ? Object.entries(active.metrics).filter(([key]) => {
    if (source === "market") return !["searchVolume", "monthlySearches", "estimatedMonthlyPurchase", "searchVolumeGrowth"].includes(key);
    return !["trafficShare", "estimatedTraffic", "organicRank", "adRank", "sponsoredRank", "searchVolume", "monthlySearches"].includes(key);
  }).slice(0, 4) : [];

  const toggleSort = (key: SortKey) => {
    if (sort === key) setDir((current) => current === "desc" ? "asc" : "desc");
    else { setSort(key); setDir(key === "keyword" ? "asc" : "desc"); }
  };
  const sortIcon = (key: SortKey) => sort === key ? (dir === "desc" ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />) : null;

  const groupName = source === "market" ? "市场关键词需求" : "竞品流量关键词";
  const primaryName = source === "market" ? "月搜索量估算" : "流量占比";
  const secondaryName = source === "market" ? "月购买次数" : "预估流量";

  return (
    <div className={styles.area}>
      <header className={styles.head}>
        <div className={styles.headMain}>
          <span className={styles.kicker}>需求与流量 · 第三方估算</span>
          <h2>需求有多大，流量从哪里来？</h2>
          <p>
            市场关键词（种子词查询）与竞品流量词（ASIN 反查）是两类数据集：分开统计、不相加、不共用分母。
            SellerSprite 估算不等于销量或市场规模。
          </p>
        </div>
        <div className={styles.sourceSwitch} role="group" aria-label="切换关键词数据集">
          <button type="button" aria-pressed={source === "market"} onClick={() => { onSourceChange("market"); setSelected(""); }}>
            市场关键词需求 <em>{stats.keywords.market.rows}</em>
          </button>
          <button type="button" aria-pressed={source === "competitor"} onClick={() => { onSourceChange("competitor"); setSelected(""); }}>
            竞品流量关键词 <em>{stats.keywords.competitorTraffic.rows}</em>
          </button>
        </div>
      </header>

      <section className={styles.tableCard} aria-label={`${groupName}数据表`}>
        <header className={styles.tableHead}>
          <div>
            <h3>{groupName}</h3>
            <p>
              {source === "market" ? `以研究关键词「${data.research?.keyword ?? "未绑定"}」为查询对象。` : "以正式样本内的 ASIN 为查询对象，只描述该 ASIN 的流量结构。"}
              共 {rows.length} 行；缺失指标显示「—」，不补 0。
            </p>
          </div>
          <div className={styles.tableTools}>
            <label className={styles.search}>
              <Search size={14} aria-hidden="true" />
              <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索关键词…" aria-label="筛选关键词" />
            </label>
            <span className={styles.count}>{sorted.length} 行</span>
          </div>
        </header>

        <div className={styles.tableWrap}>
          <table className={styles.table} aria-label={source === "market" ? "市场关键词需求" : "竞品流量关键词"}>
            <thead>
              <tr>
                <th scope="col" aria-sort={sort === "keyword" ? (dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("keyword")}>关键词 {sortIcon("keyword")}</button>
                </th>
                <th scope="col" aria-sort={sort === "primary" ? (dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("primary")}>{primaryName} {sortIcon("primary")}</button>
                </th>
                <th scope="col" aria-sort={sort === "secondary" ? (dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("secondary")}>{secondaryName} {sortIcon("secondary")}</button>
                </th>
                {source === "market" ? (
                  <th scope="col" aria-sort={sort === "growth" ? (dir === "asc" ? "ascending" : "descending") : "none"}>
                    <button type="button" onClick={() => toggleSort("growth")}>搜索量增长率 {sortIcon("growth")}</button>
                  </th>
                ) : (
                  <>
                    <th scope="col">自然 / 广告排名</th>
                    <th scope="col">月搜索量估算</th>
                  </>
                )}
                <th scope="col">来源 · 时间</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, index) => {
                const text = splitKeyword(row.keyword);
                const organic = row.metrics.organicRank;
                const ad = row.metrics.adRank ?? row.metrics.sponsoredRank;
                return (
                  <tr key={`${row.evidence.id}:${index}`} data-current={row.keyword === selected || undefined}>
                    <th scope="row">
                      <button type="button" className={styles.keywordBtn} onClick={() => setSelected(row.keyword === selected ? "" : row.keyword)} aria-pressed={row.keyword === selected}>
                        <span className={styles.keywordMain}>
                          <b>{text.translation ?? text.english}</b>
                          {text.badge ? <em>{text.badge}</em> : null}
                        </span>
                        {text.translation ? <small lang="en">{text.english}</small> : null}
                      </button>
                    </th>
                    <td className={styles.num}>{primaryOf(row) == null ? "—" : source === "competitor" ? `${(primaryOf(row)! * 100).toFixed(2)}%` : number(primaryOf(row))}</td>
                    <td className={styles.num}>{secondaryOf(row) == null ? "—" : number(secondaryOf(row))}</td>
                    {source === "market" ? (
                      <td className={styles.num}>{growthOf(row) == null ? "—" : `${(growthOf(row)! * 100).toFixed(2)}%`}</td>
                    ) : (
                      <>
                        <td className={styles.num}>{organic?.value == null && ad?.value == null ? "—" : `${organic?.value == null ? "—" : `自然 ${number(organic.value)}`} / ${ad?.value == null ? "—" : `广告 ${number(ad.value)}`}`}</td>
                        <td className={styles.num}>{row.searchVolume == null ? "—" : number(row.searchVolume)}</td>
                      </>
                    )}
                    <td className={styles.sourceCell}>
                      <span>SellerSprite</span>
                      <small>{row.observedAt ? time(row.observedAt) : "来源未提供数据周期"}</small>
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={source === "market" ? 5 : 6} className={styles.emptyCell}>
                    {query.trim()
                      ? `${source === "market" ? "A" : "B"} 组没有匹配当前筛选的关键词。`
                      : source === "market"
                        ? "还没有以研究关键词为查询对象的可分析关键词行。商品搜索样本只证明取得了商品列表，不能由此推算关键词搜索量。"
                        : "还没有绑定到本研究正式样本 ASIN 的反查流量词。"}
                    <button type="button" onClick={() => { if (query.trim()) onQueryChange(""); else onCapture(source === "market" ? "keyword_mining_trend" : "reverse_asin"); }}>
                      {query.trim() ? "清除筛选" : source === "market" ? "挖掘种子关键词" : "反查竞品流量词"}
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.explain} data-empty={!active || undefined} aria-label="选中关键词解释">
        {active && label ? (
          <>
            <header className={styles.explainHead}>
              <div>
                <span className={styles.explainKicker}>当前选中 · {groupName}</span>
                <h3>{label.translation ?? label.english}</h3>
                {label.translation ? <p lang="en">{label.english}</p> : null}
              </div>
              <span className={styles.rankChip}>组内第 {rank} / {sorted.length}</span>
            </header>

            <div className={styles.explainBody}>
              <div className={styles.meaningCol}>
                <b data-tone="can">能说明</b>
                <p>{source === "market" ? "这个查询词在来源观察时的搜索量级与增长率估算，可作为需求方向的线索。" : "这个 ASIN 的流量词结构与占比，可说明它靠什么词获得曝光。"}</p>
              </div>
              <div className={styles.meaningCol}>
                <b data-tone="cannot">不能说明</b>
                <p>{source === "market" ? "不等于实际销量或市场规模；不同关键词搜索量不能相加。" : "不代表整个市场；单个 ASIN 的流量结构不能外推到其他商品。"}</p>
              </div>
              <div className={styles.metricsCol}>
                {activeSecondary.length ? (
                  <ul className={styles.extraMetrics}>
                    {activeSecondary.map(([key, metric]) => (
                      <li key={key}>
                        <span>{metricNames[key] ?? key}</span>
                        <b>{formatMetric(key, metric)}</b>
                        <small>{natureNames[metric.metricNature] ?? metric.metricNature}</small>
                      </li>
                    ))}
                  </ul>
                ) : <p className={styles.explainEmpty}>这一行只有主指标，没有其他可用指标。</p>}
                <details className={styles.evidence}>
                  <summary>依据：主体、版本与证据</summary>
                  <p>
                    来源：SellerSprite · 站点：{data.marketplace} · 主体：
                    {source === "market"
                      ? active.subjectKey.startsWith("sellersprite:") ? "查询级（种子关键词）" : `${asinOf(active.subjectKey)}（商品级旧证据）`
                      : `${asinOf(active.subjectKey)}（ASIN 反查）`}
                  </p>
                  <p>
                    证据版本：{active.evidence.version === null ? "未编号版本" : `v${active.evidence.version}`} · {active.evidence.contentHash.slice(0, 12)} · 采集：{time(active.evidence.capturedAt)}
                  </p>
                  <EvidenceList ids={[active.evidence.id]} data={data} lookup={lookup} supports={`${label.english} 的${source === "market" ? "需求指标" : "流量词"}`} />
                </details>
              </div>
            </div>
          </>
        ) : (
          <p className={styles.explainEmpty}>
            点表格里任意关键词，这里显示它的估算性质、能说明与不能说明，以及证据主体；不选也不影响表格阅读。
          </p>
        )}
      </section>

      <section className={styles.notes} aria-label="口径与补证">
        <div className={styles.notesMain}>
          <h3>两类分母为什么不能相加</h3>
          <p>
            A 以研究关键词为查询对象，B 以明确 ASIN 为查询对象；两组不相加、不共用分母。
            {unclassified.length ? `另有 ${unclassified.length} 行来源模块未登记，不计入任一分组。` : ""}
          </p>
        </div>
        <dl className={styles.notesCounts}>
          <div><dt>A 市场关键词</dt><dd>{stats.keywords.market.rows} 行 · 有搜索量 {stats.keywords.market.withSearchVolume}</dd></div>
          <div><dt>B 竞品流量词</dt><dd>{stats.keywords.competitorTraffic.rows} 行 · 有流量占比 {stats.keywords.competitorTraffic.withTrafficShare}</dd></div>
        </dl>
        <div className={styles.notesActions}>
          <div className={styles.captureLinks}>
            <button type="button" onClick={() => onCapture("keyword_mining_trend")}>挖掘种子关键词</button>
            <button type="button" onClick={() => onCapture("reverse_asin")}>反查竞品流量词</button>
            <button type="button" onClick={() => onCapture("historical_trend")}>商品历史趋势</button>
          </div>
          <small>这些入口只打开补证任务，不会直接采集。</small>
        </div>
      </section>

      <MarketSectionFindings report={report} section="demand" stale={Boolean(reportStale)} generatedAt={report?.generatedAt} onOpenReport={onOpenReport} />
    </div>
  );
}
