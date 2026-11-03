"use client";

/**
 * 指针跟随高光（React Bits「Spotlight Card」交互语义的等价实现）。
 * 不引入 motion 依赖，只写 CSS 变量，由样式层渲染径向光斑。
 */
import { useCallback, useRef } from "react";

export function useSpotlight<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const onPointerMove = useCallback((event: React.PointerEvent<T>) => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    element.style.setProperty("--mx", `${Math.round(event.clientX - rect.left)}px`);
    element.style.setProperty("--my", `${Math.round(event.clientY - rect.top)}px`);
  }, []);
  return { ref, onPointerMove };
}
