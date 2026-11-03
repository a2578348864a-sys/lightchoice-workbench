import { describe, expect, it, vi } from "vitest";

import type { ResearchFactSnapshot } from "@/lib/research/researchContracts";
import type { ResearchInputBundle } from "@/lib/sourceLayer/v2/contracts";
import { FIXTURE_CONTENT_HASH, FIXTURE_CAPTURED_AT, makeProductFact } from "@/lib/marketScan/__fixtures__/productFactFixture";
import {
  buildV5ResearchPacket,
  ResearchPacketBuildError,
} from "./researchPacketBuilder";

vi.mock("@/lib/server/db", () => ({ prisma: {} }));

const proofRef = {
  refId: "evidence:" + productFact().sourceProof.evidenceId,
  kind: "product_evidence" as const,
  subjectKey: productFact().subjectKey,
  evidenceId: productFact().sourceProof.evidenceId,
  captureId: productFact().sourceProof.captureId,
  version: 1,
  contentHash: FIXTURE_CONTENT_HASH,
  capturedAt: FIXTURE_CAPTURED_AT,
};

function productFact() {
  const fact = makeProductFact({
    source: "sellersprite_xlsx",
    contentHash: FIXTURE_CONTENT_HASH,
    capturedAt: FIXTURE_CAPTURED_AT,
  });
  return {
    ...fact,
    sourceProof: {
      ...fact.sourceProof,
      entityBinding: {
        bound: true,
        expectedAsin: fact.basic.asin.value,
        observedAsin: fact.basic.asin.value,
        expectedMarketplace: "US",
        observedMarketplace: "US",
        urlAsin: fact.basic.asin.value,
        urlMarketplace: "US",
      },
    },
  };
}

function factField<T>(value: T | null) {
  return {
    value,
    status: value === null ? "missing" as const : "present" as const,
    source: "sellersprite_xlsx" as const,
    confidence: value === null ? 0 : 0.9,
    capturedAt: FIXTURE_CAPTURED_AT,
    rawProofHash: FIXTURE_CONTENT_HASH,
    evidenceRefs: [],
  };
}

function snapshot() {
  const fact = productFact();
  return {
    basic: {
      asin: factField(fact.basic.asin.value),
      title: factField(fact.basic.title.value),
      image: factField(fact.basic.image.value),
      brand: factField(fact.basic.brand.value),
      category: factField(fact.basic.category.value),
      price: factField(fact.basic.price.value),
      rating: factField(4.5),
      reviewCount: factField(120),
      bulletPoints: factField(["fixture point"]),
    },
    market: {
      bsr: factField(1500),
      monthlySalesEstimate: factField(300),
      monthlyRevenueEstimate: factField({ amount: 4997.5, currency: "USD" }),
      launchedDate: factField("2024-06-01"),
      subCategoryBsr: factField(null),
      dateFirstAvailable: factField(null),
      buyboxSeller: factField(null),
      fulfillmentType: factField(null),
      estimatedGrossMargin: factField(null),
      listingQualityScore: factField(null),
    },
    profit: {
      packageWeight: factField({ value: 0.5, unit: "kg" as const }),
      packageDimensions: factField({ length: 10, width: 8, height: 4, unit: "cm" as const }),
      fbaFee: factField(fact.profit.fbaFee.value),
      itemWeight: factField(null),
      itemDimensions: factField(null),
    },
    keywordEvidence: { topKeywords: factField([]) },
  } as ResearchFactSnapshot;
}

function bundle(overrides: Partial<ResearchInputBundle> = {}): ResearchInputBundle {
  const fact = productFact();
  return {
    schemaVersion: "research-input-bundle.v1",
    taskId: "task-1",
    candidateId: "candidate-1",
    subjectKey: fact.subjectKey,
    productFact: fact,
    sourceEvidenceRefs: [proofRef],
    keywordEvidence: [],
    reviewEvidence: [],
    customerVoiceEvidence: [],
    trendObservations: [],
    missingFields: [],
    conflicts: [],
    freshness: { latestCapturedAt: FIXTURE_CAPTURED_AT, ageDays: 0 },
    traceId: "trace-1",
    ...overrides,
  };
}

function build(overrides: Partial<Parameters<typeof buildV5ResearchPacket>[0]> = {}) {
  const fact = productFact();
  return buildV5ResearchPacket({
    productFact: fact,
    facts: snapshot(),
    researchInputBundle: bundle(),
    taskId: "task-1",
    revision: 1,
    marketplace: "US",
    generatedAt: "2026-09-28T00:00:00.000Z",
    ...overrides,
  });
}

