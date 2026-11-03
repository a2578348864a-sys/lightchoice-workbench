import { describe, expect, it } from "vitest";
import { buildV1ReportView } from "./v1ReportView";
import type { ResearchEvidenceRef, ResearchReport } from "@/lib/research/researchContracts";

const ref: ResearchEvidenceRef = {
  refId: "evidence:v1-view",
  source: "amazon_dom",
  captureId: "v1-view",
  evidenceId: "v1-view",
  subjectKey: "amazon:US:B0V1VIEW01",
  capturedAt: "2026-10-01T00:00:00.000Z",
  contentHash: "b".repeat(64),
  sourceUrl: "https://example.invalid/v1-view",
};

const n = (text: string) => ({ text, evidenceRefs: [ref] });

function report(overrides: Partial<ResearchReport> = {}): ResearchReport {
  return {
    schema: "research-report.v1",
    taskId: "task-v1",
    candidateId: "cand-v1",
    runId: "run-v1",
    subjectKey: "amazon:US:B0V1VIEW01",
    generatedAt: "2026-10-28T00:00:00.000Z",
    generationStatus: "completed",
    ai: { provider: "deepseek", status: "completed", errorCode: null },
    node: "synthesize_research",
    facts: {} as ResearchReport["facts"],
    decisionSummary: {} as ResearchReport["decisionSummary"],
    executiveSummary: { analysis: n("隔离合成摘要"), keyPoints: [n("要点一")] },
    marketOpportunity: { facts: {} as ResearchReport["marketOpportunity"]["facts"], analysis: n("购买价值假设待验证") },
    competitionInsight: {
      analysis: n("竞争分析"),
      differentiationSuggestions: [n("改良方向：成本更高")],
      causalHypotheses: [n("包装约束可能导致竞品未解决")],
      causalInvestigations: [
        {
          hypothesis: n("漏水可能来自密封圈装配误差"),
          rationale: n("首次使用即渗水"),
          supportingEvidence: [n("多条评论提到渗水")],
          counterevidence: [n("低频场景未复现")],
          unknowns: ["缺少拆解记录"],
          confidence: "medium",
          verification: ["抽 10 件做静置测试"],
        },
        {
          hypothesis: { text: null, evidenceRefs: [] },
          supportingEvidence: [],
          counterevidence: [],
          unknowns: ["没有任何可追溯证据支持该原因。"],
          confidence: "unknown",
          verification: [],
        },
      ],
      alternatives: [n("保留现状作为对照组")],
      supportingEvidence: [n("评论反复提到装包场景渗水")],
      counterevidence: [n("若对照测试无改善应停止")],
      verificationItems: [n("两周对照测试")],
    },
    vocAnalysis: { analysis: n("通勤用户装包场景漏水"), painPoints: [n("评论原声")] },
    unitEconomics: { facts: {} as ResearchReport["unitEconomics"]["facts"], deterministic: {} as ResearchReport["unitEconomics"]["deterministic"], analysis: n("缺少报价，不可计算") },
    supplyChain: { facts: {} as ResearchReport["supplyChain"]["facts"], analysis: n("工艺能力未确认") },
    riskAssessment: { analysis: n("成本超边界应停止"), risks: [n("模具成本上升")], verificationItems: [n("核对包装体积")] },
    citationIndex: [],
    unverifiedAssumptions: [n("未验证假设一条")],
    ...overrides,
  };
}

describe("v1 研报只读展示投影", () => {
  it("把已持久化的 v1 研报映射成可读视图，并保留假设性质与逐原因关联", () => {
    const view = buildV1ReportView(report(), { reportHash: "hash-v1", generatedAt: "2026-10-28T00:00:00.000Z" });
    expect(view.source).toBe("v1");
    expect(view.reportHash).toBe("hash-v1");
    // 未显式声明绑定时必须如实标为 unbound（时效未知），不得默认有效
    expect(view.bindingStatus).toBe("unbound");
    expect(view.summary).toBe("隔离合成摘要");
    expect(view.causalInvestigations).toHaveLength(2);
    expect(view.causalInvestigations[0]).toMatchObject({ hypothesisVerified: false, confidence: "medium", rationale: "首次使用即渗水" });
    expect(view.causalInvestigations[0]!.hypothesis).toContain("待验证原因假设");
    expect(view.causalInvestigations[0].supportingEvidence).toEqual(["多条评论提到渗水"]);
    expect(view.causalInvestigations[0].counterevidence).toEqual(["低频场景未复现"]);
    expect(view.causalInvestigations[0].unknowns).toEqual(["缺少拆解记录"]);
    expect(view.causalInvestigations[0].verification).toEqual(["抽 10 件做静置测试"]);
    // 没有证据的原因保持「未知」，不被补写成结论
    expect(view.causalInvestigations[1].hypothesis).toBe("");
    expect(view.causalInvestigations[1].hypothesisVerified).toBe(false);
    expect(view.causalInvestigations[1].unknowns).toEqual(["没有任何可追溯证据支持该原因。"]);
  });

  it("记录绑定时标为 bound，供界面区分「有效」与「时效未知」", () => {
    const view = buildV1ReportView(report(), { reportHash: "hash-bound", generatedAt: "2026-10-28T00:00:00.000Z", bindingStatus: "bound" });
    expect(view.bindingStatus).toBe("bound");
  });

  it("只搬运已有内容：缺失字段保持空，不补默认值也不推断", () => {
    const view = buildV1ReportView(report({
      competitionInsight: { analysis: { text: null, evidenceRefs: [] }, differentiationSuggestions: [] },
      unverifiedAssumptions: undefined,
    }), { reportHash: "hash-2", generatedAt: "2026-10-28T00:00:00.000Z" });
    expect(view.competitionAnalysis).toBeNull();
    expect(view.differentiationSuggestions).toEqual([]);
    expect(view.causalInvestigations).toEqual([]);
    expect(view.unverifiedAssumptions).toEqual([]);
  });
});
