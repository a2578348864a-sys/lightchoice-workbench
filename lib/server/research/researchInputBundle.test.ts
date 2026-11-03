import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildResearchEngineInput: vi.fn(),
  createEvidenceStore: vi.fn(),
  sourceLayerOperator: vi.fn(() => "owner:v1"),
  recordDiagnosticEvent: vi.fn(),
}));

vi.mock("@/lib/server/research/researchInput", () => ({
  buildResearchEngineInput: mocks.buildResearchEngineInput,
}));
vi.mock("@/lib/sourceLayer/server/evidenceStore", () => ({
  createEvidenceStore: mocks.createEvidenceStore,
}));
vi.mock("@/lib/sourceLayer/server/sourceLayerService", () => ({
  sourceLayerOperator: mocks.sourceLayerOperator,
}));
vi.mock("@/lib/sourceLayer/server/diagnosticService", () => ({
  recordDiagnosticEvent: mocks.recordDiagnosticEvent,
}));

import {
  conflictProductFactFields,
  missingProductFactFields,
} from "@/lib/server/research/researchInputBundle";
import {
  buildCustomerVoiceAttachmentPayload,
  buildCustomerVoiceObservation,
} from "@/lib/sourceLayer/customerVoice";
import { SOURCE_EVIDENCE_ATTACHMENT_SCHEMA } from "@/lib/sourceLayer/evidenceAttachment";
import { buildV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import { syntheticReviewAttachment } from "@/lib/server/research/v3EvidenceTestFixtures";

const fact = {
  schema: "product-fact.v3" as const,
  subjectKey: "amazon:US:B000000001",
  sourceProof: {} as never,
  basic: {
    asin: { value: "B000000001", status: "present" },
    title: { value: null, status: "missing" },
  },
  market: { bsr: { value: null, status: "missing" } },
  profit: { fbaFee: { value: null, status: "missing" } },
};

function variationAttachment() {
  const asin = "B000000001";
  const childAsin = "B000000002";
  const capturedAt = "2026-09-21T00:03:00.000Z";
  const payload = buildV3ModuleEvidence({
    module: "variation",
    subjectKey: fact.subjectKey,
    marketplace: "US",
    capturedAt,
    provider: "Amazon",
    sourceSurface: "Amazon product detail variation DOM",
    sourceUrl: `https://www.amazon.com/dp/${asin}`,
    acquisitionMode: "DOM_DIRECT",
    metricNature: "source_observed",
    status: "VALIDATED_AVAILABLE",
    limitations: [],
    identity: { asin, parentAsin: asin },
    data: {
      outcome: "COMPLETE",
      variationStatus: "COMPLETE",
      currentAsin: asin,
      parentAsin: asin,
      variantAsins: [asin, childAsin],
      variants: [
        { asin, options: [{ dimensionKey: "size", label: "Size", value: "Small" }] },
        { asin: childAsin, options: [{ dimensionKey: "size", label: "Size", value: "Large" }] },
      ],
      identityProof: { urlAsin: asin, pageAsin: asin, productContainerFound: true, bound: true },
      error: null,
    },
    evidenceOnly: true,
  });
  return {
    schemaVersion: SOURCE_EVIDENCE_ATTACHMENT_SCHEMA,
    attachmentId: "variation-attachment-1",
    subjectKey: fact.subjectKey,
    kind: "v3_variation_v1" as const,
    sourceType: "amazon_dom" as const,
    capturedAt,
    sourceUrl: `https://www.amazon.com/dp/${asin}`,
    sourceFingerprint: "variation-query-1",
    contentHash: "f".repeat(64),
    payload: payload as unknown as Record<string, unknown>,
  };
}

describe("ResearchInputBundle field inventory", () => {
  it("keeps missing fields explicit", () => {
    expect(missingProductFactFields(fact as never)).toEqual(["basic.title", "market.bsr", "profit.fbaFee"]);
  });

  it("surfaces conflict markers without changing facts", () => {
    expect(conflictProductFactFields({
      ...fact,
      basic: { ...fact.basic, title: { value: "x", status: "conflict" } },
    } as never)).toEqual(["basic.title"]);
  });

  it("surfaces unresolved field projection conflicts to Research without promoting either value", () => {
    expect(conflictProductFactFields({
      ...fact,
      basic: { ...fact.basic, reviewCount: { value: null, status: "missing" } },
      sourceConflicts: [{ field: "basic.reviewCount", code: "SOURCE_CONFLICT_UNRESOLVED", resolved: false, candidates: [] }],
    } as never)).toEqual(["basic.reviewCount"]);
  });
});

describe("ResearchInputBundle EvidenceStore handoff trace", () => {
  beforeEach(() => {
    mocks.buildResearchEngineInput.mockReset();
    mocks.createEvidenceStore.mockReset();
    mocks.recordDiagnosticEvent.mockReset();
    mocks.recordDiagnosticEvent.mockResolvedValue({ persisted: true, event: {} });
  });

  it("reads linked evidence and records a redacted research handoff event", async () => {
    const mixedReview = `${"It works well for my baking. ".repeat(45)}However the lid cracked after a few weeks.`;
    expect(mixedReview.length).toBeGreaterThan(1_000);
    const voice = buildCustomerVoiceObservation({
      source: "manual_voc",
      subjectKey: fact.subjectKey,
      externalContentId: "manual-voice-row-1",
      parentContentId: null,
      threadId: null,
      contentType: "review",
      authorRef: null,
      capturedAt: "2026-09-21T00:02:00.000Z",
      publishedAt: null,
      title: "Lid durability",
      text: mixedReview,
      rating: 2,
      verifiedPurchase: null,
      engagement: null,
      sourceUrl: null,
      evidenceRefs: [`rawArtifact:raw-${"a".repeat(24)}`],
      provenance: {
        provider: "manual_import",
        method: "manual_import",
        accessBasis: "user_supplied_file",
        sourceAttachmentId: null,
        rawArtifactId: `raw-${"a".repeat(24)}`,
        providerTermsVersion: null,
      },
      retentionPolicy: null,
      deletionRequired: false,
      externalDeletedAt: null,
      identityMatch: "UNRESOLVED",
      ownerExperience: null,
    });
    const sourceReview = syntheticReviewAttachment();
    const sourceReviewAttachment = {
      ...sourceReview,
      attachmentId: "source-review-v3",
      subjectKey: fact.subjectKey,
      payload: {
        ...sourceReview.payload,
        subjectKey: fact.subjectKey,
        status: "AVAILABLE_WITH_LIMITATION",
        limitations: ["public_top_reviews_only"],
        identity: { asin: "B000000001" },
      },
    };
    const sourceVariationAttachment = variationAttachment();
    const normalizedAmazonReview = buildCustomerVoiceObservation({
      source: "amazon_review",
      subjectKey: fact.subjectKey,
      externalContentId: "normalized-review-1",
      parentContentId: null,
      threadId: null,
      contentType: "review",
      authorRef: null,
      capturedAt: "2026-09-21T00:02:00.000Z",
      publishedAt: null,
      title: "Synthetic sample title",
      text: "Synthetic fixture review text for adapter verification.",
      rating: 5,
      verifiedPurchase: true,
      engagement: null,
      sourceUrl: null,
      evidenceRefs: ["attachment:source-review-v3"],
      provenance: {
        provider: "amazon_dom",
        method: "capture_v3_amazon_review",
        accessBasis: "first_party_visible_page",
        sourceAttachmentId: "source-review-v3",
        rawArtifactId: null,
        providerTermsVersion: null,
      },
      retentionPolicy: null,
      deletionRequired: false,
      externalDeletedAt: null,
      identityMatch: "EXACT",
      ownerExperience: null,
    });
    const voicePayload = buildCustomerVoiceAttachmentPayload({
      subjectKey: fact.subjectKey,
      observations: [voice],
    });
    const amazonVoicePayload = buildCustomerVoiceAttachmentPayload({
      subjectKey: fact.subjectKey,
      observations: [normalizedAmazonReview],
    });
    const linkedFact = {
      ...fact,
      sourceProof: {
        source: "amazon_dom",
        subjectKey: fact.subjectKey,
        evidenceId: "ev-product-1",
        captureId: "cap-product-1",
        contentHash: "hash-product-1",
        capturedAt: "2026-09-21T00:00:00.000Z",
      },
    };
    const evidence = {
      evidenceId: "ev-product-1",
      captureId: "cap-product-1",
      subjectKey: fact.subjectKey,
      sourceType: "amazon_dom",
      version: 2,
      contentHash: "hash-product-1",
      capturedAt: "2026-09-21T00:00:00.000Z",
    };
    mocks.buildResearchEngineInput.mockResolvedValue({
      taskId: "task-research-1",
      candidateId: "candidate-1",
      productFact: linkedFact,
    });
    mocks.createEvidenceStore.mockReturnValue({
      getSubject: vi.fn().mockResolvedValue({
        subjectKey: fact.subjectKey,
        versions: [evidence],
        attachments: [{
          attachmentId: "attachment-keyword-1",
          kind: "keyword_evidence",
          contentHash: "hash-keyword-1",
          capturedAt: "2026-09-21T00:01:00.000Z",
        }, sourceReviewAttachment, sourceVariationAttachment, {
          attachmentId: "customer-voice-attachment-1",
          kind: "customer_voice_observation_v1",
          contentHash: "hash-customer-voice-1",
          capturedAt: "2026-09-21T00:02:00.000Z",
          payload: voicePayload,
        }, {
          attachmentId: "customer-voice-amazon-attachment-1",
          kind: "customer_voice_observation_v1",
          contentHash: "hash-customer-voice-amazon-1",
          capturedAt: "2026-09-21T00:02:00.000Z",
          payload: amazonVoicePayload,
        }],
      }),
      listTrendObservations: vi.fn().mockResolvedValue([]),
    });

    const { buildResearchInputBundle } = await import("@/lib/server/research/researchInputBundle");
    const result = await buildResearchInputBundle({
      context: { mode: "owner", token: "test-token" },
      taskId: "task-research-1",
      traceId: "trace-research-1",
    });

    expect(result.traceId).toBe("trace-research-1");
    expect(result.sourceEvidenceRefs.map((ref) => ref.refId)).toEqual([
      "evidence:ev-product-1",
      "attachment:attachment-keyword-1",
      "attachment:source-review-v3",
      "attachment:variation-attachment-1",
      "attachment:customer-voice-attachment-1",
      "attachment:customer-voice-amazon-attachment-1",
    ]);
    expect(result.customerVoiceEvidence).toHaveLength(2);
    expect(result.customerVoiceEvidence?.[0]).toMatchObject({
      attachmentId: "customer-voice-attachment-1",
      source: "manual_voc",
      observationCount: 1,
    });
    expect(result.customerVoiceEvidence?.[0]?.observations).toEqual([{
        refId: "attachment:customer-voice-attachment-1",
        externalContentId: "manual-voice-row-1",
        contentHash: expect.any(String),
        source: "manual_voc",
        evidenceRefs: [`rawArtifact:raw-${"a".repeat(24)}`],
        limitations: [],
        parentContentId: null,
        threadId: null,
        subreddit: null,
        depth: null,
        contentType: "review",
        title: "Lid durability",
        text: mixedReview,
        rating: 2,
        verifiedPurchase: null,
        publishedAt: null,
        engagement: null,
        authorRef: null,
        provenance: {
          provider: "manual_import",
          method: "manual_import",
          accessBasis: "user_supplied_file",
          sourceAttachmentId: null,
          rawArtifactId: `raw-${"a".repeat(24)}`,
          providerTermsVersion: null,
        },
        identityMatch: "UNRESOLVED",
        ownerExperience: null,
      }]);
    expect(result.customerVoiceEvidence?.[1]).toMatchObject({
      attachmentId: "customer-voice-amazon-attachment-1",
      source: "amazon_review",
      observationCount: 1,
      observations: [{
        refId: "attachment:customer-voice-amazon-attachment-1",
        externalContentId: expect.any(String),
        contentHash: expect.any(String),
        source: "amazon_review",
        evidenceRefs: ["attachment:source-review-v3"],
        limitations: ["public_top_reviews_only"],
        parentContentId: null,
        threadId: null,
        subreddit: null,
        depth: null,
        contentType: "review",
        title: "Synthetic sample title",
        text: "Synthetic fixture review text for adapter verification.",
        rating: 5,
        verifiedPurchase: true,
        publishedAt: null,
        engagement: null,
        authorRef: null,
        provenance: {
          provider: "amazon_dom",
          method: "capture_v3_amazon_review",
          accessBasis: "first_party_visible_page",
          sourceAttachmentId: "source-review-v3",
          rawArtifactId: null,
          providerTermsVersion: null,
        },
        identityMatch: "EXACT",
        ownerExperience: null,
      }],
    });
    expect(result.reviewEvidence).toEqual([]);
    expect(result.variationEvidence).toMatchObject({
      outcome: "complete",
      completeness: "complete",
      parentAsin: "B000000001",
      memberAsins: ["B000000001", "B000000002"],
      evidenceRefs: [{ refId: "attachment:variation-attachment-1", kind: "attachment", attachmentId: "variation-attachment-1" }],
      relations: expect.arrayContaining([
        expect.objectContaining({ relation: "child", toAsin: "B000000002", evidenceRefs: expect.arrayContaining([
          expect.objectContaining({ refId: "attachment:variation-attachment-1" }),
        ]) }),
      ]),
    });
    expect(mocks.recordDiagnosticEvent).toHaveBeenCalledTimes(1);
    expect(mocks.recordDiagnosticEvent.mock.calls[0]?.[0]).toMatchObject({
      event: expect.objectContaining({
        traceId: "trace-research-1",
        taskId: "task-research-1",
        subjectKey: linkedFact.subjectKey,
        module: "RESEARCH_HANDOFF",
        eventType: "research_input_bundle_read",
        evidenceRefs: [
          "evidence:ev-product-1",
          "attachment:attachment-keyword-1",
          "attachment:source-review-v3",
          "attachment:variation-attachment-1",
          "attachment:customer-voice-attachment-1",
          "attachment:customer-voice-amazon-attachment-1",
        ],
      }),
    });

    await buildResearchInputBundle({
      context: { mode: "owner", token: "test-token" },
      taskId: "task-research-1",
      traceId: "trace-read-only",
      recordDiagnostic: false,
    });
    expect(mocks.recordDiagnosticEvent).toHaveBeenCalledTimes(1);
  });

  it("includes exact Amazon history origins in the ResearchInputBundle evidence refs", async () => {
    const asin = "B000000001";
    const subjectKey = `amazon:US:${asin}`;
    const sourceUrl = `https://www.amazon.com/dp/${asin}`;
    const currentRef = {
      refId: "evidence:ev-product-current",
      kind: "product_evidence" as const,
      subjectKey,
      evidenceId: "ev-product-current",
      captureId: "cap-product-current",
      version: 2,
      contentHash: "a".repeat(64),
      capturedAt: "2026-10-01T00:00:00.000Z",
    };
    const historyRef = {
      refId: "evidence:ev-product-history",
      kind: "product_evidence" as const,
      subjectKey,
      evidenceId: "ev-product-history",
      captureId: "cap-product-history",
      version: 1,
      contentHash: "b".repeat(64),
      capturedAt: "2026-09-30T00:00:00.000Z",
    };
    const binding = {
      bound: true,
      expectedAsin: asin,
      observedAsin: asin,
      expectedMarketplace: "US",
      observedMarketplace: "US",
      urlAsin: asin,
      urlMarketplace: "US",
    };
    const origin = {
      evidenceId: historyRef.evidenceId,
      captureId: historyRef.captureId,
      subjectKey,
      version: historyRef.version,
      contentHash: historyRef.contentHash,
      capturedAt: historyRef.capturedAt,
      sourceType: "amazon_dom",
      sourceUrl,
      marketplace: "US",
      asin,
      sourceRef: "amazon_dom.title",
      ruleId: "title",
      registryVersion: "amazon-detail-field-registry.v1",
      resolverVersion: "amazon-detail-field-resolver.v1",
    };
    const historyFact = {
      ...fact,
      subjectKey,
      sourceProof: {
        source: "amazon_dom",
        subjectKey,
        evidenceId: currentRef.evidenceId,
        captureId: currentRef.captureId,
        contentHash: currentRef.contentHash,
        capturedAt: currentRef.capturedAt,
        sourceUrl,
        operator: "owner:v1",
        entityBinding: binding,
      },
      basic: {
        ...fact.basic,
        asin: { value: asin, status: "present" },
        title: {
          value: "Restored title",
          status: "present",
          source: "amazon_dom",
          confidence: 1,
          capturedAt: historyRef.capturedAt,
          rawProofHash: historyRef.contentHash,
          evidenceRefs: [{ ...historyRef, source: "amazon_dom", sourceUrl }],
        },
      },
      amazonDetailHistory: {
        schemaVersion: "amazon-detail-field-history-projection.v1",
        subjectKey,
        marketplace: "US",
        asin,
        injectedNow: "2026-10-01T00:00:00.000Z",
        priceContext: null,
        fields: {
          title: { field: "title", status: "restored", value: "Restored title", origin, candidateOrigins: [origin], rejected: [], reason: null, decisionHash: "c".repeat(64) },
          price: { field: "price", status: "missing", value: null, origin: null, candidateOrigins: [], rejected: [], reason: "no_eligible_confirmed_candidate", decisionHash: "d".repeat(64) },
        },
        decisionHash: "e".repeat(64),
      },
    };
    const evidenceRecord = (ref: typeof currentRef | typeof historyRef) => ({
      evidenceId: ref.evidenceId,
      captureId: ref.captureId,
      subjectKey,
      version: ref.version,
      sourceType: "amazon_dom",
      sourceUrl,
      capturedAt: ref.capturedAt,
      contentHash: ref.contentHash,
      factAuthority: "evidence_only",
      validation: { verdict: "passed", readyForResearch: true },
      pkg: {
        subjectKey,
        captureId: ref.captureId,
        version: ref.version,
        marketplace: "US",
        fields: { asin },
        sourceProof: { sourceType: "amazon_dom", capturedAt: ref.capturedAt, sourceUrl, entityBinding: binding },
      },
    });
    const records = [evidenceRecord(currentRef), evidenceRecord(historyRef)];
    mocks.buildResearchEngineInput.mockResolvedValue({
      taskId: "task-history",
      candidateId: "candidate-history",
      productFact: historyFact,
    });
    mocks.createEvidenceStore.mockReturnValue({
      getSubject: vi.fn().mockResolvedValue({ subjectKey, versions: records, attachments: [] }),
      listTrendObservations: vi.fn().mockResolvedValue([]),
    });

    const { buildResearchInputBundle } = await import("@/lib/server/research/researchInputBundle");
    const result = await buildResearchInputBundle({
      context: { mode: "owner", token: "test-token" },
      taskId: "task-history",
      engineInput: {
        taskId: "task-history",
        candidateId: "candidate-history",
        productFact: historyFact,
      } as never,
      recordDiagnostic: false,
    });

    expect(result.sourceEvidenceRefs.filter((ref) => ref.kind === "product_evidence")).toEqual([currentRef, historyRef]);
    expect(result.sourceEvidenceRefs.map((ref) => ref.refId)).toEqual([currentRef.refId, historyRef.refId]);
    expect(mocks.buildResearchEngineInput).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PH3：SellerSprite typed provider 字段进入正式 ResearchInputBundle
// ─────────────────────────────────────────────────────────────────────────────
function sellerSpriteKeywordAttachment(contentHash = "s".repeat(64)) {
  const asin = "B000000001";
  const capturedAt = "2026-09-26T08:20:00.000Z";
  const payload = buildV3ModuleEvidence({
    module: "reverse_asin",
    subjectKey: fact.subjectKey,
    marketplace: "US",
    capturedAt,
    provider: "SellerSprite",
    sourceSurface: "reverse_asin_table",
    sourceUrl: null,
    acquisitionMode: "DOM_DIRECT",
    metricNature: "provider_estimate",
    status: "VALIDATED_AVAILABLE",
    limitations: [],
    identity: { asin },
    data: {
      tables: [{
        headers: ["Rank", "Keyword", "Traffic Share", "Estimated Traffic", "Organic Rank"],
        rows: [["1", "kitchen organizer", "38.37%", "81,070", "515"]],
      }],
    },
  });
  return {
    schemaVersion: SOURCE_EVIDENCE_ATTACHMENT_SCHEMA,
    attachmentId: "attachment-ss-keyword-1",
    subjectKey: fact.subjectKey,
    kind: "v3_reverse_asin_v1" as const,
    sourceType: "sellersprite_plugin" as const,
    capturedAt,
    sourceUrl: null,
    sourceFingerprint: null,
    contentHash,
    payload,
  };
}

function sellerSpriteKeywordMiningAttachment() {
  const seedKeyword = "wood cutting board";
  const attachmentId = "attachment-ss-mining-1";
  const capturedAt = "2026-09-26T08:25:00.000Z";
  const payload = buildV3ModuleEvidence({
    module: "keyword_mining_trend",
    subjectKey: fact.subjectKey,
    marketplace: "US",
    capturedAt,
    provider: "SellerSprite",
    sourceSurface: "SellerSprite keyword mining visible table",
    sourceUrl: "https://www.sellersprite.com/v3/keyword-miner/",
    acquisitionMode: "DOM_DIRECT",
    metricNature: "provider_estimate",
    status: "VALIDATED_AVAILABLE",
    limitations: [],
    identity: { keyword: seedKeyword },
    data: {
      queryInput: { module: "keyword_mining_trend", seedKeyword, marketplace: "US" },
      queryIdentity: {
        subjectKey: fact.subjectKey,
        marketplace: "US",
        module: "keyword_mining_trend",
        query: seedKeyword,
        queryFingerprint: "a".repeat(64),
        captureJobFingerprint: "b".repeat(64),
      },
      visibleDom: {
        tables: [{
          selector: "table.keyword-results",
          headers: ["关键词", "月搜索量"],
          rows: [["bamboo cutting board", "1,240"]],
          headerSource: "visible_table",
          headerStatus: "HEADER_OK",
          columnCount: 2,
        }],
      },
    },
  });
  return {
    schemaVersion: SOURCE_EVIDENCE_ATTACHMENT_SCHEMA,
    attachmentId,
    subjectKey: fact.subjectKey,
    kind: "v3_keyword_mining_trend_v1" as const,
    sourceType: "sellersprite_plugin" as const,
    capturedAt,
    sourceUrl: "https://www.sellersprite.com/v3/keyword-miner/",
    sourceFingerprint: "b".repeat(64),
    contentHash: "m".repeat(64),
    payload,
  };
}

function sellerSpriteProductMarketAttachment(input: {
  attachmentId?: string;
  subjectKey?: string;
  asin?: string;
  contentHash?: string;
  data?: Record<string, unknown>;
} = {}) {
  const subjectKey = input.subjectKey ?? fact.subjectKey;
  const asin = input.asin ?? "B000000001";
  const capturedAt = "2026-09-26T08:50:36.000Z";
  const payload = buildV3ModuleEvidence({
    module: "sellersprite_product_market",
    subjectKey,
    marketplace: "US",
    capturedAt,
    provider: "SellerSprite",
    sourceSurface: "SellerSprite visible product summary card",
    sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
    acquisitionMode: "DOM_DIRECT",
    metricNature: "provider_observed",
    status: "AVAILABLE_WITH_LIMITATION",
    limitations: ["visible product summary only"],
    identity: { asin, parentAsin: "B0B75Y63J4" },
    data: input.data ?? {
      bsr: { rank: 30297, category: "Home & Kitchen" },
      price: { amount: 37.01, currency: "USD" },
      rating: 4.6,
      reviewCount: 1046,
    },
  });
  return {
    schemaVersion: SOURCE_EVIDENCE_ATTACHMENT_SCHEMA,
    attachmentId: input.attachmentId ?? "attachment-ss-product-market-1",
    subjectKey,
    kind: "v3_sellersprite_product_market_v1" as const,
    sourceType: "sellersprite_plugin" as const,
    capturedAt,
    sourceUrl: payload.sourceUrl,
    sourceFingerprint: "market-query-1",
    contentHash: input.contentHash ?? "c".repeat(64),
    payload,
  };
}

describe("PH3 typed provider → ResearchInputBundle 集成", () => {
  beforeEach(() => {
    mocks.buildResearchEngineInput.mockReset();
    mocks.createEvidenceStore.mockReset();
    mocks.recordDiagnosticEvent.mockReset();
    mocks.recordDiagnosticEvent.mockResolvedValue({ persisted: true, event: {} });
  });

  function wire(attachments: readonly unknown[]) {
    const linkedFact = {
      ...fact,
      sourceProof: {
        source: "amazon_dom",
        subjectKey: fact.subjectKey,
        evidenceId: "ev-product-1",
        captureId: "cap-product-1",
        contentHash: "hash-product-1",
        capturedAt: "2026-09-21T00:00:00.000Z",
      },
    };
    mocks.buildResearchEngineInput.mockResolvedValue({
      taskId: "task-ss-1",
      candidateId: "candidate-ss-1",
      productFact: linkedFact,
    });
    mocks.createEvidenceStore.mockReturnValue({
      getSubject: vi.fn().mockResolvedValue({
        subjectKey: fact.subjectKey,
        versions: [{
          evidenceId: "ev-product-1",
          captureId: "cap-product-1",
          subjectKey: fact.subjectKey,
          sourceType: "amazon_dom",
          version: 2,
          contentHash: "hash-product-1",
          capturedAt: "2026-09-21T00:00:00.000Z",
        }],
        attachments,
      }),
      listTrendObservations: vi.fn().mockResolvedValue([]),
    });
  }

  it("真实 typed provider 字段进入 bundle，并按附件来源绑定（非借用当前 Evidence ID）", async () => {
    wire([sellerSpriteKeywordAttachment()]);
    const { buildResearchInputBundle } = await import("@/lib/server/research/researchInputBundle");
    const result = await buildResearchInputBundle({
      context: { mode: "owner", token: "test-token" },
      taskId: "task-ss-1",
      recordDiagnostic: false,
    });

    // 附件引用已进 bundle
    expect(result.sourceEvidenceRefs.map((ref) => ref.refId)).toContain("attachment:attachment-ss-keyword-1");

    expect(result.providerMetricEvidence).toHaveLength(1);
    const entry = result.providerMetricEvidence![0];
    expect(entry.provider).toBe("SellerSprite");
    expect(entry.subjectKey).toBe(fact.subjectKey);
    expect(entry.queryIdentity).toEqual({ subjectKey: fact.subjectKey, marketplace: "US", asin: "B000000001" });
    expect(entry.sourceType).toBe("sellersprite_plugin");
    expect(entry.evidenceRefId).toBe("attachment:attachment-ss-keyword-1");
    expect(entry.contentHash).toBe("s".repeat(64));
    expect(entry.capturedAt).toBe("2026-09-26T08:20:00.000Z");
    expect(entry.metricNature).toBe("provider_estimate");
    expect(entry.metricPeriod).toBeNull();
    expect(entry.observedAt).toBeNull();
    // 铁律：不使用当前 Evidence 的 ID 包装第三方字段
    expect(entry as Record<string, unknown>).not.toHaveProperty("evidenceId");
    expect(entry as Record<string, unknown>).not.toHaveProperty("evidenceVersion");

    expect(entry.rows).toHaveLength(1);
    expect(entry.rows[0].keyword).toBe("kitchen organizer");
    const metricNames = entry.rows[0].metrics.map((metric) => metric.metric);
    expect(metricNames).toContain("trafficShare");
    expect(metricNames).toContain("estimatedTraffic");
    expect(metricNames).toContain("organicRank");
    for (const metric of entry.rows[0].metrics) {
      // SellerSprite 估算绝不升格为 Amazon confirmed
      expect(metric.metricNature).toBe("provider_estimate");
      expect(metric.value).not.toBeNull();
    }
    expect(entry.rows[0].metrics.find((metric) => metric.metric === "trafficShare")).toMatchObject({
      value: 0.3837,
      unit: "ratio",
    });
  });

  it("Keyword Mining 在 ASIN Research subject 下保留独立 seed 与可回查附件引用", async () => {
    const attachment = sellerSpriteKeywordMiningAttachment();
    wire([attachment]);
    const { buildResearchInputBundle } = await import("@/lib/server/research/researchInputBundle");
    const result = await buildResearchInputBundle({
      context: { mode: "owner", token: "test-token" },
      taskId: "task-ss-1",
      recordDiagnostic: false,
    });

    const entry = result.providerMetricEvidence?.[0];
    expect(result.sourceEvidenceRefs).toContainEqual(expect.objectContaining({
      refId: "attachment:attachment-ss-mining-1",
      kind: "attachment",
      subjectKey: fact.subjectKey,
      attachmentId: "attachment-ss-mining-1",
      contentHash: "m".repeat(64),
      capturedAt: "2026-09-26T08:25:00.000Z",
    }));
    expect(entry).toMatchObject({
      module: "keyword_mining_trend",
      subjectKey: fact.subjectKey,
      queryIdentity: { subjectKey: fact.subjectKey, marketplace: "US", asin: "B000000001" },
      evidenceRefId: "attachment:attachment-ss-mining-1",
      rows: [{ keyword: "bamboo cutting board" }],
      metricNature: "provider_estimate",
    });
    expect((attachment.payload as { identity?: { keyword?: string } }).identity?.keyword).toBe("wood cutting board");
    expect((attachment.payload as { data?: { queryIdentity?: { query?: string } } }).data?.queryIdentity?.query).toBe("wood cutting board");
  });

  it("把同 ASIN SellerSprite 商品级显式市场指标按原来源、时间、口径投影到 Research", async () => {
    const attachment = sellerSpriteProductMarketAttachment();
    wire([attachment]);
    const { buildResearchInputBundle } = await import("@/lib/server/research/researchInputBundle");
    const result = await buildResearchInputBundle({
      context: { mode: "owner", token: "test-token" },
      taskId: "task-ss-1",
      recordDiagnostic: false,
    });
    const marketBundle = result as unknown as {
      providerProductMarketEvidence?: readonly Record<string, unknown>[];
    };

    expect(marketBundle.providerProductMarketEvidence).toHaveLength(1);
    expect(marketBundle.providerProductMarketEvidence?.[0]).toMatchObject({
      provider: "SellerSprite",
      module: "sellersprite_product_market",
      subjectKey: fact.subjectKey,
      asin: "B000000001",
      parentAsin: "B0B75Y63J4",
      sourceType: "sellersprite_plugin",
      sourceSurface: "SellerSprite visible product summary card",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
      evidenceRefId: "attachment:attachment-ss-product-market-1",
      attachmentId: "attachment-ss-product-market-1",
      contentHash: "c".repeat(64),
      capturedAt: "2026-09-26T08:50:36.000Z",
      metricNature: "provider_observed",
      limitations: ["visible product summary only"],
      metrics: [
        { metric: "bsrRank", value: 30297, scope: "Home & Kitchen", metricNature: "provider_observed" },
        { metric: "price", value: 37.01, currency: "USD", metricNature: "provider_observed" },
        { metric: "rating", value: 4.6, metricNature: "provider_observed" },
        { metric: "reviewCount", value: 1046, metricNature: "provider_observed" },
      ],
    });
    expect(result.sourceEvidenceRefs).toContainEqual(expect.objectContaining({
      refId: "attachment:attachment-ss-product-market-1",
      kind: "attachment",
      subjectKey: fact.subjectKey,
      contentHash: "c".repeat(64),
      capturedAt: "2026-09-26T08:50:36.000Z",
    }));
  });

  it("Research 不投影挂在当前主体下但身份属于其他 ASIN 的 Product Market 附件", async () => {
    const mismatched = sellerSpriteProductMarketAttachment({
      attachmentId: "attachment-ss-other-asin",
      subjectKey: "amazon:US:B0ZZZZZZZZ",
      asin: "B0ZZZZZZZZ",
    });
    wire([mismatched]);
    const { buildResearchInputBundle } = await import("@/lib/server/research/researchInputBundle");
    const result = await buildResearchInputBundle({
      context: { mode: "owner", token: "test-token" },
      taskId: "task-ss-1",
      recordDiagnostic: false,
    });
    const marketBundle = result as unknown as {
      providerProductMarketEvidence?: readonly Record<string, unknown>[];
    };

    expect(marketBundle.providerProductMarketEvidence).toBeUndefined();
    expect(result.sourceEvidenceRefs.find((ref) => ref.attachmentId === "attachment-ss-other-asin")?.subjectKey)
      .toBe("amazon:US:B0ZZZZZZZZ");
  });

  it("既有 Amazon 附件消费不回归：keyword/review/variation 仍正常产出且同时保留 provider 字段", async () => {
    const sourceReview = syntheticReviewAttachment();
    wire([
      sellerSpriteKeywordAttachment(),
      {
        ...sourceReview,
        attachmentId: "source-review-v3",
        subjectKey: fact.subjectKey,
        payload: { ...sourceReview.payload, subjectKey: fact.subjectKey, identity: { asin: "B000000001" } },
      },
      variationAttachment(),
      {
        attachmentId: "attachment-keyword-legacy-1",
        kind: "keyword_evidence",
        contentHash: "hash-keyword-1",
        capturedAt: "2026-09-21T00:01:00.000Z",
      },
    ]);
    const { buildResearchInputBundle } = await import("@/lib/server/research/researchInputBundle");
    const result = await buildResearchInputBundle({
      context: { mode: "owner", token: "test-token" },
      taskId: "task-ss-1",
      recordDiagnostic: false,
    });

    // 既有消费仍工作
    expect(result.keywordEvidence.length).toBeGreaterThan(0);
    expect(result.reviewEvidence.length).toBeGreaterThan(0);
    expect(result.variationEvidence).toBeTruthy();
    // provider 字段同时存在
    expect(result.providerMetricEvidence).toHaveLength(1);
  });

  it("附件身份不匹配（跨 subject）时 typed 字段不进入 bundle", async () => {
    const base = sellerSpriteKeywordAttachment();
    const payload = base.payload as unknown as Record<string, unknown>;
    const mismatched = {
      ...base,
      subjectKey: "amazon:US:B0ZZZZZZZZ",
      payload: { ...payload, subjectKey: "amazon:US:B0ZZZZZZZZ", identity: { asin: "B0ZZZZZZZZ" } },
    } as unknown as ReturnType<typeof sellerSpriteKeywordAttachment>;
    wire([mismatched]);
    const { buildResearchInputBundle } = await import("@/lib/server/research/researchInputBundle");
    const result = await buildResearchInputBundle({
      context: { mode: "owner", token: "test-token" },
      taskId: "task-ss-1",
      recordDiagnostic: false,
    });
    expect(result.providerMetricEvidence).toBeUndefined();
  });

  it("没有 typed provider 证据时该键整键缺省（不产出空壳）", async () => {
    wire([
      {
        attachmentId: "attachment-keyword-legacy-1",
        kind: "keyword_evidence",
        contentHash: "hash-keyword-1",
        capturedAt: "2026-09-21T00:01:00.000Z",
      },
    ]);
    const { buildResearchInputBundle } = await import("@/lib/server/research/researchInputBundle");
    const result = await buildResearchInputBundle({
      context: { mode: "owner", token: "test-token" },
      taskId: "task-ss-1",
      recordDiagnostic: false,
    });
    expect(result.providerMetricEvidence).toBeUndefined();
  });

  it("F-03：canonical customer_voice 已归一来源时，同一批 legacy/v3 review 不得重复进入 reviewEvidence", async () => {
    // legacy review_evidence 与 v3_review_voc_v1 含同一批 4 条评论（行级身份一致）；
    // canonical Observation 归一 v3 附件。修复后 reviewEvidence 必须为空。
    const rows = [1, 2, 3, 4].map((number) => ({
      asin: "B000000001",
      rating: number === 1 ? 5 : 4,
      reviewDate: `2026-09-0${number}T00:00:00.000Z`,
      reviewText: number === 1 ? "Synthetic fixture review text for adapter verification." : `Synthetic fixture review body ${number}.`,
      title: number === 1 ? "Synthetic sample title" : `Fixture review ${number}`,
      verifiedPurchase: true,
    }));
    const v3 = {
      attachmentId: "v3-review-f03",
      kind: "v3_review_voc_v1",
      subjectKey: fact.subjectKey,
      capturedAt: "2026-09-26T08:20:00.000Z",
      contentHash: "v".repeat(64),
      payload: buildV3ModuleEvidence({
        module: "review_voc",
        subjectKey: fact.subjectKey,
        marketplace: "US",
        capturedAt: "2026-09-26T08:20:00.000Z",
        provider: "amazon",
        sourceSurface: "synthetic_test_fixture",
        acquisitionMode: "DOM_DIRECT",
        metricNature: "source_observed",
        status: "VALIDATED_AVAILABLE",
        limitations: ["public_top_reviews_only"],
        identity: { asin: "B000000001" },
        data: { reviews: rows },
        evidenceOnly: true,
      }),
    };
    const legacy = {
      attachmentId: "legacy-review-1",
      kind: "review_evidence",
      subjectKey: fact.subjectKey,
      capturedAt: "2026-09-26T08:20:00.000Z",
      contentHash: "l".repeat(64),
      payload: { schema: "review-evidence.v1", asin: "B000000001", reviews: rows },
    };
    const normalizedReview = buildCustomerVoiceObservation({
      source: "amazon_review",
      subjectKey: fact.subjectKey,
      externalContentId: "normalized-review-f03",
      parentContentId: null,
      threadId: null,
      contentType: "review",
      authorRef: null,
      capturedAt: "2026-09-26T08:20:00.000Z",
      publishedAt: null,
      title: "Synthetic sample title",
      text: "Synthetic fixture review text for adapter verification.",
      rating: 5,
      verifiedPurchase: true,
      engagement: null,
      sourceUrl: null,
      evidenceRefs: ["attachment:v3-review-f03"],
      provenance: {
        provider: "amazon_dom",
        method: "capture_v3_amazon_review",
        accessBasis: "first_party_visible_page",
        sourceAttachmentId: "v3-review-f03",
        rawArtifactId: null,
        providerTermsVersion: null,
      },
      retentionPolicy: null,
      deletionRequired: false,
      externalDeletedAt: null,
      identityMatch: "EXACT",
      ownerExperience: null,
    });
    const voicePayload = buildCustomerVoiceAttachmentPayload({
      subjectKey: fact.subjectKey,
      observations: [normalizedReview],
    });
    wire([
      v3,
      legacy,
      {
        attachmentId: "customer-voice-f03",
        kind: "customer_voice_observation_v1",
        subjectKey: fact.subjectKey,
        capturedAt: "2026-09-26T08:21:00.000Z",
        contentHash: "c".repeat(64),
        payload: voicePayload,
      },
    ]);
    const { buildResearchInputBundle } = await import("@/lib/server/research/researchInputBundle");
    const result = await buildResearchInputBundle({
      context: { mode: "owner", token: "test-token" },
      taskId: "task-ss-1",
      recordDiagnostic: false,
    });
    expect(result.customerVoiceEvidence?.length ?? 0).toBeGreaterThan(0);
    expect(result.reviewEvidence).toEqual([]);
  });
});
