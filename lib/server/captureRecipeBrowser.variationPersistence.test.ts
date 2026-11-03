import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launchPersistentContext: vi.fn(),
  checkAmazonCapturePreflight: vi.fn(),
  ensureAmazonUsSessionEnvironment: vi.fn(),
  captureV3ModuleEvidence: vi.fn(),
  testProfileDir: "",
  testLockRoot: "",
}));

vi.mock("@/lib/server/playwrightRuntime", () => ({
  loadPlaywright: async () => ({ chromium: { launchPersistentContext: mocks.launchPersistentContext } }),
}));
vi.mock("@/lib/server/amazonCapturePreflight", () => ({
  checkAmazonCapturePreflight: mocks.checkAmazonCapturePreflight,
}));
vi.mock("@/lib/server/amazonCaptureBrowserConfig", () => ({
  buildAmazonCaptureContextOptions: () => ({}),
  resolveAmazonCaptureNetworkConfig: () => ({ env: {}, proxy: null, invalidReason: null }),
}));
vi.mock("@/lib/server/playwrightProfileLease.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/playwrightProfileLease.mjs")>();
  return {
    ...actual,
    launchPersistentContextWithProfileLock: (_profileDir: string, launch: () => Promise<{ close(): Promise<void> }>) =>
      actual.launchPersistentContextWithProfileLock(mocks.testProfileDir, launch, { lockRoot: mocks.testLockRoot }),
  };
});
vi.mock("@/lib/server/amazonUsSessionEnvironment", () => ({
  ensureAmazonUsSessionEnvironment: mocks.ensureAmazonUsSessionEnvironment,
}));
vi.mock("@/tools/collectors/amazon/browser-control", () => ({
  resolveSystemBrowser: () => ({ browser: "chrome", executablePath: "C:/chrome.exe" }),
}));
vi.mock("@/lib/sourceLayer/v3ModuleEvidence", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sourceLayer/v3ModuleEvidence")>(),
  captureV3ModuleEvidence: mocks.captureV3ModuleEvidence,
}));

import type { AccessContext } from "@/lib/server/accessPassword";
import { captureThroughGateway } from "@/lib/sourceLayer/server/captureGateway";
import type { RawVariationPage } from "@/tools/collectors/amazon/variation-page-extract";
import { collectAmazonVariationsWithPlaywright } from "./captureRecipeBrowser";

const ASIN = "B0CLY1KWLB";
const CHILD_ASIN = "B0BB3KD2JD";
const OWNER_CONTEXT = { mode: "owner", token: "" } as AccessContext;
const RAW_VARIATION_SIGNALS = {
  parentAsin: "B0DMQ2YQLJ",
  dimensionToAsinMap: { "0_18": ASIN, "0_17": CHILD_ASIN },
  dimensionValuesDisplayData: {
    [ASIN]: ["18 Ounces", "Neon Crush"],
    [CHILD_ASIN]: ["18 Ounces", "Navy"],
  },
  variationDisplayLabels: { size_name: "Size", color_name: "Color" },
  domGroups: [],
  variationRootFound: false,
  explicitNoVariation: false,
  jsonStateFound: true,
  jsonStateDiagnostics: { scriptsScanned: 1, scriptsMatched: 1, parsedFields: [
    "dimensionToAsinMap", "dimensionValuesDisplayData", "variationDisplayLabels",
  ] },
};

