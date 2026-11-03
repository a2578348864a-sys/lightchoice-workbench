type CardSummary = {
  readonly researchPriority?: "P1" | "P2" | "P3";
  readonly recommendedNextAction?: "继续研究" | "补充数据" | "暂停";
  readonly actionReasons?: readonly string[];
  readonly missingInformation?: readonly string[];
};

type CardRiskCounts = {
  readonly blocking: number;
  readonly warning: number;
  readonly notComputable: number;
  readonly passed: number;
};

export type JudgmentCardDelivery = {
  readonly status: "available" | "unavailable";
  readonly reason?: string;
  readonly aiInvoked?: boolean;
  readonly decisionSummary?: CardSummary;
  readonly riskCounts?: CardRiskCounts;
};

const UNAVAILABLE_REASONS: Record<string, string> = {
  PRODUCT_FACT_MISSING: "尚未读取到已确认的商品事实。",
  ASSEMBLY_FAILED: "决策装配失败，无法完成确定性评估。",
  BOUNDARY_UNAVAILABLE: "证据边界不可读，请先检查研究资料完整性。",
};

const NEXT_ACTION_META: Record<string, { label: string; className: string }> = {
  继续研究: { label: "继续研究", className: "text-emerald-700" },
  补充数据: { label: "补充数据", className: "text-amber-700" },
  暂停: { label: "暂停", className: "text-rose-700" },
};

export const PRIORITY_LABELS: Record<string, string> = {
  P1: "P1 · 优先研究",
  P2: "P2 · 常规研究",
  P3: "P3 · 数据不足延后",
};

/**
 * P0-DC-01：商品判断卡。
 * 固定「系统建议」角标；无证据不出建议；纯确定性计算，未调用 AI。
 */
export function JudgmentCard({ delivery }: { delivery: JudgmentCardDelivery }) {
  if (delivery.status !== "available" || !delivery.decisionSummary) {
    const reasonText = (delivery.reason && UNAVAILABLE_REASONS[delivery.reason]) || "数据不足，暂不给出判断。";
    return (
      <div data-testid="judgment-card" data-advisory="true" className="rounded-xl border border-dashed border-amber-300 bg-amber-50/70 p-3">
        <div className="flex items-center justify-between mb-1">
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[12px] font-bold text-amber-800">系统建议 · 仅供参考</span>
          <span className="text-[12px] text-amber-600">确定性计算 · 未调用 AI</span>
        </div>
        <p className="text-xs font-semibold text-amber-900">数据不足，不给建议</p>
        <p className="mt-0.5 text-[13px] leading-snug text-amber-700">{reasonText}</p>
      </div>
    );
  }
  const summary = delivery.decisionSummary;
  const counts = delivery.riskCounts;
  const actionMeta = summary.recommendedNextAction
    ? NEXT_ACTION_META[summary.recommendedNextAction] ?? { label: summary.recommendedNextAction, className: "text-slate-700" }
    : null;
  const reasons = summary.actionReasons ?? [];
  return (
    <div data-testid="judgment-card" data-advisory="true" className="rounded-xl border-2 border-indigo-200 bg-indigo-50/40 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[12px] font-bold text-indigo-800">系统建议 · 仅供参考，最终决策由人工做出</span>
      </div>
      <div className="flex items-center gap-2">
        {summary.researchPriority && (
          <span className="rounded bg-white px-1.5 py-0.5 text-[13px] font-bold text-slate-700 border border-slate-200" data-testid="judgment-priority">
            {PRIORITY_LABELS[summary.researchPriority] ?? summary.researchPriority}
          </span>
        )}
        {actionMeta && (
          <span className={`text-sm font-bold ${actionMeta.className}`} data-testid="judgment-next-action">
            {actionMeta.label}
          </span>
        )}
      </div>
      {reasons.length > 0 && (
        <ul className="space-y-0.5">
          {reasons.slice(0, 4).map((reason, index) => (
            <li key={index} className="text-[13px] leading-snug text-slate-600" data-testid="judgment-reason">· {reason}</li>
          ))}
        </ul>
      )}
      {counts && (
        <div className="flex flex-wrap gap-1.5 text-[12px]">
          <span className="rounded bg-rose-50 px-1.5 py-0.5 font-semibold text-rose-700" data-testid="judgment-count-blocking">阻断 {counts.blocking}</span>
          <span className="rounded bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-700" data-testid="judgment-count-warning">预警 {counts.warning}</span>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-500" data-testid="judgment-count-missing">缺失 {counts.notComputable}</span>
        </div>
      )}
      <p className="text-[12px] text-slate-400 border-t border-indigo-100 pt-1.5">
        确定性规则计算 · 本卡未调用 AI
        {summary.missingInformation && summary.missingInformation.length > 0
          ? ` · ${summary.missingInformation.length} 项关键数据待补`
          : ""}
      </p>
    </div>
  );
}
