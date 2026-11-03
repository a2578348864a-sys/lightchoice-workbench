"use client";
import { useMemo, useState } from "react";
import { BarChart, Bar, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell, ReferenceLine } from "recharts";
import type { MarketIntelligence, MarketIntelligenceReport, MarketIntelligenceSample } from "@/lib/marketScan/intelligence";
import { ProductImage } from "@/components/source-layer/ProductImage";
import { trustedSampleImageUrl } from "./MarketResearchReport";
import { MarketDistributionChart as Bins } from "./MarketDistributionChart";
import { MarketHistoryChart } from "./MarketHistoryChart";
import { EvidenceList, type EvidenceLookup } from "./MarketReportEvidence";
import { MarketSectionFindings } from "./MarketAreaShell";
import { usePrefersReducedMotion } from "@/components/source/capture-console/usePrefersReducedMotion";
import styles from "./MarketCompetition.module.css";

const number = (v: number | null | undefined) => v == null ? "未知" : v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const time = (v: string | null | undefined) => v ? `${v.slice(0, 10)} ${v.slice(11, 16)} UTC` : "时间未知";
type Detail = NonNullable<MarketIntelligence["productDetails"]>[number];
type ClaimField = "material" | "itemDimensions" | "bulletPoints";
const conflictFor = (d: Detail | undefined, f: ClaimField) => d?.facts.conflicts.some(c => c.field === f || c.field.endsWith(`.${f}`));

export function competitionClaim(d: Detail | undefined, f: ClaimField): string {
  if (conflictFor(d, f)) return "来源冲突，待核实";
  if (!d) return "未知";
  if (f === "material") return d.facts.material || "未知";
  if (f === "bulletPoints") return d.facts.bulletPoints[0] || "未知";
  const dims = d.facts.itemDimensions;
  return dims ? `${[dims.length, dims.width, ...(dims.height == null ? [] : [dims.height])].join(" × ")} ${dims.unit}` : "未知";
}

/** 分箱标签 → 区间；只解析既有统计分箱，不新增业务阈值。 */
function parseBand(label: string): { min: number; max: number } | null {
  const range = label.match(/^(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)$/u);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const open = label.match(/^≥\s*(\d+(?:\.\d+)?)$/u);
  if (open) return { min: Number(open[1]), max: Number.POSITIVE_INFINITY };
  return null;
}

type SortKey = "price" | "rating" | "reviews" | "brand";

/**
 * 02 市场竞争区（第二次视觉返工）：竞争结构 → 代表商品观察 → 必要解释。
 * 只消费已保存的锁定样本、统计与来源字段；筛选、排序、分页、选中都不改变样本或统计。
 */
