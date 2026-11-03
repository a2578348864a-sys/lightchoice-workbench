import { describe, expect, it, vi } from "vitest";
import { AMAZON_NAVIGATION_TIMEOUT_MS } from "./amazonSessionDiagnostics";
import {
  MAX_AMAZON_US_SESSION_CALIBRATION_ATTEMPTS,
  ensureAmazonUsSessionEnvironment,
  type AmazonSessionEnvironmentDiagnostic,
} from "./amazonUsSessionEnvironment";

type GotoOptions = { waitUntil?: string; timeout?: number };

function fakePage(delivery: string, language = "en-US", calibrates = true) {
  let currentDelivery = delivery;
  const goto = vi.fn(async (_url: string, _options?: GotoOptions) => undefined);
  const fill = vi.fn(async () => { if (calibrates) currentDelivery = "New York 10001"; });
  const click = vi.fn(async () => undefined);
  const page = {
    goto,
    url: () => "https://www.amazon.com/",
    title: async () => "Amazon.com. Spend less. Smile more.",
    evaluate: async <T>() => ({ delivery: currentDelivery, language, title: "Amazon.com", marker: true }) as T,
    locator: (selector: string) => ({
      click: async () => { await click(); },
      fill: async () => { await fill(); },
      count: async () => selector === "#GLUXConfirmClose" ? 0 : 1,
    }),
  };
  return { page, goto, fill, click };
}

function timeoutError(message = "page.goto: Timeout 60000ms exceeded."): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

function collectDiagnostics() {
  const diagnostics: AmazonSessionEnvironmentDiagnostic[] = [];
  return {
    diagnostics,
    onDiagnostic: async (fields: AmazonSessionEnvironmentDiagnostic) => { diagnostics.push(fields); },
  };
}

