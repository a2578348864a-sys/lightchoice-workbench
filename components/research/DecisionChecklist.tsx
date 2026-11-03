type ChecklistItem = {
  readonly key: string;
  readonly label: string;
  readonly status: "passed" | "blocked" | "warning" | "missing";
  readonly detail: string;
};

type DeliverySummary = {
  readonly checklist?: readonly ChecklistItem[];
  readonly actionReasons?: readonly string[];
  readonly recommendedNextAction?: string;
  readonly researchPriority?: string;
};

const STATUS_META: Record<ChecklistItem["status"], { label: string; className: string }> = {
  passed: { label: "通过", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  warning: { label: "预警", className: "bg-amber-50 text-amber-700 border-amber-200" },
  blocked: { label: "阻断", className: "bg-rose-50 text-rose-700 border-rose-200" },
  missing: { label: "缺失", className: "bg-slate-100 text-slate-500 border-slate-200" },
};

/**
 * P0-DC-02：决策核对清单（8 项三态）+ 确定性归因。
 * 数据来自 decisionDelivery.decisionSummary（纯确定性计算，零 AI）。
 */
export function DecisionChecklist({ summary }: { summary: DeliverySummary }) {
  const checklist = summary.checklist ?? [];
  const reasons = summary.actionReasons ?? [];
  if (!checklist.length) {
    return (
      <div data-testid="decision-checklist" className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-[13px] text-slate-500">
        决策核对清单暂不可用（证据边界未就绪）。
      </div>
    );
  }
  return (
    <div data-testid="decision-checklist" className="rounded-xl border border-slate-200 bg-white p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-slate-900">决策核对清单（8 项）</span>
        <span className="text-[12px] text-slate-400">确定性计算 · 非 AI 结论</span>
      </div>
      <ul className="space-y-1.5">
        {checklist.map((item) => {
          const meta = STATUS_META[item.status] ?? STATUS_META.missing;
          return (
            <li key={item.key} className="flex items-start gap-2 rounded-lg border border-slate-100 bg-slate-50/50 p-2" data-testid={`checklist-item-${item.key}`}>
              <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[12px] font-semibold ${meta.className}`} data-testid={`checklist-status-${item.key}`}>
                {meta.label}
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-slate-800">{item.label}</p>
                <p className="text-[12px] leading-snug text-slate-500">{item.detail}</p>
              </div>
            </li>
          );
        })}
      </ul>
      {reasons.length > 0 && (
        <div className="border-t border-slate-100 pt-2">
          <p className="text-[12px] font-semibold text-slate-600 mb-1">依据（自动生成归因）：</p>
          <ul className="space-y-0.5">
            {reasons.map((reason, index) => (
              <li key={index} className="text-[12px] leading-snug text-slate-500" data-testid="checklist-action-reason">
                · {reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
