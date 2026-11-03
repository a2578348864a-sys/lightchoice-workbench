"use client";

import { useMemo, useState } from "react";
import { ArrowRight, MessageSquareQuote, ShieldAlert } from "lucide-react";

import styles from "./EvidenceOpportunityWorkspace.module.css";
import { ResearchCompetitorSnapshot } from "./ResearchCompetitorSnapshot";
/** 统一资料阅读器可承载的资料类型（本页只负责发起，内容由详情页装配）。 */
export type EvidenceMaterialTarget = "reviews" | "facts" | "voc" | "report" | "audit" | "plan" | "competitors" | "archive";
import type { ResearchClaimAudit } from "@/lib/research/evidenceAudit";
import type { ImprovementHypothesisItem, ImprovementPlan } from "@/lib/research/improvementPlan";

export type EvidenceTheme = {
  readonly label: string;
  readonly summary: string;
  readonly reviewCount: number;
  readonly strength: string;
  /** 上游类目：pain=负向 / positive=正向 / request=请求。历史数据可能缺省，缺省时不计入任何一层。 */
  readonly kind?: "pain" | "positive" | "request";
};

export type EvidenceRequirement = {
  readonly id?: string;
  readonly sourceThemeLabel: string;
  readonly requirement: string;
  readonly reviewCount?: number;
  readonly severityHint?: string | null;
};

export type EvidenceCheckpoint = {
  readonly id?: string;
  readonly sourceThemeLabel: string;
  readonly checkpoint: string;
  readonly reviewCount?: number;
  readonly evidenceRefs?: readonly string[];
};

const STRENGTH_LABEL: Record<string, string> = {
  recurring: "复现主题",
  weak: "弱信号",
  isolated: "孤立提及",
};

/** 一句话说清这条强度能支持到哪一步；长解释留给完整资料。 */
const STRENGTH_HINT: Record<string, string> = {
  recurring: "多条评论重复出现，可作为改良线索",
  weak: "只有少量提及，只能当方向假设",
  isolated: "只有 1 条提及，属个案线索",
};

function strengthLabel(value: string): string {
  return STRENGTH_LABEL[value] ?? "强度未分级";
}

