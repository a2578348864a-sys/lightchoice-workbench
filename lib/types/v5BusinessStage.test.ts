import { describe, it, expect } from "vitest";
import {
  resolveBusinessStage,
  getBusinessStageMeta,
  BUSINESS_STAGES,
  BUSINESS_STAGE_TABS,
  type BusinessStage,
} from "./v5BusinessStage";

describe("v5BusinessStage contract and resolver", () => {
  it("推进状态不替用户断言立项或全部事实已成立", () => {
    expect(BUSINESS_STAGES.proceed.description).toContain("不等于立项");
    expect(BUSINESS_STAGES.proceed.description).not.toContain("事实与商业逻辑成立");
  });

  it("resolves archived tasks to archived stage", () => {
    expect(resolveBusinessStage({ archivedAt: "2026-09-25T00:00:00Z" })).toBe("archived");
    expect(resolveBusinessStage({ isArchived: true })).toBe("archived");
    expect(
      resolveBusinessStage({
        isArchived: true,
        myChoice: { canonicalStatus: "PROCEED" },
      })
    ).toBe("archived");
  });

  it("resolves canonical final choices to their corresponding stages", () => {
    expect(
      resolveBusinessStage({
        myChoice: { canonicalStatus: "PROCEED" },
      })
    ).toBe("proceed");

    expect(
      resolveBusinessStage({
        myChoice: { canonicalStatus: "DROP" },
      })
    ).toBe("drop");

    expect(
      resolveBusinessStage({
        myChoice: { canonicalStatus: "PAUSE" },
      })
    ).toBe("pause");

    expect(
      resolveBusinessStage({
        myChoice: { canonicalStatus: "VALIDATE_MORE" },
      })
    ).toBe("validate_more");

    // Legacy need info ambiguous maps to validate_more
    expect(
      resolveBusinessStage({
        dbStatus: "need_info",
      })
    ).toBe("validate_more");
  });

  it("resolves tasks with formal report ready and no decision as needs_decision", () => {
    expect(
      resolveBusinessStage({
        taskId: "task-123",
        isLegacy: false,
        reportHash: "sha256-abc",
        deepseekAvailable: true,
      })
    ).toBe("needs_decision");

    expect(
      resolveBusinessStage({
        taskId: "task-123",
        hasFormalReport: true,
      })
    ).toBe("needs_decision");
  });

  it("resolves candidate or unfinalized tasks without formal report as ready", () => {
    // Candidate without taskId
    expect(
      resolveBusinessStage({
        taskId: null,
      })
    ).toBe("ready");

    // Task exists but no report generated yet
    expect(
      resolveBusinessStage({
        taskId: "task-123",
        isLegacy: false,
        reportHash: null,
        deepseekAvailable: false,
      })
    ).toBe("ready");

    // Legacy task without full report
    expect(
      resolveBusinessStage({
        taskId: "task-legacy",
        isLegacy: true,
        reportHash: null,
      })
    ).toBe("ready");
  });

  it("provides complete metadata for all 7 business stages", () => {
    const expectedStages: BusinessStage[] = [
      "ready",
      "needs_decision",
      "proceed",
      "validate_more",
      "pause",
      "drop",
      "archived",
    ];

    for (const stage of expectedStages) {
      const meta = getBusinessStageMeta(stage);
      expect(meta.stage).toBe(stage);
      expect(meta.label).toBeTruthy();
      expect(meta.badgeText).toBeTruthy();
      expect(meta.description).toBeTruthy();
      expect(meta.tone).toBeTruthy();
    }
  });

  it("contains all 7 stage tabs plus all tab in order", () => {
    expect(BUSINESS_STAGE_TABS.map((t) => t.key)).toEqual([
      "all",
      "ready",
      "needs_decision",
      "proceed",
      "validate_more",
      "pause",
      "drop",
      "archived",
    ]);
  });
});