describe("ensureAmazonUsSessionEnvironment", () => {
  it("校准次数上限锁死为 1", () => {
    expect(MAX_AMAZON_US_SESSION_CALIBRATION_ATTEMPTS).toBe(1);
  });

  it("does not open a browser when network preflight is not US_READY", async () => {
    const { page, goto, fill, click } = fakePage("Tokyo Japan");
    const diagnostics: Array<{ networkPreflight: string; calibrationAttempted: boolean; finalEnvironmentStatus: string; traceId: string }> = [];
    const result = await ensureAmazonUsSessionEnvironment({
      page,
      networkPreflight: "NON_US_EXIT",
      module: "SEARCH",
      traceId: "trace-non-us",
      onDiagnostic: async (fields) => { diagnostics.push(fields); },
    });
    expect(result.ok).toBe(false);
    expect(goto).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(diagnostics).toMatchObject([{
      networkPreflight: "NON_US_EXIT",
      calibrationAttempted: false,
      finalEnvironmentStatus: "BLOCKED",
      traceId: "trace-non-us",
    }]);
    // 非美国出口不需要 session 级 failureKind：原因由 networkPreflight 表达。
    expect(result).toMatchObject({ failureStage: "PREFLIGHT", failureKind: null });
  });

  it("accepts an existing US session without calibration", async () => {
    const { page, fill, goto } = fakePage("New York 10001");
    const result = await ensureAmazonUsSessionEnvironment({ page, networkPreflight: "US_READY", module: "DETAIL", traceId: "t" });
    expect(result).toMatchObject({ ok: true, deliveryBefore: "US", calibrationAttempted: false, deliveryAfter: "US" });
    expect(fill).not.toHaveBeenCalled();
    // 一次导航、最多 60 秒；就绪会话不产生第二次导航。
    expect(goto).toHaveBeenCalledTimes(1);
    expect(goto.mock.calls[0]?.[1]).toMatchObject({ timeout: AMAZON_NAVIGATION_TIMEOUT_MS });
    expect(result).toMatchObject({ stage: "SESSION_READY", failureStage: null, failureKind: null });
    expect(result.navigationElapsedMs).toBeLessThanOrEqual(AMAZON_NAVIGATION_TIMEOUT_MS);
  });

  it("waits once for a fresh Amazon home header to hydrate before classifying the session", async () => {
    const { page: basePage, goto } = fakePage("New York 10001");
    let headerReady = false;
    const waitForSelector = vi.fn(async () => { headerReady = true; });
    const page = {
      ...basePage,
      waitForSelector,
      evaluate: async <T>() => ({
        delivery: "New York 10001",
        language: "en-US",
        title: "Amazon.com. Spend less. Smile more.",
        marker: headerReady,
      }) as T,
    };

    const result = await ensureAmazonUsSessionEnvironment({
      page,
      networkPreflight: "US_READY",
      module: "REVIEW",
      traceId: "trace-fresh-home-hydration",
    });

    expect(result).toMatchObject({ ok: true, stage: "SESSION_READY", deliveryBefore: "US" });
    expect(goto).toHaveBeenCalledTimes(1);
    expect(waitForSelector).toHaveBeenCalledTimes(1);
    expect(waitForSelector).toHaveBeenCalledWith("#nav-logo-sprites, #nav-logo", {
      state: "attached",
      timeout: 5_000,
    });
  });

  it("calibrates a stale Japan session once and verifies again", async () => {
    const { page, fill, click } = fakePage("Tokyo Japan");
    const diagnostics: Array<{
      module: string;
      eventType: string;
      networkPreflight: string;
      sessionDeliveryBefore: string;
      calibrationAttempted: boolean;
      sessionDeliveryAfter: string;
      finalEnvironmentStatus: string;
      traceId: string;
    }> = [];
    const result = await ensureAmazonUsSessionEnvironment({
      page,
      networkPreflight: "US_READY",
      module: "SEARCH",
      traceId: "trace-calibration-success",
      onDiagnostic: async (fields) => { diagnostics.push(fields); },
    });
    expect(result).toMatchObject({ ok: true, deliveryBefore: "NON_US", calibrationAttempted: true, deliveryAfter: "US" });
    expect(fill).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(2);
    expect(diagnostics).toMatchObject([{
      module: "SEARCH",
      eventType: "amazon_us_session_environment_checked",
      networkPreflight: "US_READY",
      sessionDeliveryBefore: "Japan",
      calibrationAttempted: true,
      sessionDeliveryAfter: "US",
      finalEnvironmentStatus: "US_READY",
      traceId: "trace-calibration-success",
    }]);
    expect(result).toMatchObject({ stage: "SESSION_READY", failureStage: null, failureKind: null });
  });

  it("still calibrates stale Japan delivery before failing a non-English session closed", async () => {
    const { page, fill, click } = fakePage("Tokyo Japan", "ja-JP");
    const result = await ensureAmazonUsSessionEnvironment({ page, networkPreflight: "US_READY", module: "DETAIL", traceId: "t" });
    expect(result).toMatchObject({
      ok: false,
      errorCode: "LOCALE_MISMATCH",
      deliveryBefore: "NON_US",
      calibrationAttempted: true,
      deliveryAfter: "US",
      language: "ja-jp",
    });
    expect(fill).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ failureStage: "VERIFY_LANGUAGE", failureKind: "LANGUAGE_MISMATCH" });
  });

  it("fails closed after one unsuccessful calibration", async () => {
    const { page, fill } = fakePage("Tokyo Japan", "en-US", false);
    const result = await ensureAmazonUsSessionEnvironment({ page, networkPreflight: "US_READY", module: "REVIEW", traceId: "t" });
    expect(result).toMatchObject({ ok: false, errorCode: "AMAZON_US_SESSION_CALIBRATION_FAILED", calibrationAttempted: true, deliveryAfter: "NON_US" });
    expect(fill).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ failureStage: "VERIFY_DELIVERY", failureKind: "DELIVERY_VERIFY_FAILED" });
  });

  it("preserves observed delivery and attempt diagnostics when the UI calibration throws", async () => {
    const { page } = fakePage("Tokyo Japan");
    const { diagnostics, onDiagnostic } = collectDiagnostics();
    const failingPage = {
      ...page,
      locator(selector: string) {
        if (selector === "#nav-global-location-popover-link") {
          return { click: async () => { throw timeoutError("locator.click: Timeout 8000ms exceeded."); }, fill: async () => undefined, count: async () => 1 };
        }
        return page.locator(selector);
      },
    };

    const result = await ensureAmazonUsSessionEnvironment({
      page: failingPage,
      networkPreflight: "US_READY",
      module: "SEARCH",
      traceId: "trace-calibration-click-failed",
      onDiagnostic,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: "AMAZON_US_SESSION_CALIBRATION_FAILED",
      deliveryBefore: "NON_US",
      calibrationAttempted: true,
      deliveryAfter: "UNKNOWN",
    });
    expect(diagnostics).toMatchObject([{
      networkPreflight: "US_READY",
      sessionDeliveryBefore: "Japan",
      calibrationAttempted: true,
      sessionDeliveryAfter: "UNKNOWN",
      finalEnvironmentStatus: "BLOCKED",
      traceId: "trace-calibration-click-failed",
    }]);
    expect(result).toMatchObject({ failureStage: "OPEN_DELIVERY_DIALOG", failureKind: "DELIVERY_DIALOG_TIMEOUT" });
  });

  it("导航超时：定位到 OPEN_AMAZON_HOME / NAVIGATION_TIMEOUT 并保留安全异常字段", async () => {
    const { page, goto, fill } = fakePage("New York 10001");
    goto.mockRejectedValue(timeoutError());
    const { diagnostics, onDiagnostic } = collectDiagnostics();
    const result = await ensureAmazonUsSessionEnvironment({
      page,
      networkPreflight: "US_READY",
      module: "DETAIL",
      traceId: "trace-navigation-timeout",
      onDiagnostic,
    });

    expect(result).toMatchObject({
      ok: false,
      failureStage: "OPEN_AMAZON_HOME",
      failureKind: "NAVIGATION_TIMEOUT",
      errorName: "TimeoutError",
      errorCode: "AMAZON_US_SESSION_CALIBRATION_FAILED",
    });
    expect(result.errorDetail).toContain("Timeout 60000ms exceeded");
    expect(goto).toHaveBeenCalledTimes(1);
    expect(goto.mock.calls[0]?.[1]).toMatchObject({ timeout: AMAZON_NAVIGATION_TIMEOUT_MS });
    expect(fill).not.toHaveBeenCalled();
    expect(result.navigationElapsedMs).toBeLessThanOrEqual(AMAZON_NAVIGATION_TIMEOUT_MS);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      failureStage: "OPEN_AMAZON_HOME",
      failureKind: "NAVIGATION_TIMEOUT",
      errorName: "TimeoutError",
    });
  });

  it("页面打开但读不到配送地区信号：定位到 READ_DELIVERY_SIGNAL 且不做盲目校准", async () => {
    const { page, fill, click } = fakePage("");
    const result = await ensureAmazonUsSessionEnvironment({ page, networkPreflight: "US_READY", module: "DETAIL", traceId: "t" });

    expect(result).toMatchObject({
      ok: false,
      pageStatus: "ok",
      deliveryBefore: "UNKNOWN",
      calibrationAttempted: false,
      failureStage: "READ_DELIVERY_SIGNAL",
      failureKind: "DELIVERY_SIGNAL_NOT_FOUND",
    });
    expect(fill).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it("Amazon 错误页：定位到 READ_PAGE_STATUS / AMAZON_ERROR_PAGE", async () => {
    const { page } = fakePage("New York 10001");
    const errorPage = {
      ...page,
      evaluate: async <T>() => ({ delivery: "", language: "", title: "Sorry! Something went wrong!", marker: false }) as T,
    };
    const result = await ensureAmazonUsSessionEnvironment({ page: errorPage, networkPreflight: "US_READY", module: "DETAIL", traceId: "t" });
    expect(result).toMatchObject({
      ok: false,
      errorCode: "PAGE_CHANGED",
      pageStatus: "blocked",
      failureStage: "READ_PAGE_STATUS",
      failureKind: "AMAZON_ERROR_PAGE",
    });
  });

  it("校准后重载仍超时：阶段回到 OPEN_AMAZON_HOME，导航次数不超过 2", async () => {
    const { page, goto, fill } = fakePage("Tokyo Japan");
    goto.mockImplementation(async () => {
      if (goto.mock.calls.length >= 2) throw timeoutError();
      return undefined;
    });
    const result = await ensureAmazonUsSessionEnvironment({ page, networkPreflight: "US_READY", module: "SEARCH", traceId: "t" });

    expect(goto).toHaveBeenCalledTimes(2);
    expect(fill).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      calibrationAttempted: true,
      failureStage: "OPEN_AMAZON_HOME",
      failureKind: "NAVIGATION_TIMEOUT",
    });
    expect(result.calibrationElapsedMs).toBeGreaterThanOrEqual(0);
  });
});
