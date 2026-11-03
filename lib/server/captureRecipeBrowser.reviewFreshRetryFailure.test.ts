import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 回归：Review fresh-session 重试失败必须留下真实失败记录。
 * 修复前：关闭持久会话 / 启动 fresh 浏览器 / 单次 fresh 尝试抛错都会冒泡到函数外层 catch，
 * 外层带着**持久会话的 extraction_empty** 结果返回 → 证据里 freshSessionAttempts 永远 0，
 * 看起来「已重试」实则从未重试，也无法区分「页面真的没有评论」与「重试机制自身失败」。
 */

const mocks = vi.hoisted(() => ({
  launchPersistentContext: vi.fn(),
  launchFreshBrowser: vi.fn(),
  checkAmazonCapturePreflight: vi.fn(),
  recordDiagnosticEvent: vi.fn(),
  testProfileDir: "",
  testLockRoot: "",
}));

vi.mock("@/lib/server/playwrightRuntime", () => ({
  loadPlaywright: async () => ({
    chromium: {
      launchPersistentContext: mocks.launchPersistentContext,
      launch: mocks.launchFreshBrowser,
    },
  }),
}));

vi.mock("@/lib/server/playwrightProfileLease.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/playwrightProfileLease.mjs")>();
  return {
    ...actual,
    launchPersistentContextWithProfileLock: (_profileDir: string, launch: () => Promise<{ close(): Promise<void> }>) =>
      actual.launchPersistentContextWithProfileLock(mocks.testProfileDir, launch, { lockRoot: mocks.testLockRoot }),
  };
});

vi.mock("@/lib/server/amazonCapturePreflight", () => ({
  checkAmazonCapturePreflight: mocks.checkAmazonCapturePreflight,
}));

vi.mock("@/lib/server/amazonUsSessionEnvironment", () => ({
  ensureAmazonUsSessionEnvironment: async () => ({
    ok: true,
    pageStatus: "ok",
    errorCode: null,
    errorMessage: null,
    failureStage: null,
    failureKind: null,
    elapsedMs: 10,
    navigationElapsedMs: 10,
    calibrationElapsedMs: 0,
    finalEnvironmentStatus: "US_READY",
    hostname: "www.amazon.com",
    delivery: "US",
    language: "en-us",
  }),
  toAmazonSessionFailureReport: () => null,
}));

vi.mock("@/lib/sourceLayer/server/diagnosticService", () => ({
  recordDiagnosticEvent: mocks.recordDiagnosticEvent,
}));

vi.mock("@/tools/collectors/amazon/browser-control", () => ({
  resolveSystemBrowser: () => ({ browser: "chrome", executablePath: "C:/chrome.exe" }),
}));

vi.mock("@/lib/sourceLayer/server/captureGateway", () => ({
  captureThroughGateway: vi.fn(),
}));

import type { AccessContext } from "@/lib/server/accessPassword";
import { collectAmazonReviewsWithPlaywright } from "./captureRecipeBrowser";

const ownerContext = { mode: "owner", token: "" } as unknown as AccessContext;
const ASIN = "B0TEST0001";

const detailExtraction = {
  pageStatus: "ok",
  urlAsin: ASIN,
  pageAsin: ASIN,
  bindingProof: { urlMatchesExpected: true, pageAnchorMatchesExpected: true, productContainerFound: true },
};

function readiness(count: number) {
  return {
    productTitlePresent: true,
    reviewNodeCount: count,
    bodyNodeCount: count,
    explicitNoReviews: false,
    pageTitle: "Amazon.com: test",
    elapsedMs: 100,
    retryAttempt: 1,
    scrollTriggered: true,
  };
}

function makeEvaluate(getSnippets: () => unknown[], reviewNodeCount: () => number) {
  return async (expression: string) => {
    if (typeof expression === "string" && expression.includes("MAX_ITEMS")) return getSnippets();
    if (typeof expression === "string" && expression.includes("reviewNodeCount")) return readiness(reviewNodeCount());
    return detailExtraction;
  };
}

type PageMock = {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  goto: (url: string, options?: { waitUntil?: string; timeout?: number }) => Promise<unknown>;
  waitForSelector: (selector: string, options?: { state?: string; timeout?: number }) => Promise<unknown>;
  url: () => string;
  title: () => Promise<string>;
  evaluate: (expression: string) => Promise<unknown>;
};

function makePage(options: { snippets: unknown[]; reviewNodeCount: () => number; gotoError?: Error }): PageMock {
  return {
    on: () => undefined,
    goto: async () => {
      if (options.gotoError) throw options.gotoError;
      return undefined;
    },
    waitForSelector: async () => undefined,
    url: () => `https://www.amazon.com/dp/${ASIN}?language=en_US&currency=USD`,
    title: async () => "Amazon.com: test",
    evaluate: makeEvaluate(() => options.snippets, options.reviewNodeCount),
  };
}

let testProfileRoot = "";
let previousAcquisition: string | undefined;

