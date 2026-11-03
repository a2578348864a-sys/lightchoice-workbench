import { describe, expect, it } from "vitest";
import type { MarketIntelligence } from "@/lib/marketScan/intelligence";
import type { ScanReadModel } from "../researchPresentation";
import { buildActions, buildEvidenceModel, buildInsightModel, buildPriceStructure } from "./cockpitModel";

function makeScan(overrides: Partial<ScanReadModel> = {}): ScanReadModel {
  return {
    id: "scan-a",
    scanName: "测试研究",
    marketplace: "US",
    sampleCount: 4,
    sampleHash: "hash-a",
    resourceVersion: "v1",
    createdAt: "2026-10-01T00:00:00.000Z",
    sampleItems: [
      { asin: "A1", subjectKey: "amazon:US:A1", title: "A1", imageUrl: null, price: 8, priceCurrency: "USD", rating: 4.5, reviewCount: 10 },
      { asin: "A2", subjectKey: "amazon:US:A2", title: "A2", imageUrl: null, price: 12, priceCurrency: "USD", rating: 4.4, reviewCount: 20 },
      { asin: "A3", subjectKey: "amazon:US:A3", title: "A3", imageUrl: null, price: 22, priceCurrency: "USD", rating: 4.3, reviewCount: 30 },
      { asin: "A4", subjectKey: "amazon:US:A4", title: "A4", imageUrl: null, price: null, priceCurrency: null, rating: null, reviewCount: null },
    ],
    marketGate: { status: "PAUSE", effectiveStatus: "PAUSE", stale: false, reason: "r", missingDataAcknowledged: false },
    decisionReadiness: {
      status: "READY",
      blockers: [],
      acknowledgeableMissing: [{ code: "DEMAND_NOT_COMPLETE", label: "销量缺失", detail: "d" }],
    },
    handoffEligible: true,
    ...overrides,
  };
}

function makeIntelligence(overrides: Partial<MarketIntelligence> = {}): MarketIntelligence {
  return {
    schema: "market-intelligence.v1",
    scanId: "scan-a",
    scanName: "测试研究",
    marketplace: "US",
    resourceVersion: "v1",
    sampleHash: "hash-a",
    inputHash: "input-1",
    observedAt: "2026-10-01T00:00:00.000Z",
    samples: [
      { asin: "A1", subjectKey: "amazon:US:A1" },
      { asin: "A2", subjectKey: "amazon:US:A2" },
      { asin: "A3", subjectKey: "amazon:US:A3" },
    ] as unknown as MarketIntelligence["samples"],
    sources: [],
    keywords: [],
    productMarkets: [],
    productSignals: [],
    trends: [],
    reviews: [
      { subjectKey: "amazon:US:A1", title: null, text: "t1", rating: 2, evidence: { id: "e1", evidenceId: "e1", capturedAt: "2026-10-01T00:00:00.000Z", sourceUrl: "" } },
      { subjectKey: "amazon:US:A2", title: null, text: "t2", rating: 5, evidence: { id: "e2", evidenceId: "e2", capturedAt: "2026-10-01T00:00:00.000Z", sourceUrl: "" } },
    ],
    variations: [],
    category: null,
    queryBindings: [],
    bindingCandidates: [],
    evidenceChanges: [],
    limitations: ["样本不代表全市场"],
    provider: { ready: false, code: "PROVIDER_NOT_CONFIGURED", message: "未配置" },
    reports: [],
    ...overrides,
  } as unknown as MarketIntelligence;
}

describe("cockpit price structure", () => {
  it("只统计可计价样本，缺失价格不计入 0 元带", () => {
    const structure = buildPriceStructure(makeScan());
    expect(structure.pricedCount).toBe(3);
    expect(structure.unpricedCount).toBe(1);
    expect(structure.median).toBe(12);
    expect(structure.bands.map((band) => band.count)).toEqual([1, 1, 0, 1]);
  });

  it("闭区间标签可被 02 的 $a–b 解析，空带不产生可传递筛选", () => {
    const structure = buildPriceStructure(makeScan());
    expect(structure.bands[0].rangeLabel).toBe("$0–9.99");
    expect(structure.bands[0].filterLabel).toBe("$0–9.99");
    expect(structure.bands[2].filterLabel).toBeNull();
    expect(structure.bands[3].rangeLabel).toBe("$20–22");
  });

  it("没有可计价样本时不编造价格结构", () => {
    const structure = buildPriceStructure(makeScan({ sampleItems: [], sampleCount: 0 }));
    expect(structure.pricedCount).toBe(0);
    expect(structure.median).toBeNull();
    expect(structure.bands.every((band) => band.count === 0 && band.filterLabel === null)).toBe(true);
  });
});

