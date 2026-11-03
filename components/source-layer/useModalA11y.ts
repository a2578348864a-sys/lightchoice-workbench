"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * 打开中的弹层栈：同一时刻只有「最近打开」的弹层处理键盘事件。
 * 嵌套场景（抽屉里再开危险确认）中，外层若也监听 Tab/Escape 会把焦点抢回自己，
 * 造成焦点错乱或一次 Escape 关掉两层（D0-005）。
 */
const openModalStack: Array<symbol> = [];

/**
 * 弹层（Dialog / Drawer）的模态焦点行为（WAI-ARIA Modal Dialog Pattern）：
 * 1. 打开时把焦点移入弹层；
 * 2. Tab / Shift+Tab 在弹层内循环；
 * 3. Escape 只关闭最上层弹层；
 * 4. 关闭后把焦点还给打开它的触发元素。
 *
 * 实现要点：
 * - onClose 走 ref：父组件内联箭头函数每次渲染都换 identity，
 *   若放进 effect 依赖会导致弹层打开期间反复清理/重跑，
 *   重捕获时焦点已在弹层内，关闭后无法归还（D0-005 复现根因之一）。
 * - 捕获只发生在「关闭 → 打开」的首次 effect，打开期间不再改写 previouslyFocused。
 */
export function useModalA11y(options: {
  open: boolean;
  onClose: () => void;
  /** 弹层容器；焦点被困在这个元素内部。 */
  containerRef: RefObject<HTMLElement | null>;
  /** 打开后优先聚焦的元素；缺省聚焦容器内第一个可聚焦元素。 */
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { open, onClose, containerRef, initialFocusRef } = options;
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const modalIdRef = useRef<symbol>(Symbol("modal"));
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const modalId = modalIdRef.current;
    openModalStack.push(modalId);

    // 记录触发元素，关闭时归还焦点（仅打开时捕获一次）。
    previouslyFocused.current = typeof document === "undefined"
      ? null
      : (document.activeElement as HTMLElement | null);

    const focusables = (): HTMLElement[] => {
      const container = containerRef.current;
      if (!container) return [];
      return Array.from(container.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.offsetParent !== null || element === document.activeElement);
    };

    // 打开后移入焦点（下一次渲染后执行，确保 DOM 已挂载）。
    const focusTimer = window.setTimeout(() => {
      const target = initialFocusRef?.current ?? focusables()[0] ?? containerRef.current;
      target?.focus?.();
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      // 只有栈顶（最上层）弹层响应键盘；下层弹层的监听器直接让行。
      if (openModalStack[openModalStack.length - 1] !== modalId) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !containerRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown, true);
      const stackIndex = openModalStack.lastIndexOf(modalId);
      if (stackIndex >= 0) openModalStack.splice(stackIndex, 1);
      // 关闭后归还焦点；元素可能已从 DOM 移除，因此做存在性判断。
      const previous = previouslyFocused.current;
      if (previous && typeof previous.focus === "function" && document.contains(previous)) {
        previous.focus();
      }
    };
    // onClose 故意不进依赖：identity 由 ref 追踪，避免打开期间 effect 反复重跑。
  }, [open, containerRef, initialFocusRef]);
}
