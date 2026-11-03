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
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    viralAnalysisRecord: {
      findUnique: vi.fn(),
      update: vi.fn(),
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
    batchUpdateRecords: vi.fn().mockResolvedValue({}),
    searchTableRecords: vi.fn().mockResolvedValue([]),
    listTableFields: vi.fn().mockResolvedValue([]),
  };
});

describe("OPERATION_RECEIPT_PERSISTENCE & RECOVERY", () => {
  const mockContext = {
    token: "mock-owner-token",
    authSource: "password" as const,
    tokenIssuedAt: Date.now(),
    mode: "owner" as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists receipt and restores beforeState after reloading from DB by receiptId", async () => {
    const mockReceiptId = "rcpt_pull_feishu_20260929_abc";
    const itemToCompensate: CompensatingItemRecord = {
      taskId: "task-001",
      beforeLocalState: {
        decisionStatus: "need_info",
        resultJson: JSON.stringify({ v5Research: { state: "before_decision" } }),
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

    // 1. Mock DB reload: receipt retrieved from prisma.v5OperationReceipt by receiptId
    vi.mocked(prisma.v5OperationReceipt.findUnique).mockResolvedValueOnce({
      id: mockReceiptId,
      actorScope: "owner:v1",
      operation: "feishu-hub:pull-decisions",
      resourceKey: "feishu-hub:decisions",
      idempotencyKey: "idem-key-123",
      requestHash: "req_hash_123",
      status: "succeeded",
      responseJson: JSON.stringify({
        scannedRecords: 1,
        applied: 1,
        unchanged: 0,
        pendingReview: 0,
        appliedItems: [itemToCompensate],
        appliedConceptRecordIds: [],
      }),
      errorCode: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    // Mock local task matching afterLocalState
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

    // Mock T01 current state matching afterT01State
    vi.mocked(baseClient.searchTableRecords).mockResolvedValueOnce([
      {
        record_id: "recT01-001",
        fields: { "主体键": "amazon:US:B07G4VTV2F", "决策状态": "PROCEED" },
      },
    ]);

    // Mock successful CAS updateMany
    vi.mocked(prisma.viralAnalysisRecord.updateMany).mockResolvedValueOnce({ count: 1 });

    // 2. Execute compensation from reloaded receipt
    const result = await compensateV5HubDecisionPullReceipt({
      context: mockContext,
      receiptId: mockReceiptId,
    });

    // 3. Verify receipt reload was invoked with exact receiptId
    expect(prisma.v5OperationReceipt.findUnique).toHaveBeenCalledWith({
      where: { id: mockReceiptId },
    });

    // 4. Verify local state was restored via CAS updateMany with updatedAt and resultJson binding
    expect(prisma.viralAnalysisRecord.updateMany).toHaveBeenCalledWith({
      where: {
        id: "task-001",
        decisionStatus: "continue",
        updatedAt: expect.any(Date),
        resultJson: expect.any(String),
      },
      data: expect.objectContaining({
        decisionStatus: "need_info",
        resultJson: JSON.stringify({ v5Research: { state: "before_decision" } }),
      }),
    });

    // 5. Verify T01 mirror was restored to exact prior status (PAUSED, NEVER blanket PENDING!)
    expect(baseClient.batchUpdateRecords).toHaveBeenCalledWith(
      expect.anything(),
      [{ record_id: "recT01-001", fields: { "决策状态": "PAUSED" } }],
    );

    expect(result.compensated).toBe(true);
    expect(result.recordsRestored).toBe(1);
    expect(result.t01MirrorsRestored).toBe(1);
  });

  it("fails closed when receipt is missing or beforeLocalState is missing", async () => {
    // Sub-case A: receipt not found in DB
    vi.mocked(prisma.v5OperationReceipt.findUnique).mockResolvedValueOnce(null);

    await expect(
      compensateV5HubDecisionPullReceipt({
        context: mockContext,
        receiptId: "nonexistent-receipt",
      }),
    ).rejects.toThrowError("未找到回执记录: nonexistent-receipt");

    // Sub-case B: receipt found but beforeLocalState missing -> Fail Closed
    const corruptedItem: CompensatingItemRecord = {
      taskId: "task-corrupted",
      beforeLocalState: null, // missing!
      afterLocalState: {
        decisionStatus: "continue",
        canonicalStatus: "PROCEED",
        choice: "PROCEED",
      },
      beforeT01State: null,
      afterT01State: null,
      t02RecordId: "recT02-002",
    };

    vi.mocked(prisma.v5OperationReceipt.findUnique).mockResolvedValueOnce({
      id: "receipt-corrupted",
      responseJson: JSON.stringify({ appliedItems: [corruptedItem] }),
    } as any);

    try {
      await compensateV5HubDecisionPullReceipt({
        context: mockContext,
        receiptId: "receipt-corrupted",
      });
      expect.unreachable("should have thrown V5CoreError");
    } catch (err: any) {
      expect(err.code).toBe("MISSING_BEFORE_STATE_AUTO_COMPENSATION");
    }

    // Nothing was updated
    expect(prisma.viralAnalysisRecord.update).not.toHaveBeenCalled();
    expect(baseClient.batchUpdateRecords).not.toHaveBeenCalled();
  });
});
