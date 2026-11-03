import { describe, expect, it } from "vitest";
import {
  amazonProductUrl,
  formatMoneyValue,
  formatRatingDisplay,
  formatReviewCountDisplay,
  resolveGalleryGaps,
  resolveGalleryTitle,
  resolveReviewNavigation,
  resolveUsagePresentation,
  type GalleryItem,
} from "./presentation";

function item(overrides: Partial<GalleryItem> = {}): GalleryItem {
  return {
    id: "item-1",
    asin: "B0TEST1234",
    title: "Halloween Banner Paper Fan Balloons",
    usageStatus: "needs_review",
    ...overrides,
  };
}

describe("resolveGalleryTitle", () => {
  it("DERIVED_FROM_CATEGORY 只作为类目辅助，不得冒充中文商品名", () => {
    const title = resolveGalleryTitle(item({
      chineseTitle: "家居与厨房",
      chineseTitleStatus: "DERIVED_FROM_CATEGORY",
      chineseCategory: "家居与厨房",
    }));
    expect(title.primary).toBe("Halloween Banner Paper Fan Balloons");
    expect(title.primaryIsChinese).toBe(false);
    expect(title.categoryNote).toBe("家居与厨房");
    expect(title.titleSource).toBe("ORIGINAL_TITLE");
  });

  it("权威中文标题优先，并保留英文原标题可查看", () => {
    const title = resolveGalleryTitle(item({
      chineseTitle: "万圣节纸扇气球横幅",
      chineseTitleStatus: "AUTHORITATIVE_CHINESE_TITLE",
      title: "Halloween Banner Paper Fan Balloons",
    }));
    expect(title.primary).toBe("万圣节纸扇气球横幅");
    expect(title.primaryIsChinese).toBe(true);
    expect(title.secondaryOriginal).toBe("Halloween Banner Paper Fan Balloons");
  });

  it("无标题时退到品牌 · 类目，再退到 ASIN，不生成空标题", () => {
    const withBrand = resolveGalleryTitle(item({ title: null, brand: "Dashsafe", chineseCategory: "乐器" }));
    expect(withBrand.primary).toBe("Dashsafe · 乐器");
    const onlyAsin = resolveGalleryTitle(item({ title: null, brand: null, chineseCategory: null, category: null }));
    expect(onlyAsin.primary).toBe("B0TEST1234");
    expect(onlyAsin.titleSource).toBe("FALLBACK");
  });

  it("UNAVAILABLE 中文标题不进入主标题或类目辅助", () => {
    const title = resolveGalleryTitle(item({
      chineseTitle: null,
      chineseTitleStatus: "UNAVAILABLE",
      chineseCategory: null,
      category: "Home & Kitchen",
    }));
    expect(title.primary).toBe("Halloween Banner Paper Fan Balloons");
    expect(title.categoryNote).toBe("Home & Kitchen");
  });
});

describe("formatMoneyValue", () => {
  it("按真实币种格式化，未知币种保留代码而不是默认美元", () => {
    expect(formatMoneyValue(14.97, "USD")?.text).toBe("$14.97");
    expect(formatMoneyValue(14.97, "EUR")?.text).toBe("\u20ac14.97");
    expect(formatMoneyValue(1480, "JPY")?.text).toBe("\u00a51,480");
    expect(formatMoneyValue(9.5, "XYZ")?.text).toBe("9.50 XYZ");
  });

  it("缺失值与非法值返回 null，不补 0", () => {
    expect(formatMoneyValue(null, "USD")).toBeNull();
    expect(formatMoneyValue(undefined, "USD")).toBeNull();
    expect(formatMoneyValue(Number.NaN, "USD")).toBeNull();
  });
});

describe("评分/评论诚实展示", () => {
  it("冲突评论数不显示数字，只显示待核对", () => {
    const review = formatReviewCountDisplay({ value: 27477, status: "conflict" });
    expect(review.text).toBe("评论数待核对");
    expect(review.pending).toBe(true);
    expect(review.text).not.toContain("27");
  });

  it("确认评论数与缺失评论数分别表达", () => {
    expect(formatReviewCountDisplay({ value: 823, status: "confirmed" }).text).toBe("823 条评价");
    expect(formatReviewCountDisplay({ value: null, status: "missing" }).text).toBe("评论数缺失");
    expect(formatReviewCountDisplay(null).text).toBeNull();
  });

  it("评分冲突时不冒充确认值", () => {
    expect(formatRatingDisplay({ value: 4.7, status: "conflict" })).toEqual({ text: "评分待核对", pending: true });
    expect(formatRatingDisplay({ value: 4.7, status: "confirmed" })).toEqual({ text: "4.7", pending: false });
    expect(formatRatingDisplay({ value: null, status: "missing" })).toBeNull();
  });
});

