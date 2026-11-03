import { describe, expect, it } from "vitest";
import { buildResearchExportRecord } from "./exportRecord";
import { mapResearchExportToLarkRecord } from "./larkMapping";
import type { ResearchDecision, ResearchReport } from "./researchContracts";
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
  const present = <T>(value: T) => ({
    value,
    status: "present" as const,
    source: "sellersprite_plugin" as const,
    confidence: 1,
    capturedAt: ref.capturedAt,
    rawProofHash: ref.contentHash,
    evidenceRefs: [ref],
  });
  const missing = <T>() => ({
    value: null,
    status: "missing" as const,
    source: "sellersprite_plugin" as const,
    confidence: 0,
    capturedAt: ref.capturedAt,
    rawProofHash: ref.contentHash,
    evidenceRefs: [ref],
  });
  const narrative = (text: string | null) => ({ text, evidenceRefs: text ? [ref] : [] });
  const facts = {
    basic: {
      asin: present("B0TEST0001"),
      title: present("Test Product"),
      image: present("https://img.test/a.jpg"),
      brand: present("Brand"),
      category: present("Home"),
      price: present({ amount: 29.99, currency: "USD" }),
      rating: missing<number>(),
      reviewCount: missing<number>(),
      bulletPoints: missing<readonly string[]>(),
    },
    market: {
      bsr: present(150),
      monthlySalesEstimate: present(850),
      monthlyRevenueEstimate: present({ amount: 25491.5, currency: "USD" }),
      launchedDate: missing<string>(),
      // G2-A：快照新增槽位。本夹具保持"缺失"语义，导出/映射断言不受影响。
      subCategoryBsr: missing<number>(),
      dateFirstAvailable: missing<string>(),
      buyboxSeller: missing<string>(),
      fulfillmentType: missing<string>(),
      estimatedGrossMargin: missing<number>(),
      listingQualityScore: missing<number>(),
    },
    profit: {
      packageWeight: missing<{ value: number; unit: "kg" }>(),
      packageDimensions: missing<{ length: number; width: number; height: number; unit: "cm" }>(),
      fbaFee: present({ amount: 4.5, currency: "USD" }),
      itemWeight: missing<{ value: number; unit: "kg" }>(),
      itemDimensions: missing<{ length: number; width: number; height: number; unit: "cm" }>(),
    },
    // G2-B：本夹具不含关键词证据 → 显式 missing（不造词）。
    keywordEvidence: { topKeywords: missing<readonly ProductFactKeyword[]>() },
  };
  return {
    schema: "research-report.v1",
    taskId: "task-123",
    candidateId: "candidate-456",
    runId: "run-789",
    subjectKey: ref.subjectKey,
    generatedAt: ref.capturedAt,
    generationStatus: "completed",
    node: "synthesize_research",
    facts,
    decisionSummary: {
      researchPriority: "P1",
      recommendedNextAction: "继续研究",
      keyReasons: ["高潜力利基市场"],
      blockingRisks: ["缺少重量数据"],
      missingInformation: ["重量"],
    },
    executiveSummary: {
      analysis: narrative("整体表现优异，具备较强盈利空间。"),
      keyPoints: [narrative("核心卖点明确")],
    },
    marketOpportunity: {
      facts: facts.market,
      analysis: narrative("同品类中排名前 5%，增长迅速。"),
    },
    competitionInsight: {
      analysis: narrative("竞品集中度低，仍有入局机会。"),
      differentiationSuggestions: [narrative("外观改款")],
    },
    vocAnalysis: {
      analysis: narrative("买家高度赞美做工质量。"),
      painPoints: [],
    },
    unitEconomics: {
      facts: {
        price: facts.basic.price,
        fbaFee: facts.profit.fbaFee,
        packageWeight: facts.profit.packageWeight,
        packageDimensions: facts.profit.packageDimensions,
        estimatedGrossMargin: facts.market.estimatedGrossMargin,
      },
      deterministic: {
        knownRevenueAfterFbaFee: {
          value: { amount: 25.49, currency: "USD" },
          status: "available",
          evidenceRefs: [ref],
          reason: null,
        },
        grossProfit: {
          value: null,
          status: "not_computable",
          evidenceRefs: [ref],
          reason: "缺少国内采购价",
        },
      },
      analysis: narrative("扣除 FBA 后已知金额 25.49 USD。"),
    },
    supplyChain: {
      facts: {
        packageWeight: facts.profit.packageWeight,
        packageDimensions: facts.profit.packageDimensions,
        itemWeight: facts.profit.itemWeight,
        itemDimensions: facts.profit.itemDimensions,
      },
      analysis: narrative("建议联系 1688 供应商询价。"),
    },
    riskAssessment: {
      analysis: narrative("无已知专利阻断。"),
      risks: [narrative("头程运费波动风险"), narrative("海关查验风险")],
    },
    citationIndex: [{ fieldPath: "facts.basic.asin", evidenceRefs: [ref] }],
    ai: { provider: "deepseek", status: "completed", errorCode: null },
  };
}

