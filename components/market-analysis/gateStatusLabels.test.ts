import { describe, expect, it } from "vitest";
import { GATE_SEMANTICS_HINT, GATE_STATUS_LABELS, gateSemanticsFor } from "./gateStatusLabels";

describe("市场闸门文案（P5-v6）", () => {
  it("PROCEED 显示为「允许继续研究」，不再是「已通过」", () => {
    expect(GATE_STATUS_LABELS.PROCEED).toBe("允许继续研究");
    expect(Object.values(GATE_STATUS_LABELS)).not.toContain("已通过");
  });

  it("PROCEED 附带「不代表机会/开发已确认」的解释，其余状态不附", () => {
    expect(gateSemanticsFor("PROCEED")).toBe(GATE_SEMANTICS_HINT);
    expect(GATE_SEMANTICS_HINT).toContain("不代表市场机会");
    expect(gateSemanticsFor("PAUSE")).toBeNull();
    expect(gateSemanticsFor(null)).toBeNull();
  });
});
