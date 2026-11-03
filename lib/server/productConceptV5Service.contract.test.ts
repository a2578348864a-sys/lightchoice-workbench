import { describe, expect, it } from "vitest";
import { parseProductConcept, type ProductConceptSourceBinding } from "@/lib/marketOpportunity/concept";
import {
  buildProductConceptV5FromResearchSnapshot,
  evaluateProductConceptCurrentGate,
  productConceptSourceBindingMatches,
} from "@/lib/server/productConceptV5Service";

const binding: ProductConceptSourceBinding = {
  sourceType: "research_v5",
  subjectKey: "amazon:US:B07G4VTV2F",
  researchTaskId: "research-task-1",
  researchRevision: 4,
  reportHash: "a".repeat(64),
  factHash: "b".repeat(64),
  evidenceHash: "c".repeat(64),
  generatedAt: "2026-09-27T00:00:00.000Z",
};

const concept = parseProductConcept({
  schemaVersion: "product-concept.v1",
  status: "READY",
  conceptId: "pcv5_test",
  opportunityId: null,
  sourceBinding: binding,
  revision: 1,
  generatedAt: "2026-09-27T00:00:00.000Z",
  targetCustomer: null,
  useCases: [],
  primaryPainPoints: [],
  recommendedSpecs: [],
  differentiation: [],
  targetPriceRange: { status: "MISSING", min: null, max: null, currency: null, refs: [] },
  targetCostRange: { status: "MISSING", min: null, max: null, currency: null, refs: [] },
  marginAssumptions: null,
  packagingDirection: [],
  supplierFeasibility: null,
  complianceRequirements: [],
  risks: [],
  missingValidation: [],
  factRefs: [],
  researchRefs: [],
  assumptions: [],
  confirmedFacts: [],
  derived: [],
  missing: [],
  aiSummary: null,
  model: "local-research-v5-adapter-v1",
  humanDecision: { status: "UNREVIEWED", reason: null, decidedAt: null, revision: 0 },
});

describe("Product Concept V5 stale binding gate", () => {
  it("maps only citation-bound Research VOC into pain points and use cases", () => {
    const voiceRef = "attachment:voice-1";
    const pain = "The cap leaked during a hike.";
    const useCase = "Used the bottle on long hikes.";
    const summary = "Buyers need a cap that stays leak-free on longer hikes.";
    const opportunity = "Offer a locking cap accessory.";
    const risk = "A replacement cap may not fit all existing variants.";
    const conceptSnapshot = buildProductConceptV5FromResearchSnapshot({
      taskId: binding.researchTaskId,
      subjectKey: binding.subjectKey,
      title: "Research title",
      report: {
        schema: "research-report.v5",
        summary,
        opportunities: [opportunity],
        risks: [risk],
        unverifiedAssumptions: [],
        allowedEvidenceRefs: [voiceRef],
        narrativeBindings: [
          { field: "summary", text: summary, evidenceRefs: [voiceRef] },
          { field: "opportunities[0]", text: opportunity, evidenceRefs: [voiceRef] },
          { field: "risks[0]", text: risk, evidenceRefs: [voiceRef] },
          { field: "vocAnalysis.painPoints[0]", text: pain, evidenceRefs: [voiceRef] },
          { field: "vocAnalysis.useCases[0]", text: useCase, evidenceRefs: [voiceRef] },
        ],
        vocAnalysis: {
          painPoints: [{ text: pain, evidenceRefs: [voiceRef] }],
          positiveSignals: [],
          failureModes: [{ text: "Unsupported failure", evidenceRefs: ["attachment:not-allowed"] }],
          useCases: [{ text: useCase, evidenceRefs: [voiceRef] }],
          replacementSignals: [],
          switchReasons: [],
          ownershipClaims: [],
        },
      },
      binding,
      packetHash: null,
      current: true,
      staleReason: null,
      productEvidenceId: "",
      productTitle: null,
    });

    expect(conceptSnapshot.primaryPainPoints).toEqual([pain]);
    expect(conceptSnapshot.useCases).toEqual([useCase]);
    expect(conceptSnapshot.factRefs).toEqual([]);
    expect(conceptSnapshot.recommendedSpecs).toEqual([]);
    expect(conceptSnapshot.differentiation).toEqual([]);
    expect(conceptSnapshot.researchRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: binding.researchTaskId, path: "report.summary" }),
      expect.objectContaining({ refId: binding.researchTaskId, path: "report.opportunities[0]" }),
      expect.objectContaining({ refId: binding.researchTaskId, path: "report.risks[0]" }),
      expect.objectContaining({ refId: binding.researchTaskId, path: "report.vocAnalysis.painPoints[0]" }),
      expect.objectContaining({ refId: binding.researchTaskId, path: "report.vocAnalysis.useCases[0]" }),
    ]));
    expect(conceptSnapshot.traceableItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "research_voc_pain", text: pain, evidenceRefs: [voiceRef], validationRequired: true }),
      expect.objectContaining({ kind: "research_voc_use_case", text: useCase, evidenceRefs: [voiceRef], validationRequired: true }),
    ]));
    expect(conceptSnapshot.traceableItems?.some((item) => item.text === "Unsupported failure")).toBe(false);
  });

  it("accepts only the same Research task, revision, report, fact and evidence hashes", () => {
    expect(productConceptSourceBindingMatches(concept, binding)).toBe(true);
    expect(productConceptSourceBindingMatches(concept, { ...binding, researchRevision: 5 })).toBe(false);
    expect(productConceptSourceBindingMatches(concept, { ...binding, reportHash: "d".repeat(64) })).toBe(false);
    expect(productConceptSourceBindingMatches(concept, { ...binding, factHash: "d".repeat(64) })).toBe(false);
    expect(productConceptSourceBindingMatches(concept, { ...binding, evidenceHash: "d".repeat(64) })).toBe(false);
    expect(productConceptSourceBindingMatches(concept, { ...binding, researchTaskId: "another-task" })).toBe(false);
  });

  it("invalidates an old APPROVE after Research changes and allows only a current approval to sync", () => {
    const approved = parseProductConcept({
      ...concept,
      humanDecision: { status: "APPROVE", reason: "Reviewed", decidedAt: "2026-09-27T00:00:00.000Z", revision: 1 },
    });
    expect(evaluateProductConceptCurrentGate({ concept: approved, currentBinding: binding, researchCurrent: true })).toMatchObject({
      stale: false,
      approvalCurrent: true,
      canSync: true,
    });
    const nextResearch = { ...binding, researchRevision: 5, reportHash: "d".repeat(64) };
    expect(evaluateProductConceptCurrentGate({ concept: approved, currentBinding: nextResearch, researchCurrent: true })).toMatchObject({
      stale: true,
      approvalCurrent: false,
      canSync: false,
    });
    expect(evaluateProductConceptCurrentGate({ concept: approved, currentBinding: binding, researchCurrent: false }).canSync).toBe(false);
  });

  it.each(["UNREVIEWED", "VALIDATE_MORE", "PAUSE", "DROP"] as const)("blocks Product Project sync for %s", (status) => {
    const gateConcept = parseProductConcept({
      ...concept,
      humanDecision: status === "UNREVIEWED"
        ? { status, reason: null, decidedAt: null, revision: 0 }
        : { status, reason: "Not approved for sync.", decidedAt: "2026-09-27T00:00:00.000Z", revision: 1 },
    });
    expect(evaluateProductConceptCurrentGate({ concept: gateConcept, currentBinding: binding, researchCurrent: true })).toMatchObject({
      stale: false,
      approvalCurrent: false,
      canSync: false,
    });
  });
});
