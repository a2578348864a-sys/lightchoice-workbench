import { describe, expect, it } from "vitest";

import { briefEmptyStateMessage } from "./ProductBriefClient";

describe("04 需求单空态文案与服务端门禁一致", () => {
  it("服务端允许生成时不再提示必须先回 03", () => {
    const message = briefEmptyStateMessage(false, null);
    expect(message).toContain("已满足生成条件");
    expect(message).not.toContain("必须先在");
  });

  it("商品闸门未通过时展示真实原因", () => {
    const message = briefEmptyStateMessage(true, "PRODUCT_GATE_PROCEED_REQUIRED");
    expect(message).toContain("继续推进");
    expect(message).toContain("服务端才会接受");
  });

  it("来源变化与报告缺失各自展示真实原因", () => {
    expect(briefEmptyStateMessage(true, "RESEARCH_EVIDENCE_STALE")).toContain("重新确认研究");
    expect(briefEmptyStateMessage(true, "RESEARCH_REPORT_REQUIRED")).toContain("商品深研报告");
  });
});
