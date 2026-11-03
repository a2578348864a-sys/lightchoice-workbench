import { calculatePurchaseCostCeiling, type ProductBrief } from "@/lib/productBrief/contract";

/**
 * E-1E：产品开发需求单「批准」按钮的前置条件（客户端预判，服务端仍是权威）。
 *
 * 服务端在 productBriefService.saveProductBrief 里用**本次提交值**判定：
 *   targetPrice / targetMarginPct 非空，且 calculatePurchaseCostCeiling(...).status === "COMPUTED"，
 * 否则返回 422 PRODUCT_BRIEF_NOT_READY。
 *
 * 这里用同一套纯函数与同样口径（提交值，而不是 GET 返回的旧 purchaseCostCeiling）预先算出原因，
 * 只用于禁用按钮和展示原因；不放宽、不替代服务端校验。
 */
export type ApprovalGateInput = {
  targetPrice: string | number | null;
  targetMarginPct: string | number | null;
  referralFee: string | number | null;
  logistics: string | number | null;
  estimatedTax: string | number | null;
  otherKnownCosts?: string | number | null;
  /** 表单里不可编辑、但测算需要的固定成本项（来自当前需求单 economics）。 */
  fbaFee: number | null;
  currency?: string | null;
};

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 返回 null 表示可以批准；返回字符串表示不可批准的原因（用于按钮 title/说明）。 */
export function deriveApprovalBlockedReason(input: ApprovalGateInput): string | null {
  const targetPrice = toNumber(input.targetPrice);
  const targetMarginPct = toNumber(input.targetMarginPct);
  if (targetPrice === null) return "缺少目标价格：先填写目标售价才能批准。";
  if (targetMarginPct === null) return "缺少目标毛利率：先填写目标毛利率才能批准。";
  if (input.fbaFee === null) {
    /**
     * 措辞必须与**真实来源**一致（本轮已核实）：
     * - Amazon 商品页抽取**刻意排除** FBA 行（`detail-page-expression-source` 明确 skip，
     *   `fba_fee` 恒为 undefined，测试断言 rows 只有 2 条）——所以「重新采集商品详情」不可能补出 FBA；
     * - 系统里 FBA 唯一来源是卖家精灵适配器的「预估FBA费」（`estimatedFbaFee`，metricNature=estimate），
     *   需要来源层配置后才能取到；
     * - 04 页面按设计不提供手工补填（FBA 属平台费用，不能由人工填成商品事实）。
     * 历史文案先写「先在测算区补齐」（该入口不存在），后写「补采该商品的 FBA」（Amazon 页永远给不出），
     * 两次都把用户引向做不到的动作。这里只陈述真实来源与可行下一步，不放宽批准门禁。
     */
    return "当前商品事实缺少 FBA 费用：Amazon 商品页不提供该字段（系统按设计不把第三方浮层数值当作商品事实），"
      + "唯一合法来源是卖家精灵的「预估 FBA 费」，需先在来源层配置并重新采集；04 页面不提供手工补填。"
      + "在补齐之前可保持「待评审」并继续完善需求单，但不能批准。";
  }

  const ceiling = calculatePurchaseCostCeiling({
    targetPrice,
    targetMarginPct,
    referralFee: toNumber(input.referralFee),
    fbaFee: input.fbaFee,
    logistics: toNumber(input.logistics),
    estimatedTax: toNumber(input.estimatedTax),
    otherKnownCosts: toNumber(input.otherKnownCosts),
    currency: input.currency ?? undefined,
  });
  if (ceiling.status === "COMPUTED") return null;
  return `采购成本上限不可计算：${ceiling.reason ?? "成本项不完整"}（需目标价格、目标毛利率、平台费、FBA、物流与估算税费齐全且非负）。`;
}

export function approvalGateFromBrief(
  brief: Pick<ProductBrief, "economics">,
  form: {
    targetPrice: string;
    targetMarginPct: string;
    referralFee: string;
    logistics: string;
    estimatedTax: string;
    otherKnownCosts: string;
  },
): string | null {
  return deriveApprovalBlockedReason({
    targetPrice: form.targetPrice,
    targetMarginPct: form.targetMarginPct,
    referralFee: form.referralFee,
    logistics: form.logistics,
    estimatedTax: form.estimatedTax,
    otherKnownCosts: form.otherKnownCosts,
    fbaFee: brief.economics.fbaFee,
    currency: brief.economics.currency,
  });
}
