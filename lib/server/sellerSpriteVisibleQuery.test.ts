import { describe, expect, it, vi } from "vitest";

import {
  SELLERSPRITE_QUERY_ADAPTERS,
  assertSellerSpriteSubjectIdentity,
  hasPageSpecificResultChanged,
  hasVisiblePageTransitionResult,
  isSellerSpriteSourceLimitDeclared,
  isSellerSpriteQueryPageUrl,
  sellerSpriteQueryFingerprint,
  sellerSpriteKeywordMiningQuerySubjectKey,
  sellerSpriteProductMarketQuerySubjectKey,
  validateSellerSpriteQueryInput,
  visibleSnapshotCore,
  type SellerSpriteQuerySnapshot,
} from "@/lib/server/sellerSpriteVisibleQuery";

function snapshot(overrides: Partial<SellerSpriteQuerySnapshot> = {}): SellerSpriteQuerySnapshot {
  return {
    pageTitle: "SellerSprite",
    bodyText: "",
    tables: [],
    queryInputs: [],
    marketplaceEcho: "US",
    loading: false,
    gate: null,
    empty: false,
    queryError: false,
    ...overrides,
  };
}

describe("SellerSprite one-shot visible query contracts", () => {
  it("uses a category query subject for Product Market and rejects an ASIN subject", () => {
    const queryInput = { module: "sellersprite_product_market" as const, category: "Kitchen & Dining", marketplace: "US" as const };
    const subjectKey = sellerSpriteProductMarketQuerySubjectKey(queryInput);
    expect(subjectKey).toMatch(/^sellersprite:US:product-market:[a-f0-9]{64}$/u);
    expect(() => assertSellerSpriteSubjectIdentity({
      module: "sellersprite_product_market", subjectKey, identity: { category: "Kitchen & Dining" }, queryInput,
    })).not.toThrow();
    expect(() => assertSellerSpriteSubjectIdentity({
      module: "sellersprite_product_market", subjectKey: "amazon:US:B000000001", identity: { category: "Kitchen & Dining" }, queryInput,
    })).toThrow("SELLERSPRITE_PRODUCT_MARKET_QUERY_IDENTITY_MISMATCH");
    expect(() => assertSellerSpriteSubjectIdentity({
      module: "sellersprite_product_market", subjectKey, identity: { category: "Garden" }, queryInput,
    })).toThrow("SELLERSPRITE_PRODUCT_MARKET_QUERY_IDENTITY_MISMATCH");
  });

  it("gives Keyword Mining a deterministic seedKeyword subject independent of every batch ASIN", () => {
    const queryInput = { module: "keyword_mining_trend" as const, seedKeyword: "silicone baking mat", marketplace: "US" as const };
    const subjectKey = sellerSpriteKeywordMiningQuerySubjectKey(queryInput);
    expect(subjectKey).toMatch(/^sellersprite:US:keyword-mining:[a-f0-9]{64}$/u);
    expect(subjectKey).toBe(sellerSpriteKeywordMiningQuerySubjectKey({ ...queryInput, conditions: {} }));
    expect(subjectKey).not.toBe("amazon:US:B000000001");
    expect(subjectKey).not.toBe(sellerSpriteKeywordMiningQuerySubjectKey({ ...queryInput, seedKeyword: "silicone baking sheet" }));
  });

  it("reads the reported row total from the visible pagination label", () => {
    const node = (text: string) => ({
      textContent: text,
      innerText: text,
      disabled: false,
      className: "",
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 80, height: 24 }),
    });
    const activePage = node("2");
    let bodyText = "51 - 100/5,416";
    let pagerTotalLabel = "/5,416";
    const pager = {
      ...node(""),
      querySelector: (selector: string) => selector === ".el-pager li.active, [aria-current='page']"
        ? activePage
        : selector === ".all-page-num" ? node(pagerTotalLabel) : null,
      querySelectorAll: (selector: string) => selector === ".el-pager li.number"
        ? [node("1"), node("2")]
        : selector.includes("button.btn-next") ? [node("下一页")] : [],
    };
    vi.stubGlobal("document", {
      body: { get innerText() { return bodyText; }, scrollHeight: 800 },
      documentElement: { scrollHeight: 800 },
      querySelectorAll: (selector: string) => selector === ".el-pagination" ? [pager] : [],
    });
    vi.stubGlobal("window", {
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", overflowY: "visible" }),
      innerHeight: 800,
      scrollY: 0,
    });

    try {
      const snapshot = visibleSnapshotCore("NEVER_MATCHES");
      expect(snapshot.traversal).toMatchObject({ pageNumber: 2, reportedTotalRows: 5416 });

      bodyText = "搜索结果数: 492";
      pagerTotalLabel = "/20";
      expect(visibleSnapshotCore("NEVER_MATCHES").traversal?.reportedTotalRows).toBe(492);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("recognizes the visible membership result limit without matching generic upgrade copy", () => {
    expect(isSellerSpriteSourceLimitDeclared("主人~ 您当前的会员版本无法查看全部结果")).toBe(true);
    expect(isSellerSpriteSourceLimitDeclared("结果列表已加载，升级套餐可了解更多")).toBe(false);
  });

  it("validates distinct Product Research category input and result table", () => {
    const input = validateSellerSpriteQueryInput({ module: "sellersprite_product_market", category: "Kitchen", marketplace: "US", filters: { priceMin: "10" } }, "sellersprite_product_market");
    const adapter = SELLERSPRITE_QUERY_ADAPTERS.sellersprite_product_market;
    expect(adapter.inputSelector).toContain("category");
    expect(adapter.identityInput(input)).toBe("Kitchen");
    expect(adapter.hasCompletionSignal(snapshot({
      queryInputs: ["Kitchen", "10"],
      tables: [{ headers: ["ASIN", "商品名称"], rows: [["B012345678", "Insulated bottle"]] }],
    }), "Kitchen", { priceMin: "10" })).toBe(true);
    expect(adapter.hasCompletionSignal(snapshot({
      queryInputs: ["Other"],
      tables: [{ headers: ["ASIN"], rows: [["B012345678"]] }],
    }), "Kitchen")).toBe(false);
  });

  it("requires Reverse ASIN query echo to match the target ASIN", () => {
    const input = validateSellerSpriteQueryInput({ module: "reverse_asin", targetAsin: "b012345678", marketplace: "US" }, "reverse_asin");
    const adapter = SELLERSPRITE_QUERY_ADAPTERS.reverse_asin;
    expect(adapter.inputSelector).toContain("asin");
    expect(adapter.identityInput(input)).toBe("B012345678");
    const result = { headers: ["关键词", "月搜索量"], rows: [["example", "unknown"]] };
    expect(adapter.hasCompletionSignal(snapshot({ queryInputs: ["B012345678"], tables: [result] }), "B012345678")).toBe(true);
    expect(adapter.hasCompletionSignal(snapshot({ queryInputs: ["B099999999"], tables: [result] }), "B012345678")).toBe(false);
  });

  it("requires Keyword Mining seed and its own keyword table signal", () => {
    const input = validateSellerSpriteQueryInput({ module: "keyword_mining_trend", seedKeyword: "water bottle", marketplace: "US" }, "keyword_mining_trend");
    const adapter = SELLERSPRITE_QUERY_ADAPTERS.keyword_mining_trend;
    expect(adapter.inputSelector).toContain("keyword");
    expect(adapter.identityInput(input)).toBe("water bottle");
    expect(adapter.hasCompletionSignal(snapshot({
      queryInputs: ["water bottle"],
      tables: [{ headers: ["关键词", "搜索量"], rows: [["insulated bottle"]] }],
    }), "water bottle")).toBe(true);
  });

  it("rejects module mismatch, invalid ASIN, unsupported marketplace, and malformed conditions", () => {
    expect(() => validateSellerSpriteQueryInput({ module: "reverse_asin", targetAsin: "short", marketplace: "US" }, "reverse_asin")).toThrow("SELLERSPRITE_TARGET_ASIN_INVALID");
    expect(() => validateSellerSpriteQueryInput({ module: "keyword_mining_trend", seedKeyword: "water", marketplace: "CA" }, "keyword_mining_trend")).toThrow("SELLERSPRITE_MARKETPLACE_UNSUPPORTED");
    expect(() => validateSellerSpriteQueryInput({ module: "keyword_mining_trend", seedKeyword: "water", marketplace: "US", conditions: [] }, "keyword_mining_trend")).toThrow("SELLERSPRITE_CONDITIONS_INVALID");
    expect(() => validateSellerSpriteQueryInput({ module: "keyword_mining_trend", seedKeyword: "water", marketplace: "US", conditions: { searchVolumeMin: "   " } }, "keyword_mining_trend")).toThrow("SELLERSPRITE_CONDITION_VALUE_INVALID");
    expect(() => validateSellerSpriteQueryInput({ module: "keyword_mining_trend", seedKeyword: "water", marketplace: "US", conditions: { email: "value" } }, "keyword_mining_trend")).toThrow("SELLERSPRITE_CONDITION_KEY_INVALID");
    expect(() => validateSellerSpriteQueryInput({ module: "reverse_asin", targetAsin: "B012345678", marketplace: "US" }, "keyword_mining_trend")).toThrow("SELLERSPRITE_QUERY_MODULE_MISMATCH");
  });

  it("does not report result completion while loading or without page-specific headers", () => {
    const adapter = SELLERSPRITE_QUERY_ADAPTERS.reverse_asin;
    expect(adapter.hasCompletionSignal(snapshot({
      queryInputs: ["B012345678"], loading: true,
      tables: [{ headers: ["ASIN"], rows: [["B012345678"]] }],
    }), "B012345678")).toBe(false);
    expect(adapter.hasCompletionSignal(snapshot({
      queryInputs: ["B012345678"],
      tables: [{ headers: ["ASIN"], rows: [["B012345678"]] }],
    }), "B012345678")).toBe(false);
  });

  it("requires the selected module result table itself to change", () => {
    const oldKeywordTable = { headers: ["关键词", "搜索量"], rows: [["water bottle", "100"]] };
    const before = snapshot({ tables: [oldKeywordTable] });
    const afterWithUnrelatedChange = snapshot({
      tables: [
        oldKeywordTable,
        { headers: ["ASIN", "商品名称"], rows: [["B012345678", "New unrelated item"]] },
      ],
    });

    expect(hasPageSpecificResultChanged(before, afterWithUnrelatedChange, "keyword_mining_trend")).toBe(false);
    expect(SELLERSPRITE_QUERY_ADAPTERS.keyword_mining_trend.hasCompletionSignal(
      snapshot({ ...afterWithUnrelatedChange, queryInputs: ["water bottle"] }),
      "water bottle",
    )).toBe(true);
  });

  it("does not accept a next-page number while the previous page rows are still visible", () => {
    const headers = ["关键词", "搜索量"];
    const previous = snapshot({
      traversal: {
        page: 3, pageNumber: 3, pageCount: 32, scrollY: 0, scrollTarget: null,
        clientHeight: 0, scrollHeight: 0, hasNextPage: true, nextPageDisabled: false,
        sourceLimitDeclared: false, reportedTotalRows: 1564, accessibleRows: null, unavailableRows: null,
      },
      tables: [{ headers, rows: [["phone desk stand", "846"]] }],
    });
    const stalePageFour = snapshot({
      ...previous,
      traversal: { ...previous.traversal!, page: 4, pageNumber: 4 },
    });
    const loadedPageFour = snapshot({
      ...stalePageFour,
      tables: [{ headers, rows: [["iphone 17 pro max stand", "812"]] }],
    });

    expect(hasVisiblePageTransitionResult({ previous, snapshot: stalePageFour, module: "keyword_mining_trend", nextPage: 4 })).toBe(false);
    expect(hasVisiblePageTransitionResult({ previous, snapshot: loadedPageFour, module: "keyword_mining_trend", nextPage: 4 })).toBe(true);
  });

  it("keeps the three official page types separate from Category Market", () => {
    expect(isSellerSpriteQueryPageUrl("https://www.sellersprite.com/v3/product-research/", "sellersprite_product_market")).toBe(true);
    expect(isSellerSpriteQueryPageUrl("https://www.sellersprite.com/v2/market-research", "sellersprite_product_market")).toBe(false);
    expect(isSellerSpriteQueryPageUrl("https://www.sellersprite.com/v3/keyword-reverse/", "reverse_asin")).toBe(true);
    expect(isSellerSpriteQueryPageUrl("https://www.sellersprite.com/v3/keyword-reverse/", "keyword_mining_trend")).toBe(false);
    expect(isSellerSpriteQueryPageUrl("http://www.sellersprite.com/v3/keyword-mining/", "keyword_mining_trend")).toBe(false);
  });

  it("accepts the real Keyword Mining page (/v3/keyword-miner) and legacy aliases", () => {
    // 真实页面实测为 /v3/keyword-miner；keyword-mining / keyword-research 为历史别名
    expect(isSellerSpriteQueryPageUrl("https://www.sellersprite.com/v3/keyword-miner", "keyword_mining_trend")).toBe(true);
    expect(isSellerSpriteQueryPageUrl("https://www.sellersprite.com/v3/keyword-miner/?q=water%20bottle&marketId=1&batch=0", "keyword_mining_trend")).toBe(true);
    expect(isSellerSpriteQueryPageUrl("https://www.sellersprite.com/v3/keyword-mining/", "keyword_mining_trend")).toBe(true);
    expect(isSellerSpriteQueryPageUrl("https://www.sellersprite.com/v3/keyword-miner", "reverse_asin")).toBe(false);
    expect(isSellerSpriteQueryPageUrl("https://www.sellersprite.com/v3/keyword-miner", "sellersprite_product_market")).toBe(false);
  });

  it("fingerprints module, marketplace, query and visible conditions deterministically", () => {
    const first = { module: "sellersprite_product_market", category: "Kitchen", marketplace: "US", filters: { priceMin: "10", ratingMin: "4" } } as const;
    const reordered = { module: "sellersprite_product_market", category: "Kitchen", marketplace: "US", filters: { ratingMin: "4", priceMin: "10" } } as const;
    expect(sellerSpriteQueryFingerprint(first)).toBe(sellerSpriteQueryFingerprint(reordered));
    expect(sellerSpriteQueryFingerprint(first)).not.toBe(sellerSpriteQueryFingerprint({ ...first, filters: { ...first.filters, ratingMin: "5" } }));
    expect(sellerSpriteQueryFingerprint(first, "access-scope-a")).not.toBe(sellerSpriteQueryFingerprint(first, "access-scope-b"));
  });
});
