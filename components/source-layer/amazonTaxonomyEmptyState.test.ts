import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AMAZON_CATEGORY_DICTIONARY,
  AMAZON_CATEGORY_TAXONOMY_META,
  AMAZON_TAXONOMY_IMPORTED,
  TAXONOMY_STATUS,
  findAmazonCategoryByAmazonNodeId,
  findAmazonCategoryPathByAmazonNodeId,
  presentSellerSpriteCategoryLabel,
  translateCategorySegment,
} from "./amazonCategoryDictionary";
import { searchLocalCategories, summarizeCategoryMarketRows } from "./SellerSpriteCategoryMarketCapturePanel";

const panelSource = readFileSync(new URL("./SellerSpriteCategoryMarketCapturePanel.tsx", import.meta.url), "utf8");

/**
 * 公开仓库不附带任何第三方类目数据。本文件锁定"无数据"这一默认状态：
 * 模块可加载、查询安全、面板展示空状态与导入提示，而不是崩溃。
 */
describe("公开版本无类目数据时的安全默认值", () => {
  it("dictionary 为空，状态明确为 NOT_IMPORTED", () => {
    expect(AMAZON_TAXONOMY_IMPORTED).toBe(false);
    expect(AMAZON_CATEGORY_DICTIONARY).toEqual([]);
    expect(TAXONOMY_STATUS).toBe("NOT_IMPORTED");
    expect(AMAZON_CATEGORY_TAXONOMY_META.stats.rootCount).toBe(0);
    expect(AMAZON_CATEGORY_TAXONOMY_META.stats.totalNodeCount).toBe(0);
    expect(AMAZON_CATEGORY_TAXONOMY_META.source.kind).toBe("not_imported");
  });

  it("按节点查找与路径查找在空数据下安全返回空值", () => {
    expect(findAmazonCategoryByAmazonNodeId("1055398")).toBeNull();
    expect(findAmazonCategoryPathByAmazonNodeId("1055398")).toEqual([]);
  });

  it("中文翻译在空词表下返回 null，不伪造翻译", () => {
    expect(translateCategorySegment("Home & Kitchen")).toBeNull();
    expect(presentSellerSpriteCategoryLabel("Home & Kitchen > Kitchen & Dining")).toBeTruthy();
  });

  it("本地搜索索引为空时不返回任何类目，也不抛错", () => {
    expect(searchLocalCategories("kitchen")).toEqual([]);
    expect(searchLocalCategories("")).toEqual([]);
  });

  it("空批次的质量汇总保持全零，不误报成功", () => {
    const summary = summarizeCategoryMarketRows([]);
    expect(summary.total).toBe(0);
    expect(summary.available).toBe(0);
    expect(summary.empty).toBe(true);
  });

  it("面板在无数据时展示空状态与导入提示（而不是渲染空树）", () => {
    expect(panelSource).toContain('data-testid="category-taxonomy-empty"');
    expect(panelSource).toContain("先导入类目字典");
    expect(panelSource).toContain("generate-amazon-us-category-tree.mjs");
    expect(panelSource).toContain("尚未导入类目字典");
  });
});
