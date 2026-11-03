import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AMAZON_NAVIGATION_TIMEOUT_MS } from "./amazonSessionDiagnostics";

const mocks = vi.hoisted(() => ({
  recordDiagnosticEvent: vi.fn(),
  captureThroughGateway: vi.fn(),
}));

vi.mock("@/lib/sourceLayer/server/diagnosticService", () => ({
  recordDiagnosticEvent: mocks.recordDiagnosticEvent,
}));

vi.mock("@/lib/sourceLayer/server/captureGateway", () => ({
  captureThroughGateway: mocks.captureThroughGateway,
}));

import type { AccessContext } from "@/lib/server/accessPassword";
import { checkAmazonSessionReadiness } from "./amazonSessionReadiness";

const ownerContext = { mode: "owner", userId: "owner-1", token: "test-token" } as unknown as AccessContext;
beforeEach(() => vi.stubEnv("LOCAL_ACQUISITION_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

it("reports the disabled capture gate without launching a session or writing diagnostics", async () => {
  vi.stubEnv("LOCAL_ACQUISITION_ENABLED", "false");
  const checkPreflight = vi.fn(); const openSession = vi.fn();
  const result = await checkAmazonSessionReadiness({ context: ownerContext, deps: { checkPreflight, openSession } });
  expect(result).toMatchObject({ status: "ACQUISITION_DISABLED", errorCode: "LOCAL_ENVIRONMENT_REQUIRED", sessionReady: false, browserLaunched: false });
  expect(checkPreflight).not.toHaveBeenCalled(); expect(openSession).not.toHaveBeenCalled();
});

const usReadyPreflight = {
  ok: true,
  status: "US_READY" as const,
  exitCountry: "US",
  exitCountryName: "United States",
  proxyConfigured: true,
  proxyProtocol: "http",
  failureKind: null,
  probeAttempts: 1,
  fallbackAttempted: false,
  errorCode: null,
  message: "采集出口为美国 (US)，符合 Amazon US 采集要求。",
  checkedAt: "2026-09-23T15:30:14.330Z",
};

const nonUsPreflight = {
  ...usReadyPreflight,
  ok: false,
  status: "NON_US_EXIT" as const,
  exitCountry: "JP",
  exitCountryName: "Japan",
  errorCode: "AMAZON_CAPTURE_NON_US_EXIT" as const,
  message: "当前采集出口不是美国（检测到 Japan / JP）。",
};

type GotoOptions = { waitUntil?: string; timeout?: number };

function fakePage(delivery: string, language = "en-US", calibrates = true) {
  let currentDelivery = delivery;
  const goto = vi.fn(async (_url: string, _options?: GotoOptions) => undefined);
  const fill = vi.fn(async () => { if (calibrates) currentDelivery = "New York 10001"; });
  const page = {
    goto,
    url: () => "https://www.amazon.com/",
    title: async () => "Amazon.com. Spend less. Smile more.",
    evaluate: async <T>() => ({ delivery: currentDelivery, language, title: "Amazon.com", marker: true }) as T,
    locator: (_selector: string) => ({
      click: async () => undefined,
      fill: async () => { await fill(); },
      count: async () => 0,
    }),
  };
  return { page, goto, fill };
}

function timeoutError(message = "page.goto: Timeout 60000ms exceeded."): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

function sessionOf(delivery: string, language = "en-US", calibrates = true) {
  const { page, goto, fill } = fakePage(delivery, language, calibrates);
  const close = vi.fn(async () => undefined);
  return { openSession: async () => ({ ok: true as const, page, close }), close, goto, fill };
}

describe("checkAmazonSessionReadiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordDiagnosticEvent.mockResolvedValue(undefined);
  });

  it("非美国出口：不启动浏览器，返回 PREFLIGHT_BLOCKED", async () => {
    const openSession = vi.fn();
    const result = await checkAmazonSessionReadiness({
      context: ownerContext,
      deps: { checkPreflight: async () => nonUsPreflight, openSession },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "PREFLIGHT_BLOCKED",
      sessionReady: false,
      networkPreflight: "NON_US_EXIT",
      exitCountry: "JP",
      browserLaunched: false,
      failureStage: "PREFLIGHT",
      failureKind: null,
      pageStatus: "blocked",
      delivery: "UNKNOWN",
    });
    expect(openSession).not.toHaveBeenCalled();
    expect(mocks.captureThroughGateway).not.toHaveBeenCalled();
  });

  it("US_READY + 首页正常 + delivery US：SESSION_READY 且不产生采集事实", async () => {
    const session = sessionOf("New York 10001");
    const result = await checkAmazonSessionReadiness({
      context: ownerContext,
      deps: { checkPreflight: async () => usReadyPreflight, openSession: session.openSession },
    });

    expect(result).toMatchObject({
      ok: true,
      status: "SESSION_READY",
      sessionReady: true,
      networkPreflight: "US_READY",
      browserLaunched: true,
      hostname: "www.amazon.com",
      pageStatus: "ok",
      delivery: "US",
      language: "en-us",
      calibrationAttempted: false,
      failureStage: null,
      failureKind: null,
      errorCode: null,
    });
    expect(result.navigationElapsedMs).toBeLessThanOrEqual(AMAZON_NAVIGATION_TIMEOUT_MS);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(mocks.captureThroughGateway).not.toHaveBeenCalled();
    expect(mocks.recordDiagnosticEvent).toHaveBeenCalledTimes(1);
    expect(mocks.recordDiagnosticEvent.mock.calls[0]?.[0]).toMatchObject({
      event: {
        eventType: "amazon_us_session_readiness_checked",
        module: "SESSION_READINESS",
        status: "succeeded",
        subjectKey: "amazon:US:session-readiness",
      },
    });
  });

  it("浏览器关闭失败时不会把会话报告为 SESSION_READY", async () => {
    const session = sessionOf("New York 10001");
    session.close.mockRejectedValue(Object.assign(new Error("close failed"), { code: "PROFILE_BROWSER_CLOSE_FAILED" }));
    const result = await checkAmazonSessionReadiness({
      context: ownerContext,
      deps: { checkPreflight: async () => usReadyPreflight, openSession: session.openSession },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "SESSION_NOT_READY",
      sessionReady: false,
      failureStage: "BROWSER_CLOSE",
      errorCode: "PROFILE_BROWSER_CLOSE_FAILED",
    });
    expect(mocks.recordDiagnosticEvent.mock.calls[0]?.[0]).toMatchObject({
      event: { status: "blocked", errorCode: "PROFILE_BROWSER_CLOSE_FAILED", humanRequired: true },
    });
  });

  it("US_READY + 第一次 delivery 非 US：一次校准后 SESSION_READY", async () => {
    const session = sessionOf("Tokyo Japan");
    const result = await checkAmazonSessionReadiness({
      deps: { checkPreflight: async () => usReadyPreflight, openSession: session.openSession },
    });

    expect(result).toMatchObject({
      ok: true,
      status: "SESSION_READY",
      sessionReady: true,
      delivery: "US",
      language: "en-us",
      calibrationAttempted: true,
    });
    expect(session.fill).toHaveBeenCalledTimes(1);
    expect(session.goto).toHaveBeenCalledTimes(2);
  });

  it("导航超时：SESSION_NOT_READY 且明确给出阶段 / 类型 / 耗时", async () => {
    const session = sessionOf("New York 10001");
    session.goto.mockRejectedValue(timeoutError());
    const result = await checkAmazonSessionReadiness({
      context: ownerContext,
      deps: { checkPreflight: async () => usReadyPreflight, openSession: session.openSession },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "SESSION_NOT_READY",
      sessionReady: false,
      browserLaunched: true,
      failureStage: "OPEN_AMAZON_HOME",
      failureKind: "NAVIGATION_TIMEOUT",
      errorName: "TimeoutError",
      errorCode: "AMAZON_US_SESSION_CALIBRATION_FAILED",
    });
    expect(result.errorDetail).toContain("Timeout 60000ms exceeded");
    expect(Number.isFinite(result.elapsedMs)).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(mocks.recordDiagnosticEvent.mock.calls[0]?.[0]).toMatchObject({
      event: { status: "blocked", humanRequired: true },
    });
  });

  it("浏览器不可用：BROWSER_UNAVAILABLE 且 browserLaunched=false", async () => {
    const result = await checkAmazonSessionReadiness({
      deps: {
        checkPreflight: async () => usReadyPreflight,
        openSession: async () => ({ ok: false as const, errorCode: "PLAYWRIGHT_RUNTIME_MISSING", errorMessage: "当前项目未安装 Playwright runtime。", errorName: null, errorDetail: null }),
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "BROWSER_UNAVAILABLE",
      browserLaunched: false,
      failureStage: "BROWSER_LAUNCH",
      errorCode: "PLAYWRIGHT_RUNTIME_MISSING",
    });
    expect(mocks.captureThroughGateway).not.toHaveBeenCalled();
  });

  it("未传 context 时不写审计事件，但结果仍然完整", async () => {
    const session = sessionOf("New York 10001");
    const result = await checkAmazonSessionReadiness({
      deps: { checkPreflight: async () => usReadyPreflight, openSession: session.openSession },
    });
    expect(result.status).toBe("SESSION_READY");
    expect(mocks.recordDiagnosticEvent).not.toHaveBeenCalled();
  });

  it("同一次 Readiness 检查把相同代理快照传给出口预检和浏览器启动", async () => {
    const original = process.env.AMAZON_CAPTURE_PROXY_URL;
    process.env.AMAZON_CAPTURE_PROXY_URL = "http://127.0.0.1:7890";
    let preflightEnv: Record<string, string | undefined> | undefined;
    let browserEnv: Record<string, string | undefined> | undefined;
    const session = sessionOf("New York 10001");

    try {
      const result = await checkAmazonSessionReadiness({
        deps: {
          checkPreflight: async (proxyEnv) => {
            preflightEnv = proxyEnv;
            process.env.AMAZON_CAPTURE_PROXY_URL = "http://127.0.0.1:9999";
            return usReadyPreflight;
          },
          openSession: async (proxyEnv) => {
            browserEnv = proxyEnv;
            return session.openSession();
          },
        },
      });

      expect(result.status).toBe("SESSION_READY");
      expect(preflightEnv?.AMAZON_CAPTURE_PROXY_URL).toBe("http://127.0.0.1:7890");
      expect(browserEnv).toEqual(preflightEnv);
      expect(session.close).toHaveBeenCalledOnce();
    } finally {
      if (original === undefined) delete process.env.AMAZON_CAPTURE_PROXY_URL;
      else process.env.AMAZON_CAPTURE_PROXY_URL = original;
    }
  });
});
