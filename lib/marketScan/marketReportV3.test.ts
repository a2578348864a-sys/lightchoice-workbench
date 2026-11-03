import { describe, expect, it } from "vitest";
import {
  collectReportCitations,
  MARKET_REPORT_SECTIONS,
  MARKET_REPORT_V3_SCHEMA,
  validateMarketReport,
  type MarketIntelligence,
} from "./intelligence";
import { buildVoiceCoverage } from "./researchStatistics";
import { buildOpportunityResearchSnapshot, readOpportunityResearchSnapshot } from "./opportunityResearch";
import { parseMarketWorkflowMetadata, buildInitialMarketWorkflowMetadata } from "@/lib/marketWorkflow/metadata";

const refA = { id: "review-source-a", evidenceId: "raw-a", subjectKey: "amazon:US:B0A0000001", contentHash: "a".repeat(64), capturedAt: "2026-10-23T00:00:00Z", sourceUrl: null, version: null, nature: "source_observed" };
const refB = { id: "review-source-b", evidenceId: "raw-b", subjectKey: "amazon:US:B0B0000002", contentHash: "b".repeat(64), capturedAt: "2026-10-23T01:00:00Z", sourceUrl: null, version: null, nature: "source_observed" };
const refs = new Set([refA.id, refB.id]);
const reviews = [
  { id: "R1", subjectKey: refA.subjectKey, subjectKeys: [refA.subjectKey], title: "thin", text: "too thin and slips", rating: 2, evidence: refA },
  { id: "R2", subjectKey: refB.subjectKey, subjectKeys: [refB.subjectKey, refA.subjectKey], title: null, text: "works well", rating: 5, evidence: refB },
  { id: "R3", subjectKey: refA.subjectKey, subjectKeys: [refA.subjectKey], title: null, text: "hard to clean", rating: 3, evidence: refA },
] satisfies MarketIntelligence["reviews"];
const aliases = new Map([["R1", reviews[0]], ["R2", reviews[1]], ["R3", reviews[2]]]);
const point = (text: string, citations: string[] = [refA.id], nature: "fact" | "estimate" | "calculation" | "inference" | "unknown" = "fact") => ({ text, nature, citations });

function validInput() {
  return {
    schema: MARKET_REPORT_V3_SCHEMA,
    judgment: { ...point("样本价格集中在中低价位，但缺少销量权重。", [refA.id], "calculation"), canJudge: "能判断样本价格与评分分布。", cannotJudge: "不能判断全市场份额与长期趋势。" },
    findings: [
      { title: "打滑与厚度", section: "voice", nature: "fact", what: "有用户反映垫子太薄并打滑。", why: "影响操作稳定性。", basis: "低星评论原文。", limits: ["仅本次低星子集"], citations: [refA.id] },
      { title: "价格带集中", section: "competition", nature: "calculation", what: "样本价格位于中低价位。", why: "影响进入定价。", basis: "34款锁定标价。", limits: ["非销量份额"], citations: [refA.id] },
    ],
    riskGaps: [{ title: "品牌覆盖不足", text: "14款商品没有品牌证据。", gap: "品牌字段缺失。", impact: "无法判断品牌集中度。", nature: "fact", citations: [refA.id] }],
    productOpportunities: [{ title: "防滑结构", buyerProblem: "垫子滑动", scenario: "擀面与烘烤时固定", hypothesis: "底部增加防滑纹理", unverified: ["成本影响未知"], citations: [refA.id] }],
    nextActions: [{ question: "多少用户提到滑动？", neededEvidence: "更多低星原文", howToVerify: "有界补采后逐条分类", doneWhen: "覆盖至少30条低星评论", citations: [] }],
    workspaces: Object.fromEntries(MARKET_REPORT_SECTIONS.filter((key) => key !== "overview").map((key) => [key, {
      status: "assessed",
      reason: "",
      summary: point(`${key} 区结论`, [refA.id], "inference"),
      limits: ["仅限锁定样本"],
    }])),
    comparisonSubjects: [refA.subjectKey, refB.subjectKey],
    comparisonItems: [
      { subjectKey: refA.subjectKey, advantages: ["尺寸明确"], limitations: ["偏薄"], unknowns: ["长期耐用性未知"], citations: [refA.id] },
      { subjectKey: refB.subjectKey, advantages: ["评价量高"], limitations: ["价格未含套装说明"], unknowns: ["单件成本未知"], citations: [refB.id] },
    ],
    comparisonDifferences: [{ dimension: "厚度", text: "一款被评论认为偏薄，另一款没有厚度证据。", citations: [refA.id] }],
    voiceThemes: [
      { id: "t1", label: "薄与打滑", sentiment: "negative", statement: point("用户反映偏薄和打滑。", [refA.id]), reviewRefs: ["R1", "R3"], scenario: "固定垫子", hypothesis: "厚度不足", improvement: "增加防滑纹理", verification: ["对比不同厚度"] },
      { id: "t2", label: "好用", sentiment: "positive", statement: point("有用户认为好用。", [refB.id]), reviewRefs: ["R2"], scenario: "日常烘焙", hypothesis: "不粘表面", improvement: "保持不粘", verification: ["跟踪长期使用"] },
    ],
    reviewResults: { R1: ["t1"], R2: ["t2"], R3: ["t1"] },
  };
}

