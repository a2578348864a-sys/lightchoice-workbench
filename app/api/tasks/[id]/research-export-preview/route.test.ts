import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuthenticated: vi.fn(),
  readResearchTaskSnapshot: vi.fn(),
  readStoredResearchReport: vi.fn(),
  readStoredResearchDecision: vi.fn(),
}));

vi.mock("@/lib/server/demoGuard", () => ({ requireAuthenticated: mocks.requireAuthenticated }));
vi.mock("@/lib/server/research/researchInput", () => ({
  readResearchTaskSnapshot: mocks.readResearchTaskSnapshot,
  ResearchV1InputError: class ResearchV1InputError extends Error {
    code = "task_not_found";
    status = 404;
  },
}));
vi.mock("@/lib/server/research/researchReportStore", () => ({
  readStoredResearchReport: mocks.readStoredResearchReport,
}));
vi.mock("@/lib/server/research/researchHumanReviewStore", () => ({
  readStoredResearchDecision: mocks.readStoredResearchDecision,
}));

import { GET } from "./route";

const context = { params: Promise.resolve({ id: "task-1" }) };
const reportHash = "a".repeat(64);

function fakeReport() {
  const ref = {
    refId: "evidence:ev-1",
    source: "sellersprite_plugin" as const,
    captureId: "cap-1",
    evidenceId: "ev-1",
    subjectKey: "amazon:US:B0TEST0001",
    capturedAt: "2026-09-19T00:00:00.000Z",
    contentHash: "c".repeat(64),
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
  return {
    schema: "research-report.v1" as const,
    taskId: "task-1",
    candidateId: "candidate-1",
    runId: "run-1",
    subjectKey: ref.subjectKey,
    generatedAt: ref.capturedAt,
    generationStatus: "completed" as const,
    node: "synthesize_research" as const,
    facts: {
      basic: {
        asin: present("B0TEST0001"),
        title: present("Test Title"),
        image: present("https://img.test/pic.jpg"),
        brand: present("TestBrand"),
        category: present("Sports"),
        price: present({ amount: 19.99, currency: "USD" }),
        rating: present(4.5),
        reviewCount: present(120),
        bulletPoints: present(["Point 1"]),
      },
      market: {
        bsr: present(88),
        monthlySalesEstimate: present(1200),
        monthlyRevenueEstimate: present({ amount: 23988, currency: "USD" }),
        launchedDate: present("2024-01-01"),
      },
      profit: {
        packageWeight: present({ value: 0.5, unit: "kg" as const }),
        packageDimensions: present({ length: 10, width: 5, height: 2, unit: "cm" as const }),
        fbaFee: present({ amount: 3.5, currency: "USD" }),
      },
    },
    decisionSummary: {
      researchPriority: "P1" as const,
      recommendedNextAction: "继续研究" as const,
      keyReasons: ["高毛利利基"],
      blockingRisks: [],
      missingInformation: [],
    },
    executiveSummary: {
      analysis: { text: "综合评估良好", evidenceRefs: [ref] },
      keyPoints: [],
    },
    marketOpportunity: {
      facts: {} as any,
      analysis: { text: "市场空间大", evidenceRefs: [ref] },
    },
    competitionInsight: {
      analysis: { text: "竞争平缓", evidenceRefs: [ref] },
      differentiationSuggestions: [],
    },
    vocAnalysis: {
      analysis: { text: "好评居多", evidenceRefs: [ref] },
      painPoints: [],
    },
    unitEconomics: {
      facts: {} as any,
      deterministic: {
        knownRevenueAfterFbaFee: { value: { amount: 16.49, currency: "USD" }, status: "available" as const, evidenceRefs: [ref], reason: null },
        grossProfit: { value: null, status: "not_computable" as const, evidenceRefs: [ref], reason: "缺采购价" },
      },
      analysis: { text: "FBA费合理", evidenceRefs: [ref] },
    },
    supplyChain: {
      facts: {} as any,
      analysis: { text: "货源充足", evidenceRefs: [ref] },
    },
    riskAssessment: {
      analysis: { text: "合规无障碍", evidenceRefs: [ref] },
      risks: [{ text: "汇率波动", evidenceRefs: [ref] }],
    },
    citationIndex: [{ fieldPath: "facts.basic.asin", evidenceRefs: [ref] }],
    ai: { provider: "deepseek" as const, status: "completed" as const, errorCode: null },
  };
}

describe("GET /api/tasks/[id]/research-export-preview", () => {
  beforeEach(() => {
    mocks.requireAuthenticated.mockReset();
    mocks.readResearchTaskSnapshot.mockReset();
    mocks.readStoredResearchReport.mockReset();
    mocks.readStoredResearchDecision.mockReset();

    mocks.requireAuthenticated.mockReturnValue({
      ok: true,
      context: { mode: "owner", demoAccessId: null },
    });
    mocks.readResearchTaskSnapshot.mockResolvedValue({
      id: "task-1",
      candidateId: "candidate-1",
      result: {},
    });
  });

  it("未认证时返回 401", async () => {
    mocks.requireAuthenticated.mockReturnValueOnce({
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "未登录。",
    });
    const response = await GET(new NextRequest("http://localhost/api/tasks/task-1/research-export-preview"), context);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it("无已保存 ResearchReport 时返回 404", async () => {
    mocks.readStoredResearchReport.mockReturnValue(null);
    const response = await GET(new NextRequest("http://localhost/api/tasks/task-1/research-export-preview"), context);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("research_report_not_found");
  });

  it("报告存在但无人工复核时返回完整 exportRecord 与 larkFields，humanDecision 为 null", async () => {
    const report = fakeReport();
    mocks.readStoredResearchReport.mockReturnValue({
      report,
      reportHash,
      generatedAt: report.generatedAt,
    });
    mocks.readStoredResearchDecision.mockReturnValue(null);

    const response = await GET(new NextRequest("http://localhost/api/tasks/task-1/research-export-preview"), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);

    const data = body.data;
    expect(data.exportRecord.taskId).toBe("task-1");
    expect(data.exportRecord.candidateId).toBe("candidate-1");
    expect(data.exportRecord.product.asin).toBe("B0TEST0001");
    expect(data.exportRecord.market.sales).toBe(1200);
    expect(data.exportRecord.humanDecision).toBeNull();
    expect(data.exportRecord.evidence.reportHash).toBe(reportHash);

    // 检查 LarkBaseRecord
    expect(data.larkFields.商品信息.ASIN).toBe("B0TEST0001");
    expect(data.larkFields.人工决策.决策状态).toBe("待复核");
    expect(data.larkFields.证据.报告指纹).toBe(reportHash);
  });

  it("报告与人工复核均存在时，正确组合决策数据与指纹", async () => {
    const report = fakeReport();
    mocks.readStoredResearchReport.mockReturnValue({
      report,
      reportHash,
      generatedAt: report.generatedAt,
    });
    mocks.readStoredResearchDecision.mockReturnValue({
      status: "continue",
      nextAction: "prepare_listing",
      notes: "产品利润空间充足",
      updatedAt: "2026-09-19T10:00:00.000Z",
      updatedBy: "owner",
      reviewedReportHash: reportHash,
    });

    const response = await GET(new NextRequest("http://localhost/api/tasks/task-1/research-export-preview"), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);

    const data = body.data;
    expect(data.exportRecord.humanDecision).toEqual({
      status: "continue",
      nextAction: "prepare_listing",
      notes: "产品利润空间充足",
      // RESEARCH-001：复核指纹与当前报告一致 → 未过期
      reviewedReportHash: reportHash,
      reviewStale: false,
    });

    expect(data.larkFields.人工决策).toEqual({
      决策状态: "continue",
      下一步动作: "prepare_listing",
      决策备注: "产品利润空间充足",
    });
  });

  it("RESEARCH-001：历史复核没有报告指纹时按过期处理，Lark 人工状态回落为待复核", async () => {
    const report = fakeReport();
    mocks.readStoredResearchReport.mockReturnValue({
      report,
      reportHash,
      generatedAt: report.generatedAt,
    });
    // 旧版复核意见：没有 reviewedReportHash
    mocks.readStoredResearchDecision.mockReturnValue({
      status: "continue",
      nextAction: "prepare_listing",
      notes: "旧版复核意见",
      updatedAt: "2026-09-19T10:00:00.000Z",
      updatedBy: "owner",
    });

    const response = await GET(new NextRequest("http://localhost/api/tasks/task-1/research-export-preview"), context);
    expect(response.status).toBe(200);
    const data = (await response.json()).data;

    expect(data.exportRecord.humanDecision.reviewStale).toBe(true);
    expect(data.exportRecord.humanDecision.reviewedReportHash).toBeNull();
    expect(data.larkFields.人工决策.决策状态).toBe("待复核");
    expect(data.larkFields.风险.join("")).toContain("旧版报告");
  });
});
