"use client";

import { useMemo, useState } from "react";
import { ArrowUpRight, ChevronDown, FileWarning, Lightbulb, ShieldQuestion, Target } from "lucide-react";
import { ROLE_LABEL, type Role } from "../data";
import type { InsightItem, InsightModel } from "./cockpitModel";
import styles from "./cockpit.module.css";

type Tab = "opportunity" | "risk" | "action";

const TAB_META: Array<{ id: Tab; label: string; icon: typeof Lightbulb }> = [
  { id: "opportunity", label: "机会", icon: Lightbulb },
  { id: "risk", label: "风险", icon: FileWarning },
  { id: "action", label: "待验证", icon: Target },
];

export function InsightCard({
  insight,
  onOpenEvidence,
  onOpenSubject,
  onNav,
}: {
  insight: InsightModel;
  onOpenEvidence: (item: InsightItem, tab: Tab) => void;
  onOpenSubject: (subjectKey: string) => void;
  onNav: (screen: "overview" | "gate") => void;
}) {
  const counts: Record<Tab, number> = {
    opportunity: insight.opportunities.length,
    risk: insight.risks.length,
    action: insight.actions.length,
  };
  const firstAvailable: Tab = counts.opportunity ? "opportunity" : counts.risk ? "risk" : "action";
  const [tab, setTab] = useState<Tab>(firstAvailable);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const items = useMemo(() => {
    if (tab === "opportunity") return insight.opportunities;
    if (tab === "risk") return insight.risks;
    return insight.actions;
  }, [tab, insight]);

  const hasContent = counts.opportunity + counts.risk + counts.action > 0;

  return (
    <section className={`${styles.card} ${styles.insightCard}`} aria-labelledby="ck-insight-title">
      <header className={styles.cardHead}>
        <div>
          <p className={styles.kicker}>AI 研判</p>
          <h2 id="ck-insight-title" className={styles.cardTitle}>机会与风险</h2>
        </div>
        <span className={styles.pill} data-tone={insight.status === "ready" ? "ok" : insight.status === "stale" ? "warn" : "muted"}>
          {insight.statusLabel}
        </span>
      </header>

      {insight.status === "stale" || insight.status === "missing" ? (
        <p className={styles.insightBanner} data-tone={insight.status === "stale" ? "warn" : "muted"} role="status">
          {insight.statusDetail}
          {insight.generatedAt ? <span> · 生成于 {insight.generatedAt.slice(0, 10)} · {insight.model ?? "模型未知"}</span> : null}
        </p>
      ) : insight.status === "unavailable" ? (
        <p className={styles.insightBanner} data-tone="muted" role="status">{insight.statusDetail}</p>
      ) : null}

      {!hasContent ? (
        <div className={styles.emptyBlock}>
          <strong>没有可展示的结构化结论</strong>
          <p>{insight.providerReady ? "研报未包含机会/风险条目，不补写结论。" : "AI 服务未配置有效凭据，当前无法生成研报。"}</p>
          <button type="button" className={styles.inlineCta} onClick={() => onNav("overview")}>
            进入 02 研究总览查看证据
            <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <>
          <div className={styles.insightTabs} role="tablist" aria-label="机会与风险分类">
            {TAB_META.map((meta) => {
              const Icon = meta.icon;
              const active = tab === meta.id;
              return (
                <button
                  key={meta.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={styles.insightTab}
                  data-active={active ? "true" : undefined}
                  onClick={() => {
                    setTab(meta.id);
                    setExpandedId(null);
                  }}
                >
                  <Icon size={13} aria-hidden="true" />
                  {meta.label}
                  <em>{counts[meta.id]}</em>
                </button>
              );
            })}
          </div>

          <ul className={styles.insightList} data-scroll={expandedId ? "true" : undefined}>
            {items.map((item) => {
              const expanded = expandedId === item.id;
              return (
                <li key={item.id} className={styles.insightItem} data-expanded={expanded ? "true" : undefined}>
                  <button
                    type="button"
                    className={styles.insightItemHead}
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : item.id)}
                  >
                    <span className={styles.insightItemTitle}>{item.title}</span>
                    <span className={styles.insightItemSummary}>{item.summary}</span>
                    <ChevronDown size={15} className={styles.insightChevron} aria-hidden="true" />
                  </button>
                  {expanded ? (
                    <div className={styles.insightBody}>
                      {item.fields.map((field) => (
                        <div key={field.label} className={styles.insightField}>
                          <span>{field.label}</span>
                          <p>{field.value}</p>
                        </div>
                      ))}
                      {item.lists.map((list) => (
                        <div key={list.label} className={styles.insightField}>
                          <span>{list.label}</span>
                          <ul className={styles.insightBullets}>
                            {list.items.map((entry) => <li key={entry}>{entry}</li>)}
                          </ul>
                        </div>
                      ))}
                      {item.relatedSubjects.length ? (
                        <div className={styles.insightField}>
                          <span>相关商品</span>
                          <div className={styles.subjectRow}>
                            {item.relatedSubjects.map((subject) => (
                              <button
                                key={subject.subjectKey}
                                type="button"
                                className={styles.subjectChip}
                                onClick={() => onOpenSubject(subject.subjectKey)}
                              >
                                {subject.subjectKey.split(":").at(-1)}
                                {subject.role ? <em>{ROLE_LABEL[subject.role as Role] ?? subject.role}</em> : null}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {tab === "opportunity" ? (
                        <p className={styles.insightHint}>
                          下一步验证方向见「待验证」标签（{counts.action} 项）；引用可定位不等于结论已成立。
                        </p>
                      ) : null}
                      <button
                        type="button"
                        className={styles.inlineCta}
                        onClick={() => onOpenEvidence(item, tab)}
                      >
                        查看证据、来源与限制
                        <ArrowUpRight size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <p className={styles.cardNote}>
        <ShieldQuestion size={13} aria-hidden="true" /> AI 提议 ≠ 来源事实 ≠ 人工确认；不生成机会分数或市场规模。
      </p>
    </section>
  );
}
