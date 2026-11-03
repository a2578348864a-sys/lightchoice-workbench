import { describe, expect, it } from "vitest";
import {
  parseReviewImportContent,
  parseCsvRows,
  MAX_REVIEW_TEXT_LENGTH,
} from "@/lib/server/reviewImportParser";

describe("Review Import Parser (G3-A)", () => {
  it("解析标准 CSV 评论导表", () => {
    const csv = [
      "asin,rating,reviewTitle,reviewText,reviewDate,verifiedPurchase",
      'B0GFCZTRKL,5,"Great Board","This cutting board is durable and smooth.","2026-08-10",true',
      'B0GFCZTRKL,4,"Pretty good","Good quality, slightly heavy.","2026-08-12",false',
    ].join("\n");

    const result = parseReviewImportContent(csv);
    expect(result.ok).toBe(true);
    expect(result.reviews).toHaveLength(2);
    expect(result.stats.validReviews).toBe(2);
    expect(result.stats.totalRows).toBe(2);

    expect(result.reviews[0]).toEqual({
      asin: "B0GFCZTRKL",
      sourceProductRole: "current_candidate",
      reviewTitle: "Great Board",
      reviewText: "This cutting board is durable and smooth.",
      rating: 5,
      reviewDate: "2026-08-10",
      verifiedPurchase: true,
      reviewId: null,
      sourceType: "manual_import",
      bindingKind: "manual_confirmed",
    });

    expect(result.reviews[1].rating).toBe(4);
    expect(result.reviews[1].verifiedPurchase).toBe(false);
  });

  it("支持中文及别名乱序表头", () => {
    const csv = [
      "星级,评论正文,评论标题,商品ASIN,是否VP,评论日期",
      '5,"竹子材质非常好，刀痕不明显。","非常满意",B0GFCZTRKL,是,"2026-09-01"',
      '1,"开裂了，不推荐购买。","质量堪忧",B0GFCZTRKL,否,"2026-09-05"',
    ].join("\n");

    const result = parseReviewImportContent(csv);
    expect(result.ok).toBe(true);
    expect(result.reviews).toHaveLength(2);
    expect(result.reviews[0].asin).toBe("B0GFCZTRKL");
    expect(result.reviews[0].rating).toBe(5);
    expect(result.reviews[0].reviewText).toBe("竹子材质非常好，刀痕不明显。");
    expect(result.reviews[0].reviewTitle).toBe("非常满意");
    expect(result.reviews[0].verifiedPurchase).toBe(true);
    expect(result.reviews[1].rating).toBe(1);
    expect(result.reviews[1].verifiedPurchase).toBe(false);
  });

  it("处理包含逗号、转义双引号和换行符的复杂 CSV 文本", () => {
    const csv = [
      'ASIN,review_text,rating',
      'B0GFCZTRKL,"Line 1 of review,\nLine 2 with ""special quotes"" and commas, still part of body.",5',
      'B0GFCZTRKL,"Simple second review",4',
    ].join("\r\n");

    const rows = parseCsvRows(csv);
    expect(rows).toHaveLength(3);
    expect(rows[1][1]).toContain('Line 2 with "special quotes" and commas');

    const result = parseReviewImportContent(csv);
    expect(result.ok).toBe(true);
    expect(result.reviews).toHaveLength(2);
    expect(result.reviews[0].reviewText).toBe(
      'Line 1 of review,\nLine 2 with "special quotes" and commas, still part of body.'
    );
  });

  it("超长评论正文截断至 2000 字符", () => {
    const longText = "A".repeat(3000);
    const csv = `ASIN,reviewText\nB0GFCZTRKL,"${longText}"`;

    const result = parseReviewImportContent(csv);
    expect(result.ok).toBe(true);
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0].reviewText.length).toBe(MAX_REVIEW_TEXT_LENGTH);
    expect(result.stats.truncatedReviews).toBe(1);
  });

  it("过滤空评论行与全空行", () => {
    const csv = [
      "ASIN,reviewText,rating",
      'B0GFCZTRKL,"Valid text",5',
      'B0GFCZTRKL,"   ",4',
      ',,',
      'B0GFCZTRKL,,',
      'B0GFCZTRKL,"Another valid text",3',
    ].join("\n");

    const result = parseReviewImportContent(csv);
    expect(result.ok).toBe(true);
    expect(result.reviews).toHaveLength(2);
    expect(result.stats.skippedEmpty).toBe(3); // 1 空白内容 + 1 全空行 + 1 空内容
  });

  it("校验非法 ASIN 并允许 defaultAsin 回退", () => {
    const csv = [
      "ASIN,reviewText,rating",
      'INVALID_ASIN,"Review text 1",5',
      ',Review text 2,4',
      'B0GFCZTRKL,"Review text 3",5',
    ].join("\n");

    // 不提供 defaultAsin：前两条被拒绝
    const resNoFallback = parseReviewImportContent(csv);
    expect(resNoFallback.reviews).toHaveLength(1);
    expect(resNoFallback.rejectedCount).toBe(2);
    expect(resNoFallback.stats.invalidAsin).toBe(2);

    // 提供 defaultAsin：前两条回退到 defaultAsin
    const resWithFallback = parseReviewImportContent(csv, { defaultAsin: "B0GFCZTRKL" });
    expect(resWithFallback.reviews).toHaveLength(3);
    expect(resWithFallback.reviews[0].asin).toBe("B0GFCZTRKL");
    expect(resWithFallback.reviews[1].asin).toBe("B0GFCZTRKL");
    expect(resWithFallback.rejectedCount).toBe(0);
  });

  it("解析结果可无缝对接 buildReviewItem 生成合法 ReviewItem", async () => {
    const { buildReviewItem } = await import("@/lib/server/reviewEvidence");
    const csv = 'ASIN,reviewText,rating,reviewTitle\nB0GFCZTRKL,"Solid wood, very sturdy.",5,"Love it"';
    const result = parseReviewImportContent(csv);
    expect(result.ok).toBe(true);
    const item = buildReviewItem(result.reviews[0], new Date().toISOString());
    expect(item.productAsin).toBe("B0GFCZTRKL");
    expect(item.reviewText).toBe("Solid wood, very sturdy.");
    expect(item.rating).toBe(5);
    expect(item.reviewTitle).toBe("Love it");
    expect(item.nature).toBe("review_observation");
  });
});
