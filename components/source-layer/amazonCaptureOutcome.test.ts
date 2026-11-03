import { describe, expect, it } from "vitest";
import { amazonCaptureFailureGuidance, classifyAmazonCaptureFailure, formatAmazonCaptureRequestFailure, resolveAmazonCaptureOutcome } from "./amazonCaptureOutcome";

describe("classifyAmazonCaptureFailure", () => {
  it.each([
    ["CAPTCHA_DETECTED", "human_confirmation"],
    ["HUMAN_REQUIRED", "human_confirmation"],
    ["LOGIN_REQUIRED", "login_required"],
    ["LOCAL_ENVIRONMENT_REQUIRED", "acquisition_disabled"],
    ["PLAYWRIGHT_RUNTIME_MISSING", "environment_unavailable"],
    ["PLAYWRIGHT_BROWSER_FAILED", "network"],
    ["LOCALE_MISMATCH", "market_locale"],
    ["MARKETPLACE_MISMATCH", "marketplace_mismatch"],
    ["AMAZON_US_SESSION_CALIBRATION_FAILED", "session_unavailable"],
    ["AMAZON_CAPTURE_NON_US_EXIT", "network_exit"],
    ["BATCH_CAPTURE_SCOPE_DISABLED", "scope_disabled"],
    ["AMAZON_CAPTURE_PREFLIGHT_FAILED", "network"],
    ["ASIN_BUDGET_INVALID", "invalid_input"],
    ["REVIEW_SOURCE_UNAVAILABLE", "network"],
    ["REVIEW_EXTRACTION_EMPTY", "page_changed"],
    ["ASIN_PAGE_ANCHOR_MISMATCH", "page_changed"],
    ["UNRECOGNIZED_CODE", "unknown"],
  ] as const)("maps %s to %s", (code, expected) => {
    expect(classifyAmazonCaptureFailure(code)).toBe(expected);
  });

  it("does not collapse scope or locale failures into the generic environment message", () => {
    expect(amazonCaptureFailureGuidance("scope_disabled").title).toBe("批量采集未开放");
    expect(amazonCaptureFailureGuidance("market_locale").title).toBe("页面地区或币种不符");
    expect(amazonCaptureFailureGuidance("environment_unavailable").title).not.toBe("批量采集未开放");
  });
});

describe("resolveAmazonCaptureOutcome", () => {
  it("accepts captured detail only with at least one ready fact", () => {
    expect(resolveAmazonCaptureOutcome({ status: "captured", mode: "detail", readyCount: 1 }).success).toBe(true);
  });

  it.each(["failed", "unavailable", "blocked", "human_required", undefined])("keeps %s as a diagnostic outcome", (status) => {
    const result = resolveAmazonCaptureOutcome({ status, mode: "detail", errorCode: "E_TEST", errorMessage: "reason", traceId: "trace" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result).toMatchObject({ errorCode: "E_TEST", errorMessage: "reason", traceId: "trace" });
  });

  it("does not call an empty captured detail result success", () => {
    expect(resolveAmazonCaptureOutcome({ status: "captured", mode: "detail", readyCount: 0 }).success).toBe(false);
  });

  it("requires actual observations for search success", () => {
    expect(resolveAmazonCaptureOutcome({ status: "captured", mode: "search", observationCount: 0 }).success).toBe(false);
    expect(resolveAmazonCaptureOutcome({ status: "captured", mode: "search", observationCount: 1 }).success).toBe(true);
  });

  it("formats request exceptions with explicit failure state and trace placeholder", () => {
    expect(formatAmazonCaptureRequestFailure(new Error("network disconnected"))).toBe([
      "Amazon 采集未完成。",
      "状态：failed",
      "错误码：CAPTURE_REQUEST_FAILED",
      "原因：network disconnected",
      "traceId：未提供",
    ].join("\n"));
  });
});
