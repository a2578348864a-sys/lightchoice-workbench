import { describe, expect, it } from "vitest";

import { buildJevReadinessInputFromProduction, fieldPresenceOf } from "@/lib/server/research/jevReadinessInput";
import type { ResearchInputBundle } from "@/lib/sourceLayer/v2/contracts";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import type { DecisionDelivery } from "@/lib/server/research/decisionDelivery";
import type { VocAnalysisV1 } from "@/lib/server/vocAnalysis";

function factField(status: "present" | "missing"): Record<string, unknown> {
  return { value: null, status, source: "amazon_dom", confidence: 0.9, capturedAt: null, rawProofHash: null };
}

function productFactFixture(): ProductFact {
  return {
    basic: {
      asin: factField("present"),
      title: factField("present"),
      image: factField("missing"),
      brand: factField("present"),
      category: factField("present"),
      price: factField("present"),
      rating: factField("present"),
      reviewCount: factField("present"),
      bulletPoints: factField("missing"),
    },
    market: {
      bsr: factField("missing"),
      subCategoryBsr: factField("present"),
      monthlySalesEstimate: factField("present"),
      monthlyRevenueEstimate: factField("missing"),
      launchedDate: factField("missing"),
    },
    profit: {
      packageWeight: factField("missing"),
      packageDimensions: factField("missing"),
      fbaFee: factField("missing"),
    },
  } as unknown as ProductFact;
}

function observation(externalContentId: string, refId: string): Record<string, unknown> {
  return {
    refId,
    externalContentId,
    contentHash: "b".repeat(64),
    source: "amazon_review",
    evidenceRefs: [refId],
    limitations: [],
    parentContentId: null,
    threadId: null,
    subreddit: null,
    depth: null,
    contentType: "review",
    title: null,
    text: "x",
    rating: 5,
    verifiedPurchase: true,
    publishedAt: null,
    engagement: null,
    authorRef: null,
    provenance: {
      provider: "amazon_dom",
      method: "capture_v3_amazon_review",
      accessBasis: "first_party_visible_page",
      sourceAttachmentId: null,
      rawArtifactId: null,
      providerTermsVersion: null,
    },
    identityMatch: "EXACT",
    ownerExperience: null,
  };
}

function bundleFixture(): ResearchInputBundle {
  return {
    taskId: "task-1",
    subjectKey: "amazon:US:B0TEST0001",
    customerVoiceEvidence: [
      {
        attachmentId: "att-1",
        contentHash: "a".repeat(64),
        source: "amazon_review",
        observationCount: 3,
        omittedCount: 0,
        observations: [
          observation("obs-1", "attachment:att-1"),
          observation("obs-4", "attachment:att-9"), // refId 与所在附件不一致 → 自行复核拒收
          observation("obs-dup", "attachment:att-1"),
        ],
      },
      {
        attachmentId: "att-2",
        contentHash: "c".repeat(64),
        source: "amazon_review",
        observationCount: 2,
        omittedCount: 0,
        observations: [
          observation("obs-3", "attachment:att-2"),
          observation("obs-dup", "attachment:att-2"), // 同一身份映射到两个附件 → 歧义 → 整体拒收
        ],
      },
    ],
    productFact: productFactFixture(),
  } as unknown as ResearchInputBundle;
}

function vocTheme(label: string, refs: string[], reviewCount: number, strength: "isolated" | "weak" | "recurring"): Record<string, unknown> {
  return { themeId: `t-${label}`, label, summary: "s", evidenceRefs: refs, sourceProductRoles: [], reviewCount, coverage: 0.5, strength, limitations: null };
}

