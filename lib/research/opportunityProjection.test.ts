import { describe, expect, it } from "vitest";
import { buildSourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import { buildVocProjection } from "@/lib/research/vocProjection";
import { buildOpportunityProjection } from "@/lib/research/opportunityProjection";
import { VOC_STRENGTH_THRESHOLDS } from "@/lib/research/vocThresholds";
import { DEEP_RESEARCH_SCHEMA, type DeepResearchComparisonProjection } from "@/lib/research/deepResearchTypes";

const ASIN_A = "B0TEST0001";
const CAPTURED_AT = "2026-10-14T08:43:00.173Z";

function reviewFixture(input: { text: string; rating?: number }) {
  return {
    asin: ASIN_A,
    rating: input.rating ?? 5,
    title: "Review title",
    reviewText: input.text,
    reviewDate: "October 12, 2026",
    verifiedPurchase: true,
    sourceType: "amazon_review",
    sourceUrl: `https://www.amazon.com/product-reviews/${ASIN_A}`,
    bindingKind: "subject_local",
    bindingNote: null,
    completeness: "full",
    evidenceLevel: "source_observed",
  };
}

function reviewAttachment(input: { id: string; reviews: Array<Record<string, unknown>> }) {
  return buildSourceEvidenceAttachment({
    attachmentId: `att-${input.id}`,
    subjectKey: `amazon:US:${ASIN_A}`,
    kind: "v3_review_voc_v1",
    sourceType: "amazon_dom",
    capturedAt: CAPTURED_AT,
    payload: {
      schemaVersion: "capture-system-v3-module-evidence.v1",
      module: "review_voc",
      subjectKey: `amazon:US:${ASIN_A}`,
      marketplace: "US",
      capturedAt: CAPTURED_AT,
      provider: "amazon",
      sourceSurface: "amazon_product_reviews",
      status: "VALIDATED_AVAILABLE",
      metricNature: "source_observed",
      identity: { asin: ASIN_A },
      limitations: [],
      data: { outcome: "reviews_visible", reviewCount: input.reviews.length, reviews: input.reviews },
      evidenceOnly: true,
    },
  });
}

const comparisonFixture: DeepResearchComparisonProjection = {
  schemaVersion: DEEP_RESEARCH_SCHEMA,
  scanId: "scan-1",
  scanName: "测试对比",
  representativesSelected: true,
  roleCoverage: ["benchmark"],
  rows: [
    {
      asin: "B0COMP0001",
      subjectKey: "amazon:US:B0COMP0001",
      role: "benchmark",
      roleLabel: "基准商品",
      roleNote: null,
      title: "Wide Mouth Storage Container 32 oz",
      brand: "Brand",
      category: "Storage",
      price: { amount: 19.99, currency: "USD" },
      packCount: { value: 2, source: "title", raw: "2 Pack" },
      unitPrice: null,
      rating: 4.5,
      reviewCount: 1200,
      bsr: null,
      specs: [{ label: "容量", value: "32 oz", source: "title" }],
      capturedAt: CAPTURED_AT,
      missing: [],
      comparability: { level: "comparable", reason: "同品类同规格口径" },
    },
  ],
  differences: [],
  limitations: ["代表商品快照仅覆盖 1 件。"],
};

function vocOf(texts: Array<{ text: string; rating?: number }>) {
  return buildVocProjection({ attachments: [reviewAttachment({ id: "fixture", reviews: texts.map((item) => reviewFixture(item)) })] });
}

describe("开发机会：只消费明确负面反馈", () => {
  it("达到弱信号门槛的明确负面 → 生成机会，假设仍是待验证", () => {
    const voc = vocOf([
      { text: "It is hard to clean inside the ridges.", rating: 2 },
      { text: "Cleaning is hard, it takes forever.", rating: 2 },
    ]);
    const projection = buildOpportunityProjection({ voc, comparison: comparisonFixture });
    const cleaning = projection.opportunities.find((item) => item.id === "opp_clean_difficulty");
    expect(cleaning).toBeDefined();
    expect(cleaning?.strength).toBe("weak");
    expect(cleaning?.hypothesis).toContain("待验证");
    expect(cleaning?.humanStatus).toBe("pending");
    expect(cleaning?.problem).toContain(`${VOC_STRENGTH_THRESHOLDS.weakMin} 条明确负面反馈`);
    expect(cleaning?.evidence.length).toBeGreaterThan(0);
    expect(cleaning?.evidence[0].attachmentId).toContain("att-fixture");
  });

  it("只有 1 条明确负面 → isolated，不进入机会，并解释原因", () => {
    const voc = vocOf([{ text: "Hard to clean inside.", rating: 2 }]);
    const projection = buildOpportunityProjection({ voc });
    expect(projection.opportunities).toEqual([]);
    expect(projection.excluded).toHaveLength(1);
    expect(projection.excluded[0].reason).toContain("未达弱信号门槛");
  });

  it("只有主题提及（无明确负面）→ 不进入机会，原因写明「不能算痛点」", () => {
    const voc = vocOf([{ text: "It is a little slippery, but that is fine.", rating: 5 }]);
    const projection = buildOpportunityProjection({ voc });
    expect(projection.opportunities).toEqual([]);
    const slip = projection.excluded.find((item) => item.theme.includes("防滑"));
    expect(slip?.reason).toContain("不能算痛点");
  });

  it("正面反馈不转成负面需求", () => {
    const voc = vocOf([{ text: "Very easy to clean and durable.", rating: 5 }]);
    const projection = buildOpportunityProjection({ voc });
    expect(projection.opportunities).toEqual([]);
  });

  it("证据不足（0 条评论）→ 无机会且给出限制说明", () => {
    const voc = buildVocProjection({ attachments: [] });
    const projection = buildOpportunityProjection({ voc });
    expect(projection.opportunities).toEqual([]);
    expect(projection.limitations.join(" ")).toContain("评论样本");
  });

  it("竞品现状只引用已存快照事实，未选代表商品时明确写待补", () => {
    const voc = vocOf([
      { text: "Hard to clean inside.", rating: 2 },
      { text: "Hard to clean, takes forever.", rating: 2 },
    ]);
    const withComparison = buildOpportunityProjection({ voc, comparison: comparisonFixture });
    expect(withComparison.opportunities[0].competitorStatus).toContain("1 件代表商品");
    const withoutComparison = buildOpportunityProjection({ voc, comparison: null });
    expect(withoutComparison.opportunities[0].competitorStatus).toContain("待补");
  });

  it("证据只取明确负面原文，不超过 3 条（可接受/待核对的句子不进入机会证据）", () => {
    const voc = vocOf([
      { text: "Hard to clean inside.", rating: 2 },
      { text: "Really hard to clean the edges.", rating: 2 },
      { text: "Cleaning is hard, takes forever.", rating: 2 },
      { text: "A little hard to clean, but fine by me.", rating: 4 },
      { text: "Cleaning is awkward, which is fine.", rating: 5 },
    ]);
    const projection = buildOpportunityProjection({ voc });
    const opportunity = projection.opportunities[0];
    expect(opportunity.evidence.length).toBeLessThanOrEqual(3);
    expect(opportunity.problem).toContain("3 条明确负面反馈");
    expect(opportunity.problem).toContain("共 5 条提及");
    // 可接受的两条只出现在 excluded 的理由里，不进入机会证据
    expect(opportunity.evidence.every((item) => !/fine by me|which is fine/.test(item.excerpt))).toBe(true);
  });

  it("机会始终是待人工确认，不因证据充分而自动变成开发要求", () => {
    const voc = vocOf(Array.from({ length: 5 }, (_, index) => ({ text: `Review ${index}: hard to clean the corners.`, rating: 2 })));
    const projection = buildOpportunityProjection({ voc });
    expect(projection.opportunities[0].strength).toBe("recurring");
    expect(projection.opportunities.every((item) => item.humanStatus === "pending")).toBe(true);
    expect(projection.limitations.join(" ")).toContain("必须经人工确认");
  });
});

describe("开发机会：VOC 语义修复后不得把正面/食物脱离误当痛点", () => {
  it("zero leaks / nothing stuck 是正面，不生成渗漏机会", () => {
    const voc = vocOf([{ text: "Nothing stuck, zero leaks in the oven.", rating: 5 }]);
    const projection = buildOpportunityProjection({ voc });
    expect(projection.opportunities).toEqual([]);
    expect(projection.excluded.some((item) => item.theme.includes("渗漏"))).toBe(false);
  });

  it("食物 slid right off 不生成防滑机会；只有垫子自身移动才进入防滑主题", () => {
    const food = buildOpportunityProjection({
      voc: vocOf([{ text: "Teriyaki salmon slid right off the mat.", rating: 5 }]),
    });
    expect(food.opportunities).toEqual([]);
    expect(food.excluded.some((item) => item.theme.includes("防滑"))).toBe(false);

    const mat = buildOpportunityProjection({
      voc: vocOf([{ text: "The mat moves all over the counter while I roll dough.", rating: 2 }]),
    });
    expect(mat.opportunities).toEqual([]);
    expect(mat.excluded.some((item) => item.theme.includes("防滑"))).toBe(true);
  });
});

describe("开发机会：假设性担忧与部件松脱修复后不错误升级（第二轮收纳箱回归）", () => {
  it("HOMZ 假设性担忧（实际完好）→ 无 durability 机会，仅以「不能算痛点」排除", () => {
    const voc = vocOf([
      {
        text: "I was worried about ordering bins online because they are harder to ship and was worried they would arrive broken. They were packed perfectly and arrived fully intact. They are good quality and very sturdy.",
        rating: 5,
      },
    ]);
    const projection = buildOpportunityProjection({ voc });
    expect(projection.opportunities).toEqual([]);
    const durability = projection.excluded.find((item) => item.theme.includes("耐用"));
    expect(durability?.reason).toContain("不能算痛点");
  });

  it("Rubbermaid 提手脱落 complaint → 进入 durability 机会证据（弱信号，仍待人工确认）", () => {
    const voc = vocOf([
      { text: "The plastic handles came broken on one of them.", rating: 4 },
      { text: "They don't break, but the handles don't fit properly and constantly fall off.", rating: 3 },
    ]);
    const projection = buildOpportunityProjection({ voc });
    const durability = projection.opportunities.find((item) => item.id === "opp_durability");
    expect(durability).toBeDefined();
    expect(durability?.strength).toBe("weak");
    expect(durability?.humanStatus).toBe("pending");
    expect(durability?.evidence.some((item) => /fall off/.test(item.excerpt))).toBe(true);
  });

  it("提手可拆卸设计（用户认可）→ 不生成 durability 机会", () => {
    const voc = vocOf([
      { text: "The handles come off easily for storage, which I love.", rating: 5 },
      { text: "Great bins, very sturdy.", rating: 5 },
    ]);
    const projection = buildOpportunityProjection({ voc });
    expect(projection.opportunities).toEqual([]);
  });
});
