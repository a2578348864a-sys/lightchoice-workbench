import { describe, expect, it } from "vitest";
import { deriveResearchState, RESEARCH_PROGRESS_LABELS } from "@/lib/research/researchState";

describe("E-1B research progress state", () => {
  it("只有任务壳（handoff 后无 report / 无修订 / 无需求单 / 无决策）→ 未开始研究", () => {
    expect(deriveResearchState({ hasReport: false })).toBe("not_started");
    expect(deriveResearchState({ hasReport: false, researchRevision: 0 })).toBe("not_started");
    expect(deriveResearchState({ hasReport: false, researchRevision: null })).toBe("not_started");
  });

  it("已有正式研报 → 已有研究报告（不再显示为未开始）", () => {
    expect(deriveResearchState({ hasReport: true })).toBe("report_ready");
    expect(deriveResearchState({ hasReport: true, researchRevision: 3 })).toBe("report_ready");
  });

  it("有研究过痕迹（修订号 / 需求单 / 决策）但暂无 report → 研究进行中", () => {
    expect(deriveResearchState({ hasReport: false, researchRevision: 1 })).toBe("in_progress");
    expect(deriveResearchState({ hasReport: false, hasProductBrief: true })).toBe("in_progress");
    expect(deriveResearchState({ hasReport: false, hasDecision: true })).toBe("in_progress");
  });

  it("三种状态都有明确中文标签，避免列表用「已准备」掩盖空壳", () => {
    expect(RESEARCH_PROGRESS_LABELS.report_ready).toBe("已有研究报告");
    expect(RESEARCH_PROGRESS_LABELS.in_progress).toBe("研究进行中");
    expect(RESEARCH_PROGRESS_LABELS.not_started).toBe("未开始研究");
  });
});
