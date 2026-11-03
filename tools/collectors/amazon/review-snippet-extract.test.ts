/**
 * V3 Final Operability Correction — Package C：Review Snippet 提取表达式工件测试
 *
 * 与 detail-page-expression.test.ts 同职责：
 * 1. 表达式自包含（fixed-name helpers、无 `${...}` 运行时拼接、无 fn.toString() 模式）
 * 2. 占位替换正确（__MAX_ITEMS__ → 数值）
 * 3. 在隔离作用域执行（new Function + fake DOM）验证真实提取语义
 */
import { describe, expect, it } from "vitest";
import {
  REVIEW_SNIPPET_EXTRACTOR_SOURCE,
  buildReviewDomReadinessExpression,
  buildReviewSnippetExtractionExpression,
  isReviewPageIdentityBound,
  REVIEW_DOM_READINESS_SOURCE,
  type ReviewSnippet,
} from "@/tools/collectors/amazon/review-snippet-extract";

/** fake DOM：模拟 Amazon 详情页 Top Reviews 片段及独立标题/正文节点。 */
function fakeDom(): { document: { querySelectorAll: () => Array<{ textContent: string; querySelector: (selector: string) => { textContent: string } | null }> } } {
  const nodes = [
    { raw: '5.0 out of 5 stars Reviewed in the United States on August 1, 2026 Verified Purchase Fits perfectly and feels premium.', title: 'Fits perfectly', body: 'Fits perfectly and feels premium.', verified: true },
    { raw: 'Assembly instructions are confusing.', title: '', body: 'Assembly instructions are confusing.', verified: false },
  ];
  return {
    document: {
      querySelectorAll: () => nodes.map((node) => {
        return {
          textContent: node.raw,
          querySelector: (selector: string) => {
            if (selector.includes('review-title') || selector === '.review-title') {
              return node.title ? { textContent: node.title } : null;
            }
            if (selector.includes('review-body') || selector === '.review-text-content') {
              return { textContent: node.body };
            }
            if (selector.includes('avp-badge')) return node.verified ? { textContent: 'Verified Purchase' } : null;
            return null;
          },
        };
      }),
    },
  };
}

function amazonCurrentReviewDom(): { document: { querySelectorAll: () => Array<{ textContent: string; querySelector: (selector: string) => { textContent: string } | null }> } } {
  const raw = "Tango's product reviews5 out of 5 starsThe device that just keeps getting better and better with each revisionReviewed in the United States on December 14, 2019Verified PurchaseOkay so first off I'd like to say that this is a real public review.";
  return {
    document: {
      querySelectorAll: () => [{
        textContent: raw,
        querySelector: (selector: string) => {
          if (selector === '[data-hook="reviewTitle"]' || selector === '[class*="single-review-title"]') {
            return { textContent: 'The device that just keeps getting better and better with each revision' };
          }
          if (selector === '[data-hook="reviewRichContentContainer"]' || selector === '[class*="contain-rich-content"]') {
            return { textContent: "Okay so first off I'd like to say that this is a real public review." };
          }
          if (selector.includes('avp-badge')) return { textContent: 'Verified Purchase' };
          return null;
        },
      }],
    },
  };
}

function runExpression<T>(expression: string, dom: ReturnType<typeof fakeDom>): T {
  const factory = new Function("document", `return ${expression}`) as (document: unknown) => T;
  return factory(dom.document);
}

