import { describe, expect, it } from "vitest";
import { mapReportToLarkFields } from "./larkMapping";
import type { ResearchReport } from "./researchContracts";
import type { ProductFactKeyword } from "@/lib/sourceLayer/fact/types";

function reportFixture(): ResearchReport {
  const ref = {
    refId: "evidence:ev-1",
    source: "sellersprite_plugin" as const,
    captureId: "cap-1",
    evidenceId: "ev-1",
    subjectKey: "amazon:US:B0TEST0001",
    capturedAt: "2026-09-19T00:00:00.000Z",
    contentHash: "a".repeat(64),
    sourceUrl: "https://www.amazon.com/dp/B0TEST0001",
  };
  const present = <T>(value: T) => ({ value, status: "present" as const, source: "sellersprite_plugin" as const, confidence: 1, capturedAt: ref.capturedAt, rawProofHash: ref.contentHash, evidenceRefs: [ref] });
  const missing = <T>() => ({ value: null, status: "missing" as const, source: "sellersprite_plugin" as const, confidence: 0, capturedAt: ref.capturedAt, rawProofHash: ref.contentHash, evidenceRefs: [ref] });
  const narrative = (text: string | null) => ({ text, evidenceRefs: text ? [ref] : [] });
  const facts = {
    basic: {
      asin: present("B0TEST0001"), title: present("Test Product"), image: present("https://img.test/a.jpg"), brand: present("Brand"), category: present("Home"), price: present({ amount: 10, currency: "USD" }), rating: missing<number>(), reviewCount: missing<number>(), bulletPoints: missing<readonly string[]>(),
    },
    market: { bsr: present(10), monthlySalesEstimate: present(20), monthlyRevenueEstimate: present({ amount: 200, currency: "USD" }), launchedDate: missing<string>(), subCategoryBsr: missing<number>(), dateFirstAvailable: missing<string>(), buyboxSeller: missing<string>(), fulfillmentType: missing<string>(), estimatedGrossMargin: missing<number>(), listingQualityScore: missing<number>() },
    profit: { packageWeight: missing<{ value: number; unit: "kg" }>(), packageDimensions: missing<{ length: number; width: number; height: number; unit: "cm" }>(), fbaFee: present({ amount: 2, currency: "USD" }), itemWeight: missing<{ value: number; unit: "kg" }>(), itemDimensions: missing<{ length: number; width: number; height: number; unit: "cm" }>() },
    keywordEvidence: { topKeywords: missing<readonly ProductFactKeyword[]>() },
  };
  return {
    schema: "research-report.v1", taskId: "task-1", candidateId: "candidate-1", runId: "run-1", subjectKey: ref.subjectKey, generatedAt: ref.capturedAt, generationStatus: "degraded", node: "synthesize_research", facts,
    decisionSummary: { researchPriority: "P2", recommendedNextAction: "补充数据", keyReasons: ["摘要"], blockingRisks: ["风险一"], missingInformation: ["评分"] },
    executiveSummary: { analysis: narrative("摘要"), keyPoints: [] }, marketOpportunity: { facts: facts.market, analysis: narrative(null) }, competitionInsight: { analysis: narrative("竞争"), differentiationSuggestions: [] }, vocAnalysis: { analysis: narrative(null), painPoints: [] },
    unitEconomics: { facts: { price: facts.basic.price, fbaFee: facts.profit.fbaFee, packageWeight: facts.profit.packageWeight, packageDimensions: facts.profit.packageDimensions, estimatedGrossMargin: facts.market.estimatedGrossMargin }, deterministic: { knownRevenueAfterFbaFee: { value: { amount: 8, currency: "USD" }, status: "available", evidenceRefs: [ref], reason: null }, grossProfit: { value: null, status: "not_computable", evidenceRefs: [ref], reason: "缺少采购成本" } }, analysis: narrative(null) },
    supplyChain: { facts: { packageWeight: facts.profit.packageWeight, packageDimensions: facts.profit.packageDimensions, itemWeight: facts.profit.itemWeight, itemDimensions: facts.profit.itemDimensions }, analysis: narrative(null) }, riskAssessment: { analysis: narrative("风险说明"), risks: [narrative("风险一")] }, citationIndex: [], ai: { provider: "deepseek", status: "degraded", errorCode: "missing_api_key" },
  };
}

describe("mapReportToLarkFields", () => {
  it("只映射报告事实与分析，缺失值保持 null", () => {
    const fields = mapReportToLarkFields(reportFixture(), { decisionStatus: "pending", researchLink: "/tasks/task-1" });
    expect(fields.商品信息.ASIN).toBe("B0TEST0001");
    expect(fields.商品信息.图片).toContain("img.test");
    expect(fields.市场数据.月销量).toBe(20);
    expect(fields.市场数据.上架时间).toBeNull();
    expect(fields.研究结论.研究优先级).toBe("P2");
    expect(fields.研究结论.研究状态).toBe("降级报告");
    expect(fields.研究结论.下一步动作).toBe("补充数据");
    expect(fields.研究结论.核心机会).toBeNull();
    expect(fields.研究结论.核心风险).toEqual(["【AI待人工复核】风险一"]);
    expect(fields.研究结论.缺失数据).toEqual(["评分"]);
    expect(fields.利润分析.毛利).toBeNull();
    expect(fields.利润分析.已知扣除FBA后金额).toBe(8);
    expect(fields.风险).toEqual(["风险一", "【估算口径】月销量来自 monthlySalesEstimate，仅为来源估算，不是已确认销量，不能据此认定动销或开发价值。", "【估算口径】月销售额是来源估算，不是已确认经营事实。"]);
    expect(fields.人工决策状态).toBe("pending");
    expect(fields.研究链接).toBe("/tasks/task-1");
  });
});
