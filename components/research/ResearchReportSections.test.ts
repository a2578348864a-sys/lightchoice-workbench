import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ResearchConclusionEvidence,
  ResearchCostSection,
  ResearchImprovementSection,
  ResearchRiskSection,
  ResearchVoiceReport,
} from "./ResearchReportSections";
import type { ResearchClaimAudit } from "@/lib/research/evidenceAudit";
import type { ImprovementPlan } from "@/lib/research/improvementPlan";

const themes = [
  { label: "清洗后仍发黏", summary: "多位买家提到用后难清洗。", reviewCount: 6, strength: "recurring", kind: "pain" as const },
  { label: "初次使用偏滑", summary: "有买家说第一次用会滑。", reviewCount: 2, strength: "weak", kind: "pain" as const },
  { label: "运输划痕", summary: "1 条评论提到到货时有划痕。", reviewCount: 1, strength: "isolated", kind: "pain" as const },
  { label: "尺寸合适", summary: "尺寸与描述一致。", reviewCount: 4, strength: "recurring", kind: "positive" as const },
];

const planFixture: ImprovementPlan = {
  schema: "improvement-plan.v1",
  status: "NEEDS_VERIFICATION",
  statusLabel: "需先做区分性验证",
  statusReason: "原因假设未核实。",
  rulesVersion: "improvement-plan.rules.v3",
  rulesVersionNote: "",
  derivationDigest: "ipd-test0001",
  items: [
    {
      index: 0,
      inputKind: "CAUSE_HYPOTHESIS",
      inputKindLabel: "原因假设（研究给出）",
      hypothesis: "表面纹理不足导致清洗困难（假设）",
      rationale: null,
      attribution: { primary: "material", primaryLabel: "材料与表面", all: [], basis: "命中关键词" },
      rootCauseStatus: "ROOT_CAUSE_UNVERIFIED",
      actionabilityStatus: "PRODUCT_ACTIONABLE",
      actionabilityLabel: "产品问题（可改良）",
      productActionable: true,
      actionabilityReason: null,
      actionabilityBasis: "强信号",
      problemNature: "DEFECT_CLAIM",
      competitiveExplanations: [],
      candidateTargets: ["表面纹理"],
      targetStatus: "ANCHORED",
      partAnchors: ["表面"],
      targetNote: null,
      linkedDirections: [],
      sideEffects: [],
      costUncertainties: [],
      complianceChecks: [],
      verificationTasks: [{ category: "sample_test", label: "样品测试", task: "同尺寸不同表面处理对照清洗残留", source: "RESEARCH" }],
      missingVerificationCategories: [],
      evidence: {
        level: "multiple_mentions",
        levelLabel: "多条线索",
        summaryLabel: "证据线索概况",
        supportingCount: 3,
        counterCount: 0,
        unknownCount: 1,
        modelConfidence: "low",
        basis: "研报自述",
        scopeNote: "不得当作发生率。",
      },
      unknowns: ["根因未确认"],
    },
  ],
  inputKinds: ["CAUSE_HYPOTHESIS"],
  sourceDisclosure: null,
  actionabilityCounts: [],
  attributionCounts: [],
  missingVerificationCategories: [],
  disclaimer: "改良假设不是开发要求。",
};

const auditFixture: ResearchClaimAudit = {
  schema: "research-claim-audit.v1",
  verdict: "BLOCKED",
  marketData: {
    salesGrade: "NOT_AVAILABLE",
    reviewBase: 9,
    reviewRead: 9,
    reviewReadSource: "REPORT_TEXT",
    painReferences: { total: 3, unique: 3 },
  },
  flags: [
    {
      code: "MISSING_DATA_USED",
      severity: "BLOCKING",
      field: "summary",
      index: 0,
      text: "该品当前动销良好",
      reason: "销量不可用却写成确定性动销",
      suggested: "删除动销表述",
    },
  ],
  blockingCount: 1,
  warningCount: 0,
  headline: "存在 1 处越级结论",
};