beforeEach(async () => {
  testProfileRoot = await mkdtemp(join(tmpdir(), "lightchoice-review-fresh-retry-"));
  mocks.testProfileDir = join(testProfileRoot, "profile");
  mocks.testLockRoot = join(testProfileRoot, "locks");
  await mkdir(mocks.testProfileDir, { recursive: true });
  previousAcquisition = process.env.LOCAL_ACQUISITION_ENABLED;
  process.env.LOCAL_ACQUISITION_ENABLED = "true";
  process.env.V5_ACQUISITION_SCOPE = "batch_and_single";
  mocks.checkAmazonCapturePreflight.mockReset();
  mocks.checkAmazonCapturePreflight.mockResolvedValue({
    ok: true,
    status: "US_READY",
    exitCountry: "US",
    exitCountryName: "United States",
    proxyConfigured: true,
    proxyProtocol: "http",
    failureKind: null,
    probeAttempts: 1,
    fallbackAttempted: false,
    errorCode: null,
    message: "出口为美国。",
    checkedAt: "2026-10-14T08:00:00.000Z",
  });
  mocks.recordDiagnosticEvent.mockReset();
  mocks.recordDiagnosticEvent.mockResolvedValue(undefined);
  mocks.launchPersistentContext.mockReset();
  mocks.launchFreshBrowser.mockReset();
});

afterEach(async () => {
  if (testProfileRoot) await rm(testProfileRoot, { recursive: true, force: true });
  if (previousAcquisition === undefined) delete process.env.LOCAL_ACQUISITION_ENABLED;
  else process.env.LOCAL_ACQUISITION_ENABLED = previousAcquisition;
});

describe("Review fresh-session 重试失败必须留下真实失败记录", () => {
  it("fresh 浏览器启动失败：记录 page_error + REVIEW_FRESH_BROWSER_LAUNCH_FAILED，不再伪装 extraction_empty", async () => {
    const persistentPage = makePage({ snippets: [], reviewNodeCount: () => 0 });
    mocks.launchPersistentContext.mockResolvedValue({
      newPage: async () => persistentPage,
      close: async () => undefined,
    });
    mocks.launchFreshBrowser.mockRejectedValue(new Error("spawn chrome ENOENT"));

    const result = await collectAmazonReviewsWithPlaywright({
      context: ownerContext,
      asins: [{ asin: ASIN, role: "current_candidate" }],
      traceId: "trace-launch-failure",
    });

    const page = result.pageResults.find((item) => item.asin === ASIN);
    expect(page?.status).toBe("page_error");
    expect(page?.status).not.toBe("extraction_empty");
    expect(page?.diagnostics?.strategy).toBe("fresh_context");
    expect(page?.diagnostics?.sessionFailure?.errorCode).toBe("REVIEW_FRESH_BROWSER_LAUNCH_FAILED");
    expect(page?.note).toContain("fresh session 浏览器启动失败");
    expect(result.items).toEqual([]);
  });

  it("fresh 单次尝试导航抛错：记录 page_error + REVIEW_FRESH_SESSION_FAILED", async () => {
    const persistentPage = makePage({ snippets: [], reviewNodeCount: () => 0 });
    mocks.launchPersistentContext.mockResolvedValue({
      newPage: async () => persistentPage,
      close: async () => undefined,
    });
    const freshPage = makePage({
      snippets: [],
      reviewNodeCount: () => 0,
      gotoError: new Error("net::ERR_TIMED_OUT"),
    });
    mocks.launchFreshBrowser.mockResolvedValue({
      newContext: async () => ({ newPage: async () => freshPage, close: async () => undefined }),
      close: async () => undefined,
    });

    const result = await collectAmazonReviewsWithPlaywright({
      context: ownerContext,
      asins: [{ asin: ASIN, role: "current_candidate" }],
      traceId: "trace-navigation-failure",
    });

    const page = result.pageResults.find((item) => item.asin === ASIN);
    expect(page?.status).toBe("page_error");
    expect(page?.diagnostics?.sessionFailure?.errorCode).toBe("REVIEW_FRESH_SESSION_FAILED");
    expect(page?.diagnostics?.freshSessionAttempts).toBeGreaterThanOrEqual(0);
    expect(page?.note).toContain("ERR_TIMED_OUT");
  });

  it("fresh 尝试成功：保留成功语义并记录 fresh 尝试次数", async () => {
    const persistentPage = makePage({ snippets: [], reviewNodeCount: () => 0 });
    mocks.launchPersistentContext.mockResolvedValue({
      newPage: async () => persistentPage,
      close: async () => undefined,
    });
    const snippet = {
      rating: 5,
      date: "January 5, 2026",
      title: "Great mat",
      reviewText: "Works well for baking cookies.",
      verifiedPurchase: true,
    };
    const freshPage = makePage({ snippets: [snippet], reviewNodeCount: () => 1 });
    mocks.launchFreshBrowser.mockResolvedValue({
      newContext: async () => ({ newPage: async () => freshPage, close: async () => undefined }),
      close: async () => undefined,
    });

    const result = await collectAmazonReviewsWithPlaywright({
      context: ownerContext,
      asins: [{ asin: ASIN, role: "current_candidate" }],
      traceId: "trace-success",
    });

    const page = result.pageResults.find((item) => item.asin === ASIN);
    expect(result.status).toBe("captured");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.reviewText).toBe("Works well for baking cookies.");
    expect(page?.status).toBe("ok");
    expect(page?.diagnostics?.strategy).toBe("fresh_context");
    expect(page?.diagnostics?.freshSessionAttempts).toBe(1);
  });
});