import type { ReviewImportInput, ReviewSourceProductRole } from "@/lib/server/reviewEvidence";

export type ReviewVocSnippet = {
  rating: number | null;
  date: string | null;
  title: string;
  reviewText: string;
  verifiedPurchase?: boolean | null;
  reviewId?: string | null;
  sourceRef: string;
};

export type ReviewVocPlan =
  | { ok: true; reviews: ReviewImportInput[]; sourceType: "browser" | "manual_import" }
  | { ok: false; errorCode: "LOGIN_REQUIRED" | "CAPTCHA_DETECTED" | "ASIN_NOT_FOUND" | "SOURCE_MISSING"; reason: string };

/**
 * Review 只保留公开可见或人工导入的原文/片段，不把 VOC 结论写入商品事实。
 * 浏览器提取只在页面已证明 ASIN 绑定时允许生成导入项。
 */
export function planReviewVocImport(input: {
  asin: string;
  sourceProductRole: ReviewSourceProductRole;
  sourceUrl: string | null;
  entityBound: boolean;
  pageStatus: "ok" | "login_wall" | "captcha" | "unknown_page";
  snippets: readonly ReviewVocSnippet[];
  sourceType: "browser" | "manual_import";
}): ReviewVocPlan {
  if (!/^[A-Z0-9]{10}$/.test(input.asin)) {
    return { ok: false, errorCode: "ASIN_NOT_FOUND", reason: "评论没有绑定到合法 ASIN。" };
  }
  if (input.pageStatus === "login_wall") {
    return { ok: false, errorCode: "LOGIN_REQUIRED", reason: "评论来源要求登录，系统不会自动登录。" };
  }
  if (input.pageStatus === "captcha") {
    return { ok: false, errorCode: "CAPTCHA_DETECTED", reason: "检测到验证码，需要人工接管。" };
  }
  if (!input.entityBound) {
    return { ok: false, errorCode: "ASIN_NOT_FOUND", reason: "无法证明评论页面属于目标商品。" };
  }
  if (input.snippets.length === 0) {
    return { ok: false, errorCode: "SOURCE_MISSING", reason: "没有可保存的评论原文或公开片段。" };
  }
  return {
    ok: true,
    sourceType: input.sourceType,
    reviews: input.snippets.slice(0, 20).map((snippet) => ({
      asin: input.asin,
      sourceProductRole: input.sourceProductRole,
      reviewText: snippet.reviewText,
      verifiedPurchase: snippet.verifiedPurchase ?? null,
      reviewTitle: snippet.title || null,
      reviewId: snippet.reviewId ?? null,
      rating: snippet.rating,
      reviewDate: snippet.date,
      sourceUrl: input.sourceUrl,
      sourceRef: snippet.sourceRef,
      bindingKind: input.sourceType === "browser" ? "browser_verified" : "manual_confirmed",
      bindingNote: "页面实体绑定已在采集前完成",
      sourceType: input.sourceType,
      collectorVersion: input.sourceType === "browser" ? "amazon-review-snippet-collector.v1" : undefined,
    })),
  };
}