describe("03 单页总览新区块诚实呈现", () => {
  it("买家反馈区分「已复现」与「待验证线索」，弱信号不升级为结论", () => {
    const html = renderToStaticMarkup(createElement(ResearchVoiceReport, {
      taskId: "t1",
      themes,
      reviewSnapshot: { totalReviews: 12, reviewsUsed: 12 },
      onOpenReviews: () => {},
      onOpenVoc: () => {},
    }));
    expect(html).toContain("买家反馈");
    expect(html).toContain("已复现");
    expect(html).toContain("待验证线索");
    expect(html).toContain("不是买家问题发生率");
    expect(html).toContain("孤立提及");
  });

  it("改良假设保留根因未确认与验证要求；无计划时如实说明证据不足", () => {
    const withPlan = renderToStaticMarkup(createElement(ResearchImprovementSection, {
      plan: planFixture,
      requirements: [],
      checkpoints: [{ id: "c1", sourceThemeLabel: "清洗后仍发黏", checkpoint: "确认表面处理工艺" }],
      unknowns: ["耐高温寿命未知"],
      onOpenPlan: () => {},
    }));
    expect(withPlan).toContain("表面纹理不足导致清洗困难");
    expect(withPlan).toContain("根因未确认");
    expect(withPlan).toContain("同尺寸不同表面处理对照清洗残留");
    expect(withPlan).toContain("待供应商确认问题");
    expect(withPlan).toContain("待验证线索");

    const withoutPlan = renderToStaticMarkup(createElement(ResearchImprovementSection, {
      plan: null,
      requirements: [],
      checkpoints: [],
      unknowns: [],
      onOpenPlan: () => {},
    }));
    expect(withoutPlan).toContain("尚未形成改良方向");
    expect(withoutPlan).toContain("不足以提出改什么");
  });

  it("历史研报的改良建议统一标注为历史线索，不冒充当前开发建议", () => {
    const html = renderToStaticMarkup(createElement(ResearchImprovementSection, {
      plan: planFixture,
      requirements: [],
      checkpoints: [],
      unknowns: [],
      historical: true,
      onOpenPlan: () => {},
    }));
    expect(html).toContain("历史改良线索（待重新核实）");
    expect(html).toContain("历史改良假设");
    expect(html).toContain("需重新核实后才能作为当前开发建议");
    // 底层假设与验证要求保留，不改写研究结果
    expect(html).toContain("表面纹理不足导致清洗困难");
    expect(html).toContain("同尺寸不同表面处理对照清洗残留");
    expect(html).not.toContain("可以验证的改良方向");
  });

  it("结论关联证据：无登记关联时如实显示「无登记关联」，不摆任意引用", () => {
    const html = renderToStaticMarkup(createElement(ResearchConclusionEvidence, {
      taskId: "t1",
      refs: [],
    }));
    expect(html).toContain("原文核验状态：无登记关联");
    expect(html).toContain("暂无可直接关联的原文证据");
    expect(html).not.toContain("已关联");
    expect(html).not.toContain("直接支持证据");
  });

  it("结论关联证据：有登记关联时状态为「待核实」，不写已证实也不写没有证据", () => {
    const html = renderToStaticMarkup(createElement(ResearchConclusionEvidence, {
      taskId: "t1",
      refs: ["amazon-content:abc123"],
    }));
    expect(html).toContain("原文核验状态：待核实");
    expect(html).not.toContain("已证实");
    expect(html).not.toContain("没有证据");
    expect(html).not.toContain("直接支持证据");
    expect(html).not.toContain("其他关联原文");
  });

  it("成本不可计算时给出缺口与不补估算的口径", () => {
    const html = renderToStaticMarkup(createElement(ResearchCostSection, {
      cost: { status: "not_computable", totalCost: null, currency: "USD", reason: null, gaps: ["缺少成本数据，暂无法估算利润"] },
      onOpenCost: () => {},
    }));
    expect(html).toContain("暂不可计算");
    expect(html).toContain("缺少成本数据");
    expect(html).toContain("不用 0 或估算值补足");
  });

  it("风险区区分越级结论与无阻断；权威未定或审查不可用时不得宣布无风险", () => {
    const blocked = renderToStaticMarkup(createElement(ResearchRiskSection, {
      claimAudit: auditFixture,
      stale: false,
      reportAuthorityAmbiguous: false,
      riskState: "blocking",
      gateLabel: "存在越级结论",
      blockingRisks: [],
      onOpenAudit: () => {},
    }));
    expect(blocked).toContain("存在越级结论");
    expect(blocked).toContain("该品当前动销良好");
    expect(blocked).not.toContain("风险尚无法完整判断");

    const ambiguous = renderToStaticMarkup(createElement(ResearchRiskSection, {
      claimAudit: null,
      stale: false,
      reportAuthorityAmbiguous: true,
      riskState: "unverifiable",
      gateLabel: "风险尚无法完整判断",
      blockingRisks: [],
      onOpenAudit: () => {},
    }));
    expect(ambiguous).toContain("风险尚无法完整判断");
    expect(ambiguous).toContain("先确认以哪份研报为准");
    expect(ambiguous).not.toContain("无阻断风险");
    expect(ambiguous).not.toContain("未发现阻断风险");

    const auditUnavailable = renderToStaticMarkup(createElement(ResearchRiskSection, {
      claimAudit: null,
      stale: false,
      reportAuthorityAmbiguous: false,
      riskState: "unverifiable",
      gateLabel: "风险尚无法完整判断",
      blockingRisks: [],
      onOpenAudit: () => {},
    }));
    expect(auditUnavailable).toContain("风险尚无法完整判断");
    expect(auditUnavailable).toContain("先完成审查或确认报告版本");

    const staleWithAudit = renderToStaticMarkup(createElement(ResearchRiskSection, {
      claimAudit: { ...auditFixture, verdict: "NEEDS_DOWNGRADE", flags: [], blockingCount: 0, warningCount: 1 },
      stale: true,
      reportAuthorityAmbiguous: false,
      riskState: "clear",
      gateLabel: "无阻断风险",
      blockingRisks: [],
      onOpenAudit: () => {},
    }));
    expect(staleWithAudit).toContain("不再作为当前有效结论");
  });
});
