export type ProductResearchDecisionStatus =
  | "creative_ready"
  | "needs_information"
  | "abandoned";

export const PRODUCT_RESEARCH_DECISION_OPTIONS: ReadonlyArray<{
  value: ProductResearchDecisionStatus;
  label: string;
  description: string;
}> = [
  {
    value: "creative_ready",
    label: "可做（推进立项）",
    description: "表示当前证据支持推进立项；不代表采购、盈利、合规或上架已经成立。",
  },
  {
    value: "needs_information",
    label: "待观察（需补资料）",
    description: "记录缺失证据与下一步补充动作，研究保持开放并暂不推进立项。",
  },
  {
    value: "abandoned",
    label: "不做（排除放弃）",
    description: "停止继续推进，但完整保留 Candidate、研究依据和决定历史。",
  },
];

export function isProductResearchDecisionStatus(
  value: unknown,
): value is ProductResearchDecisionStatus {
  return value === "creative_ready" || value === "needs_information" || value === "abandoned";
}

export function getProductResearchDecisionLabel(status: ProductResearchDecisionStatus): string {
  return PRODUCT_RESEARCH_DECISION_OPTIONS.find((option) => option.value === status)?.label ?? status;
}
