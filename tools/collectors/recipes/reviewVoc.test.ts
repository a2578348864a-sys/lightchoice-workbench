import { describe, expect, it } from "vitest";
import { planReviewVocImport } from "./reviewVoc";

describe("Review VOC recipe bridge", () => {
  it("keeps review text and binding metadata as review evidence input", () => {
    const result = planReviewVocImport({
      asin: "B00063QBL8",
      sourceProductRole: "current_candidate",
      sourceUrl: "https://www.amazon.com/dp/B00063QBL8",
      entityBound: true,
      pageStatus: "ok",
      sourceType: "browser",
      snippets: [{ rating: 2, date: "January 1, 2026", title: "Weak hinge", reviewText: "The hinge broke after a week.", sourceRef: "amazon:top-review:1" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reviews[0]).toMatchObject({ asin: "B00063QBL8", reviewText: "The hinge broke after a week.", sourceType: "browser", bindingKind: "browser_verified" });
  });

  it("never turns login or CAPTCHA into a retrying scraper action", () => {
    expect(planReviewVocImport({ asin: "B00063QBL8", sourceProductRole: "competitor", sourceUrl: null, entityBound: false, pageStatus: "login_wall", snippets: [], sourceType: "browser" })).toMatchObject({ ok: false, errorCode: "LOGIN_REQUIRED" });
    expect(planReviewVocImport({ asin: "B00063QBL8", sourceProductRole: "competitor", sourceUrl: null, entityBound: false, pageStatus: "captcha", snippets: [], sourceType: "browser" })).toMatchObject({ ok: false, errorCode: "CAPTCHA_DETECTED" });
  });
});
