import { describe, expect, it } from "vitest";
import { buildV5ReportView, observationsFromV5View } from "./v5ReportView";

/**
 * 形状取自真实 v5 研报（research-report.v5）：
 * summary 是字符串 + narrativeBindings 提供引用；painPoints 是 {text, evidenceRefs}；
 * risks / opportunities / unverifiedAssumptions 是字符串数组；**没有** competitionInsight。
 */
const V5_REPORT = {
  schema: "research-report.v5",
  summary: "该商品为硅胶烘焙垫，页面快照显示售价 15.88 美元，评论样本仅 2 条。",
  opportunities: ["过去一个月购买量约 300 件，可作为切入细分市场的机会。"],
  risks: ["评论数仅 2 条，评分不具统计代表性，不能据此判断真实口碑稳定性。"],
  vocAnalysis: {
    painPoints: [
      { text: "首次按压角落卡扣需要较大力度，安装体验存在一定费力感。", evidenceRefs: ["attachment:att-5dbfcc96ad62f0bcea514ad5"] },
      { text: "有买家反馈实测尺寸短于宣传尺寸。", evidenceRefs: [] },
    ],
    positiveSignals: [],
    failureModes: [],
    useCases: [],
  },
  citations: [{ quote: "x" }],
  unverifiedAssumptions: ["缺失商品字段事实: 基础事实·品牌", "缺失商品字段事实: 市场事实·月销估算"],
  narrativeBindings: [{ field: "summary", text: "该商品为硅胶烘焙垫…", evidenceRefs: ["evidence:ev-1"] }],
  allowedEvidenceRefs: ["evidence:ev-1", "attachment:att-5dbfcc96ad62f0bcea514ad5"],
};

describe("buildV5ReportView（v5 只读投影）", () => {
  const view = buildV5ReportView(V5_REPORT, { reportHash: "7d9cfc2741438dd2", researchRevision: 2 });

  it("搬运真实字段并保留每行自己的引用，不合并来源", () => {
    expect(view).not.toBeNull();
    expect(view!.schema).toBe("research-report-view.v5");
    expect(view!.reportHash).toBe("7d9cfc2741438dd2");
    expect(view!.painPoints).toHaveLength(2);
    expect(view!.painPoints[0]!.evidenceRefs).toEqual(["attachment:att-5dbfcc96ad62f0bcea514ad5"]);
    // 第二行本身没有引用：保持空数组，不借用别的行的引用
    expect(view!.painPoints[1]!.evidenceRefs).toEqual([]);
    expect(view!.summary?.evidenceRefs).toEqual(["evidence:ev-1"]);
    expect(view!.risks[0]!.text).toContain("统计代表性");
    expect(view!.opportunities).toHaveLength(1);
    expect(view!.unverifiedAssumptions).toHaveLength(2);
    expect(view!.citationCount).toBe(1);
    expect(view!.allowedEvidenceRefCount).toBe(2);
  });

  it("如实披露缺失的原因假设层，且 hasCausalLayer 为 false", () => {
    expect(view!.hasCausalLayer).toBe(false);
    expect(view!.missingFacts.join()).toContain("原因假设");
    expect(view!.missingFacts.join()).toContain("验证动作");
    expect(view!.missingFacts).toHaveLength(6);
  });

  it("没有 report 时返回 null，不伪造空视图", () => {
    expect(buildV5ReportView(null, { reportHash: "x", researchRevision: 1 })).toBeNull();
    expect(buildV5ReportView("not-a-report", { reportHash: "x", researchRevision: 1 })).toBeNull();
  });

  it("问题陈述转派生输入时逐字保留文本与引用", () => {
    const observations = observationsFromV5View(view!);
    expect(observations).toHaveLength(2);
    expect(observations[0]!.statement).toBe("首次按压角落卡扣需要较大力度，安装体验存在一定费力感。");
    expect(observations[1]!.evidenceRefs).toEqual([]);
  });

  it("v5 契约若将来补上原因假设层，missingFacts 会随之减少而不是死写", () => {
    const upgraded = {
      ...V5_REPORT,
      competitionInsight: {
        causalInvestigations: [{
          hypothesis: { text: "卡扣结构一致性不足", evidenceRefs: ["evidence:ev-1"] },
          rationale: { text: "两条评论都提到按压费力", evidenceRefs: ["evidence:ev-1"] },
          supportingEvidence: [{ text: "a", evidenceRefs: [] }],
          counterevidence: [],
          unknowns: [],
          verification: [],
        }],
        verificationItems: [],
      },
    };
    const view2 = buildV5ReportView(upgraded, { reportHash: "h", researchRevision: 1 })!;
    expect(view2.hasCausalLayer).toBe(true);
    expect(view2.missingFacts).not.toContain("原因假设（competitionInsight.causalInvestigations）");
  });
});
