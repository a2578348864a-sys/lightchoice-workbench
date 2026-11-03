import { describe, expect, it } from "vitest";
import { buildResearchExportBatch } from "./exportBatch";
import type { ResearchExportRecord } from "./researchContracts";

function record(taskId: string): ResearchExportRecord {
  return {
    taskId,
    candidateId: `candidate-${taskId}`,
    product: { asin: null, title: taskId, image: null, category: null },
    market: { price: null, sales: null, bsr: null },
    research: { summary: null, priority: "P2", opportunity: null, risks: [], unverifiedAssumptions: [] },
    humanDecision: null,
    evidence: {
      reportHash: `${taskId}-hash`,
      generatedAt: "2026-09-19T00:00:00.000Z",
      citationCount: 0,
      factCitationCount: 0,
      narrativeCitationCount: 0,
      unverifiedAssumptionCount: 0,
    },
  };
}

describe("buildResearchExportBatch", () => {
  it("只包装已有 ResearchExportRecord，不改变项目顺序或内容", () => {
    const items = [record("task-1"), record("task-2"), record("task-3")];
    const batch = buildResearchExportBatch({
      items,
      generatedAt: "2026-09-19T12:00:00.000Z",
    });

    expect(batch).toEqual({
      exportVersion: "research-export-batch.v1",
      generatedAt: "2026-09-19T12:00:00.000Z",
      items,
    });
  });
});
