import { describe, expect, it } from "vitest";
import { VOC_RULE_VERSION, describeVocRuleCurrency } from "@/lib/research/vocRuleVersion";
import { buildVocProjection } from "@/lib/research/vocProjection";
import { buildSourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";

const ASIN = "B0TEST0001";
const CAPTURED_AT = "2026-10-18T08:43:00.173Z";

function reviewFixture(text: string, rating = 5) {
  return {
    asin: ASIN,
    rating,
    title: "Review title",
    reviewText: text,
    reviewDate: "October 12, 2026",
    verifiedPurchase: true,
    sourceType: "amazon_review",
    sourceUrl: `https://www.amazon.com/product-reviews/${ASIN}`,
    bindingKind: "subject_local",
    bindingNote: null,
    completeness: "full",
    evidenceLevel: "source_observed",
  };
}

function attachment(reviews: Array<Record<string, unknown>>) {
  return buildSourceEvidenceAttachment({
    attachmentId: "att-rule-version",
    subjectKey: `amazon:US:${ASIN}`,
    kind: "v3_review_voc_v1",
    sourceType: "amazon_dom",
    capturedAt: CAPTURED_AT,
    payload: {
      schemaVersion: "capture-system-v3-module-evidence.v1",
      module: "review_voc",
      subjectKey: `amazon:US:${ASIN}`,
      marketplace: "US",
      capturedAt: CAPTURED_AT,
      provider: "amazon",
      sourceSurface: "amazon_product_reviews",
      status: "VALIDATED_AVAILABLE",
      metricNature: "source_observed",
      identity: { asin: ASIN },
      limitations: [],
      data: { outcome: "reviews_visible", reviewCount: reviews.length, reviews },
      evidenceOnly: true,
    },
  });
}

describe("VOC 规则版本：投影来源标识", () => {
  it("当前 VOC 投影带规则版本（唯一来源，可识别）", () => {
    const result = buildVocProjection({ attachments: [attachment([reviewFixture("Great mat, nothing stuck.")])] });
    expect(result.ruleVersion).toBe(VOC_RULE_VERSION);
    expect(result.ruleVersion).toMatch(/^voc-rules\.v\d+$/u);
  });

  it("空投影同样带规则版本（来源标识不依赖样本）", () => {
    const result = buildVocProjection({ attachments: [] });
    expect(result.ruleVersion).toBe(VOC_RULE_VERSION);
  });
});

describe("VOC 规则版本：读侧时效判定（不写状态、不参与 stale 门禁）", () => {
  it("记录版本与当前一致 → current，无提示", () => {
    const currency = describeVocRuleCurrency(VOC_RULE_VERSION);
    expect(currency.status).toBe("current");
    expect(currency.hint).toBeNull();
  });

  it("记录版本是已知旧版本 → outdated，提示重新核对且不称旧结论错误", () => {
    const currency = describeVocRuleCurrency("voc-rules.v2");
    expect(currency.status).toBe("outdated");
    expect(currency.hint).toContain("voc-rules.v2");
    expect(currency.hint).toContain(VOC_RULE_VERSION);
    expect(currency.hint).toContain("重新核对");
    // 不得把覆盖范围差异说成旧结论错误
    expect(currency.hint).toContain("不一定是旧结论错误");
  });

  it("旧报告缺少规则版本 → unknown，不编造版本", () => {
    for (const stored of [null, undefined, ""]) {
      const currency = describeVocRuleCurrency(stored);
      expect(currency.status).toBe("unknown");
      expect(currency.hint).toContain("未记录");
    }
  });

  it("无法解析的版本串 → unknown（不猜测新旧）", () => {
    const currency = describeVocRuleCurrency("voc-rules.2026-01-01");
    expect(currency.status).toBe("unknown");
    expect(currency.hint).toContain("无法识别");
  });

  it("记录版本高于当前（异常回滚场景）→ 按 current 处理，不误报过期", () => {
    const currency = describeVocRuleCurrency("voc-rules.v99");
    expect(currency.status).toBe("current");
    expect(currency.hint).toBeNull();
  });
});
