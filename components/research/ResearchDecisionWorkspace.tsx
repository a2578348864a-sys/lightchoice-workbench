"use client";

import type { ReactNode } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  FileText,
  HelpCircle,
  ShieldAlert,
  Trash2,
} from "lucide-react";

import { CANONICAL_DECISION_ACTIONS, type CanonicalDecisionStatus } from "@/lib/types/v5DecisionStatus";
import styles from "./ResearchDecisionWorkspace.module.css";

const ICONS: Partial<Record<CanonicalDecisionStatus, ReactNode>> = {
  PROCEED: <CheckCircle2 aria-hidden="true" />,
  VALIDATE_MORE: <HelpCircle aria-hidden="true" />,
  PAUSE: <Clock aria-hidden="true" />,
  DROP: <Trash2 aria-hidden="true" />,
};

export type DecisionCurrent = {
  label: string;
  chosenAt: string | null;
  reason: string | null;
  stale: boolean;
};

/**
 * 03 人工决策（极简版）。
 *
 * 四段固定顺序：能不能决定 → 有哪些选择 → 决定前必须知道什么 → 确认并保存。
 * 只做展示与选择态；提交、版本校验、风险知悉、04 门禁全部由调用方既有实现负责，
 * 本组件不判断“能不能提交”，只如实显示传入的结论。
 */
