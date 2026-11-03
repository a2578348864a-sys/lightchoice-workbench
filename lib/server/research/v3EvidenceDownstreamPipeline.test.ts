import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  prismaFindTask: vi.fn(),
  prismaFindCandidate: vi.fn(),
  getSubject: vi.fn(),
  listTrendObservations: vi.fn(),
  recordDiagnosticEvent: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({
  prisma: {
    viralAnalysisRecord: {
      findUnique: mocks.prismaFindTask,
    },
    opportunityCandidate: {
      findUnique: mocks.prismaFindCandidate,
    },
  },
}));

vi.mock("@/lib/sourceLayer/server/evidenceStore", () => ({
  createEvidenceStore: vi.fn(() => ({
    getSubject: mocks.getSubject,
    listTrendObservations: mocks.listTrendObservations,
  })),
}));

vi.mock("@/lib/sourceLayer/server/diagnosticService", () => ({
  recordDiagnosticEvent: mocks.recordDiagnosticEvent,
}));

import { buildResearchEngineInput } from "@/lib/server/research/researchInput";
import { buildResearchInputBundle } from "@/lib/server/research/researchInputBundle";
import { allowedEvidenceRefsOf } from "@/lib/server/v5ResearchService";
import { manualEntryAdapter } from "@/lib/sourceLayer/adapters/manualEntryAdapter";
import { adaptEvidenceToProductFact } from "@/lib/sourceLayer/fact/productFactAdapter";
import type { SourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import {
  syntheticHistoricalTrendAttachment,
  syntheticReviewAttachment,
  syntheticReverseAsinAttachment,
} from "./v3EvidenceTestFixtures";

const capturedAt = "2026-09-26T08:20:00.000Z";
function fixtureEvidence() {
  const captured = manualEntryAdapter.capture({ payload: { asin: "B07G4VTV2F", title: "KINTO Day-off Tumbler Water Bottle",
    productUrl: "https://www.amazon.com/dp/B07G4VTV2F", images: ["https://m.media-amazon.com/images/I/71xyz.jpg"], brand: "KINTO",
    price: 38.5, rating: 4.5, reviewCount: 1046, bsrRank: 2500, bsrCategory: "Kitchen" }, capturedAt, operator: "owner:v1" });
  const pkg = manualEntryAdapter.normalize({ draft: captured.drafts[0], captureId: "cap-b07g4vtv2f", version: 1 });
  const outcome = manualEntryAdapter.validate({ pkg, context: { now: capturedAt } });
  return manualEntryAdapter.createEvidence({ pkg: outcome.pkg, report: outcome.report });
}
function fixtureProductFact() { return adaptEvidenceToProductFact({ evidence: fixtureEvidence() }); }

describe("Downstream Consumption Pipeline Spike: End-to-End Adapter Verification", () => {
  let realReviewAtt: SourceEvidenceAttachment;
  let realKwAtt: SourceEvidenceAttachment;
  let realHistAtt: SourceEvidenceAttachment;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordDiagnosticEvent.mockResolvedValue({ persisted: true, event: {} });
    mocks.listTrendObservations.mockResolvedValue([]);

    // Synthetic fixtures exercise adapter behavior; real data is reserved for REAL_E2E.
    realReviewAtt = syntheticReviewAttachment();
    realKwAtt = syntheticReverseAsinAttachment();
    realHistAtt = syntheticHistoricalTrendAttachment();
  });

  it("1. buildResearchEngineInput 能消费 V3 关键词与 V3 评论", async () => {
    const fact = fixtureProductFact();
    mocks.prismaFindTask.mockResolvedValue({
      id: "task-spike-01",
      updatedAt: new Date(capturedAt),
      resultJson: JSON.stringify({
        candidateToTask: { candidateId: "cand-spike-01" },
      }),
    });
    mocks.prismaFindCandidate.mockResolvedValue({
      id: "cand-spike-01",
      convertedTaskId: "task-spike-01",
      sourceMetaJson: JSON.stringify({ productFact: fact }),
    });

    // Mock EvidenceStore 包含合成 V3 附件。
    mocks.getSubject.mockResolvedValue({
      subjectKey: fact.subjectKey,
      versions: [fixtureEvidence()],
      attachments: [realReviewAtt, realKwAtt, realHistAtt],
    });

    const engineInput = await buildResearchEngineInput({
      context: { mode: "owner", token: "test" },
      taskId: "task-spike-01",
    });

    // 关键词验证：V3 关键词成功投影入 ProductFact
    expect(engineInput.productFact.keywordEvidence).toBeDefined();
    expect(engineInput.productFact.keywordEvidence?.topKeywords.status).toBe("present");
    const keywords = engineInput.productFact.keywordEvidence?.topKeywords.value ?? [];
    expect(keywords.length).toBeGreaterThan(0);
    expect(keywords.map((k) => k.keyword)).toContain("kinto water bottle");

    // 关键词来源性质：必须保持 estimate，不得升级为 confirmed
    for (const kw of keywords) {
      expect(kw.metricNature).toBe("estimate");
      expect(kw.evidenceRef).toBe(`attachment:${realKwAtt.attachmentId}`);
    }

    // 评论验证：V3 评论进入 reviewEvidenceSummary
    expect(engineInput.reviewEvidenceSummary).toBeDefined();
    expect(engineInput.reviewEvidenceSummary).toHaveLength(1);
    const reviewSummary = engineInput.reviewEvidenceSummary![0];
    expect(reviewSummary.refId).toBe(`attachment:${realReviewAtt.attachmentId}`);
    expect(reviewSummary.asin).toBe("B07G4VTV2F");
    expect(reviewSummary.sampleReviews.length).toBeGreaterThanOrEqual(4);
    expect(reviewSummary.sampleReviews[0].text).toContain("Synthetic fixture review text");

    // 评论引用进入 sourceEvidenceRefs
    const refIds = engineInput.sourceEvidenceRefs.map((r) => r.refId);
    expect(refIds).toContain(`evidence:${fact.sourceProof.evidenceId}`);
    expect(refIds).toContain(`attachment:${realReviewAtt.attachmentId}`);

    // 铁律验证：评论绝不进入 ProductFact
    expect((engineInput.productFact as any).reviewEvidence).toBeUndefined();
    expect((engineInput.productFact.basic as any).reviews).toBeUndefined();
  });

  it("2. buildResearchInputBundle 能完整消费 V3 关键词、评论及内存历史趋势", async () => {
    const fact = fixtureProductFact();
    mocks.prismaFindTask.mockResolvedValue({
      id: "task-spike-02",
      updatedAt: new Date(capturedAt),
      resultJson: JSON.stringify({
        candidateToTask: { candidateId: "cand-spike-02" },
      }),
    });
    mocks.prismaFindCandidate.mockResolvedValue({
      id: "cand-spike-02",
      convertedTaskId: "task-spike-02",
      sourceMetaJson: JSON.stringify({ productFact: fact }),
    });

    mocks.getSubject.mockResolvedValue({
      subjectKey: fact.subjectKey,
      versions: [fixtureEvidence()],
      attachments: [realReviewAtt, realKwAtt, realHistAtt],
    });

    const bundle = await buildResearchInputBundle({
      context: { mode: "owner", token: "test" },
      taskId: "task-spike-02",
    });

    // 1. 验证 V3 关键词附件被 Bundle 消费
    expect(bundle.keywordEvidence).toHaveLength(1);
    expect(bundle.keywordEvidence[0].kind).toBe("v3_reverse_asin_v1");
    expect(bundle.keywordEvidence[0].attachmentId).toBe(realKwAtt.attachmentId);

    // 2. 验证 V3 评论附件被 Bundle 消费
    expect(bundle.reviewEvidence).toHaveLength(1);
    expect(bundle.reviewEvidence[0].kind).toBe("v3_review_voc_v1");
    expect(bundle.reviewEvidence[0].attachmentId).toBe(realReviewAtt.attachmentId);

    // 3. 验证 V3 历史趋势转换为内存 TrendObservation
    expect(bundle.trendObservations.length).toBeGreaterThanOrEqual(3);
    for (const trend of bundle.trendObservations) {
      expect(trend.schemaVersion).toBe("trend-observation.v1");
      expect(trend.subjectKey).toBe(fact.subjectKey);
      expect(trend.valueKind).toBe("estimated");
      expect(trend.sourceType).toBe("sellersprite_plugin");
      expect(trend.evidenceRefs).toEqual([`attachment:${realHistAtt.attachmentId}`]);
    }

    // 4. 验证 sourceEvidenceRefs 包含所有 V3 证据引用
    const allRefs = bundle.sourceEvidenceRefs.map((r) => r.refId);
    expect(allRefs).toContain(`evidence:${fact.sourceProof.evidenceId}`);
    expect(allRefs).toContain(`attachment:${realReviewAtt.attachmentId}`);
    expect(allRefs).toContain(`attachment:${realKwAtt.attachmentId}`);
    expect(allRefs).toContain(`attachment:${realHistAtt.attachmentId}`);
    expect(allRefs.some((r) => r.startsWith("trend:v3:"))).toBe(true);

    // 5. 诊断写入使用 mock，不访问真实 Canonical Store。
    expect(mocks.recordDiagnosticEvent).toHaveBeenCalled();
  });

  it("3. 回归测试：BLOCKED_WITH_EVIDENCE 的评论和关键词附件不得进入可消费证据，但保留在 sourceEvidenceRefs 中", async () => {
    const fact = fixtureProductFact();
    mocks.prismaFindTask.mockResolvedValue({
      id: "task-spike-03",
      updatedAt: new Date(capturedAt),
      resultJson: JSON.stringify({
        candidateToTask: { candidateId: "cand-spike-03" },
      }),
    });
    mocks.prismaFindCandidate.mockResolvedValue({
      id: "cand-spike-03",
      convertedTaskId: "task-spike-03",
      sourceMetaJson: JSON.stringify({ productFact: fact }),
    });

    const realBlockedReviewAtt = syntheticReviewAttachment("BLOCKED_WITH_EVIDENCE");
    expect((realBlockedReviewAtt.payload as any).status).toBe("BLOCKED_WITH_EVIDENCE");

    // 构造 status = BLOCKED_WITH_EVIDENCE 的关键词附件
    const blockedKwAtt: SourceEvidenceAttachment = {
      schemaVersion: "source-evidence-attachment.v1",
      attachmentId: "att-kw-blocked-999",
      subjectKey: fact.subjectKey,
      sourceType: "sellersprite_plugin",
      kind: "v3_reverse_asin_v1",
      capturedAt,
      contentHash: "hash-blocked-kw",
      sourceUrl: null,
      sourceFingerprint: null,
      payload: {
        schemaVersion: "capture-system-v3-module-evidence.v1",
        module: "reverse_asin",
        subjectKey: fact.subjectKey,
        marketplace: "US",
        capturedAt,
        provider: "sellersprite",
        sourceSurface: "web",
        sourceUrl: null,
        providerUpdatedAt: null,
        acquisitionMode: "DOM_DIRECT",
        metricNature: "provider_observed",
        status: "BLOCKED_WITH_EVIDENCE",
        limitations: ["crawler blocked by captcha"],
        identity: { asin: "B07G4VTV2F" },
        data: { accessGate: { blocked: true } },
        evidenceOnly: true,
      },
    };

    // Store 包含：正常评论 + 被阻断评论 + 正常关键词 + 被阻断关键词 + 正常时序
    mocks.getSubject.mockResolvedValue({
      subjectKey: fact.subjectKey,
      versions: [fixtureEvidence()],
      attachments: [
        realReviewAtt,
        realBlockedReviewAtt,
        realKwAtt,
        blockedKwAtt,
        realHistAtt,
      ],
    });

    // 1. 验证 buildResearchEngineInput 消费门禁
    const engineInput = await buildResearchEngineInput({
      context: { mode: "owner", token: "test" },
      taskId: "task-spike-03",
    });

    // 评论摘要只包含正常评论，被阻断评论不得进入
    expect(engineInput.reviewEvidenceSummary).toHaveLength(1);
    expect(engineInput.reviewEvidenceSummary![0].refId).toBe(`attachment:${realReviewAtt.attachmentId}`);
    expect(engineInput.reviewEvidenceSummary![0].sampleReviews).toHaveLength(4);

    // 2. 验证 buildResearchInputBundle 消费门禁
    const bundle = await buildResearchInputBundle({
      context: { mode: "owner", token: "test" },
      taskId: "task-spike-03",
    });

    // 评论门禁：bundle.reviewEvidence 仅包含 1 个合法评论附件，被阻断附件被严格拦截
    expect(bundle.reviewEvidence).toHaveLength(1);
    expect(bundle.reviewEvidence[0].attachmentId).toBe(realReviewAtt.attachmentId);
    expect(bundle.reviewEvidence.some((att) => att.attachmentId === realBlockedReviewAtt.attachmentId)).toBe(false);

    // 关键词门禁：bundle.keywordEvidence 仅包含 1 个合法关键词附件，被阻断附件被严格拦截
    expect(bundle.keywordEvidence).toHaveLength(1);
    expect(bundle.keywordEvidence[0].attachmentId).toBe(realKwAtt.attachmentId);
    expect(bundle.keywordEvidence.some((att) => att.attachmentId === blockedKwAtt.attachmentId)).toBe(false);

    // 区分原则验证：sourceEvidenceRefs 作为来源留痕索引，必须包含被阻断的附件
    const allRefIds = bundle.sourceEvidenceRefs.map((r) => r.refId);
    expect(allRefIds).toContain(`attachment:${realBlockedReviewAtt.attachmentId}`);
    expect(allRefIds).toContain(`attachment:${blockedKwAtt.attachmentId}`);
    expect(allRefIds).toContain(`attachment:${realReviewAtt.attachmentId}`);
    expect(allRefIds).toContain(`attachment:${realKwAtt.attachmentId}`);

    // 4. 验证 allowedEvidenceRefs 白名单：只包含合法可消费证据，严格剔除被阻断的附件
    const allowed = allowedEvidenceRefsOf(bundle);
    expect(allowed).toContain(`evidence:${fact.sourceProof.evidenceId}`);
    expect(allowed).toContain(`attachment:${realReviewAtt.attachmentId}`);
    expect(allowed).toContain(`attachment:${realKwAtt.attachmentId}`);
    expect(allowed).toContain(`attachment:${realHistAtt.attachmentId}`);
    expect(allowed).not.toContain(`attachment:${realBlockedReviewAtt.attachmentId}`);
    expect(allowed).not.toContain(`attachment:${blockedKwAtt.attachmentId}`);

    // A complete audit ledger containing only blocked/unverified evidence is never a model allowlist.
    expect(allowedEvidenceRefsOf({
      sourceEvidenceRefs: [
        { refId: `attachment:${realBlockedReviewAtt.attachmentId}` },
        { refId: `attachment:${blockedKwAtt.attachmentId}` },
        { refId: "attachment:unverified-review-ref" },
        { refId: "attachment:plan-limitation-keyword-ref" },
        { refId: "attachment:human-action-required-ref" },
      ],
    })).toEqual([]);
  });
});
