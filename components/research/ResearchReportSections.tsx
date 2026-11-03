"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Calculator,
  ChevronDown,
  ChevronUp,
  ListChecks,
  Loader2,
  MessageSquareQuote,
  ShieldAlert,
  ShieldCheck,
  ThumbsUp,
} from "lucide-react";

import styles from "./ResearchReportSections.module.css";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import { formatBuyerVoiceLoadError } from "@/components/research/BuyerVoicePanel";
import { localizeVoiceSource } from "@/lib/client/bilingualDisplay";
import type { EvidenceCheckpoint, EvidenceRequirement, EvidenceTheme } from "./EvidenceOpportunityWorkspace";
import { plainText } from "./ResearchOverviewFocus";
import type { ImprovementPlan } from "@/lib/research/improvementPlan";
import type { ResearchClaimAudit } from "@/lib/research/evidenceAudit";

/** 03 单页研究总览的第 3～7 段：买家反馈 / 产品改良与待验证项 / 成本可行性 / 关键风险。
 *  只消费已存投影与既有只读接口：不新增研究引擎、API 或存储，不改变任何门禁与状态。 */

/** 展示清洗：去掉括号里的内部字段名（与总览同一规则），不改写任何结论。 */
const clean = (text: string): string => plainText(text);

const STRENGTH_TAG: Record<string, { label: string; tone: "ok" | "warn" | "muted" }> = {
  recurring: { label: "已复现", tone: "ok" },
  weak: { label: "待验证线索", tone: "warn" },
  isolated: { label: "孤立提及", tone: "muted" },
};

type VoiceObservation = {
  externalContentId: string;
  source: string;
  title: string | null;
  text: string;
  rating: number | null;
  publishedAt: string | null;
  sourceUrl: string | null;
};

/** ② 研究结论的原文核验状态（V11）：三个事实严格分开，不混用——
 *  ① VOC 主题提及次数：显示在结论行「（N 条评论提及）」，本块不重复；
 *  ② 已关联原文数量：checkpoints.evidenceRefs 与已采集观察按 externalContentId 精确命中的条数（真实读取，不写死）；
 *  ③ 内容级核验确认支持的条数：系统没有逐条语义核验数据，恒显示「待核实」，不写「已证实」，
 *     也不把未核验误写成「没有证据」。
 *  默认只给状态、一句说明、简短预览与查看入口；完整原文与来源链接点「查看关联原文」就地展开，再次点击收起。
 *  无登记关联或读取失败时如实显示，不生成替代内容；不做文字相似度匹配、不新增 AI 调用。 */
