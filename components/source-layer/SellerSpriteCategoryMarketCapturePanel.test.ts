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
  type AmazonCategoryNode,
} from "@/components/source-layer/amazonCategoryDictionary";
import { shouldDisableSellerSpriteCapture, searchLocalCategories, summarizeCategoryMarketRows } from "@/components/source-layer/SellerSpriteCategoryMarketCapturePanel";

const panel = readFileSync(new URL("./SellerSpriteCategoryMarketCapturePanel.tsx", import.meta.url), "utf8");
const matchModule = readFileSync(new URL("../../lib/sourceLayer/sellerSpriteCategoryMatch.ts", import.meta.url), "utf8");
const latestResult = readFileSync(new URL("./LatestCategoryMarketCaptureResult.tsx", import.meta.url), "utf8");
const sourcePage = readFileSync(new URL("../source/SourceManagementClient.tsx", import.meta.url), "utf8");
const dictionary = readFileSync(new URL("./amazonCategoryDictionary.ts", import.meta.url), "utf8");

type FlatNode = { node: AmazonCategoryNode; depth: number; path: string[] };
function flatten(nodes: AmazonCategoryNode[], depth = 1, parentPath: string[] = []): FlatNode[] {
  return nodes.flatMap((node) => [{ node, depth, path: [...parentPath, node.amazonNodeId] }, ...flatten(node.children, depth + 1, [...parentPath, node.amazonNodeId])]);
}

const ALL_NODES = flatten(AMAZON_CATEGORY_DICTIONARY);
const STATS = AMAZON_CATEGORY_TAXONOMY_META.stats;

/**
 * 这两个来源都查不到任何子类目的一级类目（数字 / 服务型 storefront）。
 * 状态标记为 `NO_CHILD_IN_CURRENT_SOURCES`（当前来源无子类），**不代表 Amazon 官方绝对无子类**。
 */
const ROOTS_WITHOUT_SUBCATEGORIES = ["163856011", "8098158011", "599858", "10272111"];

const SAMPLED_ROOT_IDS = [
  "172282", // Electronics
  "7141123011", // Clothing, Shoes & Jewelry
  "15684181", // Automotive
  "2619533011", // Pet Supplies
  "165793011", // Toys & Games
  "1055398", // Home & Kitchen
];

describe("Category Market Capture entrance and feedback", () => {
  it("offers Chinese-first cascading category selection and a SellerSprite node confirmation step", () => {
    expect(panel).toContain("Amazon 类目选择");
    expect(panel).toContain("确认 SellerSprite 类目节点");
    expect(panel).toContain("查找对应的 SellerSprite 类目");
    expect(panel).toContain("采集类目市场");
    expect(panel).toContain("aria-pressed={selectedSellerSpriteNodeId === node.id}");
    expect(panel).toContain("buildSellerSpriteCategoryLookupQuery(amazonPathEn)");
    expect(panel).not.toContain("Amazon 类目关键词");
    expect(panel).not.toContain("category-market-query");
  });

  it("shows loading, actionable failure, and persisted estimate results", () => {
    expect(panel).toContain("正在查找 SellerSprite 类目…");
    expect(panel).toContain("正在采集类目市场…");
    expect(panel).toContain("role=\"alert\"");
    expect(panel).toContain("类目市场批次已保存到来源证据");
    expect(panel).toContain("SellerSprite 第三方估算");
    expect(panel).toContain("未标记为 Amazon 确认");
  });

  it("restores the latest saved market batch without starting another capture", () => {
    expect(panel).toContain('/api/source-layer/category-market/latest');
    expect(panel).toContain('cache: "no-store"');
    expect(panel).toContain("已从来源证据恢复上次类目市场批次");
    expect(panel).toContain("刷新后已恢复，无需重新搜索或采集。");
    expect(panel).toContain("CATEGORY_CAPTURE_RESTORE_FAILED");
  });

  it("places the three capture types side by side with purpose-specific labels", () => {
    expect(sourcePage).toContain("商品事实采集（ASIN）");
    expect(sourcePage).toContain("关键词市场");
    expect(sourcePage).toContain("类目市场");
    expect(sourcePage).toContain("SellerSpriteCategoryMarketCapturePanel");
    expect(sourcePage).toContain("showModeSelector={false}");
    expect(sourcePage).not.toContain("导入卖家精灵 XLSX");
    // P4-UX1：Keepa 收进「更多工具」，不作为与三主入口并列的第四个市场入口
    expect(sourcePage).toContain("more-tools");
    expect(sourcePage).toContain("导入 Keepa 趋势 CSV");
    expect(sourcePage).not.toContain("1688 供应链采集");
    expect(sourcePage).not.toContain("真实抓取仍需在受控授权下执行");
  });
});

