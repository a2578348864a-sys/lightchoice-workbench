"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type AnchoredMenuProps = {
  ariaLabel: string;
  title?: string;
  triggerClassName?: string;
  triggerContent: ReactNode;
  panelClassName?: string;
  /** start = 面板左边缘对齐按钮；end = 右边缘对齐（表格行、卡片右下角用 end） */
  align?: "start" | "end";
  testId?: string;
  children: (close: () => void) => ReactNode;
};

/**
 * 03 列表用的锚定浮层。
 *
 * 为什么不用 `<details>` + `position:absolute`：卡片和 Hero 都有 `overflow:hidden`
 * （用于圆角与顶部渐变），绝对定位的菜单会被父级裁掉，表现为「点了没反应」。
 * 这里把面板 portal 到 body、用 fixed 定位并按视口夹取/上下翻转，
 * 点击外部、Esc、滚动、选中项都会关闭；不改 01/02 的共享组件。
 */
export function AnchoredMenu({
  ariaLabel,
  title,
  triggerClassName,
  triggerContent,
  panelClassName,
  align = "end",
  testId,
  children,
}: AnchoredMenuProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const box = trigger.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const gap = 6;
    const pad = 8;

    let top = box.bottom + gap;
    if (top + height > window.innerHeight - pad) {
      const above = box.top - height - gap;
      top = above >= pad ? above : Math.max(pad, window.innerHeight - height - pad);
    }
    const preferredLeft = align === "end" ? box.right - width : box.left;
    const left = Math.min(Math.max(pad, preferredLeft), Math.max(pad, window.innerWidth - width - pad));

    setPos({ top, left });
  }, [align]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    /**
     * 滚动关闭要留一段「打开宽限」：点击触发按钮时，浏览器可能正好在把按钮滚进视口
     * （列表加载更多之后、行在折叠区下方时都会发生）。该 scroll 事件在 click 之后才派发，
     * 于是菜单刚打开就被自己的关闭监听关掉，用户看到的是「点了没反应」。
     * 实测：23 张卡片时真实点击 aria-expanded 保持 false，脚本直接 click() 才能打开。
     * 只忽略打开瞬间的这批滚动，之后用户继续滚动仍然按原逻辑关闭。
     */
    const openedAt = performance.now();
    const OPEN_SCROLL_GRACE_MS = 250;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const close = () => setOpen(false);
    const closeOnScroll = () => {
      if (performance.now() - openedAt < OPEN_SCROLL_GRACE_MS) return;
      setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
        className={triggerClassName}
        data-testid={testId}
        onClick={() => setOpen((value) => !value)}
      >
        {triggerContent}
      </button>
      {open && mounted
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              aria-label={ariaLabel}
              className={panelClassName}
              data-testid={testId ? `${testId}-panel` : undefined}
              style={{
                position: "fixed",
                top: pos?.top ?? 0,
                left: pos?.left ?? 0,
                zIndex: 70,
                opacity: pos ? 1 : 0,
              }}
            >
              {children(() => setOpen(false))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
