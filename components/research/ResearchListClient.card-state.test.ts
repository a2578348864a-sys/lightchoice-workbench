import { describe, expect, it } from "vitest";
import { researchCardChoiceLabel, type ResearchListRow } from "./ResearchListClient";
import { researchCardCtaOf, researchCardStatusOf, researchFindingOf } from "./researchListRow";

const baseRow = {
  taskId: "task-1",
  archivedAt: null,
  researchState: "report_ready",
  businessStage: "needs_decision",
  stale: false,
  reportConsumptionBlocked: false,
  reportAuditVerdict: null,
  myChoice: null,
  finding: { status: "CURRENT", label: "核心发现", text: "当前结论", basis: "当前研报" },
} as unknown as ResearchListRow;

describe("研究卡片人工决定语义", () => {
  it("没有保存记录时不把 PENDING 标成临时观察", () => {
    expect(researchCardChoiceLabel(null)).toBe("尚未保存人工决定");
    expect(researchCardChoiceLabel({ choice: null, scope: null, chosenAt: null, reasonPreview: null })).toBe("尚未保存人工决定");
  });
  it("正式决策与临时观察使用保存记录的作用域", () => {
    const choice: NonNullable<ResearchListRow["myChoice"]> = { choice: "WATCH", canonicalStatus: "VALIDATE_MORE", scope: "FINAL", chosenAt: "2026-10-19T00:00:00Z", reasonPreview: null };
    expect(researchCardChoiceLabel(choice)).toBe("人工决定：需补充验证");
    expect(researchCardChoiceLabel({ ...choice, canonicalStatus: "PAUSE", scope: "TEMPORARY" })).toBe("临时观察：暂缓观察");
  });

  it("报告暂停采信时卡片显示报告状态并给出复核入口", () => {
    const row = { ...baseRow, reportConsumptionBlocked: true, reportAuditVerdict: "BLOCKED" as const, reportConsumptionNotice: "研报存在超过证据强度的结论" };
    expect(researchCardStatusOf(row).label).toContain("报告暂停采信");
    expect(researchCardStatusOf(row).tone).toBe("risk");
    expect(researchCardCtaOf(row).label).toBe("复核研究");
    expect(researchFindingOf(row).label).toBe("报告暂停采信");
  });

  it("报告需降级或来源变化时不再显示直接进入决策", () => {
    const needsDowngrade = { ...baseRow, reportAuditVerdict: "NEEDS_DOWNGRADE" as const };
    expect(researchCardStatusOf(needsDowngrade).label).toContain("报告需复核");
    expect(researchCardCtaOf(needsDowngrade).label).toBe("复核研究");

    const stale = { ...baseRow, stale: true };
    expect(researchCardStatusOf(stale).label).toContain("需重新确认");
    expect(researchCardCtaOf(stale).label).toBe("复核研究");
  });

  it("正常待决策研究仍保留进入决策入口", () => {
    expect(researchCardStatusOf(baseRow).label).toContain("待决策");
    expect(researchCardCtaOf(baseRow).label).toBe("进入决策");
  });

  it("stale 优先于服务端仍标记 CURRENT 的旧发现", () => {
    const row = {
      ...baseRow,
      stale: true,
      finding: { status: "CURRENT" as const, label: "核心发现", text: "旧结论仍被服务端标为当前", basis: "当前研报" },
    };
    const finding = researchFindingOf(row);
    expect(finding.status).toBe("HISTORICAL");
    expect(finding.label).toBe("历史研报需复核");
    expect(finding.text).toBeNull();
  });
});
