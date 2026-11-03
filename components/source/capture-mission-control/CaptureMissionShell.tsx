"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Radar, X } from "lucide-react";

import { useModalA11y } from "@/components/source-layer/useModalA11y";
import styles from "./capture-mission-control.module.css";

export type MissionPhaseTone = "ready" | "running" | "done" | "warn" | "error";

/**
 * LightChoice Capture Mission Control 的沉浸式外壳。
 *
 * 仅负责「大尺寸工作面板」的层级、焦点、关闭和固定头部；业务状态仍由
 * CaptureMissionPlan / BatchCaptureRunPanel 使用现有服务端合同驱动。
 */
export function CaptureMissionShell({
  ariaLabel,
  batchName,
  marketplace,
  sourceLabel,
  phaseLabel,
  phaseTone,
  onClose,
  children,
  padded = false,
}: {
  ariaLabel: string;
  batchName: string;
  marketplace: string | null;
  sourceLabel: string;
  phaseLabel: string;
  phaseTone: MissionPhaseTone;
  onClose: () => void;
  children: ReactNode;
  padded?: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const titleId = "capture-mission-control-title";

  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    if (!mounted) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [mounted]);

  useModalA11y({ open: mounted, onClose, containerRef: shellRef });

  if (!mounted) return null;

  const market = (marketplace || "US").toUpperCase();

  return createPortal(
    <div className={styles.overlay} data-testid="capture-mission-control" role="presentation">
      <div className={styles.backdrop} aria-hidden="true" onClick={onClose} />
      <section
        ref={shellRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-label={ariaLabel}
        className={styles.shell}
      >
        <header className={styles.topbar}>
          <div className={styles.brand}>
            <span className={styles.brandMark} aria-hidden="true"><Radar size={18} strokeWidth={1.8} /></span>
            <div className={styles.brandCopy}>
              <p className={styles.brandKicker}>轻选工作台 · 采集任务控制台</p>
              <h2 id={titleId} className={styles.brandTitle}>{batchName || "采集任务驾驶舱"}</h2>
            </div>
          </div>

          <div className={styles.topContext} aria-label="当前批次上下文">
            <span className={styles.contextChip}>{sourceLabel}</span>
            <span className={styles.contextChip}>Amazon {market}</span>
            <span className={styles.phasePill} data-tone={phaseTone}>
              <i className={styles.phaseDot} aria-hidden="true" />
              {phaseLabel}
            </span>
          </div>

          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="关闭采集任务驾驶舱" data-testid="capture-mission-close">
            <X size={18} />
          </button>
        </header>

        <div className={`${styles.shellBody} ${padded ? styles.shellBodyPadded : ""}`}>
          {children}
        </div>
      </section>
    </div>,
    document.body,
  );
}