describe("REVIEW_SNIPPET_EXTRACTOR_SOURCE（自包含工件）", () => {
  it("Review 页面身份绑定允许缺少 ASIN 标签，但拒绝 URL 或显式标签不匹配", () => {
    const base = { expectedAsin: "B0AAAA0001", urlAsin: "B0AAAA0001", pageAsin: null, pageStatus: "ok", productContainerFound: true };
    expect(isReviewPageIdentityBound(base)).toBe(true);
    expect(isReviewPageIdentityBound({ ...base, pageAsin: "B0BBBB0002" })).toBe(false);
    expect(isReviewPageIdentityBound({ ...base, urlAsin: "B0BBBB0002" })).toBe(false);
    expect(isReviewPageIdentityBound({ ...base, productContainerFound: false })).toBe(false);
    expect(isReviewPageIdentityBound({ ...base, pageStatus: "captcha" })).toBe(false);
  });

  it("不含运行时拼接模式（P1-A 防线）", () => {
    expect(REVIEW_SNIPPET_EXTRACTOR_SOURCE).not.toMatch(/\$\{/);
    expect(REVIEW_SNIPPET_EXTRACTOR_SOURCE).not.toContain("functionSource");
    expect(REVIEW_SNIPPET_EXTRACTOR_SOURCE).toContain("__MAX_ITEMS__");
    expect(REVIEW_SNIPPET_EXTRACTOR_SOURCE).toContain("document.querySelectorAll");
  });

  it("buildReviewSnippetExtractionExpression 替换占位并校验上限", () => {
    const expression = buildReviewSnippetExtractionExpression({ maxItems: 5 });
    expect(expression).toContain("const MAX_ITEMS = 5;");
    expect(expression).not.toContain("__MAX_ITEMS__");
    expect(() => buildReviewSnippetExtractionExpression({ maxItems: 0 })).toThrow();
    expect(() => buildReviewSnippetExtractionExpression({ maxItems: 21 })).toThrow();
  });

  it("隔离作用域执行：提取星级/日期/标题", () => {
    const expression = buildReviewSnippetExtractionExpression({ maxItems: 10 });
    const result = runExpression<ReviewSnippet[]>(expression, fakeDom());
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      rating: 5,
      date: "August 1, 2026",
      title: "Fits perfectly",
      reviewText: "Fits perfectly and feels premium.",
      verifiedPurchase: true,
    });
    // 第二条无 rating/日期 → null 字段
    expect(result[1].rating).toBeNull();
    expect(result[1].date).toBe("");
    expect(result[1].title).toContain("Assembly instructions are confusing.");
    expect(result[1].reviewText).toBe("Assembly instructions are confusing.");
    expect(result[1].verifiedPurchase).toBe(false);
  });

  it("maxItems 截断生效", () => {
    const expression = buildReviewSnippetExtractionExpression({ maxItems: 1 });
    const result = runExpression<ReviewSnippet[]>(expression, fakeDom());
    expect(result).toHaveLength(1);
  });

  it("兼容当前 Amazon Top Reviews 的 reviewTitle/reviewRichContentContainer", () => {
    const expression = buildReviewSnippetExtractionExpression({ maxItems: 10 });
    const result = runExpression<ReviewSnippet[]>(expression, amazonCurrentReviewDom());
    expect(result).toEqual([{
      rating: 5,
      date: "December 14, 2019",
      title: "The device that just keeps getting better and better with each revision",
      reviewText: "Okay so first off I'd like to say that this is a real public review.",
      verifiedPurchase: true,
    }]);
  });
});

