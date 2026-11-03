import { describe, expect, it } from "vitest";
import {
  assessResearchDepth,
  RESEARCH_DEPTH_SEMANTIC_SAMPLES,
} from "./researchDepthQuality";
import type { ResearchEvidenceRef, ResearchReport } from "@/lib/research/researchContracts";

const ref: ResearchEvidenceRef = {
  refId: "evidence:depth-fixture",
  source: "amazon_dom",
  captureId: "depth-fixture",
  evidenceId: "depth-fixture",
  subjectKey: "amazon:US:B0DEPTH001",
  capturedAt: "2026-10-01T00:00:00.000Z",
  contentHash: "a".repeat(64),
  sourceUrl: "https://example.invalid/depth-fixture",
};

const narrative = (text: string) => ({ text, evidenceRefs: [ref] });

function report(overrides: Partial<ResearchReport> = {}): Pick<ResearchReport, "marketOpportunity" | "competitionInsight" | "vocAnalysis" | "riskAssessment"> {
  return {
    marketOpportunity: {
      facts: {} as ResearchReport["marketOpportunity"]["facts"],
      analysis: narrative("购买价值假设是目标人群愿意为更可靠的使用体验付费；需要访谈与转化证据验证。"),
    },
    competitionInsight: {
      analysis: narrative("观察到同类商品有漏水投诉，竞争性原因假设可能是密封结构或使用方式；该假设可能错，需比较不同场景并核实反证。"),
      differentiationSuggestions: [narrative("方案：保留现状与说明改良作对照；成本或副作用是包装成本增加；用对照测试验证，若无改善则停止。")],
    },
    vocAnalysis: {
      analysis: narrative("目标人群是通勤用户，在装包和倾倒场景下观察到具体漏水问题。"),
      painPoints: [narrative("评论原声描述通勤装包时发生漏水。")],
    },
    riskAssessment: {
      analysis: narrative("若供应商无法提供稳定工艺或成本超过边界，应停止该方向；下一步核实报价并做小样测试。"),
      risks: [narrative("在证据不足时先缩小场景并验证，不把估算当事实。")],
    },
    ...overrides,
  };
}

