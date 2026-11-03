import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  compensateV5HubDecisionPullReceipt,
  type CompensatingItemRecord,
} from "./v5HubDecisionPullService";
import { prisma } from "./db";
import { V5CoreError } from "./v5CoreCommon";
import * as baseClient from "@/lib/integrations/lark/baseClient";

vi.mock("./db", () => ({
  prisma: {
    v5OperationReceipt: {
      findUnique: vi.fn(),
    },
    viralAnalysisRecord: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/integrations/lark/config", () => ({
  getLarkConfig: vi.fn().mockReturnValue({
    ok: true,
    config: {
      appId: "appId",
      appSecret: "appSecret",
      appToken: "RXOabDkG0abBevsno43cSkTFnWb",
      tableId: "tblMock",
      openApiDomain: "https://open.feishu.cn",
    },
  }),
}));

vi.mock("@/lib/integrations/lark/baseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/lark/baseClient")>();
  return {
    ...actual,
    searchTableRecords: vi.fn(),
    batchUpdateRecords: vi.fn().mockResolvedValue({}),
  };
});

describe("compensateV5HubDecisionPullReceipt", () => {
  const mockContext = {
    token: "mock-token-123",
    authSource: "password" as const,
    tokenIssuedAt: Date.now(),
    mode: "owner" as const,
  };

  const sampleItem: CompensatingItemRecord = {
    taskId: "task-001",
    beforeLocalState: {
      decisionStatus: "need_info",
      resultJson: JSON.stringify({ v5Research: { state: "prior", myChoice: { canonicalStatus: "VALIDATE_MORE", choice: "WATCH" } } }),
    },
    afterLocalState: {
      decisionStatus: "continue",
      canonicalStatus: "PROCEED",
      choice: "PROCEED",
    },
    beforeT01State: {
      recordId: "recT01-001",
      decisionStatus: "PAUSED",
    },
    afterT01State: {
      recordId: "recT01-001",
      decisionStatus: "PROCEED",
    },
    t02RecordId: "recT02-001",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Case A: current local == afterLocalState and current T01 == afterT01State -> compensation PASS", async () => {
    vi.mocked(prisma.v5OperationReceipt.findUnique).mockResolvedValueOnce({
      id: "receipt-123",
      responseJson: JSON.stringify({
        appliedItems: [sampleItem],
        appliedConceptRecordIds: [],
      }),
    } as any);

    // Mock local current task matching afterLocalState exactly
    vi.mocked(prisma.viralAnalysisRecord.findUnique).mockResolvedValue({
      id: "task-001",
      type: "workflow",
      decisionStatus: "continue",
      resultJson: JSON.stringify({
        v5Research: {
          myChoice: {
            canonicalStatus: "PROCEED",
            choice: "PROCEED",
          },
        },
      }),
      updatedAt: new Date(),
    } as any);

    // Mock T01 mirror current status matching afterT01State exactly
    vi.mocked(baseClient.searchTableRecords).mockResolvedValueOnce([
      {
        record_id: "recT01-001",
        fields: { "主体键": "amazon:US:B07G4VTV2F", "决策状态": "PROCEED" },
      },
    ]);

    // Mock successful CAS updateMany
    vi.mocked(prisma.viralAnalysisRecord.updateMany).mockResolvedValueOnce({ count: 1 });

    const result = await compensateV5HubDecisionPullReceipt({
      context: mockContext,
      receiptId: "receipt-123",
    });

    expect(result.compensated).toBe(true);
    expect(result.recordsRestored).toBe(1);
    expect(result.t01MirrorsRestored).toBe(1);

    // Assert updateMany was called with CAS condition matching afterLocalState & prechecked snapshot
    expect(prisma.viralAnalysisRecord.updateMany).toHaveBeenCalledWith({
      where: {
        id: "task-001",
        decisionStatus: "continue",
        updatedAt: expect.any(Date),
        resultJson: expect.any(String),
      },
      data: expect.objectContaining({
        decisionStatus: "need_info",
        resultJson: sampleItem.beforeLocalState!.resultJson,
      }),
    });

    // Assert T01 was restored to exact beforeT01State (PAUSED, not blanket PENDING)
    expect(baseClient.batchUpdateRecords).toHaveBeenCalledWith(
      expect.anything(),
      [{ record_id: "recT01-001", fields: { "决策状态": "PAUSED" } }],
    );
  });

  it("Case B: current local != afterLocalState -> fails with COMPENSATION_STATE_DIVERGED (zero writes)", async () => {
    vi.mocked(prisma.v5OperationReceipt.findUnique).mockResolvedValue({
      id: "receipt-diverged-local",
      responseJson: JSON.stringify({
        appliedItems: [sampleItem],
        appliedConceptRecordIds: [],
      }),
    } as any);

    // User made a newer decision (e.g. PAUSE) after the pull!
    vi.mocked(prisma.viralAnalysisRecord.findUnique).mockResolvedValue({
      id: "task-001",
      type: "workflow",
      decisionStatus: "need_info", // diverged from "continue"
      resultJson: JSON.stringify({
        v5Research: {
          myChoice: {
            canonicalStatus: "PAUSE", // diverged from "PROCEED"
            choice: "WATCH",
          },
        },
      }),
      updatedAt: new Date(),
    } as any);

    await expect(
      compensateV5HubDecisionPullReceipt({
        context: mockContext,
        receiptId: "receipt-diverged-local",
      }),
    ).rejects.toThrowError(V5CoreError);

    try {
      await compensateV5HubDecisionPullReceipt({
        context: mockContext,
        receiptId: "receipt-diverged-local",
      });
    } catch (err: any) {
      expect(err.code).toBe("COMPENSATION_STATE_DIVERGED");
    }

    // Zero writes
    expect(prisma.viralAnalysisRecord.updateMany).not.toHaveBeenCalled();
    expect(baseClient.batchUpdateRecords).not.toHaveBeenCalled();
  });

  it("Case C: local matches but T01 current != afterT01State -> fails with T01_COMPENSATION_STATE_DIVERGED (zero writes)", async () => {
    vi.mocked(prisma.v5OperationReceipt.findUnique).mockResolvedValue({
      id: "receipt-diverged-t01",
      responseJson: JSON.stringify({
        appliedItems: [sampleItem],
        appliedConceptRecordIds: [],
      }),
    } as any);

    // Local matches
    vi.mocked(prisma.viralAnalysisRecord.findUnique).mockResolvedValue({
      id: "task-001",
      decisionStatus: "continue",
      resultJson: JSON.stringify({
        v5Research: {
          myChoice: {
            canonicalStatus: "PROCEED",
            choice: "PROCEED",
          },
        },
      }),
      updatedAt: new Date(),
    } as any);

    // T01 in Feishu was altered externally to REJECTED (diverged from afterT01State "PROCEED")
    vi.mocked(baseClient.searchTableRecords).mockResolvedValue([
      {
        record_id: "recT01-001",
        fields: { "主体键": "amazon:US:B07G4VTV2F", "决策状态": "REJECTED" },
      },
    ]);

    await expect(
      compensateV5HubDecisionPullReceipt({
        context: mockContext,
        receiptId: "receipt-diverged-t01",
      }),
    ).rejects.toThrowError(V5CoreError);

    try {
      await compensateV5HubDecisionPullReceipt({
        context: mockContext,
        receiptId: "receipt-diverged-t01",
      });
    } catch (err: any) {
      expect(err.code).toBe("T01_COMPENSATION_STATE_DIVERGED");
    }

    // Crucial: Precheck all targets prevented ANY local or T01 writes!
    expect(prisma.viralAnalysisRecord.updateMany).not.toHaveBeenCalled();
    expect(baseClient.batchUpdateRecords).not.toHaveBeenCalled();
  });

  it("Case D: receipt has appliedConceptRecordIds -> fails with COMPENSATION_SCOPE_UNSUPPORTED_T05 (zero writes)", async () => {
    vi.mocked(prisma.v5OperationReceipt.findUnique).mockResolvedValue({
      id: "receipt-with-t05",
      responseJson: JSON.stringify({
        appliedItems: [sampleItem],
        appliedConceptRecordIds: ["recConcept001"],
      }),
    } as any);

    await expect(
      compensateV5HubDecisionPullReceipt({
        context: mockContext,
        receiptId: "receipt-with-t05",
      }),
    ).rejects.toThrowError(V5CoreError);

    try {
      await compensateV5HubDecisionPullReceipt({
        context: mockContext,
        receiptId: "receipt-with-t05",
      });
    } catch (err: any) {
      expect(err.code).toBe("COMPENSATION_SCOPE_UNSUPPORTED_T05");
      expect(err.message).toContain("Product Concept / T05");
    }

    // Zero writes
    expect(prisma.viralAnalysisRecord.findUnique).not.toHaveBeenCalled();
    expect(prisma.viralAnalysisRecord.updateMany).not.toHaveBeenCalled();
    expect(baseClient.batchUpdateRecords).not.toHaveBeenCalled();
  });

  it("Case E: fails closed when beforeLocalState is missing from receipt", async () => {
    const corruptedItem: CompensatingItemRecord = {
      taskId: "task-002",
      beforeLocalState: null,
      afterLocalState: {
        decisionStatus: "continue",
        canonicalStatus: "PROCEED",
        choice: "PROCEED",
      },
      beforeT01State: null,
      afterT01State: null,
      t02RecordId: "recT02-002",
    };

    vi.mocked(prisma.v5OperationReceipt.findUnique).mockResolvedValue({
      id: "receipt-corrupted",
      responseJson: JSON.stringify({ appliedItems: [corruptedItem] }),
    } as any);

    await expect(
      compensateV5HubDecisionPullReceipt({
        context: mockContext,
        receiptId: "receipt-corrupted",
      }),
    ).rejects.toThrowError(V5CoreError);

    try {
      await compensateV5HubDecisionPullReceipt({
        context: mockContext,
        receiptId: "receipt-corrupted",
      });
    } catch (err: any) {
      expect(err.code).toBe("MISSING_BEFORE_STATE_AUTO_COMPENSATION");
    }

    expect(prisma.viralAnalysisRecord.updateMany).not.toHaveBeenCalled();
    expect(baseClient.batchUpdateRecords).not.toHaveBeenCalled();
  });

  it("Case F: concurrent modification between precheck and restore causes updateMany count === 0 -> fails with COMPENSATION_STATE_DIVERGED", async () => {
    vi.mocked(prisma.v5OperationReceipt.findUnique).mockResolvedValue({
      id: "receipt-toctou-race",
      responseJson: JSON.stringify({
        appliedItems: [sampleItem],
        appliedConceptRecordIds: [],
      }),
    } as any);

    // Mock local task matching afterLocalState during precheck
    vi.mocked(prisma.viralAnalysisRecord.findUnique).mockResolvedValue({
      id: "task-001",
      type: "workflow",
      decisionStatus: "continue",
      resultJson: JSON.stringify({
        v5Research: {
          myChoice: {
            canonicalStatus: "PROCEED",
            choice: "PROCEED",
          },
        },
      }),
      updatedAt: new Date("2026-09-28T10:00:00.000Z"),
    } as any);

    // Mock T01 precheck match
    vi.mocked(baseClient.searchTableRecords).mockResolvedValue([
      {
        record_id: "recT01-001",
        fields: { "主体键": "amazon:US:B07G4VTV2F", "决策状态": "PROCEED" },
      },
    ]);

    // Simulate TOCTOU: between precheck and restore, another write occurred so CAS where clause matches 0 records
    vi.mocked(prisma.viralAnalysisRecord.updateMany).mockResolvedValue({ count: 0 });

    await expect(
      compensateV5HubDecisionPullReceipt({
        context: mockContext,
        receiptId: "receipt-toctou-race",
      }),
    ).rejects.toThrowError(V5CoreError);

    try {
      await compensateV5HubDecisionPullReceipt({
        context: mockContext,
        receiptId: "receipt-toctou-race",
      });
    } catch (err: any) {
      expect(err.code).toBe("COMPENSATION_STATE_DIVERGED");
      expect(err.message).toContain("并发冲突");
    }

    // T01 batchUpdateRecords should NOT have run
    expect(baseClient.batchUpdateRecords).not.toHaveBeenCalled();
  });
});