export function ResearchDecisionWorkspace({
  title,
  asin,
  researchRevision,
  canSubmit,
  blockReason,
  nextStep,
  current,
  gate,
  gateLabel,
  risks,
  missing,
  notice,
  suggestion,
  basisText,
  note,
  onNoteChange,
  ack,
  onAckChange,
  needsAck,
  pending,
  onPendingChange,
  onSubmit,
  busy,
  onOpenEvidence,
  onOpenReport,
  onOpenBrief,
  briefReady,
  briefLabel,
  supportDetail,
  extraActions,
}: {
  title: string | null;
  asin: string;
  researchRevision: number | null;
  canSubmit: boolean;
  blockReason: string | null;
  nextStep: { label: string; onClick: () => void } | null;
  current: DecisionCurrent | null;
  gate: { blocking: number; warning: number; notComputable: number } | null;
  /** 阻断结论一句话：由调用方按既有审查/门禁结果给出，组件不再自行推导。 */
  gateLabel: string;
  risks: readonly string[];
  /** 缺失事实：不是风险，单独一行列出，不与风险卡混排。 */
  missing: readonly string[];
  /** 与本次判断直接相关的一条审查提示（如表述强于证据）；没有就不显示。 */
  notice?: string | null;
  suggestion: { available: boolean; nextAction: string | null; reason: string | null };
  basisText: string | null;
  note: string;
  onNoteChange: (value: string) => void;
  ack: boolean;
  onAckChange: (value: boolean) => void;
  needsAck: boolean;
  pending: CanonicalDecisionStatus | null;
  onPendingChange: (status: CanonicalDecisionStatus) => void;
  onSubmit: () => void;
  busy: boolean;
  onOpenEvidence: () => void;
  onOpenReport: () => void;
  onOpenBrief: () => void;
  briefReady: boolean;
  /** 04 门禁的一句话状态（可进入 / 可查看但需重新确认 / 需先记录）。 */
  briefLabel: string;
  supportDetail?: ReactNode;
  extraActions?: ReactNode;
}) {
  const pendingMeta = pending ? CANONICAL_DECISION_ACTIONS.find((item) => item.status === pending) ?? null : null;
  const saveDisabled = !canSubmit || !pending || (needsAck && !ack) || busy;

  return (
    <div className={styles.wrap} data-testid="decision-workspace">
      {/* ① 当前能不能决定 */}
      <section className={styles.hero} data-tone={canSubmit ? "ready" : "blocked"} aria-label="当前能不能决定">
        <div className={styles.heroMain}>
          <p className={styles.kicker}>人工决策 · 当前状态</p>
          <h1 className={styles.title}>{title?.trim() || asin}</h1>
          <p className={styles.meta}>
            {asin}
            {researchRevision !== null ? ` · 研究版本 rev.${researchRevision}` : ""}
            {current ? ` · 已记录「${current.label}」` : " · 尚未做决定"}
          </p>

          <div className={styles.verdict}>
            <span className={styles.state} data-tone={canSubmit ? "ready" : "blocked"} data-testid="decision-state">
              {canSubmit ? "可以提交人工决定" : "暂不可提交"}
            </span>
            <p className={styles.reason} data-testid="decision-block-reason">
              {blockReason ?? "研报与研究版本一致，可以直接提交本次判断。"}
            </p>
          </div>
        </div>

        {nextStep ? (
          <button type="button" className={styles.heroAction} onClick={nextStep.onClick} data-testid="decision-next-step">
            {nextStep.label}
            <ArrowRight aria-hidden="true" />
          </button>
        ) : null}
      </section>

      {/* ② 我有哪些选择 */}
      <section className={styles.part} aria-label="可选的四种决定">
        <header className={styles.partHead}>
          <h2>你打算怎么继续？</h2>
          <p>四种选择的权重相同，AI 建议只作参考；最终判断由你决定。</p>
        </header>

        <div className={styles.options} data-testid="decision-options">
          {CANONICAL_DECISION_ACTIONS.map((action) => {
            const selected = pending === action.status;
            const saved = current && current.label === action.label;
            return (
              <button
                key={action.status}
                type="button"
                className={styles.option}
                data-tone={action.tone}
                aria-pressed={selected}
                onClick={() => onPendingChange(action.status)}
                data-testid={`decision-option-${action.status}`}
              >
                <span className={styles.optionIcon}>{ICONS[action.status] ?? <HelpCircle aria-hidden="true" />}</span>
                <span className={styles.optionBody}>
                  <strong>
                    {action.label}
                    {saved ? <em className={styles.savedTag}>已记录</em> : null}
                  </strong>
                  <span>{action.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* ③ 决定前必须知道什么 */}
      <section className={styles.part} aria-label="决定前必须知道什么">
        <header className={styles.partHead}>
          <h2>决定前必须知道</h2>
          {gate ? (
            <p className={styles.gateLine} data-testid="decision-gate-line">{gateLabel}</p>
          ) : null}
        </header>

        {notice ? (
          <p className={styles.notice} data-testid="decision-notice">
            <ShieldAlert aria-hidden="true" />
            <span>{notice}</span>
          </p>
        ) : null}

        {risks.length > 0 ? (
          <ul className={styles.risks} data-testid="decision-risks">
            {risks.slice(0, 2).map((item) => (
              <li key={item}>
                <ShieldAlert aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {risks.length > 2 ? <p className={styles.more}>另有 {risks.length - 2} 项记录在下方完整依据中。</p> : null}

        {missing.length > 0 ? (
          <p className={styles.missing} data-testid="decision-missing">
            <span>仍缺</span>
            {missing.slice(0, 3).join(" · ")}
            {missing.length > 3 ? ` 等 ${missing.length} 项` : ""}
          </p>
        ) : null}

        {risks.length === 0 && missing.length === 0 && !notice ? (
          <p className={styles.empty}>没有记录到关键缺口；这不代表没有风险。</p>
        ) : null}

        <p className={styles.suggestion} data-testid="decision-ai-suggestion">
          <span>AI 建议 · 仅供参考</span>
          <strong>{suggestion.available ? suggestion.nextAction ?? "暂无建议" : "当前不可评估"}</strong>
          {suggestion.available && suggestion.reason ? <em>{suggestion.reason}</em> : null}
        </p>

        {basisText ? <p className={styles.basis} data-testid="decision-basis">{basisText}</p> : null}

        <div className={styles.links}>
          <button type="button" className={styles.link} onClick={onOpenEvidence} data-testid="decision-open-evidence">
            查看完整依据
            <ArrowRight aria-hidden="true" />
          </button>
          <button type="button" className={styles.link} onClick={onOpenReport} data-testid="decision-open-report">
            查看研报与版本
            <ArrowRight aria-hidden="true" />
          </button>
        </div>

        {supportDetail ? (
          <details className={styles.fold} data-testid="decision-support-detail">
            <summary>完整风险规则与系统核对</summary>
            <div className={styles.foldBody}>{supportDetail}</div>
          </details>
        ) : null}
      </section>

      {/* ④ 确认并保存 */}
      <section className={styles.part} aria-label="确认并保存">
        <header className={styles.partHead}>
          <h2>确认并保存</h2>
        </header>

        <dl className={styles.summary} data-testid="decision-summary">
          <div>
            <dt>当前能否提交</dt>
            <dd data-tone={canSubmit ? "ok" : "blocked"}>{canSubmit ? "可以" : "不可以"}</dd>
          </div>
          <div>
            <dt>你选择的决定</dt>
            <dd data-tone={pendingMeta ? "ok" : "muted"}>{pendingMeta ? pendingMeta.label : "尚未选择"}</dd>
          </div>
          <div>
            <dt>已保存的决定</dt>
            <dd data-tone={current ? "ok" : "muted"}>
              {current
                ? `${current.label}${current.chosenAt ? ` · ${new Date(current.chosenAt).toLocaleDateString("zh-CN")}` : ""}${current.stale ? " · 需重新确认" : ""}`
                : "尚未保存"}
            </dd>
          </div>
          <div>
            <dt>04 需求单</dt>
            <dd data-tone={briefReady ? "ok" : "muted"}>{briefLabel}</dd>
          </div>
        </dl>

        <label className={styles.noteField}>
          <span>决策备注（可选）</span>
          <textarea
            rows={2}
            value={note}
            onChange={(event) => onNoteChange(event.target.value)}
            placeholder="记录这次判断的理由；会与当前事实和来源版本一起保存。"
            data-testid="decision-note"
          />
        </label>

        {needsAck ? (
          <label className={styles.ack} data-testid="decision-ack-label">
            <input
              type="checkbox"
              checked={ack}
              onChange={(event) => onAckChange(event.target.checked)}
              data-testid="decision-ack-checkbox"
            />
            <span>
              我已知悉 {gate?.blocking ?? 0} 项阻断风险、{gate?.notComputable ?? 0} 条规则因数据缺失无法评估，仍提交本次判断。
            </span>
          </label>
        ) : null}

        <div className={styles.saveRow}>
          <button
            type="button"
            className={styles.primary}
            onClick={onSubmit}
            disabled={saveDisabled}
            data-testid="decision-submit"
          >
            {busy
              ? "正在保存…"
              : !canSubmit
                ? "当前不可提交"
                : pendingMeta
                  ? `保存决定：${pendingMeta.label}`
                  : "请先选择一种决定"}
          </button>
          <button type="button" className={styles.ghost} onClick={onOpenBrief} data-testid="decision-open-brief">
            <FileText aria-hidden="true" />
            {briefReady ? "查看 04 需求单" : "04 需求单状态"}
          </button>
        </div>

        <p className={styles.hint}>
          {canSubmit
            ? "保存后立即生效；重新选择会覆盖上一次决定。"
            : "当前不可提交：先按上方提示处理，再回到这里选择。"}
        </p>

        {extraActions ? <div className={styles.extra}>{extraActions}</div> : null}
      </section>
    </div>
  );
}
