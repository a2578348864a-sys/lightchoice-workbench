"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, MoreHorizontal } from "lucide-react";
import styles from "./BatchWorkspace.module.css";

export type HeaderMenuAction = {
  key: string;
  label: string;
  icon?: ReactNode;
  testId?: string;
  onSelect: () => void;
  disabled?: boolean;
  /** 禁用原因必须真实可读（门禁/权限/批次状态），不能只把按钮变灰。 */
  disabledReason?: string;
  busy?: boolean;
  busyLabel?: string;
  tone?: "default" | "danger";
  separatorBefore?: boolean;
  hidden?: boolean;
};

export type HeaderPrimaryAction = {
  label: string;
  testId: string;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  busy?: boolean;
  busyLabel?: string;
};

/**
 * 批次工作区头部：批量身份、真实状态、样本门槛与操作。
 * 低频/运行类动作收进「更多」；主操作保留唯一强调色按钮，避免一屏多个同权重按钮。
 */
export function BatchWorkspaceHeader({
  batchName,
  createdAt,
  marketplace,
  sourceLabel,
  archivedAt,
  statusPill,
  qualityPill,
  rawCount,
  validSampleCount,
  thresholdText,
  thresholdTone,
  unverifiedCount,
  primaryAction,
  gateAction,
  onOpenConsole,
  onOpenEvidence,
  menuItems,
}: {
  batchName: string;
  createdAt: string;
  marketplace: string | null;
  sourceLabel: string;
  archivedAt: string | null;
  statusPill: { label: string; tone: "ok" | "warn" | "off" | "info" };
  qualityPill: { label: string; tone: "ok" | "warn" | "off" | "info" } | null;
  rawCount: number;
  validSampleCount: number;
  thresholdText: string;
  thresholdTone: "ok" | "warn";
  unverifiedCount: number;
  primaryAction: HeaderPrimaryAction;
  gateAction?: { label: string; disabledReason: string };
  onOpenConsole: () => void;
  onOpenEvidence: () => void;
  menuItems: HeaderMenuAction[];
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const visibleItems = menuItems.filter((item) => !item.hidden);

  useEffect(() => {
    if (!menuOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    }
    function onPointer(event: MouseEvent | PointerEvent) {
      const root = menuRef.current;
      if (!root) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      setMenuOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [menuOpen]);

  const created = new Date(createdAt);
  const createdLabel = Number.isNaN(created.getTime()) ? "创建时间未知" : created.toLocaleDateString("zh-CN");
  const market = (marketplace || "US").toUpperCase();

  return (
    <header className={styles.header}>
      <div className={styles.headerMain}>
        <p className={styles.eyebrow}>{sourceLabel} · {createdLabel} · Amazon {market}</p>
        <h2 className={styles.title}>{batchName || "未命名批次"}</h2>
        <div className={styles.badgeRow}>
          <span className={styles.pill} data-tone={statusPill.tone} data-testid="batch-status-badge">
            {statusPill.label}
          </span>
          {qualityPill ? <span className={styles.pill} data-tone={qualityPill.tone}>{qualityPill.label}</span> : null}
          {archivedAt ? <span className={styles.pill} data-tone="off">已归档</span> : null}
        </div>
        <div className={styles.metaRow} data-testid="batch-result-summary">
          <span><b>{rawCount}</b> 商品记录</span>
          <span className={styles.metaDot} aria-hidden="true">·</span>
          <span><b>{validSampleCount}</b> 有效样本</span>
          <span className={styles.metaDot} aria-hidden="true">·</span>
          <span className={thresholdTone === "ok" ? styles.metaOk : styles.metaWarn}>{thresholdText}</span>
          {unverifiedCount > 0 ? (
            <>
              <span className={styles.metaDot} aria-hidden="true">·</span>
              <span className={styles.metaWarn}>{unverifiedCount} 待核对</span>
            </>
          ) : null}
        </div>
      </div>

      <div className={styles.actions}>
        {primaryAction.href && !primaryAction.disabled ? (
          <a
            className={styles.btnPrimary}
            href={primaryAction.href}
            data-testid={primaryAction.testId}
          >
            {primaryAction.label}
          </a>
        ) : (
          <button
            type="button"
            className={styles.btnPrimary}
            data-testid={primaryAction.testId}
            onClick={primaryAction.onClick}
            disabled={primaryAction.disabled || primaryAction.busy}
            title={primaryAction.disabledReason}
          >
            {primaryAction.busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
            {primaryAction.busy && primaryAction.busyLabel ? primaryAction.busyLabel : primaryAction.label}
          </button>
        )}

        <button type="button" className={styles.btnSoft} data-testid="open-capture-console" onClick={onOpenConsole}>
          采集控制台
        </button>
        <button type="button" className={styles.btnSoft} data-testid="open-evidence-history" onClick={onOpenEvidence}>
          资料与来源
        </button>
        {gateAction ? (
          <button
            type="button"
            className={styles.btnSoft}
            disabled
            title={gateAction.disabledReason}
          >
            {gateAction.label}
          </button>
        ) : null}

        {visibleItems.length > 0 ? (
          <div className={styles.menuWrap} ref={menuRef}>
            <button
              type="button"
              ref={menuButtonRef}
              className={styles.menuBtn}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="更多批次操作"
              data-testid="batch-more-actions"
              onClick={() => setMenuOpen((prev) => !prev)}
            >
              <MoreHorizontal size={17} aria-hidden="true" />
            </button>
            {menuOpen ? (
              <div className={styles.menu} role="menu" aria-label="更多批次操作">
                {visibleItems.map((item) => (
                  <div key={item.key}>
                    {item.separatorBefore ? <div className={styles.menuSep} aria-hidden="true" /> : null}
                    <button
                      type="button"
                      role="menuitem"
                      className={styles.menuItem}
                      data-tone={item.tone === "danger" ? "danger" : undefined}
                      data-testid={item.testId}
                      disabled={item.disabled || item.busy}
                      title={item.disabled ? item.disabledReason : undefined}
                      onClick={() => {
                        setMenuOpen(false);
                        item.onSelect();
                      }}
                    >
                      {item.busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : item.icon}
                      {item.busy && item.busyLabel ? item.busyLabel : item.label}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}
