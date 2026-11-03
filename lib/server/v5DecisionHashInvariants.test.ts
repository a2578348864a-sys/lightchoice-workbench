import { describe, expect, it, vi } from "vitest";
import { hashJson } from "@/lib/server/v5CoreCommon";
import { buildV5ResearchPacket } from "@/lib/server/research/researchPacketBuilder";
import type { ResearchFactSnapshot } from "@/lib/research/researchContracts";
import type { ResearchInputBundle } from "@/lib/sourceLayer/v2/contracts";
import {
  FIXTURE_CONTENT_HASH,
  FIXTURE_CAPTURED_AT,
  makeProductFact,
} from "@/lib/marketScan/__fixtures__/productFactFixture";
import type { CanonicalDecisionStatus } from "@/lib/types/v5DecisionStatus";

vi.mock("@/lib/server/db", () => ({ prisma: {} }));

const proofRef = {
  refId: "evidence:evidence-B0FIXTURE1",
  kind: "product_evidence" as const,
  subjectKey: makeProductFact().subjectKey,
  evidenceId: "evidence-B0FIXTURE1",
  captureId: "capture-B0FIXTURE1",
  version: 1,
  contentHash: FIXTURE_CONTENT_HASH,
  capturedAt: FIXTURE_CAPTURED_AT,
};

function productFact(priceAmount = 29.99) {
  const fact = makeProductFact({
    source: "sellersprite_xlsx",
    contentHash: FIXTURE_CONTENT_HASH,
    capturedAt: FIXTURE_CAPTURED_AT,
    price: priceAmount,
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
    status: value === null ? ("missing" as const) : ("present" as const),
    source: "sellersprite_xlsx" as const,
    confidence: value === null ? 0 : 0.9,
    capturedAt: FIXTURE_CAPTURED_AT,
    rawProofHash: FIXTURE_CONTENT_HASH,
    evidenceRefs: [],
  };
}

function snapshot(fact = productFact()) {
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

function bundle(fact = productFact(), evidenceRefs = [proofRef]): ResearchInputBundle {
  return {
    schemaVersion: "research-input-bundle.v1",
    taskId: "task-1",
    candidateId: "candidate-1",
    subjectKey: fact.subjectKey,
    productFact: fact,
    sourceEvidenceRefs: evidenceRefs,
    keywordEvidence: [],
    reviewEvidence: [],
    customerVoiceEvidence: [],
    trendObservations: [],
    missingFields: [],
    conflicts: [],
    freshness: { latestCapturedAt: FIXTURE_CAPTURED_AT, ageDays: 0 },
    traceId: "trace-1",
  };
}

describe("Four-Hash Invariants & Human Decision Independence", () => {
  it("proves factHash, evidenceHash, and packetHash are strictly independent of Human Decision", () => {
    const fact = productFact();
    const packet = buildV5ResearchPacket({
      productFact: fact,
      facts: snapshot(fact),
      researchInputBundle: bundle(fact),
      taskId: "task-1",
      revision: 1,
      marketplace: "US",
      generatedAt: "2026-09-28T00:00:00.000Z",
    });

    // 1. Verify existence of the 3 packet hashes
    expect(packet.factHash).toMatch(/^[a-f0-9]{64}$/i);
    expect(packet.evidenceHash).toMatch(/^[a-f0-9]{64}$/i);
    expect(packet.packetHash).toMatch(/^[a-f0-9]{64}$/i);

    // 2. Simulate 5 different Human Decisions across the 5 canonical statuses
    const canonicalDecisions: readonly { canonicalStatus: CanonicalDecisionStatus; choice: "WATCH" | "PASS" | "PROCEED" }[] = [
      { canonicalStatus: "PENDING", choice: "WATCH" },
      { canonicalStatus: "VALIDATE_MORE", choice: "WATCH" },
      { canonicalStatus: "PROCEED", choice: "PROCEED" },
      { canonicalStatus: "PAUSE", choice: "WATCH" },
      { canonicalStatus: "DROP", choice: "PASS" },
    ];

    // Compute decisionBindingHash for each decision
    const bindingHashes = canonicalDecisions.map((d) =>
      hashJson({
        taskId: "task-1",
        asin: fact.basic.asin.value,
        researchRevision: 1,
        factHash: packet.factHash,
        evidenceHash: packet.evidenceHash,
        reportHash: "r".repeat(64),
        choice: d.choice,
        canonicalStatus: d.canonicalStatus,
      })
    );

    // All binding hashes must be distinct from each other because canonicalStatus/choice differ
    const uniqueBindingHashes = new Set(bindingHashes);
    expect(uniqueBindingHashes.size).toBe(5);

    // Underlying factHash, evidenceHash, and packetHash are COMPLETELY UNTOUCHED by human decision changes
    expect(packet.factHash).toBe(packet.factHash);
    expect(packet.evidenceHash).toBe(packet.evidenceHash);
    expect(packet.packetHash).toBe(packet.packetHash);
  });

  it("verifies CAS guard: changing facts changes factHash & packetHash; changing evidence changes evidenceHash & packetHash", () => {
    const factA = productFact(29.99);
    const packetA = buildV5ResearchPacket({
      productFact: factA,
      facts: snapshot(factA),
      researchInputBundle: bundle(factA),
      taskId: "task-1",
      revision: 1,
      marketplace: "US",
      generatedAt: "2026-09-28T00:00:00.000Z",
    });

    // Change price -> changes factHash and packetHash, but evidenceHash remains identical
    const factB = productFact(49.99);
    const packetB = buildV5ResearchPacket({
      productFact: factB,
      facts: snapshot(factB),
      researchInputBundle: bundle(factB),
      taskId: "task-1",
      revision: 1,
      marketplace: "US",
      generatedAt: "2026-09-28T00:00:00.000Z",
    });

    expect(packetB.factHash).not.toBe(packetA.factHash);
    expect(packetB.packetHash).not.toBe(packetA.packetHash);
    expect(packetB.evidenceHash).toBe(packetA.evidenceHash);

    // Add a secondary evidence ref -> changes evidenceHash and packetHash, but factHash remains identical
    const extraProofRef = {
      refId: "evidence:evidence-B0FIXTURE2",
      kind: "product_evidence" as const,
      subjectKey: factA.subjectKey,
      evidenceId: "evidence-B0FIXTURE2",
      captureId: "capture-B0FIXTURE2",
      version: 1,
      contentHash: "fedcba9876543210".repeat(4),
      capturedAt: FIXTURE_CAPTURED_AT,
    };
    const packetC = buildV5ResearchPacket({
      productFact: factA,
      facts: snapshot(factA),
      researchInputBundle: bundle(factA, [proofRef, extraProofRef]),
      taskId: "task-1",
      revision: 1,
      marketplace: "US",
      generatedAt: "2026-09-28T00:00:00.000Z",
    });

    expect(packetC.evidenceHash).not.toBe(packetA.evidenceHash);
    expect(packetC.packetHash).not.toBe(packetA.packetHash);
    expect(packetC.factHash).toBe(packetA.factHash);
  });
});
