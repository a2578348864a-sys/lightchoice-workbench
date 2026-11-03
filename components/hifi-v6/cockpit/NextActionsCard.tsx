"use client";

import { ArrowRight, Lock, ListChecks } from "lucide-react";
import type { CockpitAction } from "./cockpitModel";
import styles from "./cockpit.module.css";

export function NextActionsCard({
  actions,
  onAction,
}: {
  actions: CockpitAction[];
  onAction: (action: CockpitAction) => void;
}) {
  return (
    <section className={`${styles.card} ${styles.actionsCard}`} aria-labelledby="ck-actions-title">
      <header className={styles.cardHead}>
        <div>
          <p className={styles.kicker}>待处理事项</p>
          <h2 id="ck-actions-title" className={styles.cardTitle}>下一步行动</h2>
        </div>
        <span className={styles.pill} data-tone="muted"><ListChecks size={12} aria-hidden="true" />{actions.length} 项</span>
      </header>

      {actions.length === 0 ? (
        <div className={styles.emptyBlock}>
          <strong>当前没有需要处理的待办</strong>
          <p>行动项只从已有证据缺口、冲突与门禁状态派生，不额外创建任务。</p>
        </div>
      ) : (
        <ol className={styles.actionList}>
          {actions.map((action) => {
            const blocked = action.target.kind === "blocked";
            return (
              <li key={action.id}>
                <button
                  type="button"
                  className={styles.actionItem}
                  data-tone={action.tone}
                  data-blocked={blocked ? "true" : undefined}
                  disabled={blocked}
                  aria-disabled={blocked}
                  title={blocked ? action.blockedReason ?? undefined : undefined}
                  onClick={() => {
                    if (!blocked) onAction(action);
                  }}
                >
                  <span className={styles.actionDot} aria-hidden="true" />
                  <span className={styles.actionText}>
                    <strong>{action.title}</strong>
                    <small>{action.detail}</small>
                    {blocked ? (
                      <em className={styles.actionCta} data-blocked="true">
                        <Lock size={11} aria-hidden="true" />
                        {action.blockedReason ?? "条件未满足"}
                      </em>
                    ) : (
                      <em className={styles.actionCta}>
                        {action.cta}
                        <ArrowRight size={12} aria-hidden="true" />
                      </em>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <p className={styles.cardNote}>行动项只做跳转与查看，不代表动作已完成或已通过门禁。</p>
    </section>
  );
}
