"use client";

import { useState } from "react";
import { ProductImage } from "@/components/source-layer/ProductImage";
import type {
  MarketIntelligence,
  MarketIntelligenceReport,
  MarketReportAction,
  MarketReportFinding,
  MarketReportOpportunity,
  MarketReportPoint,
  MarketReportRisk,
  MarketReportSection,
  MarketReportJudgment,
  MarketVoiceTheme,
  MarketWorkspaceReport,
  MarketResearchRecommendation,
} from "@/lib/marketScan/intelligence";
import type { OpportunityResearchSnapshot } from "@/lib/marketScan/opportunityResearch";
import { EvidenceList, buildEvidenceLookup, type EvidenceLookup } from "./MarketReportEvidence";
import { deriveReportActionState } from "./reportActionState";
import styles from "./MarketIntelligencePanel.module.css";
import visual from "./MarketResearchVisual.module.css";

const sectionKeys: Record<string, MarketReportSection> = { 研究总览: "overview", 市场竞争: "competition", 关键词与需求: "demand", 买家声音: "voice", 商品对比: "comparison" };
const sectionNames: Record<MarketReportSection, string> = { overview: "研究总览", competition: "市场竞争", demand: "关键词与需求", voice: "买家声音", comparison: "商品对比" };
const natureNames: Record<string, string> = { fact: "来源观察", estimate: "第三方估算", calculation: "数据计算", inference: "AI 推断", unknown: "证据不足" };
const sentimentNames: Record<string, string> = { negative: "问题反馈", positive: "正向反馈", mixed: "混合反馈" };
const roleLabels: Record<string, string> = { benchmark: "标杆竞品", newcomer: "新进入者", pain_point: "痛点样本" };
const recoveryReasonNames: Record<string, string> = {
  MARKET_RESEARCH_STORAGE_LIMIT: "研究保存空间不足",
  CAS_CONFLICT: "研究已被其他操作更新",
  MARKET_RESEARCH_INPUT_STALE: "研究证据已更新",
  PERSIST_FAILED: "保存未完成",
};
const number = (value: number | null | undefined) => value === null || value === undefined ? "未知" : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const asinOf = (subjectKey: string) => subjectKey.split(":").at(-1) ?? subjectKey;
const time = (value: string) => value.length >= 16 ? `${value.slice(0, 10)} ${value.slice(11, 16)} UTC` : value;

const TRUSTED_AMAZON_IMAGE_HOST = /^(?:[a-z0-9-]+\.)*(?:media-amazon\.com|ssl-images-amazon\.com|images-amazon\.com)$/i;

/**
 * 仅从当前研究已保存的样本详情中按 subjectKey 精确读取可信主图 URL。
 * 不拼接、不猜测、不接受非可信外部主机；缺失或非常规地址一律返回 null 交由 ProductImage 渲染占位。
 */
export function trustedSampleImageUrl(data: MarketIntelligence, subjectKey: string): string | null {
  const raw = data.productDetails?.find((detail) => detail.subjectKey === subjectKey)?.facts?.imageUrl ?? null;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  // Stored raster snapshots are resolved from this exact subject's pinned Evidence as well.
  if (raw.length <= 4 * 1024 * 1024 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/u.test(raw)) return raw;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "https:") return null;
    if (!TRUSTED_AMAZON_IMAGE_HOST.test(parsed.hostname)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export type SavedRepresentativeItem = {
  marketSampleKey: string;
  asin: string;
  subjectKey: string;
  role: "benchmark" | "newcomer" | "pain_point";
  note: string | null;
  researchContext?: OpportunityResearchSnapshot;
};

type ReportProps = {
  data: MarketIntelligence;
  active: string;
  report?: MarketIntelligenceReport;
  reportId: string;
  onReport: (id: string) => void;
  onGenerate: () => void;
  busy: boolean;
  comparisonSubjects: string[];
  savedRepresentatives?: SavedRepresentativeItem[];
  onSwitchTab?: (tab: "商品对比") => void;
  overviewStatsStrip?: React.ReactNode;
  voiceSideExtra?: React.ReactNode;
  onAdoptRecommendation?: (report: MarketIntelligenceReport, recommendation: MarketResearchRecommendation) => void;
  /** 总览驾驶舱已提供版本切换与生成入口时，折叠区不再重复一套控制条。 */
  hideToolbar?: boolean;
};

function EvidenceToggle({ ids, data, lookup, supports, limits }: { ids: string[]; data: MarketIntelligence; lookup: EvidenceLookup; supports?: string; limits?: string[] }) {
  if (ids.length === 0) return null;
  return <details className={styles.evidenceToggle}>
    <summary>核对这项结论的依据（{ids.length} 项证据）</summary>
    <EvidenceList ids={ids} data={data} lookup={lookup} supports={supports} limits={limits} />
  </details>;
}

export function ReportFinding({ point, data, lookup }: { point: MarketReportPoint; data: MarketIntelligence; lookup: EvidenceLookup }) {
  return <div className={styles.reportPoint} data-nature={point.nature}>
    <span className={styles.tag} data-nature={point.nature}>{natureNames[point.nature] ?? point.nature}</span>
    <p>{point.text}</p>
    <EvidenceToggle ids={point.citations} data={data} lookup={lookup} supports={point.text} />
  </div>;
}

function JudgmentBlock({ judgment, data, lookup }: { judgment: MarketReportJudgment; data: MarketIntelligence; lookup: EvidenceLookup }) {
  const firstSentence = judgment.text.match(/^.*?[。！？](?:”|」)?/u)?.[0] ?? judgment.text;
  const excerpt = firstSentence.length > 110 ? `${firstSentence.slice(0,110)}…` : firstSentence;
  return <section className={styles.judgment} aria-label="当前判断">
    <div className={styles.judgmentLayout}>
      <div className={styles.judgmentPrimary}>
        <div className={styles.judgmentTitleRow}>
          <span className={styles.blockKicker}>当前判断</span>
          <span className={styles.tag} data-nature={judgment.nature}>{natureNames[judgment.nature] ?? judgment.nature}</span>
        </div>
        <h3 className={styles.judgmentText}>{excerpt}</h3>
        <p className={styles.judgmentLimit}>暂不能判断：{judgment.cannotJudge}</p>
        <details className={styles.evidenceToggle}><summary>完整判断与依据</summary><p>{judgment.text}</p><p>可以判断：{judgment.canJudge}</p><EvidenceToggle ids={judgment.citations} data={data} lookup={lookup} supports={judgment.text} /></details>
      </div>
    </div>
  </section>;
}

function FindingsBlock({ findings, data, lookup, title = "最值得关注的发现", defaultLimit }: { findings: MarketReportFinding[]; data: MarketIntelligence; lookup: EvidenceLookup; title?: string; defaultLimit?: number }) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = Boolean(defaultLimit && findings.length > defaultLimit);
  const shown = hasMore && !expanded ? findings.slice(0, defaultLimit) : findings;
  return <section className={styles.reportSection} aria-label={title}>
    <div className={styles.blockHead}>
      <div>
        <span className={styles.blockKicker}>关键发现</span>
        <h4>{title}</h4>
      </div>
      <div className={styles.headRight}>
        <span className={styles.countPill}>{shown.length}/{findings.length} 项</span>
        {hasMore && (
          <button type="button" className={styles.inlineToggleBtn} onClick={() => setExpanded((prev) => !prev)}>
            {expanded ? "收起其余发现" : `展开其余 ${findings.length - defaultLimit!} 项发现`}
          </button>
        )}
      </div>
    </div>
    {shown.length === 0 ? (
      <p className={styles.emptyState}>本次报告没有形成有依据的关键发现。请结合上方“暂时不能判断”和下方证据缺口阅读；这不等于已经证明没有问题。</p>
    ) : (
      <div className={styles.findingList}>
        {shown.map((finding, index) => (
          <article className={styles.finding} key={`${finding.title}:${index}`}>
            <header className={styles.findingHeader}>
              <span className={styles.findingIndex}>{index + 1}</span>
              <h5>{finding.title}</h5>
              <span className={styles.tag} data-nature={finding.nature}>{natureNames[finding.nature] ?? finding.nature}</span>
              <span className={styles.sectionChip}>{sectionNames[finding.section]}</span>
            </header>
            <p className={styles.findingWhat}>{finding.what}</p>
            {finding.limits[0] && <p className={styles.findingBasis}>{finding.limits[0]}</p>}
            <details className={styles.evidenceToggle}>
              <summary>查看关注原因、限制条件与依据（{finding.citations.length} 项证据）</summary>
              <div className={styles.foldedDetailBox}>
                <p><b>数据依据：</b>{finding.basis}</p>
                <p className={styles.findingWhy}><b>关注原因：</b>{finding.why}</p>
                {finding.limits.length > 0 && (
                  <div className={styles.findingSideLimit}>
                    <span className={styles.limitBadge}>限制条件</span>
                    <ul>{finding.limits.map((limit) => <li key={limit}>{limit}</li>)}</ul>
                  </div>
                )}
                <EvidenceList ids={finding.citations} data={data} lookup={lookup} supports={finding.what} limits={finding.limits} />
              </div>
            </details>
          </article>
        ))}
      </div>
    )}
  </section>;
}

