import { describe, expect, it } from "vitest";
import { describeDecisionBasis } from "./decisionBasis";

describe("describeDecisionBasis", () => {
  it("无人工决定时不生成说明", () => {
    expect(describeDecisionBasis({ hasDecision: false, source: null, localEconomicsIncomplete: true })).toBeNull();
  });

  it("外部飞书依据与本地研究包匹配时标记为已绑定", () => {
    const notice = describeDecisionBasis({
      hasDecision: true,
      source: { kind: "feishu_hub", recordId: "rec-1", reviewedAt: "2026-09-28T11:26:01.000Z", packetHash: "e0f9e0fe08e9847f" },
      linkedRecordId: "rec-1",
      localEconomicsIncomplete: false,
    });
    expect(notice?.kind).toBe("linked");
    expect(notice?.text).toContain("飞书 T02 记录 rec-1");
    expect(notice?.text).toContain("2026-09-28");
    expect(notice?.text).toContain("证据包 e0f9e0fe08…");
    expect(notice?.text).toContain("已与本地研究包绑定");
  });

  it("外部依据已记录但未绑定时如实提示，不否定决定", () => {
    const notice = describeDecisionBasis({
      hasDecision: true,
      source: { kind: "feishu_hub", recordId: "rec-1" },
      linkedRecordId: null,
      localEconomicsIncomplete: true,
    });
    expect(notice?.kind).toBe("unlinked");
    expect(notice?.text).toContain("尚未与本地研究包建立有效绑定");
    expect(notice?.text).toContain("本地经济性字段不完整");
    expect(notice?.text).not.toContain("无效");
  });

  it("未记录外部来源时只提示本地依据缺失", () => {
    const notice = describeDecisionBasis({
      hasDecision: true,
      source: null,
      localEconomicsIncomplete: true,
    });
    expect(notice?.kind).toBe("local_only");
    expect(notice?.text).toContain("未记录外部依据来源");
    expect(notice?.text).toContain("不改变历史决定状态");
  });
});
