import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), summary: vi.fn() }));
vi.mock("@/lib/server/demoGuard", () => ({ requireAuthenticated: mocks.auth }));
vi.mock("@/lib/server/latestAmazonCaptureSummary", () => ({ getLatestAmazonCaptureSummary: mocks.summary }));
import { GET } from "./route";
describe("read-only latest Amazon result API", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockReturnValue({ ok: true, context: { mode: "owner", token: "" } }); });
  it("returns a stable no-store JSON result without starting collection", async () => {
    mocks.summary.mockResolvedValue({ asin: "B000000001", version: 13 });
    const response = await GET(new NextRequest("http://127.0.0.1:3112/api/source-layer/latest-amazon-capture"));
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ ok: true, data: { asin: "B000000001", version: 13 } });
  });
  it("protects the caller boundary and hides diagnostic details", async () => {
    mocks.auth.mockReturnValue({ ok: false, status: 403, code: "FORBIDDEN", message: "禁止" });
    expect((await GET(new NextRequest("http://127.0.0.1:3112/api/source-layer/latest-amazon-capture"))).status).toBe(403);
    expect(mocks.summary).not.toHaveBeenCalled();
    mocks.auth.mockReturnValue({ ok: true, context: { mode: "owner", token: "" } }); mocks.summary.mockRejectedValue(new Error("private-token"));
    const response = await GET(new NextRequest("http://127.0.0.1:3112/api/source-layer/latest-amazon-capture"));
    expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("private-token");
  });
});
