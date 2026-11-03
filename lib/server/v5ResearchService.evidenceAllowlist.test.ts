import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildResearchInputBundle: vi.fn(),
}));

vi.mock("@/lib/server/research/researchInputBundle", () => ({
  buildResearchInputBundle: mocks.buildResearchInputBundle,
}));

import { allowedEvidenceRefsOf, loadCanonicalResearchBoundary } from "@/lib/server/v5ResearchService";

describe("canonical Research evidence allowlist boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed when only blocked or unverified audit refs exist", async () => {
    mocks.buildResearchInputBundle.mockResolvedValue({
      sourceEvidenceRefs: [
        { refId: "attachment:blocked-review-ref" },
        { refId: "attachment:unverified-keyword-ref" },
        { refId: "attachment:plan-limitation-ref" },
        { refId: "attachment:human-action-required-ref" },
      ],
      reviewEvidence: [],
      keywordEvidence: [],
      trendObservations: [],
    });

    const result = await loadCanonicalResearchBoundary({
      context: { mode: "owner", token: "test-owner-token" },
      taskId: "task-blocked-evidence-only",
    });

    expect(result).toMatchObject({ ok: false, errorCode: "EVIDENCE_BINDING_MISSING" });
  });

  it("adds only the formal Customer Voice attachment identity to the Research citation allowlist", () => {
    expect(allowedEvidenceRefsOf({
      customerVoiceEvidence: [{ attachmentId: "cv-attachment-1", contentHash: "d".repeat(64) }],
    })).toEqual(expect.arrayContaining([
      "attachment:cv-attachment-1",
      `attachment:${"d".repeat(64)}`,
      `attachment:a-${"d".repeat(64)}`,
    ]));
  });

  it("adds only the bound Provider metric attachment identity to the Research citation allowlist", () => {
    expect(allowedEvidenceRefsOf({
      providerMetricEvidence: [{
        evidenceRefId: "attachment:ss-kw-1",
        attachmentId: "ss-kw-1",
        contentHash: "e".repeat(64),
      }],
    })).toEqual(expect.arrayContaining([
      "attachment:ss-kw-1",
      `attachment:${"e".repeat(64)}`,
      `attachment:a-${"e".repeat(64)}`,
    ]));
  });

  it("fails closed for a provider metric entry without a bound attachment identity", () => {
    expect(allowedEvidenceRefsOf({ providerMetricEvidence: [{}] })).toEqual([]);
  });

  it("authorizes only field and variation references bound to attachments in this bundle", () => {
    const subjectKey = "amazon:US:B0CFTP6JR4";
    const detailHash = "a".repeat(64);
    const variationHash = "b".repeat(64);
    const detailId = "att-detail-bound";
    const variationId = "att-variation-bound";
    const detailRef = `attachment:${detailId}`;
    const variationRef = `attachment:${variationId}`;
    const baseEvidence = {
      kind: "product_evidence" as const,
      refId: "evidence:primary-1",
      subjectKey,
      evidenceId: "primary-1",
      captureId: "capture-1",
      version: 1,
      contentHash: "c".repeat(64),
      capturedAt: "2026-10-01T00:00:00.000Z",
    };
    const detailEvidence = {
      ...baseEvidence,
      kind: "attachment" as const,
      refId: detailRef,
      contentHash: detailHash,
      capturedAt: "2026-10-02T00:00:00.000Z",
      attachmentId: detailId,
    };
    const variationEvidenceRef = {
      ...baseEvidence,
      kind: "attachment" as const,
      refId: variationRef,
      contentHash: variationHash,
      capturedAt: "2026-10-03T00:00:00.000Z",
      attachmentId: variationId,
    };
    const allowed = allowedEvidenceRefsOf({
      sourceEvidenceRefs: [baseEvidence, detailEvidence, variationEvidenceRef],
      productFact: {
        subjectKey,
        sourceProof: { evidenceId: "primary-1" },
        basic: {
          asin: { value: "B0CFTP6JR4" },
          brand: { evidenceRefs: [{
            refId: detailRef,
            source: "amazon_dom",
            captureId: detailId,
            evidenceId: detailId,
            subjectKey,
            capturedAt: detailEvidence.capturedAt,
            contentHash: detailHash,
            sourceUrl: "https://www.amazon.com/dp/B0CFTP6JR4",
          }] },
        },
      },
      variationEvidence: {
        subjectKey,
        subjectAsin: "B0CFTP6JR4",
        outcome: "complete",
        completeness: "complete",
        evidenceRefs: [variationEvidenceRef],
      },
    });

    expect(allowed).toEqual(expect.arrayContaining([
      detailRef,
      `attachment:${detailHash}`,
      `attachment:a-${detailHash}`,
      variationRef,
      `attachment:${variationHash}`,
      `attachment:a-${variationHash}`,
    ]));
    expect(allowed).not.toContain("attachment:att-not-in-this-bundle");
  });

  it("blocks a claimed ProductFact citation before Research when its attachment binding is absent", async () => {
    mocks.buildResearchInputBundle.mockResolvedValue({
      subjectKey: "amazon:US:B0CFTP6JR4",
      productFact: {
        subjectKey: "amazon:US:B0CFTP6JR4",
        sourceProof: { evidenceId: "primary-2" },
        basic: {
          brand: { evidenceRefs: [{
            refId: "attachment:att-missing",
            source: "amazon_dom",
            captureId: "att-missing",
            evidenceId: "att-missing",
            subjectKey: "amazon:US:B0CFTP6JR4",
            capturedAt: "2026-10-02T00:00:00.000Z",
            contentHash: "d".repeat(64),
            sourceUrl: "https://www.amazon.com/dp/B0CFTP6JR4",
          }] },
        },
      },
      sourceEvidenceRefs: [{
        kind: "product_evidence",
        refId: "evidence:primary-2",
        subjectKey: "amazon:US:B0CFTP6JR4",
        evidenceId: "primary-2",
        captureId: "capture-2",
        version: 1,
        contentHash: "e".repeat(64),
        capturedAt: "2026-10-01T00:00:00.000Z",
      }],
      reviewEvidence: [], keywordEvidence: [], trendObservations: [],
    });

    const result = await loadCanonicalResearchBoundary({
      context: { mode: "owner", token: "test-owner-token" },
      taskId: "task-invalid-field-binding",
    });

    expect(result).toMatchObject({ ok: false, errorCode: "EVIDENCE_BINDING_MISSING" });
    if (!result.ok) expect(result.message).toContain("basic.brand");
  });
});
