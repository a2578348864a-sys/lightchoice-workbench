"use client";

import type { ReactNode } from "react";
import styles from "./MarketAreaShell.module.css";

/** 四区共用外壳：标题、口径条、内容卡与空态。只做展示，不持有业务状态。 */
export function AreaHeader({
  kicker,
  title,
  lead,
  meta,
  actions,
}: {
  kicker: string;
  title: string;
  lead: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className={styles.header}>
      <div className={styles.headerMain}>
        <span className={styles.kicker}>{kicker}</span>
        <h2>{title}</h2>
        <p>{lead}</p>
        {meta ? <div className={styles.meta}>{meta}</div> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}

export type CaliberItem = { label: string; value: string; note?: ReactNode; tone?: "warn" | "neutral" };

export function CaliberStrip({ items, label = "口径" }: { items: CaliberItem[]; label?: string }) {
  return (
    <ul className={styles.calibers} aria-label={label}>
      {items.map((item) => (
        <li key={`${item.label}-${item.value}`} data-tone={item.tone ?? "neutral"}>
          <span>{item.label}</span>
          <b>{item.value}</b>
          {item.note ? <small>{item.note}</small> : null}
        </li>
      ))}
    </ul>
  );
}

export function AreaCard({
  kicker,
  title,
  note,
  actions,
  children,
  ariaLabel,
  className = "",
}: {
  kicker?: string;
  title: string;
  note?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <section className={`${styles.card} ${className}`.trim()} aria-label={ariaLabel ?? title}>
      <header className={styles.cardHead}>
        <div>
          {kicker ? <span className={styles.kicker}>{kicker}</span> : null}
          <h3>{title}</h3>
          {note ? <p>{note}</p> : null}
        </div>
        {actions ? <div className={styles.cardActions}>{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function AreaEmpty({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>;
}

export function AreaNote({ children }: { children: ReactNode }) {
  return <p className={styles.note}>{children}</p>;
}

const NATURE_LABELS: Record<string, string> = { fact: "来源观察", estimate: "第三方估算", calculation: "数据计算", inference: "AI 推断", unknown: "未确认" };

/**
 * 本区 AI 判断：只呈现已存报告里属于本区的结论与限制，不含版本选择、生成按钮与全局提示。
 * 同一份报告在五个区各显示一次本区内容，不复制整段报告；过期报告必须标为历史。
 */
export function MarketSectionFindings({
  report,
  section,
  stale,
  generatedAt,
  onOpenReport,
  label = "AI 判断",
}: {
  report: { inputHash: string; generatedAt: string; model: string; workspaces?: Partial<Record<string, { status: "assessed" | "insufficient"; reason: string; summary: { text: string; nature: string }; limits: string[] }>>; findings?: Array<{ title: string; what: string; nature: string; section: string; limits: string[] }> } | undefined;
  section: "competition" | "demand" | "voice" | "comparison";
  stale: boolean;
  generatedAt?: string;
  onOpenReport: () => void;
  label?: string;
}) {
  const workspace = report?.workspaces?.[section];
  const findings = (report?.findings ?? []).filter((item) => item.section === section).slice(0, 2);
  const hasContent = Boolean(workspace?.summary?.text || findings.length);

  return (
    <section className={styles.findings} data-stale={stale || undefined} aria-label={`${label}（本区已存报告）`}>
      <header className={styles.findingsHead}>
        <div>
          <span className={styles.findingsKicker}>{label}</span>
          <h3>{workspace?.status === "insufficient" ? "本区证据不足以下结论" : "这份报告对本区的判断"}</h3>
        </div>
        <div className={styles.findingsMeta}>
          {stale ? (
            <span className={styles.staleTag}>历史报告 · 证据已变化</span>
          ) : (
            <span>{generatedAt ? `${generatedAt.slice(0, 10)} 生成 · ${report?.model ?? "模型未记录"}` : "已存报告"}</span>
          )}
          <button type="button" onClick={onOpenReport}>研究总览 →</button>
        </div>
      </header>

      {!report ? (
        <p className={styles.findingsEmpty}>
          这项研究还没有已存 AI 报告。本区的数据与统计不依赖 AI；需要 AI 判断时到「研究总览」生成一次，五区共用同一份。
        </p>
      ) : !hasContent ? (
        <p className={styles.findingsEmpty}>{workspace?.reason || "这份报告没有记录本区的独立结论；以本区数据与证据为准。"}</p>
      ) : (
        <div className={styles.findingsBody}>
          {workspace?.summary?.text ? (
            <p className={styles.findingsSummary}>
              <span className={styles.natureTag} data-nature={workspace.summary.nature}>{NATURE_LABELS[workspace.summary.nature] ?? workspace.summary.nature}</span>
              {workspace.summary.text}
            </p>
          ) : null}
          {findings.length ? (
            <ul className={styles.findingsList}>
              {findings.map((finding) => (
                <li key={finding.title}>
                  <b>{finding.title}</b>
                  <span>{finding.what}</span>
                  <em className={styles.natureTag} data-nature={finding.nature}>{NATURE_LABELS[finding.nature] ?? finding.nature}</em>
                </li>
              ))}
            </ul>
          ) : null}
          {workspace?.limits?.length ? <p className={styles.findingsLimit}>限制：{workspace.limits.slice(0, 2).join("；")}</p> : null}
        </div>
      )}
    </section>
  );
}
