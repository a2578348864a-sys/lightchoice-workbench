import { describe, expect, it, vi } from "vitest";
import {
  AMAZON_NAVIGATION_TIMEOUT_MS,
  AMAZON_SESSION_FAILURE_KINDS,
  AMAZON_SESSION_STAGES,
  classifyThrownSessionFailure,
  describeSessionError,
  isSessionTimeoutError,
} from "./amazonSessionDiagnostics";

function timeoutError(message = "page.goto: Timeout 60000ms exceeded."): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

describe("Amazon 会话诊断词汇", () => {
  it("导航超时是有界常量：60 秒且不超过 60 秒上限", () => {
    expect(AMAZON_NAVIGATION_TIMEOUT_MS).toBe(60_000);
    expect(AMAZON_NAVIGATION_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
    expect(Number.isFinite(AMAZON_NAVIGATION_TIMEOUT_MS)).toBe(true);
  });

  it("阶段与失败类型覆盖任务书要求的最小集合", () => {
    for (const stage of [
      "PREFLIGHT", "BROWSER_LAUNCH", "BROWSER_CLOSE", "OPEN_AMAZON_HOME", "READ_PAGE_STATUS",
      "READ_DELIVERY_SIGNAL", "OPEN_DELIVERY_DIALOG", "ENTER_US_ZIP", "APPLY_US_ZIP",
      "VERIFY_DELIVERY", "VERIFY_LANGUAGE", "SESSION_READY",
    ]) {
      expect(AMAZON_SESSION_STAGES).toContain(stage);
    }
    for (const kind of [
      "NAVIGATION_TIMEOUT", "NAVIGATION_ERROR", "AMAZON_ERROR_PAGE", "DELIVERY_SIGNAL_NOT_FOUND",
      "DELIVERY_DIALOG_TIMEOUT", "ZIP_INPUT_TIMEOUT", "ZIP_APPLY_TIMEOUT", "DELIVERY_VERIFY_FAILED",
      "LANGUAGE_MISMATCH", "UNKNOWN_SESSION_FAILURE",
    ]) {
      expect(AMAZON_SESSION_FAILURE_KINDS).toContain(kind);
    }
  });

  it("超时判定识别 Playwright TimeoutError 与超时文案", () => {
    expect(isSessionTimeoutError(timeoutError())).toBe(true);
    expect(isSessionTimeoutError(new Error("Timeout 60000ms exceeded."))).toBe(true);
    expect(isSessionTimeoutError(new Error("popover did not open"))).toBe(false);
    expect(isSessionTimeoutError(undefined)).toBe(false);
  });

  it("按阶段把抛错分类，导航阶段区分超时与一般导航错误", () => {
    expect(classifyThrownSessionFailure("OPEN_AMAZON_HOME", timeoutError())).toBe("NAVIGATION_TIMEOUT");
    expect(classifyThrownSessionFailure("OPEN_AMAZON_HOME", new Error("net::ERR_RESET"))).toBe("NAVIGATION_ERROR");
    expect(classifyThrownSessionFailure("READ_DELIVERY_SIGNAL", new Error("x"))).toBe("DELIVERY_SIGNAL_NOT_FOUND");
    expect(classifyThrownSessionFailure("OPEN_DELIVERY_DIALOG", timeoutError("locator.click: Timeout 8000ms exceeded."))).toBe("DELIVERY_DIALOG_TIMEOUT");
    expect(classifyThrownSessionFailure("ENTER_US_ZIP", new Error("x"))).toBe("ZIP_INPUT_TIMEOUT");
    expect(classifyThrownSessionFailure("APPLY_US_ZIP", new Error("x"))).toBe("ZIP_APPLY_TIMEOUT");
    expect(classifyThrownSessionFailure("SESSION_READY", new Error("x"))).toBe("UNKNOWN_SESSION_FAILURE");
  });

  it("异常描述只保留安全字段：截断、单行、凭据打码", () => {
    const longMessage = `page.goto failed //user:secret-proxy-password@proxy.local:8080 ${"x".repeat(600)}`;
    const described = describeSessionError(new Error(longMessage));
    expect(described.name).toBe("Error");
    expect(described.detail).not.toBeNull();
    expect((described.detail ?? "").length).toBeLessThanOrEqual(300);
    expect(described.detail).not.toContain("secret-proxy-password");
    expect(described.detail).toContain("//user:***@proxy.local:8080");
    expect(described.detail?.includes("\n")).toBe(false);
  });

  it("异常描述不会把非异常输入变成可用字符串", () => {
    expect(describeSessionError(undefined)).toEqual({ name: null, detail: null });
    expect(describeSessionError({ cookie: "session-token" })).toEqual({ name: null, detail: null });
    expect(describeSessionError("  ")).toEqual({ name: null, detail: null });
  });
});