function RisksBlock({ risks, data, lookup }: { risks: MarketReportRisk[]; data: MarketIntelligence; lookup: EvidenceLookup }) {
  return <section className={styles.reportSection} aria-label="风险与证据缺口">
    <div className={styles.blockHead}><div><span className={styles.blockKicker}>风险与缺口</span><h4>哪些判断现在不能当作事实</h4></div><span className={styles.countPill}>{risks.length} 项</span></div>
    {risks.length === 0 ? <p className={styles.emptyState}>本次报告没有登记额外风险；仍需阅读各工作区的限制说明。</p> : <div className={styles.riskList}>{risks.map((risk) => <article className={styles.risk} key={risk.title}>
      <header><h5>{risk.title}</h5><span className={styles.tag} data-nature={risk.nature}>{natureNames[risk.nature] ?? risk.nature}</span></header>
      <p className={styles.cardLeadText}>{risk.text}</p>
      <details className={styles.evidenceToggle}>
        <summary>查看证据缺口、受影响判断与依据（{risk.citations.length} 项证据）</summary>
        <div className={styles.foldedDetailBox}>
          <div className={styles.riskGrid}>
            <div><span className={styles.label}>证据缺口</span><p>{risk.gap}</p></div>
            <div><span className={styles.label}>受影响判断</span><p>{risk.impact}</p></div>
          </div>
          <EvidenceList ids={risk.citations} data={data} lookup={lookup} supports={risk.text} />
        </div>
      </details>
    </article>)}</div>}
  </section>;
}

function OpportunitiesBlock({ opportunities, data, lookup }: { opportunities: MarketReportOpportunity[]; data: MarketIntelligence; lookup: EvidenceLookup }) {
  return <section className={styles.reportSection} aria-label="待验证的产品机会">
    <div className={styles.blockHead}><div><span className={styles.blockKicker}>待验证机会（AI 假设）</span><h4>哪些改进方向值得进一步验证</h4></div><span className={styles.countPill}>{opportunities.length} 项</span></div>
    {opportunities.length === 0 ? <p className={styles.emptyState}>本次材料没有支持可陈述的产品机会；不能为了填满结构而提出无依据建议。</p> : <div className={styles.opportunityList}>{opportunities.map((opportunity, index) => <article className={styles.opportunity} key={opportunity.title}>
      <header><span className={styles.findingIndex}>{index + 1}</span><h5>{opportunity.title}</h5><span className={styles.tag} data-nature="inference">待验证假设</span></header>
      <p className={styles.cardLeadText}><b>改进假设：</b>{opportunity.hypothesis}</p>
      <details className={styles.evidenceToggle}>
        <summary>查看适用场景、未验证条件与依据（{opportunity.citations.length} 项证据）</summary>
        <div className={styles.foldedDetailBox}>
          <p className={styles.cardSubText}><b>买家痛点：</b>{opportunity.buyerProblem}</p>
          <dl>
            <dt>适用场景与证据</dt><dd>{opportunity.scenario}</dd>
            <dt>尚未验证的条件</dt><dd>{opportunity.unverified.length ? <ul>{opportunity.unverified.map((item) => <li key={item}>{item}</li>)}</ul> : "未登记；仍需验证"}</dd>
            {opportunity.id && <>
              <dt>反对依据</dt><dd>{opportunity.counterEvidence?.join("；") || "本次输入未登记明确反证，仍需主动核查。"}</dd>
              <dt>何时放弃或调整</dt><dd>{opportunity.rejectionConditions?.join("；") || "尚未登记"}</dd>
              <dt>开发条件与未知</dt><dd>{opportunity.developmentConstraints?.join("；") || "成本、性能及供应条件待验证"}</dd>
            </>}
          </dl>
          <EvidenceToggle ids={opportunity.citations} data={data} lookup={lookup} supports={opportunity.buyerProblem} />
        </div>
      </details>
    </article>)}</div>}
  </section>;
}