function normalize(text: string): string {
  return text.replace(/[\s，。、；：""''（）()【】[\]·—…!！?？,.;:'"]/g, "").toLowerCase();
}

/**
 * 主题 → 研报原因假设的唯一对应规则：只做确定性文本比对。
 * 找不到就返回 null，由界面如实显示「尚未形成方案」，不按顺序硬配。
 */
function matchPlanItem(
  theme: EvidenceTheme,
  requirement: EvidenceRequirement | null,
  plan: ImprovementPlan | null
): ImprovementHypothesisItem | null {
  if (!plan || plan.items.length === 0) return null;
  const themeKey = normalize(theme.label);
  const requirementKey = requirement ? normalize(requirement.requirement) : "";
  const requirementHead = requirementKey.slice(0, 12);

  const hit = plan.items.find((item) => {
    const hypothesis = normalize(item.hypothesis);
    if (themeKey.length >= 2 && hypothesis.includes(themeKey)) return true;
    if (requirementHead.length >= 6 && hypothesis.includes(requirementHead)) return true;
    if (requirement && item.linkedDirections.some((direction) => normalize(direction) === requirementKey)) return true;
    return false;
  });
  return hit ?? null;
}

/**
 * 03「证据与机会」（极简版）。
 *
 * 默认只走一条判断链：当前买家问题 → 证据强度 → 改良判断 → 下一步验证。
 * 完整原因、风险、缺口、VOC 明细、竞品与成本都还在，但只在需要时展开或进入统一阅读器。
 * 不新增一级/二级导航：问题切换是筛选，不是导航。
 */
export function EvidenceOpportunityWorkspace({
  taskId,
  stale,
  reportAuthorityAmbiguous,
  themes,
  requirements,
  checkpoints,
  reviewSnapshot,
  unknowns,
  plan,
  audit,
  missingLimits,
  onOpenMaterial,
  onOpenCompetitorDetail,
  onOpenCost,
  cost,
}: {
  taskId: string;
  asin: string | null;
  marketplace: string | null;
  stale: boolean;
  reportAuthorityAmbiguous: boolean;
  themes: readonly EvidenceTheme[];
  requirements: readonly EvidenceRequirement[];
  checkpoints: readonly EvidenceCheckpoint[];
  reviewSnapshot: { totalReviews: number | null; reviewsUsed: number | null } | null;
  unknowns: readonly string[];
  plan: ImprovementPlan | null;
  audit: ResearchClaimAudit | null;
  missingLimits: readonly string[];
  onOpenMaterial: (target: EvidenceMaterialTarget) => void;
  onOpenCompetitorDetail: () => void;
  onOpenCost: () => void;
  cost: {
    status: "available" | "not_computable" | null;
    totalCost: number | null;
    currency: string | null;
    reason: string | null;
    gaps: readonly string[];
  };
}) {
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [detail, setDetail] = useState<"unknowns" | null>(null);

  const painThemes = useMemo(
    () => themes.filter((theme) => theme.kind === "pain").slice().sort((a, b) => b.reviewCount - a.reviewCount),
    [themes]
  );
  const positiveThemes = useMemo(() => themes.filter((theme) => theme.kind === "positive"), [themes]);
  const activeTheme = painThemes.find((theme) => theme.label === activeLabel) ?? painThemes[0] ?? null;

  const requirementOf = (theme: EvidenceTheme | null): EvidenceRequirement | null =>
    theme ? requirements.find((item) => item.sourceThemeLabel === theme.label) ?? null : null;
  const checkpointOf = (theme: EvidenceTheme | null): EvidenceCheckpoint | null =>
    theme ? checkpoints.find((item) => item.sourceThemeLabel === theme.label) ?? null : null;

  const activeRequirement = requirementOf(activeTheme);
  const activeCheckpoint = checkpointOf(activeTheme);
  const activePlanItem = activeTheme ? matchPlanItem(activeTheme, activeRequirement, plan) : null;

  const auditTone = !audit
    ? "muted"
    : audit.verdict === "CONSISTENT"
      ? "ok"
      : audit.verdict === "NEEDS_DOWNGRADE"
        ? "warn"
        : "blocked";
  const blockingFlags = audit?.flags.filter((flag) => flag.severity === "BLOCKING") ?? [];
  const warningFlags = audit?.flags.filter((flag) => flag.severity === "WARNING") ?? [];

  const independentReviews = reviewSnapshot?.reviewsUsed ?? null;
  /** 空状态只解释一次：说清「为什么没有结论」，不在下面再堆一段。 */
  const emptyReason = reportAuthorityAmbiguous
    ? "报告权威未定（V1 与 V5 并存），暂不能给出问题结论。"
    : independentReviews === null || independentReviews === 0
      ? "还没有已读评论。导入或采集评论后，这里会按提及数排出真实问题。"
      : `已读 ${independentReviews} 条评论，没有重复出现的问题；单条反馈只算个案线索。`;

  const reportStateLabel = reportAuthorityAmbiguous
    ? "报告权威未定"
    : stale
      ? "来源已变化"
      : plan
        ? plan.statusLabel
        : "尚无正式研报";

  /** 审查结论压成一句：先给条目数，再给动作；阻断条目单独列在下面。 */
  const auditNote = !audit
    ? "尚无可用的证据审查"
    : blockingFlags.length > 0
      ? `${blockingFlags.length} 处越级结论，暂不能采信`
      : warningFlags.length > 0
        ? `${warningFlags.length} 处表述强于证据，需降级阅读`
        : "未发现越级结论";

  const riskItems = useMemo(() => {
    if (!activePlanItem) return [] as string[];
    return [
      ...activePlanItem.sideEffects.map((item) => item.text),
      ...activePlanItem.costUncertainties.map((item) => item.text),
      ...activePlanItem.complianceChecks.map((item) => item.text),
    ].slice(0, 4);
  }, [activePlanItem]);

  const verifyItems = useMemo(() => {
    const list: string[] = [];
    if (activeCheckpoint) list.push(activeCheckpoint.checkpoint);
    if (activePlanItem) list.push(...activePlanItem.verificationTasks.map((task) => task.task));
    return [...new Set(list)].slice(0, 4);
  }, [activeCheckpoint, activePlanItem]);

  return (
    <div className={styles.wrap} data-testid="evidence-opportunity-workspace">
      {/* ① 当前买家问题：一个问题、一句现象、一行数字 */}
      <section className={styles.hero} aria-label="当前买家问题">
        <header className={styles.heroHead}>
          <p className={styles.kicker}>
            <MessageSquareQuote aria-hidden="true" />
            {activeTheme && activeTheme.strength !== "recurring" ? "待验证问题" : "买家问题"}
          </p>
          <span className={styles.heroState} data-tone={reportAuthorityAmbiguous || stale ? "warn" : "muted"}>
            {reportStateLabel}
          </span>
        </header>

        {activeTheme ? (
          <>
            <h2 className={styles.heroTitle}>{activeTheme.label}</h2>
            <p className={styles.heroScene}>{activeTheme.summary}</p>
            <p className={styles.heroMetrics}>
              <b>{activeTheme.reviewCount}</b> 条评论提及
              <span>·</span>
              <b>{strengthLabel(activeTheme.strength)}</b>
              {independentReviews !== null ? (
                <>
                  <span>·</span>共 <b>{independentReviews}</b> 条已读评论
                </>
              ) : null}
            </p>
          </>
        ) : (
          <>
            <h2 className={styles.heroTitle} data-empty="true">暂无可确认的问题</h2>
            <p className={styles.heroScene}>{emptyReason}</p>
            <div className={styles.heroActions}>
              <button type="button" className={styles.primary} onClick={() => onOpenMaterial("reviews")}>
                查看原始评论
                <ArrowRight aria-hidden="true" />
              </button>
              <button type="button" className={styles.ghost} onClick={() => onOpenMaterial("voc")}>
                看 VOC 规则结果
              </button>
            </div>
          </>
        )}

        {painThemes.length > 1 ? (
          <nav className={styles.switcher} aria-label="切换买家问题">
            {painThemes.map((theme, index) => (
              <button
                key={theme.label}
                type="button"
                className={styles.chip}
                aria-pressed={activeTheme?.label === theme.label}
                data-testid={`evidence-theme-${index}`}
                onClick={() => setActiveLabel(theme.label)}
              >
                {theme.label}
                <em>{theme.reviewCount}</em>
              </button>
            ))}
          </nav>
        ) : null}

        {activeTheme ? <p className={styles.heroFoot}>提及数是评论计数，不是买家发生率。</p> : null}
      </section>

      {/* ② 判断链：强度 → 改良 → 验证 */}
      {activeTheme ? (
        <section className={styles.chain} aria-label="判断链">
          <div className={styles.step} data-tone={auditTone}>
            <p className={styles.stepLabel}>
              <em>01</em>
              证据强度
            </p>
            <p className={styles.stepLead}>
              {strengthLabel(activeTheme.strength)}
              <span className={styles.stepLeadNote}>{STRENGTH_HINT[activeTheme.strength] ?? "强度分级由评论计数推导"}</span>
            </p>

            {blockingFlags.length > 0 ? (
              <ul className={styles.blockingList}>
                {blockingFlags.slice(0, 2).map((flag) => (
                  <li key={`${flag.code}-${flag.field}-${flag.index}`}>
                    <ShieldAlert aria-hidden="true" />
                    <span>
                      <b>越级结论</b>
                      {flag.text}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            <p className={styles.stepNote}>
              <span data-tone={auditTone === "ok" ? "ok" : "warn"}>{auditNote}</span>
              <button type="button" onClick={() => onOpenMaterial("audit")} disabled={!audit} data-testid="evidence-open-audit">
                完整审查
              </button>
              {unknowns.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setDetail(detail === "unknowns" ? null : "unknowns")}
                  data-testid="evidence-toggle-unknowns"
                >
                  {detail === "unknowns" ? "收起缺口" : `仍无法证明 ${unknowns.length} 项`}
                </button>
              ) : null}
            </p>

            {detail === "unknowns" && unknowns.length > 0 ? (
              <ul className={styles.bullets} data-testid="evidence-unknowns">
                {unknowns.slice(0, 4).map((item) => (
                  <li key={item}>{item}</li>
                ))}
                {missingLimits.length > unknowns.length ? (
                  <li>另有 {missingLimits.length} 项缺失事实记录在完整审查里。</li>
                ) : null}
              </ul>
            ) : null}
          </div>

          <div className={styles.step}>
            <p className={styles.stepLabel}>
              <em>02</em>
              改良判断
            </p>
            {activeRequirement || activePlanItem ? (
              <>
                <p className={styles.stepLead}>{activeRequirement?.requirement ?? activePlanItem?.hypothesis ?? "—"}</p>
                <p className={styles.stepNote}>
                  <span data-tone="ok">已形成可开发化方向</span>
                  由这条问题的 {activeTheme.reviewCount} 条评论派生；根因未确认，属可验证假设。
                </p>
              </>
            ) : (
              <>
                <p className={styles.stepLead} data-empty="true">暂不能形成可开发化方案</p>
                <p className={styles.stepNote}>
                  {activeTheme.reviewCount} 条提及（{strengthLabel(activeTheme.strength)}），未达复现门槛（≥4 条）；不凭单条反馈编造改哪里、牺牲什么。
                </p>
              </>
            )}

            {activePlanItem || riskItems.length > 0 ? (
              <details className={styles.fold} data-testid="evidence-plan-expand">
                <summary>完整原因、成本与风险</summary>
                <div className={styles.foldBody}>
                  <div>
                    <p className={styles.foldLabel}>为什么提出这个方向</p>
                    <p className={styles.foldText}>
                      {activePlanItem?.rationale?.trim()
                        ? activePlanItem.rationale
                        : activeRequirement
                          ? `由「${activeTheme.label}」的 ${activeTheme.reviewCount} 条评论经 VOC 规则确定性派生；这是对问题文本的归类，不是已确认的工程根因。`
                          : "现有证据只能说明「有买家遇到这个问题」，还不足以说明是结构、材质还是使用方式导致。"}
                    </p>
                    {activePlanItem ? (
                      <p className={styles.foldMeta}>归因归类：{activePlanItem.attribution.primaryLabel} · {activePlanItem.actionabilityLabel}</p>
                    ) : null}
                  </div>
                  <div>
                    <p className={styles.foldLabel}>可能的成本、结构或使用风险</p>
                    {riskItems.length > 0 ? (
                      <ul className={styles.bullets}>
                        {riskItems.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className={styles.foldText}>尚未评估。没有供应商报价、结构与合规确认前，这里不能给出成本或牺牲项。</p>
                    )}
                  </div>
                  {activeCheckpoint?.evidenceRefs?.length ? (
                    <p className={styles.foldMeta}>
                      该核实点已附 {activeCheckpoint.evidenceRefs.length} 条证据引用，可在「原始评论」中追溯原始材料。
                    </p>
                  ) : null}
                </div>
              </details>
            ) : null}

            {plan ? (
              <p className={styles.stepNote}>
                <button type="button" onClick={() => onOpenMaterial("plan")} data-testid="evidence-open-plan">
                  完整改良假设
                </button>
                <span className={styles.rootTag}>根因未确认 · 不是开发决定</span>
              </p>
            ) : null}
          </div>

          <div className={styles.step} data-tone="verify">
            <p className={styles.stepLabel}>
              <em>03</em>
              下一步验证
            </p>
            {verifyItems.length > 0 ? (
              <>
                <p className={styles.stepLead}>{verifyItems[0]}</p>
                {verifyItems.length > 1 ? (
                  <p className={styles.stepNote}>
                    <span>另有 {verifyItems.length - 1} 项验证要求</span>
                    <span className={styles.verifyList}>
                      {verifyItems.slice(1).map((item) => (
                        <span key={item}>{item}</span>
                      ))}
                    </span>
                  </p>
                ) : null}
              </>
            ) : (
              <p className={styles.stepLead} data-empty="true">尚未形成验证项</p>
            )}
            <div className={styles.stepActions}>
              <button type="button" className={styles.primary} onClick={() => onOpenMaterial("reviews")} data-testid="evidence-open-reviews">
                查看这条问题的评论
                <ArrowRight aria-hidden="true" />
              </button>
              <button type="button" className={styles.ghost} onClick={() => onOpenMaterial("voc")}>
                VOC 规则结果
              </button>
            </div>
            <p className={styles.stepFoot}>
              相关原始评论按附件归档，<strong>不逐条对应「{activeTheme.label}」</strong>，也不是该主题的逐条支持证据；单条评论只代表该用户的体验。
            </p>
          </div>
        </section>
      ) : null}

      {/* ③ 买家也认可的点：折叠，不抢问题的注意力 */}
      {positiveThemes.length > 0 ? (
        <details className={styles.positive}>
          <summary>买家也认可的点（{positiveThemes.length}）</summary>
          <ul>
            {positiveThemes.map((theme) => (
              <li key={theme.label}>
                {theme.label}
                <em>{theme.reviewCount}</em>
              </li>
            ))}
          </ul>
          <p className={styles.positiveNote}>正向反馈不代表没有风险，也不抵消上面记录的买家问题。</p>
        </details>
      ) : null}

      {/* ④ 竞品对照：直接嵌在本页，只给关键列；完整字段走统一阅读器 */}
      <div id="research-competitors-inline">
        <ResearchCompetitorSnapshot taskId={taskId} onOpenDetail={onOpenCompetitorDetail} />
      </div>

      {/* ⑤ 成本与可行性：默认只给状态、结果与最关键缺口；表单与规则在专注操作区 */}
      <section className={styles.cost} aria-label="成本与可行性" data-testid="evidence-cost-summary">
        <header className={styles.panelHead}>
          <div>
            <p className={styles.kicker}>成本与可行性</p>
            <h3>单件成本测算</h3>
          </div>
          <span className={styles.panelMeta} data-tone={cost.status === "available" ? "ok" : "warn"}>
            {cost.status === "available" ? "已可计算" : cost.status === "not_computable" ? "暂不可计算" : "尚未录入"}
          </span>
        </header>

        <div className={styles.costBody}>
          <div className={styles.costValue}>
            <span>单件成本</span>
            <strong data-empty={cost.status === "available" ? "false" : "true"}>
              {cost.status === "available" && cost.totalCost !== null
                ? `${cost.currency === "USD" || !cost.currency ? "$" : `${cost.currency} `}${cost.totalCost.toFixed(2)}`
                : "—"}
            </strong>
          </div>

          <div className={styles.costGaps}>
            <p className={styles.blockLabel}>最关键缺口</p>
            {cost.gaps.length > 0 ? (
              <p className={styles.blockText}>{cost.gaps[0]}</p>
            ) : (
              <p className={styles.blockText}>没有记录到缺口；这不代表费用已经核实。</p>
            )}
          </div>

          <button type="button" className={styles.primary} onClick={onOpenCost} data-testid="evidence-open-cost">
            填写 / 查看成本
            <ArrowRight aria-hidden="true" />
          </button>
        </div>
      </section>

    </div>
  );
}
