import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BriefDecisionSummaryCard } from "./BriefDecisionSummary";
import { buildBriefDecisionSummary } from "@/lib/productBrief/briefDecisionSummary";
import { PRODUCT_BRIEF_SCHEMA, type ProductBrief } from "@/lib/productBrief/contract";
import { buildImprovementPlan } from "@/lib/research/improvementPlan";

const BRIEF: ProductBrief = {
  schemaVersion: PRODUCT_BRIEF_SCHEMA,
  status: "READY",
  revision: 3,
  generatedAt: "2026-10-05T00:00:00.000Z",
  sourceBinding: { taskId: "t", researchRevision: 2, reportHash: "r", factHash: "f", evidenceHash: "e", marketScanId: null, marketSampleHash: null },
  identity: { asin: "B0HFS7K4GP", title: "硅胶垫", imageUrl: null, brand: null, category: null, marketplace: "US" },
  projectOverview: null,
  targetUser: null,
  corePainPoints: [{ text: "首次按压角落卡扣需要较大力度，安装体验存在一定费力感。", nature: "EVIDENCE_DERIVED", evidenceRefs: ["attachment:att-1"] }],
  benchmarks: [],
  differentiation: [],
  economics: { targetPrice: 15.88, targetMarginPct: 35, referralFee: null, fbaFee: null, logistics: null, estimatedTax: null, otherKnownCosts: null, currency: "USD", purchaseCostCeiling: { status: "NOT_COMPUTABLE", value: null, currency: "USD", formula: "x", reason: "缺 FBA" } },
  specsDirection: [],
  vocQaRedlines: [],
  risks: [],
  rationale: [],
  missingValidation: ["平台 referral fee 尚未提供，购买成本上限暂不能完整计算。"],
};

const PLAN = buildImprovementPlan({
  observations: [{ statement: BRIEF.corePainPoints[0]!.text, evidenceRefs: ["attachment:att-1"] }],
  sourceDisclosure: { sourceKind: "v5", missingFacts: ["原因假设（competitionInsight.causalInvestigations）"] },
});

describe("BriefDecisionSummaryCard", () => {
  const summary = buildBriefDecisionSummary({ brief: BRIEF, plan: PLAN, stale: false, approvalBlockedReason: "缺 FBA" });
  const html = renderToStaticMarkup(createElement(BriefDecisionSummaryCard, { summary }));

  it("首屏给出决策结论与依据", () => {
    expect(html).toContain("brief-decision-summary");
    expect(html).toContain("brief-decision-headline");
    expect(html).toContain("仅有问题陈述");
    expect(html).toContain("尚不具备立项依据");
    expect(html).toContain("brief-decision-headline-basis");
  });

  it("三层状态分别渲染，且 READY 明确不等于立项通过", () => {
    expect(html).toContain("brief-decision-level-document");
    expect(html).toContain("brief-decision-level-research");
    expect(html).toContain("brief-decision-level-human");
    expect(html).toContain("不代表已通过立项评审");
    expect(html).toContain("无人工立项记录");
    expect(html).toContain("批准门禁未通过");
  });

  it("主要产品问题带来源 / 假设 / 未验证 / 反证说明", () => {
    expect(html).toContain("brief-decision-problem-0");
    expect(html).toContain("卡扣");
    expect(html).toContain("来源：研报 VOC 问题陈述");
    expect(html).toContain("未验证");
    expect(html).toContain("缺失不等于没有");
  });

  it("关键未知、下一步、停止条件各自成块，缺内容时明确说明", () => {
    expect(html).toContain("brief-decision-unknowns");
    expect(html).toContain("brief-decision-next");
    expect(html).toContain("brief-decision-stop");
    expect(html).toContain("尚未形成明确停止条件，需人工补充");
  });

  it("事实口径可展开，并保留「≠ 立项 ≠ 生产」", () => {
    expect(html).toContain("brief-decision-caliber");
    expect(html).toContain("不等于真实值");
    expect(html).toContain("≠ 可以立项");
    expect(html).toContain("≠ 可以下发生产");
  });
});