function ResearchRecommendations({ report, data, lookup, saved, onAdopt, onSwitchTab, preview = false, busy }: {
  report: MarketIntelligenceReport; data: MarketIntelligence; lookup: EvidenceLookup; saved?: SavedRepresentativeItem[];
  onAdopt?: ReportProps["onAdoptRecommendation"]; onSwitchTab?: ReportProps["onSwitchTab"]; preview?: boolean; busy: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const decision = report.recommendationDecision;
  const recommendations = report.researchRecommendations ?? [];
  const stale = report.inputHash !== data.inputHash || Boolean(data.scope?.changed);
  const shown = preview && !expanded ? recommendations.slice(0, 3) : recommendations;
  const sharedQuestions = !preview && shown.length > 1 ? [...new Set(shown[0].researchQuestions)].filter((question) => shown.every((item) => item.researchQuestions.includes(question))) : [];
  return <section className={`${styles.reportSection} ${visual.recommendations}`} aria-label="AI 推荐研究对象" data-testid="research-recommendations">
    <div className={styles.blockHead}><div><span className={styles.blockKicker}>AI 研究建议 · 人工选择</span><h4>{decision?.status === "do_not_continue" ? "目前建议暂不继续" : decision?.status === "insufficient" ? "当前还不能推荐研究对象" : "为验证机会，建议研究这些商品"}</h4></div></div>
    <p className={styles.cardLeadText}>{decision?.reason ?? "这份历史报告未包含研究对象推荐。可主动更新整份报告；已有分析与人工选择继续保留。"}</p>
    {decision && <p className={styles.note}>推荐研究价值，尚未证明开发可行。优先成熟产品改良；成本、工艺、性能与供应条件仍须在 03 核实。</p>}
    {sharedQuestions.length > 0 && <div className={visual.sharedQuestions}><b>共同验证问题</b><p>{sharedQuestions.join("；")}</p></div>}
    {shown.length > 0 && <div className={styles.recommendationGrid}>{shown.map((item) => {
      const sample = data.samples.find((sample) => sample.subjectKey === item.subjectKey);
      const formal = data.statistics?.subjects.includes(item.subjectKey) === true;
      const adopted = saved?.some((entry) => entry.subjectKey === item.subjectKey && entry.researchContext?.reportId === report.id);
      const opportunities = (report.productOpportunities ?? []).filter((opportunity) => opportunity.id && item.opportunityIds.includes(opportunity.id));
      const purpose = item.role === "benchmark" ? "直接对照" : item.role === "pain_point" ? "痛点样本" : "差异化参考";
      const disabledReason = busy ? "正在处理，请稍后。" : stale ? "报告证据或范围已变化，当前只能查看历史推荐。" : !formal ? "该商品已不在正式样本内。" : adopted ? "本版研究目的已经保存。" : !onAdopt ? "当前页面未连接选择草稿入口。" : "";
      return <article className={styles.recommendationCard} key={item.subjectKey} data-testid="research-recommendation-card">
        <div className={styles.recommendationIdentity}><ProductImage src={trustedSampleImageUrl(data, item.subjectKey)} alt={`${sample?.asin ?? asinOf(item.subjectKey)} 商品图`} className={styles.overviewSampleThumb} iconClassName="h-4 w-4" placeholderLabel="无图"/><div><span className={styles.tag}>{preview ? roleLabels[item.role] : purpose}</span><h5>{data.translations?.[`title:${item.subjectKey}`]?.text ?? (preview ? sample?.title ?? asinOf(item.subjectKey) : `${sample?.brand ?? "品牌未知"} · ${sample?.asin ?? asinOf(item.subjectKey)}`)}</h5><small>{sample?.asin ?? asinOf(item.subjectKey)}</small></div></div>
        <p><b>研究机会：</b>{opportunities.map((opportunity) => opportunity.title).join("、")}</p>
        <p>{item.rationale}</p>
        {!preview && <><p className={styles.note}>研究作用按本次问题理解；加入草稿保留已有人工角色与手填理由。</p><details className={styles.evidenceToggle}><summary>核对相反反馈、否定条件与原标题</summary><p>原标题：{sample?.title ?? "未知"}</p>{opportunities.map((opportunity) => <div key={opportunity.id ?? opportunity.title}><b>{opportunity.title}</b><p>相反反馈 / 证据：{opportunity.counterEvidence?.join("；") || "未记录，需要继续寻找反例。"}</p><p>否定条件：{opportunity.rejectionConditions?.join("；") || "尚未明确，进入03前应补充。"}</p><p>开发条件待核实：{opportunity.developmentConstraints?.join("；") || "成本、工艺与供应未确认。"}</p></div>)}</details></>}
        {item.researchQuestions.some((question) => !sharedQuestions.includes(question)) && <div className={styles.researchQuestions}><b>这款商品在 03 要弄清</b><ul>{item.researchQuestions.filter((question) => !sharedQuestions.includes(question)).map((question) => <li key={question}>{question}</li>)}</ul></div>}
        <EvidenceToggle ids={item.citations} data={data} lookup={lookup} supports={item.rationale}/>
        {preview ? <button type="button" onClick={() => onSwitchTab?.("商品对比")} className={styles.inlineToggleBtn}>去商品对比核对并选择 →</button>
          : <><button type="button" disabled={Boolean(disabledReason)} title={disabledReason || "仅加入选择草稿；核对后另行保存"} onClick={() => onAdopt?.(report, item)} className={styles.inlineToggleBtn} data-testid={`adopt-recommendation-${sample?.asin ?? asinOf(item.subjectKey)}`}>{adopted ? "本版研究目的已保存" : stale ? "报告已过期，请先更新" : !formal ? "已不在正式样本中" : "加入我的选择草稿"}</button>{disabledReason && <p className={styles.note}>不可加入：{disabledReason}</p>}</>}
      </article>;
    })}</div>}
    {preview && recommendations.length > 3 && <button type="button" className={styles.inlineToggleBtn} onClick={() => setExpanded(!expanded)}>{expanded ? "收起其余推荐" : `查看其余 ${recommendations.length - 3} 款推荐`}</button>}
    {decision && <EvidenceToggle ids={decision.citations} data={data} lookup={lookup} supports={decision.reason}/>}
    {!preview && shown.length > 0 && <p className={styles.note}>加入草稿不会写入正式选择或创建 03 任务。核对角色与理由，完成人工市场判断并保存代表商品后，使用原有交接入口。</p>}
  </section>;
}

function OverviewSamplePreviewStrip({
  data,
  report,
  savedRepresentatives,
  onSwitchTab,
}: {
  data: MarketIntelligence;
  report: MarketIntelligenceReport;
  savedRepresentatives?: SavedRepresentativeItem[];
  onSwitchTab?: (tab: "商品对比") => void;
}) {
  const hasSavedReps = Boolean(savedRepresentatives && savedRepresentatives.length > 0);
  const previewSubjects = hasSavedReps
    ? savedRepresentatives!.slice(0, 3).map((item) => ({
        subjectKey: item.subjectKey,
        roleLabel: roleLabels[item.role] ?? item.role,
      }))
    : (report.comparisonSubjects ?? []).slice(0, 3).map((subjectKey) => ({
        subjectKey,
        roleLabel: "报告对比样本",
      }));

  if (previewSubjects.length === 0) return null;

  const titleOf = (subjectKey: string) =>
    data.translations?.[`title:${subjectKey}`]?.text
    ?? data.samples.find((s) => s.subjectKey === subjectKey)?.title
    ?? asinOf(subjectKey);

  return (
    <section
      className={styles.overviewSampleStrip}
      aria-label={hasSavedReps ? "已保存正式代表商品" : "对比样本预览"}
      data-testid="overview-sample-preview-strip"
      data-preview-mode={hasSavedReps ? "saved_representatives" : "comparison_preview"}
    >
      <div className={styles.overviewSampleHead}>
        <div>
          <span className={styles.blockKicker}>
            {hasSavedReps ? "研究对象锚点 · 已保存正式代表商品" : "研究对象实物参考 · 对比样本预览（尚未保存为正式代表）"}
          </span>
          <h4>
            {hasSavedReps
              ? `已保存 ${savedRepresentatives!.length} 款正式代表商品（展示前 ${previewSubjects.length} 款）`
              : `当前尚未保存正式代表商品 · 展示报告重点对比样本（${previewSubjects.length} 款）`}
          </h4>
        </div>
        <div className={styles.headRight}>
          {!hasSavedReps && (
            <span className={styles.previewStateBadge} data-testid="overview-preview-unsaved-badge">
              对比样本预览，尚未保存为正式代表
            </span>
          )}
          {onSwitchTab && (
            <button type="button" className={styles.inlineToggleBtn} onClick={() => onSwitchTab("商品对比")}>
              前往「商品对比」查看完整规格 →
            </button>
          )}
        </div>
      </div>
      <div className={styles.overviewSampleGrid}>
        {previewSubjects.map(({ subjectKey, roleLabel }) => {
          const sample = data.samples.find((s) => s.subjectKey === subjectKey);
          const asin = sample?.asin ?? asinOf(subjectKey);
          const imageUrl = trustedSampleImageUrl(data, subjectKey);
          return (
            <div key={subjectKey} className={styles.overviewSampleCard} data-subject-key={subjectKey}>
              <ProductImage
                src={imageUrl}
                alt={`${asin} 商品缩略图`}
                className={styles.overviewSampleThumb}
                iconClassName="h-4 w-4"
                placeholderLabel="无图"
                testId={`overview-sample-image-${asin}`}
              />
              <div className={styles.overviewSampleMeta}>
                <div className={styles.overviewSampleTopRow}>
                  <span className={styles.asinPill}>{asin}</span>
                  <span className={styles.sectionChip}>{roleLabel}</span>
                  {sample?.price !== null && sample?.price !== undefined && (
                    <span className={styles.headerPricePill}>{number(sample.price)} {sample.priceCurrency ?? "USD"}</span>
                  )}
                </div>
                <p className={styles.overviewSampleTitle} title={titleOf(subjectKey)}>{titleOf(subjectKey)}</p>
                <small className={styles.overviewSampleSub}>
                  {sample?.brand ?? "品牌未知"} · 评分 {number(sample?.rating)} · 评论 {number(sample?.reviewCount)} 条
                </small>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ActionsBlock({ actions, data, lookup }: { actions: MarketReportAction[]; data: MarketIntelligence; lookup: EvidenceLookup }) {
  return <section className={styles.reportSection} aria-label="下一步">
    <div className={styles.blockHead}><div><span className={styles.blockKicker}>下一步验证清单</span><h4>按优先级，先核实什么</h4></div><span className={styles.countPill}>{actions.length} 项</span></div>
    {actions.length === 0 ? <p className={styles.emptyState}>本次报告没有给出下一步行动；请先补齐上方列出的证据缺口。</p> : <ol className={styles.actionList}>{actions.map((action, index) => <li className={styles.action} key={`${action.question}:${index}`}>
      <span className={styles.actionIndex}>{index + 1}</span>
      <div className={styles.actionBody}>
        <h5>{action.question}</h5>
        <details className={styles.evidenceToggle}><summary>验证方法与依据</summary><div className={styles.actionMetaGrid}>
          <p><b>所需证据：</b>{action.neededEvidence}</p>
          <p><b>验证方法：</b>{action.howToVerify}</p>
          <p><b>完成标准：</b>{action.doneWhen}</p>
        </div>
        {action.citations.length > 0 && <EvidenceToggle ids={action.citations} data={data} lookup={lookup} supports={action.question} />}
        </details>
      </div>
    </li>)}</ol>}
  </section>;
}

export function WorkspaceSummary({ block, section, data, lookup }: { block: MarketWorkspaceReport; section: MarketReportSection; data: MarketIntelligence; lookup: EvidenceLookup }) {
  return <section className={styles.workspaceSummary} aria-label={`${sectionNames[section]}分析`}>
    <div className={styles.blockHead}>
      <span className={styles.blockKicker}>AI 判断</span>
      <span className={styles.statusPill} data-status={block.status}>{block.status === "insufficient" ? "证据受限" : "已有结构化结论"}</span>
    </div>
    <p className={styles.workspaceSummaryLead}>{block.summary.text}</p>
    {block.status === "insufficient" && block.reason && <p className={styles.insufficientReason}><b>证据限制说明：</b>{block.reason}</p>}
    {block.limits.length > 0 && block.status !== "insufficient" && (
      <p className={styles.workspaceCompactLimits}>
        {block.limits[0]}
      </p>
    )}
    {(block.summary.citations.length > 0 || block.limits.length > 0) && <details className={styles.evidenceToggle}><summary>限制与依据</summary>{block.limits.map(limit=><p key={limit}>{limit}</p>)}<EvidenceToggle ids={block.summary.citations} data={data} lookup={lookup} supports={block.summary.text} limits={block.limits}/></details>}
  </section>;
}

function ThemeReview({ id, data, lookup }: { id: string; data: MarketIntelligence; lookup: EvidenceLookup }) {
  const review = data.reviews.find((entry) => entry.id === id);
  if (!review) return <div className={styles.themeReview}><p className={styles.note}>该历史版本的评论不在当前读取范围，原始 ID：{id}</p></div>;
  const translated = data.translations?.[`review:${id}`];
  return <div className={styles.themeReview}>
    <div className={styles.reviewMeta}>
      <b className={styles.starBadge}>{review.rating ?? "未评分"} 星</b>
      <span>商品 ASIN：{(review.subjectKeys ?? [review.subjectKey]).map(asinOf).join("、")}</span>
      <span>观察于 {time(review.evidence.capturedAt)}</span>
    </div>
    {translated ? (
      <>
        <p className={styles.translatedReviewText}>{translated.text}</p>
        <div className={styles.reviewSubRow}>
          <small className={styles.translationTag}>中文缓存译文 · {translated.model}（与 AI 主题归纳分开）</small>
          <details className={styles.enOriginalToggle}>
            <summary>查看英文原文</summary>
            <p lang="en">{review.title ? `${review.title}\n` : ""}{review.text}</p>
          </details>
        </div>
      </>
    ) : (
      <>
        <small className={styles.untranslatedTag}>尚无缓存译文 · 英文原文如下（可在下方评论列表主动翻译）</small>
        <p lang="en" className={styles.untranslatedReviewText}>{review.title ? `${review.title}\n` : ""}{review.text}</p>
      </>
    )}
    <EvidenceToggle ids={[review.evidence.id]} data={data} lookup={lookup} supports="该评论原文" />
  </div>;
}

function VoiceReport({ report, data, lookup, workspace, sectionFindings, sideExtra }: { report: MarketIntelligenceReport; data: MarketIntelligence; lookup: EvidenceLookup; workspace?: MarketWorkspaceReport; sectionFindings: MarketReportFinding[]; sideExtra?: React.ReactNode }) {
  const themes = report.voiceThemes ?? [];
  const coverage = report.voiceCoverage;
  const results = report.reviewResults ?? [];
  const [sentimentFilter, setSentimentFilter] = useState<"all" | "negative" | "positive">("all");
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);
  const themeName = new Map((report.voiceThemes ?? []).map((theme) => [theme.id, theme.label]));
  const reviewById = new Map(data.reviews.filter((review) => review.id).map((review) => [review.id!, review]));
  const negThemes = themes.filter((t) => t.sentiment === "negative");
  const posThemes = themes.filter((t) => t.sentiment !== "negative");
  const filteredThemes = sentimentFilter === "all" ? themes : sentimentFilter === "negative" ? negThemes : posThemes;

  return <section className={styles.voiceReport} aria-label="买家声音主题与覆盖">
    {!coverage && <p className={styles.warning}>该报告没有保存逐条分类覆盖信息，不能把主题数量当作完整分类结果。</p>}
    <div className={styles.voiceWorkspaceGrid}>
      <aside className={styles.voiceSidebar} aria-label="评论主题概览与口径">
        <div className={styles.voiceNavCard}>
          <div className={styles.blockHead}>
            <div>
              <span className={styles.blockKicker}>
                主题导航（{coverage ? `${coverage.sampled} 条输入子集` : "覆盖范围未记录"}）
              </span>
              <h4>抱怨痛点与认可点分布</h4>
            </div>
            <span className={styles.countPill}>{themes.length} 个主题</span>
          </div>
          <div className={styles.sentimentFilterRow} role="group" aria-label="按情感倾向筛选主题">
            <button type="button" aria-pressed={sentimentFilter === "all"} onClick={() => setSentimentFilter("all")}>全部 ({themes.length})</button>
            <button type="button" aria-pressed={sentimentFilter === "negative"} onClick={() => setSentimentFilter("negative")}>问题反馈 ({negThemes.length})</button>
            <button type="button" aria-pressed={sentimentFilter === "positive"} onClick={() => setSentimentFilter("positive")}>正向认可 ({posThemes.length})</button>
          </div>
          <div className={styles.themeNavList}>
            {filteredThemes.map((theme) => {
              const key = theme.id ?? theme.label;
              const isSelected = selectedThemeId === key;
              return (
                <button
                  type="button"
                  key={key}
                  className={`${styles.themeNavItem} ${isSelected ? styles.themeNavItemActive : ""}`}
                  data-sentiment={theme.sentiment}
                  onClick={() => {
                    setSelectedThemeId(key);
                    document.getElementById(`voice-theme-${key}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                  }}
                >
                  <div className={styles.themeNavTitleRow}>
                    <span className={styles.tag} data-sentiment={theme.sentiment}>{sentimentNames[theme.sentiment]}</span>
                    <strong>{theme.label}</strong>
                  </div>
                  <span className={styles.themeNavCount}>{theme.reviewCount} 条评论 · {theme.productCount} 款商品</span>
                </button>
              );
            })}
          </div>
        </div>
        {sideExtra}
      </aside>

      <div className={styles.voiceMain}>
        {workspace && <WorkspaceSummary block={workspace} section="voice" data={data} lookup={lookup} />}
        {themes.length === 0 ? (
          <p className={styles.emptyState}>本次输入没有形成可陈述的买家主题；这不等于买家没有抱怨或认可。</p>
        ) : (
          <div className={styles.themeList}>
            {filteredThemes.map((theme) => (
              <ThemeCard
                key={theme.id ?? theme.label}
                theme={theme}
                sampledCount={coverage?.sampled ?? null}
                data={data}
                lookup={lookup}
                defaultOpenReviews={selectedThemeId === (theme.id ?? theme.label)}
              />
            ))}
          </div>
        )}
        {sectionFindings.length > 0 && <FindingsBlock findings={sectionFindings} data={data} lookup={lookup} title="与「买家声音」相关的关键发现" />}
        {results.length > 0 && (
          <details className={styles.reviewAudit}>
            <summary>
              逐条核对本次输入 {results.length} 条评论的处理结果（归入主题 {coverage?.themed ?? "未记录"} · 已读未命中 {coverage?.noMatch ?? "未记录"} · 无法判断 {coverage?.unable ?? "未记录"}）
            </summary>
            <p className={styles.note}>归入主题、已读未命中、无法判断分别标记；无法判断不会算成“没有问题”。</p>
            <div className={styles.auditTableWrap}>
              <table className={styles.auditTable}>
                <thead>
                  <tr><th>评论摘要 / ID</th><th>星级 / 商品</th><th>分类结果</th></tr>
                </thead>
                <tbody>
                  {results.map((result) => {
                    const review = reviewById.get(result.reviewId);
                    const translated = review ? data.translations?.[`review:${review.id}`] : undefined;
                    return (
                      <tr key={result.reviewId}>
                        <td>
                          <p className={styles.auditText}>{translated?.text ?? review?.title ?? review?.text.slice(0, 80) ?? "当前数据中未找到该评论"}</p>
                          <small>{result.reviewId}</small>
                        </td>
                        <td>{review ? `${review.rating ?? "未评分"} 星 · ${(review.subjectKeys ?? [review.subjectKey]).map(asinOf).join("、")}` : "未知"}</td>
                        <td>
                          {result.status === "themed" ? (
                            <span className={styles.themed}>主题：{result.themeIds.map((id) => themeName.get(id) ?? id).join("、")}</span>
                          ) : result.status === "no_match" ? (
                            <span>已读未命中</span>
                          ) : (
                            <span className={styles.unable}>无法判断</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
    </div>
  </section>;
}

function ThemeCard({
  theme,
  sampledCount,
  data,
  lookup,
  defaultOpenReviews = false,
}: {
  theme: MarketVoiceTheme;
  sampledCount: number | null;
  data: MarketIntelligence;
  lookup: EvidenceLookup;
  defaultOpenReviews?: boolean;
}) {
  const key = theme.id ?? theme.label;
  // 按 reviewIds 关联的真实评论提取 subjectKeys 并集并严格去重
  const linkedSubjectKeys = Array.from(
    new Set(
      theme.reviewIds.flatMap((id) => {
        const review = data.reviews.find((entry) => entry.id === id);
        if (!review) return [];
        return review.subjectKeys?.length ? review.subjectKeys : [review.subjectKey];
      }).filter(Boolean),
    ),
  );
  const countMismatch = linkedSubjectKeys.length > 0 && linkedSubjectKeys.length !== theme.productCount;

  return <article id={`voice-theme-${key}`} className={styles.theme} data-sentiment={theme.sentiment}>
    <header className={styles.themeHead}>
      <div>
        <span className={styles.tag} data-sentiment={theme.sentiment}>{sentimentNames[theme.sentiment]}</span>
        <h5>{theme.label}</h5>
      </div>
      <span className={styles.themeCount}>
        {sampledCount !== null ? `本次 ${sampledCount} 条输入中命中 ${theme.reviewCount} 条独立评论` : `命中 ${theme.reviewCount} 条独立评论（输入总数未记录）`} · 涉及 {theme.productCount} 款商品
      </span>
    </header>
    <p className={styles.themeStatement}>{theme.statement.text}</p>
    {linkedSubjectKeys.length > 0 && (
      <div className={styles.themeProductsStrip} aria-label="该主题评论关联商品">
        <span className={styles.themeProductsLabel}>关联商品：</span>
        {linkedSubjectKeys.map((subjectKey) => {
          const sample = data.samples.find((s) => s.subjectKey === subjectKey);
          const asin = sample?.asin ?? asinOf(subjectKey);
          const imageUrl = trustedSampleImageUrl(data, subjectKey);
          return (
            <div key={subjectKey} className={styles.themeProductChip} data-subject-key={subjectKey}>
              <ProductImage
                src={imageUrl}
                alt={`${asin} 缩略图`}
                className={styles.themeProductThumb}
                iconClassName="h-3.5 w-3.5"
                testId={`voice-theme-image-${key}-${asin}`}
              />
              <span className={styles.themeProductChipText}>
                <b>{asin}</b>
                <small>{sample?.brand ?? "品牌未知"}</small>
              </span>
            </div>
          );
        })}
        {countMismatch && (
          <span className={styles.caliberDiffHint} data-testid={`voice-theme-count-diff-${key}`}>
            口径提示：评论关联到 {linkedSubjectKeys.length} 款商品（共享变体或跨商品），已保留报告记录 {theme.productCount} 款
          </span>
        )}
      </div>
    )}
    <details className={styles.evidenceToggle}><summary>场景、改进假设与验证事项</summary><div className={styles.themeGrid}>
      <div className={styles.themeCell} data-kind="fact">
        <span className={styles.label}>使用场景（评论提及）</span>
        <p>{theme.scenario || "未确认"}</p>
      </div>
      <div className={styles.themeCell} data-kind="inference">
        <span className={styles.label}>可能原因（AI 推断）</span>
        <p>{theme.hypothesis || "未确认"}</p>
      </div>
      <div className={styles.themeCell} data-kind="hypothesis">
        <span className={styles.label}>改进假设（待验证）</span>
        <p>{theme.improvement || "需要进一步研究"}</p>
      </div>
    </div>
    <p className={styles.verifyLine}><b>待验证事项：</b>{theme.verification.join("；")}</p>
    </details>
    <details className={styles.themeReviews} open={defaultOpenReviews ? true : undefined}>
      <summary>核对这 {theme.reviewCount} 条原始评论（中文译文优先，可展开英文原文）</summary>
      {theme.reviewIds.map((id) => <ThemeReview key={id} id={id} data={data} lookup={lookup} />)}
    </details>
    <EvidenceToggle ids={theme.statement.citations} data={data} lookup={lookup} supports={theme.statement.text} />
  </article>;
}

function ComparisonReport({ report, data, lookup, currentSubjects }: { report: MarketIntelligenceReport; data: MarketIntelligence; lookup: EvidenceLookup; currentSubjects: string[] }) {
  const reportSubjects = report.comparisonSubjects ?? [];
  const sameSet = reportSubjects.length === currentSubjects.length && [...reportSubjects].sort().join("|") === [...currentSubjects].sort().join("|");
  const titleOf = (subjectKey: string) => data.translations?.[`title:${subjectKey}`]?.text ?? data.samples.find((sample) => sample.subjectKey === subjectKey)?.title ?? asinOf(subjectKey);
  return <section className={styles.comparisonReport} aria-label="本次对比的 AI 分析">
    <div className={styles.blockHead}>
      <div>
        <span className={styles.blockKicker}>AI 对比分析（严格按报告保存时的历史商品集合展示）</span>
        <h4>{reportSubjects.length ? `报告记录的 ${reportSubjects.length} 款商品：差异与待验证项` : "本次报告没有记录对比商品"}</h4>
      </div>
      <span className={styles.countPill}>报告记录：{reportSubjects.map(asinOf).join(" / ") || "未选择"}</span>
    </div>
    <p className={styles.note}>以下为保存时的 AI 解释，尚未证明性能、成本或供应优势；以当前事实表、正反反馈及03验证为依据。</p>
    {!reportSubjects.length ? <p className={styles.note}>生成报告时没有选择对比商品，因此没有 AI 对比结论。上方商品表仍可独立核对真实字段与证据。</p> : <>
      {!sameSet && <p className={styles.warning}>报告对比的是 {reportSubjects.map(asinOf).join("、")}，当前临时对比集合（{currentSubjects.map(asinOf).join("、") || "未选择"}）已变化。以下旧结论与图片均对应报告保存时的历史商品，不能当作当前临时选择的新分析；需要点击「更新整份研究报告」才会重新分析当前集合。</p>}
      <details className={styles.evidenceToggle}><summary>展开报告保存时的差异解释与逐款分析</summary>
      <div className={sameSet ? undefined : styles.oldComparison}>
        {(report.comparisonDifferences ?? []).length > 0 && (
          <div className={styles.differences}>
            <h5>跨商品关键维度差异</h5>
            <div className={styles.differenceGrid}>
              {report.comparisonDifferences!.map((difference) => (
                <div key={difference.dimension} className={styles.differenceCard}>
                  <b>{difference.dimension}</b>
                  <p>{difference.text}</p>
                  <EvidenceToggle ids={difference.citations} data={data} lookup={lookup} supports={difference.text} />
                </div>
              ))}
            </div>
          </div>
        )}
        <details className={styles.evidenceToggle}><summary>查看逐款 AI 分析：优势、局限与待验证项（{report.comparisonItems?.length ?? 0} 款）</summary><div className={styles.compareCards}>
          {(report.comparisonItems ?? []).map((item) => {
            const asin = asinOf(item.subjectKey);
            const sample = data.samples.find((s) => s.subjectKey === item.subjectKey);
            const imageUrl = trustedSampleImageUrl(data, item.subjectKey);
            return (
              <article className={styles.compareCard} key={item.subjectKey} data-report-subject={item.subjectKey}>
                <header className={styles.compareCardHeader}>
                  <ProductImage
                    src={imageUrl}
                    alt={`${asin} 报告记录商品主图`}
                    className={styles.compareReportThumb}
                    iconClassName="h-4 w-4"
                    placeholderLabel="无图"
                    testId={`compare-report-image-${asin}`}
                  />
                  <div className={styles.compareCardTitleCol}>
                    <div className={styles.compareCardBadgeRow}>
                      <span className={styles.asinPill}>{asin}</span>
                      <span className={styles.brandBadge}>{sample?.brand ?? "品牌未知"}</span>
                      {!sameSet && <span className={styles.sectionChip}>历史报告商品</span>}
                    </div>
                    <h5 title={titleOf(item.subjectKey)}>{titleOf(item.subjectKey)}</h5>
                  </div>
                </header>
                <div className={styles.compareCardSection} data-tone="ok">
                  <span className={styles.label}>具体优势（AI 归纳）</span>
                  {item.advantages.length ? <ul>{item.advantages.map((entry) => <li key={entry}>{entry}</li>)}</ul> : <p>没有足够证据确认优势。</p>}
                </div>
                <div className={styles.compareCardSection} data-tone="gap">
                  <span className={styles.label}>具体局限（AI 归纳）</span>
                  {item.limitations.length ? <ul>{item.limitations.map((entry) => <li key={entry}>{entry}</li>)}</ul> : <p>没有足够证据确认局限。</p>}
                </div>
                <div className={styles.compareCardSection} data-tone="neutral">
                  <span className={styles.label}>缺失 / 待验证事项</span>
                  {item.unknowns.length ? <ul>{item.unknowns.map((entry) => <li key={entry}>{entry}</li>)}</ul> : <p>报告未登记额外待验证事项。</p>}
                </div>
                <EvidenceToggle ids={item.citations} data={data} lookup={lookup} supports={`${titleOf(item.subjectKey)} 的对比判断`} />
              </article>
            );
          })}
        </div></details>
      </div></details>
    </>}
  </section>;
}

function LegacyReport({ report, active, data, lookup }: { report: MarketIntelligenceReport; active: string; data: MarketIntelligence; lookup: EvidenceLookup }) {
  const section = sectionKeys[active];
  const points = report.sections?.[section] ?? (active === "研究总览" ? [report.summary] : []);
  return <div className={styles.legacyReport}>
    <p className={styles.legacyNotice}>该报告为结构化改造前的旧版（{report.schema.endsWith("v1") ? "v1 总报告" : "v2 五区段落"}）：没有结构化发现、风险/机会/行动分解，也没有逐条评论分类。以下保留旧内容供参考，不补写为 v3 能力。</p>
    {active === "买家声音" && report.voiceThemes?.length ? <section className={styles.voiceReport}><div className={styles.blockHead}><div><span className={styles.blockKicker}>旧版主题</span><h4>AI 列举的支持证据</h4></div><span className={styles.countPill}>{report.voiceThemes.length} 个主题</span></div><p className={styles.note}>旧版只列出支持每个主题的评论，不能当作完整分类或发生率；本次输入阅读范围见下方覆盖信息。</p>{report.voiceThemes.map((theme) => <article className={styles.theme} key={theme.label}><header className={styles.themeHead}><div><h5>{theme.label}</h5><span className={styles.tag} data-sentiment={theme.sentiment}>{sentimentNames[theme.sentiment]}</span></div><span className={styles.themeCount}>AI 列举支持证据 {theme.reviewCount} 条</span></header><p className={styles.themeStatement}>{theme.statement.text}</p><p><b>使用场景</b>{theme.scenario || "未确认"}</p><p><b>可能原因（推断）</b>{theme.hypothesis || "未确认"}</p><p><b>改进假设（待验证）</b>{theme.improvement || "需要进一步研究"}</p><p><b>验证事项</b>{theme.verification.join("；")}</p><details className={styles.themeReviews}><summary>查看旧版列举的 {theme.reviewCount} 条评论</summary>{theme.reviewIds.map((id) => <ThemeReview key={id} id={id} data={data} lookup={lookup} />)}</details><EvidenceToggle ids={theme.statement.citations} data={data} lookup={lookup} supports={theme.statement.text} /></article>)}</section> : null}
    {points.length ? <div className={styles.legacyPoints}>{points.map((point, index) => <ReportFinding key={`${point.text.slice(0, 20)}:${index}`} point={point} data={data} lookup={lookup} />)}</div> : active !== "买家声音" && <p className={styles.emptyState}>旧版报告没有本区结构化分析；可查看本区真实数据，或按需更新整份报告。</p>}
  </div>;
}

function CoverageDetails({ report }: { report: MarketIntelligenceReport }) {
  const v3 = report.schema === "market-intelligence-report.v3";
  const index = report.inputEvidenceIndex ?? [];
  const cited = report.citedEvidence ?? [];
  return <details className={styles.coverageDetails}>
    <summary>报告生成信息、输入覆盖范围与技术校验索引</summary>
    {report.analysisCoverage ? <div className={styles.coverageFacts}>
      <span>正式商品 <b>{report.analysisCoverage.samples}</b></span>
      <span>评论原文 <b>{report.analysisCoverage.reviewsRead}/{report.analysisCoverage.reviewsAvailable}</b></span>
      <span>关键词 <b>{report.analysisCoverage.keywordsRead}/{report.analysisCoverage.keywordsAvailable}</b></span>
      <span>统计版本 <b>{report.analysisCoverage.statisticsHash.slice(0, 12)}…</b></span>
    </div> : <p className={styles.note}>该报告没有记录分析覆盖信息。</p>}
    {report.analysisCoverage && <p className={styles.note}>{report.analysisCoverage.policy}</p>}
    <p>实际返回模型：{report.model}；配置模型：{report.configuredModel ?? report.model}；报告结构：{v3 ? "v3 结构化" : report.schema.endsWith("v2") ? "v2 五区段落" : "v1 总报告"}；生成时间：{time(report.generatedAt)}。</p>
    <p>输出用量：{report.usage?.completionTokens ?? "未取得"} tokens；耗时 {report.usage?.elapsedMs ? `${Math.round(report.usage.elapsedMs / 1000)} 秒` : "未取得"}；结束原因 {report.usage?.finishReason ?? "未取得"}。费用未提供时保持未知。</p>
    {v3 && <p>输入证据版本索引 {index.length} 条；报告实际引用 {cited.length} 条完整证据快照。技术标识和 contentHash 只在下方需要核对时展开。</p>}
    {v3 && index.length > 0 && <details><summary>输入证据版本索引（{index.length} 条）</summary><div className={styles.idList}>{index.map((entry) => <p key={entry.id}><span>{entry.id}</span><code>{entry.contentHash.slice(0, 12)}…</code></p>)}</div></details>}
    {v3 && cited.length > 0 && <details><summary>报告实际引用的证据快照（{cited.length} 条）</summary><div className={styles.idList}>{cited.map((citation) => <p key={citation.id}><span>{citation.subjectKey} · {time(citation.capturedAt)} · {citation.id}</span><code>{citation.contentHash.slice(0, 12)}…</code></p>)}</div></details>}
    {!v3 && report.inputManifest?.reviewIds?.length ? <details><summary>旧版报告实际读取的 {report.inputManifest.reviewIds.length} 条评论 ID</summary>{report.inputManifest.reviewIds.map((id) => <p key={id}>{id}</p>)}</details> : null}
  </details>;
}

export function MarketResearchReport({
  data,
  active,
  report,
  reportId,
  onReport,
  onGenerate,
  busy,
  comparisonSubjects,
  savedRepresentatives,
  onSwitchTab,
  overviewStatsStrip,
  voiceSideExtra,
  onAdoptRecommendation,
  hideToolbar = false,
}: ReportProps) {
  const lookup = buildEvidenceLookup(data);
  const section = sectionKeys[active];
  const stale = Boolean(report && report.inputHash !== data.inputHash);
  const comparisonStale = active === "商品对比" && Boolean(report) && JSON.stringify([...(report?.comparisonSubjects ?? [])].sort()) !== JSON.stringify([...comparisonSubjects].sort());
  const { disabled, reason: disabledReason, label: buttonLabel } = deriveReportActionState({
    data,
    busy,
    comparisonSubjects,
    hasReport: Boolean(report),
  });
  const v3 = report?.schema === "market-intelligence-report.v3";
  const workspace = report?.workspaces?.[section];
  const sectionFindings = (report?.findings ?? []).filter((finding) => finding.section === section);
  const hasFacts = Boolean(data.statistics?.sampleCount);

  // 紧凑报告版本与更新控制条：保留版本切换、生成/更新、禁用原因提示，但把模型/v3技术标识弱化为次级文本
  const toolbar = (
    <div className={styles.reportToolbar} data-compact={active !== "研究总览" ? "true" : "false"} aria-label="研究报告版本与更新控制">
      <div className={styles.reportToolbarLeft}>
        {data.reports.length > 0 ? (
          <label className={styles.reportVersionLabel}>
            <span>报告版本</span>
            <select aria-label="历史市场研报" value={report?.id ?? reportId} onChange={(event) => onReport(event.target.value)}>
              {[...data.reports].reverse().map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.generatedAt.slice(0, 16).replace("T", " ")}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className={styles.reportToolbarNote}>尚未生成 AI 报告（打开/切区/刷新不调用模型）</span>
        )}
        {report && (
          <span className={styles.reportToolbarNote}>
            AI 分析
          </span>
        )}
      </div>
      <div className={styles.reportToolbarRight}>
        {disabled && !busy && <small className={styles.disabledHint} title={disabledReason}>不可点击：{disabledReason}</small>}
        <button type="button" className={styles.primaryReportBtn} disabled={disabled} title={disabledReason} onClick={onGenerate}>
          {buttonLabel}
        </button>
      </div>
    </div>
  );

  return <article className={styles.ai} aria-label="五区共用市场研究报告">
    {hideToolbar ? null : toolbar}
    {!data.provider.ready && <p className={styles.warning}>{data.provider.message}</p>}
    {data.recoverableReport && <p className={styles.warning}>{data.recoverableReport.stale ? `模型已于 ${time(data.recoverableReport.generatedAt)} 完成生成，但当时研究证据已更新（${recoveryReasonNames[data.recoverableReport.reason] ?? "输入版本不一致"}），系统不会把过期输入的报告强行写回当前范围。` : `模型已于 ${time(data.recoverableReport.generatedAt)} 执行完成并通过报告校验（${data.recoverableReport.model}），但上次因「${recoveryReasonNames[data.recoverableReport.reason] ?? "保存未完成"}」尚未写入研究状态。当前研究输入未变，点击上方按钮可直接保存该结果，不会再次计费。`}</p>}
    {data.scope?.changed && <p className={styles.warning}>商品归属确认与正式统计范围尚未同步。当前报告仍绑定已保存范围；请先在商品对比核实并应用排除项。</p>}
    {data.reportReadIssues?.length ? <p className={styles.warning}>有 {data.reportReadIssues.length} 份历史报告因结构或版本不受支持而无法读取。它们没有被删除，也不影响下方可读报告；不会因此说“从未生成”。</p> : null}
    {(stale || comparisonStale) && <p className={styles.warning}>{stale ? "研究证据已变化，当前显示的是历史报告，不能当作当前版本的新结论。" : "当前临时对比的商品集合与报告记录不同；旧对比结论只作历史参考。"}更新需要你明确点击上方按钮；原报告、人工决定和输入都会保留。</p>}

    {!report ? (
      <div className={styles.reportEmpty}>
        <p>{hasFacts ? "尚未生成真实市场报告。当前页面展示的锁定样本统计与原始证据均可直接核对；需要 AI 生成结构化判断、关键发现、风险、机会和下一步验证清单时，请点击右上方按钮。" : "当前没有可用于报告的有效样本；先补齐证据，系统不会用空内容生成报告。"}</p>
      </div>
    ) : v3 ? (
      <>
        {active === "研究总览" && (
          <>
            {overviewStatsStrip}
            {report.judgment && <JudgmentBlock judgment={report.judgment} data={data} lookup={lookup} />}
            <div className={visual.overviewPriority}>
              <div><OpportunitiesBlock opportunities={report.productOpportunities ?? []} data={data} lookup={lookup} /></div>
              <div><RisksBlock risks={report.riskGaps ?? []} data={data} lookup={lookup} /></div>
            </div>
            <FindingsBlock findings={report.findings ?? []} data={data} lookup={lookup} defaultLimit={2} />
            <ResearchRecommendations key={report.id} report={report} data={data} lookup={lookup} saved={savedRepresentatives} preview onSwitchTab={onSwitchTab} busy={busy}/>
            <OverviewSamplePreviewStrip
              data={data}
              report={report}
              savedRepresentatives={savedRepresentatives}
              onSwitchTab={onSwitchTab}
            />
            <ActionsBlock actions={report.nextActions ?? []} data={data} lookup={lookup} />
          </>
        )}
        {active !== "研究总览" && (
          <>
            {active === "买家声音" ? (
              <VoiceReport report={report} data={data} lookup={lookup} workspace={workspace} sectionFindings={sectionFindings} sideExtra={voiceSideExtra} />
            ) : active === "商品对比" ? (
              <>
                <ResearchRecommendations key={report.id} report={report} data={data} lookup={lookup} saved={savedRepresentatives} onAdopt={onAdoptRecommendation} busy={busy}/>
                <ComparisonReport report={report} data={data} lookup={lookup} currentSubjects={comparisonSubjects} />
                {workspace ? <WorkspaceSummary block={workspace} section={section} data={data} lookup={lookup} /> : <p className={styles.warning}>该报告缺少「{active}」的专属分析，属于结构异常；请更新整份报告。其余可读部分仍保留。</p>}
                {sectionFindings.length > 0 && <FindingsBlock findings={sectionFindings} data={data} lookup={lookup} title={`与「${active}」相关的关键发现`} />}
              </>
            ) : (
              <>
                {workspace ? <WorkspaceSummary block={workspace} section={section} data={data} lookup={lookup} /> : <p className={styles.warning}>该报告缺少「{active}」的专属分析，属于结构异常；请更新整份报告。其余可读部分仍保留。</p>}
                {sectionFindings.length > 0 && <FindingsBlock findings={sectionFindings} data={data} lookup={lookup} title={`与「${active}」相关的关键发现`} />}
              </>
            )}
          </>
        )}
        <CoverageDetails report={report} />
      </>
    ) : (
      <>
        {active === "商品对比" && report.comparisonSubjects?.length ? <p className={styles.note}>该旧版报告记录的对比商品：{report.comparisonSubjects.map(asinOf).join("、")}。旧版没有逐商品优势/局限结构。</p> : null}
        <LegacyReport report={report} active={active} data={data} lookup={lookup} />
        <CoverageDetails report={report} />
      </>
    )}
  </article>;
}