describe.skipIf(!AMAZON_TAXONOMY_IMPORTED)("Amazon US 类目树数据覆盖门禁（防止再次缩水）", () => {
  it("保留完整的一级类目（38 个）并且除白名单外每个一级类目都有真实子节点", () => {
    expect(AMAZON_CATEGORY_DICTIONARY).toHaveLength(38);
    expect(STATS.rootCount).toBe(38);

    const emptyRoots = AMAZON_CATEGORY_DICTIONARY.filter((node) => node.children.length === 0).map((node) => node.amazonNodeId);
    expect(emptyRoots.sort()).toEqual([...ROOTS_WITHOUT_SUBCATEGORIES].sort());
    expect(STATS.rootsWithoutChildren.slice().sort()).toEqual([...ROOTS_WITHOUT_SUBCATEGORIES].sort());
    // 至少 34/38 个一级类目必须有真实子树（远高于「只有 Home & Kitchen」）
    expect(AMAZON_CATEGORY_DICTIONARY.filter((node) => node.children.length > 0).length).toBeGreaterThanOrEqual(34);
  });

  it("每个一级类目都带 childStatus，且空子节点只标 NO_CHILD_IN_CURRENT_SOURCES（不宣称官方无子类）", () => {
    const byId = new Map(STATS.rootsChildStatus.map((entry) => [entry.amazonNodeId, entry]));
    expect(byId.size).toBe(38);
    for (const node of AMAZON_CATEGORY_DICTIONARY) {
      const entry = byId.get(node.amazonNodeId);
      expect(entry, `missing childStatus for ${node.amazonNodeId}`).toBeDefined();
      expect(["HAS_CHILDREN", "NO_CHILD_IN_CURRENT_SOURCES"]).toContain(entry!.childStatus);
      expect(entry!.childCount).toBe(node.children.length);
      if (node.children.length === 0) expect(entry!.childStatus).toBe("NO_CHILD_IN_CURRENT_SOURCES");
      else expect(entry!.childStatus).toBe("HAS_CHILDREN");
    }
    // 文案不得出现「Amazon 官方无子类」这类断言
    expect(STATS.rootsChildStatus.some((entry) => entry.childStatus === "NO_CHILD_IN_CURRENT_SOURCES")).toBe(true);
    expect(JSON.stringify(STATS.rootsChildStatus)).not.toMatch(/OFFICIALLY_NO_CHILD|officialNoChild/u);
  });

  it("中文覆盖把「待确认」单独统计，不用 missingZhCount=0 掩盖", () => {
    expect(STATS.translatedZhCount + STATS.pendingZhCount).toBe(STATS.totalNodeCount);
    expect(STATS.translatedZhCount).toBeGreaterThan(0);
    expect(STATS.zhCoverageRate).toBeCloseTo((STATS.translatedZhCount / STATS.totalNodeCount) * 100, 1);
    const pendingBySuffix = ALL_NODES.filter((entry) => entry.node.zh.startsWith("中文待确认")).length;
    expect(pendingBySuffix).toBe(STATS.pendingZhCount);
    expect(AMAZON_CATEGORY_TAXONOMY_META.stats.pendingZhCount).toBe(STATS.pendingZhCount);
  });

  it("状态门禁：未完成官方完整树 diff 前，只能是 INTERIM_HIGH_COVERAGE", () => {
    const status = AMAZON_CATEGORY_TAXONOMY_META.taxonomyStatus;
    const diffStatus = AMAZON_CATEGORY_TAXONOMY_META.officialDiff?.status;
    if (diffStatus === "DIFF_COMPLETED") {
      expect(status).toBe("COMPLETE");
    } else {
      expect(status).toBe("INTERIM_HIGH_COVERAGE");
      expect(AMAZON_CATEGORY_TAXONOMY_META.amazonUsTaxonomy).toBe("INTERIM_HIGH_COVERAGE");
    }
    expect(TAXONOMY_STATUS).toBe(status);
    // 面板必须把状态与官方 diff 状态显示出来
    expect(panel).toContain("TAXONOMY_STATUS");
    expect(panel).toContain("amazon-taxonomy-official-diff");
  });


  it("全树显著大于一级类目数，且存在二级、三级与更深层级", () => {
    expect(ALL_NODES.length).toBeGreaterThan(AMAZON_CATEGORY_DICTIONARY.length * 5);
    expect(STATS.totalNodeCount).toBe(ALL_NODES.length);
    expect(STATS.level2Count).toBeGreaterThan(0);
    expect(STATS.level3Count).toBeGreaterThan(0);
    expect(STATS.maxDepth).toBeGreaterThanOrEqual(3);
    expect(ALL_NODES.some((entry) => entry.depth >= 3)).toBe(true);
  });

  it("不是只有 Home & Kitchen 有子树：多个完全不同主类目都必须有二三级真实路径", () => {
    const subtreeDepth = (node: AmazonCategoryNode): number =>
      1 + Math.max(0, ...node.children.map((child) => subtreeDepth(child)));

    for (const rootId of SAMPLED_ROOT_IDS) {
      const root = findAmazonCategoryByAmazonNodeId(rootId);
      expect(root, `missing root ${rootId}`).not.toBeNull();
      expect(root!.children.length, `root ${rootId} has no level-2 children`).toBeGreaterThan(0);

      // 必须至少有一个二级节点带真实三级子节点（不是只有 Home & Kitchen 才有子树）
      const level2WithChildren = root!.children.filter((child) => child.children.length > 0);
      expect(level2WithChildren.length, `root ${rootId} has no level-2 node with level-3 children`).toBeGreaterThan(0);

      // 该一级类目的子树必须达到三级及以上
      expect(subtreeDepth(root!), `root ${rootId} subtree depth must be >= 3`).toBeGreaterThanOrEqual(3);

      const deepLevel3 = level2WithChildren[0].children[0];
      const path = findAmazonCategoryPathByAmazonNodeId(rootId);
      expect(path.map((node) => node.amazonNodeId)).toEqual([rootId]);
      const deepPath = findAmazonCategoryPathByAmazonNodeId(deepLevel3.amazonNodeId);
      expect(deepPath.map((node) => node.amazonNodeId)).toEqual([
        rootId,
        level2WithChildren[0].amazonNodeId,
        deepLevel3.amazonNodeId,
      ]);
    }
  });

  it("node ID 全局唯一、中英文非空、来源与快照时间明确", () => {
    const ids = ALL_NODES.map((entry) => entry.node.amazonNodeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(STATS.duplicateAmazonNodeIds).toEqual([]);
    expect(ids.every((id) => /^\d+$/.test(id))).toBe(true);

    expect(ALL_NODES.every((entry) => entry.node.zh.trim().length > 0)).toBe(true);
    expect(ALL_NODES.every((entry) => entry.node.en.trim().length > 0)).toBe(true);
    expect(ALL_NODES.every((entry) => entry.node.sellerSpriteSearchTerm.trim().length > 0)).toBe(true);
    expect(STATS.missingZhCount).toBe(0);
    expect(STATS.missingEnCount).toBe(0);

    expect(AMAZON_CATEGORY_TAXONOMY_META.marketplace).toBe("US");
    expect(AMAZON_CATEGORY_TAXONOMY_META.source.kind.length).toBeGreaterThan(0);
    expect(String(AMAZON_CATEGORY_TAXONOMY_META.source.harvestedAt).length).toBeGreaterThan(0);
    expect(String(AMAZON_CATEGORY_TAXONOMY_META.generatedAt).length).toBeGreaterThan(0);
  });

  it("数据来自生成产物而不是手写数组", () => {
    expect(dictionary).toContain("amazon-us-taxonomy.v1.json");
    expect(dictionary).not.toContain('category("1055398"');
  });

  it("保留 Amazon 节点样例（Home & Kitchen → 厨房与餐饮 路径）", () => {
    expect(findAmazonCategoryByAmazonNodeId("1055398")).toMatchObject({
      zh: "家居与厨房",
      en: "Home & Kitchen",
      sellerSpriteSearchTerm: "kitchen",
    });
    const level2 = findAmazonCategoryByAmazonNodeId("284507");
    expect(level2).toMatchObject({ zh: "厨房与餐饮", en: "Kitchen & Dining" });
    expect(findAmazonCategoryByAmazonNodeId("1055398:284507")).toBeNull();
  });
});

describe.skipIf(!AMAZON_TAXONOMY_IMPORTED)("SellerSprite 候选中文优先双语展示", () => {
  it("把英文路径映射为中文优先，并保留英文原始路径", () => {
    const presented = presentSellerSpriteCategoryLabel("Home & Kitchen:Kitchen & Dining");
    expect(presented.zhPath).toBe("家居与厨房 > 厨房与餐饮");
    expect(presented.enPath).toBe("Home & Kitchen > Kitchen & Dining");
    expect(presented.fullyMatched).toBe(true);
  });

  it("无法匹配的片段保留英文原文，不做假翻译", () => {
    const presented = presentSellerSpriteCategoryLabel("Electronics:Nonexistent Category XYZ");
    expect(presented.zhPath).toBe("电子产品 > Nonexistent Category XYZ");
    expect(presented.fullyMatched).toBe(false);
    expect(presented.totalSegmentCount).toBe(2);
    expect(presented.matchedSegmentCount).toBe(1);
  });

  it("面板同时渲染中文优先路径与英文原文，并保留原始 label 与 SellerSprite ID", () => {
    expect(panel).toContain("presentSellerSpriteCategoryLabel");
    expect(panel).toContain("category-market-node-zh-");
    expect(panel).toContain("category-market-node-en-");
    expect(panel).toContain("title={node.label}");
    expect(panel).toContain("SellerSprite ID：{selectedSellerSpriteNode.id}");
  });

  it("级联选择不写死层数上限", () => {
    expect(panel).not.toMatch(/最多\s*三\s*级/);
    expect(panel).toContain("category.children");
    expect(panel).toContain("任意深度级联");
    expect(dictionary).not.toContain("MAX_CATEGORY_DEPTH");
  });

  it("真实 SellerSprite 路径的中文路径不残留可翻译英文段", () => {
    const samples = [
      "Electronics:Computers & Accessories",
      "Clothing, Shoes & Jewelry:Women",
      "Home & Kitchen:Kitchen & Dining:Storage & Organization",
      "Collectibles & Fine Art:Sports:Trading Cards",
      "Toys & Games:Party Supplies:Decorations",
      "Sports & Outdoors:Fan Shop:Sports Souvenirs:Trading Cards",
    ];
    for (const label of samples) {
      const presented = presentSellerSpriteCategoryLabel(label);
      expect(presented.untranslatedSegments, `${label} -> ${presented.zhPath}`).toEqual([]);
      expect(presented.fullyMatched).toBe(true);
      expect(presented.matchedSegmentCount).toBe(presented.totalSegmentCount);
    }
  });


  it("面板明确声明双语展示格式，并对未翻译片段给出提示", () => {
    expect(panel).toContain("category-market-bilingual-format");
    expect(panel).toContain("中文路径");
    expect(panel).toContain("English original path");
    expect(panel).toContain("category-market-node-untranslated-");
  });

});

describe("双 ID 流程与结果展示保持分离", () => {
  it("keeps the confirmed SellerSprite node ID separate from the selected Amazon node ID", () => {
    expect(panel).toContain("selectedSellerSpriteNodeId");
    expect(panel).toContain("categoryId: selectedSellerSpriteNodeId");
    expect(panel).toContain("Amazon 类目节点 ID：{selectedCategory?.amazonNodeId}");
    expect(panel).not.toContain("findAmazonCategoryPathById(node.id)");
    expect(latestResult).toContain('batch.category.label || "SellerSprite 类目"');
    expect(latestResult).not.toContain("formatAmazonCategoryLabel(batch.category.nodeId");
  });
});

describe("SellerSprite 候选匹配门禁（禁止默认第一条）", () => {
  it("UI 必须使用 shared matcher，禁止 candidates[0]/nodes[0] 自动选中", () => {
    expect(panel).toContain("matchSellerSpriteCandidate");
    expect(panel).toContain("isTrustedSellerSpriteMatch");
    expect(panel).toContain("sellerSpriteMatchBadge");
    expect(panel).toContain("amazonNodeId: selectedCategory.amazonNodeId");
    expect(panel).toContain("amazonPathEn");
    expect(panel).not.toMatch(/setSelectedSellerSpriteNodeId\(\s*nodes\s*\[\s*0\s*\]/);
    expect(panel).not.toMatch(/setSelectedSellerSpriteNodeId\(\s*payload\.data\.nodes\s*\[\s*0\s*\]/);
    // 查找后不得自动确认候选
    expect(panel).toContain('setSelectedSellerSpriteNodeId("")');
  });

  it("可信匹配展示明确提示，冲突时禁止采集", () => {
    expect(matchModule).toContain("精确节点匹配");
    expect(matchModule).toContain("推荐匹配");
    expect(panel).toContain("sellerSpriteMatchBadge");
    expect(panel).toContain("该 SellerSprite 节点与当前 Amazon 类目不匹配");
    expect(panel).toContain("canCapture");
    expect(panel).toContain("const captureDisabled = shouldDisableSellerSpriteCapture({ canCapture, cdpReachable })");
    expect(panel).toContain("disabled={captureDisabled}");
    expect(panel).toContain("category-market-match-blocked");
    expect(panel).toContain("category-market-node-badge-");
    expect(panel).toContain("data-match-type=");
  });

  it("Amazon 选择变化会清空 SellerSprite 确认，不自动改写 Amazon", () => {
    expect(panel).toContain("function selectCategoryAtLevel");
    expect(panel).toContain("function selectSellerSpriteNode");
    expect(panel).toContain("resetSelectionState()");
    // SellerSprite 确认不得反写 Amazon 路径
    const selectSellerSprite = panel.slice(panel.indexOf("function selectSellerSpriteNode"));
    const body = selectSellerSprite.slice(0, selectSellerSprite.indexOf("\n  }"));
    expect(body).not.toContain("setSelectedCategoryPath");
  });

  it("捕获请求携带 Amazon 上下文，供 fail-closed 校验", () => {
    expect(panel).toContain("amazonNodeId: selectedCategory.amazonNodeId");
    expect(panel).toContain("categoryId: selectedSellerSpriteNodeId");
    expect(panel).toContain("amazonPathEn,");
  });
});

describe("SellerSprite CDP 前置禁用（只提前禁用，不放宽服务端门禁）", () => {
  it("cdpReachable=false 才额外禁用；true/未知保持既有门禁（fail-open）", () => {
    expect(shouldDisableSellerSpriteCapture({ canCapture: true, cdpReachable: false })).toBe(true);
    expect(shouldDisableSellerSpriteCapture({ canCapture: true, cdpReachable: true })).toBe(false);
    expect(shouldDisableSellerSpriteCapture({ canCapture: true, cdpReachable: null })).toBe(false);
    expect(shouldDisableSellerSpriteCapture({ canCapture: true })).toBe(false);
    expect(shouldDisableSellerSpriteCapture({ canCapture: false, cdpReachable: true })).toBe(true);
  });

  it("挂载时只读预检一次，超时静默，且按钮旁显示原因", () => {
    expect(panel).toContain('fetch("/api/source-layer/capture-environment"');
    expect(panel).toContain("setTimeout(() => controller.abort(), 1500)");
    expect(panel).toContain("shouldDisableSellerSpriteCapture({ canCapture, cdpReachable })");
    expect(panel).toContain("SellerSprite CDP 不可达：先启动专用浏览器并登录");
    expect(panel).toContain("category-market-cdp-blocked");
    expect(panel).toContain("cdpReachable === false");
  });
});


describe.skipIf(!AMAZON_TAXONOMY_IMPORTED)("S04 本地查找与真实指标覆盖", () => {
  it("按真实节点身份定位任意深度，搜索不请求外部来源", () => {
    const hits = searchLocalCategories("284507");
    const hit = hits.find(item => item.node.amazonNodeId === "284507");
    expect(hit?.path).toEqual(["1055398", "284507"]);
    expect(searchLocalCategories("不存在的类目-no-match")).toEqual([]);
    expect(searchLocalCategories("   ")).toEqual([]);
    const deep = ALL_NODES.find(item => item.depth >= 5)!;
    expect(searchLocalCategories(deep.node.amazonNodeId).some(item => item.path.join(":") === deep.path.join(":"))).toBe(true);
  });
  it("零是有效估算，null 保持缺失；空返回不显示成功", () => {
    const row = {segment: {value: "受控测试", authority: "provider_derived" as const}, monthlyTotalSales: {value: 0, nature: "provider_estimate" as const}, averagePriceUsd: {value: null, nature: "provider_estimate" as const}, returnRatePercent: {value: 0, nature: "provider_estimate" as const}, warnings: []};
    expect(summarizeCategoryMarketRows([row])).toEqual({available: 2, total: 3, partial: true, empty: false});
    expect(summarizeCategoryMarketRows([])).toEqual({available: 0, total: 0, partial: false, empty: true});
    expect(summarizeCategoryMarketRows([{...row, averagePriceUsd: {...row.averagePriceUsd, value: 10}}])).toEqual({available: 3, total: 3, partial: false, empty: false});
  });
});
