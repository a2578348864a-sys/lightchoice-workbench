import { describe, expect, it } from "vitest";
import { PRODUCT_BRIEF_SCHEMA, type ProductBrief } from "./contract";
import { buildBriefDecisionSummary } from "./briefDecisionSummary";
import { buildImprovementPlan } from "@/lib/research/improvementPlan";

const baseBrief = (overrides: Partial<ProductBrief> = {}): ProductBrief => ({
  schemaVersion: PRODUCT_BRIEF_SCHEMA,
  status: "READY",
  revision: 3,
  generatedAt: "2026-10-05T00:00:00.000Z",
  sourceBinding: {
    taskId: "task-1",
    researchRevision: 2,
    reportHash: "reporthash-abc",
    factHash: "facthash-abc",
    evidenceHash: "evidencehash-abc",
    marketScanId: null,
    marketSampleHash: null,
  },
  identity: { asin: "B0HFS7K4GP", title: "测试硅胶垫", imageUrl: null, brand: null, category: null, marketplace: "US" },
  projectOverview: null,
  targetUser: null,
  corePainPoints: [{ text: "首次按压角落卡扣需要较大力度，安装体验存在一定费力感。", nature: "EVIDENCE_DERIVED", evidenceRefs: ["attachment:att-1"] }],
  benchmarks: [],
  differentiation: [],
  economics: {
    targetPrice: 15.88,
    targetMarginPct: 35,
    referralFee: null,
    fbaFee: null,
    logistics: null,
    estimatedTax: null,
    otherKnownCosts: null,
    currency: "USD",
    purchaseCostCeiling: { status: "NOT_COMPUTABLE", value: null, currency: "USD", formula: "x", reason: "缺 FBA" },
  },
  specsDirection: [],
  vocQaRedlines: [],
  risks: [],
  rationale: [],
  missingValidation: ["平台 referral fee 尚未提供，购买成本上限暂不能完整计算。", "头程/物流成本尚未提供，不能猜测。"],
  ...overrides,
});

const OBSERVATION_PLAN = buildImprovementPlan({
  observations: [{ statement: "首次按压角落卡扣需要较大力度，安装体验存在一定费力感。", evidenceRefs: ["attachment:att-1"] }],
  sourceDisclosure: { sourceKind: "v5", missingFacts: ["原因假设（competitionInsight.causalInvestigations）", "验证动作（verification）"] },
});

