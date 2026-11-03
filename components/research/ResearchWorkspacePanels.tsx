"use client";

import Link from "next/link";
import styles from "./ResearchReading.module.css";
import type { CanonicalDecisionStatus } from "@/lib/types/v5DecisionStatus";

/** 人工决定的展示文案（与决定按钮一致，仅用于只读摘要）。 */
const DECISION_LABEL: Record<CanonicalDecisionStatus, string> = {
  PENDING: "待决定",
  PROCEED: "继续推进",
  VALIDATE_MORE: "需补充验证",
  PAUSE: "暂缓观察",
  DROP: "放弃",
};

function labelOf(status: string | null): string {
  return status ? DECISION_LABEL[status as CanonicalDecisionStatus] ?? "已记录" : "";
}
function hintOf(status: string | null): string {
  return status ? DECISION_HINT[status as CanonicalDecisionStatus] ?? "以已保存的人工决定为准。" : "";
}

const DECISION_HINT: Record<CanonicalDecisionStatus, string> = {
  PENDING: "尚未记录人工决定。",
  PROCEED: "在明确限制下推进评估，不等于采购或量产。",
  VALIDATE_MORE: "先补齐关键证据，再作下一次判断。",
  PAUSE: "商业时机暂不合适，与证据不足分别记录。",
  DROP: "停止推进，保留研究与决定历史。",
};

export type OverviewSuggestion = {
  status: "available" | "unavailable";
  priority?: string;
  nextAction?: string;
  keyReason?: string;
  blocking: number;
  warning: number;
  notComputable: number;
};

/**
 * 判断总览双卡（对照 3414 第 15 张）：
 * 左卡是人工决定的权威记录，右卡是研究建议；两者不同时明确以人工决定为准。
 */
export function ResearchOverviewHero({
  decisionStatus,
  decisionReason,
  hasDecision,
  decisionStale = false,
  suggestion,
  hasReport,
  onOpenDecision,
  briefHref,
  onOpenComparison,
}: {
  decisionStatus: string | null;
  decisionReason: string | null;
  hasDecision: boolean;
  decisionStale?: boolean;
  suggestion: OverviewSuggestion;
  hasReport: boolean;
  onOpenDecision: () => void;
  briefHref: string | null;
  onOpenComparison: () => void;
}) {
  const decided = hasDecision && decisionStatus ? decisionStatus : null;
  const staleDecision = Boolean(decided && decisionStale);
  const differs = Boolean(decided && suggestion.nextAction && suggestion.nextAction !== labelOf(decided));

  return (
    <div className="lc-overview-hero">
      <section className="lc-decision-hero" data-decided={decided && !staleDecision ? "true" : undefined} data-decision={staleDecision ? "STALE" : decided ?? "PENDING"} aria-label="人工决定">
        <div className="lc-hero-head">
          <span>人工决定 · 你的判断</span>
          <span className="lc-hero-state">{staleDecision ? "需重新确认" : decided ? "已保存" : "尚未决定"}</span>
        </div>
        <div className="lc-hero-body">
          <p className="lc-hero-eyebrow">{staleDecision ? "历史决定" : "当前记录"}</p>
          <h2>{decided ? labelOf(decided) : "还没有人工决定"}</h2>
          <p className="lc-hero-desc">
            {decided ? decisionReason?.trim() || hintOf(decided) : "研究建议不能代替人工判断；在「人工决定」中记录理由后才会形成权威结论。"}
          </p>
        </div>
        <div className="lc-hero-foot">
          <span>{staleDecision ? "研究或证据已更新，历史决定需重新确认" : "人工决定是推进判断的权威记录"}</span>
          <button type="button" onClick={onOpenDecision}>{decided ? "查看 / 调整决定" : "去做人工决定"} →</button>
        </div>
      </section>

      <section className="lc-suggestion-card" aria-label="研究建议">
        <div className="lc-hero-head">
          <span>研究建议 · 系统推导</span>
          {suggestion.status === "available" && <span className="lc-hero-tag">{suggestion.nextAction ?? suggestion.priority ?? "已生成"}</span>}
        </div>
        <h2>{hasReport ? (suggestion.nextAction ? `建议${suggestion.nextAction}` : "研究已生成，建议待定") : "尚无正式研报"}</h2>
        <p className="lc-suggestion-text">
          {suggestion.keyReason?.trim() || (hasReport ? "研报未给出可读取的建议理由；请打开研报查看完整依据。" : "完成正式研报后，这里才会出现研究建议。")}
        </p>
        <ul className="lc-suggestion-counts">
          <li>阻断 {suggestion.blocking}</li>
          <li>提醒 {suggestion.warning}</li>
          <li>不可评估 {suggestion.notComputable}</li>
        </ul>
        {differs && <p className="lc-suggestion-note">{staleDecision ? "建议与历史决定分别保留；历史决定需重新确认。" : "建议与人工决定不同。两种记录分别保留，以已保存的人工决定为准。"}</p>}
        <div className="lc-suggestion-links">
          <button type="button" onClick={onOpenComparison}>查看依据与判断 ↗</button>
          {briefHref && <Link href={briefHref}>查看需求单 ↗</Link>}
        </div>
      </section>
    </div>
  );
}

export type EvidenceThread = {
  key: "voc" | "comparison" | "risk";
  index: string;
  label: string;
  title: string;
  description: string;
  action: string;
};

