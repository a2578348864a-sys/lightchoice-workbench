import { describe, expect, it } from "vitest";
import { researchCardChoiceLabel, type ResearchListRow } from "./ResearchListClient";
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
});