function vocAnalysisFixture(): VocAnalysisV1 {
  return {
    schema: "voc-analysis.v1",
    version: 1,
    runId: "run-1",
    candidateId: null,
    model: "test",
    promptVersion: "voc-analysis.v1",
    inputEvidenceHash: "h",
    datasetSnapshot: { totalReviews: 3, reviewsUsed: 3, sampledReviews: ["obs-1", "obs-3", "obs-dup"] },
    startedAt: "2026-10-01T00:00:00.000Z",
    finishedAt: "2026-10-01T00:01:00.000Z",
    tokenUsage: null,
    gateResult: "pass",
    themes: {
      positiveThemes: [vocTheme("正面主题", ["obs-1"], 1, "isolated")],
      painPointThemes: [
        vocTheme("正常痛点", ["obs-1"], 1, "isolated"),
        vocTheme("混合引用痛点", ["obs-1", "obs-3"], 2, "weak"),
        vocTheme("未知引用痛点", ["obs-unknown"], 1, "isolated"),
        vocTheme("refId错配痛点", ["obs-4"], 1, "isolated"),
        vocTheme("歧义痛点", ["obs-dup"], 1, "isolated"),
      ],
      usageScenarios: [],
      recurringRequests: [],
      conflicts: [],
      weakSignals: [],
    },
    unknowns: ["u1"],
    nextResearchSteps: ["n1"],
    unverified: [],
    humanReviewResult: null,
    updatedAt: "2026-10-01T00:01:00.000Z",
  } as unknown as VocAnalysisV1;
}

const REPORT: Record<string, unknown> = {
  schema: "research-report.v5",
  summary: null,
  opportunities: [],
  risks: [],
  narrativeBindings: [
    { field: "summary", text: "有绑定的摘要", evidenceRefs: ["evidence:ev-1"] },
    { field: "risks[0]", text: "引用不在白名单的风险", evidenceRefs: ["evidence:ev-x"] },
    { field: "risks[1]", text: "无引用文本", evidenceRefs: [] },
  ],
  unverifiedAssumptions: ["未验证假设 U1"],
};

const DELIVERY = {
  status: "available",
  assembleVersion: "decision-delivery.v1",
  aiInvoked: false,
  riskGate: { status: "blocked", hasBlockingRisk: true, blockingReasons: ["B1"], warningReasons: ["W1"], rules: [] },
  riskCounts: { blocking: 2, warning: 1, notComputable: 3, passed: 5 },
  decisionSummary: { researchPriority: "P2", recommendedNextAction: "补充数据", keyReasons: ["k"], blockingRisks: ["r"], missingInformation: ["m"] },
} as unknown as DecisionDelivery;

const BINDING = { reportHash: "r1", factHash: "f1", evidenceHash: "e1", researchRevision: 3 };
const ALLOWED = ["attachment:att-1", "evidence:ev-1"];

