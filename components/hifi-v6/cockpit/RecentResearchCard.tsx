"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { GATE_LABEL } from "../data";
import type { RecentResearch } from "../researchPresentation";
import styles from "./cockpit.module.css";

export function RecentResearchCard({
  recent,
  currentId,
}: {
  recent: RecentResearch[];
  currentId: string | null;
}) {
  return (
    <section className={`${styles.card} ${styles.recentCard}`} aria-labelledby="ck-recent-title">
      <header className={styles.cardHead}>
        <div>
          <p className={styles.kicker}>研究记录</p>
          <h2 id="ck-recent-title" className={styles.cardTitle}>最近研究</h2>
        </div>
        <span className={styles.pill} data-tone="muted">按实际研究对象打开</span>
      </header>

      {recent.length === 0 ? (
        <div className={styles.emptyBlock}>
          <strong>还没有可打开的研究记录</strong>
          <p>完成一次市场采集后，这里会列出真实研究对象。</p>
        </div>
      ) : (
        <ul className={styles.recentList}>
          {recent.map((item) => {
            const isCurrent = currentId === item.id;
            return (
              <li key={item.id}>
                <Link
                  href={`/market-analysis/${encodeURIComponent(item.id)}?view=overview`}
                  className={styles.recentItem}
                  data-current={isCurrent ? "true" : undefined}
                  aria-label={`打开研究：${item.name}`}
                >
                  <span className={styles.recentThumb}>
                    {item.image
                      ? <img src={item.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
                      : <span className={styles.recentThumbEmpty} aria-hidden="true" />}
                  </span>
                  <span className={styles.recentBody}>
                    <span className={styles.recentTags}>
                      {isCurrent ? <span className={styles.tagCurrent}>当前</span> : null}
                      <span className={styles.tagGate} data-tone={item.stale ? "warn" : "ok"}>
                        {item.stale ? "需重新确认" : GATE_LABEL[item.gate]}
                      </span>
                    </span>
                    <strong className={styles.recentName}>{item.name}</strong>
                    <small className={styles.recentMeta}>{item.site} · {item.count || "待核对"} 件锁定样本</small>
                  </span>
                  <ArrowUpRight size={14} className={styles.recentArrow} aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
