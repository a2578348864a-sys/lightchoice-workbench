import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), collect: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/server/demoGuard", () => ({ requireAuthenticated: mocks.auth }));
vi.mock("@/lib/server/captureRecipeBrowser", () => ({ collectAmazonDetailWithPlaywright: mocks.collect }));
vi.mock("@/lib/sourceLayer/server/diagnosticService", () => ({ recordCaptureApiDiagnostic: mocks.audit }));
import { POST } from "./route";
function request(asin: string) {
  return new NextRequest("http://127.0.0.1:3010/api/source-layer/collect/amazon-detail", { method: "POST",
    headers: { origin: "http://127.0.0.1:3010", host: "127.0.0.1:3010", "content-type": "application/json" }, body: JSON.stringify({ asin }) });
}
describe("ASIN detail public response contract", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockReturnValue({ ok: true, context: { mode: "owner", token: "" } }); mocks.audit.mockResolvedValue(undefined); });
  it("rejects malformed ASIN without touching browser or Gateway", async () => {
    const response = await POST(request("invalid"));
    expect(response.status).toBe(400); expect((await response.json()).error.code).toBe("asin_invalid");
    expect(mocks.collect).not.toHaveBeenCalled();
  });
  it.each(["LOCAL_ENVIRONMENT_REQUIRED", "LOGIN_REQUIRED", "CAPTCHA_DETECTED", "ASIN_IDENTITY_MISMATCH"])("does not accept %s as captured", async errorCode => {
    mocks.collect.mockResolvedValue({ status: "unavailable", errorCode, errorMessage: "fixture-gate", capture: null, trace: null });
    const response = await POST(request("B000000001")); const body = await response.json();
    expect(response.status).toBe(409); expect(body.ok).toBe(false); expect(body.error.code).toBe(errorCode);
  });
  it("requires captured status and returns actual evidence references and ProductFact count", async () => {
    mocks.collect.mockResolvedValue({ status: "captured", errorCode: null, capture: { traceId: "fixture-trace", source: "amazon_dom",
      capture: { items: [{ subjectKey: "amazon:US:B000000001", captureId: "fixture-id", version: 1, contentHash: "a".repeat(64) }], readyCount: 1 }, productFacts: [{}], qualityGate: {} } });
    const response = await POST(request("B000000001")); const body = await response.json();
    expect(response.status).toBe(201); expect(body.data.status).toBe("captured"); expect(body.data.productFactCount).toBe(1);
    expect(body.data.capture.items[0].subjectKey).toBe("amazon:US:B000000001");
  });
  it("keeps a persisted partial capture distinct from full success even with HTTP 200", async () => {
    mocks.collect.mockResolvedValue({ status: "failed", partial: true, errorCode: "MODULE_EVIDENCE_WRITE_FAILED",
      capture: { traceId: "fixture-trace", source: "amazon_dom", capture: { items: [], readyCount: 0 }, productFacts: [], qualityGate: {} } });
    const response = await POST(request("B000000001")); const body = await response.json();
    expect(response.status).toBe(200); expect(body.data.status).toBe("failed"); expect(body.data.partial).toBe(true);
  });
});
