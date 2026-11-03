"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Languages } from "lucide-react";
import type { MarketIntelligence, MarketIntelligenceReport } from "@/lib/marketScan/intelligence";
import { voicePhraseSegments } from "@/lib/marketScan/researchStatistics";
import { EvidenceList, type EvidenceLookup } from "./MarketReportEvidence";
import { MarketSectionFindings } from "./MarketAreaShell";
import styles from "./MarketVoiceWorkspace.module.css";

const number = (n: number | null | undefined) => n == null ? "未知" : n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const time = (value: string) => value.length >= 16 ? `${value.slice(0, 10)} ${value.slice(11, 16)} UTC` : value;
const asinOf = (subjectKey: string) => subjectKey.split(":").at(-1) ?? subjectKey;

/**
 * 原文强调：只标出当前主题短语规则的字面命中片段。
 * 命中不等于缺陷结论；未选中主题时按普通文本渲染。
 */
function ReviewText({ text, ruleId, className }: { text: string; ruleId: string; className: string }) {
  const segments = useMemo(() => (ruleId ? voicePhraseSegments(ruleId, text) : [{ text, hit: false }]), [ruleId, text]);
  if (!ruleId) return <p className={className}>{text}</p>;
  return (
    <p className={className}>
      {segments.map((segment, index) => segment.hit
        ? <mark key={index} className={styles.mark}>{segment.text}</mark>
        : <span key={index}>{segment.text}</span>)}
    </p>
  );
}

/**
 * 02 买家声音区（P1-02 视觉返工）：主题索引 → 真实原声阅读 → 证据分析 三层。
 * 三套数字必须分开：已取得评论观察、原文短语规则命中、AI 逐条分类输入。
 * 短语命中只作待核实线索，不把评论自动认定为工程缺陷。
 */