describe("Jev 生产输入构建（P0-A）", () => {
  it("fieldPresenceOf：缺失显式；bsr 由大类或小类任一 present 判定", () => {
    const presence = fieldPresenceOf(productFactFixture());
    expect(presence.brand).toBe("present");
    expect(presence.price).toBe("present");
    expect(presence.reviewCount).toBe("present");
    expect(presence.bsr).toBe("present"); // subCategoryBsr present
    expect(presence.fbaFee).toBe("missing");
    expect(presence.packageWeight).toBe("missing");
    expect(fieldPresenceOf(null)).toEqual({});
  });

  it("缺少正式研报 → 明确不可用（RESEARCH_REPORT_MISSING）", () => {
    const built = buildJevReadinessInputFromProduction({
      taskId: "task-1",
      asin: "B0TEST0001",
      binding: BINDING,
      report: null,
      bundle: bundleFixture(),
      allowedEvidenceRefs: ALLOWED,
      delivery: DELIVERY,
      vocAnalysis: vocAnalysisFixture(),
    });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.reason).toBe("RESEARCH_REPORT_MISSING");
  });

  it("绑定四元组不完整 → 明确不可用（RESEARCH_BINDING_INCOMPLETE）", () => {
    const built = buildJevReadinessInputFromProduction({
      taskId: "task-1",
      asin: "B0TEST0001",
      binding: { reportHash: "r1", factHash: null, evidenceHash: "e1", researchRevision: 3 },
      report: REPORT,
      bundle: bundleFixture(),
      allowedEvidenceRefs: ALLOWED,
      delivery: DELIVERY,
      vocAnalysis: vocAnalysisFixture(),
    });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.reason).toBe("RESEARCH_BINDING_INCOMPLETE");
  });

  it("完整输入：叙述绑定校验、VOC 整主题降级、风险门禁与摘要映射", () => {
    const built = buildJevReadinessInputFromProduction({
      taskId: "task-1",
      asin: "B0TEST0001",
      binding: BINDING,
      report: REPORT,
      bundle: bundleFixture(),
      allowedEvidenceRefs: ALLOWED,
      delivery: DELIVERY,
      vocAnalysis: vocAnalysisFixture(),
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const input = built.input;

    // 绑定与白名单原样透传
    expect(input.binding).toEqual(BINDING);
    expect(input.allowedEvidenceRefs).toEqual(ALLOWED);
    expect(input.fieldPresence.bsr).toBe("present");

    // 叙述：仅绑定且白名单内者进入 verified；其余进入 unverified（含未验证假设）
    expect(input.verifiedNarratives).toHaveLength(1);
    expect(input.verifiedNarratives[0]?.text).toBe("有绑定的摘要");
    expect(input.verifiedNarratives[0]?.evidenceRefs).toEqual(["evidence:ev-1"]);
    expect(input.unverifiedNarratives).toContain("引用不在白名单的风险");
    expect(input.unverifiedNarratives).toContain("无引用文本");
    expect(input.unverifiedNarratives).toContain("未验证假设 U1");

    // VOC：仅可确定性映射且白名单内的主题进入；其余整主题降级
    const labels = (input.voc?.themes ?? []).map((theme) => theme.label).sort();
    expect(labels).toEqual(["正常痛点", "正面主题"].sort());
    const pain = (input.voc?.themes ?? []).find((theme) => theme.label === "正常痛点");
    expect(pain?.evidenceRefs).toEqual(["attachment:att-1"]);
    const downgraded = input.vocRefResolution.downgradedThemes;
    expect(downgraded.map((theme) => theme.label).sort()).toEqual(
      ["混合引用痛点", "未知引用痛点", "refId错配痛点", "歧义痛点"].sort(),
    );
    const byLabel = new Map(downgraded.map((theme) => [theme.label, theme.reason]));
    expect(byLabel.get("混合引用痛点")).toBe("REF_NOT_IN_ALLOWLIST");
    expect(byLabel.get("未知引用痛点")).toBe("UNMAPPED_REF");
    expect(byLabel.get("refId错配痛点")).toBe("UNMAPPED_REF");
    expect(byLabel.get("歧义痛点")).toBe("UNMAPPED_REF");
    expect(input.vocRefResolution.mappedThemeRefs).toBe(2);
    expect(input.voc?.independentReviewCount).toBe(3);
    expect(input.voc?.themeMentionCount).toBe(2);

    // 风险门禁与决策摘要
    expect(input.riskGateSummary?.status).toBe("blocked");
    expect(input.riskGateSummary?.hasBlockingRisk).toBe(true);
    expect(input.riskGateSummary?.ruleCounts).toEqual({ blocking: 2, warning: 1, notComputable: 3, passed: 5 });
    expect(input.decisionSummary?.researchPriority).toBe("P2");
    expect(input.decisionSummary?.recommendedNextAction).toBe("补充数据");
    expect(input.missingInformation).toEqual(["m"]);
  });

  it("无正式 VOC 分析：voc=null 且不编造（其余字段照常）", () => {
    const built = buildJevReadinessInputFromProduction({
      taskId: "task-1",
      asin: "B0TEST0001",
      binding: BINDING,
      report: REPORT,
      bundle: bundleFixture(),
      allowedEvidenceRefs: ALLOWED,
      delivery: null,
      vocAnalysis: null,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input.voc).toBeNull();
    expect(built.input.vocRefResolution.mappedThemeRefs).toBe(0);
    expect(built.input.riskGateSummary).toBeNull();
    expect(built.input.decisionSummary).toBeNull();
  });
});
