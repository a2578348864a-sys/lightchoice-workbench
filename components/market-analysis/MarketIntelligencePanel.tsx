"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MarketHistoryChart } from "./MarketHistoryChart";
import { MarketProductComparison } from "./MarketProductComparison";
import { MarketCompetition } from "./MarketCompetition";
import { MarketDemandWorkspace } from "./MarketDemandWorkspace";
import { MarketVoiceWorkspace } from "./MarketVoiceWorkspace";
import { MarketCompareWorkspace } from "./MarketCompareWorkspace";
import { RefreshCw, Database, ClipboardCheck } from "lucide-react";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import type { MarketIntelligence, MarketIntelligenceSample } from "@/lib/marketScan/intelligence";
import { MarketResearchReport, type SavedRepresentativeItem } from "./MarketResearchReport";
import type { MarketIntelligenceReport, MarketResearchRecommendation } from "@/lib/marketScan/intelligence";
import { EvidenceList, buildEvidenceLookup, type EvidenceLookup } from "./MarketReportEvidence";
import { MarketResearchCaptureDialog, type ResearchCaptureMode } from "./MarketResearchCaptureDialog";
import { MarketOverviewCockpit } from "./MarketOverviewCockpit";
import styles from "./MarketIntelligencePanel.module.css";
import visual from "./MarketResearchVisual.module.css";

