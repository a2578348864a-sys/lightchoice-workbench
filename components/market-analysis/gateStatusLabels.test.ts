import { describe, expect, it } from "vitest";

import { marketListGatePresentation } from "./gateStatusLabels";

describe("02 市场研究列表与详情统一门禁", () => {
  it("stale 判断优先显示需重新确认，不把历史暂缓伪装成有效", () => {
    expect(marketListGatePresentation({ status: "PAUSE", effectiveStatus: "PENDING", stale: true })).toMatchObject({
      key: "STALE",
      label: "需重新确认",
      tone: "warn",
      note: "判断已失效",
    });
  });

  it("使用 effectiveStatus 而不是旧 status", () => {
    expect(marketListGatePresentation({ status: "PAUSE", effectiveStatus: "PROCEED", stale: false })).toMatchObject({
      key: "PROCEED",
      label: "允许继续研究",
      tone: "ok",
    });
  });

  it("保留未记录与普通状态", () => {
    expect(marketListGatePresentation(null).key).toBe("NONE");
    expect(marketListGatePresentation({ status: "PENDING" })).toMatchObject({ key: "PENDING", label: "待处理" });
  });
});
