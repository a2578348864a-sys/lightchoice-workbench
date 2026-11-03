"use client";

import { useId } from "react";

import type { ConsoleEvidence } from "./captureConsoleModel";
import styles from "./capture-console.module.css";

const RADIUS = 50;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** 资料证据环：数值只随快照变化；首次渲染直接显示终值（CSS 过渡不会从 0 开始）。 */
export function CaptureEvidenceRing({ evidence }: { evidence: ConsoleEvidence }) {
  const gradientId = `lcRingGrad-${useId().replace(/:/g, "")}`;
  const offset = CIRCUMFERENCE * (1 - Math.min(100, Math.max(0, evidence.percent)) / 100);

  return (
    <section className={styles.card} aria-label="本轮资料证据覆盖">
      <div className={styles.ringCard}>
        <div className={styles.ring}>
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#0f8f74" />
                <stop offset="100%" stopColor="#38bdf8" />
              </linearGradient>
            </defs>
            <circle className={styles.ringTrack} cx="60" cy="60" r={RADIUS} />
            <circle
              className={styles.ringBar}
              cx="60"
              cy="60"
              r={RADIUS}
              stroke={`url(#${gradientId})`}
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={offset}
              data-testid="capture-console-evidence-ring"
            />
          </svg>
          <div className={styles.ringCenter}>
            <b data-testid="capture-console-evidence-count">{evidence.value}</b>
            <span>/ {evidence.total} 单元</span>
          </div>
        </div>
        <div className={styles.ringCopy}>
          <p className={styles.k}>本轮资料覆盖</p>
          <p className={styles.v} data-testid="capture-console-evidence-percent">{evidence.percent}%</p>
          <div className={styles.chipRow}>
            {evidence.failed > 0 ? (
              <span className={styles.chip} data-tone="rose" data-testid="capture-console-failed-chip">
                失败 {evidence.failed}
              </span>
            ) : null}
            {evidence.partial > 0 ? (
              <span className={styles.chip} data-tone="warn" data-testid="capture-console-partial-chip">
                部分 {evidence.partial}
              </span>
            ) : null}
            {evidence.failed === 0 && evidence.partial === 0 ? (
              <span className={styles.chip} data-tone="ok">无失败单元</span>
            ) : null}
          </div>
          <p style={{ marginTop: 6, fontSize: 12.5, color: "#7b9188" }} data-testid="capture-console-evidence-note">
            {evidence.total - evidence.value > 0
              ? `本轮还有 ${evidence.total - evidence.value} 个资料单元未取得有效证据`
              : "本轮全部资料单元已取得有效证据"}
          </p>
        </div>
      </div>
    </section>
  );
}