/** 三条证据线索：每条都指向真实模块，不新增统计口径。 */
export function ResearchEvidenceThreads({ threads, onOpen }: { threads: EvidenceThread[]; onOpen: (key: EvidenceThread["key"]) => void }) {
  if (!threads.length) return null;
  return (
    <section className="lc-threads" aria-label="三条证据线索">
      <div className="lc-threads-head">
        <h2>三条证据线索</h2>
        <p>每条线索都能回到对应材料；片段不足以单独证明市场需求。</p>
      </div>
      <div className="lc-thread-grid">
        {threads.map((thread) => (
          <article key={thread.key} className={`lc-thread-card is-${thread.key}`}>
            <span className="lc-thread-index">{thread.index} / {thread.label}</span>
            <strong>{thread.title}</strong>
            <p>{thread.description}</p>
            <button type="button" onClick={() => onOpen(thread.key)}>{thread.action} ↗</button>
          </article>
        ))}
      </div>
    </section>
  );
}

export type EvidencePane = "reviews" | "facts" | "voc" | "report";

const EVIDENCE_PANES: { id: EvidencePane; label: string; hint: string }[] = [
  { id: "reviews", label: "原始评论", hint: "买家原话与正向/负向片段" },
  { id: "facts", label: "商品事实", hint: "只读引用，未知保持未知" },
  { id: "voc", label: "VOC 规则结果", hint: "规则命中与观察分离" },
  { id: "report", label: "AI 研报与历史分析", hint: "当前研报与历史 AI 分析" },
];

/** 材料分类放在阅读区上方；未选择材料时保持收起，避免原始材料抢占问题视图。 */
export function EvidenceRail({ active, onChange }: { active: EvidencePane | null; onChange: (pane: EvidencePane) => void }) {
  return (
    <nav className={styles.evidenceNav} aria-label="证据分类">
        {EVIDENCE_PANES.map((pane) => (
          <button key={pane.id} type="button" onClick={() => onChange(pane.id)} aria-current={active === pane.id ? "true" : undefined} data-testid={`evidence-pane-${pane.id}`}>
            <strong>{pane.label}</strong>
            <small>{pane.hint}</small>
          </button>
        ))}
    </nav>
  );
}

/** 与比较正文同宽的摘要；具体费用缺口按需查看，不占用固定侧栏。 */
export function ComparisonRail({ status, totalCost, currency, reason, gaps, onOpenCost }: { status: "available" | "not_computable" | null; totalCost: number | null; currency: string | null; reason: string | null; gaps: readonly string[]; onOpenCost: () => void }) {
  return (
    <aside className={styles.feasibility} data-testid="comparison-feasibility" data-available={status === "available"} aria-label="可行性摘要">
      <div className={styles.feasibilityRow}>
        <div>
          <h2>成本可行性</h2>
          <p className={styles.feasibilityValue}>{status === "available" && totalCost !== null ? `单件成本 ${totalCost.toFixed(2)} ${currency ?? "USD"}` : "费用未齐，暂不可计算"}</p>
        </div>
        <p className={styles.feasibilityReason}>{reason?.trim() || (status === "available" ? "按已录入目标与费用测算，非真实采购成本。" : "缺少可计算的价格与费用输入。")}</p>
        <button type="button" onClick={onOpenCost}>查看成本与费用 ↗</button>
      </div>
      {gaps.length > 0 && <details className={styles.feasibilityDetails}>
        <summary>口径与费用缺口</summary>
        <ul>{[...new Set(gaps)].map((item) => <li key={item}>{item}</li>)}</ul>
      </details>}
    </aside>
  );
}

/** 人工决定的右栏：判断前再看一眼依据与限制。 */
export function DecisionRail({ missing, blocking, warning, notComputable, currentLabel, briefHref, decisionStale = false, suggestion, onOpenEvidence }: {
  missing: readonly string[];
  blocking: number;
  warning: number;
  notComputable: number;
  currentLabel: string | null;
  briefHref: string | null;
  decisionStale?: boolean;
  suggestion?: { nextAction: string | null; keyReason: string | null } | null;
  onOpenEvidence?: () => void;
}) {
  return (
    <aside className="lc-research-rail lc-decision-rail" aria-label="依据与限制">
      <p className="lc-rail-eyebrow">保存前再看一眼</p>
      <h2>依据与限制</h2>
      {suggestion ? (
        <div className="lc-rail-ai">
          <p className="lc-rail-eyebrow">AI 建议 · 仅供参考</p>
          <strong>{suggestion.nextAction ?? "暂无建议"}</strong>
          <p>{suggestion.keyReason ?? "依据见下方限制与证据审查。"}</p>
          {onOpenEvidence ? <button type="button" className="lc-rail-link" onClick={onOpenEvidence}>查看证据审查 ↗</button> : null}
        </div>
      ) : null}
      <ul className="lc-limit-list">
        <li><span>评论原文与正向反馈</span><em>可追溯</em></li>
        <li><span>成本与供应条件</span><em>{notComputable > 0 ? `${notComputable} 项不可评估` : "见成本测算"}</em></li>
        <li><span>风险核查</span><em>{blocking > 0 ? `${blocking} 项阻断` : warning > 0 ? `${warning} 项提醒` : "未发现阻断"}</em></li>
      </ul>
      {missing.length > 0 && (
        <ul className="lc-rail-list">
          {missing.slice(0, 4).map((item) => <li key={item}>{item}</li>)}
        </ul>
      )}
      <p className="lc-rail-note">{decisionStale && currentLabel ? `历史决定：${currentLabel}，需重新确认。` : `当前已保存：${currentLabel ?? "尚无人工决定"}。`}重新提交可能改变需求单来源绑定，旧版本会保留。</p>
      {briefHref && <Link className="lc-rail-link" href={briefHref}>查看需求单当前状态 ↗</Link>}
    </aside>
  );
}
