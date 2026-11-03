import { describe, expect, it } from "vitest";

import { buildDecisionDelivery } from "./decisionDelivery";
import { makeProductFact } from "@/lib/marketScan/__fixtures__/productFactFixture";

describe("buildDecisionDelivery (P0-DC 决策交付装配)", () => {
  it("可用输入 → 组装 available：8 项清单、计数守恒、零 AI 调用", () => {
    const delivery = buildDecisionDelivery({ bundle: { productFact: makeProductFact() } });

    expect(delivery.status).toBe("available");
    expect(delivery.assembleVersion).toBe("decision-delivery.v1");
    expect(delivery.aiInvoked).toBe(false);

    const summary = delivery.decisionSummary;
    const gate = delivery.riskGate;
    const counts = delivery.riskCounts;
    expect(summary).toBeDefined();
    expect(gate).toBeDefined();
    expect(counts).toBeDefined();
    if (!summary || !gate || !counts) return;

    expect(summary.checklist).toHaveLength(8);
    expect(["P1", "P2", "P3"]).toContain(summary.researchPriority);
    expect(["继续研究", "补充数据", "暂停"]).toContain(summary.recommendedNextAction);
    expect(Array.isArray(summary.actionReasons)).toBe(true);
    expect(summary.actionReasons!.length).toBeGreaterThan(0);

    expect(gate.rules.length).toBeGreaterThan(0);
    for (const rule of gate.rules) {
      expect(["triggered", "passed", "not_computable"]).toContain(rule.status);
    }
    expect(counts.blocking + counts.warning + counts.notComputable + counts.passed).toBe(gate.rules.length);

    // 建议与确定性门禁一致（builder 规则）
    if (gate.hasBlockingRisk) {
      expect(summary.recommendedNextAction).toBe("暂停");
    } else if (summary.missingInformation.length >= 3) {
      expect(summary.recommendedNextAction).toBe("补充数据");
    }
  });

  it("productFact 缺失 → unavailable（fail-closed，不编造建议）", () => {
    const delivery = buildDecisionDelivery({ bundle: { productFact: null } });
    expect(delivery.status).toBe("unavailable");
    expect(delivery.aiInvoked).toBe(false);
    expect(delivery.reason).toBe("PRODUCT_FACT_MISSING");
    expect(delivery.decisionSummary).toBeUndefined();
  });

  it("not_computable 规则计入缺失计数（渲染层显示数据缺失而非通过）", () => {
    const delivery = buildDecisionDelivery({ bundle: { productFact: makeProductFact() } });
    if (delivery.status !== "available" || !delivery.riskGate || !delivery.riskCounts) return;
    const notComputableRules = delivery.riskGate.rules.filter((rule) => rule.status === "not_computable");
    expect(delivery.riskCounts.notComputable).toBe(notComputableRules.length);
  });
});

describe("buildDecisionDelivery · V6 人工商业输入接通", () => {
  // 事实新鲜 + 包装/FBA 事实齐备 → 用户只需补采购成本/头程/广告费率即可算出经济性。
  const freshFact = () => makeProductFact({ capturedAt: "2026-10-13T00:00:00.000Z", price: 30 });
  const assumptions = {
    procurementCost: { amount: 4, currency: "USD" as const },
    shippingMode: "sea_fast" as const,
    targetTacosRate: 0.1,
  };

  it("提供情景假设后，经济性相关规则由不可计算变为可判定（假设确实被采纳）", () => {
    const withoutInputs = buildDecisionDelivery({ bundle: { productFact: freshFact() }, marketplace: "US" });
    const withInputs = buildDecisionDelivery({ bundle: { productFact: freshFact() }, assumptions, marketplace: "US" });

    expect(withoutInputs.status).toBe("available");
    expect(withInputs.status).toBe("available");
    expect(withoutInputs.aiInvoked).toBe(false);
    expect(withInputs.aiInvoked).toBe(false);
    expect(withoutInputs.riskCounts).toBeDefined();
    expect(withInputs.riskCounts).toBeDefined();
    if (!withoutInputs.riskCounts || !withInputs.riskCounts) return;

    // 采纳假设后至少多出一条可判定规则
    expect(withInputs.riskCounts.notComputable).toBeLessThan(withoutInputs.riskCounts.notComputable);

    const negative = withInputs.riskGate?.rules.find((rule) => rule.ruleId === "NEGATIVE_NET_PROFIT");
    expect(negative?.status).toBe("passed");
  });

  it("提供假设也不会自动产生 PROCEED 或替用户做决定", () => {
    const delivery = buildDecisionDelivery({ bundle: { productFact: freshFact() }, assumptions, marketplace: "US" });
    expect(delivery.aiInvoked).toBe(false);
    const action = delivery.decisionSummary?.recommendedNextAction;
    expect(["继续研究", "补充数据", "暂停"]).toContain(action);
    // 系统建议的取值域里不存在 PROCEED；人工决策仍由用户独立签发
    expect(JSON.stringify(delivery)).not.toContain("PROCEED");
  });
});