describe("research depth offline rubric", () => {
  it("keeps the four risk-discriminating semantic samples versioned", () => {
    expect(RESEARCH_DEPTH_SEMANTIC_SAMPLES.map((sample) => sample.id)).toEqual([
      "same_complaint_different_causes",
      "packaging_or_instruction_alternative",
      "better_performance_acquisition_constraint",
      "cannot_manufacture_or_profit_stop",
    ]);
    expect(RESEARCH_DEPTH_SEMANTIC_SAMPLES.every((sample) => sample.mustReview.length > 0 && sample.forbiddenShortcuts.length > 0)).toBe(true);
  });

  it("passes only the mechanical floor and always leaves semantic review pending", () => {
    const assessment = assessResearchDepth(report());
    expect(assessment.automatedStatus).toBe("pass");
    expect(assessment.humanReviewStatus).toBe("pending");
    expect(assessment.hardFailures).toEqual([]);
    expect(assessment.semanticSampleIds).toHaveLength(4);
  });

  it("hard-fails shallow generic output and missing evidence instead of accepting JSON shape", () => {
    const assessment = assessResearchDepth(report({
      marketOpportunity: { facts: {} as ResearchReport["marketOpportunity"]["facts"], analysis: { text: "建议优化", evidenceRefs: [] } },
      competitionInsight: { analysis: { text: "需要人工判断", evidenceRefs: [] }, differentiationSuggestions: [] },
      riskAssessment: { analysis: { text: "风险可控", evidenceRefs: [] }, risks: [] },
    }));
    expect(assessment.automatedStatus).toBe("hard_fail");
    expect(assessment.hardFailures.join("；")).toContain("可追溯证据");
    expect(assessment.hardFailures.join("；")).toContain("泛化占位语");
  });

  it("does not borrow tradeoffs or validation from a different proposal, or pass empty VOC", () => {
    const assessment = assessResearchDepth(report({
      competitionInsight: {
        ...report().competitionInsight,
        differentiationSuggestions: [
          narrative("改结构：成本更高。"),
          narrative("改说明：做对照测试验证。"),
        ],
      },
      vocAnalysis: { analysis: { text: "", evidenceRefs: [] }, painPoints: [] },
    }));
    expect(assessment.checks.differentiationTradeoff).toBe("fail");
    expect(assessment.checks.differentiationStopOrTest).toBe("fail");
    expect(assessment.checks.vocSpecificScenario).toBe("fail");
    expect(assessment.automatedStatus).toBe("hard_fail");
  });

  it("P3-01-B：新版结构化支持/反证/验证项均有合法引用时通过机械门槛", () => {
    const assessment = assessResearchDepth(report({
      competitionInsight: {
        ...report().competitionInsight,
        causalHypotheses: [narrative("包装限制可能导致竞品没有解决漏水问题。")],
        alternatives: [narrative("保留现状作为对照组。")],
        supportingEvidence: [narrative("多条评论在装包场景提到漏水。")],
        counterevidence: [narrative("低频使用场景未复现漏水。")],
        verificationItems: [narrative("做两周对照测试，若无改善则停止。")],
      },
      riskAssessment: {
        ...report().riskAssessment,
        verificationItems: [narrative("核对包装体积和成本，超过边界则暂停。")],
      },
    }));
    expect(assessment.automatedStatus).toBe("pass");
    expect(assessment.checks.structuredSupportAndCounterevidence).toBe("pass");
    expect(assessment.checks.structuredVerification).toBe("pass");
  });

  it("P3-01-B：新版结构化字段缺少支持或反证时硬失败，不用免责声明掩盖缺口", () => {
    const assessment = assessResearchDepth(report({
      competitionInsight: {
        ...report().competitionInsight,
        causalHypotheses: [narrative("包装限制可能导致竞品没有解决漏水问题。")],
        alternatives: [],
        supportingEvidence: [narrative("多条评论在装包场景提到漏水。")],
        counterevidence: [],
        verificationItems: [narrative("做两周对照测试，若无改善则停止。")],
      },
    }));
    expect(assessment.automatedStatus).toBe("hard_fail");
    expect(assessment.hardFailures.join("；")).toContain("支持证据与反证");
  });
});

/** P2-02（4.1/4.4）：逐原因支持/反证关联的离线回归。 */
const investigation = (overrides: Partial<NonNullable<ResearchReport["competitionInsight"]["causalInvestigations"]>[number]> = {}) => ({
  hypothesis: narrative("漏水可能来自密封圈装配误差。"),
  supportingEvidence: [narrative("多条评论在首次使用后即出现渗水。")],
  counterevidence: [narrative("低频使用场景未复现渗水。")],
  unknowns: ["缺少拆解记录，无法区分密封圈与壳体公差。"],
  confidence: "medium" as const,
  verification: ["抽 10 件做 30 分钟静置与倾斜测试，若均不渗水则该原因被否定。"],
  ...overrides,
});

const withInvestigations = (items: NonNullable<ResearchReport["competitionInsight"]["causalInvestigations"]>) => report({
  competitionInsight: { ...report().competitionInsight, causalInvestigations: items },
});

