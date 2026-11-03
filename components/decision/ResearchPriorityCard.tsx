"use client";

/**
 * components/decision/ResearchPriorityCard.tsx
 *
 * AI 研究优先级建议卡片（只读展示）。
 *
 * 展示约束：
 * - 明确标注「AI 建议」，不得表达「AI 决定」；
 * - 不自动推进候选状态；
 * - 不阻塞主流程（加载失败时优雅降级为空）。
 */
import type { ProductDecision, DecisionPriority } from "@/lib/decision/types";

const PRIORITY_CONFIG: Record<
  DecisionPriority,
  { label: string; color: string; bg: string; border: string }
> = {
  P1: {
    label: "P1 · 建议优先研究",
    color: "text-emerald-700",
    bg: "bg-emerald-50",
    border: "border-emerald-200",
  },
  P2: {
    label: "P2 · 可以研究",
    color: "text-sky-700",
    bg: "bg-sky-50",
    border: "border-sky-200",
  },
  P3: {
    label: "P3 · 优先级较低",
    color: "text-amber-700",
    bg: "bg-amber-50",
    border: "border-amber-200",
  },
};

type ResearchPriorityCardProps = {
  /** 候选商品 ID（用于触发分析） */
  candidateId: string;
  /** AI 分析结论 */
  decision: ProductDecision | null;
  /** 是否正在加载 */
  loading: boolean;
  /** 错误信息（有值时展示降级提示） */
  error: string | null;
  /** 点击「重新分析」回调 */
  onRefresh?: () => void;
};

export function ResearchPriorityCard({
  decision,
  loading,
  error,
  onRefresh,
}: ResearchPriorityCardProps) {
  // 加载中：骨架屏
  if (loading) {
    return (
      <div className="rounded-lg border border-slate-100 bg-slate-50 p-4 animate-pulse" data-testid="research-priority-skeleton">
        <div className="h-4 w-32 rounded bg-slate-200 mb-3" />
        <div className="h-6 w-24 rounded bg-slate-200 mb-2" />
        <div className="space-y-2">
          <div className="h-3 w-full rounded bg-slate-100" />
          <div className="h-3 w-3/4 rounded bg-slate-100" />
        </div>
      </div>
    );
  }

  // 错误或无结果：优雅降级（不阻塞主流程）
  if (error || !decision) {
    return (
      <div className="rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs text-slate-400" data-testid="research-priority-empty">
        <span>AI 建议暂不可用</span>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="ml-2 text-slate-500 underline hover:text-slate-700"
          >
            重试
          </button>
        )}
      </div>
    );
  }

  const config = PRIORITY_CONFIG[decision.priority] ?? PRIORITY_CONFIG.P2;
  const confidencePct = Math.round(decision.confidence * 100);
  const isPending = decision.status === "pending" || decision.status === "failed";

  return (
    <div
      className={`rounded-lg border p-4 ${config.bg} ${config.border}`}
      data-testid="research-priority-card"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          {/* AI 标识 */}
          <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[12px] font-medium text-violet-700">
            <svg className="h-2.5 w-2.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path d="M10 2a8 8 0 100 16A8 8 0 0010 2zm0 14a6 6 0 110-12 6 6 0 010 12zm1-7h-2v2H7v2h2v2h2v-2h2v-2h-2V9z" />
            </svg>
            AI 建议
          </span>
          <span className="text-xs text-slate-400">非最终决策</span>
        </div>
        {onRefresh && !isPending && (
          <button
            type="button"
            onClick={onRefresh}
            className="text-[12px] text-slate-400 hover:text-slate-600 transition-colors"
            title="重新分析"
          >
            刷新
          </button>
        )}
      </div>

      {/* Priority + Confidence */}
      <div className="flex items-baseline gap-3 mb-3">
        {isPending ? (
          <span className="text-sm font-medium text-slate-500">分析待完成</span>
        ) : (
          <>
            <span className={`text-base font-semibold ${config.color}`}>{config.label}</span>
            <span className="text-sm text-slate-500">
              置信度 <span className="font-medium text-slate-700">{confidencePct}%</span>
            </span>
          </>
        )}
      </div>

      {/* Reasons */}
      {decision.reasons.length > 0 && !isPending && (
        <div className="mb-2">
          <p className="text-[13px] font-medium text-slate-500 mb-1">分析依据</p>
          <ul className="space-y-0.5">
            {decision.reasons.map((reason, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-slate-700">
                <span className="mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-current opacity-50" />
                {reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Risks */}
      {decision.risks.length > 0 && !isPending && (
        <div>
          <p className="text-[13px] font-medium text-amber-600 mb-1">注意事项</p>
          <ul className="space-y-0.5">
            {decision.risks.map((risk, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-amber-700">
                <span className="mt-0.5 text-amber-500">⚠</span>
                {risk}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Pending状态提示 */}
      {isPending && (
        <p className="text-xs text-slate-500">{decision.reasons[0] ?? "AI 分析服务暂时不可用，不影响正常研究流程。"}</p>
      )}

      {/* 数据提供方标注 */}
      <p className="mt-3 text-[12px] text-slate-400 border-t border-current/10 pt-2">
        由 {decision.provider} 提供建议 · 仅供参考，最终决策由运营人员人工判断
      </p>
    </div>
  );
}
