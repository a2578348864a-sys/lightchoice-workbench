"use client";

import { useCallback, useEffect, useRef } from "react";
import { ArrowLeft, X } from "lucide-react";
import styles from "./ResearchMaterialDrawer.module.css";

export type MaterialDrawerMeta = {
  /** 阅读器标题，例如「AI 研报与引用」 */
  title: string;
  /** 一行来源/口径说明，例如「当前权威报告 · rev.3」 */
  subtitle?: string | null;
  /** 风险或状态标识（历史/失效/不可采信等） */
  badges?: readonly { label: string; tone: "ok" | "warn" | "blocked" | "muted" }[];
  /** 返回上一层（档案索引）；不传则不显示返回 */
  onBack?: (() => void) | null;
};

/**
 * 03 统一资料阅读器。
 *
 * 设计约束（Owner 已确认）：
 * - 桌面端右侧滑出，窄屏接近全屏；只承载「阅读」，不承载成本表单。
 * - 关闭（按钮 / Esc / 点击遮罩）后页面不重排、不滚动、不丢失当前工作区与选中主题。
 * - 内部只有一层内容，不再造第二套 Tab 导航；返回档案索引时用单一「返回」按钮。
 */
export function ResearchMaterialDrawer({
  meta,
  onClose,
  children,
  testId = "research-material-drawer",
}: {
  meta: MaterialDrawerMeta;
  onClose: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown, true);
    const timer = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>("[data-drawer-close]")?.focus();
    }, 30);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      // 关闭后把焦点还给触发按钮，键盘用户不会掉到页面顶部
      restoreRef.current?.focus?.();
    };
  }, [handleKeyDown]);

  return (
    <div className={styles.overlay} role="presentation" data-testid={testId}>
      <div className={styles.scrim} onClick={onClose} aria-hidden="true" />
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lc-material-drawer-title"
        ref={panelRef}
      >
        <header className={styles.head}>
          <div className={styles.headMain}>
            {meta.onBack ? (
              <button type="button" className={styles.back} onClick={meta.onBack} data-testid="material-drawer-back">
                <ArrowLeft aria-hidden="true" />
                返回资料目录
              </button>
            ) : null}
            <h2 id="lc-material-drawer-title" className={styles.title}>{meta.title}</h2>
            {meta.subtitle ? <p className={styles.subtitle}>{meta.subtitle}</p> : null}
            {meta.badges?.length ? (
              <ul className={styles.badges}>
                {meta.badges.map((badge) => (
                  <li key={badge.label} data-tone={badge.tone}>{badge.label}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="关闭资料阅读器" data-drawer-close data-testid="material-drawer-close">
            <X aria-hidden="true" />
          </button>
        </header>
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}