function textSnippet(text: string, max = 64): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function ResearchConclusionEvidence({
  taskId,
  refs,
}: {
  taskId: string;
  refs: readonly string[];
}) {
  const [matched, setMatched] = useState<VoiceObservation[] | null>(refs.length === 0 ? [] : null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setFailed(false);
    try {
      const response = await fetch(`/api/research/${encodeURIComponent(taskId)}/customer-voice`, {
        headers: buildAccessHeaders(),
        cache: "no-store",
        signal,
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.ok === false) throw new Error("unavailable");
      const data = (json?.data ?? json) as { observations?: VoiceObservation[] };
      const list = Array.isArray(data.observations) ? data.observations : [];
      const refSet = new Set(refs);
      setMatched(list.filter((item) => refSet.has(item.externalContentId)));
    } catch (caught) {
      if ((caught as Error)?.name === "AbortError") return;
      // 读取失败 = 无法确认关联：如实显示，不猜、不回退到任意引用。
      setFailed(true);
    }
  }, [taskId, refs]);

  useEffect(() => {
    if (refs.length === 0) {
      setMatched([]);
      return;
    }
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refs]);

  const linkedCount = matched?.length ?? 0;

  // 无登记关联：如实空态，不生成替代内容。
  if (refs.length === 0) {
    return (
      <div className={styles.linkedEvidence} data-testid="overview-conclusion-evidence">
        <p className={styles.verifyTitle}>原文核验状态：无登记关联</p>
        <p className={styles.verifyNote} data-testid="overview-conclusion-evidence-empty">暂无可直接关联的原文证据。</p>
      </div>
    );
  }

  return (
    <div className={styles.linkedEvidence} data-testid="overview-conclusion-evidence">
      <p className={styles.verifyTitle}>原文核验状态：待核实</p>
      {matched === null && !failed ? (
        <p className={styles.verifyNote}>正在读取关联原文…</p>
      ) : linkedCount === 0 ? (
        <p className={styles.verifyNote} data-testid="overview-conclusion-evidence-empty">
          已登记 {refs.length} 条关联，暂未读取到可展示的原文。
        </p>
      ) : (
        <>
          <p className={styles.verifyNote}>
            已关联 {linkedCount} 条原始评论，尚未逐条核实哪些直接支持当前结论。
          </p>

          {!expanded ? (
            <ul className={styles.previewList}>
              {matched!.slice(0, 3).map((item) => (
                <li key={item.externalContentId}>
                  <em>
                    {item.rating !== null ? `${item.rating.toFixed(1)} 分` : "无评分"}
                    {item.publishedAt ? ` · ${new Date(item.publishedAt).toLocaleDateString("zh-CN")}` : ""}
                  </em>
                  <span>“{textSnippet(item.text)}”</span>
                </li>
              ))}
            </ul>
          ) : (
            <>
              <ul className={styles.linkedQuotes}>
                {matched!.slice(0, 3).map((item) => (
                  <li key={item.externalContentId}>
                    <span className={styles.linkedMeta}>
                      {item.rating !== null ? `${item.rating.toFixed(1)} 分` : "无评分"}
                      {item.publishedAt ? ` · ${new Date(item.publishedAt).toLocaleDateString("zh-CN")}` : ""}
                      {item.sourceUrl ? <> · <a href={item.sourceUrl} target="_blank" rel="noreferrer noopener">原文 ↗</a></> : null}
                    </span>
                    <p>“{item.text}”</p>
                  </li>
                ))}
              </ul>
              <p className={styles.caveat}>
                以上原文按 VOC 登记的 ID 精确对应，未改写、未删减；系统未做逐条语义核验，是否支持当前结论请以原文自行判断。
              </p>
            </>
          )}

          <button
            type="button"
            className={styles.ghostBtn}
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            data-testid="overview-conclusion-toggle"
          >
            {expanded ? "收起关联原文" : `查看关联原文（${linkedCount}）`}
            {expanded ? <ChevronUp className="size-3.5" aria-hidden="true" /> : <ChevronDown className="size-3.5" aria-hidden="true" />}
          </button>
        </>
      )}
    </div>
  );
}

