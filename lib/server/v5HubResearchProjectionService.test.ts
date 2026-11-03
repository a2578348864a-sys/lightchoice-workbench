import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditResearchClaims, makeUnavailableClaimAudit } from "@/lib/research/evidenceAudit";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  getLarkConfig: vi.fn(),
  buildResearchInputBundle: vi.fn(),
  buildV5ResearchPacket: vi.fn(),
  buildResearchFactSnapshot: vi.fn(),
  mapResearchPacketToV5HubFields: vi.fn(),
  mapProductFactToV5HubFields: vi.fn(),
  mapProductConceptToV5HubFields: vi.fn(),
  projectV5HubRecord: vi.fn(),
  getResearchDetail: vi.fn(),
}));
vi.mock("@/lib/server/v5ResearchService", () => ({ getResearchDetail: mocks.getResearchDetail }));

vi.mock("@/lib/server/db", () => ({
  prisma: {
    viralAnalysisRecord: {
      findUnique: mocks.findUnique,
      updateMany: mocks.updateMany,
    },
  },
}));
vi.mock("@/lib/integrations/lark/config", () => ({ getLarkConfig: mocks.getLarkConfig }));
vi.mock("@/lib/server/research/researchInputBundle", () => ({ buildResearchInputBundle: mocks.buildResearchInputBundle }));
vi.mock("@/lib/server/research/researchPacketBuilder", () => ({ buildV5ResearchPacket: mocks.buildV5ResearchPacket }));
vi.mock("@/lib/server/research/researchEngine", () => ({ buildResearchFactSnapshot: mocks.buildResearchFactSnapshot }));
vi.mock("@/lib/integrations/lark/v5HubProjection", () => ({
  mapResearchPacketToV5HubFields: mocks.mapResearchPacketToV5HubFields,
  mapProductFactToV5HubFields: mocks.mapProductFactToV5HubFields,
  mapProductConceptToV5HubFields: mocks.mapProductConceptToV5HubFields,
}));
vi.mock("@/lib/marketOpportunity/concept", () => ({ parseProductConcept: (value: unknown) => value }));
vi.mock("@/lib/integrations/lark/v5HubProjectionService", () => ({
  projectV5HubRecord: mocks.projectV5HubRecord,
  v5HubLogicalKey: (_tableId: string, fields: Record<string, unknown>) => JSON.stringify(fields),
}));
vi.mock("@/lib/server/v5CoreCommon", () => ({
  hashJson: (value: unknown) => JSON.stringify(value),
  requireOwnerContext: (context: { mode: string }) => { if (context.mode !== "owner") throw new Error("OWNER_REQUIRED"); },
  V5CoreError: class extends Error {
    constructor(public readonly code: string, message: string, public readonly status: number) { super(message); }
  },
  withV5Receipt: async (input: { execute: () => Promise<unknown> }) => ({ value: await input.execute(), replayed: false }),
}));

import { projectProductConceptToV5Hub, projectResearchTaskToV5Hub } from "./v5HubResearchProjectionService";

