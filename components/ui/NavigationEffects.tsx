"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

/** Visual effects only: both existing shells retain their own navigation and state. */
export function NavigationEffects({ railRef, collapsed, activeKey }: {
  railRef: RefObject<HTMLElement | null>;
  collapsed: boolean;
  activeKey: string;
}) {
  const id = useId();
  const spineRef = useRef<HTMLSpanElement>(null);
  const [tooltip, setTooltip] = useState<{ text: string; left: number; top: number } | null>(null);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    let described: HTMLElement | null = null;
    let frame = 0;
    const hide = () => {
      if (described) {
        const remaining = (described.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(value => value && value !== id);
        if (remaining.length) described.setAttribute("aria-describedby", remaining.join(" "));
        else described.removeAttribute("aria-describedby");
      }
      described = null;
      setTooltip(null);
    };
    const item = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;
    const show = (element: HTMLElement | null) => {
      if (!collapsed || !element || !rail.contains(element)) return;
      hide();
      const box = element.getBoundingClientRect();
      const text = element.getAttribute("aria-label") || element.dataset.tip || "";
      if (!text) return;
      described = element;
      element.setAttribute("aria-describedby", [element.getAttribute("aria-describedby"), id].filter(Boolean).join(" "));
      setTooltip({ text, left: rail.getBoundingClientRect().right + 10, top: Math.min(window.innerHeight - 38, Math.max(8, box.top + (box.height - 30) / 2)) });
    };
    const update = () => {
      frame = 0;
      const active = rail.querySelector<HTMLElement>('.lc-site-nav-link[aria-current="page"], .nav-item.active');
      const spine = spineRef.current;
      if (!spine) return;
      if (!active) { spine.style.opacity = "0"; return; }
      const box = active.getBoundingClientRect(), bounds = rail.getBoundingClientRect();
      spine.style.top = `${box.top - bounds.top + rail.scrollTop + 11}px`;
      spine.style.left = `${box.left - bounds.left - 4}px`;
      spine.style.height = `${Math.max(12, box.height - 24)}px`;
      spine.style.opacity = "1";
    };
    const schedule = () => { if (!frame) { if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(update); else update(); } };
    // Pointer-relative radial highlight adapted from Magic UI MagicCard (MIT).
    // Copyright (c) Magic UI. Full notice: components/ui/NavigationEffects.LICENSE.md.
    const move = (event: PointerEvent) => {
      const element = item(event.target);
      if (!element) return;
      const box = element.getBoundingClientRect();
      element.style.setProperty("--lc-nav-x", `${event.clientX - box.left}px`);
      element.style.setProperty("--lc-nav-y", `${event.clientY - box.top}px`);
    };
    const over = (event: PointerEvent) => show(item(event.target));
    const out = (event: PointerEvent) => { if (item(event.target) !== item(event.relatedTarget)) hide(); };
    const focus = (event: FocusEvent) => show(item(event.target));
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    const resize = () => { hide(); schedule(); };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    if (observer) {
      observer.observe(rail);
      for (const nav of rail.querySelectorAll("nav")) observer.observe(nav);
    }
    rail.addEventListener("pointermove", move);
    rail.addEventListener("pointerover", over);
    rail.addEventListener("pointerout", out);
    rail.addEventListener("focusin", focus);
    rail.addEventListener("focusout", hide);
    rail.addEventListener("keydown", key);
    rail.addEventListener("click", hide);
    rail.addEventListener("scroll", hide);
    window.addEventListener("resize", resize);
    window.addEventListener("scroll", hide, true);
    update();
    return () => {
      observer?.disconnect();
      if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      hide();
      rail.removeEventListener("pointermove", move);
      rail.removeEventListener("pointerover", over);
      rail.removeEventListener("pointerout", out);
      rail.removeEventListener("focusin", focus);
      rail.removeEventListener("focusout", hide);
      rail.removeEventListener("keydown", key);
      rail.removeEventListener("click", hide);
      rail.removeEventListener("scroll", hide);
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", hide, true);
    };
  }, [railRef, collapsed, activeKey, id]);

  return <>
    <span ref={spineRef} className="lc-navigation-spine" aria-hidden="true" />
    {tooltip && createPortal(<div id={id} role="tooltip" className="lc-navigation-tooltip" style={{ left: tooltip.left, top: tooltip.top }}>{tooltip.text}</div>, document.body)}
  </>;
}