function validate(raw: unknown, withContext = true) {
  return validateMarketReport(raw, refs, withContext ? { reviews, comparisonSubjects: [refA.subjectKey, refB.subjectKey], reviewAliases: aliases } : undefined);
}

function opportunityReport() {
  return {
    ...validInput(),
    productOpportunities: [{ ...validInput().productOpportunities[0], id: "o1", counterEvidence: [], rejectionConditions: ["如果滑动主要来自不适用场景则调整方向"], developmentConstraints: ["成本与供应能力未验证"] }],
    recommendationDecision: { status: "recommend", reason: "值得验证改进价值，不代表适合开发。", citations: [refA.id] },
    researchRecommendations: [{ subjectKey: refA.subjectKey, opportunityIds: ["o1"], role: "pain_point", rationale: "核对真实使用问题", researchQuestions: ["改进是否有效且不破坏清洁便利性？"], citations: [refA.id] }],
  };
}
const opportunityContext = { reviews, comparisonSubjects: [refA.subjectKey, refB.subjectKey], reviewAliases: aliases, formalSubjects: [refA.subjectKey, refB.subjectKey], requireRecommendations: true, subjectEvidence: new Map([[refA.subjectKey, new Set([refA.id])], [refB.subjectKey, new Set([refB.id])]]) };

