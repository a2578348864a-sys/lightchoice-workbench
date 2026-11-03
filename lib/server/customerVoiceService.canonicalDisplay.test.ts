import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerVoiceResearchEvidence } from "@/lib/sourceLayer/v2/contracts";

const mocks = vi.hoisted(() => ({
  buildResearchInputBundle: vi.fn(),
  getSubject: vi.fn(),
  getVocAnalysis: vi.fn(),
}));

vi.mock("@/lib/server/research/researchInputBundle", () => ({
  buildResearchInputBundle: mocks.buildResearchInputBundle,
}));
vi.mock("@/lib/sourceLayer/server/sourceLayerService", () => ({
  sourceLayerOperator: vi.fn(() => "owner:v1"),
}));
vi.mock("@/lib/sourceLayer/server/evidenceStore", () => ({
  createEvidenceStore: vi.fn(() => ({ getSubject: mocks.getSubject })),
}));
vi.mock("@/lib/server/vocAnalysis", async () => ({
  ...(await vi.importActual<typeof import("@/lib/server/vocAnalysis")>("@/lib/server/vocAnalysis")),
  getVocAnalysis: mocks.getVocAnalysis,
}));

import { listCustomerVoiceForResearchTask } from "@/lib/server/customerVoiceService";
import { adaptCustomerVoiceEvidenceToVocObservations } from "@/lib/server/vocAnalysis";
import { buildCustomerVoiceAttachmentPayload, buildCustomerVoiceObservation } from "@/lib/sourceLayer/customerVoice";
import { buildSourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import { buildV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";

const SUBJECT_KEY = "amazon:US:B005CXG1X0";
const CAPTURED_AT = "2026-10-10T12:00:00.000Z";
const CONTEXT = { mode: "owner", token: "test" } as const;

function buildCanonicalObservations() {
  return Array.from({ length: 13 }, (_, index) => buildCustomerVoiceObservation({
    source: "amazon_review",
    subjectKey: SUBJECT_KEY,
    externalContentId: `canonical-review-${index + 1}`,
    parentContentId: null,
    threadId: null,
    contentType: "review",
    authorRef: null,
    capturedAt: CAPTURED_AT,
    publishedAt: `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    title: `Review ${index + 1}`,
    text: `Review body ${index + 1}`,
    rating: 5,
    verifiedPurchase: true,
    engagement: null,
    sourceUrl: "https://www.amazon.com/dp/B005CXG1X0",
    evidenceRefs: ["attachment:v3-review-source"],
    provenance: {
      provider: "amazon_dom",
      method: "capture_v3_amazon_review",
      accessBasis: "first_party_visible_page",
      sourceAttachmentId: "v3-review-source",
      rawArtifactId: null,
      providerTermsVersion: null,
    },
    retentionPolicy: null,
    deletionRequired: false,
    externalDeletedAt: null,
    identityMatch: "EXACT",
    ownerExperience: null,
  }));
}

function projectCanonicalEvidence(
  attachmentId: string,
  contentHash: string,
  observations: ReturnType<typeof buildCanonicalObservations>,
): CustomerVoiceResearchEvidence {
  return {
    attachmentId,
    contentHash,
    source: "amazon_review",
    observationCount: observations.length,
    omittedCount: 0,
    observations: observations.map((observation) => ({
      refId: `attachment:${attachmentId}`,
      externalContentId: observation.externalContentId,
      contentHash: observation.contentHash,
      source: observation.source,
      evidenceRefs: observation.evidenceRefs,
      limitations: ["public_top_reviews_only"],
      parentContentId: observation.parentContentId,
      threadId: observation.threadId,
      subreddit: observation.subreddit,
      depth: observation.depth,
      contentType: observation.contentType,
      title: observation.title,
      text: observation.text,
      rating: observation.rating,
      verifiedPurchase: observation.verifiedPurchase,
      publishedAt: observation.publishedAt,
      engagement: observation.engagement,
      authorRef: observation.authorRef,
      provenance: observation.provenance,
      identityMatch: observation.identityMatch,
      ownerExperience: observation.ownerExperience,
    })),
  };
}

describe("Buyer Voice canonical display query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVocAnalysis.mockResolvedValue(null);
  });

  it("returns the 13 unique canonical observations across duplicate attachments and excludes legacy and V3 display rows", async () => {
    const canonicalAttachmentId = "canonical-customer-voice";
    const duplicateCanonicalAttachmentId = "canonical-customer-voice-duplicate";
    const canonicalObservations = buildCanonicalObservations();
    const canonicalPayload = buildCustomerVoiceAttachmentPayload({
      subjectKey: SUBJECT_KEY,
      observations: canonicalObservations,
    });
    const canonicalAttachment = buildSourceEvidenceAttachment({
      attachmentId: canonicalAttachmentId,
      subjectKey: SUBJECT_KEY,
      kind: "customer_voice_observation_v1",
      sourceType: "amazon_dom",
      capturedAt: CAPTURED_AT,
      sourceUrl: "https://www.amazon.com/dp/B005CXG1X0",
      payload: canonicalPayload as unknown as Record<string, unknown>,
    });
    const duplicateCanonicalAttachment = buildSourceEvidenceAttachment({
      attachmentId: duplicateCanonicalAttachmentId,
      subjectKey: SUBJECT_KEY,
      kind: "customer_voice_observation_v1",
      sourceType: "amazon_dom",
      capturedAt: CAPTURED_AT,
      sourceUrl: "https://www.amazon.com/dp/B005CXG1X0",
      payload: canonicalPayload as unknown as Record<string, unknown>,
    });
    const legacyAttachment = buildSourceEvidenceAttachment({
      attachmentId: "legacy-review-evidence",
      subjectKey: SUBJECT_KEY,
      kind: "review_evidence",
      sourceType: "amazon_dom",
      capturedAt: CAPTURED_AT,
      sourceUrl: "https://www.amazon.com/dp/B005CXG1X0",
      payload: {
        asin: "B005CXG1X0",
        reviews: canonicalObservations.map((observation) => ({
          asin: "B005CXG1X0",
          title: observation.title,
          reviewText: observation.text,
          rating: observation.rating,
          verifiedPurchase: observation.verifiedPurchase,
          reviewDate: observation.publishedAt,
        })),
      },
    });
    const v3Evidence = buildV3ModuleEvidence({
      module: "review_voc",
      subjectKey: SUBJECT_KEY,
      marketplace: "US",
      capturedAt: CAPTURED_AT,
      provider: "amazon",
      sourceSurface: "visible_product_page",
      sourceUrl: "https://www.amazon.com/dp/B005CXG1X0",
      acquisitionMode: "DOM_DIRECT",
      metricNature: "source_observed",
      status: "AVAILABLE_WITH_LIMITATION",
      limitations: ["public_top_reviews_only"],
      identity: { asin: "B005CXG1X0" },
      data: {
        reviews: canonicalObservations.map((observation) => ({
          title: observation.title,
          body: observation.text,
          rating: observation.rating,
          verifiedPurchase: observation.verifiedPurchase,
          publishedAt: observation.publishedAt,
        })),
      },
    });
    const v3Attachment = buildSourceEvidenceAttachment({
      attachmentId: "v3-review-source",
      subjectKey: SUBJECT_KEY,
      kind: "v3_review_voc_v1",
      sourceType: "amazon_dom",
      capturedAt: CAPTURED_AT,
      sourceUrl: "https://www.amazon.com/dp/B005CXG1X0",
      payload: v3Evidence as unknown as Record<string, unknown>,
    });
    const canonicalGroup = projectCanonicalEvidence(canonicalAttachmentId, canonicalAttachment.contentHash, canonicalObservations);
    const duplicateCanonicalGroup = projectCanonicalEvidence(
      duplicateCanonicalAttachmentId,
      duplicateCanonicalAttachment.contentHash,
      canonicalObservations,
    );

    mocks.buildResearchInputBundle.mockResolvedValue({
      subjectKey: SUBJECT_KEY,
      customerVoiceEvidence: [canonicalGroup, duplicateCanonicalGroup],
    });
    mocks.getSubject.mockResolvedValue({
      subjectKey: SUBJECT_KEY,
      versions: [{ version: 1 }],
      attachments: [canonicalAttachment, duplicateCanonicalAttachment, legacyAttachment, v3Attachment],
    });

    const result = await listCustomerVoiceForResearchTask({ context: CONTEXT, taskId: "task-canonical-display" });
    const analyzeObservations = adaptCustomerVoiceEvidenceToVocObservations([canonicalGroup, duplicateCanonicalGroup]);

    expect(result.count).toBe(analyzeObservations.length);
    expect(result.count).toBe(13);
    expect(result.observations).toHaveLength(analyzeObservations.length);
    expect(result.observations.map((observation) => observation.externalContentId)).toEqual(
      analyzeObservations.map((observation) => observation.observationId),
    );
    expect(result.observations.map((observation) => observation.externalContentId)).toEqual(
      canonicalObservations.map((observation) => observation.externalContentId),
    );
    expect(result.observations.every((observation) =>
      observation.provenance.sourceAttachmentId === "v3-review-source"
      && observation.evidenceRefs.includes("attachment:v3-review-source"),
    )).toBe(true);
    expect(result.evidenceRefs).toEqual([
      expect.objectContaining({ refId: `attachment:${canonicalAttachmentId}` }),
      expect.objectContaining({ refId: `attachment:${duplicateCanonicalAttachmentId}` }),
    ]);
    expect(result.observations.some((observation) => observation.evidenceRefs.includes("attachment:legacy-review-evidence"))).toBe(false);
    expect(result.analysis).toBeNull();
  });
});