describe("buildBriefDecisionSummary（04 决策摘要）", () => {
  it("三层状态分开表达：文档 / 研究 / 人工，互不冒充", () => {
    const summary = buildBriefDecisionSummary({ brief: baseBrief(), plan: OBSERVATION_PLAN, stale: false });
    const byKey = new Map(summary.levels.map((level) => [level.key, level]));
    expect(byKey.get("document")!.value).toBe("待评审（READY）");
    // READY 只是文档生命周期状态：必须写明不代表通过立项评审
    expect(byKey.get("document")!.note).toContain("不代表已通过立项评审");
    expect(byKey.get("research")!.value).toContain("仅有问题陈述");
    expect(byKey.get("human")!.value).toContain("无人工立项记录");
    expect(summary.levels).toHaveLength(3);
  });

  it("APPROVED 也只说文档已批准，不等于生产授权", () => {
    const summary = buildBriefDecisionSummary({ brief: baseBrief({ status: "APPROVED" }), plan: OBSERVATION_PLAN, stale: false });
    const human = summary.levels.find((level) => level.key === "human")!;
    expect(human.value).toContain("标记批准");
    expect(human.note).toContain("不等于生产或采购授权");
  });

  it("批准门禁未通过时写进人工状态说明，而不是含糊说「可批准」", () => {
    const summary = buildBriefDecisionSummary({
      brief: baseBrief(),
      plan: OBSERVATION_PLAN,
      stale: false,
      approvalBlockedReason: "当前商品事实缺少 FBA 费用：Amazon 商品页不提供该字段。",
    });
    const human = summary.levels.find((level) => level.key === "human")!;
    expect(human.note).toContain("批准门禁未通过");
    expect(summary.headlineBasis).toContain("批准门禁");
  });

  it("只有问题陈述时，结论是「可先验证但不构成立项依据」", () => {
    const summary = buildBriefDecisionSummary({ brief: baseBrief(), plan: OBSERVATION_PLAN, stale: false });
    expect(summary.headline).toContain("仅有问题陈述");
    expect(summary.headline).toContain("尚不具备立项依据");
    expect(summary.headlineBasis).toContain("v5 综合研报");
  });

  it("来源已变化时不给任何立项暗示", () => {
    const summary = buildBriefDecisionSummary({ brief: baseBrief(), plan: OBSERVATION_PLAN, stale: true, staleReason: "RESEARCH_EVIDENCE_STALE" });
    expect(summary.headline).toContain("来源已变化");
    expect(summary.tone).toBe("blocked");
  });

  it("主要产品问题只取产品问题，并标注来源 / 是否假设 / 是否已验证 / 反证", () => {
    const plan = buildImprovementPlan({
      observations: [
        { statement: "首次按压角落卡扣需要较大力度，安装体验存在一定费力感。", evidenceRefs: ["a"] },
        { statement: "同父体 11 个变体共享流量与评论，因此该 ASIN 排名靠前。", evidenceRefs: ["b"] },
      ],
      sourceDisclosure: { sourceKind: "v5", missingFacts: ["原因假设"] },
    });
    const summary = buildBriefDecisionSummary({ brief: baseBrief(), plan, stale: false });
    expect(summary.productProblems).toHaveLength(1);
    expect(summary.productProblems[0]!.text).toContain("卡扣");
    expect(summary.productProblems[0]!.source).toContain("VOC 问题陈述");
    expect(summary.productProblems[0]!.isHypothesis).toBe(true);
    expect(summary.productProblems[0]!.verified).toContain("未验证");
    expect(summary.productProblems[0]!.counter).toContain("缺失不等于没有");
    expect(summary.productProblemNote).toContain("非产品 / 混合判断未列入首屏");
  });

  it("关键未知用当前经济性缺口（实时），不再把生成时缺失快照当成当前缺失", () => {
    const summary = buildBriefDecisionSummary({ brief: baseBrief(), plan: OBSERVATION_PLAN, stale: false });
    expect(summary.keyUnknowns.length).toBeGreaterThan(0);
    expect(summary.keyUnknownsSource).toContain("实时计算");
    // missingValidation 是生成时快照，不能作为当前缺口来源
    expect(summary.keyUnknownsSource).not.toContain("生成时按缺失字段列出");
  });

  it("研报没有验证动作时，产品问题验证只给规则模板并明确未经人工确认", () => {
    const summary = buildBriefDecisionSummary({ brief: baseBrief(), plan: OBSERVATION_PLAN, stale: false });
    expect(summary.verification.sourceKind).toBe("TEMPLATE");
    expect(summary.verification.note).toContain("未经人工确认");
    // 商业缺口不能混进产品验证动作
    expect(summary.verification.items.join()).not.toMatch(/目标毛利率|referral fee|物流/);
  });

  it("三类待办互不冒充：产品验证 / 商业可行性 / 供应商确认", () => {
    const brief = baseBrief({
      confirmationItems: [
        { id: "cfq_moq", item: "起订量（MOQ）与阶梯报价是否满足首单需求", status: "待确认", reason: "需要供应商确认" },
        { id: "cfq_sample", item: "是否支持样品测试与结构、做工改进确认", status: "待确认", reason: "需要供应商确认" },
      ],
    });
    const summary = buildBriefDecisionSummary({ brief, plan: OBSERVATION_PLAN, stale: false });
    expect(summary.verification.items.length).toBeGreaterThan(0);
    expect(summary.business.items.length).toBeGreaterThan(0);
    expect(summary.business.items.join()).not.toMatch(/报告|复核|对比竞品/);
    expect(summary.supplier.items.length).toBe(2);
    expect(summary.supplier.note).toContain("仍为未知");
    // 供应商事项不得出现在产品验证里
    expect(summary.verification.items.join()).not.toContain("MOQ");
  });

  it("没有停止条件时明确说需要人工补充，而不是编造一条", () => {
    const summary = buildBriefDecisionSummary({ brief: baseBrief(), plan: OBSERVATION_PLAN, stale: false });
    expect(summary.stopConditions).toEqual([]);
    expect(summary.stopConditionsNote).toContain("尚未形成明确停止条件");
  });

  it("研报给出停止条件时提炼展示", () => {
    const brief = baseBrief({
      researchAlternatives: [{ text: "若样品测试无法把清洗耗时降到 30 秒内，应停止该改良方向。", nature: "ASSUMPTION", evidenceRefs: ["a"] }],
    });
    const summary = buildBriefDecisionSummary({ brief, plan: OBSERVATION_PLAN, stale: false });
    expect(summary.stopConditions).toHaveLength(1);
    expect(summary.stopConditions[0]).toContain("停止该改良方向");
    expect(summary.stopConditionsNote).toBeNull();
  });

  it("没有需求单时不编造结论", () => {
    const summary = buildBriefDecisionSummary({ brief: null, plan: null, stale: false });
    expect(summary.headline).toContain("尚未生成需求单");
    expect(summary.productProblems).toEqual([]);
    expect(summary.levels.find((level) => level.key === "document")!.value).toContain("尚无需求单");
  });

  it("事实口径固定写明：已持久化≠已确认、估算≠真实、冲突保留、旧快照不补造", () => {
    const summary = buildBriefDecisionSummary({ brief: baseBrief(), plan: OBSERVATION_PLAN, stale: false });
    const text = summary.caliberNotes.join("");
    expect(text).toContain("不等于供应商或性能已验证");
    expect(text).toContain("不等于真实值");
    expect(text).toContain("来源冲突保留并列");
    expect(text).toContain("不改写历史数据");
  });
});

