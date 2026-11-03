import type { MarketGateStatus } from "@/lib/marketWorkflow/metadata";

/**
 * 市场闸门状态的中文标签（唯一来源，供页面与测试共用）。
 *
 * P5-v6：PROCEED 原来显示为「已通过」，容易被读成"这个市场机会已通过评审"。
 * 它的真实语义只是工作流门禁——满足样本/证据口径并显式确认缺失数据后，
 * **允许把流程推进到代表商品与商品研究**，不代表市场机会、产品开发或商业可行性已确认。
 */
export const GATE_STATUS_LABELS: Record<MarketGateStatus, string> = {
  PENDING: "待处理",
  PROCEED: "允许继续研究",
  VALIDATE_MORE: "需补充验证",
  PAUSE: "暂缓",
  DROP: "放弃",
};

/** 该状态是否需要额外解释「不等于机会成立」。 */
export const GATE_SEMANTICS_HINT = "「允许继续研究」只代表满足进入下一研究阶段的流程条件（样本充分 + 缺失数据已确认），不代表市场机会、产品开发或商业可行性已经获得确认。";

export function gateSemanticsFor(status: MarketGateStatus | null | undefined): string | null {
  return status === "PROCEED" ? GATE_SEMANTICS_HINT : null;
}
