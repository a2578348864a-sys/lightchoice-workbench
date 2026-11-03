import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { CustomerVoiceResearchEvidence } from "@/lib/sourceLayer/v2/contracts";

const mocks = vi.hoisted(() => ({
  buildResearchInputBundle: vi.fn(),
  readReviewEvidenceSnapshot: vi.fn(),
  getReviewEvidence: vi.fn(),
  importReviews: vi.fn(),
  analyzeVoc: vi.fn(),
}));

vi.mock("@/lib/server/research/researchInputBundle", () => ({
  buildResearchInputBundle: mocks.buildResearchInputBundle,
}));
vi.mock("@/lib/server/reviewEvidence", () => ({
  readReviewEvidenceSnapshot: mocks.readReviewEvidenceSnapshot,
  getReviewEvidence: mocks.getReviewEvidence,
  importReviews: mocks.importReviews,
}));
vi.mock("@/lib/server/vocAnalysis", () => ({
  analyzeVoc: mocks.analyzeVoc,
}));

import { analyzeVocForResearchTask } from "@/lib/server/customerVoiceService";

const context = { mode: "owner", token: "test" } as const;
const canonicalGroup: CustomerVoiceResearchEvidence = {
  attachmentId: "customer-voice-attachment-1",
  contentHash: "b".repeat(64),
  source: "amazon_review",
  observationCount: 1,
  omittedCount: 0,
  observations: [{
    refId: "attachment:customer-voice-attachment-1",
    externalContentId: "amazon-review-external-1",
    contentHash: "a".repeat(64),
    source: "amazon_review",
    evidenceRefs: ["attachment:raw-amazon-review-1"],
    parentContentId: null,
    threadId: null,
    subreddit: null,
    depth: null,
    contentType: "review",
    title: "Strong build",
    text: "The product feels sturdy.",
    rating: 5,
    verifiedPurchase: true,
    publishedAt: "2026-09-01T00:00:00.000Z",
    engagement: null,
    authorRef: null,
    provenance: {
      provider: "amazon_dom",
      method: "capture_v3_amazon_review",
      accessBasis: "first_party_visible_page",
      sourceAttachmentId: "raw-amazon-review-1",
      rawArtifactId: null,
      providerTermsVersion: null,
    },
    identityMatch: "EXACT",
    ownerExperience: null,
  }],
};

describe("Customer Voice Analyze service boundary", () => {
  it("builds canonical ResearchInputBundle input and never reads or imports legacy ReviewEvidence", async () => {
    vi.clearAllMocks();
    mocks.buildResearchInputBundle.mockResolvedValue({
      candidateId: "candidate-1",
      subjectKey: "amazon:US:B005CXG1X0",
      customerVoiceEvidence: [canonicalGroup],
      reviewEvidence: [{ attachmentId: "legacy-review", kind: "review_evidence" }],
    });
    mocks.readReviewEvidenceSnapshot.mockResolvedValue({
      resultJson: "{}",
      updatedAt: "2026-10-11T00:00:00.000Z",
    });
    mocks.analyzeVoc.mockResolvedValue({
      analysis: { schema: "voc-analysis.v1" },
      unverified: [],
      gateResult: "pass",
    });

    const result = await analyzeVocForResearchTask({ context, taskId: "task-canonical" });

    expect(result).toMatchObject({ gateResult: "pass", unverifiedCount: 0 });
    expect(mocks.buildResearchInputBundle).toHaveBeenCalledWith({
      context,
      taskId: "task-canonical",
      recordDiagnostic: false,
    });
    expect(mocks.analyzeVoc).toHaveBeenCalledWith(expect.objectContaining({
      context,
      taskId: "task-canonical",
      candidateId: "candidate-1",
      subjectKey: "amazon:US:B005CXG1X0",
      customerVoiceEvidence: [canonicalGroup],
    }));
    expect(mocks.getReviewEvidence).not.toHaveBeenCalled();
    expect(mocks.importReviews).not.toHaveBeenCalled();
  });

  it("keeps Amazon collection free of automatic Analyze and Provider calls", () => {
    const source = readFileSync(new URL("./customerVoiceService.ts", import.meta.url), "utf8");
    const start = source.indexOf("export async function collectAmazonReviewsForResearchTask");
    const end = source.indexOf("export async function analyzeVocForResearchTask", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const collectImplementation = source.slice(start, end);
    expect(collectImplementation).not.toMatch(/\banalyzeVoc\b|\bcallAiJson\b|\bimportReviews\b/u);
    expect(collectImplementation).not.toContain("vocAnalysis:");
  });
});
