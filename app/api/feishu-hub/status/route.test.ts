import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/v5FeishuService", () => ({
  getFeishuConnectionStatus: vi.fn(() => ({
    configured: true,
    status: "ready",
    preflight: "passed",
    marketTableReady: true,
    researchTableReady: true,
    displayName: "Test Base",
    lastCheckedAt: "2026-09-29T00:00:00.000Z",
    lastSuccessAt: "2026-09-29T00:00:00.000Z",
    lastError: null,
    baseOpenUrl: "https://example.invalid/base",
  })),
}));

describe("GET /api/feishu-hub/status", () => {
  it("returns T01-T06 status without a business write", async () => {
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://127.0.0.1:3011/api/feishu-hub/status", { headers: { host: "127.0.0.1:3011" } }));
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.status).toBe("ready");
    expect(json.data.configured).toBe(true);
    expect(json.data.displayName).toBe("Test Base");
    expect(json.data.preflight).toBe("passed");
    expect(json.data.hubStatus).toBe("online");
    expect(json.data.tables.map((table: { key: string }) => table.key)).toEqual(["T01", "T02", "T03", "T04", "T05", "T06"]);
  });
});
