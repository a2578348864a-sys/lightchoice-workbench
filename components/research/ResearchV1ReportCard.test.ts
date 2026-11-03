import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResearchV1ReportCard } from "./ResearchV1ReportCard";
import type { V1ReportView } from "@/lib/research/v1ReportView";

const view = (overrides: Partial<V1ReportView> = {}): V1ReportView => ({
  schema: "research-report-view.v1",
  source: "v1",
  reportHash: "77dc051dda54a08fff72c2979ef1b31c",
  generatedAt: "2026-10-28T00:00:00.000Z",
  bindingStatus: "bound",
  authoritative: true,
  generationStatus: "completed",
  summary: "隔离合成摘要",
  keyPoints: ["要点一"],
  marketOpportunity: "购买价值假设待验证",
  competitionAnalysis: "竞争分析",
  differentiationSuggestions: ["改良方向：成本更高"],
  causalHypotheses: ["包装约束可能导致竞品未解决"],
  causalInvestigations: [{
    hypothesis: "漏水可能来自密封圈装配误差",
    hypothesisVerified: true,
    rationale: "首次使用即渗水",
    supportingEvidence: ["多条评论提到渗水"],
    counterevidence: ["低频场景未复现"],
    unknowns: ["缺少拆解记录"],
    confidence: "medium",
    verification: ["抽 10 件做静置测试"],
  }],
  alternatives: ["保留现状作为对照组"],
  supportingEvidence: ["评论反复提到装包场景渗水"],
  counterevidence: ["若对照测试无改善应停止"],
  verificationItems: ["两周对照测试"],
  vocAnalysis: "通勤用户装包场景漏水",
  painPoints: ["评论原声"],
  riskAnalysis: "成本超边界应停止",
  risks: ["模具成本上升"],
  riskVerificationItems: ["核对包装体积"],
  unitEconomicsAnalysis: "缺少报价，不可计算",
  supplyChainAnalysis: "工艺能力未确认",
  unverifiedAssumptions: ["未验证假设一条"],
  ...overrides,
});

describe("03 页面 v1 正式研报只读卡", () => {
  it("有效时显示「报告有效」并呈现关键研究内容，AI 假设标注待验证", () => {
    const html = renderToStaticMarkup(createElement(ResearchV1ReportCard, { view: view(), stale: false }));
    expect(html).toContain("正式研报（v1 引擎）");
    expect(html).toContain("报告有效");
    expect(html).toContain("隔离合成摘要");
    expect(html).toContain("原因 1：漏水可能来自密封圈装配误差");
    expect(html).toContain("待验证");
    expect(html).toContain("为什么提出：首次使用即渗水");
    expect(html).toContain("反证线索：低频场景未复现");
    expect(html).toContain("未知：缺少拆解记录");
    expect(html).toContain("验证：抽 10 件做静置测试");
    expect(html).not.toContain("来源已变化");
  });

  it("来源失效时明确标注需重新确认，并声明不会自动恢复旧人工决定", () => {
    const html = renderToStaticMarkup(createElement(ResearchV1ReportCard, { view: view(), stale: true }));
    expect(html).toContain("来源已变化 · 需重新确认");
    expect(html).toContain("不会自动恢复旧人工决定");
    expect(html).not.toContain("报告有效");
  });

  it("缺失的支持/反证/验证显式写未知，不用空白冒充已核实", () => {
    const html = renderToStaticMarkup(createElement(ResearchV1ReportCard, {
      view: view({
        causalInvestigations: [{
          hypothesis: "可能是包装导致",
          hypothesisVerified: true,
          rationale: null,
          supportingEvidence: [],
          counterevidence: [],
          unknowns: [],
          confidence: "unknown",
          verification: [],
        }],
      }),
      stale: false,
    }));
    expect(html).toContain("支持线索：未知");
    expect(html).toContain("反证线索：未知");
    expect(html).toContain("验证：未提供");
  });
});
