import { describe, expect, it } from "vitest";
import { calculatePurchaseCostCeiling } from "@/lib/productBrief/contract";
import { approvalGateFromBrief, deriveApprovalBlockedReason } from "@/lib/productBrief/approvalGate";

const ready = {
  targetPrice: "29.99",
  targetMarginPct: "35",
  referralFee: "4.5",
  logistics: "3.2",
  estimatedTax: "1.8",
  otherKnownCosts: "0",
  fbaFee: 5.1,
  currency: "USD",
};

describe("E-1E 需求单批准前置条件（客户端预判，服务端 422 仍是权威）", () => {
  it("成本项齐全且可计算时允许批准", () => {
    expect(deriveApprovalBlockedReason(ready)).toBeNull();
  });

  it("缺少目标价格或目标毛利率时给出具体原因", () => {
    expect(deriveApprovalBlockedReason({ ...ready, targetPrice: "" })).toContain("目标价格");
    expect(deriveApprovalBlockedReason({ ...ready, targetMarginPct: "" })).toContain("目标毛利率");
    expect(deriveApprovalBlockedReason({ ...ready, targetPrice: "abc" })).toContain("目标价格");
  });

  it("缺少 FBA 费用时不可批准（与服务端口径一致，fbaFee 参与测算）", () => {
    expect(deriveApprovalBlockedReason({ ...ready, fbaFee: null })).toContain("FBA");
  });

  it("FBA 缺失的提示必须陈述真实来源与可行下一步", () => {
    const blocked = deriveApprovalBlockedReason({ ...ready, fbaFee: null }) ?? "";
    // 真实来源：Amazon 商品页不提供，唯一来源是卖家精灵预估字段
    expect(blocked).toContain("Amazon 商品页不提供");
    expect(blocked).toContain("卖家精灵");
    expect(blocked).toContain("不提供手工补填");
    expect(blocked).toContain("待评审");
    // 反向断言：不得再让用户去不存在的入口，也不得暗示「重新采集商品详情」能补出 FBA
    expect(blocked).not.toContain("先在测算区补齐成本项");
    expect(blocked).not.toContain("补采该商品的 FBA 费用");
  });

  it("目标毛利高于售价导致采购成本上限不可计算时给出原因", () => {
    const blocked = deriveApprovalBlockedReason({ ...ready, targetPrice: "10", targetMarginPct: "90" });
    expect(blocked).toContain("采购成本上限不可计算");
    // 与合同层同一函数的结果保持一致，避免两套判定
    const ceiling = calculatePurchaseCostCeiling({
      targetPrice: 10,
      targetMarginPct: 90,
      referralFee: 4.5,
      fbaFee: 5.1,
      logistics: 3.2,
      estimatedTax: 1.8,
      otherKnownCosts: 0,
      currency: "USD",
    });
    expect(ceiling.status).toBe("NOT_COMPUTABLE");
  });

  it("approvalGateFromBrief 用表单值而非旧 purchaseCostCeiling 判定", () => {
    const briefLike = {
      economics: {
        targetPrice: 19.99,
        targetMarginPct: 30,
        referralFee: 3,
        fbaFee: 5,
        logistics: 3,
        estimatedTax: 1.5,
        otherKnownCosts: 0,
        currency: "USD",
        purchaseCostCeiling: { status: "COMPUTED" as const, value: 1, currency: "USD", formula: "x", reason: null },
      },
    };
    // 表单里的价格被清空 → 即使旧的 purchaseCostCeiling 仍是 COMPUTED，也必须判为不可批准
    expect(approvalGateFromBrief(briefLike, {
      targetPrice: "",
      targetMarginPct: "30",
      referralFee: "3",
      logistics: "3",
      estimatedTax: "1.5",
      otherKnownCosts: "0",
    })).toContain("目标价格");
    expect(approvalGateFromBrief(briefLike, {
      targetPrice: "29.99",
      targetMarginPct: "30",
      referralFee: "3",
      logistics: "3",
      estimatedTax: "1.5",
      otherKnownCosts: "0",
    })).toBeNull();
  });
});