describe("evidence-bound opportunity recommendations", () => {
  it("keeps legacy v3 reports readable without inventing recommendations", () => {
    expect(validate(validInput()).researchRecommendations).toBeUndefined();
    expect(validate(validInput()).promptVersion).toBe("market-report.v3");
  });
  it("recommends a formal subject even when it is outside the temporary comparison", () => {
    const raw = opportunityReport(); raw.comparisonSubjects = []; raw.comparisonItems = [];
    const report = validateMarketReport(raw, refs, { ...opportunityContext, comparisonSubjects: [] });
    expect(report.researchRecommendations?.[0].subjectKey).toBe(refA.subjectKey);
    expect(collectReportCitations(report).has(refA.id)).toBe(true);
  });
  it("rejects out-of-scope subjects and cross-subject evidence", () => {
    const raw = opportunityReport(); raw.researchRecommendations[0].subjectKey = "amazon:US:B0C0000003";
    expect(() => validateMarketReport(raw, refs, opportunityContext)).toThrow("MARKET_AI_RECOMMENDATION_OUTSIDE_SCOPE");
    raw.researchRecommendations[0].subjectKey = refA.subjectKey;
    raw.researchRecommendations[0].citations = [refB.id];
    expect(() => validateMarketReport(raw, refs, opportunityContext)).toThrow("MARKET_AI_RECOMMENDATION_EVIDENCE_MISMATCH");
  });
  it("rejects orphan recommendations and evidence-free opportunities", () => {
    const raw = opportunityReport(); raw.researchRecommendations[0].opportunityIds = ["missing"];
    expect(() => validateMarketReport(raw, refs, opportunityContext)).toThrow("MARKET_AI_RECOMMENDATIONS_INVALID");
    raw.researchRecommendations[0].opportunityIds = ["o1"]; raw.productOpportunities[0].citations = [];
    expect(() => validateMarketReport(raw, refs, opportunityContext)).toThrow();
  });
  it("allows an honest empty recommendation and requires evidence for a negative decision", () => {
    const raw = { ...opportunityReport(), productOpportunities: [], researchRecommendations: [], recommendationDecision: { status: "insufficient", reason: "缺少场景与性能依据", citations: [] as string[] } };
    expect(validateMarketReport(raw, refs, opportunityContext).researchRecommendations).toEqual([]);
    raw.recommendationDecision.status = "do_not_continue";
    expect(() => validateMarketReport(raw, refs, opportunityContext)).toThrow();
    raw.recommendationDecision.citations = [refA.id];
    expect(validateMarketReport(raw, refs, opportunityContext).recommendationDecision?.status).toBe("do_not_continue");
  });
  it("freezes adopted questions, counterevidence, rejection conditions and exact evidence; rejects stale adoption", () => {
    const report = { ...validateMarketReport(opportunityReport(), refs, opportunityContext), id: "report-1", inputHash: "a".repeat(64), generatedAt: refA.capturedAt, model: "offline-test", citedEvidence: [refA, refB] };
    const selection = { reportId: report.id, inputHash: report.inputHash, opportunityIds: ["o1"] };
    const brief = buildOpportunityResearchSnapshot(report, refA.subjectKey, selection, report.inputHash);
    expect(readOpportunityResearchSnapshot(JSON.parse(JSON.stringify(brief)))).toEqual(brief);
    expect(brief.evidence).toEqual([refA]);
    expect(brief.recommendation.researchQuestions).toHaveLength(1);
    expect(() => buildOpportunityResearchSnapshot(report, refA.subjectKey, selection, "b".repeat(64))).toThrow("MARKET_RECOMMENDATION_STALE");
    const workflow = buildInitialMarketWorkflowMetadata({ scanId: "scan", sampleHash: "sample", metricsHash: "metrics", metricsVersion: "v1" });
    const stored = { ...workflow, representatives: { ...workflow.representatives, items: [{ marketSampleKey: "scan:B0A0000001", asin: "B0A0000001", subjectKey: refA.subjectKey, role: "pain_point", note: "人工保留的理由", selectedAt: refA.capturedAt, selectedBy: "owner:v1", researchContext: brief }] } };
    expect(parseMarketWorkflowMetadata(JSON.parse(JSON.stringify(stored)))?.representatives.items[0].researchContext).toEqual(brief);
  });
});