describe("决策摘要与真实经济性值不再互相矛盾（P5-v4 回归）", () => {
  const REAL_VALUES = {
    targetPrice: 15.88,
    targetMarginPct: 35,
    referralFee: 2.38,
    fbaFee: null,
    logistics: 1.2,
    estimatedTax: null,
    otherKnownCosts: null,
    currency: "USD",
    purchaseCostCeiling: { status: "NOT_COMPUTABLE" as const, value: null, currency: "USD", formula: "x", reason: "缺 FBA 费用" },
  };

  it("已保存 35% / 2.38 / 1.2 时，不得再写「尚未填写 / 尚未提供」", () => {
    const brief = baseBrief({ economics: REAL_VALUES });
    const summary = buildBriefDecisionSummary({ brief, plan: OBSERVATION_PLAN, stale: false });
    const business = summary.business.items.join(" ");
    expect(business).toContain("35%");
    expect(business).toContain("2.38 USD");
    expect(business).toContain("1.2 USD");
    expect(business).not.toContain("尚未填写");
    // 逐字段判断：已有值的三项不得写成「未提供」，真正缺失的 FBA 仍应写「未提供」
    for (const label of ["目标毛利率", "平台佣金", "物流成本"]) {
      const line = summary.business.items.find((item) => item.startsWith(label)) ?? "";
      expect(line).not.toContain("未提供");
    }
    const fbaLine = summary.business.items.find((item) => item.startsWith("FBA 费用")) ?? "";
    expect(fbaLine).toContain("未提供");
    // 关键未知同样不能把已有值说成缺失
    expect(summary.keyUnknowns.join(" ")).not.toContain("尚未填写");
    expect(summary.keyUnknowns.join(" ")).not.toContain("尚未提供");
  });

  it("来源失效时显示「历史保存值」而不是「当前缺失」", () => {
    const brief = baseBrief({ economics: REAL_VALUES });
    const summary = buildBriefDecisionSummary({ brief, plan: OBSERVATION_PLAN, stale: true, staleReason: "RESEARCH_EVIDENCE_STALE" });
    const business = summary.business.items.join(" ");
    expect(business).toContain("历史保存值");
    expect(business).toContain("35%");
    expect(summary.headline).toContain("来源已变化");
  });

  it("商业缺口不进入产品问题验证，也不冒充供应商确认", () => {
    const brief = baseBrief({ economics: REAL_VALUES });
    const summary = buildBriefDecisionSummary({ brief, plan: OBSERVATION_PLAN, stale: false });
    expect(summary.verification.items.join()).not.toMatch(/35%|2\.38|FBA/);
    expect(summary.supplier.items.join()).not.toMatch(/售价|毛利率/);
  });
});
