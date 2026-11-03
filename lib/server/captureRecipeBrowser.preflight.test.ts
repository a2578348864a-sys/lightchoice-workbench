import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launchPersistentContext: vi.fn(),
  checkAmazonCapturePreflight: vi.fn(),
  recordDiagnosticEvent: vi.fn(),
  captureThroughGateway: vi.fn(),
  testProfileDir: "",
  testLockRoot: "",
}));

vi.mock("@/lib/server/playwrightRuntime", () => ({
  loadPlaywright: async () => ({
    chromium: { launchPersistentContext: mocks.launchPersistentContext },
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

vi.mock("@/lib/sourceLayer/server/diagnosticService", () => ({
  recordDiagnosticEvent: mocks.recordDiagnosticEvent,
}));

vi.mock("@/tools/collectors/amazon/browser-control", () => ({
  resolveSystemBrowser: () => ({ browser: "chrome", executablePath: "C:/chrome.exe" }),
}));

vi.mock("@/lib/sourceLayer/server/captureGateway", () => ({
  captureThroughGateway: mocks.captureThroughGateway,
}));

vi.mock("@/lib/sourceLayer/v3ModuleEvidence", () => ({ captureV3ModuleEvidence: vi.fn() }));

import type { AccessContext } from "@/lib/server/accessPassword";
import {
  collectAmazonDetailWithPlaywright,
  collectAmazonReviewsWithPlaywright,
  collectAmazonSearchWithPlaywright,
  collectAmazonVariationsWithPlaywright,
} from "./captureRecipeBrowser";
import { acquirePlaywrightProfileLock } from "./playwrightProfileLease.mjs";

const ownerContext = { mode: "owner", userId: "owner-1", token: "test-token" } as unknown as AccessContext;
let testProfileRoot = "";

beforeEach(async () => {
  testProfileRoot = await mkdtemp(join(tmpdir(), "lightchoice-capture-browser-test-"));
  mocks.testProfileDir = join(testProfileRoot, "profile");
  mocks.testLockRoot = join(testProfileRoot, "locks");
  await mkdir(mocks.testProfileDir, { recursive: true });
});

afterEach(async () => {
  if (testProfileRoot) await rm(testProfileRoot, { recursive: true, force: true });
});

const nonUsPreflight = {
  ok: false,
  status: "NON_US_EXIT" as const,
  exitCountry: "JP",
  exitCountryName: "Japan",
  proxyConfigured: true,
  proxyProtocol: "http",
  failureKind: null,
  probeAttempts: 1,
  fallbackAttempted: false,
  errorCode: "AMAZON_CAPTURE_NON_US_EXIT" as const,
  message: "当前采集出口不是美国（检测到 Japan / JP）。",
  checkedAt: "2026-09-23T00:00:00.000Z",
};

describe("Amazon 三个正式 Playwright 入口的非美国出口阻断", () => {
  const previousLocalAcquisition = process.env.LOCAL_ACQUISITION_ENABLED;

  beforeEach(() => {
    process.env.LOCAL_ACQUISITION_ENABLED = "true";
  process.env.V5_ACQUISITION_SCOPE = "batch_and_single";
    mocks.checkAmazonCapturePreflight.mockResolvedValue(nonUsPreflight);
    mocks.launchPersistentContext.mockReset();
    mocks.recordDiagnosticEvent.mockReset();
    mocks.recordDiagnosticEvent.mockResolvedValue(undefined);
    mocks.captureThroughGateway.mockReset();
  });

  afterEach(() => {
    if (previousLocalAcquisition === undefined) delete process.env.LOCAL_ACQUISITION_ENABLED;
    else process.env.LOCAL_ACQUISITION_ENABLED = previousLocalAcquisition;
  });

  it("blocks Detail/Search/Review/Variation when active capture is disabled, before network/browser/store", async () => {
    process.env.LOCAL_ACQUISITION_ENABLED = "false";
    mocks.checkAmazonCapturePreflight.mockClear();
    const detail = await collectAmazonDetailWithPlaywright({ context: ownerContext, asin: "B000000001" });
    const search = await collectAmazonSearchWithPlaywright({ context: ownerContext, query: "kitchen organizer" });
    const review = await collectAmazonReviewsWithPlaywright({
      context: ownerContext,
      asins: [{ asin: "B000000001", role: "current_candidate" }],
    });
    const variation = await collectAmazonVariationsWithPlaywright({ context: ownerContext, asins: [{ asin: "B000000001" }] });
    expect([detail.errorCode, search.errorCode, review.errorCode, variation.errorCode]).toEqual([
      "LOCAL_ENVIRONMENT_REQUIRED",
      "LOCAL_ENVIRONMENT_REQUIRED",
      "LOCAL_ENVIRONMENT_REQUIRED",
      "LOCAL_ENVIRONMENT_REQUIRED",
    ]);
    expect(review.items).toEqual([]);
    expect(variation.results).toEqual([]);
    expect(mocks.checkAmazonCapturePreflight).not.toHaveBeenCalled();
    expect(mocks.launchPersistentContext).not.toHaveBeenCalled(); expect(mocks.captureThroughGateway).not.toHaveBeenCalled();
  });

  it("Detail + NON_US_EXIT：不启动 launchPersistentContext，capture 为 null", async () => {
    const result = await collectAmazonDetailWithPlaywright({
      context: ownerContext,
      asin: "B0TEST0001",
    });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("AMAZON_CAPTURE_NON_US_EXIT");
    expect(result.capture).toBeNull();
    expect(mocks.launchPersistentContext).not.toHaveBeenCalled();
    expect(mocks.captureThroughGateway).not.toHaveBeenCalled();
    expect(mocks.recordDiagnosticEvent).toHaveBeenCalledTimes(1);
  });

  it("Review + NON_US_EXIT：不启动 launchPersistentContext，items 为空", async () => {
    const result = await collectAmazonReviewsWithPlaywright({
      context: ownerContext,
      asins: [{ asin: "B0TEST0001", role: "current_candidate" }],
    });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("AMAZON_CAPTURE_NON_US_EXIT");
    expect(result.items).toEqual([]);
    expect(result.pageResults).toEqual([]);
    expect(mocks.launchPersistentContext).not.toHaveBeenCalled();
    expect(mocks.captureThroughGateway).not.toHaveBeenCalled();
  });

  it("Search + NON_US_EXIT：不启动 launchPersistentContext，captures 为空", async () => {
    const result = await collectAmazonSearchWithPlaywright({
      context: ownerContext,
      query: "kitchen organizer",
    });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("AMAZON_CAPTURE_NON_US_EXIT");
    expect(result.captures).toEqual([]);
    expect(mocks.launchPersistentContext).not.toHaveBeenCalled();
    expect(mocks.captureThroughGateway).not.toHaveBeenCalled();
  });

  it("Profile 已被另一个持有者锁定时返回 PROFILE_IN_USE，不启动 Playwright", async () => {
    mocks.checkAmazonCapturePreflight.mockResolvedValue({
      ...nonUsPreflight,
      ok: true,
      status: "US_READY",
      exitCountry: "US",
      errorCode: null,
      failureKind: null,
      probeAttempts: 1,
      fallbackAttempted: false,
    });
    const release = await acquirePlaywrightProfileLock(mocks.testProfileDir, { lockRoot: mocks.testLockRoot });
    try {
      const result = await collectAmazonDetailWithPlaywright({ context: ownerContext, asin: "B0TEST0001" });
      expect(result.errorCode).toBe("PROFILE_IN_USE");
      expect(result.errorMessage).toContain("未启动浏览器");
      expect(mocks.launchPersistentContext).not.toHaveBeenCalled();
    } finally {
      await release();
    }
  });
});

describe("Amazon 会话门禁失败时的阶段级诊断透传", () => {
  const previousLocalAcquisition = process.env.LOCAL_ACQUISITION_ENABLED;

  beforeEach(() => {
    process.env.LOCAL_ACQUISITION_ENABLED = "true";
  process.env.V5_ACQUISITION_SCOPE = "batch_and_single";
    mocks.checkAmazonCapturePreflight.mockResolvedValue({
      ...nonUsPreflight,
      ok: true,
      status: "US_READY" as const,
      exitCountry: "US",
      exitCountryName: "United States",
      errorCode: null,
      message: "采集出口为美国 (US)，符合 Amazon US 采集要求。",
    });
    mocks.launchPersistentContext.mockReset();
    mocks.recordDiagnosticEvent.mockReset();
    mocks.recordDiagnosticEvent.mockResolvedValue(undefined);
    mocks.captureThroughGateway.mockReset();
  });

  afterEach(() => {
    if (previousLocalAcquisition === undefined) delete process.env.LOCAL_ACQUISITION_ENABLED;
    else process.env.LOCAL_ACQUISITION_ENABLED = previousLocalAcquisition;
  });

  function sessionPage(delivery: string) {
    return {
      goto: vi.fn(async () => undefined),
      url: () => "https://www.amazon.com/",
      title: async () => "Amazon.com. Spend less. Smile more.",
      evaluate: async <T>() => ({ delivery, language: "en-US", title: "Amazon.com", marker: true }) as T,
      locator: () => ({ click: async () => undefined, fill: async () => undefined, count: async () => 0 }),
      on: () => undefined,
      waitForSelector: async () => undefined,
    };
  }

  it("Detail：会话门禁失败必须给出 failureStage / failureKind / 耗时，且不进入 Capture Gateway", async () => {
    mocks.launchPersistentContext.mockResolvedValue({
      newPage: async () => sessionPage(""),
      close: async () => undefined,
    });

    const result = await collectAmazonDetailWithPlaywright({
      context: ownerContext,
      asin: "B0TEST0002",
      traceId: "trace-session-gate",
    });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("AMAZON_US_SESSION_CALIBRATION_FAILED");
    expect(result.capture).toBeNull();
    expect(result.sessionDiagnostics).toMatchObject({
      stage: "READ_DELIVERY_SIGNAL",
      failureStage: "READ_DELIVERY_SIGNAL",
      failureKind: "DELIVERY_SIGNAL_NOT_FOUND",
    });
    expect(Number.isFinite(result.sessionDiagnostics?.elapsedMs ?? NaN)).toBe(true);
    expect(mocks.captureThroughGateway).not.toHaveBeenCalled();
    expect(mocks.recordDiagnosticEvent).toHaveBeenCalledTimes(1);
    const auditCall = mocks.recordDiagnosticEvent.mock.calls[0]?.[0] as {
      event: { status: string; reason: string; errorCode: string | null };
    };
    expect(auditCall.event.status).toBe("blocked");
    expect(auditCall.event.reason).toContain("failureStage=READ_DELIVERY_SIGNAL");
    expect(auditCall.event.reason).toContain("failureKind=DELIVERY_SIGNAL_NOT_FOUND");
    expect(auditCall.event.reason).toContain("navigationElapsedMs=");
  });

  it("Search：会话门禁失败同样透传 sessionDiagnostics", async () => {
    mocks.launchPersistentContext.mockResolvedValue({
      newPage: async () => sessionPage(""),
      close: async () => undefined,
    });

    const result = await collectAmazonSearchWithPlaywright({
      context: ownerContext,
      query: "kitchen organizer",
      traceId: "trace-session-gate-search",
    });

    expect(result.status).toBe("failed");
    expect(result.captures).toEqual([]);
    expect(result.sessionDiagnostics).toMatchObject({
      failureStage: "READ_DELIVERY_SIGNAL",
      failureKind: "DELIVERY_SIGNAL_NOT_FOUND",
    });
    expect(mocks.captureThroughGateway).not.toHaveBeenCalled();
  });

  it("Capture 对预检与 Playwright 使用同一代理快照，即使进程环境随后改变", async () => {
    const originalProxy = process.env.AMAZON_CAPTURE_PROXY_URL;
    process.env.AMAZON_CAPTURE_PROXY_URL = "http://127.0.0.1:7890";
    let preflightProxy: string | undefined;
    let launchedProxy: string | undefined;
    mocks.checkAmazonCapturePreflight.mockImplementation(async (options: { env: Record<string, string | undefined> }) => {
      preflightProxy = options.env.AMAZON_CAPTURE_PROXY_URL;
      process.env.AMAZON_CAPTURE_PROXY_URL = "http://127.0.0.1:9999";
      return {
        ...nonUsPreflight,
        ok: true,
        status: "US_READY",
        exitCountry: "US",
        errorCode: null,
        failureKind: null,
        probeAttempts: 1,
        fallbackAttempted: false,
      };
    });
    mocks.launchPersistentContext.mockImplementation(async (_profileDir: string, options: { proxy?: { server: string } }) => {
      launchedProxy = options.proxy?.server;
      return { newPage: async () => sessionPage(""), close: async () => undefined };
    });

    try {
      const result = await collectAmazonDetailWithPlaywright({ context: ownerContext, asin: "B0TEST0002" });
      expect(result.errorCode).toBe("AMAZON_US_SESSION_CALIBRATION_FAILED");
      expect(preflightProxy).toBe("http://127.0.0.1:7890");
      expect(launchedProxy).toBe("http://127.0.0.1:7890");
      expect(mocks.captureThroughGateway).not.toHaveBeenCalled();
    } finally {
      if (originalProxy === undefined) delete process.env.AMAZON_CAPTURE_PROXY_URL;
      else process.env.AMAZON_CAPTURE_PROXY_URL = originalProxy;
    }
  });
});

describe("Amazon Search page checkpoints", () => {
  const previousLocalAcquisition = process.env.LOCAL_ACQUISITION_ENABLED;
  const previousScope = process.env.V5_ACQUISITION_SCOPE;

  beforeEach(() => {
    process.env.LOCAL_ACQUISITION_ENABLED = "true";
    process.env.V5_ACQUISITION_SCOPE = "batch_and_single";
    mocks.checkAmazonCapturePreflight.mockResolvedValue({
      ...nonUsPreflight,
      ok: true,
      status: "US_READY",
      exitCountry: "US",
      errorCode: null,
      failureKind: null,
    });
    mocks.captureThroughGateway.mockReset();
    mocks.recordDiagnosticEvent.mockReset();
    mocks.recordDiagnosticEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (previousLocalAcquisition === undefined) delete process.env.LOCAL_ACQUISITION_ENABLED;
    else process.env.LOCAL_ACQUISITION_ENABLED = previousLocalAcquisition;
    if (previousScope === undefined) delete process.env.V5_ACQUISITION_SCOPE;
    else process.env.V5_ACQUISITION_SCOPE = previousScope;
  });

  it("persists page 1 before navigating; a Canada page 2 returns page 1 evidence and never writes page 2", async () => {
    const firstAsin = "B0TEST0001";
    let pageNumber = 0;
    let evaluateIndex = 0;
    const page = {
      goto: vi.fn(async (url: string) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/s") pageNumber = Number(parsed.searchParams.get("page") ?? "1");
      }),
      url: () => pageNumber ? `https://www.amazon.com/s?k=isolated&page=${pageNumber}` : "https://www.amazon.com/",
      title: async () => "Amazon.com",
      on: vi.fn(),
      waitForSelector: vi.fn(async () => undefined),
      evaluate: vi.fn(async <T>() => {
        evaluateIndex += 1;
        if (evaluateIndex === 1) return { delivery: "Seattle, WA 98101, United States", language: "en-US", title: "Amazon.com", marker: true } as T;
        if (evaluateIndex === 2 || evaluateIndex === 4) return {
          pageUrl: pageNumber === 2 ? "https://www.amazon.com/s?k=isolated&page=2" : "https://www.amazon.com/s?k=isolated",
          amazonBrandMarkerPresent: true,
          deliveryRegion: pageNumber === 2 ? "Canada" : "Seattle, WA 98101, United States",
          language: "en-US",
        } as T;
        const asin = pageNumber === 2 ? "B0TEST0002" : firstAsin;
        return {
          schemaVersion: "amazon-search-page-extraction.v2",
          requested: { marketplace: "amazon.com", market: "US", currency: "USD" },
          observed: {},
          query: "isolated query",
          page: pageNumber,
          capturedAt: "2026-10-22T00:00:00.000Z",
          pageStatus: "ok",
          blocked: false,
          keyContainerFound: true,
          rawCardCount: 1,
          sampledObservationIds: [],
          diagnosticVisiblePriceNodeCount: 1,
          observations: [{
            appearanceKey: `page-${pageNumber}-${asin}`,
            page: pageNumber,
            position: 1,
            sponsored: false,
            sponsoredFlag: false,
            naturalRank: 1,
            sponsoredDiagnostic: { schemaVersion: "amazon-sponsored-placement-diagnostic.v1", state: false, markerSource: "known_card_structure", selectorCategory: "standard_search_result_card", reasonCode: "known_organic_structure", matchedText: null },
            asin,
            identityMissingReason: null,
            title: `Test product ${pageNumber}`,
            priceText: "$12.99",
            priceCurrency: "USD",
            ratingText: "4.5 out of 5 stars",
            reviewCountText: "100",
            brand: null,
            observedProductUrl: `https://www.amazon.com/dp/${asin}`,
            productUrl: `https://www.amazon.com/dp/${asin}`,
            imageUrl: null,
            capturedAt: "2026-10-22T00:00:00.000Z",
            fieldMissingReasons: {},
          }],
        } as T;
      }),
    };
    mocks.launchPersistentContext.mockResolvedValue({ newPage: async () => page, close: async () => undefined });
    mocks.captureThroughGateway.mockImplementation(async (input: { subjectKey: string }) => ({
      source: "amazon_dom",
      traceId: "trace-page-checkpoint",
      capture: { items: [{ subjectKey: input.subjectKey, captureId: "capture-1", evidenceId: "evidence-1", version: 1, contentHash: "a".repeat(64) }] },
      productFacts: [],
    }));

    const persistedCheckpoints: Array<{ page: number; state: string }> = [];
    const result = await collectAmazonSearchWithPlaywright({
      context: ownerContext,
      query: "isolated query",
      pages: 2,
      maxAppearances: 2,
      traceId: "trace-page-checkpoint",
      onPageCheckpoint: async (value) => { persistedCheckpoints.push({ page: value.page, state: value.state }); },
    });

    expect(result.status).toBe("captured");
    expect(result.partial).toBe(true);
    expect(result.errorCode).toBe("MARKETPLACE_MISMATCH");
    expect(result.navigationUsed).toBe(2);
    expect(result.plan).toMatchObject({ pageCount: 1, totalObservationCount: 1 });
    expect(result.captures).toHaveLength(1);
    expect(mocks.captureThroughGateway).toHaveBeenCalledTimes(1);
    expect(mocks.captureThroughGateway.mock.calls[0]?.[0]).toMatchObject({ subjectKey: `amazon:US:${firstAsin}` });
    expect(result.pageCheckpoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ page: 1, state: "evidence_persisted" }),
      expect.objectContaining({ page: 2, state: "blocked", errorCode: "MARKETPLACE_MISMATCH" }),
    ]));
    expect(persistedCheckpoints).toContainEqual({ page: 1, state: "evidence_persisted" });
    expect(persistedCheckpoints).toContainEqual({ page: 2, state: "blocked" });
    expect(persistedCheckpoints).toContainEqual({ page: 1, state: "navigating" });
    expect(persistedCheckpoints).toContainEqual({ page: 2, state: "navigating" });
  });
});
