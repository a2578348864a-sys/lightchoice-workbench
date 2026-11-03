/**
 * 来源层来源（seller_sprite_market_research）的事实候选提取。
 *
 * 症状：来源层候选进入研究后，fact-candidates 恒为 0 → 创作门禁
 * 停在 no_confirmed_facts，用户无法沿正常路径确认任何商品事实。
 *
 * 已确认的根因（两处断点，均在同一函数内）：
 *   A. extractFactCandidates 只读候选分析上下文里的 `facts.productFacts`，
 *      而 seller_sprite_market_research 分支把事实做成了**扁平投影**
 *      （facts.title / brand / priceUsd / rating / reviewCount / category），
 *      两者形状不匹配 → 品牌/价格/评分/评论数/类目全部读不到。
 *   B. 标题派生同样只从 browserEvidence 与 productFacts.productTitle 取标题，
 *      读不到扁平投影里的 facts.title → 材质/容量/颜色/数量等规格派生全部丢失。
 *
 * 本用例断言「修复后应有的行为」，不依赖任何 AI 或网络。
 */
import { describe, expect, it } from "vitest";

import { extractFactCandidates } from "@/lib/factCandidates";

/** 复刻 buildCandidateAnalysisContext 的 seller_sprite_market_research 分支输出形状。 */
function marketResearchContext(input: {
  title: string;
  brand?: string | null;
  category?: string | null;
  priceUsd?: number | null;
  rating?: number | null;
  reviewCount?: number | null;
}) {
  /* 注意：这里不能用 ?? 兜默认值——显式 null 表示「该字段缺失」，必须原样保留。 */
  return {
    version: "candidate-analysis-context-v1",
    integrity: "verified_seller_sprite",
    facts: {
      capturedAt: "2026-09-18T15:46:14.479Z",
      originKind: "seller_sprite_market_research",
      marketplace: "Amazon US",
      reportType: "SellerSprite Search Results",
      asin: "B004K6LHF2",
      parentAsin: null,
      productUrl: "https://www.amazon.com/dp/B004K6LHF2",
      title: input.title,
      imageUrl: null,
      priceUsd: "priceUsd" in input ? input.priceUsd : 3.28,
      rating: "rating" in input ? input.rating : 4.8,
      reviewCount: "reviewCount" in input ? input.reviewCount : 6323,
      brand: "brand" in input ? input.brand : null,
      category: "category" in input ? input.category : "Office Products",
      searchRank: null,
      estimatedMonthlySales: null,
      estimatedMonthlyRevenueUsd: null,
      disclaimer: "third_party_estimate_point_in_time",
    },
    assessment: { researchMode: "market_research_only", promotionEligible: false },
  };
}

const TITLE = "Five Star Spiral Notebook + Study App, 1 Subject, College Ruled Paper, 8.5\" x 11\", 100 Sheets, Blue (Color May Vary) (72565)";

function resultJson(input: Parameters<typeof marketResearchContext>[0]) {
  return {
    productName: input.title,
    candidateAnalysisContext: marketResearchContext(input),
  };
}

describe("来源层来源：扁平投影应产出事实候选（缺口 A）", () => {
  it("品牌/价格/评分/评论数/类目 从 verified_seller_sprite 扁平 facts 提取", () => {
    const candidates = extractFactCandidates(resultJson({
      title: TITLE,
      brand: "Five Star",
      category: "Office Products",
    }));
    const fields = candidates.map((c) => c.field);
    expect(fields).toContain("brand");
    expect(fields).toContain("price");
    expect(fields).toContain("rating");
    expect(fields).toContain("reviews");
    expect(fields).toContain("category");

    const brand = candidates.find((c) => c.field === "brand");
    expect(brand?.value).toBe("Five Star");
    const price = candidates.find((c) => c.field === "price");
    expect(price?.value).toBe(3.28);
    const reviews = candidates.find((c) => c.field === "reviews");
    expect(reviews?.value).toBe(6323);
    /* 来源可追溯：必须指向候选分析上下文的扁平 facts */
    expect(brand?.sourceKind).toBe("seller_sprite_product_facts");
    expect(brand?.sourceRef).toContain("candidateAnalysisContext.facts");
  });

  it("缺失的字段保持缺失，不产出候选（不猜测、不补全）", () => {
    const candidates = extractFactCandidates(resultJson({
      title: TITLE,
      brand: null,
      priceUsd: null,
      rating: null,
      reviewCount: null,
      category: null,
    }));
    const fields = candidates.map((c) => c.field);
    expect(fields).not.toContain("brand");
    expect(fields).not.toContain("price");
    expect(fields).not.toContain("rating");
    expect(fields).not.toContain("reviews");
    expect(fields).not.toContain("category");
  });

  it("全部候选都仍需人工确认（humanConfirmationRequired），绝不自动成为事实", () => {
    const candidates = extractFactCandidates(resultJson({ title: TITLE, brand: "Five Star" }));
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.humanConfirmationRequired).toBe(true);
    }
  });
});

