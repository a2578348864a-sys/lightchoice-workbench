"use client";

/**
 * 数字首次进入视口时计数。
 * 移植 Magic UI Number Ticker 的交互语义（延迟、小数位、tabular-nums、只播放一次），
 * 依赖不兼容（本仓库未安装 motion）故改为 requestAnimationFrame + IntersectionObserver 的等价实现。
 * 支持 prefers-reduced-motion：直接显示终值。
 */
import { useEffect, useRef, useState } from "react";
import styles from "./cockpit.module.css";

function format(value: number, decimals: number): string {
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function NumberTicker({
  value,
  duration = 900,
  decimals = 0,
  prefix = "",
  suffix = "",
  className,
  ariaLabel,
  immediate = false,
}: {
  value: number;
  duration?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
  ariaLabel?: string;
  /** true 时挂载即计数（用于首屏 KPI，避免未进入视口时长期显示 0）。 */
  immediate?: boolean;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const playedRef = useRef(false);
  const fromRef = useRef(0);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const reduce = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      playedRef.current = true;
      setCurrent(value);
      return;
    }

    const run = () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      const from = fromRef.current;
      const start = performance.now();
      const step = (now: number) => {
        const progress = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        setCurrent(from + (value - from) * eased);
        if (progress < 1) frameRef.current = requestAnimationFrame(step);
        else frameRef.current = null;
      };
      frameRef.current = requestAnimationFrame(step);
    };

    if (playedRef.current || immediate) {
      playedRef.current = true;
      run();
      return () => {
        if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      };
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        playedRef.current = true;
        run();
        observer.disconnect();
      }
    }, { threshold: 0.25 });
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    };
  }, [value, duration, immediate]);

  useEffect(() => {
    if (playedRef.current) fromRef.current = value;
  }, [value]);

  const text = `${prefix}${format(current, decimals)}${suffix}`;
  return (
    <span ref={ref} className={`${styles.ticker} ${className ?? ""}`}>
      <span aria-hidden="true">{text}</span>
      <span className={styles.srOnly}>{ariaLabel ?? `${prefix}${format(value, decimals)}${suffix}`}</span>
    </span>
  );
}