describe("v3 structured market report contract", () => {
  it("resolves short transport citations to exact evidence versions and rejects unknown aliases", () => {
    const aliases = new Map([["E1", refA.id], ["E2", refB.id]]);
    const raw = JSON.parse(JSON.stringify(validInput(), (_key, value) => value === refA.id ? "E1" : value === refB.id ? "E2" : value));
    const parsed = validateMarketReport(raw, refs, { reviews, comparisonSubjects: [refA.subjectKey, refB.subjectKey], reviewAliases: new Map(reviews.map((review) => [review.id, review])), refResolver: aliases });
    expect(parsed.judgment?.citations).toEqual([refA.id]);
    expect(collectReportCitations(parsed).has("E1")).toBe(false);
    expect(() => validateMarketReport({ ...raw, judgment: { ...raw.judgment, citations: ["E999"] } }, refs, { reviews, comparisonSubjects: [refA.subjectKey, refB.subjectKey], refResolver: aliases })).toThrow();
  });
  it("maps every aliased review exactly once and computes theme denominators from real identities", () => {
    const report = validate(validInput());
    expect(report.schema).toBe(MARKET_REPORT_V3_SCHEMA);
    expect(report.reviewResults).toEqual([
      { reviewId: "R1", status: "themed", themeIds: ["t1"] },
      { reviewId: "R2", status: "themed", themeIds: ["t2"] },
      { reviewId: "R3", status: "themed", themeIds: ["t1"] },
    ]);
    expect(report.voiceThemes?.[0]).toMatchObject({ reviewCount: 2, productCount: 1, reviewIds: ["R1", "R3"] });
    expect(report.voiceThemes?.[1]).toMatchObject({ reviewCount: 1, productCount: 2, reviewIds: ["R2"] });
    expect(report.findings?.[0].section).toBe("voice");
    expect(report.comparisonSubjects).toEqual([refA.subjectKey, refB.subjectKey]);
  });

  it("accepts no_match and unable statuses but never treats unable as a negative theme", () => {
    const raw = validInput();
    raw.reviewResults = { R1: ["t1"], R2: ["t2"], R3: ["t1"] };
    raw.voiceThemes = [
      { ...raw.voiceThemes[0], reviewRefs: ["R1"] },
      { ...raw.voiceThemes[1], reviewRefs: ["R2"] },
    ];
    raw.reviewResults = { R1: ["t1"], R2: ["t2"], R3: null } as unknown as typeof raw.reviewResults;
    const report = validate(raw);
    expect(report.reviewResults?.find((result) => result.reviewId === "R3")).toEqual({ reviewId: "R3", status: "unable", themeIds: [] });
    expect(report.voiceThemes?.[0].reviewCount).toBe(1);
    const noMatch = validate({ ...validInput(), reviewResults: { R1: [], R2: ["t2"], R3: [] } , voiceThemes: [validInput().voiceThemes[1]] });
    expect(noMatch.reviewResults?.filter((result) => result.status === "no_match")).toHaveLength(2);
  });

  it("rejects missing, duplicate, out-of-range and invalid-theme review results", () => {
    const missing = validInput();
    missing.reviewResults = { R1: ["t1"], R2: ["t2"] } as typeof missing.reviewResults;
    expect(() => validate(missing)).toThrow("MARKET_AI_REVIEW_COVERAGE_INVALID");
    const duplicate = validInput();
    duplicate.reviewResults = { R1: ["t1"], R2: ["t2"], R3: ["t1"], "r1": ["t1"] } as unknown as typeof duplicate.reviewResults;
    expect(() => validate(duplicate)).toThrow("MARKET_AI_REVIEW_COVERAGE_INVALID");
    const foreignRef = validInput();
    foreignRef.reviewResults = { R1: ["t1"], R2: ["t2"], R3: ["t1"], R9: [] } as unknown as typeof foreignRef.reviewResults;
    expect(() => validate(foreignRef)).toThrow("MARKET_AI_REVIEW_COVERAGE_INVALID");
    const foreignTheme = validInput();
    foreignTheme.reviewResults = { R1: ["t9"], R2: ["t2"], R3: ["t1"] } as unknown as typeof foreignTheme.reviewResults;
    expect(() => validate(foreignTheme)).toThrow("MARKET_AI_REVIEW_COVERAGE_INVALID");
  });

  it("allows an explicitly insufficient workspace but refuses a silent empty explanation", () => {
    const raw = validInput();
    raw.workspaces.demand = { status: "insufficient", reason: "没有可用历史日期序列，无法判断长期需求趋势。", summary: { text: "需求趋势无法判断。", nature: "unknown", citations: [] }, limits: [] };
    expect(validate(raw).workspaces?.demand?.status).toBe("insufficient");
    const silent = validInput();
    silent.workspaces.demand = { status: "insufficient", reason: "", summary: point("无", [], "unknown"), limits: [] };
    expect(() => validate(silent)).toThrow("MARKET_AI_WORKSPACE_INVALID");
    expect(() => validate({ ...validInput(), workspaces: { ...validInput().workspaces, demand: undefined } })).toThrow("MARKET_AI_WORKSPACE_INVALID");
  });

  it("keeps empty findings/opportunities legal when the reason is explicit", () => {
    const raw = validInput();
    raw.findings = [];
    raw.productOpportunities = [];
    raw.judgment.cannotJudge = "当前材料不足以形成有依据的发现或机会。";
    const report = validate(raw);
    expect(report.findings).toEqual([]);
    expect(report.productOpportunities).toEqual([]);
  });

  it("requires exact comparison coverage and no fabricated subjects", () => {
    const raw = validInput();
    raw.comparisonItems = [raw.comparisonItems[0]];
    expect(() => validate(raw)).toThrow("MARKET_AI_COMPARISON_INVALID");
    const foreign = validInput();
    foreign.comparisonItems[0].subjectKey = "amazon:US:B0FOREIGN1";
    expect(() => validate(foreign)).toThrow("MARKET_AI_COMPARISON_INVALID");
  });

  it("roundtrips a stored v3 report and validates its own review coverage", () => {
    const parsed = validate(validInput());
    expect(buildVoiceCoverage(parsed.reviewResults!, reviews, 129)).toMatchObject({ available: 129, sampled: 3, themed: 3, noMatch: 0, unable: 0, sampledProducts: 2, lowStarSampled: 2 });
    const stored = {
      ...parsed,
      id: "report-1",
      inputHash: "c".repeat(64),
      generatedAt: "2026-10-23T02:00:00Z",
      model: "deepseek-flash",
      inputManifest: { evidence: [], reviewIds: ["R1", "R2", "R3"], keywordRows: [] },
      voiceCoverage: buildVoiceCoverage(parsed.reviewResults!, reviews, 129),
    };
    const roundtrip = validateMarketReport(stored, collectReportCitations(stored));
    expect(roundtrip.reviewResults).toHaveLength(3);
    expect(roundtrip.voiceCoverage).toBeUndefined();
    expect(roundtrip.voiceThemes?.[0]).toMatchObject({ reviewCount: 2, productCount: 1 });
    expect(roundtrip.voiceThemes?.[1]).toMatchObject({ reviewCount: 1, productCount: 2 });
    const badProductCount = { ...stored, voiceThemes: [{ ...stored.voiceThemes![0], productCount: 0 }, stored.voiceThemes![1]] };
    expect(() => validateMarketReport(badProductCount, collectReportCitations(badProductCount))).toThrow("MARKET_AI_VOICE_INVALID");
    const corrupted = { ...stored, voiceCoverage: { ...stored.voiceCoverage, sampled: 2 } };
    expect(() => validateMarketReport(corrupted, collectReportCitations(corrupted))).toThrow("MARKET_AI_VOICE_INVALID");
    const droppedReview = { ...stored, inputManifest: { ...stored.inputManifest, reviewIds: ["R1", "R2"] } };
    expect(() => validateMarketReport(droppedReview, collectReportCitations(droppedReview))).toThrow("MARKET_AI_REVIEW_COVERAGE_INVALID");
  });

  it("still reads v1 and v2 reports without pretending they have v3 coverage", () => {
    const v1 = { schema: "market-intelligence-report.v1", summary: point("旧报告"), opportunities: [], risks: [], unknowns: [], actions: [] };
    expect(validateMarketReport(v1, refs).schema).toBe("market-intelligence-report.v1");
    const v2 = { schema: "market-intelligence-report.v2", sections: Object.fromEntries(MARKET_REPORT_SECTIONS.map((key) => [key, [point(`${key}`)]])), voiceThemes: [] };
    const storedV2 = validateMarketReport(v2, refs);
    expect(storedV2.sections?.overview).toHaveLength(1);
    expect(storedV2.reviewResults).toBeUndefined();
  });
});
