import { describe, expect, it } from "vitest";
import { classifyAmazonCaptureFailure, formatAmazonCaptureRequestFailure, resolveAmazonCaptureOutcome } from "./amazonCaptureOutcome";

describe("classifyAmazonCaptureFailure", () => {
  it.each([
    ["CAPTCHA_DETECTED", "human_confirmation"],
    ["HUMAN_REQUIRED", "human_confirmation"],
    ["LOGIN_REQUIRED", "login_required"],
    ["LOCAL_ENVIRONMENT_REQUIRED", "environment_unavailable"],
    ["PLAYWRIGHT_RUNTIME_MISSING", "environment_unavailable"],
    ["PLAYWRIGHT_BROWSER_FAILED", "network"],
    ["ASIN_BUDGET_INVALID", "invalid_input"],
    ["REVIEW_SOURCE_UNAVAILABLE", "network"],
    ["REVIEW_EXTRACTION_EMPTY", "page_changed"],
    ["ASIN_PAGE_ANCHOR_MISMATCH", "page_changed"],
    ["UNRECOGNIZED_CODE", "unknown"],
  ] as const)("maps %s to %s", (code, expected) => {
    expect(classifyAmazonCaptureFailure(code)).toBe(expected);
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
