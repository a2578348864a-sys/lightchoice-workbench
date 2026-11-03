"use client";

/**
 * components/decision/useResearchPriority.ts
 *
 * 客户端 Hook，获取并管理候选商品的 AI 研究优先级建议。
 *
 * 设计原则：
 * - 懒加载（用户看到候选卡片时才触发，不预加载）；
 * - 失败时静默降级，不中断主流程；
 * - 不缓存跨组件结果（每个候选卡片独立管理自身状态）。
 */
import { useCallback, useEffect, useState } from "react";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import type { ProductDecision } from "@/lib/decision/types";

type UseResearchPriorityState = {
  decision: ProductDecision | null;
  loading: boolean;
  error: string | null;
};

type UseResearchPriorityReturn = UseResearchPriorityState & {
  /** 手动触发重新分析 */
  refresh: () => void;
  /** 是否已经发起过分析请求 */
  triggered: boolean;
};

/**
 * 获取候选商品的 AI 研究优先级建议。
 *
 * @param candidateId 候选商品 ID
 * @param autoLoad 是否在 mount 时自动加载（默认 false，需要手动调用 refresh）
 */
export function useResearchPriority(
  candidateId: string | null,
  autoLoad = false
): UseResearchPriorityReturn {
  const [state, setState] = useState<UseResearchPriorityState>({
    decision: null,
    loading: false,
    error: null,
  });
  const [triggered, setTriggered] = useState(false);

  const fetchDecision = useCallback(async () => {
    if (!candidateId) return;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    setTriggered(true);
    try {
      const response = await fetch(
        `/api/decision/research-priority/${encodeURIComponent(candidateId)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...buildAccessHeaders(),
          },
        }
      );

      if (!response.ok) {
        // API 级别错误 → 静默降级，不展示错误（避免打扰用户主流程）
        setState({ decision: null, loading: false, error: "analysis_unavailable" });
        return;
      }

      const body: unknown = await response.json();
      if (
        typeof body === "object" &&
        body !== null &&
        (body as Record<string, unknown>)["ok"] === true
      ) {
        const data = (body as Record<string, unknown>)["data"];
        const resolved = (data as ProductDecision) ?? null;
        if (resolved && typeof window !== "undefined") {
          try {
            window.sessionStorage.setItem(`qx:decision-priority:${candidateId}`, JSON.stringify(resolved));
          } catch {
            // ignore storage quota
          }
        }
        setState({
          decision: resolved,
          loading: false,
          error: null,
        });
      } else {
        setState({ decision: null, loading: false, error: "analysis_unavailable" });
      }
    } catch {
      // 网络错误 → 静默降级
      setState({ decision: null, loading: false, error: "network_error" });
    }
  }, [candidateId]);

  // 挂载时尝试从 sessionStorage 恢复已有 snapshot
  useEffect(() => {
    if (!candidateId || typeof window === "undefined") return;
    try {
      const cached = window.sessionStorage.getItem(`qx:decision-priority:${candidateId}`);
      if (cached) {
        const parsed = JSON.parse(cached) as ProductDecision;
        if (parsed?.priority) {
          setState({ decision: parsed, loading: false, error: null });
          setTriggered(true);
        }
      }
    } catch {
      // ignore
    }
  }, [candidateId]);

  useEffect(() => {
    if (autoLoad && candidateId && !triggered) {
      void fetchDecision();
    }
  }, [autoLoad, candidateId, triggered, fetchDecision]);

  return { ...state, refresh: fetchDecision, triggered };
}
