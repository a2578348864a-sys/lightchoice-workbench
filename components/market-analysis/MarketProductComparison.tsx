"use client";

import { useState } from "react";
import type { MarketIntelligence, MarketIntelligenceReport, MarketIntelligenceSample } from "@/lib/marketScan/intelligence";
import { ProductImage } from "@/components/source-layer/ProductImage";
import { trustedSampleImageUrl } from "./MarketResearchReport";
import { COMPARISON_FIELDS, DIFFERENCE_LABELS, compareField, comparisonCell, questionFields, type ComparisonField } from "./marketComparisonPresentation";
import styles from "./MarketIntelligencePanel.module.css";
import local from "./MarketComparison.module.css";
import visual from "./MarketResearchVisual.module.css";

const time = (value: string | null) => value ? `${value.slice(0, 10)} ${value.slice(11, 16)} UTC` : "时间未知";
const allFields = Object.keys(COMPARISON_FIELDS) as ComparisonField[];

export function MarketProductComparison({ comparison, data, report }: {
  comparison: MarketIntelligenceSample[]; data: MarketIntelligence; report?: MarketIntelligenceReport;
}) {
  const current = Boolean(report && report.inputHash === data.inputHash && !data.scope?.changed);
  const opportunities = report?.productOpportunities ?? [];
  const [opportunityId, setOpportunityId] = useState(current ? opportunities[0]?.id ?? "basic" : "basic");
  const [customQuestion, setCustomQuestion] = useState("");
  const opportunity = opportunities.find((item) => item.id === opportunityId);
  const question = customQuestion.trim() || (opportunity ? `${opportunity.title}：${opportunity.buyerProblem}` : "这些商品的尺寸、材质和标价有哪些值得核实的差异？");
  const relevantFields = questionFields(question);
  const fields = relevantFields.filter((field) => compareField(data, comparison, field) !== "close");
  const closeFields = relevantFields.filter((field) => !fields.includes(field));
  const row = (field: ComparisonField) => {
    const state = compareField(data, comparison, field);
    const meta = COMPARISON_FIELDS[field];
    return <tbody key={field} data-comparison-field={field}>
      <tr><th scope="row">{meta.label}<span className={local.difference} data-state={state}>{DIFFERENCE_LABELS[state]}</span></th>
        {comparison.map((sample) => <td key={sample.subjectKey}><span className={visual.compareFact}>{comparisonCell(data, sample, field).display}</span></td>)}
      </tr>
      <tr className={local.explanation}><td colSpan={comparison.length + 1}>
        <p>{state === "conflict" ? "来源读数冲突，先核对依据。" : state === "unknown" ? "字段缺失或口径未对齐，暂时无法判断。" : state === "close" ? "读数相同或接近，不能据此陈述优势。" : field === "dimensions" ? "尺寸不同，可能影响实际使用适配。" : field === "price" ? "标价不同，套装与配置仍待对齐。" : "来源声明不同，实际性能仍待验证。"}</p>
        <details className={visual.verifyLine}><summary>{field === "dimensions" ? "03：同一场景实测适配" : field === "price" ? "03：核对配置后再询价" : field === "weight" ? "03：分别称量单件与整包" : "03：核对反例与同条件测试"}</summary><p>{meta.limit}</p><p>{meta.question}</p></details>
      </td></tr>
    </tbody>;
  };
  const table = (fields: ComparisonField[], label: string) => <div className={local.factTableScroll}><table className={local.factTable} aria-label={label}>
    <thead><tr><th>比较问题 / 字段</th>{comparison.map((sample) => <th key={sample.subjectKey}>
      <div className={local.productHeader}><div><b>{sample.asin}</b><span>{sample.brand ?? "品牌未知"}</span></div></div>
    </th>)}</tr></thead>{fields.map(row)}
  </table></div>;
  return <section className={local.comparison} aria-label="研究问题与商品关键差异">
    {comparison.length > 0 && <div className={visual.compareIdentities} aria-label="当前三款商品身份">{comparison.map((sample) => <article className={visual.compareIdentity} key={sample.subjectKey} data-product-subject={sample.subjectKey}>
      <ProductImage src={trustedSampleImageUrl(data, sample.subjectKey)} alt={`${sample.asin} 商品主图`} className={visual.compareImage} placeholderLabel="暂无可信图片" testId={`compare-product-image-${sample.asin}`} /><div><span>{sample.asin}</span><b>{data.translations?.[`title:${sample.subjectKey}`]?.text ?? sample.brand ?? "品牌未知"}</b><strong>{sample.price?.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) ?? "未知"} <small>{sample.priceCurrency ?? "币种未知"}</small></strong></div>
    </article>)}</div>}
    <div className={visual.compactQuestion}><div><span className={visual.eyebrow}>当前研究问题</span><b>{customQuestion.trim() || opportunity?.title || "尺寸、材质与标价，哪些差异值得验证？"}</b></div><details><summary>调整研究问题与查看假设</summary><div className={visual.editor}>
    <div className={local.questionBox}>
      <h3>本次要通过对比弄清什么？</h3>
      <label>沿用已有机会<select value={opportunity ? opportunityId : "basic"} onChange={(event) => { setOpportunityId(event.target.value); setCustomQuestion(""); }} aria-label="对比研究机会">
        <option value="basic">基础事实对比（无需 AI 报告）</option>
        {opportunities.filter((item) => item.id).map((item) => <option key={item.id} value={item.id}>{current ? "" : "历史参考 · "}{item.title}</option>)}
      </select></label>
      <label>当前研究问题（仅用于本页查看）<input aria-label="当前对比研究问题" value={customQuestion} onChange={(event) => setCustomQuestion(event.target.value)} placeholder={question} maxLength={300} /></label>
      <p><b>{question}</b></p>
      {!opportunity && <p>尚未采用可用机会，先做基础事实核对。痛点证据、反例和验证条件仍需补充；可以继续对比，无需先生成报告。</p>}
      {opportunity && <><p>待验证假设：{opportunity.hypothesis}</p>{!current && <p className={styles.warning}>该机会来自历史报告，仅作问题参考；来源或范围已变化，不能当作当前推荐。</p>}<details><summary>查看该机会的反证、否定条件与缺口</summary><p>相反证据：{opportunity.counterEvidence?.join("；") || "未记录，仍需寻找反例"}</p><p>否定条件：{opportunity.rejectionConditions?.join("；") || "尚未明确，进入03前应补充"}</p><p>待核实：{opportunity.unverified.join("；") || "未记录"}</p></details></>}
      <p className={local.muted}>机会、问题和参数展开只改变本页阅读；不改变正式样本、推荐数量、人工角色或选择理由。</p>
    </div>
    </div></details></div>
    {comparison.length > 0 ? <>
      <div className={local.sectionHeading}><h3>关键差异</h3><span>默认最多 3 项 · 当前 {fields.length} 项 · {comparison.length} 款临时对比</span></div>
      {closeFields.length > 0 && <p className={local.muted}>接近：{closeFields.map((field) => COMPARISON_FIELDS[field].label).join("、")} · 完整参数可展开核对</p>}
      {table(fields, "当前问题的三款商品关键差异")}
      <details className={local.parameters}>
        <summary>展开其余参数、相同字段与判读方法</summary>
        <p>“接近”包括相同记录。数字相差不超过5%、评分相差不超过0.1分时合并提示接近，仅用于避免放大小差异；这不是评分、质量门槛或优势判断。尺寸按可识别单位换算后比较各轴，测量对象仍需核实；重量因单件/整包口径未知不作排序。</p>
        {table(allFields.filter((field) => !fields.includes(field)), "其余商品参数")}
      </details>
      <details className={local.parameters}>
        <summary>查看原标题、完整卖点、正反评论和字段依据</summary>
        <div className={local.sourceGrid}>{comparison.map((sample) => {
          const detail = data.productDetails?.find((entry) => entry.subjectKey === sample.subjectKey);
          const feedback = data.reviews.filter((review) => (review.subjectKeys ?? [review.subjectKey]).includes(sample.subjectKey));
          const negative = feedback.find((review) => review.rating != null && review.rating <= 3);
          const positive = feedback.find((review) => review.rating != null && review.rating >= 4);
          return <article key={sample.subjectKey}><h4>{sample.asin}</h4><p><b>英文原标题：</b>{sample.title ?? "未知"}</p>
            <p><b>品牌：</b>{sample.brand ?? "未知"} · {data.marketplace} 站点</p>
            <p><b>变体结构：</b>{detail?.facts.variationStructure ? `来源记录 ${detail.facts.variationStructure.memberAsins.length} 个成员；父体 ${detail.facts.variationStructure.parentAsin ?? "未知"}` : "未知"}</p>
            {detail?.facts.variationStructure && <details><summary>展开变体成员与选项</summary><p>{detail.facts.variationStructure.memberAsins.join("、")}</p>{detail.facts.variationStructure.members.map((member) => <p key={member.asin}>{member.asin}：{member.options.map((option) => `${option.label ?? option.dimensionKey} ${option.value}`).join("；")}</p>)}<p>{detail.facts.variationStructure.limitation ?? "以已保存来源范围为限"}</p></details>}
            <p><b>来源卖点声明：</b>未经实测核验</p>{detail?.facts.bulletPoints.length ? <ul>{detail.facts.bulletPoints.map((point, index) => <li key={index}>{point}</li>)}</ul> : <p>卖点未知</p>}
            <p><b>买家反馈：</b>本次已保存 {feedback.length} 条，非随机样本，不推断发生率。</p>
            {[negative, positive].map((review, index) => <div key={index}><b>{index === 0 ? "问题反馈" : "正向反馈（可能的反例，待核对）"}</b>{review ? <><p>{(review.id && data.translations?.[`review:${review.id}`]?.text) || review.text}</p><p>{time(review.evidence.capturedAt)} · {review.evidence.evidenceId}</p></> : <p>当前没有对应反馈；仍需寻找证据。</p>}</div>)}
            <p><b>实测结果：</b>当前接口未提供；进入03后验证。</p>
            <p>锁定来源：{time(sample.evidence.capturedAt)} · {sample.evidence.evidenceId}</p>
            {Object.entries(detail?.facts.fieldEvidence ?? {}).map(([field, refs]) => <p key={field}>{field}：{refs?.map((ref) => `${ref.source} · ${time(ref.capturedAt)} · ${ref.refId}`).join("；") || "依据未知"}</p>)}
            {detail?.facts.conflicts.map((conflict) => <div key={conflict.field}><b>冲突：{conflict.field}</b>{conflict.candidates.map((candidate, index) => <p key={index}>{candidate.source} · {JSON.stringify(candidate.value)} · {time(candidate.capturedAt)} · {candidate.evidenceRefs.map((ref) => ref.refId).join("；")}</p>)}</div>)}
            {sample.reviewCountCaliber?.productPageValue != null && <p>商品页评价读数 {sample.reviewCountCaliber.productPageValue.toLocaleString("zh-CN")} · {time(sample.reviewCountCaliber.productPageCapturedAt)} · {sample.reviewCountCaliber.productPageEvidenceId}；不自动替换锁定值。</p>}
            {sample.evidence.sourceUrl && <a href={sample.evidence.sourceUrl} target="_blank" rel="noreferrer">打开来源页面</a>}
          </article>;
        })}</div>
      </details>
    </> : <p className={styles.emptyState}>在上方选择1–3款商品即可核对事实。正式样本、AI推荐和已保存代表商品继续保留。</p>}
  </section>;
}
