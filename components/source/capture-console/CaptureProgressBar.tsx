"use client";

import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";

import type { ConsoleProgress } from "./captureConsoleModel";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import styles from "./capture-console.module.css";

const DURATION_MS = 650;

/**
 * 连续渐变进度条。
 *
 * 快照纪律：
 * - 首次渲染直接显示服务端值，不做 0→N 表演；
 * - 只有 value 前进时才从旧值过渡到新值；
 * - value 回退（重试/重置）时立即回退，不播放前进动画；
 * - 完成扫光只在「从非完成 → 完成」时播放一次，刷新/重开不重播。
 */
export function CaptureProgressBar({ progress }: { progress: ConsoleProgress }) {
  const reduced = usePrefersReducedMotion();
  const [display, setDisplay] = useState(progress.value);
  const previousValue = useRef(progress.value);
  const previousState = useRef(progress.state);
  const [instant, setInstant] = useState(false);
  const [sweep, setSweep] = useState(false);

  useEffect(() => {
    const from = previousValue.current;
    previousValue.current = progress.value;

    if (from === progress.value) return;

    if (reduced || progress.value < from) {
      setInstant(true);
      setDisplay(progress.value);
      const timer = window.setTimeout(() => setInstant(false), 260);
      return () => window.clearTimeout(timer);
    }

    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (progress.value - from) * eased);
      if (t < 1) frame = requestAnimationFrame(step);
      else frame = 0;
    };
    frame = requestAnimationFrame(step);
    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [progress.value, reduced]);

  useEffect(() => {
    const was = previousState.current;
    previousState.current = progress.state;
    if (was === "completed" || progress.state !== "completed" || reduced) return;
    setSweep(true);
    const timer = window.setTimeout(() => setSweep(false), 1200);
    return () => window.clearTimeout(timer);
  }, [progress.state, reduced]);

  const shown = Math.round(display);
  const percent = progress.total > 0 ? Math.min(100, (display / progress.total) * 100) : 0;
  const indeterminate = progress.total <= 0;
  const hasProgress = progress.value > 0;

  return (
    <section
      className={styles.progressCard}
      data-state={progress.state}
      data-has-progress={hasProgress ? "true" : "false"}
      data-indeterminate={indeterminate ? "true" : "false"}
      data-sweep={sweep ? "true" : "false"}
      role="group"
      aria-label="本轮任务处理进度"
    >
      <div className={styles.progressTop}>
        <div className={styles.progressLabel}>
          <h3>本轮任务进度</h3>
          <span>本次授权处理的商品 · 与批次有效样本是两个口径</span>
        </div>
        <div className={styles.figure}>
          <b data-testid="capture-console-processed">{shown}</b>
          <span className={styles.slash}>/</span>
          <span className={styles.den}>{progress.total}</span>
          <span className={styles.unit}>件</span>
        </div>
      </div>

      <div
        className={styles.track}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.total > 0 ? progress.total : undefined}
        aria-valuenow={progress.total > 0 ? progress.value : undefined}
        aria-label="已处理商品"
      >
        <div
          className={styles.fill}
          data-instant={instant ? "true" : "false"}
          style={{ "--p": `${indeterminate ? 34 : percent}%` } as CSSProperties}
        >
          <span className={styles.shimmer} aria-hidden="true" />
          <span className={styles.sweep} aria-hidden="true" />
        </div>
        <span
          className={styles.edge}
          style={{ "--p": `${indeterminate ? 34 : percent}%` } as CSSProperties}
          aria-hidden="true"
        />
        <span className={styles.tick} style={{ "--x": "25%" } as CSSProperties} aria-hidden="true" />
        <span className={styles.tick} style={{ "--x": "50%" } as CSSProperties} aria-hidden="true" />
        <span className={styles.tick} style={{ "--x": "75%" } as CSSProperties} aria-hidden="true" />
      </div>

      <div className={styles.progressBottom}>
        <span className={styles.stateWord}>{progress.stateWord}</span>
        <span>{progress.updatedLabel ? `最后更新 ${progress.updatedLabel}` : "等待服务端快照"}</span>
      </div>
    </section>
  );
}
