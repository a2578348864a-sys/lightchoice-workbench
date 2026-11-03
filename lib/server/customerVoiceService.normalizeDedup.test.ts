import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildResearchInputBundle: vi.fn(),
  getSubject: vi.fn(),
  captureAttachment: vi.fn(),
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
vi.mock("@/lib/sourceLayer/server/captureGateway", () => ({
  captureEvidenceAttachmentThroughGateway: mocks.captureAttachment,
}));

import { normalizeAmazonReviewsForResearchTask } from "@/lib/server/customerVoiceService";
import { deduplicateReviewEvidence } from "@/lib/server/research/v3EvidenceResearchAdapter";
import { buildSourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import { buildV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";

const SUBJECT_KEY = "amazon:US:B005CXG1X0";
const CAPTURED_AT = "2026-10-09T02:39:00.192Z";
const CONTEXT = { mode: "owner", token: "" } as const;

describe("normalizeAmazonReviewsForResearchTask cross-format deduplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.captureAttachment.mockResolvedValue({
      attachment: { attachmentId: "normalized-voice-attachment", contentHash: "f".repeat(64) },
    });
  });

  it("normalizes 13 matching legacy and V3 rows once, using the deduplicated ResearchInputBundle projection", async () => {
    const rows = Array.from({ length: 13 }, (_, index) => ({
      asin: "B005CXG1X0",
      title: `Review ${index + 1}`,
      body: `Review body ${index + 1}`,
      rating: 5,
      verifiedPurchase: true,
      publishedAt: `2026-09-${String(index + 1).padStart(2, "0")}`,
    }));
    const legacy = buildSourceEvidenceAttachment({
      attachmentId: "legacy-review-attachment",
      subjectKey: SUBJECT_KEY,
      kind: "review_evidence",
      sourceType: "amazon_dom",
      capturedAt: CAPTURED_AT,
      sourceUrl: "https://www.amazon.com/dp/B005CXG1X0",
      payload: {
        asin: "B005CXG1X0",
        reviews: rows.map((row) => ({
          asin: row.asin,
          title: row.title,
          reviewText: row.body,
          rating: row.rating,
          verifiedPurchase: row.verifiedPurchase,
          reviewDate: row.publishedAt,
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
      data: { reviews: rows },
    });
    const v3 = buildSourceEvidenceAttachment({
      attachmentId: "v3-review-attachment",
      subjectKey: SUBJECT_KEY,
      kind: "v3_review_voc_v1",
      sourceType: "amazon_dom",
      capturedAt: CAPTURED_AT,
      sourceUrl: "https://www.amazon.com/dp/B005CXG1X0",
      payload: v3Evidence as unknown as Record<string, unknown>,
    });
    const reviewEvidence = deduplicateReviewEvidence([legacy], [v3]);

    expect(reviewEvidence.map((attachment) => attachment.attachmentId)).toEqual(["v3-review-attachment"]);
    expect(reviewEvidence[0].payload.status).toBe("AVAILABLE_WITH_LIMITATION");
    expect(reviewEvidence[0].payload.limitations).toEqual(["public_top_reviews_only"]);
    mocks.buildResearchInputBundle.mockResolvedValue({
      subjectKey: SUBJECT_KEY,
      reviewEvidence,
    });
    mocks.getSubject.mockResolvedValue({
      subjectKey: SUBJECT_KEY,
      versions: [{ version: 3 }],
      attachments: [legacy, v3],
    });

    const result = await normalizeAmazonReviewsForResearchTask({
      context: CONTEXT,
      taskId: "cmuux87dg000f5nbglvmh0wq7",
    });

    expect(result).toMatchObject({ sourceCount: 13, added: 13, duplicate: 0 });
    expect(mocks.captureAttachment).toHaveBeenCalledTimes(1);
    const captured = mocks.captureAttachment.mock.calls[0][0];
    const persistedRows = (captured.payload as { observations: Array<Record<string, unknown>> }).observations;
    expect(persistedRows).toHaveLength(13);
    expect(persistedRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidenceRefs: ["attachment:v3-review-attachment"],
        provenance: expect.objectContaining({ sourceAttachmentId: "v3-review-attachment" }),
      }),
    ]));
    expect(persistedRows.every((row) =>
      (row.provenance as { sourceAttachmentId?: string }).sourceAttachmentId === "v3-review-attachment",
    )).toBe(true);
  });
});