describe("Review DOM readiness（有界等待与诚实空态）", () => {
  function readinessDom(input: { title: boolean; reviewCount: number; body: string; onScroll?: () => void; reviewCountAfterScroll?: number }) {
    let reviewCount = input.reviewCount;
    return {
      title: "Amazon product",
      body: { innerText: input.body },
      querySelector: (selector: string) => selector === "#productTitle" && input.title ? {} : null,
      querySelectorAll: (selector: string) => selector === '[data-hook="review"]' ? Array.from({ length: reviewCount }, () => ({})) : [],
      window: {
        innerHeight: 800,
        scrollBy: () => {
          input.onScroll?.();
          if (typeof input.reviewCountAfterScroll === "number") reviewCount = input.reviewCountAfterScroll;
        },
      },
    };
  }

  it("商品标题和 review DOM 都就绪时返回节点数", async () => {
    const expression = buildReviewDomReadinessExpression({ timeoutMs: 0, pollIntervalMs: 10 });
    const factory = new Function("document", "window", `return ${expression}`) as (document: unknown, window: unknown) => Promise<unknown>;
    const dom = readinessDom({ title: true, reviewCount: 3, body: "Product details" });
    const result = await factory(dom, dom.window);
    expect(result).toMatchObject({ productTitlePresent: true, reviewNodeCount: 3, bodyNodeCount: 0, explicitNoReviews: false, pageTitle: "Amazon product", retryAttempt: 0, scrollTriggered: false });
  });

  it("正文节点数只统计公开 Review card 中的非空正文 selector", async () => {
    const expression = buildReviewDomReadinessExpression({ timeoutMs: 0, pollIntervalMs: 10 });
    const factory = new Function("document", "window", `return ${expression}`) as (document: unknown, window: unknown) => Promise<any>;
    const dom = readinessDom({ title: true, reviewCount: 2, body: "Product details" });
    dom.querySelectorAll = (selector: string) => selector === '[data-hook="review"]'
      ? Array.from({ length: 2 }, () => ({
        textContent: "Public review card",
        querySelector: (bodySelector: string) => bodySelector.includes("review-body")
          ? { textContent: "Visible review body" }
          : null,
      }))
      : [];

    const result = await factory(dom, dom.window);
    expect(result).toMatchObject({ reviewNodeCount: 2, bodyNodeCount: 2 });
  });

  it("首次为空时触发一次轻量滚动，第二次出现评论则通过", async () => {
    const expression = buildReviewDomReadinessExpression({ timeoutMs: 0, pollIntervalMs: 10 });
    const factory = new Function("document", "window", `return ${expression}`) as (document: unknown, window: unknown) => Promise<any>;
    let scrolled = 0;
    const dom = readinessDom({ title: true, reviewCount: 0, body: "Product details", onScroll: () => { scrolled += 1; }, reviewCountAfterScroll: 2 });
    const result = await factory(dom, dom.window);
    expect(scrolled).toBe(1);
    expect(result).toMatchObject({ productTitlePresent: true, reviewNodeCount: 2, explicitNoReviews: false, retryAttempt: 1, scrollTriggered: true });
  });

  it("重试窗口内评论仍未出现时，按固定间隔继续向评论区推进直至懒加载触发", async () => {
    const expression = buildReviewDomReadinessExpression({ timeoutMs: 600, pollIntervalMs: 10, scrollStepMs: 20 });
    const factory = new Function("document", "window", `return ${expression}`) as (document: unknown, window: unknown) => Promise<any>;
    let scrollCalls = 0;
    let reviewCount = 0;
    const dom = {
      title: "Amazon product",
      body: { innerText: "Product details" },
      querySelector: (selector: string) => (selector === "#productTitle" ? {} : null),
      querySelectorAll: (selector: string) => (selector === '[data-hook="review"]' ? Array.from({ length: reviewCount }, () => ({})) : []),
      documentElement: null,
      window: {
        innerHeight: 800,
        scrollY: 0,
        scrollBy: () => {
          scrollCalls += 1;
          if (scrollCalls >= 3) reviewCount = 2;
        },
      },
    };
    const result = await factory(dom, dom.window);
    expect(scrollCalls).toBeGreaterThanOrEqual(3);
    expect(result).toMatchObject({ productTitlePresent: true, reviewNodeCount: 2, retryAttempt: 1, scrollTriggered: true });
  });

  it("评论始终不出现时如实报未完成提取，滚动有界且页底后停止", async () => {
    const expression = buildReviewDomReadinessExpression({ timeoutMs: 300, pollIntervalMs: 10, scrollStepMs: 40 });
    const factory = new Function("document", "window", `return ${expression}`) as (document: unknown, window: unknown) => Promise<any>;
    let scrollCalls = 0;
    const dom = {
      title: "Amazon product",
      body: { innerText: "Product details" },
      querySelector: (selector: string) => (selector === "#productTitle" ? {} : null),
      querySelectorAll: () => [],
      documentElement: { scrollHeight: 3000 },
      window: {
        innerHeight: 800,
        get scrollY() { return scrollCalls * 900; },
        scrollBy: () => { scrollCalls += 1; },
      },
    };
    const result = await factory(dom, dom.window);
    expect(result).toMatchObject({ productTitlePresent: true, reviewNodeCount: 0, explicitNoReviews: false, retryAttempt: 1, scrollTriggered: true });
    // 页高 3000、视口 800：渐进步进 900px，触底后 scrollViewport 返回 false，次数受页高约束
    expect(scrollCalls).toBeLessThanOrEqual(4);
  });

  it("明确无评论信号与提取为空严格分开", async () => {
    const expression = buildReviewDomReadinessExpression({ timeoutMs: 0, pollIntervalMs: 10 });
    const factory = new Function("document", "window", `return ${expression}`) as (document: unknown, window: unknown) => Promise<any>;
    const confirmedDom = readinessDom({ title: true, reviewCount: 0, body: "Be the first to review this product" });
    const emptyDom = readinessDom({ title: true, reviewCount: 0, body: "Product details" });
    const confirmed = await factory(confirmedDom, confirmedDom.window);
    const empty = await factory(emptyDom, emptyDom.window);
    expect(confirmed.explicitNoReviews).toBe(true);
    expect(empty.explicitNoReviews).toBe(false);
    expect(empty.reviewNodeCount).toBe(0);
    expect(empty.retryAttempt).toBe(1);
    expect(empty.scrollTriggered).toBe(true);
  });

  it("源码是显式自包含工件并替换有界参数", () => {
    expect(REVIEW_DOM_READINESS_SOURCE).toContain("__TIMEOUT_MS__");
    expect(REVIEW_DOM_READINESS_SOURCE).toContain("__POLL_INTERVAL_MS__");
    expect(REVIEW_DOM_READINESS_SOURCE).toContain("__SCROLL_STEP_MS__");
    expect(buildReviewDomReadinessExpression({ timeoutMs: 500, pollIntervalMs: 50 })).toContain("const TIMEOUT_MS = 500;");
    expect(() => buildReviewDomReadinessExpression({ timeoutMs: 30_001 })).toThrow();
    expect(() => buildReviewDomReadinessExpression({ scrollStepMs: 5_001 })).toThrow();
  });
});