/** ③ 买家反馈：主题归纳 + 原始评论摘录，全部来自已采集证据；不逐条对应、不虚构发生率。 */
export function ResearchVoiceReport({
  taskId,
  themes,
  reviewSnapshot,
  onOpenReviews,
  onOpenVoc,
}: {
  taskId: string;
  themes: readonly EvidenceTheme[];
  reviewSnapshot: { totalReviews: number | null; reviewsUsed: number | null } | null;
  onOpenReviews: () => void;
  onOpenVoc: () => void;
}) {
  const [excerpts, setExcerpts] = useState<VoiceObservation[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/research/${encodeURIComponent(taskId)}/customer-voice`, {
        headers: buildAccessHeaders(),
        cache: "no-store",
        signal,
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.ok === false) {
        const code = typeof json?.error?.code === "string" ? json.error.code : null;
        const message = typeof json?.error?.message === "string" ? json.error.message : null;
        throw new Error(formatBuyerVoiceLoadError(response.status, code, message));
      }
      const data = (json?.data ?? json) as { observations?: VoiceObservation[] };
      const list = Array.isArray(data.observations) ? data.observations : [];
      setTotal(list.length);
      // 摘录口径固定：评分最低的 2 条（同分取先采集的），并如实标注；不做任何内容改写。
      const lowest = list
        .slice()
        .sort((a, b) => (a.rating ?? 6) - (b.rating ?? 6))
        .slice(0, 2);
      setExcerpts(lowest);
    } catch (caught) {
      if ((caught as Error)?.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "读取买家评论失败。");
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const painThemes = themes.filter((theme) => theme.kind === "pain").slice().sort((a, b) => b.reviewCount - a.reviewCount);
  const positiveThemes = themes.filter((theme) => theme.kind === "positive");
  const readCount = reviewSnapshot?.reviewsUsed ?? reviewSnapshot?.totalReviews ?? total;

  return (
    <section className={styles.section} aria-label="买家反馈" data-testid="overview-voice-report">
      <header className={styles.head}>
        <div>
          <p className={styles.kicker}><MessageSquareQuote aria-hidden="true" />买家反馈</p>
          <h3 className={styles.title}>
            {painThemes.length > 0 ? "买家在评论里反复提到什么" : "买家评论怎么说"}
          </h3>
        </div>
        <span className={styles.headMeta}>
          {readCount !== null ? `已读 ${readCount} 条评论` : "尚无可读评论数"}
          {themes.length > 0 ? ` · ${themes.length} 个主题` : ""}
        </span>
      </header>

      {painThemes.length > 0 ? (
        <ul className={styles.themeList}>
          {painThemes.slice(0, 5).map((theme) => {
            const tag = STRENGTH_TAG[theme.strength] ?? { label: "强度未分级", tone: "muted" as const };
            return (
              <li key={theme.label} className={styles.themeRow}>
                <div className={styles.themeHead}>
                  <strong>{theme.label}</strong>
                  <span className={styles.themeTag} data-tone={tag.tone}>{tag.label}</span>
                  <em>{theme.reviewCount} 条提及</em>
                </div>
                <p className={styles.themeText}>{clean(theme.summary)}</p>
              </li>
            );
          })}
          {painThemes.length > 5 ? (
            <li className={styles.themeMore}>另有 {painThemes.length - 5} 个主题在 VOC 规则结果中列出。</li>
          ) : null}
        </ul>
      ) : (
        <p className={styles.empty} data-tone="muted">
          {themes.length > 0
            ? "当前评论样本没有归纳出买家问题主题；少量反馈按原样保留在下方摘录里，不升级为结论。"
            : "还没有可读的评论归纳。导入或采集评论后，这里会给出真实买家反馈。"}
        </p>
      )}
      {painThemes.length > 0 ? (
        <p className={styles.caveat}>提及数是评论计数，不是买家问题发生率；「待验证线索」不足以作为结论。</p>
      ) : null}

      {positiveThemes.length > 0 ? (
        <details className={styles.positive}>
          <summary><ThumbsUp aria-hidden="true" />买家也认可的点（{positiveThemes.length}）</summary>
          <ul>
            {positiveThemes.map((theme) => (
              <li key={theme.label}>{theme.label}<em>{theme.reviewCount} 条提及</em></li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className={styles.excerptBlock}>
        <p className={styles.excerptLabel}>原始评论摘录</p>
        {loading ? (
          <p className={styles.empty}><Loader2 className={styles.spin} aria-hidden="true" />正在读取评论原文…</p>
        ) : error ? (
          <p className={styles.empty} data-tone="warn">{error}</p>
        ) : excerpts.length === 0 ? (
          <p className={styles.empty} data-tone="muted">尚未导入评论原文。导入后这里直接展示有代表性的原话，不需要另开抽屉。</p>
        ) : (
          <>
            <div className={styles.excerptGrid}>
              {excerpts.map((item) => (
                <blockquote key={item.externalContentId} className={styles.excerpt}>
                  <header>
                    <strong>{item.title?.trim() || localizeVoiceSource(item.source)}</strong>
                    <span>
                      {item.rating !== null ? `${item.rating.toFixed(1)} 分` : "无评分"}
                      {item.publishedAt ? ` · ${new Date(item.publishedAt).toLocaleDateString("zh-CN")}` : ""}
                    </span>
                  </header>
                  <p>{item.text}</p>
                  {item.sourceUrl ? (
                    <a href={item.sourceUrl} target="_blank" rel="noreferrer noopener">原文 ↗</a>
                  ) : null}
                </blockquote>
              ))}
            </div>
            <p className={styles.caveat}>
              摘录评分最低的 {excerpts.length} 条原始评论，仅作直观示例，不代表整体分布；按附件归档，不逐条对应上方主题，单条评论只代表该用户体验。
            </p>
          </>
        )}
      </div>

      <footer className={styles.foot}>
        <button type="button" className={styles.primaryBtn} onClick={onOpenReviews} data-testid="voice-open-reviews">
          查看全部原始评论<ArrowRight aria-hidden="true" />
        </button>
        <button type="button" className={styles.ghostBtn} onClick={onOpenVoc} data-testid="voice-open-voc">
          VOC 规则结果
        </button>
      </footer>
    </section>
  );
}

/** ⑤ 产品改良与待验证项：改良假设（根因未确认）+ 待供应商确认 + 待验证线索，三态分开。
 *  historical = 研报暂停采信 / 来源失效 / 权威未定：全部建议统一标注「历史改良线索（待重新核实）」，
 *  保留原有假设、验证要求与来源，不改写底层研究结果，只改展示语义。 */
export function ResearchImprovementSection({
  plan,
  requirements,
  checkpoints,
  unknowns,
  historical = false,
  onOpenPlan,
}: {
  plan: ImprovementPlan | null;
  requirements: readonly EvidenceRequirement[];
  checkpoints: readonly EvidenceCheckpoint[];
  unknowns: readonly string[];
  historical?: boolean;
  onOpenPlan: () => void;
}) {
  const items = plan?.items ?? [];
  const showRequirements = items.length === 0 && requirements.length > 0;
  const sectionTitle = historical
    ? "历史改良线索（待重新核实）"
    : items.length > 0
      ? "可以验证的改良方向"
      : "改良与验证";

  return (
    <section className={styles.section} aria-label="产品改良与待验证项" data-testid="overview-improvement-section">
      <header className={styles.head}>
        <div>
          <p className={styles.kicker}><ListChecks aria-hidden="true" />产品改良与待验证项</p>
          <h3 className={styles.title}>{sectionTitle}</h3>
        </div>
        <span className={styles.headMeta} data-tone={historical ? "warn" : items.length > 0 ? "ok" : "muted"} data-testid="improvement-status">
          {historical ? "历史改良线索（待重新核实）" : plan ? plan.statusLabel : "尚未形成改良方向"}
        </span>
      </header>

      {historical ? (
        <p className={styles.caveat} data-testid="improvement-historical-note">
          以下内容来自已保存的历史研报与历史快照；来源已变化或报告已暂停采信，需重新核实后才能作为当前开发建议。
        </p>
      ) : null}

      {items.length > 0 ? (
        <ul className={styles.planList}>
          {items.slice(0, 3).map((item) => (
            <li key={`${item.index}-${item.hypothesis.slice(0, 24)}`} className={styles.planRow}>
              <p className={styles.planText}>{clean(item.hypothesis)}</p>
              <p className={styles.planMeta}>
                <span>{historical ? "历史改良假设" : "改良假设"}</span>
                <i>·</i>
                <span>{item.attribution.primaryLabel}</span>
                {item.actionabilityLabel ? (<><i>·</i><span>{item.actionabilityLabel}</span></>) : null}
                <b>根因未确认</b>
              </p>
              {item.verificationTasks.length > 0 ? (
                <p className={styles.planVerify}>{historical ? "原验证要求" : "下一步验证"}：{clean(item.verificationTasks[0].task)}</p>
              ) : null}
            </li>
          ))}
          {items.length > 3 ? (
            <li className={styles.themeMore}>另有 {items.length - 3} 条改良假设在完整列表中。</li>
          ) : null}
        </ul>
      ) : (
        <p className={styles.empty} data-tone="muted">
          {plan?.statusReason ?? "当前证据还不足以提出改什么、怎么改；不凭少量反馈编造改良方向。"}
        </p>
      )}

      {showRequirements ? (
        <div className={styles.subBlock}>
          <p className={styles.subLabel}>买家问题派生的改良需求（规则生成 · 未确认）</p>
          <ul className={styles.plainList}>
            {requirements.slice(0, 2).map((requirement, index) => (
              <li key={requirement.id ?? index}>
                {clean(requirement.requirement)}
                <em>来自「{requirement.sourceThemeLabel}」</em>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {checkpoints.length > 0 ? (
        <div className={styles.subBlock}>
          <p className={styles.subLabel}>待供应商确认问题（验货 / 询价时逐条核实）</p>
          <ol className={styles.plainList}>
            {checkpoints.slice(0, 3).map((checkpoint, index) => (
              <li key={checkpoint.id ?? index}>{clean(checkpoint.checkpoint)}</li>
            ))}
          </ol>
          {checkpoints.length > 3 ? <p className={styles.themeMore}>另有 {checkpoints.length - 3} 项在完整资料中。</p> : null}
        </div>
      ) : null}

      {unknowns.length > 0 ? (
        <div className={styles.subBlock} data-tone="warn">
          <p className={styles.subLabel}>待验证线索（不足以成为结论）</p>
          <ul className={styles.plainList}>
            {unknowns.slice(0, 4).map((item) => (
              <li key={item}>{clean(item)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {plan && plan.items.length > 0 ? (
        <footer className={styles.foot}>
          <button type="button" className={styles.ghostBtn} onClick={onOpenPlan} data-testid="improvement-open-plan">
            完整改良假设与验证<ArrowRight aria-hidden="true" />
          </button>
        </footer>
      ) : null}
    </section>
  );
}

/** ⑥ 成本可行性：状态 + 单件成本 + 最关键缺口；完整表单与规则在成本专注操作区。 */
export function ResearchCostSection({
  cost,
  onOpenCost,
}: {
  cost: {
    status: "available" | "not_computable" | null;
    totalCost: number | null;
    currency: string | null;
    reason: string | null;
    gaps: readonly string[];
  };
  onOpenCost: () => void;
}) {
  const statusLabel = cost.status === "available" ? "已可计算" : cost.status === "not_computable" ? "暂不可计算" : "尚未录入";
  const symbol = cost.currency === "USD" || !cost.currency ? "$" : `${cost.currency} `;

  return (
    <section className={styles.section} aria-label="成本可行性" data-testid="overview-cost-section">
      <header className={styles.head}>
        <div>
          <p className={styles.kicker}><Calculator aria-hidden="true" />成本可行性</p>
          <h3 className={styles.title}>单件成本测算</h3>
        </div>
        <span className={styles.headMeta} data-tone={cost.status === "available" ? "ok" : "warn"}>{statusLabel}</span>
      </header>

      <div className={styles.costBody}>
        <div className={styles.costValue}>
          <span>单件成本</span>
          <strong data-empty={cost.status === "available" && cost.totalCost !== null ? "false" : "true"}>
            {cost.status === "available" && cost.totalCost !== null ? `${symbol}${cost.totalCost.toFixed(2)}` : "—"}
          </strong>
        </div>
        <div className={styles.costGap}>
          <p className={styles.subLabel}>最关键缺口</p>
          <p className={styles.costGapText}>
            {cost.gaps.length > 0 ? cost.gaps[0] : "没有记录到缺口；这不代表费用已经核实。"}
          </p>
          <p className={styles.caveat}>缺失费用一律不计算，不用 0 或估算值补足。</p>
        </div>
      </div>

      <footer className={styles.foot}>
        <button type="button" className={styles.primaryBtn} onClick={onOpenCost} data-testid="overview-open-cost">
          填写 / 查看成本<ArrowRight aria-hidden="true" />
        </button>
      </footer>
    </section>
  );
}

/** ⑦ 关键风险：越级结论、阻断风险、来源失效、风险不可判四态分开；不与「无风险」混写。
 *  riskState 由调用方按既有判定计算：blocking = 审查越级或有阻断风险；
 *  unverifiable = 权威未定 / 审查不可用 / 风险规则不可用（此时不得展示「无阻断风险」）；
 *  clear = 审查与风险规则均可用且未发现阻断。 */
export function ResearchRiskSection({
  claimAudit,
  stale,
  reportAuthorityAmbiguous,
  riskState,
  gateLabel,
  blockingRisks,
  onOpenAudit,
}: {
  claimAudit: ResearchClaimAudit | null;
  stale: boolean;
  reportAuthorityAmbiguous: boolean;
  riskState: "blocking" | "unverifiable" | "clear";
  gateLabel: string;
  blockingRisks: readonly string[];
  onOpenAudit: () => void;
}) {
  const blockingFlags = claimAudit?.flags.filter((flag) => flag.severity === "BLOCKING") ?? [];
  const warningFlags = claimAudit?.flags.filter((flag) => flag.severity === "WARNING") ?? [];
  const tone = riskState === "blocking" ? "risk" : riskState === "unverifiable" ? "warn" : "ok";

  return (
    <section className={styles.section} aria-label="关键风险" data-testid="overview-risk-section">
      <header className={styles.head}>
        <div>
          <p className={styles.kicker}><ShieldAlert aria-hidden="true" />关键风险</p>
          <h3 className={styles.title}>{tone === "risk" ? "采信前需要先处理" : tone === "warn" ? "风险状态待确认" : "风险核查结果"}</h3>
        </div>
        <span className={styles.gateChip} data-tone={tone} data-testid="overview-risk-gate">{gateLabel}</span>
      </header>

      {blockingFlags.length > 0 ? (
        <ul className={styles.riskList}>
          {blockingFlags.slice(0, 2).map((flag) => (
            <li key={`${flag.code}-${flag.field}-${flag.index}`}>
              <ShieldAlert aria-hidden="true" />
              <span><b>越级结论</b>{clean(flag.text)}</span>
            </li>
          ))}
          {blockingFlags.length > 2 ? <li className={styles.themeMore}>另有 {blockingFlags.length - 2} 处在完整审查中。</li> : null}
        </ul>
      ) : null}

      {blockingRisks.length > 0 ? (
        <ul className={styles.plainList}>
          {blockingRisks.slice(0, 2).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}

      {riskState === "unverifiable" ? (
        <p className={styles.riskNote} data-tone="warn" data-testid="overview-risk-unverifiable">
          {reportAuthorityAmbiguous
            ? "报告权威未定：先确认以哪份研报为准，才能完成风险判断；在此之前不宣布无风险。"
            : "证据审查当前不可用：先完成审查或确认报告版本，再判断风险；在此之前不宣布无风险。"}
        </p>
      ) : stale ? (
        <p className={styles.riskNote} data-tone="warn">来源已变化：历史结论与历史决定仍保留，但不再作为当前有效结论，需更新研报后重新确认。</p>
      ) : riskState === "clear" && blockingFlags.length === 0 && blockingRisks.length === 0 ? (
        <p className={styles.riskNote} data-tone="ok">
          <ShieldCheck aria-hidden="true" />
          {warningFlags.length > 0
            ? `未发现阻断风险；另有 ${warningFlags.length} 处表述强于证据，采信时需降级。`
            : "未发现阻断风险；这不代表商业上一定可行，成本与验证项见上方各区。"}
        </p>
      ) : null}

      <footer className={styles.foot}>
        <button type="button" className={styles.ghostBtn} onClick={onOpenAudit} data-testid="risk-open-audit">
          查看完整证据审查<ArrowRight aria-hidden="true" />
        </button>
      </footer>
    </section>
  );
}