const context = { mode: "owner", token: "" } as const;
const config = { appId: "app", appSecret: "secret", appToken: "RXOabDkG0abBevsno43cSkTFnWb", tableId: "legacy", openApiDomain: "https://open.feishu.cn" };
const productFact = { subjectKey: "amazon:US:B000000001" };
const evidenceRefs = [{ refId: "evidence:ev-1", contentHash: "evidence-hash", evidenceId: "ev-1" }];
const bundle = { taskId: "task-1", subjectKey: productFact.subjectKey, productFact, sourceEvidenceRefs: evidenceRefs };
const report = { schema: "research-report.v5", summary: "test" };
const packet = { subjectKey: productFact.subjectKey, packetHash: "packet-hash", packetStatus: "READY" };
const state = {
  researchRevision: 4,
  report,
  reportHash: JSON.stringify(report),
  factHash: JSON.stringify(productFact),
  evidenceHash: JSON.stringify(evidenceRefs),
  marketplace: "US",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getResearchDetail.mockReset();
  mocks.getResearchDetail.mockResolvedValue({ stale: false, researchRevision: state.researchRevision, reportHash: state.reportHash,
    factHash: state.factHash, evidenceHash: state.evidenceHash,
    claimAudit: auditResearchClaims({ summary: null, opportunities: [], risks: [], painPoints: [], salesGrade: "NOT_AVAILABLE", reviewBase: null }) });
  mocks.findUnique.mockResolvedValue({ id: "task-1", type: "workflow", resultJson: JSON.stringify({ v5Research: state, facts: { asin: "B000000001" } }) });
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.getLarkConfig.mockReturnValue({ ok: true, config });
  mocks.buildResearchInputBundle.mockResolvedValue(bundle);
  mocks.buildV5ResearchPacket.mockReturnValue(packet);
  mocks.buildResearchFactSnapshot.mockReturnValue({ basic: { asin: { value: "B000000001" } } });
  mocks.mapResearchPacketToV5HubFields.mockReturnValue({ "研究包哈希": packet.packetHash });
  mocks.mapProductFactToV5HubFields.mockReturnValue({ "主体键": productFact.subjectKey });
  mocks.projectV5HubRecord
    .mockResolvedValueOnce({ status: "CREATED", recordId: "rec-packet" })
    .mockResolvedValueOnce({ status: "CREATED", recordId: "rec-product" });
});

