import { beforeEach, describe, expect, it, vi } from "vitest";

const larkMocks = vi.hoisted(() => ({
  listTableFields: vi.fn(),
  searchTableRecords: vi.fn(),
  batchCreateRecords: vi.fn(),
  batchUpdateRecords: vi.fn(),
}));

vi.mock("./baseClient", () => larkMocks);

import { parseProductConcept, type ProductConceptSnapshot } from "@/lib/marketOpportunity/concept";
import type { MarketOpportunityRecordView } from "@/lib/marketOpportunity/types";
import { syncProductProject, syncProductProjectForResearch } from "./productProjectSync";
import type { LarkConfig } from "./types";

const hash = "a".repeat(64);
const config: LarkConfig = {
  appId: "test-app",
  appSecret: "test-secret",
  appToken: "test-base",
  tableId: "legacy-product-project-test-table",
  openApiDomain: "https://open.feishu.cn",
};

function concept(overrides: Record<string, unknown> = {}): ProductConceptSnapshot {
  return parseProductConcept({
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
    model: "local-test-fixture",
    humanDecision: { status: "APPROVE", reason: "测试审批边界", decidedAt: "2026-09-27T01:00:00.000Z", revision: 1 },
    traceableItems: [],
    ...overrides,
  });
}

const legacyFields = [
  ["ConceptID", 1], ["OpportunityID", 1], ["Name", 1], ["Revision", 2],
  ["HumanDecision", 1], ["OpportunityURL", 1], ["MissingValidation", 1],
  ["FactRefs", 1], ["ResearchRefs", 1], ["ExportedAt", 1],
].map(([fieldName, type]) => ({ fieldId: `field-${fieldName}`, fieldName, type, uiType: "Text" }));

describe("legacy Product Project compatibility boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    larkMocks.listTableFields.mockResolvedValue(legacyFields);
    larkMocks.searchTableRecords.mockResolvedValue([]);
    larkMocks.batchCreateRecords.mockResolvedValue([{ record_id: "legacy-record-1", fields: {} }]);
    larkMocks.batchUpdateRecords.mockResolvedValue([]);
  });

  it("拒绝将 Research-bound 概念送入旧的 Opportunity 导出入口", async () => {
    const result = await syncProductProject({
      opportunity: { id: "opportunity-1" } as unknown as MarketOpportunityRecordView,
      concept: concept(),
      config,
    });

    expect(result.errorCode).toBe("PRODUCT_CONCEPT_SOURCE_MISMATCH");
    expect(larkMocks.listTableFields).not.toHaveBeenCalled();
    expect(larkMocks.searchTableRecords).not.toHaveBeenCalled();
    expect(larkMocks.batchCreateRecords).not.toHaveBeenCalled();
  });

  it("Research-bound 兼容导出保留旧表契约，不冒充 Opportunity 或写入六表字段", async () => {
    const result = await syncProductProjectForResearch({
      concept: concept(),
      researchTaskId: "task_research_1",
      researchTitle: "Research title",
      config,
    });

    expect(result.status).toBe("SYNCED");
    expect(result.tableId).toBe("legacy-product-project-test-table");
    expect(larkMocks.listTableFields).toHaveBeenCalledWith(config, undefined);
    expect(larkMocks.searchTableRecords).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ fieldNames: ["ConceptID"] }),
      undefined,
    );
    const payload = larkMocks.batchCreateRecords.mock.calls[0]?.[1]?.[0]?.fields as Record<string, unknown>;
    expect(payload).toMatchObject({ ConceptID: "pcv5_0123456789abcdef0123456789abcdef", OpportunityID: "" });
    expect(Object.keys(payload)).toEqual([
      "ConceptID", "OpportunityID", "Name", "Revision", "HumanDecision", "OpportunityURL",
      "MissingValidation", "FactRefs", "ResearchRefs", "ExportedAt",
    ]);
    expect(payload).not.toHaveProperty("ASIN");
    expect(payload).not.toHaveProperty("subjectKey");
  });
});