export function MarketVoiceWorkspace({
  data,
  stats,
  lookup,
  report,
  act,
  busy,
  reportStale,
  onOpenReport,
}: {
  data: MarketIntelligence;
  stats: NonNullable<MarketIntelligence["statistics"]>;
  lookup: EvidenceLookup;
  report: MarketIntelligenceReport | undefined;
  act: (action: string, extra?: Record<string, unknown>) => Promise<void>;
  busy: boolean;
  reportStale?: boolean;
  onOpenReport: () => void;
}) {
  const [reviewStars, setReviewStars] = useState("low");
  const [reviewLimit, setReviewLimit] = useState(6);
  const [selectedReviews, setSelectedReviews] = useState<string[]>([]);
  const [theme, setTheme] = useState("");
  const subjects = useMemo(() => new Set(stats.subjects), [stats.subjects]);
  const reviewCandidates = useMemo(() => data.reviews.filter((review) => subjects.has(review.subjectKey)), [data.reviews, subjects]);
  const translatedReviews = reviewCandidates.filter((review) => review.id && data.translations?.[`review:${review.id}`]).length;

  const activeRule = stats.voc.find((rule) => rule.id === theme) ?? null;
  const themedIds = useMemo(() => new Set(activeRule?.reviewIds ?? []), [activeRule]);

  // 分析栏是限高粘性侧栏：内容超出时必须让读者知道「还能往下看」，到底后收起提示。
  const analysisRef = useRef<HTMLElement | null>(null);
  const [analysisScroll, setAnalysisScroll] = useState({ more: false, atEnd: true });
  useEffect(() => {
    const el = analysisRef.current;
    if (!el) return;
    const update = () => {
      const more = el.scrollHeight > el.clientHeight + 4;
      setAnalysisScroll({ more, atEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 4 });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [theme, reviewLimit, report, data]);

  const filtered = reviewCandidates
    .filter((review) => activeRule ? themedIds.has(review.id ?? review.evidence.id) : true)
    .filter((review) => reviewStars === "all"
      || (reviewStars === "low" ? review.rating !== null && review.rating >= 1 && review.rating <= 3
        : reviewStars === "high" ? review.rating !== null && review.rating >= 4
          : review.rating !== null && Math.floor(review.rating) === Number(reviewStars)))
    .sort((a, b) => (a.rating ?? 6) - (b.rating ?? 6));
  const shown = filtered.slice(0, reviewLimit);
  const untranslatedVisible = shown.filter((review) => review.id && !data.translations?.[`review:${review.id}`]);
  const coverage = report?.voiceCoverage;
  // 可调查问题只取已存报告里记录的验证动作，不新增模型调用、不自行编造问题。
  const openQuestions = [...new Set((report?.voiceThemes ?? []).flatMap((theme) => theme.verification))].slice(0, 3);
  const aiThemes = (report?.voiceThemes ?? []).slice(0, 3);
  const lowStarShare = stats.reviews.total ? stats.reviews.lowStars / stats.reviews.total : 0;
  const canTranslate = !busy && data.provider.ready && !data.aiOperations?.length;
  const translateTitle = !data.provider.ready ? data.provider.message
    : data.aiOperations?.length ? "已有 AI 请求未确认结束，请先解除阻塞。"
      : !untranslatedVisible.length ? "当前可见评论均已有中文缓存译文，无需重复翻译。"
        : data.provider.message;

  return (
    <div className={styles.area}>
      <header className={styles.head}>
        <div className={styles.headMain}>
          <span className={styles.kicker}>买家声音 · 低星优先</span>
          <h2>买家在抱怨什么，哪些还不能当结论？</h2>
        </div>
        <span className={styles.headNote}>非随机子集 · 不推断发生率</span>
      </header>

      <section className={styles.coverage} aria-label="三套评论口径">
        <article>
          <span>① 已取得评论观察</span>
          <b>{number(stats.reviews.total)}<small>条</small></b>
          <p>1–3 星 {stats.reviews.lowStars} · 4–5 星 {stats.reviews.highStars} · 中文译文缓存 {translatedReviews} 条</p>
          <div className={styles.splitBar} role="img" aria-label={`低星 ${stats.reviews.lowStars} 条，高星 ${stats.reviews.highStars} 条`}>
            <i style={{ width: `${lowStarShare * 100}%` }} />
          </div>
        </article>
        <article>
          <span>② 原文短语规则命中</span>
          <b>{number(stats.voc.reduce((sum, rule) => sum + rule.count, 0))}<small>次</small></b>
          <p>确定性短语匹配，同一评论可命中多条；不等于 AI 主题</p>
        </article>
        <article data-tone={coverage ? "ok" : "warn"}>
          <span>③ AI 逐条分类输入</span>
          <b>{coverage ? `${coverage.sampled}/${coverage.available}` : "条数未记录"}<small>{coverage ? "条" : ""}</small></b>
          <p>{coverage ? `归入主题 ${coverage.themed} · 未命中 ${coverage.noMatch} · 无法判断 ${coverage.unable} · 覆盖 ${coverage.sampledProducts} 款商品` : "仅列举支持证据，未记录输入范围"}</p>
        </article>
      </section>

      <section className={styles.themes} aria-label="主题索引">
        <div className={styles.themeHead}>
          <h3>主题索引</h3>
          <p>点主题只看命中该短语的原声；短语命中是待核实线索，不是工程缺陷结论。</p>
        </div>
        <div className={styles.chips}>
          <button type="button" aria-pressed={!theme} onClick={() => { setTheme(""); setReviewLimit(6); }}>
            全部评论 <em>{stats.reviews.total}</em>
          </button>
          {stats.voc.map((rule) => (
            <button key={rule.id} type="button" aria-pressed={theme === rule.id} disabled={rule.count === 0} onClick={() => { setTheme(rule.id); setReviewLimit(6); }}>
              {rule.label} <em>{rule.count}</em><small>{rule.productCount} 款</small>
            </button>
          ))}
        </div>
      </section>

      <div className={styles.reading}>
        <section className={styles.reader} aria-label="评论原声">
          <header className={styles.readerHead}>
            <div>
              <h3>{activeRule ? `「${activeRule.label}」命中的原声` : "按星级阅读原始评论"}</h3>
              <p>翻译只在明确点击后发生；已缓存译文直接读取，不重复计费。中文译文与 AI 主题归纳严格区分。</p>
            </div>
            <div className={styles.readerState}>
              {activeRule ? (
                <button type="button" className={styles.clearTheme} onClick={() => { setTheme(""); setReviewLimit(6); }}>
                  清除主题 · 看全部
                </button>
              ) : null}
              <span className={styles.countPill}>当前 {filtered.length} 条</span>
            </div>
          </header>

          <div className={styles.readerTools}>
            <label>
              <span>星级</span>
              <select aria-label="按星级筛选评论" value={reviewStars} onChange={(event) => { setReviewStars(event.target.value); setReviewLimit(6); }}>
                <option value="low">优先 1–3 星（{stats.reviews.lowStars} 条）</option>
                <option value="high">4–5 星与好评原因（{stats.reviews.highStars} 条）</option>
                <option value="all">全部评论（{stats.reviews.total} 条）</option>
                {[1, 2, 3, 4, 5].map((star) => <option key={star} value={String(star)}>{star} 星</option>)}
              </select>
            </label>
            <button
              type="button"
              className={styles.translateBtn}
              disabled={!canTranslate || !untranslatedVisible.length}
              title={translateTitle}
              onClick={() => void act("translate", { targetIds: untranslatedVisible.slice(0, 12).map((review) => `review:${review.id}`) })}
            >
              <Languages size={14} />翻译可见未译评论（≤12）
            </button>
            {selectedReviews.length > 0 && (
              <button
                type="button"
                className={styles.translateBtn}
                disabled={!canTranslate}
                onClick={() => void act("translate", { targetIds: selectedReviews.filter((id) => reviewCandidates.some((review) => review.id === id) && !data.translations?.[`review:${id}`]).slice(0, 20).map((id) => `review:${id}`) })}
              >
                翻译所选未译（≤20）
              </button>
            )}
          </div>

          {activeRule && (
            <p className={styles.themeHint}>
              短语规则「{activeRule.label}」在 {activeRule.denominator} 条观察中命中 {activeRule.count} 条，涉及 {activeRule.productCount} 款商品。
              {activeRule.method}
            </p>
          )}

          <div className={styles.reviewList}>
            {shown.map((review) => {
              const translated = review.id ? data.translations?.[`review:${review.id}`] : undefined;
              return (
                <article
                  className={styles.review}
                  key={review.id ?? review.evidence.id}
                  data-hit={activeRule && themedIds.has(review.id ?? review.evidence.id) ? true : undefined}
                >
                  <header className={styles.reviewMeta}>
                    <label className={styles.select}>
                      <input
                        type="checkbox"
                        aria-label={`选择评论 ${review.id}`}
                        checked={review.id ? selectedReviews.includes(review.id) : false}
                        onChange={(event) => setSelectedReviews((ids) => event.target.checked ? [...ids, review.id!] : ids.filter((id) => id !== review.id))}
                      />
                      选择
                    </label>
                    <b className={styles.star} data-low={(review.rating ?? 5) <= 3 || undefined}>{review.rating ?? "未评分"} 星</b>
                    <span className={styles.asin}>{asinOf(review.subjectKey)}</span>
                    {activeRule && themedIds.has(review.id ?? review.evidence.id) ? (
                      <span className={styles.hitTag}>命中「{activeRule.label}」</span>
                    ) : null}
                    <span className={styles.time}>{time(review.evidence.capturedAt)}</span>
                  </header>
                  {translated ? (
                    <>
                      <ReviewText text={translated.text} ruleId={theme} className={styles.text} />
                      <div className={styles.textFoot}>
                        <small className={styles.tag}>中文译文 · {translated.model}</small>
                      </div>
                    </>
                  ) : (
                    <>
                      <small className={styles.untranslated}>未翻译 · 英文原文</small>
                      <ReviewText text={review.title ? `${review.title}\n${review.text}` : review.text} ruleId={theme} className={styles.text} />
                    </>
                  )}
                  <details className={styles.evidence}>
                    <summary>{translated ? "完整原文 · 来源 · 相关商品 · 证据" : "来源 · 相关商品 · 证据"}</summary>
                    {translated ? (
                      <div className={styles.originalBlock}>
                        <span>英文原文</span>
                        <p lang="en">{review.title ? `${review.title}\n` : ""}{review.text}</p>
                      </div>
                    ) : null}
                    <dl className={styles.reviewSource}>
                      <div><dt>相关商品</dt><dd>{asinOf(review.subjectKey)}</dd></div>
                      <div><dt>主体标识</dt><dd>{review.subjectKey}</dd></div>
                      <div><dt>取得时间</dt><dd>{time(review.evidence.capturedAt)}</dd></div>
                      <div><dt>原始性质</dt><dd>买家原始评论（非 AI 归纳）</dd></div>
                    </dl>
                    <EvidenceList ids={[review.evidence.id]} data={data} lookup={lookup} supports="这条评论原文" />
                  </details>
                </article>
              );
            })}
          </div>

          {shown.length === 0 && (
            <p className={styles.empty}>
              {activeRule ? "该主题在当前星级筛选下没有可读原声；切到全部星级或查看其他主题。" : "当前筛选下没有取得可用评论。切换全部或查看 4–5 星；没有低星证据不能说明产品没有问题。"}
            </p>
          )}
          {shown.length > 0 && shown.length < filtered.length && (
            <button type="button" className={styles.moreBtn} onClick={() => setReviewLimit((current) => current + 6)}>查看更多评论（每次 6 条）</button>
          )}
        </section>

        <aside
          className={styles.analysis}
          aria-label="证据分析"
          ref={analysisRef}
          tabIndex={analysisScroll.more ? 0 : undefined}
          data-scroll={analysisScroll.more ? "1" : undefined}
        >
          <article className={styles.analysisCard}>
            <h3>能得出 / 不能得出</h3>
            <div className={styles.canDo}>
              <b>能得出</b>
              <p>{shown.length
                ? "当前可读原话反映对应买家的个人表述，可作为 03 深研进一步核实的线索。"
                : reviewCandidates.length
                  ? "当前筛选下没有可读原话；切换星级或主题后再判断。"
                  : "尚未取得可读评论，暂时不能从原话判断问题；需要先补充评论证据。"}</p>
            </div>
            <div className={styles.cannotDo}>
              <b>不能得出</b>
              <p>不能推断全体买家的发生率、不能认定是材料或工艺缺陷；低星优先是非随机子集。</p>
            </div>
          </article>

          <article className={styles.analysisCard}>
            <h3>数量与严重度分开看</h3>
            <ul className={styles.severityList}>
              {stats.voc.filter((rule) => rule.count > 0).map((rule) => (
                <li key={rule.id} data-active={theme === rule.id || undefined}>
                  <button type="button" aria-pressed={theme === rule.id} onClick={() => { setTheme(rule.id); setReviewLimit(6); }}>
                    <span>{rule.label}<em>{rule.productCount} 款商品</em></span>
                    <b>{rule.count}<small>/{rule.denominator}</small></b>
                  </button>
                  <i><span style={{ width: `${Math.max(3, (rule.count / Math.max(1, rule.denominator)) * 100)}%` }} /></i>
                </li>
              ))}
              {!stats.voc.some((rule) => rule.count > 0) && <li className={styles.severityEmpty}>未命中预设短语；不等于买家没有痛点。</li>}
            </ul>
            <p className={styles.analysisNote}>命中次数只说明「有多少条评论这样写」，不说明问题多严重或发生多频繁。</p>
          </article>

          <article className={styles.analysisCard}>
            <h3>可调查问题（来自已存报告）</h3>
            {openQuestions.length ? (
              <ul className={styles.questionList}>
                {openQuestions.map((item) => <li key={item}>{item}</li>)}
              </ul>
            ) : (
              <p className={styles.analysisNote}>{report
                ? reviewCandidates.length
                  ? "这份报告没有记录可调查的验证动作；已取得的原声仍可作为 03 的线索。"
                  : "这份报告没有记录可调查的验证动作，当前也没有可读评论原文。"
                : "还没有已存报告；生成报告后会给出可验证的下一步。"}</p>
            )}
            <p className={styles.analysisNote}>这些是待验证动作，不是已确认的工程缺陷或改进结论。</p>
          </article>

          <article className={styles.analysisCard}>
            <h3>来源与覆盖</h3>
            <dl className={styles.coverageList}>
              <div><dt>评论观察</dt><dd>{stats.reviews.total} 条</dd></div>
              <div><dt>有评分</dt><dd>{stats.reviews.rated} 条</dd></div>
              <div><dt>覆盖商品</dt><dd>{stats.sampleCount} 款</dd></div>
              <div><dt>AI 输入</dt><dd>{coverage ? `${coverage.sampled} 条` : "未记录"}</dd></div>
            </dl>
            <p className={styles.analysisNote}>{coverage?.samplePolicy ?? stats.reviews.policy}</p>
            <details className={styles.sourceDetails}>
              <summary>逐条来源、限制与版本</summary>
              <p>统计版本 {stats.schema} · 指纹 {stats.hash} · 冻结样本 {data.sampleHash}</p>
            </details>
          </article>

          {aiThemes.length ? (
            <article className={styles.analysisCard}>
              <h3>AI 主题（已存报告）</h3>
              <ul className={styles.aiThemes}>
                {aiThemes.map((item) => (
                  <li key={item.id ?? item.label}>
                    <b>{item.label}</b>
                    <em>{item.reviewCount} 条 · {item.productCount} 款</em>
                    <span>{item.statement.text}</span>
                  </li>
                ))}
              </ul>
              <p className={styles.analysisNote}>AI 按输入子集归类，与上方「原文短语命中」不是同一口径；不是已确认根因。</p>
            </article>
          ) : null}

          {analysisScroll.more && !analysisScroll.atEnd ? (
            <p className={styles.scrollHint} aria-hidden="true">分析栏可独立滚动 · 还有下文 ↓</p>
          ) : null}
        </aside>
      </div>

      <MarketSectionFindings report={report} section="voice" stale={Boolean(reportStale)} generatedAt={report?.generatedAt} onOpenReport={onOpenReport} />
    </div>
  );
}