export const MARKET_RESEARCH_TABS = ["研究总览", "市场竞争", "关键词与需求", "买家声音", "商品对比"] as const;
export type MarketResearchTab = typeof MARKET_RESEARCH_TABS[number];
const labels: Record<string, string> = { sellersprite_product_market: "商品与市场深度", reverse_asin: "反查 ASIN", keyword_mining_trend: "关键词挖掘与趋势", historical_trend: "商品历史趋势" };
const metricNames: Record<string, string> = { searchVolumeGrowth: "月搜索量增长率", spr: "SPR（来源指标）", titleDensity: "标题密度", estimatedMonthlyPurchase: "月购买量估算", trafficShare: "流量占比", searchVolume: "搜索量", monthlySearches: "月搜索量", monthlySales: "月销量估算", organicRank: "自然排名", sponsoredRank: "广告排名", clickShare: "点击占比", conversionShare: "转化占比", cpc: "每次点击费用", competition: "竞争指标", searchTrend: "搜索趋势", price: "价格", bsr: "BSR排名", reviewCount: "评论量", rating: "评分" };
const statusNames: Record<string, string> = { available: "已有可用数据", partial: "部分数据可用", blocked: "等待来源处理", unusable: "尚不可用于分析" };
const number = (n: number | null | undefined) => n == null ? "未知" : n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const time = (value: string) => value.length >= 16 ? `${value.slice(0, 10)} ${value.slice(11, 16)} UTC` : value;
const asinOf = (subjectKey: string) => subjectKey.split(":").at(-1) ?? subjectKey;
function SectionLead({ kicker, title, children, action }: { kicker: string; title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return <div className={styles.sectionLead}><div><span className={styles.blockKicker}>{kicker}</span><h3>{title}</h3><div className={styles.sectionLeadText}>{children}</div></div>{action && <div className={styles.sectionLeadAction}>{action}</div>}</div>;
}

export function MarketIntelligencePanel({
  scanId,
  revision,
  active,
  onTabChange,
  onChanged,
  onData,
  selectedSubjects,
  savedRepresentatives,
  onAdoptRecommendation,
  marketGate,
  onGoToGate,
  onOpenDecision,
  decisionState,
}: {
  scanId: string;
  revision?: string;
  active: MarketResearchTab;
  onTabChange: (tab: MarketResearchTab) => void;
  onChanged: () => void;
  onData: (data: MarketIntelligence) => void;
  selectedSubjects: string[];
  savedRepresentatives?: SavedRepresentativeItem[];
  onAdoptRecommendation?: (report: MarketIntelligenceReport, recommendation: MarketResearchRecommendation) => void;
  marketGate?: { label: string; tone: "ok" | "warn" | "neutral" };
  onGoToGate?: () => void;
  /** 打开「决策与交接」独立工作区（P1-HANDOFF-UX）；入口与五区 Tab 视觉区分。 */
  onOpenDecision?: () => void;
  decisionState?: { label: string; tone: "ok" | "warn" | "neutral" };
}) {
  const [captureMode, setCaptureMode] = useState<ResearchCaptureMode | null>(null);
  const [data, setData] = useState<MarketIntelligence | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [query, setQuery] = useState(""), [bindings, setBindings] = useState<string[]>([]), [reportId, setReportId] = useState(""), [providerChecked, setProviderChecked] = useState(false), [returnSubject, setReturnSubject] = useState("");
  const [comparisonKeys, setComparisonKeys] = useState<string[]>([]), [comparisonReady, setComparisonReady] = useState(false);
  const [keywordSource, setKeywordSource] = useState<"market" | "competitor">("market");
  useEffect(() => { setReturnSubject(new URLSearchParams(window.location.search).get("sourceSubject") ?? ""); }, []);
  const endpoint = `/api/market-analysis/${encodeURIComponent(scanId)}/intelligence`;
  const load = useCallback(async (preserveError = false) => {
    try {
      const response = await fetch(endpoint, { headers: buildAccessHeaders(), cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error?.message ?? "无法读取市场研究，请重试。");
      setData(body.data); setBindings(body.data.queryBindings); onData(body.data); if (!preserveError) setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "读取失败"); }
  }, [endpoint, onData]);
  useEffect(() => { void load(); }, [load, revision]);
  async function act(action: string, extra: Record<string, unknown> = {}) {
    if (!data || busy) return;
    setBusy(true); setNotice(""); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { ...buildAccessHeaders(), "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ action, expectedVersion: data.resourceVersion, expectedInputHash: data.inputHash, expectedScopeHash: data.scope?.hash, ...extra }) });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error?.message ?? "操作未完成，原内容已保留。");
      setData(body.data); onData(body.data);
      setNotice(action === "translate" ? "译文已保存；刷新后仍可读取。" : action === "apply-scope" ? "正式研究范围已更新。图表采用新范围；请重新分析并确认市场判断。" : action === "generate" ? "报告已保存，可刷新回读。" : "已保存并回读。");
      onChanged();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "操作失败"); }
    finally { setBusy(false); void load(true); }
  }
  const lookup: EvidenceLookup = useMemo(() => data ? buildEvidenceLookup(data) : new Map(), [data]);
  useEffect(() => {
    if (!data || comparisonReady) return;
    const subjects = new Set(data.statistics?.subjects ?? []);
    setComparisonKeys([...new Set(selectedSubjects.filter((key) => subjects.has(key)))].slice(0, 3));
    setComparisonReady(true);
  }, [data, selectedSubjects, comparisonReady]);
  if (!data?.statistics) return <section className={styles.panel}>{error ? <div className={styles.loadError} role="alert"><p>{error}</p><button onClick={() => void load()}>重试读取</button></div> : <div className={styles.loading}><RefreshCw size={16} className={styles.spin} /><p>正在整理这项研究的证据与统计…</p></div>}</section>;
  const stats = data.statistics, subjects = new Set(stats.subjects), report = data.reports.find((entry) => entry.id === reportId) ?? data.reports.at(-1);
  // 两类关键词分开：市场关键词需求（研究关键词查询）与竞品流量关键词（明确 ASIN 反查）。
  // 竞品流量词必须绑定到本研究正式样本内的 ASIN，不能因为采集时填了研究 ID 就纳入。
  const comparison = comparisonKeys.filter((key) => subjects.has(key)).slice(0, 3).map((key) => data.samples.find((sample) => sample.subjectKey === key)).filter((sample): sample is MarketIntelligenceSample => Boolean(sample));
  const missingTitleIds = comparison.filter((sample) => sample.title && !data.translations?.[`title:${sample.subjectKey}`]).map((sample) => `title:${sample.subjectKey}`);
  const setSlot = (index: number, subjectKey: string) => {
    setComparisonKeys((current) => {
      const next = [...current];
      next[index] = subjectKey;
      return [...new Set(next.filter(Boolean))].slice(0, 3);
    });
  };
  async function associateEvidence(subjectKey: string) {
    const response = await fetch(endpoint, { headers: buildAccessHeaders(), cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error("新证据读取失败，可重试关联，无需再次采集。");
    const fresh = payload.data as MarketIntelligence;
    if (subjectKey.startsWith("sellersprite:")) {
      if (!fresh.bindingCandidates.some((candidate) => candidate.subjectKey === subjectKey)) throw new Error("来源已保存但尚无可用于当前站点研究的查询证据，请先核对任务结果。");
      const response2 = await fetch(endpoint, { method: "POST", headers: { ...buildAccessHeaders(), "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ action: "bind", subjectKeys: [...new Set([...fresh.queryBindings, subjectKey])], expectedVersion: fresh.resourceVersion, expectedInputHash: fresh.inputHash }) });
      const body = await response2.json();
      if (!response2.ok || !body.ok) throw new Error(body.error?.message ?? "证据关联失败；请重试关联。");
    }
    await load(); onChanged(); setNotice("已读取保存的来源证据；正式商品范围没有自动扩大。");
  }

  const overviewStatsStrip = (
    <section className={styles.rangeStrip} aria-label="关键统计摘要">
      <div><b>{stats.sampleCount}</b><span>正式样本商品</span></div>
      <div><b>{stats.brands.denominator}/{stats.sampleCount}</b><span>已核验品牌（{stats.brands.missing} 款未知）</span></div>
      <div><b>{stats.reviews.total}</b><span>已取得评论观察</span></div>
      <div><b>{stats.keywords.market.rows} / {stats.keywords.competitorTraffic.rows}</b><span>市场需求词 / 竞品流量词</span></div>
      <div><b>{stats.prices[0] ? `${number(stats.prices[0].median)} ${stats.prices[0].currency}` : "未知"}</b><span>锁定中位标价</span></div>
    </section>
  );

  const renderReport = (hideToolbar = false) => (
    <MarketResearchReport
      data={data}
      active={active}
      report={report}
      reportId={reportId}
      onReport={setReportId}
      onGenerate={() => void act("generate", { comparisonSubjects: comparison.map((sample) => sample.subjectKey) })}
      busy={busy}
      comparisonSubjects={comparison.map((sample) => sample.subjectKey)}
      savedRepresentatives={savedRepresentatives}
      onAdoptRecommendation={onAdoptRecommendation}
      onSwitchTab={onTabChange}
      overviewStatsStrip={overviewStatsStrip}
      hideToolbar={hideToolbar}
    />
  );
  // 过期判定与总览一致：报告记录的输入指纹与当前不一致，或范围已变更。
  const reportStale = Boolean(report) && (report!.inputHash !== data.inputHash || Boolean(data.scope?.changed));

  const currentSubjectsSorted = [...comparison.map((s) => s.subjectKey)].sort().join("|");
  const reportSubjectsSorted = [...(report?.comparisonSubjects ?? [])].sort().join("|");
  const comparisonSetChanged = Boolean(report?.comparisonSubjects?.length) && currentSubjectsSorted !== reportSubjectsSorted;

  return <section id="market-intelligence" className={`${styles.panel} ${visual.workspace}`} data-workspace={active} aria-label="关键词市场研究">
    {/* 研究身份与五区导航：两行固定结构，导航永远五等分整行，不随内容伸缩 */}
    <div className={styles.workspaceBar}>
      <div className={styles.identityRow}>
        <span className={styles.scopePill}>
          关键词：<b>{data.research?.keyword ?? "未绑定"}</b> · {stats.sampleCount} 商品 · {stats.reviews.total} 评论 · 市场词 {stats.keywords.market.rows} / 流量词 {stats.keywords.competitorTraffic.rows}
        </span>
        <div className={styles.identityActions}>
          <button type="button" onClick={() => setCaptureMode("environment")}>采集与补证</button>
          <button type="button" disabled={busy} onClick={() => void load()}><RefreshCw size={13} />刷新已保存证据</button>
          {onOpenDecision ? (
            <button type="button" className={styles.decisionEntry} data-tone={decisionState?.tone ?? "neutral"} onClick={onOpenDecision}>
              <ClipboardCheck size={15} aria-hidden="true" />
              决策与交接
              <em>{decisionState?.label ?? "进入"}</em>
            </button>
          ) : null}
        </div>
      </div>
      <nav className={styles.tabs} aria-label="市场研究工作区">
        {MARKET_RESEARCH_TABS.map((tab) => (
          <button key={tab} type="button" aria-pressed={active === tab} onClick={() => onTabChange(tab)}>
            {tab}
          </button>
        ))}
      </nav>
    </div>

    {error && <div className={styles.error} role="alert">{error}<button onClick={() => void load()}>重新读取</button></div>}
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    {Boolean(data.aiOperations?.length) && <div className={styles.warning}><strong>AI 请求尚未确认结束</strong><p>系统已阻止重复生成和翻译。请先核对服务商的执行与费用记录；解除阻塞只保存确认，不会重新调用或补写报告。</p>{data.aiOperations?.map((op) => <p key={op.id}>{op.operation.endsWith("translate") ? "翻译" : "报告"} · {op.updatedAt} · {op.recoverable ? "等待核对" : "仍在执行或等待结果"}</p>)}<label><input type="checkbox" checked={providerChecked} onChange={(event) => setProviderChecked(event.target.checked)} />我已核对服务商记录，确认这些调用已结束</label><button disabled={busy || !providerChecked || data.aiOperations?.some((op) => !op.recoverable)} onClick={() => void act("resolve-ai", { confirmedProviderChecked: true })}>保存核对结果并解除阻塞</button></div>}
    {data.scope?.changed && <div className={styles.warning}><strong>商品归属与统计范围尚未同步</strong><p>当前图表仍采用已保存范围。请到商品对比核实排除项后正式应用；旧判断与报告会保留并提示重新确认。</p></div>}

    {active === "研究总览" && <>
      <MarketOverviewCockpit
        data={data}
        report={report}
        reportId={reportId}
        onReport={setReportId}
        onGenerate={() => void act("generate", { comparisonSubjects: comparison.map((sample) => sample.subjectKey) })}
        busy={busy}
        comparisonSubjects={comparison.map((sample) => sample.subjectKey)}
        savedRepresentatives={savedRepresentatives}
        onSwitchTab={onTabChange}
        marketGate={marketGate}
        onGoToGate={onGoToGate}
      />
      <details className={styles.disclosure} data-testid="market-full-report">
        <summary>完整研究报告原文（全部发现、机会、推荐、验证清单与覆盖说明）</summary>
        <p className={styles.note}>
          总览只呈现结论、主图与缺口；这里保留报告的完整原文与逐条依据。折叠不改变报告、决策或任何写入。
        </p>
        <div className={styles.fullReportBody}>{renderReport(true)}</div>
      </details>
    </>}

    {active === "市场竞争" && <>
      <MarketCompetition
        data={data}
        lookup={lookup}
        onCaptureHistory={() => setCaptureMode("historical_trend")}
        report={report}
        reportStale={reportStale}
        onOpenReport={() => onTabChange("研究总览")}
      />

      <details className={styles.disclosure}>
        <summary>第三方商品观察与已绑定查询数据（独立核对，不覆盖锁定统计）</summary>
        {data.productSignals.filter((signal) => subjects.has(signal.subjectKey)).map((signal) => (
          <article className={styles.review} key={signal.evidence.id}>
            <h4>{asinOf(signal.subjectKey)} · 第三方观察</h4>
            <p>{signal.metrics.map((metric) => `${metricNames[metric.metric] ?? metric.metric}：${number(metric.value)}${metric.currency ? ` ${metric.currency}` : ""}`).join(" · ")}</p>
            <p className={styles.note}>独立来源观察；与锁定样本冲突时并列阅读，不能替代。BSR 还需结合所属类目与时间。</p>
            <EvidenceList ids={[signal.evidence.id]} data={data} lookup={lookup} supports="第三方商品观察" />
          </article>
        ))}
        {data.productMarkets.map((market) => (
          <article key={market.evidence.id}>
            <h4>已绑定查询 · {market.rows.length} 行</h4>
            <p>查询商品不自动纳入正式样本。不同查询与周期分开阅读。</p>
            <EvidenceList ids={[market.evidence.id]} data={data} lookup={lookup} supports="已绑定查询数据" />
          </article>
        ))}
      </details>
    </>}

    {active === "关键词与需求" && (
      <MarketDemandWorkspace
        data={data}
        stats={stats}
        lookup={lookup}
        query={query}
        onQueryChange={setQuery}
        source={keywordSource}
        onSourceChange={setKeywordSource}
        onCapture={(module) => setCaptureMode(module)}
        report={report}
        reportStale={reportStale}
        onOpenReport={() => onTabChange("研究总览")}
      />
    )}

    {active === "买家声音" && (
      <MarketVoiceWorkspace
        data={data}
        stats={stats}
        lookup={lookup}
        report={report}
        act={act}
        busy={busy}
        reportStale={reportStale}
        onOpenReport={() => onTabChange("研究总览")}
      />
    )}

    {active === "商品对比" && (
      <MarketCompareWorkspace
        data={data}
        stats={stats}
        report={report}
        lookup={lookup}
        comparison={comparison}
        comparisonKeys={comparisonKeys}
        setSlot={setSlot}
        onClear={() => setComparisonKeys([])}
        onBringRepresentatives={() => setComparisonKeys([...new Set(selectedSubjects.filter((key) => subjects.has(key)))].slice(0, 3))}
        missingTitleIds={missingTitleIds}
        busy={busy}
        act={act}
        comparisonSetChanged={comparisonSetChanged}
        savedRepresentatives={savedRepresentatives}
        reportStale={reportStale}
        onOpenReport={() => onTabChange("研究总览")}
        onOpenDecision={onOpenDecision}
      />
    )}
    {captureMode && <MarketResearchCaptureDialog mode={captureMode} data={data} scanId={scanId} onClose={() => setCaptureMode(null)} onEvidenceReady={associateEvidence} />}
    <details className={styles.disclosure} open={returnSubject ? true : undefined}>
      <summary><Database size={14} />数据覆盖、补证与来源记录</summary>
      <p className={styles.note}>缺口影响哪些判断，以及下一步可以做什么。这里的读取和展开不会发起真实采集或付费调用。</p>
      <div className={styles.modules}>
        {stats.modules.map((module) => (
          <article key={module.module}>
            <h4>{labels[module.module]}</h4>
            <p>{module.usable ? `${module.usable} 份证据可分析` : module.blocked ? "来源受限，等待处理" : module.unusable ? "已保存但缺少可分析字段" : "本研究尚无绑定真实证据"}</p>
            <button type="button" onClick={() => setCaptureMode(module.module as ResearchCaptureMode)}>准备该模块补证任务</button>
          </article>
        ))}
      </div>
      <h4>将已有查询证据关联到本研究</h4>
      {returnSubject && (
        <p className={styles.notice}>
          {data.bindingCandidates.some((candidate) => candidate.subjectKey === returnSubject)
            ? "已返回本次采集主体。请勾选核实后保存研究关联；没有自动纳入。"
            : "返回的任务尚未产生当前站点可读证据。准备任务或采集受阻不等于取得数据。"}
          <button type="button" onClick={() => setReturnSubject("")}>收起返回提示</button>
        </p>
      )}
      <p className={styles.note}>只关联适用于当前关键词和站点的来源；查询商品不会自动加入正式样本。</p>
      {data.bindingCandidates.length ? (
        data.bindingCandidates.map((candidate) => (
          <label className={styles.binding} key={candidate.subjectKey}>
            <input
              type="checkbox"
              checked={bindings.includes(candidate.subjectKey)}
              onChange={(event) => setBindings((keys) => event.target.checked ? [...keys, candidate.subjectKey] : keys.filter((key) => key !== candidate.subjectKey))}
            />
            <span>{candidate.label}<small>{candidate.subjectKey}</small></span>
          </label>
        ))
      ) : (
        <p>EvidenceStore 中尚无可关联的查询主体。商品搜索结果没有关键词搜索量字段；来源入口未执行或未取得结果时，此处不会伪造数据。</p>
      )}
      <button type="button" disabled={busy || !data.bindingCandidates.length} onClick={() => void act("bind", { subjectKeys: bindings })}>保存研究关联</button>
      <details>
        <summary>逐条来源、限制与版本</summary>
        <div className={styles.sources}>
          {data.sources.map((source) => (
            <article key={source.evidence.id + source.module}>
              <h4>{source.label} · {statusNames[source.status]}</h4>
              <p>{source.subjectKey} · {source.scope === "query" ? "查询级" : "商品级"} · {source.freshness ? `新鲜度 ${source.freshness}` : "新鲜度未知"}</p>
              <p>{source.reason}</p>
              {source.limitations.map((limit) => <p key={limit}>{limit}</p>)}
              <EvidenceList ids={[source.evidence.id]} data={data} lookup={lookup} supports={`${source.label} 来源状态`} />
            </article>
          ))}
        </div>
      </details>
      {data.evidenceChanges.length > 0 && <p className={styles.warning}>有更新商品来源；统计保留锁定观察，不能将新旧数据静默混算。{data.evidenceChanges.join(" ")}</p>}
      <p className={styles.note}>统计版本 {stats.schema} · 指纹 {stats.hash} · 冻结样本 {data.sampleHash}</p>
    </details>
  </section>;
}
