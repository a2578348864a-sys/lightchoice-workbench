import { describe, expect, it } from "vitest";
import { parseProductConcept } from "@/lib/marketOpportunity/concept";

const hash = "a".repeat(64);

function v5Concept(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "product-concept.v1",
    status: "READY",
    conceptId: "pcv5_0123456789abcdef0123456789abcdef",
    opportunityId: null,
    sourceBinding: {
      sourceType: "research_v5",
      subjectKey: "amazon:US:B07G4VTV2F",
      researchTaskId: "task_research_1",
      researchRevision: 3,
      reportHash: hash,
      factHash: "b".repeat(64),
      evidenceHash: "c".repeat(64),
      generatedAt: "2026-09-27T00:00:00.000Z",
    },
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
    traceableItems: [{
      id: "pci_summary_1",
      kind: "research_summary",
      text: "The evidence supports a cautious opportunity.",
      nature: "derived",
      evidenceRefs: ["attachment:voice-1"],
      validationRequired: true,
    }],
    ...overrides,
  };
}

describe("Product Concept V5 compatibility contract", () => {
  it("accepts a Research-bound concept without inventing opportunityId", () => {
    const parsed = parseProductConcept(v5Concept());
    expect(parsed.opportunityId).toBeNull();
    expect(parsed.sourceBinding).toMatchObject({
      sourceType: "research_v5",
      researchTaskId: "task_research_1",
      researchRevision: 3,
      reportHash: hash,
    });
    expect(parsed.traceableItems?.[0]?.evidenceRefs).toEqual(["attachment:voice-1"]);
  });

  it("rejects recommendation items without evidence refs and malformed hashes", () => {
    expect(() => parseProductConcept(v5Concept({ traceableItems: [{
      id: "pci_no_ref",
      kind: "research_opportunity",
      text: "Unsupported assertion",
      nature: "recommendation",
      evidenceRefs: [],
      validationRequired: true,
    }] }))).toThrow();
    expect(() => parseProductConcept(v5Concept({ sourceBinding: {
      ...v5Concept().sourceBinding as object,
      reportHash: "not-a-hash",
    } }))).toThrow();
  });

  it("keeps existing V4 opportunity-bound concepts readable", () => {
    const legacy = v5Concept({
      opportunityId: "opportunity_legacy_1",
      sourceBinding: undefined,
      traceableItems: undefined,
    });
    const parsed = parseProductConcept(legacy);
    expect(parsed.opportunityId).toBe("opportunity_legacy_1");
    expect(parsed.sourceBinding).toBeUndefined();
  });

  it("preserves Feishu reviewer attribution as decision provenance", () => {
    const parsed = parseProductConcept(v5Concept({
      humanDecision: {
        status: "APPROVE",
        reason: "已完成证据核对。",
        decidedAt: "2026-09-28T12:00:00.000Z",
        revision: 1,
        source: {
          kind: "feishu_hub",
          baseId: "RXOabDkG0abBevsno43cSkTFnWb",
          recordId: "rec_decision_1",
          reviewerIdentity: "ou_reviewer_1",
          reviewedAt: "2026-09-28T12:00:00.000Z",
          packetHash: "d".repeat(64),
        },
      },
    }));
    expect(parsed.humanDecision.source).toMatchObject({
      kind: "feishu_hub",
      recordId: "rec_decision_1",
      reviewerIdentity: "ou_reviewer_1",
      packetHash: "d".repeat(64),
    });
  });
});
