"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, Check, Package } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  MarketIntelligence,
  MarketIntelligenceReport,
  MarketReportFinding,
  MarketReportOpportunity,
  MarketReportRisk,
} from "@/lib/marketScan/intelligence";
import { marketKeywordCategory } from "@/lib/marketScan/intelligence";
import { EvidenceList, buildEvidenceLookup } from "./MarketReportEvidence";
import { trustedSampleImageUrl, type SavedRepresentativeItem } from "./MarketResearchReport";
import { deriveReportActionState } from "./reportActionState";
import styles from "./MarketOverviewCockpit.module.css";

const NATURE_LABELS: Record<string, string> = {
  fact: "来源观察",
  estimate: "第三方估算",
  calculation: "数据计算",
  inference: "AI 推断",
  unknown: "目前未知",
};
const ROLE_LABELS: Record<string, string> = { benchmark: "对标样本", newcomer: "新进入者", pain_point: "痛点样本" };
const MODULE_LABELS: Record<string, string> = {
  sellersprite_product_market: "商品与市场深度",
  reverse_asin: "反查 ASIN",
  keyword_mining_trend: "关键词挖掘与趋势",
  historical_trend: "商品历史趋势",
  review_voc: "买家声音",
  variation: "变体结构",
};

const number = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined ? "未知" : value.toLocaleString("zh-CN", { maximumFractionDigits: digits });
const asinOf = (subjectKey: string) => subjectKey.split(":").at(-1) ?? subjectKey;
const shortText = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…` : value);
/** 关键词原文可能带「AC 中文」或「英文 中文」后缀；图上只显示可辨识主体。 */
const keywordLabel = (raw: string) => {
  const withBadge = raw.match(/^(.+?)\s+AC\s+([\u3400-\u9fff].*)$/u);
  if (withBadge) return withBadge[1].trim();
  const bilingual = raw.match(/^([^\u3400-\u9fff]+?)\s+([\u3400-\u9fff].+)$/u);
  return bilingual ? bilingual[1].trim() : raw;
};
const timeText = (value: string) => (value.length >= 16 ? `${value.slice(0, 10)} ${value.slice(11, 16)}` : value);

type ViewId = "price" | "brand" | "demand";
type ChartRow = { label: string; fullLabel: string; count: number };

function ChartTip({ active, payload, unitLabel }: { active?: boolean; payload?: Array<{ payload?: ChartRow }>; unitLabel: string }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className={styles.chartTip}>
      <span>{row.fullLabel}</span>
      <b>
        {number(row.count, 0)} {unitLabel}
      </b>
    </div>
  );
}

/**
 * 02 研究总览（P1-01 视觉返工版）。
 * 只消费已保存的市场统计与已存 AI 报告：不在此计算业务口径、不发起模型/采集请求、不改写人工闸门与代表。
 */
export function MarketOverviewCockpit({
  data,
  report,
  reportId,
  onReport,
  onGenerate,
  busy,
  comparisonSubjects,
  savedRepresentatives,
  onSwitchTab,
  marketGate,
  onGoToGate,
}: {
  data: MarketIntelligence;
  report?: MarketIntelligenceReport;
  reportId: string;
  onReport: (id: string) => void;
  onGenerate: () => void;
  busy: boolean;
  comparisonSubjects: string[];
  savedRepresentatives?: SavedRepresentativeItem[];
  onSwitchTab?: (tab: "商品对比" | "关键词与需求" | "买家声音" | "市场竞争") => void;
  marketGate?: { label: string; tone: "ok" | "warn" | "neutral" };
  onGoToGate?: () => void;
}) {
  const [view, setView] = useState<ViewId>("price");
  const stats = data.statistics;
  const lookup = useMemo(() => buildEvidenceLookup(data), [data]);
  const action = deriveReportActionState({ data, busy, comparisonSubjects, hasReport: Boolean(report) });

  const subjects = useMemo(() => new Set(stats?.subjects ?? []), [stats]);
  const priceGroup = stats?.prices[0];
  const demandKeywords = useMemo(
    () =>
      data.keywords
        .filter((keyword) => marketKeywordCategory(keyword.module) === "market_keyword_demand" && keyword.searchVolume !== null)
        .filter((keyword) => subjects.has(keyword.subjectKey) || data.queryBindings.includes(keyword.subjectKey))
        .sort((a, b) => (b.searchVolume ?? 0) - (a.searchVolume ?? 0))
        .slice(0, 6),
    [data.keywords, data.queryBindings, subjects],
  );

  if (!stats) return null;

  const stale = Boolean(report && report.inputHash !== data.inputHash);
  const structured = report?.schema === "market-intelligence-report.v3";
  const allFindings = report?.findings ?? [];
  const findings = allFindings.slice(0, 3);
  const allRisks = report?.riskGaps ?? [];
  // 两张相邻卡各显示同量级条目：避免一侧 3 条、另一侧 8 条造成卡片高度与对齐失衡；其余仍可展开。
  const risks = allRisks.slice(0, 3);
  const moreRisks = allRisks.slice(3);
  const opportunities = (report?.productOpportunities ?? []).slice(0, 3);
  const actions = (report?.nextActions ?? []).slice(0, 3);
  const missingModules = stats.modules.filter((module) => module.usable === 0);
  const unread = report?.analysisCoverage
    ? Math.max(report.analysisCoverage.reviewsAvailable - report.analysisCoverage.reviewsRead, 0)
    : null;
  const notices: string[] = [];
  if (!data.provider.ready) notices.push(data.provider.message);
  if (data.scope?.changed) notices.push("商品归属确认与正式统计范围尚未同步：图表仍采用已保存范围，请先在「商品对比」核实并应用排除项。");
  if (stale) notices.push("研究证据已变化，当前展示的是历史报告，不能当作当前版本的新结论。原报告、人工判断与输入均保留；更新需要你明确点击上方按钮。");

  const chartConfig: Record<ViewId, { title: string; unit: string; rows: ChartRow[]; footnote: string; metric: { label: string; value: string; hint: string }; horizontal?: boolean }> = {
    price: {
      title: "锁定样本标价分布",
      unit: "款商品",
      horizontal: false,
      rows: (priceGroup?.bins ?? []).map((bin) => ({
        label: bin.label,
        fullLabel: `${bin.label}${priceGroup?.currency ? ` ${priceGroup.currency}` : ""}`,
        count: bin.count,
      })),
      footnote: priceGroup
        ? `分母 ${priceGroup.denominator}/${stats.sampleCount} 款有标价；缺失标价不按 0 计入。标价为来源页面读数，不等同成交价。`
        : "当前样本没有可用的标价读数；缺失不按 0 计入。",
      metric: {
        label: "中位标价",
        value: priceGroup?.median !== null && priceGroup?.median !== undefined ? `${number(priceGroup.median)} ${priceGroup.currency}` : "未知",
        hint: priceGroup ? `区间 ${number(priceGroup.min)}–${number(priceGroup.max)} ${priceGroup.currency}` : "无可用价格读数",
      },
    },
    brand: {
      title: "已知品牌商品数",
      unit: "款商品",
      horizontal: true,
      rows: stats.brands.rows.slice(0, 6).map((row) => ({
        label: shortText(row.brand, 18),
        fullLabel: row.brand,
        count: row.count,
      })),
      footnote: `品牌分母是「有品牌读数的商品数」${stats.brands.denominator}/${stats.sampleCount}，不是销量份额；${stats.brands.missing} 款品牌未知。`,
      metric: {
        label: "品牌集中度",
        value: stats.brands.rows[0] ? `${Math.round((stats.brands.rows[0].share ?? 0) * 100)}%` : "未知",
        hint: stats.brands.rows[0] ? `最高：${stats.brands.rows[0].brand}` : "没有可核验的品牌读数",
      },
    },
    demand: {
      title: "市场需求词（种子词查询）",
      unit: "月搜索量估算",
      horizontal: true,
      rows: demandKeywords.map((keyword) => ({
        label: shortText(keywordLabel(keyword.keyword), 18),
        fullLabel: keywordLabel(keyword.keyword),
        count: keyword.searchVolume ?? 0,
      })),
      footnote: "第三方估算，不可相加、不等于销量或市场规模；与「竞品流量词（ASIN 反查）」是两类数据集。",
      metric: {
        label: "最大单词组",
        value: demandKeywords[0] ? number(demandKeywords[0].searchVolume, 0) : "未知",
        hint: demandKeywords[0] ? `「${shortText(keywordLabel(demandKeywords[0].keyword), 18)}」月搜索量估算` : "尚无种子词需求行",
      },
    },
  };
  const chart = chartConfig[view];
  const maxCount = Math.max(0, ...chart.rows.map((row) => row.count));
  const chartEmpty = chart.rows.every((row) => row.count === 0) || chart.rows.length === 0;

  const reps = (savedRepresentatives ?? []).filter((item) => subjects.has(item.subjectKey));
  const repCards = reps.map((item) => ({
    subjectKey: item.subjectKey,
    asin: item.asin,
    role: ROLE_LABELS[item.role] ?? item.role,
    note: item.note,
  }));
  const sampleCards = stats.subjects.slice(0, 4).map((subjectKey) => {
    const sample = data.samples.find((entry) => entry.subjectKey === subjectKey);
    return { subjectKey, asin: sample?.asin ?? asinOf(subjectKey), role: null, note: null };
  });
  const productCards = repCards.length ? repCards : sampleCards;

  return (
    <div className={styles.cockpit} aria-label="研究总览驾驶舱">
      <header className={styles.toolbar}>
        <div className={styles.toolbarMain}>
          <span className={styles.statusPill} data-tone={stale ? "warn" : report ? "ok" : "muted"}>
            {stale ? "历史报告 · 证据已变化" : report ? "当前有效报告" : "尚未生成报告"}
          </span>
          {data.reports.length > 0 && (
            <label className={styles.versionPick}>
              <span className={styles.srOnly}>报告版本</span>
              <select aria-label="历史市场研报" value={report?.id ?? reportId} onChange={(event) => onReport(event.target.value)}>
                {[...data.reports].reverse().map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.generatedAt.slice(0, 16).replace("T", " ")}
                  </option>
                ))}
              </select>
            </label>
          )}
          {report && (
            <span className={styles.toolbarMeta}>
              {timeText(report.generatedAt)}
              {report.analysisCoverage ? ` · 已读 ${report.analysisCoverage.reviewsRead}/${report.analysisCoverage.reviewsAvailable} 条评论` : ""}
            </span>
          )}
        </div>
        <div className={styles.toolbarActions}>
          {notices.length > 0 && (
            <details className={styles.notices}>
              <summary>
                <AlertTriangle size={13} aria-hidden="true" />
                {notices.length} 项限制
              </summary>
              <ul>
                {notices.map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            </details>
          )}
          <button type="button" className={styles.primaryBtn} disabled={action.disabled} title={action.reason} onClick={onGenerate}>
            {action.label}
          </button>
        </div>
      </header>

      <section className={styles.hero} aria-label="研究结论与市场结构">
        <div className={styles.heroChart}>
          <header className={styles.heroHead}>
            <div>
              <span className={styles.kicker}>市场结构</span>
              <h2>{chart.title}</h2>
            </div>
            <div className={styles.segmented} role="group" aria-label="切换主图视角">
              {([["price", "价格结构"], ["brand", "品牌集中"], ["demand", "需求词"]] as const).map(([id, label]) => (
                <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)}>
                  {label}
                </button>
              ))}
            </div>
          </header>

          <div className={styles.heroMetric}>
            <div className={styles.metricMain}>
              <span>{chart.metric.label}</span>
              <b>{chart.metric.value}</b>
              <small>{chart.metric.hint}</small>
            </div>
            <dl className={styles.metricSide}>
              <div>
                <dt>正式样本</dt>
                <dd>{stats.sampleCount}</dd>
              </div>
              <div>
                <dt>评论观察</dt>
                <dd>{stats.reviews.total}</dd>
              </div>
              <div>
                <dt>需求词 / 流量词</dt>
                <dd>
                  {stats.keywords.market.rows}
                  <em>/</em>
                  {stats.keywords.competitorTraffic.rows}
                </dd>
              </div>
            </dl>
          </div>

          {chartEmpty ? (
            <div className={styles.chartEmpty}>
              <Package aria-hidden="true" size={18} />
              <p>这一视角当前没有可核对的读数。系统不会用示例数字或趋势线补位。</p>
            </div>
          ) : (
            <div className={styles.chartStage} role="img" aria-label={`${chart.title}：${chart.rows.map((row) => `${row.fullLabel} ${row.count}`).join("，")}`}>
              <div className={styles.chartInner}>
              <ResponsiveContainer width="100%" height="100%">
                {chart.horizontal ? (
                  <BarChart data={chart.rows} layout="vertical" margin={{ top: 4, right: 20, bottom: 4, left: 4 }} barCategoryGap={12}>
                    <defs>
                      <linearGradient id="ovBarStrong" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="#29B488" />
                        <stop offset="100%" stopColor="#5FCDA6" />
                      </linearGradient>
                      <linearGradient id="ovBarSoft" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="#C6E7D7" />
                        <stop offset="100%" stopColor="#E2F3EA" />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="2 6" horizontal={false} stroke="#E7F0EA" />
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12, fill: "#6B7D76" }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="label" width={132} tick={{ fontSize: 12.5, fill: "#3C514A" }} axisLine={false} tickLine={false} />
                    <Tooltip cursor={{ fill: "rgba(41,180,136,0.07)" }} content={<ChartTip unitLabel={chart.unit} />} />
                    <Bar dataKey="count" radius={[0, 6, 6, 0]} isAnimationActive={false} barSize={18}>
                      {chart.rows.map((row, index) => (
                        <Cell key={`${row.fullLabel}-${index}`} fill={row.count === maxCount && maxCount > 0 ? "url(#ovBarStrong)" : "url(#ovBarSoft)"} />
                      ))}
                    </Bar>
                  </BarChart>
                ) : (
                  <BarChart data={chart.rows} margin={{ top: 10, right: 10, bottom: 0, left: 0 }} barCategoryGap={16}>
                    <defs>
                      <linearGradient id="ovBarStrongV" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#29B488" />
                        <stop offset="100%" stopColor="#7FD3B4" />
                      </linearGradient>
                      <linearGradient id="ovBarSoftV" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#CFEEDF" />
                        <stop offset="100%" stopColor="#E9F7F0" />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="2 6" vertical={false} stroke="#E7F0EA" />
                    <XAxis dataKey="label" tick={{ fontSize: 12.5, fill: "#3C514A" }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: "#6B7D76" }} axisLine={false} tickLine={false} width={44} />
                    <Tooltip cursor={{ fill: "rgba(41,180,136,0.07)" }} content={<ChartTip unitLabel={chart.unit} />} />
                    <Bar dataKey="count" radius={[7, 7, 0, 0]} isAnimationActive={false} barSize={46}>
                      {chart.rows.map((row, index) => (
                        <Cell key={`${row.fullLabel}-${index}`} fill={row.count === maxCount && maxCount > 0 ? "url(#ovBarStrongV)" : "url(#ovBarSoftV)"} />
                      ))}
                    </Bar>
                  </BarChart>
                )}
              </ResponsiveContainer>
              </div>
            </div>
          )}

          <footer className={styles.chartFoot}>
            <p>{chart.footnote}</p>
            <details className={styles.valueDetails}>
              <summary>查看数值</summary>
              <ul>
                {chart.rows.map((row) => (
                  <li key={row.fullLabel}>
                    <span>{row.fullLabel}</span>
                    <b>{number(row.count, 0)}</b>
                  </li>
                ))}
              </ul>
            </details>
          </footer>
        </div>

        <aside className={styles.heroSide} aria-label="当前判断">
          <div>
            <div className={styles.sideHead}>
              <span className={styles.kicker}>当前判断</span>
              {report?.judgment && (
                <span className={styles.natureTag} data-nature={report.judgment.nature}>
                  {NATURE_LABELS[report.judgment.nature] ?? report.judgment.nature}
                </span>
              )}
            </div>
            {report?.judgment ? (
              <>
                <p className={styles.judgmentText}>{report.judgment.text}</p>
                <div className={styles.boundary}>
                  <div>
                    <b>可以判断</b>
                    <p>{report.judgment.canJudge}</p>
                  </div>
                  <div data-tone="warn">
                    <b>暂时不能判断</b>
                    <p>{report.judgment.cannotJudge}</p>
                  </div>
                </div>
              </>
            ) : (
              <>
                <p className={styles.judgmentText}>
                  {report
                    ? "当前报告是旧版结构，没有结构化的判断、发现与缺口字段。完整原文保留在下方折叠区，可直接阅读；需要结构化结论请更新整份报告。"
                    : "尚未生成 AI 研究报告。左侧主图与统计全部来自已保存证据，可直接核对；结论需要你点击上方按钮生成。"}
                </p>
                <div className={styles.boundary}>
                  <div data-tone="warn">
                    <b>现在仍不能回答</b>
                    <p>
                      {report
                        ? "当前版本没有把「能判断 / 不能判断」写成结构化字段，机会优先级仍需按原文人工判读。"
                        : "机会优先级、可能原因与下一步验证，都要等报告生成后才能给出；生成过程会真实调用模型并计费。"}
                    </p>
                  </div>
                </div>
              </>
            )}
          </div>
          <div className={styles.sideFoot}>
            {report?.judgment && (
              <details className={styles.sideDetails}>
                <summary>判断依据</summary>
                <EvidenceList ids={report.judgment.citations} data={data} lookup={lookup} supports={report.judgment.text} />
              </details>
            )}
            {marketGate && (
              <div className={styles.sideGate}>
                <div>
                  <span className={styles.kicker}>人工市场判断</span>
                  <p className={styles.sideGateState} data-tone={marketGate.tone}>
                    {marketGate.label}
                  </p>
                </div>
                {onGoToGate && (
                  <button type="button" className={styles.sideGateLink} onClick={onGoToGate}>
                    去判断 <ArrowRight size={13} aria-hidden="true" />
                  </button>
                )}
              </div>
            )}
          </div>
        </aside>
      </section>

      <div className={styles.infoRow} data-count={report && structured ? 2 : 1}>
        {report && structured && (
          <section className={styles.infoCard} aria-label="关键发现">
            <header className={styles.cardHead}>
              <div>
                <span className={styles.kicker}>关键发现</span>
                <h3>已经能从证据里读到的</h3>
              </div>
              <span className={styles.countChip}>
                {allFindings.length > findings.length ? `前 ${findings.length} / 共 ${allFindings.length}` : `${findings.length} 条`}
              </span>
            </header>
            {findings.length === 0 ? (
              <p className={styles.emptyText}>
                {!structured ? "旧版报告没有结构化的发现字段；完整原文保留在下方折叠区。" : "本次报告没有形成有依据的关键发现；这不等于已经证明没有问题。"}
              </p>
            ) : (
              <ol className={styles.findingList}>
                {findings.map((finding: MarketReportFinding, index) => (
                  <li key={`${finding.title}-${index}`}>
                    <span className={styles.itemIndex}>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <div className={styles.itemTitleRow}>
                        <h4>{finding.title}</h4>
                        <span className={styles.natureTag} data-nature={finding.nature}>
                          {NATURE_LABELS[finding.nature] ?? finding.nature}
                        </span>
                      </div>
                      <p className={styles.itemText}>{finding.what}</p>
                      <details className={styles.itemDetails}>
                        <summary>依据与限制</summary>
                        <p>数据依据：{finding.basis}</p>
                        <p>关注原因：{finding.why}</p>
                        {finding.limits.map((limit) => (
                          <p key={limit} className={styles.mutedLine}>
                            {limit}
                          </p>
                        ))}
                        <EvidenceList ids={finding.citations} data={data} lookup={lookup} supports={finding.what} limits={finding.limits} />
                      </details>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}

        {report && structured && (
          <section className={styles.infoCard} aria-label="反证与风险">
            <header className={styles.cardHead}>
              <div>
                <span className={styles.kicker}>反证与风险</span>
                <h3>哪些判断现在还不能当事实</h3>
              </div>
              <span className={styles.countChip}>{allRisks.length} 项</span>
            </header>
            {allRisks.length === 0 ? (
              <p className={styles.emptyText}>
                {!structured ? "旧版报告没有结构化的风险字段；请按完整原文逐条核对限制。" : "本次报告没有登记额外风险；仍需逐条读取各区限制说明。"}
              </p>
            ) : (
              <>
                <ul className={styles.riskList}>
                  {risks.map((risk: MarketReportRisk) => (
                    <li key={risk.title}>
                      <h4>{risk.title}</h4>
                      <p>{risk.text}</p>
                      <details className={styles.itemDetails}>
                        <summary>证据缺口与受影响判断</summary>
                        <p>缺口：{risk.gap}</p>
                        <p>影响：{risk.impact}</p>
                        <EvidenceList ids={risk.citations} data={data} lookup={lookup} supports={risk.text} />
                      </details>
                    </li>
                  ))}
                </ul>
                {moreRisks.length > 0 && (
                  <details className={styles.moreList}>
                    <summary>查看其余 {moreRisks.length} 项风险</summary>
                    <ul className={styles.riskList}>
                      {moreRisks.map((risk: MarketReportRisk) => (
                        <li key={risk.title}>
                          <h4>{risk.title}</h4>
                          <p>{risk.text}</p>
                          <details className={styles.itemDetails}>
                            <summary>证据缺口与受影响判断</summary>
                            <p>缺口：{risk.gap}</p>
                            <p>影响：{risk.impact}</p>
                            <EvidenceList ids={risk.citations} data={data} lookup={lookup} supports={risk.text} />
                          </details>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
          </section>
        )}

        {report && !structured && (
          <section className={styles.infoCard} aria-label="旧版报告说明">
            <header className={styles.cardHead}>
              <div>
                <span className={styles.kicker}>旧版报告</span>
                <h3>这份报告只有摘要与分节段落</h3>
              </div>
            </header>
            <p className={styles.legacyText}>
              旧版结构不包含「关键发现 / 反证与风险 / 下一步验证」的可对照字段，因此总览不拆出结构化卡片，避免把段落重新包装成新结论。
              完整原文保留在下方「完整研究报告原文」中，可直接阅读；需要结构化字段时，用上方按钮更新整份报告。
            </p>
            <p className={styles.emptyText}>更新会真实调用模型并计费；未点击前不会发起任何调用。</p>
          </section>
        )}

        {!report && (
          <section className={styles.infoCard} aria-label="生成后将补充的内容">
            <header className={styles.cardHead}>
              <div>
                <span className={styles.kicker}>生成后会补充</span>
                <h3>报告会回答的三件事</h3>
              </div>
            </header>
            <ul className={styles.expectList}>
              <li>
                <b>关键发现</b>
                <span>有依据的发现、数据依据与限制条件</span>
              </li>
              <li>
                <b>反证与风险</b>
                <span>证据缺口、受影响判断与相反解释</span>
              </li>
              <li>
                <b>机会与下一步</b>
                <span>待验证的改良假设、放弃条件与最低成本验证</span>
              </li>
            </ul>
            <p className={styles.emptyText}>这些都必须由模型基于当前已保存证据生成；系统不会预填示例结论。</p>
          </section>
        )}
      </div>

      <section className={styles.coverageStrip} aria-label="覆盖与口径">
        <header className={styles.coverageHead}>
          <div>
            <span className={styles.kicker}>覆盖与口径</span>
            <h3>这份研究读到了什么</h3>
          </div>
          <details className={styles.techDetails}>
            <summary>技术信息</summary>
            <dl>
              <div>
                <dt>统计版本</dt>
                <dd>{stats.schema}</dd>
              </div>
              <div>
                <dt>统计指纹</dt>
                <dd>{stats.hash}</dd>
              </div>
              <div>
                <dt>样本指纹</dt>
                <dd>{data.sampleHash}</dd>
              </div>
            </dl>
          </details>
        </header>
        <ul className={styles.coverageList}>
          <li>
            <span>评论输入</span>
            <b>{report?.analysisCoverage ? `${report.analysisCoverage.reviewsRead}/${report.analysisCoverage.reviewsAvailable}` : stats.reviews.total} 条</b>
            <small>{report?.voiceCoverage?.samplePolicy ?? "低星优先、非随机抽样；不能推断全体买家发生率。"}</small>
          </li>
          <li>
            <span>来源模块</span>
            <b>{missingModules.length === 0 ? "四类均有可用证据" : `${missingModules.length} 类未接通`}</b>
            <small>{missingModules.length === 0 ? "商品、反查、关键词、历史四类均已有可分析证据。" : missingModules.map((module) => MODULE_LABELS[module.module] ?? module.module).join("、")}</small>
          </li>
          <li>
            <span>报告版本</span>
            <b>{report ? (structured ? "结构化 v3" : "旧版结构") : "尚未生成"}</b>
            <small>
              {report
                ? `${report.model ? `${report.model} · ` : ""}${timeText(report.generatedAt)}${unread !== null && unread > 0 ? ` · ${unread} 条评论未读` : ""}`
                : "生成后才会有判断、发现、风险与验证建议"}
            </small>
          </li>
          <li>
            <span>证据时间</span>
            <b>{stats.timeRange.to ? timeText(stats.timeRange.to) : "未知"}</b>
            <small>样本锁定观察时间；这是已保存证据，不是本次新采集。</small>
          </li>
        </ul>
      </section>

      <section className={styles.band} aria-label="代表商品与样本">
        <header className={styles.bandHead}>
          <div>
            <span className={styles.kicker}>{repCards.length ? "已保存研究代表" : "样本商品"}</span>
            <h2>{repCards.length ? `${repCards.length} 款代表商品` : "先看样本，再决定代表"}</h2>
            <p>
              {repCards.length
                ? "角色与理由来自你的人工保存，不是 AI 推荐；满足市场判断和交接条件后，可发起商品研究。"
                : "以下为正式样本中的商品，尚未保存为研究代表。角色判断与发起商品研究需要在「决策与交接」工作区完成。"}
            </p>
          </div>
          <button type="button" className={styles.ghostBtn} onClick={() => onSwitchTab?.("商品对比")}>
            去商品对比 <ArrowRight size={14} aria-hidden="true" />
          </button>
        </header>
        <div className={styles.productGrid} data-layout={repCards.length ? "representative" : "sample"}>
          {productCards.map((card) => {
            const sample = data.samples.find((entry) => entry.subjectKey === card.subjectKey);
            const image = trustedSampleImageUrl(data, card.subjectKey);
            const price = sample?.price !== null && sample?.price !== undefined ? `${number(sample.price)} ${sample.priceCurrency ?? ""}`.trim() : "价格未知";
            return (
              <button
                type="button"
                className={styles.productCard}
                key={card.subjectKey}
                onClick={() => onSwitchTab?.("商品对比")}
                aria-label={`查看 ${card.asin} 的商品对比`}
              >
                <span className={styles.imageStage}>
                  {image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={image} alt={sample?.title ? `${sample.title} 商品图` : `${card.asin} 商品图`} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
                  ) : (
                    <span className={styles.imageFallback} aria-label="没有可信商品图">
                      <Package size={22} aria-hidden="true" />
                    </span>
                  )}
                  {card.role && <span className={styles.roleTag}>{card.role}</span>}
                </span>
                <span className={styles.productBody}>
                  <span className={styles.productMeta}>
                    <span>{sample?.brand ?? "品牌未知"}</span>
                    <span className={styles.mono}>{card.asin}</span>
                  </span>
                  <span className={styles.productTitle}>{sample?.title ?? "标题未取得"}</span>
                  <span className={styles.productNumbers}>
                    <b>{price}</b>
                    <span>{sample?.rating !== null && sample?.rating !== undefined ? `${number(sample.rating)} 星` : "评分未知"}</span>
                    <span>
                      {sample?.reviewCount !== null && sample?.reviewCount !== undefined ? `累计评价 ${number(sample.reviewCount, 0)}` : "累计评价未知"}
                    </span>
                  </span>
                  {card.note && <span className={styles.productNote}>{card.note}</span>}
                  <span className={styles.productLink}>
                    在商品对比中查看 <ArrowRight size={13} aria-hidden="true" />
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {opportunities.length > 0 && (
        <section className={styles.band} aria-label="改良机会与反证">
          <header className={styles.bandHead}>
            <div>
              <span className={styles.kicker}>机会观察</span>
              <h2>哪些改良值得先调查，且可能错在哪</h2>
              <p>每条机会都带反证与放弃条件；它们是待验证假设，不是已确认需求，也不构成开发或量产批准。</p>
            </div>
            <span className={styles.countChip}>{opportunities.length} 条</span>
          </header>
          <div className={styles.opportunityGrid}>
            {opportunities.map((item: MarketReportOpportunity, index) => (
              <article className={styles.opportunityCard} key={item.id ?? `${item.title}-${index}`}>
                <header>
                  <span className={styles.itemIndex}>{String(index + 1).padStart(2, "0")}</span>
                  <h3>{item.title}</h3>
                </header>
                <p className={styles.opportunityProblem}>{item.buyerProblem}</p>
                <p className={styles.opportunityHypothesis}>
                  <b>假设</b>
                  {item.hypothesis}
                </p>
                {item.counterEvidence?.[0] && (
                  <p className={styles.counterLine}>
                    <b>反证</b>
                    {item.counterEvidence[0]}
                  </p>
                )}
                {item.rejectionConditions?.[0] && (
                  <p className={styles.rejectLine}>
                    <b>放弃条件</b>
                    {item.rejectionConditions[0]}
                  </p>
                )}
                {item.unverified?.length ? <p className={styles.unverifiedLine}>待确认 {item.unverified.length} 项：{shortText(item.unverified[0], 56)}</p> : null}
                <details className={styles.itemDetails}>
                  <summary>展开全部反证、约束与依据</summary>
                  {item.scenario && <p>使用场景：{item.scenario}</p>}
                  {item.counterEvidence?.map((line) => (
                    <p key={line} className={styles.counterLine}>
                      <b>反证</b>
                      {line}
                    </p>
                  ))}
                  {item.rejectionConditions?.map((line) => (
                    <p key={line} className={styles.rejectLine}>
                      <b>放弃条件</b>
                      {line}
                    </p>
                  ))}
                  {item.developmentConstraints?.map((line) => <p key={line}>开发约束：{line}</p>)}
                  {item.unverified?.map((line) => <p key={line}>待确认：{line}</p>)}
                  <EvidenceList ids={item.citations} data={data} lookup={lookup} supports={item.hypothesis} />
                </details>
              </article>
            ))}
          </div>
        </section>
      )}

      {actions.length > 0 && (
        <section className={styles.band} aria-label="下一步验证">
          <header className={styles.bandHead}>
            <div>
              <span className={styles.kicker}>下一步</span>
              <h2>用最低成本先把哪一件事查清</h2>
            </div>
          </header>
          <ol className={styles.actionList}>
            {actions.map((actionItem, index) => (
              <li key={actionItem.question}>
                <span className={styles.itemIndex}>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <h3>{actionItem.question}</h3>
                  <p>
                    <b>需要证据</b>
                    {actionItem.neededEvidence}
                  </p>
                  <p>
                    <b>怎么验证</b>
                    {actionItem.howToVerify}
                  </p>
                  <p>
                    <b>完成标准</b>
                    {actionItem.doneWhen}
                  </p>
                  <details className={styles.itemDetails}>
                    <summary>核对依据</summary>
                    <EvidenceList ids={actionItem.citations} data={data} lookup={lookup} supports={actionItem.question} />
                  </details>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      <p className={styles.footNote}>
        <Check size={13} aria-hidden="true" />
        本页只读已保存证据与已存报告；打开、切换视角或展开依据都不会调用模型或改写研究统计。
      </p>
    </div>
  );
}