describe("来源层来源：标题派生规格应可用（缺口 B）", () => {
  it("从扁平 facts.title 派生规格候选（真实推导能力范围内）", () => {
    const candidates = extractFactCandidates(resultJson({ title: TITLE }));
    const derived = candidates.filter((c) => c.sourceKind === "product_title");
    const byField = new Map(derived.map((c) => [c.field, c.value]));
    /* 标题里客观写着 Blue（颜色）与 100 Sheets（数量），既有推导器即可识别 */
    expect(byField.get("color_or_variant")).toBe("Blue");
    expect(byField.get("quantity_or_pack_size")).toBe("100 Sheets");
    /*
     * 说明：标题里的 8.5" x 11" 不会被推导成 dimensions——
     * deriveTitleProductFacts 只支持 material/capacity/color/quantity/productType/series，
     * 不对任意尺寸文本做推测。此处显式记录该边界，避免后来者误以为「标题有尺寸就该有 dimensions」。
     */
    expect(byField.has("dimensions")).toBe(false);
    for (const candidate of derived) {
      expect(candidate.humanConfirmationRequired).toBe(true);
      expect(candidate.sourceRef).toBe("product_title.derived");
    }
  });

  it("标题缺失时不派生任何规格（缺失保持缺失）", () => {
    const candidates = extractFactCandidates(resultJson({ title: "" }));
    expect(candidates.filter((c) => c.sourceKind === "product_title")).toEqual([]);
  });

  it("完整来源层形状可产出 Listing 所需的规格事实（≥2 项）", () => {
    const candidates = extractFactCandidates(resultJson({ title: TITLE }));
    const fields = new Set(candidates.map((c) => c.field));
    const specFields = ["material", "capacity", "color_or_variant", "quantity_or_pack_size"];
    const specCount = specFields.filter((f) => fields.has(f)).length;
    /* 标题里 Blue + 100 Sheets → 2 项规格事实，达到既有 Listing 规格门槛 */
    expect(specCount).toBeGreaterThanOrEqual(2);
    /*
     * 边界记录：product_type 目前不会从来源层形状推导出来——
     * extractFactCandidates 调用 deriveTitleProductFacts 时只传 title，不传 category，
     * 因此类目不会被当成商品类型使用。这是保守行为（宁可少推，不可误推），
     * 保留该项为「需人工补充」，不在此处扩大推导范围。
     */
    expect(fields.has("product_type")).toBe(false);
  });
});

describe("既有来源不得回归", () => {
  it("productFacts（ProductBatch）路径仍优先且不重复", () => {
    const candidates = extractFactCandidates({
      candidateAnalysisContext: {
        version: "candidate-analysis-context-v1",
        integrity: "verified_product_batch",
        facts: {
          capturedAt: "2026-08-01T00:00:00.000Z",
          originKind: "seller_sprite_product_batch",
          productBatchId: "b1",
          productBatchItemId: "i1",
          productName: "Closet organizer",
          marketplace: "US",
          asin: "B000000001",
          reportType: "search_results",
          query: null,
          category: null,
          researchPriority: "priority_1",
          evidenceStatus: "sufficient_for_comparison",
          provisionalDisposition: "provisional_score_only",
          evidenceHash: "a".repeat(64),
          itemHash: "b".repeat(64),
          sellerSpriteDisclaimerVersion: "v1",
          productFacts: { productTitle: "Closet organizer", brand: "Acme", price: 29.99 },
        },
        assessment: { researchMode: "market_research_only", promotionEligible: false },
      },
    });
    const brand = candidates.filter((c) => c.field === "brand");
    expect(brand).toHaveLength(1);
    expect(brand[0].value).toBe("Acme");
    expect(brand[0].sourceRef).toBe("seller_sprite.productFacts.brand");
  });

  it("空输入仍返回空候选", () => {
    expect(extractFactCandidates({})).toEqual([]);
    expect(extractFactCandidates(null)).toEqual([]);
  });
});
