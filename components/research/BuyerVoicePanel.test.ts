import { describe, expect, it } from "vitest";
import { formatBuyerVoiceLoadError } from "./BuyerVoicePanel";

describe("BuyerVoicePanel 错误状态", () => {
  it("将服务端内部异常投影成带重试动作和安全错误码的提示", () => {
    expect(formatBuyerVoiceLoadError(500, "INTERNAL_ERROR", "核心服务暂时不可用，请稍后重试。"))
      .toBe("买家评论暂时无法读取（INTERNAL_ERROR）。请点击“刷新”重试；若问题持续，请把错误码提供给维护者。");
  });

  it("保留可恢复的商品事实绑定冲突提示", () => {
    expect(formatBuyerVoiceLoadError(409, "RESEARCH_INPUT_BUNDLE_EVIDENCE_MISSING", "请显式补齐商品事实来源后重试。"))
      .toBe("请显式补齐商品事实来源后重试。");
  });
});
