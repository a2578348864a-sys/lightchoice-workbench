import { describe, expect, it, vi } from "vitest";

import {
  AMAZON_SEARCH_READY_SELECTOR,
  waitForAmazonSearchResults,
} from "@/lib/server/captureRecipeBrowser";

/**
 * 搜索页就绪等待的定向测试。
 *
 * 故障背景（2026-10-21 真实事故）：搜索页 goto 只等 DOMContentLoaded，结果卡片异步注入；
 * 旧实现立刻抽取 → 0 张卡片 → unknown_page → PAGE_CHANGED，用户看到「页面结构变化」。
 * 本等待只做有界就绪等待，超时后不改变任何 fail-closed 判定。
 */
describe("Amazon 搜索页就绪等待", () => {
  it("选择器同时覆盖结果卡片与明确终态（验证码 / 登录墙 / 无结果）", () => {
    expect(AMAZON_SEARCH_READY_SELECTOR).toContain('[data-component-type="s-search-result"]');
    expect(AMAZON_SEARCH_READY_SELECTOR).toContain('form[action*="validateCaptcha"]');
    expect(AMAZON_SEARCH_READY_SELECTOR).toContain('form[name="signIn"]');
    expect(AMAZON_SEARCH_READY_SELECTOR).toContain(".s-no-results");
  });

  it("卡片出现时立即返回，并以 attached 状态等待", async () => {
    const waitForSelector = vi.fn(async () => ({}));
    await waitForAmazonSearchResults({ waitForSelector }, 5_000);
    expect(waitForSelector).toHaveBeenCalledWith(AMAZON_SEARCH_READY_SELECTOR, { state: "attached", timeout: 5_000 });
  });

  it("超时或页面异常不抛出，交由后续门禁判定", async () => {
    const waitForSelector = vi.fn(async () => { throw new Error("TimeoutError"); });
    await expect(waitForAmazonSearchResults({ waitForSelector }, 50)).resolves.toBeUndefined();
    expect(waitForSelector).toHaveBeenCalledTimes(1);
  });
});
