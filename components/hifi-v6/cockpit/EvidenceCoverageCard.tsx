"use client";

import { ArrowUpRight, MessageSquareText, ShieldAlert, Sparkles } from "lucide-react";
import { NumberTicker } from "./NumberTicker";
import type { EvidenceModel } from "./cockpitModel";
import styles from "./cockpit.module.css";

export type EvidenceDrawerKind = "conflicts" | "missing" | "coverage";

export function EvidenceCoverageCard({
  evidence,
  onOpen,
}: {
  evidence: EvidenceModel;
  onOpen: (kind: EvidenceDrawerKind) => void;
}) {
  const coveragePct = evidence.coverageRatio == null ? null : Math.round(evidence.coverageRatio * 100);
  const rows = [
    {
      id: "reviews" as const,
      icon: MessageSquareText,
      tone: "blue",
      label: "已读取评论",
      value: evidence.reviewsRead,
      unit: "条",
      detail: "已保存证据去重后的原声条数",
      drawer: "coverage" as const,
    },
    {
      id: "coverage" as const,
      icon: Sparkles,
      tone: "green",
      label: "ASIN 评论覆盖",
      value: evidence.asinCovered,
      unit: `/${evidence.sampleCount}`,
      detail: coveragePct == null ? "覆盖尚未读取" : `占锁定样本 ${coveragePct}%，未覆盖不代表无问题`,
      drawer: "coverage" as const,
    },
    {
      id: "conflicts" as const,
      icon: ShieldAlert,
      tone: "risk",
      label: "评价数冲突",
      value: evidence.conflictCount,
      unit: "件",
      detail: "搜索页与商品页读数不一致，未解决前不作强度判断",
      drawer: "conflicts" as const,
    },
  ];

  return (
    <section className={`${styles.card} ${styles.evidenceCard}`} aria-labelledby="ck-evidence-title">
      <header className={styles.cardHead}>
        <div>
          <p className={styles.kicker}>覆盖与冲突</p>
          <h2 id="ck-evidence-title" className={styles.cardTitle}>证据覆盖</h2>
        </div>
        <span className={styles.pill} data-tone={evidence.statisticsReady ? "ok" : "warn"}>
          {evidence.statisticsReady ? "统计已就绪" : "统计待读取"}
        </span>
      </header>

      <div className={styles.statList}>
        {rows.map((row) => {
          const Icon = row.icon;
          return (
            <button
              key={row.id}
              type="button"
              className={styles.statRow}
              data-tone={row.tone}
              onClick={() => onOpen(row.drawer)}
              aria-label={`${row.label}：${row.value ?? "未知"}，查看明细`}
            >
              <span className={styles.statIcon} aria-hidden="true"><Icon size={15} /></span>
              <span className={styles.statBody}>
                <span className={styles.statLabel}>{row.label}</span>
                <span className={styles.statDetail}>{row.detail}</span>
              </span>
              <span className={styles.statValue}>
                {row.value != null
                  ? <NumberTicker value={row.value} ariaLabel={`${row.value}`} />
                  : <em>未知</em>}
                <small>{row.unit}</small>
              </span>
              <ArrowUpRight size={13} className={styles.statArrow} aria-hidden="true" />
            </button>
          );
        })}
      </div>

      {coveragePct != null ? (
        <div className={styles.coverageBar} aria-hidden="true">
          <span style={{ width: `${Math.max(coveragePct, 2)}%` }} />
        </div>
      ) : null}

      <div className={styles.gapRow}>
        <span className={styles.gapLabel}>证据缺口 {evidence.missing.length} 类</span>
        {evidence.missing.length
          ? evidence.missing.slice(0, 3).map((item) => (
              <button
                key={item.code}
                type="button"
                className={styles.gapChip}
                onClick={() => onOpen("missing")}
                title={item.detail}
              >
                {item.label}
              </button>
            ))
          : <span className={styles.gapEmpty}>未读取到缺口清单；不能据此认定数据完整。</span>}
      </div>

      <p className={styles.cardNote}>
        公开评论为非随机样本，覆盖率与冲突读数只描述当前证据，不推算全市场抱怨比例。
      </p>
    </section>
  );
}
