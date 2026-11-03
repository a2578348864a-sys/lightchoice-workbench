import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prismaFindTask: vi.fn(),
  prismaFindCandidate: vi.fn(),
  getSubject: vi.fn(),
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
  })),
}));

import { buildResearchEngineInput } from "@/lib/server/research/researchInput";
import { manualEntryAdapter } from "@/lib/sourceLayer/adapters/manualEntryAdapter";
import { adaptEvidenceToProductFact } from "@/lib/sourceLayer/fact/productFactAdapter";

const capturedAt = "2026-09-20T00:00:00.000Z";
function fixtureEvidence() {
  const captured = manualEntryAdapter.capture({ payload: { asin: "B0GFCZTRKL", title: "Bamboo Cutting Board",
    productUrl: "https://www.amazon.com/dp/B0GFCZTRKL", images: ["https://images.example.test/board.jpg"], brand: "EcoWood", price: 29.99,
    rating: 4.8, reviewCount: 120, bsrRank: 1200, bsrCategory: "Kitchen" }, capturedAt, operator: "owner:v1" });
  const pkg = manualEntryAdapter.normalize({ draft: captured.drafts[0], captureId: "cap-1", version: 1 });
  const outcome = manualEntryAdapter.validate({ pkg, context: { now: capturedAt } });
  return manualEntryAdapter.createEvidence({ pkg: outcome.pkg, report: outcome.report });
}
function fixtureProductFact() { return adaptEvidenceToProductFact({ evidence: fixtureEvidence() }); }

describe("ResearchInput Review Evidence Projection (G3-B)", () => {
  beforeEach(() => {
    mocks.prismaFindTask.mockReset();
    mocks.prismaFindCandidate.mockReset();
    mocks.getSubject.mockReset();
  });

  it("当 EvidenceStore 存在 review_evidence 附件时，将其引用与摘要安全注入 sourceEvidenceRefs", async () => {
    const fact = fixtureProductFact();
    mocks.prismaFindTask.mockResolvedValue({
      id: "task-123",
      updatedAt: new Date(capturedAt),
      resultJson: JSON.stringify({
        candidateToTask: { candidateId: "cand-456" },
      }),
    });
    mocks.prismaFindCandidate.mockResolvedValue({
      id: "cand-456",
      convertedTaskId: "task-123",
      sourceMetaJson: JSON.stringify({
        productFact: fact,
      }),
    });

    mocks.getSubject.mockResolvedValue({
      subjectKey: "amazon:US:B0GFCZTRKL",
      versions: [fixtureEvidence()],
      attachments: [
        {
          attachmentId: "att-rev-999",
          kind: "review_evidence",
          contentHash: "hash-rev-999",
          capturedAt: "2026-09-21T10:00:00.000Z",
          sourceUrl: null,
          payload: {
            schemaVersion: "review-evidence-source-attachment.v1",
            reviews: [
              {
                asin: "B0GFCZTRKL",
                reviewText: "Great cutting board! Very solid.",
                rating: 5,
                reviewTitle: "Excellent",
                verifiedPurchase: true,
              },
            ],
          },
        },
      ],
    });

    const engineInput = await buildResearchEngineInput({
      context: { mode: "owner", token: "test" },
      taskId: "task-123",
    });

    // 1. 验证 sourceEvidenceRefs 包含主证据与评论附件引用
    expect(engineInput.sourceEvidenceRefs).toHaveLength(2);
    expect(engineInput.sourceEvidenceRefs[0].refId).toBe(`evidence:${fact.sourceProof.evidenceId}`);
    expect(engineInput.sourceEvidenceRefs[1].refId).toBe("attachment:att-rev-999");
    expect(engineInput.sourceEvidenceRefs[1].subjectKey).toBe("amazon:US:B0GFCZTRKL");

    // 2. 验证 reviewEvidenceSummary 包含评论样本摘要
    expect(engineInput.reviewEvidenceSummary).toBeDefined();
    expect(engineInput.reviewEvidenceSummary).toHaveLength(1);
    expect(engineInput.reviewEvidenceSummary![0].refId).toBe("attachment:att-rev-999");
    expect(engineInput.reviewEvidenceSummary![0].sampleReviews[0].text).toBe(
      "Great cutting board! Very solid."
    );

    // 3. 铁律核查：ProductFact 绝不包含评论字段，保持 Review ≠ ProductFact 隔离
    expect((engineInput.productFact as any).reviewEvidence).toBeUndefined();
    expect((engineInput.productFact.basic as any).reviews).toBeUndefined();
  });

  it("当 EvidenceStore 无 review_evidence 时，sourceEvidenceRefs 仅含主证据引用", async () => {
    const fact = fixtureProductFact();
    mocks.prismaFindTask.mockResolvedValue({
      id: "task-123",
      updatedAt: new Date(capturedAt),
      resultJson: JSON.stringify({
        candidateToTask: { candidateId: "cand-456" },
      }),
    });
    mocks.prismaFindCandidate.mockResolvedValue({
      id: "cand-456",
      convertedTaskId: "task-123",
      sourceMetaJson: JSON.stringify({
        productFact: fact,
      }),
    });
    mocks.getSubject.mockResolvedValue({
      subjectKey: "amazon:US:B0GFCZTRKL",
      versions: [fixtureEvidence()],
      attachments: [],
    });

    const engineInput = await buildResearchEngineInput({
      context: { mode: "owner", token: "test" },
      taskId: "task-123",
    });

    expect(engineInput.sourceEvidenceRefs).toHaveLength(1);
    expect(engineInput.sourceEvidenceRefs[0].refId).toBe(`evidence:${fact.sourceProof.evidenceId}`);
    expect(engineInput.reviewEvidenceSummary).toBeUndefined();
  });
});