describe("cockpit evidence coverage", () => {
  it("覆盖按有已保存评论的 ASIN 计算，缺失保持 null", () => {
    const evidence = buildEvidenceModel(makeScan(), makeIntelligence());
    expect(evidence.reviewsRead).toBe(2);
    expect(evidence.asinCovered).toBe(2);
    expect(evidence.coverageRatio).toBeCloseTo(0.5);
    expect(evidence.missing).toHaveLength(1);
  });

  it("没有 statistics 时不把冲突数当作 0", () => {
    const evidence = buildEvidenceModel(makeScan(), null);
    expect(evidence.reviewsRead).toBeNull();
    expect(evidence.conflictCount).toBeNull();
  });
});

describe("cockpit insight status", () => {
  it("没有证据时不可用，没有研报时明确未生成", () => {
    expect(buildInsightModel(null).status).toBe("unavailable");
    expect(buildInsightModel(makeIntelligence()).status).toBe("missing");
  });

  it("inputHash 不一致时标记为过期，仍保留可追溯条目", () => {
    const intelligence = makeIntelligence({
      reports: [{
        schema: "market-intelligence-report.v3",
        id: "r1",
        inputHash: "input-old",
        generatedAt: "2026-09-30T00:00:00.000Z",
        model: "m",
        summary: { text: "s", nature: "inference", citations: [] },
        opportunities: [], risks: [], unknowns: [], actions: [],
        productOpportunities: [{
          title: "机会 A", buyerProblem: "p", scenario: "s", hypothesis: "h", unverified: ["u"], citations: ["c1"],
          counterEvidence: ["ce"], rejectionConditions: [], developmentConstraints: [], id: "o1",
        }],
        researchRecommendations: [{ subjectKey: "amazon:US:A1", opportunityIds: ["o1"], role: "benchmark", rationale: "r", researchQuestions: [], citations: [] }],
      }],
    });
    const insight = buildInsightModel(intelligence);
    expect(insight.status).toBe("stale");
    expect(insight.opportunities).toHaveLength(1);
    expect(insight.opportunities[0].relatedSubjects[0].subjectKey).toBe("amazon:US:A1");
    expect(insight.opportunities[0].lists.map((list) => list.label)).toContain("相反证据");
  });

  it("inputHash 一致时才是当前有效研报", () => {
    const intelligence = makeIntelligence({
      reports: [{
        schema: "market-intelligence-report.v3",
        id: "r1",
        inputHash: "input-1",
        generatedAt: "2026-10-01T00:00:00.000Z",
        model: "m",
        summary: { text: "s", nature: "inference", citations: [] },
        opportunities: [], risks: [], unknowns: [], actions: [],
        riskGaps: [{ title: "风险 A", text: "t", gap: "g", impact: "i", nature: "unknown", citations: [] }],
      }],
    });
    expect(buildInsightModel(intelligence).status).toBe("ready");
  });
});

describe("cockpit next actions", () => {
  it("闸门未确认时先要求重新确认，03 交接保持阻塞", () => {
    const scan = makeScan({ marketGate: { status: "PAUSE", effectiveStatus: "PENDING", stale: true, reason: "r", missingDataAcknowledged: false } });
    const evidence = buildEvidenceModel(scan, makeIntelligence());
    const insight = buildInsightModel(makeIntelligence());
    const actions = buildActions({ scan, evidence, insight, gateStale: true, gateStatus: "PENDING" });
    expect(actions[0].id).toBe("gate");
    const handoff = actions.find((action) => action.id === "handoff");
    expect(handoff?.target.kind).toBe("blocked");
    expect(handoff?.blockedReason).toContain("失效");
  });

  it("PROCEED 且可交接时才给出 03 入口", () => {
    const scan = makeScan();
    const evidence = buildEvidenceModel(scan, makeIntelligence());
    const insight = buildInsightModel(makeIntelligence());
    const actions = buildActions({ scan, evidence, insight, gateStale: false, gateStatus: "PROCEED" });
    const handoff = actions.find((action) => action.id === "handoff");
    expect(handoff?.target).toEqual({ kind: "href", href: "/research" });
    expect(actions.some((action) => action.id === "gate")).toBe(false);
  });
});