describe("Research Export Record & Lark Mapping", () => {
  const report = reportFixture();
  const reportHash = "b".repeat(64);

  it("销量估算不能凭合法引用变成出口结论，原文和报告hash不改", () => {
    const original = reportFixture();
    const report: ResearchReport = {
      ...original,
      executiveSummary: { ...original.executiveSummary, analysis: { ...original.executiveSummary.analysis, text: "月销量约600件，已有稳定动销，是机会点。" } },
      marketOpportunity: { ...original.marketOpportunity, analysis: { ...original.marketOpportunity.analysis, text: "购买量约600件，说明已有稳定需求，值得开发。" } },
    };
    const before = JSON.stringify(report);
    const record = buildResearchExportRecord({ taskId: report.taskId, candidateId: report.candidateId, report, reportHash });
    expect(record.research.summary).toBeNull();
    expect(record.research.opportunity).toBeNull();
    expect(record.research.risks.join("\n")).toContain("暂停采信");
    expect(record.research.unverifiedAssumptions.every((text) => text.startsWith("【证据审查·待人工复核原文】"))).toBe(true);
    expect(record.evidence.reportHash).toBe(reportHash);
    expect(JSON.stringify(report)).toBe(before);
    expect(mapResearchExportToLarkRecord(record).风险.join("\n")).toContain("不是已确认销量");
  });

  it("小样本复数措辞只以待复核文本输出，不伪装确认结论", () => {
    const original = reportFixture();
    const report: ResearchReport = { ...original, riskAssessment: { ...original.riskAssessment, risks: [{ ...original.executiveSummary.analysis, text: "多位买家反馈尺寸过小" }] } };
    const record = buildResearchExportRecord({ taskId: report.taskId, candidateId: report.candidateId, report, reportHash });
    expect(record.research.risks[0]).toBe("【待复核，不能作为已确认结论】多位买家反馈尺寸过小");
    expect(record.research.unverifiedAssumptions.join("\n")).toContain("待人工复核原文");
  });

  it("buildResearchExportRecord 正确拼装各层字段，不修改原报告", () => {
    const decision: ResearchDecision = {
      status: "continue",
      nextAction: "prepare_listing",
      notes: "产品利润空间充足，同意进入文案阶段。",
      updatedAt: "2026-09-19T12:00:00.000Z",
      updatedBy: "owner",
      reviewedReportHash: reportHash,
    };

    const exportRecord = buildResearchExportRecord({
      taskId: "task-123",
      candidateId: "candidate-456",
      report,
      reportHash,
      decision,
    });

    expect(exportRecord.taskId).toBe("task-123");
    expect(exportRecord.candidateId).toBe("candidate-456");
    expect(exportRecord.product.asin).toBe("B0TEST0001");
    expect(exportRecord.product.title).toBe("Test Product");
    expect(exportRecord.product.image).toBe("https://img.test/a.jpg");
    expect(exportRecord.product.category).toBe("Home");

    expect(exportRecord.market.price).toEqual({ amount: 29.99, currency: "USD" });
    expect(exportRecord.market.sales).toBe(850);
    expect(exportRecord.market.bsr).toBe(150);

    expect(exportRecord.research.summary).toBe("整体表现优异，具备较强盈利空间。");
    expect(exportRecord.research.priority).toBe("P1");
    expect(exportRecord.research.opportunity).toBe("同品类中排名前 5%，增长迅速。");
    expect(exportRecord.research.risks).toEqual(["头程运费波动风险", "海关查验风险", "【估算口径】月销量来自 monthlySalesEstimate，仅为来源估算，不是已确认销量，不能据此认定动销或开发价值。"]);

    expect(exportRecord.humanDecision).toEqual({
      status: "continue",
      nextAction: "prepare_listing",
      notes: "产品利润空间充足，同意进入文案阶段。",
      // RESEARCH-001：复核绑定当前报告指纹，且未过期
      reviewedReportHash: reportHash,
      reviewStale: false,
    });

    expect(exportRecord.evidence.reportHash).toBe(reportHash);
    expect(exportRecord.evidence.generatedAt).toBe("2026-09-19T00:00:00.000Z");
    expect(exportRecord.evidence.citationCount).toBe(1);
    // RESEARCH-002：引用数量拆分事实 / AI 分析两条来源
    expect(exportRecord.evidence.factCitationCount).toBe(1);
    expect(exportRecord.evidence.narrativeCitationCount).toBe(0);
    expect(exportRecord.evidence.unverifiedAssumptionCount).toBe(0);
  });

  it("无 humanDecision 时导出记录相应字段为 null，不阻塞导出", () => {
    const exportRecord = buildResearchExportRecord({
      taskId: "task-123",
      candidateId: "candidate-456",
      report,
      reportHash,
      decision: null,
    });

    expect(exportRecord.humanDecision).toBeNull();
  });

  it("mapResearchExportToLarkRecord 输出标准平铺 6 组字段", () => {
    const decision: ResearchDecision = {
      status: "continue",
      nextAction: "continue_research",
      notes: "继续跟进市场竞争情况",
      updatedAt: "2026-09-19T12:00:00.000Z",
      updatedBy: "owner",
      reviewedReportHash: reportHash,
    };

    const exportRecord = buildResearchExportRecord({
      taskId: "task-123",
      candidateId: "candidate-456",
      report,
      reportHash,
      decision,
    });

    const larkRecord = mapResearchExportToLarkRecord(exportRecord);

    expect(larkRecord.商品信息).toEqual({
      图片: "https://img.test/a.jpg",
      ASIN: "B0TEST0001",
      商品标题: "Test Product",
      类目: "Home",
    });

    expect(larkRecord.市场数据).toEqual({
      当前售价: 29.99,
      当前售价币种: "USD",
      月销量: 850,
      BSR: 150,
    });

    expect(larkRecord.研究结论).toEqual({
      研究优先级: "P1",
      核心摘要: "整体表现优异，具备较强盈利空间。",
      核心机会: "同品类中排名前 5%，增长迅速。",
    });

    expect(larkRecord.人工决策).toEqual({
      决策状态: "continue",
      下一步动作: "continue_research",
      决策备注: "继续跟进市场竞争情况",
    });

    expect(larkRecord.风险).toEqual(["头程运费波动风险", "海关查验风险", "【估算口径】月销量来自 monthlySalesEstimate，仅为来源估算，不是已确认销量，不能据此认定动销或开发价值。"]);

    expect(larkRecord.证据).toEqual({
      报告指纹: reportHash,
      生成时间: "2026-09-19T00:00:00.000Z",
      引用数量: 1,
    });
  });

  it("P5：导出必须带上每条原因的验证动作，无动作的原因不占位", () => {
    const base = reportFixture();
    const report: ResearchReport = {
      ...base,
      competitionInsight: {
        ...base.competitionInsight,
        causalInvestigations: [
          { hypothesis: { text: "假设 A：描述未披露厚度", evidenceRefs: [] }, supportingEvidence: [], counterevidence: [],
            unknowns: [], confidence: "low", verification: ["同条件 A/B 只改披露", "连续两个周期无变化即停止"] },
          { hypothesis: { text: "假设 B：裁切公差", evidenceRefs: [] }, supportingEvidence: [], counterevidence: [],
            unknowns: [], confidence: "unknown", verification: [] },
        ],
      },
    };
    const record = buildResearchExportRecord({ taskId: "task-1", candidateId: "cand-1", report, reportHash: "hash-1" });
    // 只有带验证动作的原因被导出；空验证不占位，避免制造「已验证」的错觉。
    expect(record.research.causalVerification).toHaveLength(1);
    expect(record.research.causalVerification![0]).toEqual({
      hypothesis: "假设 A：描述未披露厚度",
      confidence: "low",
      actions: ["同条件 A/B 只改披露", "连续两个周期无变化即停止"],
    });
  });
});


it("claim blocking cannot export a hash-current human choice as an effective approval", () => {
  const base = reportFixture();
  const report = { ...base, marketOpportunity: { ...base.marketOpportunity, analysis: { ...base.marketOpportunity.analysis!, text: "月销量850件证明稳定成交和现成需求验证。" } } };
  const record = buildResearchExportRecord({ taskId: "task", candidateId: "candidate", report, reportHash: "same-hash",
    decision: { status: "continue", nextAction: "continue_research", notes: "historical owner choice", updatedAt: "2026-10-30", updatedBy: "owner", reviewedReportHash: "same-hash" } });
  expect(record.evidence.claimAuditVerdict).toBe("BLOCKED");
  expect(record.humanDecision?.reviewStale).toBe(true);
  expect(mapResearchExportToLarkRecord(record).人工决策.决策状态).toBe("待复核");
  expect(record.research.opportunity).toBeNull();
});
