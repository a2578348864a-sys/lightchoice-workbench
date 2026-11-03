import { describe, it, expect, vi } from "vitest";
import {
  checkCandidateDeletionSafety,
  checkMarketScanDeletionSafety,
  checkMarketOpportunityDeletionSafety,
  checkTaskDeletionSafety,
} from "./lifecycleSafety";
import { prisma } from "./db";

vi.mock("./db", () => ({
  prisma: {
    opportunityCandidate: {
      findUnique: vi.fn(),
    },
    marketScan: {
      findUnique: vi.fn(),
    },
    nicheOpportunity: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    viralAnalysisRecord: {
      findUnique: vi.fn(),
    },
  },
}));

describe("Lifecycle Deletion Safety (Phase F2)", () => {
  it("Candidate: blocks deletion when linked to convertedTaskId", async () => {
    vi.mocked(prisma.opportunityCandidate.findUnique).mockResolvedValueOnce({
      id: "c-1",
      name: "保温杯",
      convertedTaskId: "task-123",
      status: "pending",
    } as any);

    const result = await checkCandidateDeletionSafety("c-1");
    expect(result.canDelete).toBe(false);
    expect(result.canArchive).toBe(true);
    expect(result.code).toBe("protected_reference");
    expect(result.reason).toContain("受业务证据链保护禁止物理删除");
  });

  it("Candidate: allows deletion when convertedTaskId is null", async () => {
    vi.mocked(prisma.opportunityCandidate.findUnique).mockResolvedValueOnce({
      id: "c-2",
      name: "露营灯",
      convertedTaskId: null,
      status: "pending",
    } as any);

    const result = await checkCandidateDeletionSafety("c-2");
    expect(result.canDelete).toBe(true);
    expect(result.code).toBe("allowed");
  });

  it("MarketScan: blocks deletion when referenced by a NicheOpportunity", async () => {
    vi.mocked(prisma.marketScan.findUnique).mockResolvedValueOnce({
      id: "scan-1",
      scanName: "保温杯大盘扫描",
    } as any);

    vi.mocked(prisma.nicheOpportunity.findFirst).mockResolvedValueOnce({
      id: "opp-1",
      name: "便携保温杯机会",
    } as any);

    const result = await checkMarketScanDeletionSafety("scan-1");
    expect(result.canDelete).toBe(false);
    expect(result.code).toBe("protected_reference");
    expect(result.linkedEntityName).toBe("便携保温杯机会");
  });

  it("MarketScan: allows deletion when no opportunity references it", async () => {
    vi.mocked(prisma.marketScan.findUnique).mockResolvedValueOnce({
      id: "scan-2",
      scanName: "测试草稿扫描",
    } as any);

    vi.mocked(prisma.nicheOpportunity.findFirst).mockResolvedValueOnce(null);

    const result = await checkMarketScanDeletionSafety("scan-2");
    expect(result.canDelete).toBe(true);
    expect(result.code).toBe("allowed");
  });

  it("MarketOpportunity: blocks deletion when decision or research exists", async () => {
    vi.mocked(prisma.nicheOpportunity.findUnique).mockResolvedValueOnce({
      id: "opp-1",
      name: "已拍板机会",
      humanDecisionJson: JSON.stringify({ status: "CONTINUE", decidedAt: "2026-09-20" }),
      representativeSetJson: "{}",
      conceptSnapshotJson: null,
    } as any);

    const result = await checkMarketOpportunityDeletionSafety("opp-1");
    expect(result.canDelete).toBe(false);
    expect(result.canArchive).toBe(true);
    expect(result.code).toBe("protected_decision");
  });

  it("MarketOpportunity: allows deletion for draft opportunity with no decisions/research", async () => {
    vi.mocked(prisma.nicheOpportunity.findUnique).mockResolvedValueOnce({
      id: "opp-draft",
      name: "未决策草稿机会",
      humanDecisionJson: JSON.stringify({ status: "PENDING" }),
      representativeSetJson: JSON.stringify({ items: [] }),
      conceptSnapshotJson: null,
    } as any);

    const result = await checkMarketOpportunityDeletionSafety("opp-draft");
    expect(result.canDelete).toBe(true);
    expect(result.code).toBe("allowed");
  });

  it("Task: blocks deletion when decided or has report", async () => {
    vi.mocked(prisma.viralAnalysisRecord.findUnique).mockResolvedValueOnce({
      id: "task-1",
      title: "已完成研究的商品",
      decisionStatus: "approved",
      resultJson: JSON.stringify({ report: { summary: "PASS" } }),
    } as any);

    const result = await checkTaskDeletionSafety("task-1");
    expect(result.canDelete).toBe(false);
    expect(result.canArchive).toBe(true);
    expect(result.code).toBe("protected_decision");
  });

  it("Task: allows deletion when task is unstarted/empty pending", async () => {
    vi.mocked(prisma.viralAnalysisRecord.findUnique).mockResolvedValueOnce({
      id: "task-2",
      title: "空任务草稿",
      decisionStatus: "pending",
      resultJson: "{}",
    } as any);

    const result = await checkTaskDeletionSafety("task-2");
    expect(result.canDelete).toBe(true);
    expect(result.code).toBe("allowed");
  });
});