export function MarketCompetition({ data, lookup, onCaptureHistory, report, reportStale, onOpenReport }: {
  data: MarketIntelligence;
  lookup: EvidenceLookup;
  onCaptureHistory: () => void;
  report?: MarketIntelligenceReport;
  reportStale?: boolean;
  onOpenReport: () => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [currency, setCurrency] = useState("");
  const [band, setBand] = useState("all");
  const [sort, setSort] = useState<SortKey>("price");
  const [visible, setVisible] = useState(8);
  // 默认展开第一款样本：字段来源时间与锁定观察时间的区别必须默认可见，而不是藏在点击之后。
  const [selected, setSelected] = useState(() => data.samples.find((sample) => new Set(data.statistics?.subjects ?? []).has(sample.subjectKey))?.subjectKey ?? "");
  const reducedMotion = usePrefersReducedMotion();
  const stats = data.statistics!;
  const subjects = useMemo(() => new Set(stats.subjects), [stats.subjects]);
  const samples = useMemo(() => data.samples.filter(s => subjects.has(s.subjectKey)), [data.samples, subjects]);
  const price = stats.prices.find(p => p.currency === currency) ?? stats.prices[0];
  const reviews = stats.reviewCount;
  const legacy = (reviews.unclassifiedCount ?? 0) > 0 || reviews.verifiedCount == null;
  const reviewCaliber = legacy
    ? "旧口径含未分类读数，不能认定为可复核分布。"
    : `可复核 ${reviews.denominator} 款 · 冲突 ${reviews.conflictCount} 款 · 未复核 ${reviews.unverifiedCount} 款`;
  const historySubjects = [...new Set(data.trends.filter(t => subjects.has(t.subjectKey) && !t.field.startsWith("keepa.window.") && t.points.length > 1).map(t => t.subjectKey))];

  const bands = useMemo(() => {
    if (!price) return [];
    const parsed = price.bins.map(bin => ({ label: bin.label, range: parseBand(bin.label) }));
    return parsed.every(b => b.range) ? parsed.map(b => ({ label: b.label, min: b.range!.min, max: b.range!.max })) : [];
  }, [price]);

  const filtered = useMemo(() => {
    const list = samples.filter(sample => {
      if (band === "all" || !price || sample.price == null || sample.priceCurrency !== price.currency) return band === "all";
      const index = bands.findIndex((item, i) => sample.price! >= item.min && (i === bands.length - 1 || sample.price! < item.max));
      return String(index) === band;
    });
    return [...list].sort((a, b) => {
      if (sort === "rating") return (b.rating ?? -1) - (a.rating ?? -1);
      if (sort === "reviews") return (b.reviewCountCaliber?.state === "verified" ? b.reviewCount ?? -1 : -1) - (a.reviewCountCaliber?.state === "verified" ? a.reviewCount ?? -1 : -1);
      if (sort === "brand") return (a.brand ?? "品牌未知").localeCompare(b.brand ?? "品牌未知") || (a.price ?? 0) - (b.price ?? 0);
      return (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER);
    });
  }, [samples, band, sort, price, bands]);

  const shown = filtered.slice(0, visible);
  const active = samples.find(sample => sample.subjectKey === selected);
  const activeDetail = data.productDetails?.find(detail => detail.subjectKey === active?.subjectKey);
  const activeTitle = active ? (data.translations?.[`title:${active.subjectKey}`]?.text ?? active.title ?? `${active.brand ?? "品牌未知"} · ${active.asin}`) : "";
  const activeBand = active && price && active.priceCurrency === price.currency && active.price != null
    ? bands[bands.findIndex((item, i) => active.price! >= item.min && (i === bands.length - 1 || active.price! < item.max))]?.label
    : null;
  const priceMax = price?.bins.reduce((max, bin) => Math.max(max, bin.count), 0) ?? 0;
  // 中位在最小/最大标价之间的相对位置：只编码同一组已展示读数，不新增统计口径
  const medianPosition = price && price.median != null && price.min != null && price.max != null && price.max > price.min
    ? Math.min(100, Math.max(0, ((price.median - price.min) / (price.max - price.min)) * 100))
    : null;

  return (
    <div className={styles.area}>
      <header className={styles.head}>
        <div className={styles.headMain}>
          <span className={styles.kicker}>竞争格局 · {data.marketplace || "US"}</span>
          <h2>谁在这个价格带里，靠什么竞争？</h2>
          <p>{stats.sampleCount} 款正式样本的价格位置与品牌结构。样本观察不是全市场份额，商品页标价也不等于成交价。</p>
        </div>
        {stats.prices.length > 1 && (
          <label className={styles.currencyPick}>
            <span>币种</span>
            <select value={price?.currency} onChange={e => setCurrency(e.target.value)} aria-label="价格币种">
              {stats.prices.map(p => <option key={p.currency}>{p.currency}</option>)}
            </select>
          </label>
        )}
      </header>

      <section className={styles.stats} aria-label="竞争关键读数">
        <div>
          <span>中位标价</span>
          <b>{price ? number(price.median) : "未知"}<small>{price?.currency ?? ""}</small></b>
          <em>{price ? `有效 ${price.denominator}/${stats.sampleCount} 款` : "价格或币种未知"}</em>
          {price && medianPosition != null ? (
            <div
              className={styles.medianRange}
              role="img"
              aria-label={`样本标价最低 ${number(price.min)}、中位 ${number(price.median)}、最高 ${number(price.max)} ${price.currency ?? ""}；圆点位置为中位数`}
            >
              <span>{number(price.min)}</span>
              <i aria-hidden="true"><span style={{ left: `${medianPosition}%` }} /></i>
              <span>{number(price.max)}</span>
            </div>
          ) : null}
        </div>
        <div>
          <span>价格区间</span>
          <b>{price ? `${number(price.min)}–${number(price.max)}` : "未知"}</b>
          <em>同币种商品等权，可能为套装价</em>
        </div>
        <div>
          <span>品牌已知</span>
          <b>{stats.brands.denominator}<small>/{stats.sampleCount}</small></b>
          <em>{stats.brands.missing} 款未知 · 不是销量份额</em>
        </div>
        <div>
          <span>样本平均评分</span>
          <b>{number(stats.rating.mean)}<small>/5</small></b>
          <em>有效 {stats.rating.denominator} 款 · 不等于实物质量</em>
        </div>
        <div>
          <span>可复核累计评价</span>
          <b>{legacy ? "待核实" : reviews.denominator}<small> 款</small></b>
          <em>{legacy ? "旧口径含未分类读数" : `冲突 ${reviews.conflictCount} · 未复核 ${reviews.unverifiedCount}`}</em>
        </div>
      </section>

      <section className={styles.structure} aria-label="竞争结构">
        <article className={styles.priceCard}>
          <header>
            <h3>样本标价处于什么位置？</h3>
            <span>{price ? `有效 ${price.denominator}/${stats.sampleCount} 款 · ${price.currency}` : "无有效价格"}</span>
          </header>
          {price ? (
            <>
              <div className={styles.chart} role="img" aria-label={`价格分布：${price.bins.map(b => `${b.label} ${b.count}款`).join("，")}`}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={price.bins} margin={{ top: 14, right: 10, bottom: 4, left: 0 }} barCategoryGap={22}>
                    <defs>
                      <linearGradient id="priceBar" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#4FC79F" />
                        <stop offset="100%" stopColor="#C7EBDB" />
                      </linearGradient>
                      <linearGradient id="priceBarActive" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#29B488" />
                        <stop offset="100%" stopColor="#8FDCBE" />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke="#E8F0EB" />
                    <XAxis dataKey="label" tick={{ fontSize: 12.5, fill: "#4b6253" }} axisLine={false} tickLine={false} interval={0} />
                    <YAxis tick={{ fontSize: 12.5, fill: "#84968E" }} width={28} allowDecimals={false} axisLine={false} tickLine={false} domain={[0, Math.max(1, priceMax)]} />
                    <Tooltip cursor={{ fill: "rgba(8,127,104,0.06)" }} contentStyle={{ border: "1px solid #E3ECE7", borderRadius: 10, fontSize: 13 }} formatter={(v) => [`${v} 款`, "商品数"]} />
                    <ReferenceLine y={price.median ?? undefined} stroke="#0E7F62" strokeDasharray="4 4" label={{ value: "中位", position: "insideTopRight", fill: "#0a5747", fontSize: 12 }} />
                    <Bar dataKey="count" radius={[8, 8, 0, 0]} isAnimationActive={!reducedMotion} animationDuration={650} maxBarSize={56}>
                      {price.bins.map((bin, index) => <Cell key={bin.label} fill={band === String(index) ? "url(#priceBarActive)" : "url(#priceBar)"} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className={styles.chartNote}>同币种 {price.denominator} 款商品等权；页面标价可能为套装价，件数未核验，不计算单件价。</p>
            </>
          ) : <p className={styles.empty}>价格或币种未知，无法计算可比较的价格分布。</p>}
        </article>

        <article className={styles.brandCard}>
          <header>
            <h3>哪些品牌在样本里出现较多？</h3>
            <span>分母 {stats.brands.denominator} 款已知品牌</span>
          </header>
          {stats.brands.rows.length ? (
            <ul className={styles.brandList}>
              {stats.brands.rows.slice(0, 8).map(row => (
                <li key={row.brand}>
                  <span className={styles.brandName} title={row.brand}>{row.brand}</span>
                  <span className={styles.brandTrack}><i style={{ width: `${Math.max(4, row.share * 100)}%` }} /></span>
                  <b>{row.count}</b>
                </li>
              ))}
            </ul>
          ) : <p className={styles.empty}>品牌格局未知</p>}
          <p className={styles.chartNote}>按商品数计，不是销量份额，也不计算 CR5；{stats.brands.missing} 款品牌未知。</p>
        </article>
      </section>

      <section className={styles.products} aria-label="代表商品观察">
        <header className={styles.productsHead}>
          <div>
            <h3>代表商品观察</h3>
            <p>用途 / 形态分组：待核实 · 点商品查看尺寸、材质与来源；筛选与选择不改变正式样本。</p>
          </div>
          <div className={styles.filters}>
            <label>
              <span>价格带</span>
              <select value={band} onChange={(event) => { setBand(event.target.value); setVisible(8); }} aria-label="按价格带筛选">
                <option value="all">全部价格带</option>
                {bands.map((item, index) => <option key={item.label} value={String(index)}>{item.label} {price?.currency ?? ""}</option>)}
              </select>
            </label>
            <label>
              <span>排序</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} aria-label="商品排序">
                <option value="price">标价从低到高</option>
                <option value="rating">评分从高到低</option>
                <option value="reviews">累计评价从多到少</option>
                <option value="brand">品牌名称 A→Z</option>
              </select>
            </label>
            <span className={styles.count}>{filtered.length} / {samples.length} 款</span>
          </div>
        </header>

        {shown.length ? (
          <div className={styles.grid}>
            {shown.map(sample => {
              const detail = data.productDetails?.find(d => d.subjectKey === sample.subjectKey);
              const title = data.translations?.[`title:${sample.subjectKey}`]?.text ?? sample.title ?? `${sample.brand ?? "品牌未知"} · ${sample.asin}`;
              return (
                <article
                  key={sample.subjectKey}
                  className={styles.card}
                  data-active={sample.subjectKey === selected || undefined}
                  onMouseMove={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    event.currentTarget.style.setProperty("--mx", `${event.clientX - rect.left}px`);
                    event.currentTarget.style.setProperty("--my", `${event.clientY - rect.top}px`);
                  }}
                >
                  <button type="button" className={styles.cardButton} onClick={() => setSelected(sample.subjectKey === selected ? "" : sample.subjectKey)} aria-pressed={sample.subjectKey === selected}>
                    <span className={styles.cardImageWrap}>
                      <ProductImage src={trustedSampleImageUrl(data, sample.subjectKey)} alt={`${sample.asin} 商品主图`} className={styles.cardImage} placeholderLabel="暂无可信图片" testId={`market-product-image-${sample.asin}`} />
                    </span>
                    <span className={styles.cardBrand}>{sample.brand ?? "品牌未知"}</span>
                    <span className={styles.cardTitle}>{title}</span>
                    <span className={styles.cardFoot}>
                      <b>{number(sample.price)}<small>{sample.priceCurrency ?? "币种未知"}</small></b>
                      <em>{number(sample.rating)} 星 · {number(sample.reviewCount)} 评价</em>
                    </span>
                    <span className={styles.cardTraits}>
                      <i>{competitionClaim(detail, "itemDimensions")}</i>
                      <i>{competitionClaim(detail, "material")}</i>
                    </span>
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <p className={styles.empty}>当前筛选下没有商品；切换价格带或清除筛选。</p>
        )}

        {filtered.length > shown.length && (
          <button type="button" className={styles.moreBtn} onClick={() => setVisible(v => v + 8)}>
            显示更多（还有 {filtered.length - shown.length} 款）
          </button>
        )}

        {active && (
          <article className={styles.detail} aria-label="选中商品详情">
            <header>
              <div>
                <span className={styles.detailBrand}>{active.brand ?? "品牌未知"}{activeBand ? ` · ${activeBand} 价格带` : ""}</span>
                <h4>{activeTitle}</h4>
              </div>
              <button type="button" className={styles.ghostBtn} onClick={() => setSelected("")}>收起</button>
            </header>
            <dl className={styles.detailFacts}>
              <div><dt>标价</dt><dd>{number(active.price)} {active.priceCurrency ?? ""}</dd></div>
              <div><dt>评分</dt><dd>{number(active.rating)} / 5</dd></div>
              <div><dt>累计评价</dt><dd>{active.reviewCountCaliber?.state === "conflict" ? "冲突，未采用" : active.reviewCountCaliber?.state === "verified" ? `${number(active.reviewCount)}（可复核）` : active.reviewCountCaliber?.state === "unverified" ? "未复核，未采用" : number(active.reviewCount)}</dd></div>
              <div><dt>商品尺寸</dt><dd>{competitionClaim(activeDetail, "itemDimensions")}</dd></div>
              <div><dt>材质声明</dt><dd>{competitionClaim(activeDetail, "material")}</dd></div>
              <div><dt>ASIN</dt><dd className={styles.mono}>{active.asin}</dd></div>
            </dl>
            <p className={styles.detailNote}>尺寸与材质为来源声明，尚未实测；同名材质不证明配方或性能相同。</p>
            <p className={styles.detailMeta}>锁定样本观察：{time(active.evidence.capturedAt)} · {active.evidence.evidenceId}</p>
            <details className={styles.detailMore}>
              <summary>做法依据、字段来源与证据</summary>
            {activeDetail && ([["material", "材质"], ["itemDimensions", "商品尺寸"], ["bulletPoints", "卖点"]] as const).map(([field, fieldLabel]) => (
              <div key={field} className={styles.fieldBlock}>
                <b>{fieldLabel}字段来源</b>
                <p>{competitionClaim(activeDetail, field)}</p>
                {activeDetail.facts.fieldEvidence[field]?.map(ref => <p key={ref.refId}>{ref.source} · {time(ref.capturedAt)} · {ref.refId}</p>)}
              </div>
            ))}
            {activeDetail?.facts.bulletPoints.map((point, index) => <p key={index} className={styles.detailNote}>{point}</p>)}
            {activeDetail?.facts.conflicts.map(c => (
              <div key={c.field} className={styles.fieldBlock}>
                <b>冲突字段：{c.field}</b>
                {c.candidates.map((candidate, index) => <p key={index}>{candidate.source} · {JSON.stringify(candidate.value)} · {time(candidate.capturedAt)}</p>)}
              </div>
            ))}
            <EvidenceList ids={[active.evidence.id, ...(active.brandEvidence ? [active.brandEvidence.id] : [])]} data={data} lookup={lookup} supports="当前商品的价格、评分与品牌" />
            {active.evidence.sourceUrl && <a href={active.evidence.sourceUrl} target="_blank" rel="noreferrer">打开来源页面</a>}
            </details>
          </article>
        )}
      </section>

      <section className={styles.explain} aria-label="口径与限制">
        <h3>这些数字能说明什么</h3>
        <dl>
          <div>
            <dt>品牌结构</dt>
            <dd>{stats.brands.rows.length ? `已知 ${stats.brands.rows.length} 个品牌，按商品数计` : "品牌格局未知"}</dd>
            <small>不是销量份额，也不计算 CR5。</small>
          </div>
          <div>
            <dt>累计评价</dt>
            <dd>{legacy ? "旧口径待核实" : reviewCaliber}</dd>
            <small>{legacy ? reviewCaliber : "不是本次读取的评论条数，也不是销量。"}</small>
          </div>
          <div>
            <dt>评分</dt>
            <dd>{number(stats.rating.mean)} / 5（{stats.rating.denominator} 款有效）</dd>
            <small>每款等权，是买家累计结果，不等于实物质量。</small>
          </div>
        </dl>
      </section>

      <details className={styles.deepDive}>
        <summary>评价冲突、辅助分布与全部样本</summary>
        <div className={styles.deepBody}>
          <div className={styles.auxGrid}>
            <Bins title="样本评分分布如何？" bins={stats.rating.bins} denominator={stats.rating.denominator} note="每款等权，不证明质量门槛" color="#638a71" readable />
            <Bins title="可复核商品的累计评价数如何分布？" bins={legacy ? [] : reviews.bins} denominator={legacy ? 0 : reviews.denominator} note="只统计可复核读数；不是本次读取评论条数，也不是进入门槛。" color="#b18758" readable />
          </div>
          <details className={styles.auxDetails}>
            <summary>核对评价数读数、冲突与来源</summary>
            <p>{reviews.policy}</p>
            {samples.map(s => (
              <article key={s.subjectKey}>
                <b>{s.asin} · {s.reviewCountCaliber?.state === "conflict" ? "冲突，未采用" : s.reviewCountCaliber?.state === "verified" ? "可复核" : s.reviewCountCaliber?.state === "unverified" ? "未复核，未采用" : "缺失 / 待核实"}</b>
                <p>{s.reviewCountCaliber?.lockedSurface === "search" ? "搜索卡片" : "锁定样本"}读数 {number(s.reviewCount)} · {time(s.evidence.capturedAt)} · {s.evidence.evidenceId}</p>
                {s.reviewCountCaliber?.productPageValue != null && <p>商品页读数 {number(s.reviewCountCaliber.productPageValue)} · {time(s.reviewCountCaliber.productPageCapturedAt)} · {s.reviewCountCaliber.productPageEvidenceId}</p>}
              </article>
            ))}
          </details>
          <details className={styles.auxDetails}>
            <summary>核对品牌来源与分母</summary>
            {samples.map(s => <p key={s.subjectKey}>{s.asin} · {s.brand ?? "未知"} · {s.brandEvidence?.evidenceId ?? "品牌依据未知"}</p>)}
          </details>
        </div>
      </details>

      <details className={styles.deepDive} onToggle={e => setHistoryOpen(e.currentTarget.open)}>
        <summary>单品历史覆盖 {historySubjects.length}/{stats.sampleCount} 款 · 查看已保存的单品历史</summary>
        <div className={styles.deepBody}>
          <p className={styles.deepNote}>{Math.max(0, stats.sampleCount - historySubjects.length)} 款暂无可用序列；单品历史不能代表整批市场趋势。</p>
          {historyOpen && <MarketHistoryChart data={data} subjects={[...subjects]} />}
          <button type="button" className={styles.ghostBtn} onClick={onCaptureHistory}>准备商品历史补证</button>
        </div>
      </details>

      <MarketSectionFindings report={report} section="competition" stale={Boolean(reportStale)} generatedAt={report?.generatedAt} onOpenReport={onOpenReport} />
    </div>
  );
}