describe("Research-to-Hub projection orchestration", () => {
  it.each([
    { name: "审查不可用", claimAudit: makeUnavailableClaimAudit() },
    { name: "阻断结论", claimAudit: auditResearchClaims({ summary: null, opportunities: ["购买量600件，已有稳定动销，是机会点。"], risks: [], painPoints: [], salesGrade: "ESTIMATED", reviewBase: null }) },
    { name: "待降级", claimAudit: auditResearchClaims({ summary: null, opportunities: [], risks: ["多位买家反馈尺寸过小"], painPoints: [], salesGrade: "NOT_AVAILABLE", reviewBase: null }) },
  ])("$name不组包也不外发", async ({ claimAudit }) => {
    mocks.getResearchDetail.mockResolvedValue({ stale: false, researchRevision: state.researchRevision, reportHash: state.reportHash,
      factHash: state.factHash, evidenceHash: state.evidenceHash, claimAudit });
    await expect(projectResearchTaskToV5Hub({ context, taskId: "task-1", expectedRevision: 4, expectedReportHash: state.reportHash,
      expectedFactHash: state.factHash, expectedEvidenceHash: state.evidenceHash, idempotencyKey: "claim-reject" })).rejects.toMatchObject({ status: 409 });
    expect(mocks.buildV5ResearchPacket).not.toHaveBeenCalled();
    expect(mocks.projectV5HubRecord).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("组包后审查变为不可用时仍在第一个远端调用前拒绝", async () => {
    const good = await mocks.getResearchDetail();
    mocks.getResearchDetail.mockReset().mockResolvedValueOnce(good).mockResolvedValue({ ...good, claimAudit: makeUnavailableClaimAudit() });
    await expect(projectResearchTaskToV5Hub({ context, taskId: "task-1", expectedRevision: 4, expectedReportHash: state.reportHash,
      expectedFactHash: state.factHash, expectedEvidenceHash: state.evidenceHash, idempotencyKey: "claim-race" })).rejects.toMatchObject({ status: 409 });
    expect(mocks.buildV5ResearchPacket).toHaveBeenCalledOnce();
    expect(mocks.projectV5HubRecord).not.toHaveBeenCalled();
  });
  it("derives fields server-side, checks version/hash bindings, and projects Packet before ProductFact", async () => {
    const result = await projectResearchTaskToV5Hub({
      context, taskId: "task-1", expectedRevision: 4,
      expectedReportHash: state.reportHash, expectedFactHash: state.factHash,
      expectedEvidenceHash: state.evidenceHash, idempotencyKey: "hub-sync-1",
    });

    expect(result.packetHash).toBe(packet.packetHash);
    expect(result.packetProjection.status).toBe("CREATED");
    expect(result.productProjection.status).toBe("CREATED");
    expect(result.binding.reportHash).toBe(state.reportHash);
    expect(mocks.buildResearchFactSnapshot).toHaveBeenCalledWith(productFact);
    expect(mocks.buildResearchInputBundle).toHaveBeenCalledWith({ context, taskId: "task-1", recordDiagnostic: false });
    expect(mocks.projectV5HubRecord.mock.calls.map((call) => call[0].tableId)).toEqual(["T02", "T01"]);
    expect(mocks.mapProductFactToV5HubFields).toHaveBeenCalledWith(expect.objectContaining({ productFact }));
  });

  it("a report changed during remote projection cannot persist an old local binding", async () => {
    mocks.findUnique.mockResolvedValueOnce({ id: "task-1", type: "workflow", resultJson: JSON.stringify({ v5Research: state, facts: {} }) });
    mocks.findUnique.mockResolvedValueOnce({ id: "task-1", updatedAt: new Date(), resultJson: JSON.stringify({ v5Research: { ...state, reportHash: "changed-during-projection" }, facts: {} }) });
    await expect(projectResearchTaskToV5Hub({ context, taskId: "task-1", expectedRevision: 4, expectedReportHash: state.reportHash,
      expectedFactHash: state.factHash, expectedEvidenceHash: state.evidenceHash, idempotencyKey: "hub-sync-race" })).rejects.toMatchObject({ code: "FEISHU_PACKET_BINDING_CAS_CONFLICT", status: 409 });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("rejects stale Research before assembling inputs or calling any Feishu projection", async () => {
    await expect(projectResearchTaskToV5Hub({
      context, taskId: "task-1", expectedRevision: 3,
      expectedReportHash: state.reportHash, expectedFactHash: state.factHash,
      expectedEvidenceHash: state.evidenceHash, idempotencyKey: "hub-sync-stale",
    })).rejects.toMatchObject({ code: "RESEARCH_REVISION_STALE", status: 409 });
    expect(mocks.buildResearchInputBundle).not.toHaveBeenCalled();
    expect(mocks.projectV5HubRecord).not.toHaveBeenCalled();
  });

  it("does not project under Visitor context", async () => {
    await expect(projectResearchTaskToV5Hub({
      context: { mode: "demo" } as never, taskId: "task-1", expectedRevision: 4,
      expectedReportHash: state.reportHash, expectedFactHash: state.factHash,
      expectedEvidenceHash: state.evidenceHash, idempotencyKey: "hub-sync-visitor",
    })).rejects.toThrow("OWNER_REQUIRED");
    expect(mocks.projectV5HubRecord).not.toHaveBeenCalled();
  });

  it("projects only a concept whose source binding matches the exact current Packet inputs", async () => {
    const concept = {
      schemaVersion: "product-concept.v1",
      status: "READY",
      conceptId: "pcv5-1",
      opportunityId: null,
      revision: 2,
      sourceBinding: {
        sourceType: "research_v5",
        subjectKey: productFact.subjectKey,
        researchTaskId: "task-1",
        researchRevision: 4,
        reportHash: state.reportHash,
        factHash: state.factHash,
        evidenceHash: state.evidenceHash,
        generatedAt: "2026-09-28T00:00:00.000Z",
      },
    };
    const task = {
      id: "task-1", type: "workflow",
      resultJson: JSON.stringify({ v5Research: state, facts: { asin: "B000000001" }, productConceptV5: { concept } }),
    };
    mocks.findUnique.mockResolvedValue(task);
    mocks.projectV5HubRecord.mockResolvedValueOnce({ status: "CREATED", recordId: "rec-concept" });
    mocks.mapProductConceptToV5HubFields.mockReturnValue({ "概念 ID": "pcv5-1" });

    const result = await projectProductConceptToV5Hub({
      context, taskId: "task-1", expectedRevision: 4,
      expectedReportHash: state.reportHash, expectedFactHash: state.factHash,
      expectedEvidenceHash: state.evidenceHash, idempotencyKey: "hub-concept-1",
    });

    expect(result.conceptProjection.status).toBe("CREATED");
    expect(mocks.mapProductConceptToV5HubFields).toHaveBeenCalledWith(expect.objectContaining({
      concept,
      taskId: "task-1",
      currentBinding: expect.objectContaining({
        subjectKey: productFact.subjectKey,
        researchRevision: 4,
        reportHash: state.reportHash,
        factHash: state.factHash,
        evidenceHash: state.evidenceHash,
      }),
      expectedPacketHash: packet.packetHash,
    }));
    expect(mocks.projectV5HubRecord.mock.calls.map((call) => call[0].tableId)).toEqual(["T02", "T01", "T05"]);
  });

  it("rejects a missing ProductConcept before projecting any Research rows", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "task-1", type: "workflow",
      resultJson: JSON.stringify({ v5Research: state, facts: { asin: "B000000001" } }),
    });

    await expect(projectProductConceptToV5Hub({
      context, taskId: "task-1", expectedRevision: 4,
      expectedReportHash: state.reportHash, expectedFactHash: state.factHash,
      expectedEvidenceHash: state.evidenceHash, idempotencyKey: "hub-concept-missing",
    })).rejects.toMatchObject({ code: "PRODUCT_CONCEPT_REQUIRED", status: 409 });

    expect(mocks.projectV5HubRecord).not.toHaveBeenCalled();
  });

  it("rejects a ProductConcept with a stale source binding before projecting Research rows", async () => {
    const staleConcept = {
      schemaVersion: "product-concept.v1",
      status: "READY",
      conceptId: "pcv5-stale",
      opportunityId: null,
      revision: 2,
      sourceBinding: {
        sourceType: "research_v5",
        subjectKey: productFact.subjectKey,
        researchTaskId: "task-1",
        researchRevision: 3,
        reportHash: state.reportHash,
        factHash: state.factHash,
        evidenceHash: state.evidenceHash,
        generatedAt: "2026-09-28T00:00:00.000Z",
      },
    };
    const researchTask = {
      id: "task-1", type: "workflow",
      resultJson: JSON.stringify({ v5Research: state, facts: { asin: "B000000001" } }),
    };
    mocks.findUnique
      .mockResolvedValueOnce({ ...researchTask, resultJson: JSON.stringify({
        v5Research: state, facts: { asin: "B000000001" }, productConceptV5: { concept: staleConcept },
      }) })
      .mockResolvedValueOnce(researchTask)
      .mockResolvedValueOnce({ ...researchTask, resultJson: JSON.stringify({
        v5Research: state, facts: { asin: "B000000001" }, productConceptV5: { concept: staleConcept },
      }) });
    mocks.mapProductConceptToV5HubFields.mockImplementation(() => {
      throw new Error("V5_HUB_CONCEPT_SOURCE_BINDING_INVALID");
    });

    await expect(projectProductConceptToV5Hub({
      context, taskId: "task-1", expectedRevision: 4,
      expectedReportHash: state.reportHash, expectedFactHash: state.factHash,
      expectedEvidenceHash: state.evidenceHash, idempotencyKey: "hub-concept-stale-binding",
    })).rejects.toThrow("V5_HUB_CONCEPT_SOURCE_BINDING_INVALID");

    expect(mocks.projectV5HubRecord).not.toHaveBeenCalled();
  });

  it("fails closed with FEISHU_PACKET_BINDING_CAS_CONFLICT when local binding updateMany count is 0", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(projectResearchTaskToV5Hub({
      context, taskId: "task-1", expectedRevision: 4,
      expectedReportHash: state.reportHash, expectedFactHash: state.factHash,
      expectedEvidenceHash: state.evidenceHash, idempotencyKey: "hub-sync-conflict",
    })).rejects.toMatchObject({ code: "FEISHU_PACKET_BINDING_CAS_CONFLICT", status: 409 });
  });
});