describe("resolveGalleryGaps", () => {
  it("最多两个缺口，优先级 无图 > 详情 > BSR", () => {
    const gaps = resolveGalleryGaps(item({
      image: null,
      imageStatus: "AUTHORITATIVE_IMAGE_MISSING",
      brand: null,
      bsr: null,
      enrichmentStatus: null,
    }));
    expect(gaps.map((gap) => gap.key)).toEqual(["image", "detail"]);
  });

  it("品牌缺失由品牌行表达，不重复占用缺口位", () => {
    const gaps = resolveGalleryGaps(item({
      image: "https://m.media-amazon.com/images/I/example.jpg",
      imageStatus: "AUTHORITATIVE_IMAGE_AVAILABLE",
      brand: null,
      bsr: { rank: 38, category: "Home & Kitchen" },
      enrichmentStatus: "enriched",
    }));
    expect(gaps).toEqual([]);
  });

  it("资料完整时不制造缺口", () => {
    const gaps = resolveGalleryGaps(item({
      image: "https://m.media-amazon.com/images/I/example.jpg",
      imageStatus: "AUTHORITATIVE_IMAGE_AVAILABLE",
      brand: "JOYIN",
      bsr: { rank: 38, category: "Home & Kitchen" },
      enrichmentStatus: "enriched",
    }));
    expect(gaps).toEqual([]);
  });
});

describe("resolveUsagePresentation", () => {
  it("归档优先于可用状态", () => {
    expect(resolveUsagePresentation({ usageStatus: "research_ready", archivedAt: "2026-10-21T00:00:00.000Z" }).label).toBe("已归档");
  });
});

describe("amazonProductUrl", () => {
  it("按站点生成来源链接，未知站点回落美国站，非法 ASIN 返回 null", () => {
    expect(amazonProductUrl("B08GYNHQN3", "US")).toBe("https://www.amazon.com/dp/B08GYNHQN3");
    expect(amazonProductUrl("B08GYNHQN3", "JP")).toBe("https://www.amazon.co.jp/dp/B08GYNHQN3");
    expect(amazonProductUrl("B08GYNHQN3", "ZZ")).toBe("https://www.amazon.com/dp/B08GYNHQN3");
    expect(amazonProductUrl("bad", "US")).toBeNull();
  });
});


describe("resolveReviewNavigation（同屏检阅上下件）", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("中间商品同时有上一件和下一件，序号从 1 开始由调用方展示", () => {
    const nav = resolveReviewNavigation(items, "b");
    expect(nav.index).toBe(1);
    expect(nav.total).toBe(3);
    expect(nav.visible).toBe(true);
    expect(nav.canPrev).toBe(true);
    expect(nav.canNext).toBe(true);
    expect(nav.prevId).toBe("a");
    expect(nav.nextId).toBe("c");
  });

  it("首尾边界不循环到另一端", () => {
    expect(resolveReviewNavigation(items, "a").prevId).toBeNull();
    expect(resolveReviewNavigation(items, "a").nextId).toBe("b");
    expect(resolveReviewNavigation(items, "c").nextId).toBeNull();
    expect(resolveReviewNavigation(items, "c").prevId).toBe("b");
  });

  it("当前商品被筛选隐藏时不静默跳到另一件", () => {
    const nav = resolveReviewNavigation([{ id: "b" }, { id: "c" }], "a");
    expect(nav.visible).toBe(false);
    expect(nav.index).toBe(-1);
    expect(nav.canPrev).toBe(false);
    expect(nav.canNext).toBe(false);
    expect(nav.prevId).toBeNull();
    expect(nav.nextId).toBeNull();
  });

  it("空集合或未选中商品时没有上下件", () => {
    expect(resolveReviewNavigation([], "a")).toMatchObject({ index: -1, total: 0, visible: false, prevId: null, nextId: null });
    expect(resolveReviewNavigation(items, null)).toMatchObject({ index: -1, total: 3, visible: false, prevId: null, nextId: null });
  });
});