describe("Amazon variation evidence source signals", () => {
  let storeRoot = "";

  beforeEach(() => {
    storeRoot = mkdtempSync(join(tmpdir(), "v5-variation-source-signals-"));
    mocks.testProfileDir = join(storeRoot, "profile");
    mocks.testLockRoot = join(storeRoot, "locks");
    mkdirSync(mocks.testProfileDir, { recursive: true });
    vi.stubEnv("LOCAL_ACQUISITION_ENABLED", "true");
    vi.stubEnv("SOURCE_LAYER_STORE_DIR", join(storeRoot, "store"));
    mocks.launchPersistentContext.mockReset();
    mocks.checkAmazonCapturePreflight.mockReset().mockResolvedValue({ ok: true, status: "US_READY" });
    mocks.ensureAmazonUsSessionEnvironment.mockReset().mockResolvedValue({ ok: true });
    mocks.captureV3ModuleEvidence.mockReset().mockResolvedValue({ attachment: {
      attachmentId: "att-variation-test",
      contentHash: "d".repeat(64),
    } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (storeRoot) rmSync(storeRoot, { recursive: true, force: true });
  });

  async function collectWithRawSignals(rawSignals: RawVariationPage) {
    const page = {
      goto: vi.fn(async () => undefined),
      waitForSelector: vi.fn(async () => undefined),
      url: () => `https://www.amazon.com/dp/${ASIN}?th=1`,
      on: vi.fn(),
      evaluate: async <T>(expression: string) => (
        expression.includes("dimensionToAsinMap")
          ? rawSignals
          : { pageStatus: "ok", urlAsin: ASIN, pageAsin: ASIN, bindingProof: { productContainerFound: true } }
      ) as T,
    };
    const context = { newPage: async () => page, close: vi.fn(async () => undefined) };
    mocks.launchPersistentContext.mockResolvedValue(context);

    const result = await collectAmazonVariationsWithPlaywright({
      context: { mode: "owner", token: "" } as AccessContext,
      asins: [{ asin: ASIN }],
      now: new Date("2026-10-09T01:00:00.000Z"),
    });

    return result;
  }

  it("persists the bounded DOM-derived ASIN/value/label maps alongside normalized variations", async () => {
    const result = await collectWithRawSignals(RAW_VARIATION_SIGNALS);

    expect(result.status).toBe("captured");
    expect(result.results[0]?.capture.status).toBe("CAPTURED_PARTIAL");
    expect(mocks.captureV3ModuleEvidence).toHaveBeenCalledWith(expect.objectContaining({
      moduleEvidence: expect.objectContaining({
        data: expect.objectContaining({
          rawVariationSignals: RAW_VARIATION_SIGNALS,
        }),
      }),
    }));

    const capturePlan = mocks.captureV3ModuleEvidence.mock.calls[0]?.[0];
    const actualEvidence = await vi.importActual<typeof import("@/lib/sourceLayer/v3ModuleEvidence")>("@/lib/sourceLayer/v3ModuleEvidence");
    await captureThroughGateway({
      context: OWNER_CONTEXT,
      source: "amazon_dom",
      payload: {
        asin: ASIN,
        title: "Variation evidence test fixture",
        productUrl: `https://www.amazon.com/dp/${ASIN}`,
        images: ["https://m.media-amazon.com/images/I/variation-fixture.jpg"],
        price: 24.99,
        currency: "USD",
        rating: 4.5,
        reviewCount: 120,
      },
      now: new Date("2026-10-09T01:00:00.000Z"),
      subjectKey: `amazon:US:${ASIN}`,
      sourceUrl: `https://www.amazon.com/dp/${ASIN}`,
      marketplace: "US",
    });
    await actualEvidence.captureV3ModuleEvidence(capturePlan!);
    const readback = await actualEvidence.readV3ModuleEvidence({
      context: OWNER_CONTEXT,
      subjectKey: `amazon:US:${ASIN}`,
      module: "variation",
    });
    expect(readback.modules[0]?.data.rawVariationSignals).toEqual(RAW_VARIATION_SIGNALS);
    expect(readback.modules[0]?.data.rawVariationSignalsStatus).toBe("retained");
  });

  it("omits an oversized raw map while preserving the normalized capture and an explicit omission status", async () => {
    const largeSignals = {
      ...RAW_VARIATION_SIGNALS,
      dimensionToAsinMap: {},
      dimensionValuesDisplayData: Object.fromEntries(Array.from({ length: 80 }, (_, index) => [
        `raw-row-${index}`,
        Array.from({ length: 20 }, () => "x".repeat(120)),
      ])),
    };
    const result = await collectWithRawSignals(largeSignals);

    expect(result.results[0]?.capture.status).toBe("CAPTURED_PARTIAL");
    expect(mocks.captureV3ModuleEvidence).toHaveBeenCalledWith(expect.objectContaining({
      moduleEvidence: expect.objectContaining({
        data: expect.objectContaining({ rawVariationSignalsStatus: "omitted_size_limit" }),
      }),
    }));
    const moduleEvidence = mocks.captureV3ModuleEvidence.mock.calls[0]?.[0].moduleEvidence;
    expect(moduleEvidence.data).not.toHaveProperty("rawVariationSignals");
  });

  it("returns bounded source signals for the service fallback when the first Evidence write fails", async () => {
    mocks.captureV3ModuleEvidence.mockRejectedValueOnce(new Error("isolated gateway write failure"));

    const result = await collectWithRawSignals(RAW_VARIATION_SIGNALS);

    expect(result.results[0]?.evidenceId).toBeNull();
    expect(result.results[0]?.errorCode).toBe("VARIATION_EVIDENCE_PERSIST_FAILED");
    expect(result.results[0]?.rawVariationSignals).toEqual(RAW_VARIATION_SIGNALS);
  });
});
