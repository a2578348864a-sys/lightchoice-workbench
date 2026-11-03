import type { MarketIntelligence } from "@/lib/marketScan/intelligence";

/**
 * 报告生成/更新的可用性与原因说明。
 *
 * 这里只做**展示层**的可用性推导：是否允许点击由服务端 Route/Guard 最终裁决。
 * 五区与总览共用同一份推导，避免两个入口对同一份数据给出不同的禁用原因。
 */
export type ReportActionState = {
  disabled: boolean;
  reason: string;
  label: string;
  canRecover: boolean;
};

export function deriveReportActionState({
  data,
  busy,
  comparisonSubjects,
  hasReport,
}: {
  data: MarketIntelligence;
  busy: boolean;
  comparisonSubjects: string[];
  hasReport: boolean;
}): ReportActionState {
  const canRecover = Boolean(
    data.recoverableReport &&
    !data.recoverableReport.stale &&
    JSON.stringify([...data.recoverableReport.comparisonSubjects].sort()) === JSON.stringify([...comparisonSubjects].sort()),
  );
  const disabled = busy || Boolean(data.aiOperations?.length) || !data.statistics?.sampleCount || Boolean(data.scope?.changed) || (!data.provider.ready && !canRecover);
  const reason = busy
    ? "正在执行操作，请稍候…"
    : data.aiOperations?.length
      ? "已有 AI 请求尚未确认结束，请先在上方核对并解除阻塞。"
      : !data.statistics?.sampleCount
        ? "当前没有可用于分析的有效正式样本。"
        : data.scope?.changed
          ? "商品归属确认与正式统计范围尚未同步，请先在商品对比核实并应用排除项。"
          : !data.provider.ready && !canRecover
            ? data.provider.message
            : canRecover
              ? "直接保存上次已通过校验的模型结果，不重复计费。"
              : data.provider.message;
  const label = busy
    ? "正在处理…"
    : canRecover
      ? "保存已生成的报告（不重复计费）"
      : hasReport
        ? "更新整份研究报告"
        : "生成整份研究报告";
  return { disabled, reason, label, canRecover };
}
