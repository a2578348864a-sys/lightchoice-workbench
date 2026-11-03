import { describe, expect, it } from "vitest";
import { readStoredResearchReport } from "./researchReportStore";
import type { ResearchReport } from "@/lib/research/researchContracts";

const report = {
  schema: "research-report.v1",
  generatedAt: "2026-09-19T10:00:00.000Z",
} as unknown as ResearchReport;

describe("readStoredResearchReport", () => {
  it("读取 Active resultJson 中的 reportJson/reportHash/generatedAt 契约", () => {
    const stored = readStoredResearchReport({
      researchReport: {
        reportJson: report,
        reportHash: "a".repeat(64),
        generatedAt: "2026-09-19T10:01:00.000Z",
      },
    });

    expect(stored).toEqual({
      report,
      reportHash: "a".repeat(64),
      generatedAt: "2026-09-19T10:01:00.000Z",
    });
  });

  it("兼容首轮直接保存的旧 ResearchReport 形状", () => {
    const stored = readStoredResearchReport({
      researchReport: report,
      researchReportHash: "b".repeat(64),
      researchReportGeneratedAt: "2026-09-19T10:02:00.000Z",
    });

    expect(stored).toEqual({
      report,
      reportHash: "b".repeat(64),
      generatedAt: "2026-09-19T10:02:00.000Z",
    });
  });

  it("刷新读取时保留 decisionSummary 与原 reportHash", () => {
    const reportWithSummary = {
      ...report,
      decisionSummary: {
        researchPriority: "P2",
        recommendedNextAction: "补充数据",
        keyReasons: ["市场机会仍需补证据"],
        blockingRisks: ["成本信息缺失"],
        missingInformation: ["采购成本"],
      },
    } as unknown as ResearchReport;
    const reportHash = "c".repeat(64);
    const stored = readStoredResearchReport({
      researchReport: {
        reportJson: reportWithSummary,
        reportHash,
        generatedAt: "2026-09-19T10:03:00.000Z",
      },
    });

    expect(stored?.report.decisionSummary).toEqual(reportWithSummary.decisionSummary);
    expect(stored?.reportHash).toBe(reportHash);
  });
});
