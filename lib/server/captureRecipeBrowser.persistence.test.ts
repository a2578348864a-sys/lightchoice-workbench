import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ moduleWrite: vi.fn() }));
vi.mock("@/lib/sourceLayer/v3ModuleEvidence", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sourceLayer/v3ModuleEvidence")>(),
  captureV3ModuleEvidence: mocks.moduleWrite,
}));
vi.mock("@/lib/server/db", () => ({ prisma: {} }));
import { captureThroughGateway } from "@/lib/sourceLayer/server/captureGateway";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { captureDriverFailureCode, captureModuleEvidenceAfterGateway } from "./captureRecipeBrowser";

const context = { mode: "owner", token: "" } as const;
let root: string;
describe("capture post-write outcome", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "v5-p3-module-"));
    vi.stubEnv("SOURCE_LAYER_STORE_DIR", root);
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external_network_forbidden"); }));
    mocks.moduleWrite.mockReset();
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });
  it("preserves real Gateway evidence and returns a diagnostic failure when a later module write fails", async () => {
    const now = new Date("2026-10-01T00:00:00Z");
    const capture = await captureThroughGateway({ context, now, source: "manual", payload: {
      asin: "B000000001", title: "P3 retained evidence", productUrl: "https://www.amazon.com/dp/B000000001",
      images: ["https://m.media-amazon.com/images/I/fixture.jpg"], price: 25, currency: "USD", rating: 4.5, reviewCount: 200,
    } });
    mocks.moduleWrite.mockRejectedValue(new Error("injected_module_write_failure"));
    const failure = await captureModuleEvidenceAfterGateway(capture, { context, sourceType: "amazon_dom", moduleEvidence: {
      module: "amazon_detail", subjectKey: "amazon:US:B000000001", marketplace: "US", capturedAt: now.toISOString(),
      provider: "Amazon", sourceSurface: "fixture", sourceUrl: "https://www.amazon.com/dp/B000000001", acquisitionMode: "DOM_DIRECT",
      metricNature: "source_observed", status: "VALIDATED_AVAILABLE", identity: { asin: "B000000001" }, data: {}, evidenceOnly: true,
    } });
    expect(failure).toEqual({ code: "MODULE_EVIDENCE_WRITE_FAILED", subjectKey: "amazon:US:B000000001" });
    const store = createEvidenceStore("owner:v1");
    expect((await store.getSubject("amazon:US:B000000001"))!.versions).toHaveLength(1);
    expect(capture.productFacts[0].basic.title.value).toBe("P3 retained evidence");
    expect((await store.getAudit("amazon:US:B000000001")).find((entry) => entry.eventType === "module_evidence_write_failed"))
      .toMatchObject({ errorCode: "PERSISTENCE_FAILED", phase: "persist" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("attributes driver exceptions to timeout only when they are timeout errors", () => {
    expect(captureDriverFailureCode(new TypeError("Unexpected null selector"))).toBe("INTERNAL_UNEXPECTED");
    expect(captureDriverFailureCode(Object.assign(new Error("Navigation timed out"), { name: "TimeoutError" }))).toBe("TIMEOUT");
    expect(captureDriverFailureCode(Object.assign(new Error("Aborted"), { name: "AbortError" }))).toBe("TIMEOUT");
  });
});
