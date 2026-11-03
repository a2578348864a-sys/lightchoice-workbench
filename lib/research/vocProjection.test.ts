import { describe, expect, it } from "vitest";
import { buildSourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import { buildVocProjection } from "@/lib/research/vocProjection";
import { VOC_STRENGTH_THRESHOLDS } from "@/lib/research/vocThresholds";

const ASIN_A = "B0TEST0001";
const ASIN_B = "B0TEST0002";
const CAPTURED_AT = "2026-10-14T08:43:00.173Z";

function reviewFixture(input: { asin?: string; rating?: number; text: string; date?: string }) {
  const asin = input.asin ?? ASIN_A;
  return {
    asin,
    rating: input.rating ?? 5,
    title: "Review title",
    reviewText: input.text,
    reviewDate: input.date ?? "October 12, 2026",
    verifiedPurchase: true,
    sourceType: "amazon_review",
    sourceUrl: `https://www.amazon.com/product-reviews/${asin}`,
    bindingKind: "subject_local",
    bindingNote: null,
    completeness: "full",
    evidenceLevel: "source_observed",
  };
}

function reviewAttachment(input: { id: string; asin?: string; reviews: Array<Record<string, unknown>>; status?: string }) {
  const asin = input.asin ?? ASIN_A;
  return buildSourceEvidenceAttachment({
    attachmentId: `att-${input.id}`,
    subjectKey: `amazon:US:${asin}`,
    kind: "v3_review_voc_v1",
    sourceType: "amazon_dom",
    capturedAt: CAPTURED_AT,
    payload: {
      schemaVersion: "capture-system-v3-module-evidence.v1",
      module: "review_voc",
      subjectKey: `amazon:US:${asin}`,
      marketplace: "US",
      capturedAt: CAPTURED_AT,
      provider: "amazon",
      sourceSurface: "amazon_product_reviews",
      status: input.status ?? "VALIDATED_AVAILABLE",
      metricNature: "source_observed",
      identity: { asin },
      limitations: [],
      data: { outcome: "reviews_visible", reviewCount: input.reviews.length, reviews: input.reviews },
      evidenceOnly: true,
    },
  });
}

function projectionOf(texts: Array<{ text: string; rating?: number; asin?: string }>) {
  return buildVocProjection({
    attachments: [reviewAttachment({ id: "single", reviews: texts.map((item) => reviewFixture(item)) })],
  });
}

function themeOf(result: ReturnType<typeof buildVocProjection>, id: string) {
  return result.themes.find((theme) => theme.id === id);
}

describe("VOC 语义：主题提及 / 明确负面 / 可接受 / 正面 / 待核对", () => {
  it("明确的使用障碍 → complaint（super slippery and moves all over the counter）", () => {
    const result = projectionOf([{ text: "Super slippery and moves all over the counter while I roll dough.", rating: 2 }]);
    const theme = themeOf(result, "slip_resistance");
    expect(theme?.complaintCount).toBe(1);
    expect(theme?.mentionCount).toBe(1);
    expect(theme?.strength).toBe("isolated");
    expect(theme?.quotes[0].intent).toBe("complaint");
  });

  it("提到缺点但明确接受 → tolerated，不计入负面复现", () => {
    const result = projectionOf([{ text: "They are easy to clean, just a little slippery, which is fine by me.", rating: 5 }]);
    const theme = themeOf(result, "slip_resistance");
    expect(theme?.complaintCount).toBe(0);
    expect(theme?.toleratedCount).toBe(1);
    expect(theme?.mentionCount).toBe(1);
    expect(theme?.strength).toBe("mention_only");
    expect(theme?.quotes[0].intent).toBe("tolerated");
  });

  it("否定的负面（not slippery at all）→ 正面，不算防滑不足", () => {
    const result = projectionOf([{ text: "They are not slippery at all and stay put.", rating: 5 }]);
    expect(themeOf(result, "slip_resistance")).toBeUndefined();
    expect(themeOf(result, "slip_resistance_positive")?.positiveCount).toBe(1);
  });

  it("正反混合（easy to clean, but it slides everywhere）→ 清洁正面 + 滑动 complaint", () => {
    const result = projectionOf([{ text: "Easy to clean, but it slides everywhere on the counter.", rating: 3 }]);
    expect(themeOf(result, "clean_difficulty_positive")?.positiveCount).toBe(1);
    expect(themeOf(result, "slip_resistance")?.complaintCount).toBe(1);
  });

  it("只有关键词、没有使用影响（slippery）→ uncertain，不当投诉", () => {
    const result = projectionOf([{ text: "The surface is slippery.", rating: 4 }]);
    const theme = themeOf(result, "slip_resistance");
    expect(theme?.complaintCount).toBe(0);
    expect(theme?.uncertainCount).toBe(1);
    expect(theme?.strength).toBe("mention_only");
  });

  it("轻微观察且语境不足（start off a little slippery, even after two washes）→ uncertain", () => {
    const result = projectionOf([{ text: "These start off a little slippery, even after two washes. But then they work well.", rating: 5 }]);
    const theme = themeOf(result, "slip_resistance");
    expect(theme?.complaintCount).toBe(0);
    expect(theme?.uncertainCount).toBe(1);
  });

  it("五星评论也可以产生明确负面（5★ 里写清洁困难）", () => {
    const result = projectionOf([{ text: "Love it, but it is really hard to clean inside the ridges.", rating: 5 }]);
    const theme = themeOf(result, "clean_difficulty");
    expect(theme?.complaintCount).toBe(1);
    expect(theme?.quotes[0].rating).toBe(5);
  });

  it("一星评论里的正面句进入正面主题（不排除罕见方向）", () => {
    const result = projectionOf([{ text: "Easy to clean and I love it, though the box arrived crushed.", rating: 1 }]);
    expect(themeOf(result, "clean_difficulty_positive")?.positiveCount).toBe(1);
  });

  it("一条评论两个主题分别计数，但分母仍是 1 条评论", () => {
    const result = projectionOf([{ text: "It is hard to clean and it slides across the counter.", rating: 2 }]);
    const cleaning = themeOf(result, "clean_difficulty");
    const slip = themeOf(result, "slip_resistance");
    expect(cleaning?.complaintCount).toBe(1);
    expect(slip?.complaintCount).toBe(1);
    expect(cleaning?.sampleDenominator).toBe(1);
    expect(slip?.sampleDenominator).toBe(1);
    expect(result.reviewsRead).toBe(1);
  });

  it("同一评论重复出现在两个附件里只计一次", () => {
    const review = reviewFixture({ text: "It is hard to clean inside." });
    const result = buildVocProjection({
      attachments: [
        reviewAttachment({ id: "dup-a", reviews: [review] }),
        reviewAttachment({ id: "dup-b", reviews: [review] }),
      ],
    });
    expect(result.reviewsRead).toBe(1);
    expect(result.duplicateReviewsSuppressed).toBe(1);
    expect(themeOf(result, "clean_difficulty")?.complaintCount).toBe(1);
  });

  it("缺少 reviewId / 日期 / 变体时：不报错、按保守去重，并声明身份不完整", () => {
    const result = buildVocProjection({
      attachments: [reviewAttachment({ id: "no-meta", reviews: [reviewFixture({ text: "Hard to clean.", date: "" })] })],
    });
    expect(result.reviewsRead).toBe(1);
    expect(result.limitations.join(" ")).toContain("reviewId");
  });

  it("复现门槛边界：1 → isolated、2–3 → weak、4 → recurring（阈值来自 vocThresholds）", () => {
    const make = (count: number) => projectionOf(
      Array.from({ length: count }, (_, index) => ({ text: `Review ${index + 1}: hard to clean inside.`, rating: 2 })),
    );
    expect(themeOf(make(1), "clean_difficulty")?.strength).toBe("isolated");
    expect(themeOf(make(VOC_STRENGTH_THRESHOLDS.weakMin), "clean_difficulty")?.strength).toBe("weak");
    expect(themeOf(make(VOC_STRENGTH_THRESHOLDS.recurringMin), "clean_difficulty")?.strength).toBe("recurring");
    // 提及数不能替代投诉数：1 条投诉 + 2 条「可接受」仍是 isolated
    const mixed = projectionOf([
      { text: "Hard to clean inside.", rating: 2 },
      { text: "A little hard to clean, but fine by me.", rating: 4 },
      { text: "Cleaning is a bit awkward, which is fine.", rating: 5 },
    ]);
    const theme = themeOf(mixed, "clean_difficulty");
    expect(theme?.complaintCount).toBe(1);
    expect(theme?.toleratedCount).toBe(2);
    expect(theme?.strength).toBe("isolated");
  });
});

describe("VOC 投影：附件门禁、计数与限制", () => {
  it("非可用状态的附件被拒收，且不影响其它附件", () => {
    const result = buildVocProjection({
      attachments: [
        reviewAttachment({ id: "blocked", status: "BLOCKED_WITH_EVIDENCE", reviews: [reviewFixture({ text: "Hard to clean." })] }),
        reviewAttachment({ id: "ok", reviews: [reviewFixture({ text: "Hard to clean inside." })] }),
      ],
    });
    expect(result.attachmentsRead).toBe(1);
    expect(result.rejectedAttachments).toHaveLength(1);
    expect(result.rejectedAttachments[0].reason).toContain("状态");
  });

  it("expectedAsins 之外的附件被拒收（不猜测归属）", () => {
    const result = buildVocProjection({
      attachments: [reviewAttachment({ id: "other", asin: ASIN_B, reviews: [reviewFixture({ asin: ASIN_B, text: "Hard to clean." })] })],
      expectedAsins: [ASIN_A],
    });
    expect(result.reviewsRead).toBe(0);
    expect(result.rejectedAttachments[0].reason).toContain("不在本轮预期范围");
  });

  it("被拒收的附件不得进入合法研究输入：既不计主题，也不进样本分母", () => {
    const result = buildVocProjection({
      attachments: [
        reviewAttachment({ id: "blocked", status: "BLOCKED_WITH_EVIDENCE", reviews: [reviewFixture({ text: "Hard to clean." })] }),
        reviewAttachment({ id: "ok", reviews: [reviewFixture({ text: "Great mat, easy to clean." })] }),
      ],
    });
    expect(result.reviewsRead).toBe(1);
    expect(themeOf(result, "clean_difficulty")).toBeUndefined();
    expect(themeOf(result, "clean_difficulty_positive")?.sampleDenominator).toBe(1);
  });

  it("首句担心、后句澄清（worried about the smell but it is fine）→ 只算可接受，不算负面", () => {
    const result = projectionOf([{ text: "I was worried about the smell out of the box, but it is fine.", rating: 5 }]);
    const odor = themeOf(result, "odor");
    expect(odor?.complaintCount ?? 0).toBe(0);
    expect(odor?.toleratedCount ?? 0).toBe(1);
  });

  it("重复评论去重时保留 capturedAt 最新的那一条（仍只有 1 条独立评论）", () => {
    const older = reviewAttachment({ id: "older", reviews: [reviewFixture({ text: "Hard to clean inside." })] });
    const newer = {
      ...reviewAttachment({ id: "newer", reviews: [reviewFixture({ text: "Hard to clean inside." })] }),
      capturedAt: "2026-10-17T08:00:00.000Z",
    };
    const result = buildVocProjection({ attachments: [newer, older] });
    expect(result.reviewsRead).toBe(1);
    expect(themeOf(result, "clean_difficulty")?.quotes[0].capturedAt).toBe("2026-10-17T08:00:00.000Z");
  });

  it("每个主题最多展示 3 条原文引用（可展开核对但不灌满页面）", () => {
    const result = projectionOf([
      { text: "Hard to clean inside.", rating: 2 },
      { text: "Really hard to clean the edges.", rating: 2 },
      { text: "Cleaning is hard, takes forever.", rating: 2 },
      { text: "It is hard to clean after baking.", rating: 2 },
    ]);
    expect(themeOf(result, "clean_difficulty")?.complaintCount).toBe(4);
    expect(themeOf(result, "clean_difficulty")?.quotes.length).toBe(3);
  });

  it("同评论多 ASIN 时分别给出 perAsin 计数与分母", () => {
    const result = buildVocProjection({
      attachments: [
        reviewAttachment({ id: "a", reviews: [reviewFixture({ text: "Hard to clean." }), reviewFixture({ text: "Fine overall." })] }),
        reviewAttachment({ id: "b", asin: ASIN_B, reviews: [reviewFixture({ asin: ASIN_B, text: "Also hard to clean inside." })] }),
      ],
    });
    const theme = themeOf(result, "clean_difficulty");
    expect(theme?.asins).toEqual([ASIN_A, ASIN_B]);
    expect(theme?.perAsin).toEqual([
      { asin: ASIN_A, count: 1, denominator: 2 },
      { asin: ASIN_B, count: 1, denominator: 1 },
    ]);
    expect(theme?.sampleDenominator).toBe(3);
  });

  it("整体限制如实声明样本小、五星偏斜、去重口径与规则误判风险", () => {
    const result = projectionOf([
      { text: "Hard to clean.", rating: 5 },
      { text: "Great mat.", rating: 5 },
      { text: "Love it.", rating: 5 },
    ]);
    const text = result.limitations.join(" ");
    expect(text).toContain("不足 10 条");
    expect(text).toContain("五星评论占比");
    expect(text).toContain("reviewId");
    expect(text).toContain("误判");
  });
});

describe("VOC 语义修复：否定范围、动作主体与主题边界（真实误判回归）", () => {
  it("zero leaks / nothing stuck 是正面体验，不得判成渗漏或粘连投诉", () => {
    const result = projectionOf([{ text: "Nothing stuck, zero leaks in the oven.", rating: 5 }]);
    expect(themeOf(result, "functionality")).toBeUndefined();
    expect(themeOf(result, "functionality_positive")?.positiveCount).toBe(1);
    expect(themeOf(result, "slip_resistance")).toBeUndefined();
  });

  it("leak-proof 是正面宣称，不得因为包含 leak 而判成渗漏", () => {
    const result = projectionOf([{ text: "It is leak-proof and nothing sticks.", rating: 5 }]);
    expect(themeOf(result, "functionality")).toBeUndefined();
    expect(themeOf(result, "functionality_positive")).toBeUndefined();
  });

  it("确实发生的渗漏仍然是 complaint（it leaks onto / the mat leaked）", () => {
    const result = projectionOf([
      { text: "It leaks onto the counter.", rating: 2 },
      { text: "The mat leaked after two washes.", rating: 2 },
    ]);
    const theme = themeOf(result, "functionality");
    expect(theme?.complaintCount).toBe(2);
    expect(theme?.quotes.every((quote) => quote.intent === "complaint")).toBe(true);
  });

  it("食物从垫子滑落是不粘/易脱离语境，不得算垫子防滑不足", () => {
    const result = projectionOf([{ text: "Teriyaki salmon slid right off the mat.", rating: 5 }]);
    expect(themeOf(result, "slip_resistance")).toBeUndefined();
    expect(themeOf(result, "slip_resistance_positive")).toBeUndefined();
  });

  it("垫子在台面上移动才是防滑 complaint（moves all over the counter）", () => {
    const result = projectionOf([{ text: "The mat moves all over the counter while I roll dough.", rating: 2 }]);
    const theme = themeOf(result, "slip_resistance");
    expect(theme?.complaintCount).toBe(1);
    expect(theme?.quotes[0].intent).toBe("complaint");
  });

  it("否定与投诉同句：not slippery 是正面，hard to clean 是清洁 complaint，互不传播", () => {
    const result = projectionOf([{ text: "It is not slippery at all, but it is hard to clean.", rating: 3 }]);
    expect(themeOf(result, "slip_resistance_positive")?.positiveCount).toBe(1);
    expect(themeOf(result, "slip_resistance")).toBeUndefined();
    expect(themeOf(result, "clean_difficulty")?.complaintCount).toBe(1);
  });

  it("同句多主题：zero leaks 是功能正面，mat moves 是防滑 complaint", () => {
    const result = projectionOf([{ text: "Zero leaks, but the mat moves all over the counter.", rating: 3 }]);
    expect(themeOf(result, "functionality_positive")?.positiveCount).toBe(1);
    expect(themeOf(result, "functionality")).toBeUndefined();
    expect(themeOf(result, "slip_resistance")?.complaintCount).toBe(1);
  });

  it("同一主题多次出现：doesn't leak 不投诉，但 lid is missing 是功能 complaint", () => {
    const result = projectionOf([{ text: "It doesn't leak, but the lid is missing.", rating: 2 }]);
    const theme = themeOf(result, "functionality");
    expect(theme?.complaintCount).toBe(1);
    expect(theme?.quotes[0].intent).toBe("complaint");
  });

  it("主语/语境不足时保守处理：It slid. 只算 uncertain，不升级为投诉", () => {
    const result = projectionOf([{ text: "It slid.", rating: 3 }]);
    const theme = themeOf(result, "slip_resistance");
    expect(theme?.complaintCount).toBe(0);
    expect(theme?.uncertainCount).toBe(1);
  });
});

describe("VOC 语义修复：弯引号否定词", () => {
  it("doesn’t slip / doesn’t leak 使用弯引号时仍识别为否定", () => {
    const result = projectionOf([
      { text: "It doesn’t slip at all on the counter.", rating: 5 },
      { text: "It doesn’t leak in the oven.", rating: 5 },
    ]);
    expect(themeOf(result, "slip_resistance")).toBeUndefined();
    expect(themeOf(result, "slip_resistance_positive")?.positiveCount).toBe(1);
    expect(themeOf(result, "functionality")).toBeUndefined();
    expect(themeOf(result, "functionality_positive")?.positiveCount).toBe(1);
  });
});

describe("VOC 语义修复：假设性担忧与部件松脱（第二轮收纳箱真实误判回归）", () => {
  // ---- 问题 A：HOMZ「担心破损但实际完好」被误判为 durability complaint ----
  it("担心破损、实际完好（HOMZ 真实评论）→ 不计 durability complaint", () => {
    const result = projectionOf([
      {
        text: "I was worried about ordering bins online because they are harder to ship and was worried they would arrive broken. They were packed perfectly and arrived fully intact. They are good quality and very sturdy.",
        rating: 5,
      },
    ]);
    const theme = themeOf(result, "durability");
    expect(theme?.complaintCount ?? 0).toBe(0);
    expect(theme?.uncertainCount ?? 0).toBe(1);
  });

  it("担心破损、实际确实破损（同句确认）→ 仍然是 durability complaint", () => {
    const result = projectionOf([
      { text: "I was worried they would arrive broken, and they did arrive broken.", rating: 1 },
    ]);
    expect(themeOf(result, "durability")?.complaintCount).toBe(1);
  });

  it("担心破损、实际确实破损（独立结果句）→ 仍然是 durability complaint", () => {
    const result = projectionOf([
      { text: "I was worried they would arrive broken. One arrived cracked straight through the side.", rating: 1 },
    ]);
    expect(themeOf(result, "durability")?.complaintCount).toBe(1);
  });

  it("只表达担忧、没有实际结果 → uncertain，不虚构破损 complaint", () => {
    const result = projectionOf([{ text: "I was worried they would arrive broken.", rating: 4 }]);
    const theme = themeOf(result, "durability");
    expect(theme?.complaintCount ?? 0).toBe(0);
    expect(theme?.uncertainCount ?? 0).toBe(1);
  });

  it("担忧动词 + 情态动词之后的实际故障句不受担忧框架影响（because 从句按事实处理）", () => {
    const result = projectionOf([
      { text: "I was worried they would break because the last batch cracked after a week.", rating: 2 },
    ]);
    expect(themeOf(result, "durability")?.complaintCount).toBe(1);
  });

  // ---- 问题 B：Rubbermaid「箱体不破但提手反复脱落」被漏判 ----
  it("箱体不破、但提手反复脱落（Rubbermaid 真实评论）→ durability complaint", () => {
    const result = projectionOf([
      { text: "They don't break, but the handles don't fit properly and constantly fall off.", rating: 3 },
    ]);
    const theme = themeOf(result, "durability");
    expect(theme?.complaintCount).toBe(1);
    expect(theme?.independentReviewCount).toBe(1);
    expect(theme?.quotes[0].intent).toBe("complaint");
  });

  it("提手正常、没有脱落 → 不得计 complaint", () => {
    const result = projectionOf([
      { text: "The handles are sturdy and don't fall off at all.", rating: 5 },
    ]);
    expect(themeOf(result, "durability")?.complaintCount ?? 0).toBe(0);
  });

  it("提手可拆卸且用户明确认可 → 不得误判为质量故障", () => {
    const result = projectionOf([
      { text: "The handles come off easily for storage, which I love.", rating: 5 },
    ]);
    expect(themeOf(result, "durability")?.complaintCount ?? 0).toBe(0);
  });

  it("盖子脱落同样是部件松脱 complaint（lid falls off）", () => {
    const result = projectionOf([
      { text: "The lid falls off every time I pick it up.", rating: 2 },
    ]);
    expect(themeOf(result, "durability")?.complaintCount).toBe(1);
  });

  it("同一评论多次描述同一故障 → 只计一条独立投诉", () => {
    const result = projectionOf([
      { text: "The handles fall off. The handles keep falling off when I carry it.", rating: 2 },
    ]);
    const theme = themeOf(result, "durability");
    expect(theme?.complaintCount).toBe(1);
    expect(theme?.independentReviewCount).toBe(1);
  });

  it("don't fit 与 doesn't fit 都识别为负面表达（同一意图，不因缩写形式漏判）", () => {
    const dontFit = projectionOf([{ text: "The lid don't fit properly.", rating: 2 }]);
    const doesntFit = projectionOf([{ text: "The lid doesn't fit properly.", rating: 2 }]);
    // 识别为负面（uncertain）而非中性提及（mention）：两种缩写形式结果一致。
    expect(themeOf(dontFit, "functionality")?.uncertainCount ?? 0).toBe(1);
    expect(themeOf(doesntFit, "functionality")?.uncertainCount ?? 0).toBe(1);
    expect(themeOf(dontFit, "functionality")?.complaintCount ?? 0).toBe(0);
  });

  // ---- 历史修复行为不得回归 ----
  it("zero leaks / nothing stuck 保持正面（PR #116 不回归）", () => {
    const result = projectionOf([{ text: "Nothing stuck, zero leaks in the oven.", rating: 5 }]);
    expect(themeOf(result, "functionality")).toBeUndefined();
    expect(themeOf(result, "functionality_positive")?.positiveCount).toBe(1);
  });

  it("食物从垫子滑落保持不算防滑投诉（PR #116 不回归）", () => {
    const result = projectionOf([{ text: "Teriyaki salmon slid right off.", rating: 5 }]);
    expect(themeOf(result, "slip_resistance")).toBeUndefined();
  });

  it("确实发生的渗漏保持 complaint（PR #116 不回归）", () => {
    const result = projectionOf([{ text: "It leaks onto the counter every time.", rating: 1 }]);
    expect(themeOf(result, "functionality")?.complaintCount).toBe(1);
  });
});
