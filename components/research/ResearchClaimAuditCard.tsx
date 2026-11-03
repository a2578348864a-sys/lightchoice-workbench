import type { ResearchClaimAudit } from "@/lib/research/evidenceAudit";

/**
 * 03 商品深研 —— 研究证据强度审查（只读）。
 *
 * 存在理由：历史研报里出现「风险段说销量缺失、机会段用页面购买量推出需求验证」这类
 * 结论强度超过证据的表述。本卡不改原文、不改权威、不重新生成，只在读侧把
 * 「哪一句超过了证据、为什么、建议怎么改」摆出来，让用户先看这个再决定是否采信。
 */
const SEVERITY_TONE: Record<"BLOCKING" | "WARNING", string> = {
  BLOCKING: "bg-rose-50 text-rose-700",
  WARNING: "bg-amber-50 text-amber-800",
};

const FIELD_LABEL: Record<string, string> = {
  summary: "摘要",
  opportunities: "机会",
  risks: "风险",
  painPoints: "用户问题",
};

export function ResearchClaimAuditCard({ audit }: { audit: ResearchClaimAudit }) {
  const tone = (audit.verdict === "BLOCKED" || audit.verdict === "UNAVAILABLE")
    ? "border-rose-200 bg-rose-50/40"
    : audit.verdict === "NEEDS_DOWNGRADE"
      ? "border-amber-200 bg-amber-50/40"
      : "border-slate-200 bg-white";
  return (
    <section className={`rounded-2xl border p-4 ${tone}`} data-testid="research-claim-audit-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[15px] font-bold text-slate-800">研究证据强度审查</h3>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${(audit.verdict === "BLOCKED" || audit.verdict === "UNAVAILABLE") ? "bg-rose-100 text-rose-700" : audit.verdict === "NEEDS_DOWNGRADE" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"}`}
            data-testid="research-claim-audit-verdict"
          >
            {(audit.verdict === "BLOCKED" || audit.verdict === "UNAVAILABLE") ? (audit.verdict === "UNAVAILABLE" ? "审查不可用" : "存在越级结论") : audit.verdict === "NEEDS_DOWNGRADE" ? "表述需降级" : "未发现越级"}
          </span>
        </div>
        <p className="text-[11px] text-slate-500">原文保留 · 服务端限制采信与下游输出</p>
      </header>

      <p className="mt-2 text-[12px] leading-relaxed text-slate-700" data-testid="research-claim-audit-headline">{audit.headline}</p>

      <div className="mt-2 grid gap-1.5 text-[11px] text-slate-600 sm:grid-cols-2" data-testid="research-claim-audit-market">
        <p>
          销量口径：
          <span className="font-semibold text-slate-800">
            {audit.marketData.salesGrade === "NOT_AVAILABLE" ? "市场层无可用销量数据（不能据此确认销量）" : audit.marketData.salesGrade}
          </span>
        </p>
        <p>
          评论基数：<span className="font-semibold text-slate-800">{audit.marketData.reviewBase ?? "未知"}</span> 条（已持久化事实）
        </p>
        <p>
          研报自述读取：
          <span className="font-semibold text-slate-800">
            {audit.marketData.reviewRead === null ? "未知（研报未写明）" : `${audit.marketData.reviewRead} 条（来自研报文本，无法独立核实）`}
          </span>
        </p>
        <p>
          用户问题引用：
          <span className="font-semibold text-slate-800">
            {audit.marketData.painReferences.total} 处 / 唯一引用 {audit.marketData.painReferences.unique} 个
            {audit.marketData.painReferences.total > audit.marketData.painReferences.unique ? "（存在共享引用，不等于独立买家数）" : ""}
          </span>
        </p>
      </div>

      {audit.flags.length ? (
        <ul className="mt-2 space-y-2" data-testid="research-claim-audit-flags">
          {audit.flags.map((flag, index) => (
            <li key={`${flag.code}-${flag.field}-${flag.index}`} className="rounded-lg bg-white/80 p-2" data-testid={`research-claim-audit-flag-${index}`}>
              <p className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className={`rounded px-1.5 py-0.5 font-semibold ${SEVERITY_TONE[flag.severity]}`}>
                  {flag.severity === "BLOCKING" ? "不能作为结论" : "需降级"}
                </span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">
                  {FIELD_LABEL[flag.field] ?? flag.field} #{flag.index + 1}
                </span>
                <code className="text-[10px] text-slate-400">{flag.code}</code>
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-slate-700">原文：{flag.text}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-600">判定依据：{flag.reason}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-emerald-800">建议表述：{flag.suggested}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[12px] text-slate-500" data-testid="research-claim-audit-empty">
          {audit.verdict === "UNAVAILABLE" ? "当前无法完成证据审查，不能视为审查通过；原文保留，采信与下游输出已受限制。" : "按当前结构化口径（销量可用性 / 读取评论数 / 引用独立性）未发现结论强度超过证据的表述。"}
        </p>
      )}

      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        口径说明：本卡只做确定性检查，不判断结论真假；「不能作为结论」表示该句不能用于立项或派生产品改良方向，原文与研报哈希保持不变。
      </p>
    </section>
  );
}
