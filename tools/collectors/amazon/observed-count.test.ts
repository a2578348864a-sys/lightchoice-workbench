import { describe, expect, it } from "vitest";
import { parseObservedCountText } from "./observed-count";

describe("parseObservedCountText", () => {
  it("reads a thousands-separated count completely instead of its prefix", () => {
    // 真实失败样本：27,477 / 123,796 / 3,354 / 1,074 / 5,268 / 2,394 / 1,411 / 1,578 / 7,467
    expect(parseObservedCountText("27,477")).toBe(27477);
    expect(parseObservedCountText("(27,477)")).toBe(27477);
    expect(parseObservedCountText("27,477 ratings")).toBe(27477);
    expect(parseObservedCountText("123,796")).toBe(123796);
    expect(parseObservedCountText("7,467 global ratings")).toBe(7467);
  });

  it("repairs a count that the DOM split with whitespace around the separator", () => {
    // 千分位被拆成两个文本节点时 textContent 形如 "27 ,477" / "27\u00a0,\u00a0477"
    expect(parseObservedCountText("27 ,477")).toBe(27477);
    expect(parseObservedCountText("27\u00a0,\u00a0477")).toBe(27477);
    expect(parseObservedCountText("123\n,\n796")).toBe(123796);
  });

  it("never returns a truncated prefix", () => {
    expect(parseObservedCountText("27,")).toBeNull();
    expect(parseObservedCountText("(27,")).toBeNull();
    expect(parseObservedCountText("27, 477, 001")).toBe(27477001);
  });

  it("keeps compact suffixes and rejects rating-like decimals in count context", () => {
    expect(parseObservedCountText("1.2K")).toBe(1200);
    expect(parseObservedCountText("1.2K ratings")).toBe(1200);
    expect(parseObservedCountText("3M")).toBe(3000000);
    // 星级与计数混在同一段文本时，无法确定哪个数字是计数 → 未知，不猜。
    expect(parseObservedCountText("4.8 out of 5 stars 3,354")).toBeNull();
    expect(parseObservedCountText("4.8 out of 5")).toBeNull();
    expect(parseObservedCountText("4.8")).toBeNull();
  });

  it("returns null for missing or non-numeric text", () => {
    expect(parseObservedCountText(null)).toBeNull();
    expect(parseObservedCountText(undefined)).toBeNull();
    expect(parseObservedCountText("")).toBeNull();
    expect(parseObservedCountText("No reviews yet")).toBeNull();
  });
});