describe("P2-02 逐原因证据对应（离线）", () => {
  it("合理的竞争性原因：各自有支持、反证、未知与独立验证时通过机械门槛", () => {
    const assessment = assessResearchDepth(withInvestigations([
      investigation(),
      investigation({
        hypothesis: narrative("漏水可能来自说明书未提示倾倒角度。"),
        supportingEvidence: [narrative("部分评论提到按图示角度倾倒仍渗水。")],
        counterevidence: [narrative("有评论按同一角度使用未渗水。")],
        verification: ["招募 5 名用户按说明书操作，记录渗水比例。"],
      }),
    ]));
    expect(assessment.checks.causalPerCauseTraceability).toBe("pass");
    expect(assessment.checks.causalPerCauseUnknowns).toBe("pass");
    expect(assessment.checks.causalPerCauseVerification).toBe("pass");
    expect(assessment.advisories.filter((line) => line.includes("共用"))).toEqual([]);
  });

  it("某个原因缺少证据：不得当作结论，只能降级为待验证方向并标注未知", () => {
    const assessment = assessResearchDepth(withInvestigations([
      investigation({ hypothesis: { text: null, evidenceRefs: [] }, supportingEvidence: [], counterevidence: [], unknowns: ["没有任何可追溯证据支持该原因。"], confidence: "unknown", verification: [] }),
    ]));
    // 没有文本就没有「已证实的结论」，因此不构成可追溯性失败；
    // 但必须给出「已降级」的可解释提示，且人工审阅仍为 pending。
    expect(assessment.checks.causalPerCauseTraceability).toBe("pass");
    expect(assessment.advisories.join("；")).toContain("降级为待验证方向");
    expect(assessment.humanReviewStatus).toBe("pending");
  });

  it("原因有文本但没有任何可追溯证据时硬失败，不允许把假设写成研究结论", () => {
    const assessment = assessResearchDepth(withInvestigations([
      investigation({ hypothesis: { text: "漏水就是密封圈装配误差造成的。", evidenceRefs: [] } }),
    ]));
    expect(assessment.checks.causalPerCauseTraceability).toBe("fail");
    expect(assessment.automatedStatus).toBe("hard_fail");
    expect(assessment.hardFailures.join("；")).toContain("没有可追溯证据的原因假设");
  });

  it("只有支持证据、既无反证也不标未知的原因硬失败", () => {
    const assessment = assessResearchDepth(withInvestigations([
      investigation({ counterevidence: [], unknowns: [] }),
    ]));
    expect(assessment.checks.causalPerCauseUnknowns).toBe("fail");
    expect(assessment.hardFailures.join("；")).toContain("既无反证也未标注未知");
  });

  it("原因没有低成本验证方式时硬失败", () => {
    const assessment = assessResearchDepth(withInvestigations([investigation({ verification: [] })]));
    expect(assessment.checks.causalPerCauseVerification).toBe("fail");
    expect(assessment.hardFailures.join("；")).toContain("没有低成本验证或否定方式");
  });

  it("多个原因共用同一验证或同一支持证据时只给诊断，不擅自硬拒绝", () => {
    const shared = investigation({
      hypothesis: narrative("漏水可能来自壳体公差。"),
      supportingEvidence: [narrative("多条评论在首次使用后即出现渗水。")],
    });
    const assessment = assessResearchDepth(withInvestigations([investigation(), shared]));
    expect(assessment.automatedStatus).toBe("pass");
    expect(assessment.advisories.join("；")).toContain("验证动作被多个原因共用");
    expect(assessment.advisories.join("；")).toContain("支持证据被多个原因共用");
  });

  it("自评高可信度但没有反证时只作诊断提示，可信度本身不等于事实确认", () => {
    const assessment = assessResearchDepth(withInvestigations([
      investigation({ confidence: "high", counterevidence: [] }),
    ]));
    expect(assessment.automatedStatus).toBe("pass");
    expect(assessment.advisories.join("；")).toContain("自评高可信度但没有列出任何反证");
    expect(assessment.humanReviewStatus).toBe("pending");
  });

  it("空 VOC 与单条评论场景：没有具体人群/场景时不通过 VOC 机械门槛", () => {
    const assessment = assessResearchDepth(report({
      vocAnalysis: { analysis: { text: "", evidenceRefs: [] }, painPoints: [] },
    }));
    expect(assessment.checks.vocSpecificScenario).toBe("fail");
    expect(assessment.automatedStatus).toBe("hard_fail");
    // 「单条评论不得推断为品类严重缺陷」由 riskGateEvaluator 的低评分规则单独锁定，
    // 本 rubric 不重复实现频率判定，避免两套口径。
  });
});