describe("deterministic V5 Research Packet", () => {
  it("is stable across display timestamps and binds identity, fact, and Evidence hashes", () => {
    const first = build();
    const later = build({ generatedAt: "2026-09-29T00:00:00.000Z" });
    expect(first.packetHash).toBe(later.packetHash);
    expect(first.factHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.generatedAt).not.toBe(later.generatedAt);
  });

  it("changes the bound hashes when authoritative ProductFact content changes", () => {
    const original = build();
    const changed = productFact();
    const revisedFact = {
      ...changed,
      basic: {
        ...changed.basic,
        title: { ...changed.basic.title, value: "Revised authoritative title" },
      },
    };
    const revisedBundle = bundle({ productFact: revisedFact });
    const revisedPacket = build({ productFact: revisedFact, researchInputBundle: revisedBundle });

    expect(revisedPacket.factHash).not.toBe(original.factHash);
    expect(revisedPacket.packetHash).not.toBe(original.packetHash);
  });

  it("reuses deterministic economics and never treats missing costs as zero profit", () => {
    const packet = build();
    expect(packet.economics.price).toEqual({ amount: 19.99, currency: "USD" });
    expect(packet.economics.fbaFee).toEqual({ amount: 4.25, currency: "USD" });
    expect(packet.economics.netProfit).toBeNull();
    expect(packet.economics.landedCost).toBeNull();
    expect(packet.economics.metricNatureByField.netProfit).toBe("unknown");
  });

  it("fails closed when the canonical primary Evidence ref is absent or identity conflicts", () => {
    expect(() => build({ researchInputBundle: bundle({ sourceEvidenceRefs: [] }) }))
      .toThrowError(new ResearchPacketBuildError("PACKET_PRIMARY_EVIDENCE_REF_MISSING"));
    expect(() => build({ marketplace: "CA" }))
      .toThrowError(new ResearchPacketBuildError("PACKET_IDENTITY_MISMATCH"));
  });

  it("keeps VOC blocked until a versioned classification exists and excludes raw text", () => {
    const packet = build({ researchInputBundle: bundle({
      customerVoiceEvidence: [{
        attachmentId: "attachment-review-1",
        contentHash: FIXTURE_CONTENT_HASH,
        source: "amazon_review",
        observationCount: 1,
        omittedCount: 0,
        observations: [{
          refId: "attachment:attachment-review-1",
          externalContentId: "external-1",
          contentHash: FIXTURE_CONTENT_HASH,
          source: "amazon_review",
          evidenceRefs: ["attachment:attachment-review-1"],
          parentContentId: null,
          threadId: null,
          subreddit: null,
          depth: null,
          contentType: "review",
          title: null,
          text: "private raw review that must not be projected",
          rating: 1,
          verifiedPurchase: true,
          publishedAt: null,
          engagement: null,
          authorRef: null,
          provenance: {
            provider: "amazon_dom",
            method: "capture_v3_amazon_review",
            accessBasis: "first_party_visible_page",
            sourceAttachmentId: "attachment-review-1",
            rawArtifactId: null,
            providerTermsVersion: null,
          },
          identityMatch: "EXACT",
          ownerExperience: null,
        }],
      }],
    }) });
    expect(packet.vocSummary.status).toBe("BLOCKED_MISSING_INPUT");
    expect(packet.vocSummary.observationCount).toBe(1);
    expect(JSON.stringify(packet)).not.toContain("private raw review");
  });

  it("does not report risk PASS when no rule can be evaluated", () => {
    const empty = snapshot();
    const noRiskFacts = {
      ...empty,
      basic: { ...empty.basic, rating: factField(null), reviewCount: factField(null) },
      market: { ...empty.market, bsr: factField(null), monthlySalesEstimate: factField(null), monthlyRevenueEstimate: factField(null), estimatedGrossMargin: factField(null) },
      profit: { ...empty.profit, packageWeight: factField(null), packageDimensions: factField(null), fbaFee: factField(null) },
      timeSeries: undefined,
      variationAnalysis: undefined,
      concentration: undefined,
    } as ResearchFactSnapshot;
    const fact = productFact();
    const incompleteFact = { ...fact, profit: { ...fact.profit, fbaFee: { ...fact.profit.fbaFee, value: null, status: "missing" as const } } };
    const result = build({
      productFact: incompleteFact,
      facts: noRiskFacts,
      researchInputBundle: bundle({ productFact: incompleteFact }),
    });
    expect(result.riskCoverage.computableCount).toBe(0);
    expect(result.riskGate).toBe("UNAVAILABLE");
  });
});
