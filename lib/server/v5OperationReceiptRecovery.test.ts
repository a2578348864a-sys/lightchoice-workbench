import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({
  prisma: { v5OperationReceipt: { findUnique: mocks.findUnique, updateMany: mocks.updateMany } },
}));

import { hashJson, withV5Receipt } from "./v5CoreCommon";

const context = { mode: "owner" as const, token: "" };
const requestBody = { schemaVersion: "test-v1" };

function processingReceipt(updatedAt: Date) {
  return {
    id: "receipt-processing",
    requestHash: hashJson(requestBody),
    status: "processing",
    updatedAt,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("withV5Receipt stale processing reconciliation", () => {
  it("settles a stale receipt only after an operation-specific exact-state proof", async () => {
    const updatedAt = new Date(Date.now() - 120_000);
    mocks.findUnique.mockResolvedValueOnce(processingReceipt(updatedAt));
    mocks.updateMany.mockResolvedValueOnce({ count: 1 });
    const execute = vi.fn();
    const reconciled = { status: "PROJECTED", projections: [{ status: "UNCHANGED", recordId: "rec-exact" }] };
    const recovery = vi.fn().mockResolvedValueOnce(reconciled);

    const result = await withV5Receipt({
      context, operation: "test:readback-recovery", resourceKey: "subject", idempotencyKey: "stale-key",
      requestBody, execute,
      reconcileProcessing: { staleAfterMs: 60_000, run: recovery },
    });

    expect(result).toEqual({ value: reconciled, replayed: true, receiptId: "receipt-processing" });
    expect(recovery).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "receipt-processing", status: "processing", updatedAt },
      data: { status: "succeeded", responseJson: JSON.stringify(reconciled), errorCode: null },
    });
  });

  it("keeps fresh or unproven processing receipts in progress without executing or updating", async () => {
    const updatedAt = new Date();
    mocks.findUnique.mockResolvedValueOnce(processingReceipt(updatedAt));
    const execute = vi.fn();
    const recovery = vi.fn();

    await expect(withV5Receipt({
      context, operation: "test:readback-recovery", resourceKey: "subject", idempotencyKey: "fresh-key",
      requestBody, execute,
      reconcileProcessing: { staleAfterMs: 60_000, run: recovery },
    })).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
    expect(recovery).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("retains a stale receipt when readback cannot prove exact completion", async () => {
    mocks.findUnique.mockResolvedValueOnce(processingReceipt(new Date(Date.now() - 120_000)));
    const recovery = vi.fn().mockResolvedValueOnce(null);

    await expect(withV5Receipt({
      context, operation: "test:readback-recovery", resourceKey: "subject", idempotencyKey: "unproven-key",
      requestBody, execute: vi.fn(),
      reconcileProcessing: { staleAfterMs: 60_000, run: recovery },
    })).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
