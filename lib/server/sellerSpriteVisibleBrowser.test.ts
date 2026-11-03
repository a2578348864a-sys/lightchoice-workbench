import { describe, expect, it } from "vitest";

import {
  hasStructuredVisibleData,
  isSellerSpriteHomepage,
  matchSellerSpriteCategorySuggestion,
  pickSellerSpriteSubjectPage,
  type VisibleDomSnapshot,
} from "@/lib/server/sellerSpriteVisibleBrowser";

function snapshot(overrides: Partial<VisibleDomSnapshot> = {}): VisibleDomSnapshot {
  return {
    bodyText: "",
    tables: [],
    chartSurfaces: [],
    visibleLabels: [],
    ...overrides,
  };
}

describe("SellerSprite visible evidence classification", () => {
  it("binds two distinct exact categories and never falls back to the first suggestion", () => {
    const labels=["Kitchen & Dining", "Electronics"];
    expect(matchSellerSpriteCategorySuggestion("Electronics", labels)).toBe(1);
    expect(matchSellerSpriteCategorySuggestion("Kitchen & Dining", labels)).toBe(0);
    expect(matchSellerSpriteCategorySuggestion("Pet Supplies", labels)).toBe(-1);
    expect(matchSellerSpriteCategorySuggestion("Kitchen & Dining", [...labels, "Kitchen & Dining"])).toBe(-1);
    expect(matchSellerSpriteCategorySuggestion("", labels)).toBe(-1);
  });
  it("does not treat a page heading and an empty chart canvas as structured data", () => {
    expect(hasStructuredVisibleData(snapshot({
      chartSurfaces: [{ selector: "canvas:nth-of-type(1)", role: null, label: null, text: null }],
      visibleLabels: ["商品市场分析"],
    }))).toBe(false);
  });

  it("does not treat a table shell with only empty cells as structured data", () => {
    expect(hasStructuredVisibleData(snapshot({
      tables: [{
        selector: "#results",
        headers: ["ASIN", "Price"],
        rows: [[null, ""], [" ", null]],
        headerSource: "thead",
        headerStatus: "HEADER_OK",
        columnCount: 2,
      }],
    }))).toBe(false);
  });

  it("accepts a visible table containing actual values", () => {
    expect(hasStructuredVisibleData(snapshot({
      tables: [{
        selector: "#results",
        headers: ["ASIN", "Price"],
        rows: [["B012345678", "$12.99"]],
        headerSource: "thead",
        headerStatus: "HEADER_OK",
        columnCount: 2,
      }],
    }))).toBe(true);
  });

  it("【P2-2】无真实表头的表（表头槽里是数据行）一律不算结构化数据", () => {
    expect(hasStructuredVisibleData(snapshot({
      tables: [{
        // 症状：headers 与 rows[0] 相同（首行数据被当成表头）
        selector: "table:nth-of-type(1)",
        headers: [],
        rows: [["1", "kinto water bottle"], ["2", "kinto tumbler"]],
        headerSource: "none",
        headerStatus: "HEADER_NOT_FOUND",
        columnCount: 2,
      }],
    }))).toBe(false);
  });

  it("【P2-2】列数与表头不符时不得计入结构化数据", () => {
    expect(hasStructuredVisibleData(snapshot({
      tables: [{
        selector: "table:nth-of-type(2)",
        headers: [],
        rows: [["a", "b", "c"]],
        headerSource: "none",
        headerStatus: "ROW_COLUMN_MISMATCH",
        columnCount: 3,
      }],
    }))).toBe(false);
  });
});

describe("SellerSprite 主体采集页面选择（历史补证导航根因）", () => {
  const ASIN = "B01ACUA8HC";
  const home = "https://www.sellersprite.com/";
  const listPage = `https://www.sellersprite.com/v3/competitor-lookup?market=US&asins=%5B%22${ASIN}%22%5D&page=1`;
  const otherPage = "https://www.sellersprite.com/v3/keyword-miner?market=US&keyword=silicone";

  it("识别首页：只有首页才会被重新导航，用户已打开的结果页绝不覆盖", () => {
    expect(isSellerSpriteHomepage(home)).toBe(true);
    expect(isSellerSpriteHomepage("https://www.sellersprite.com/v3/")).toBe(true);
    expect(isSellerSpriteHomepage(listPage)).toBe(false);
    expect(isSellerSpriteHomepage("https://www.amazon.com/dp/B01ACUA8HC")).toBe(false);
    expect(isSellerSpriteHomepage("not-a-url")).toBe(false);
  });

  it("历史补证：已打开目标 ASIN 的抽屉时直接复用，不新建/不导航", () => {
    const picked = pickSellerSpriteSubjectPage({
      pages: [{ url: otherPage, drawerAsin: null }, { url: listPage, drawerAsin: ASIN }],
      asin: ASIN,
      module: "historical_trend",
    });
    expect(picked).toEqual({ index: 1, mode: "reused_confirmed_drawer" });
  });

  it("历史补证：URL 已含目标 ASIN 时复用该页（抽屉可稍后由正常点击打开）", () => {
    const picked = pickSellerSpriteSubjectPage({
      pages: [{ url: otherPage, drawerAsin: null }, { url: listPage, drawerAsin: null }],
      asin: ASIN,
      module: "historical_trend",
    });
    expect(picked).toEqual({ index: 1, mode: "reused_confirmed_url" });
  });

  it("只有首页时允许在首页导航到来源页；其他已打开页优先复用而不是导航", () => {
    expect(pickSellerSpriteSubjectPage({ pages: [{ url: home, drawerAsin: null }], asin: ASIN, module: "historical_trend" }))
      .toEqual({ index: 0, mode: "navigated_home_page" });
    expect(pickSellerSpriteSubjectPage({ pages: [{ url: otherPage, drawerAsin: null }], asin: ASIN, module: "historical_trend" }))
      .toEqual({ index: 0, mode: "reused_seller_page" });
  });

  it("没有任何来源页时才新建页面", () => {
    expect(pickSellerSpriteSubjectPage({ pages: [], asin: ASIN, module: "historical_trend" })).toBeNull();
  });

  it("用户在弹窗里选中的页面优先；选错页不会被偷偷换成别的页面", () => {
    const picked = pickSellerSpriteSubjectPage({
      pages: [{ url: otherPage, drawerAsin: null }, { url: listPage, drawerAsin: ASIN }],
      asin: ASIN,
      module: "historical_trend",
      preferredUrl: otherPage,
    });
    expect(picked).toEqual({ index: 0, mode: "reused_confirmed_url" });
    // 查竞品列表页 URL 不含 ASIN 时也可被选中：身份改由抽屉确认。
    const listPageWithoutAsin = "https://www.sellersprite.com/v3/competitor-lookup?market=US&keywords=silicone";
    expect(pickSellerSpriteSubjectPage({
      pages: [{ url: listPageWithoutAsin, drawerAsin: null }],
      asin: ASIN,
      module: "historical_trend",
      preferredUrl: listPageWithoutAsin,
    })).toEqual({ index: 0, mode: "reused_confirmed_url" });
  });

  it("商品补证同样优先复用已含该 ASIN 的页面", () => {
    expect(pickSellerSpriteSubjectPage({
      pages: [{ url: otherPage, drawerAsin: null }, { url: listPage, drawerAsin: null }],
      asin: ASIN,
      module: "sellersprite_product_market",
    })).toEqual({ index: 1, mode: "reused_confirmed_url" });
  });
});
