import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuthenticated: vi.fn(),
  checkAmazonCapturePreflight: vi.fn(),
}));

vi.mock("@/lib/server/demoGuard", () => ({
  requireAuthenticated: mocks.requireAuthenticated,
}));

vi.mock("@/lib/server/amazonCapturePreflight", () => ({
  checkAmazonCapturePreflight: mocks.checkAmazonCapturePreflight,
}));

import { GET } from "./route";

describe("GET /api/source-layer/amazon-preflight 契约测试", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("未鉴权请求返回 401/403", async () => {
    mocks.requireAuthenticated.mockReturnValue({
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "请先输入访问密码",
    });

    const request = new NextRequest("http://127.0.0.1:3010/api/source-layer/amazon-preflight");
    const response = await GET(request);
    expect(response.status).toBe(401);
    const body = await response.json() as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("unauthorized");
  });

  it("已鉴权且出口为美国时，返回 200 与 US_READY 状态", async () => {
    mocks.requireAuthenticated.mockReturnValue({
      ok: true,
      context: { mode: "owner", userId: "owner-1" },
    });
    mocks.checkAmazonCapturePreflight.mockResolvedValue({
      ok: true,
      status: "US_READY",
      exitCountry: "US",
      exitCountryName: "United States",
      proxyConfigured: true,
      proxyProtocol: "http",
      errorCode: null,
      message: "采集出口为美国 (US)，符合 Amazon US 采集要求。",
      checkedAt: "2026-09-22T17:00:00.000Z",
    });

    const request = new NextRequest("http://127.0.0.1:3010/api/source-layer/amazon-preflight");
    const response = await GET(request);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; data: { status: string; exitCountry: string } };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("US_READY");
    expect(body.data.exitCountry).toBe("US");
  });

  it("已鉴权且出口为非美（如日本）时，返回 200 与 NON_US_EXIT 状态及阻断原因", async () => {
    mocks.requireAuthenticated.mockReturnValue({
      ok: true,
      context: { mode: "owner", userId: "owner-1" },
    });
    mocks.checkAmazonCapturePreflight.mockResolvedValue({
      ok: false,
      status: "NON_US_EXIT",
      exitCountry: "JP",
      exitCountryName: "Japan",
      proxyConfigured: true,
      proxyProtocol: "http",
      errorCode: "AMAZON_CAPTURE_NON_US_EXIT",
      message: "当前采集出口不是美国（检测到 Japan / JP）。",
      checkedAt: "2026-09-22T17:00:00.000Z",
    });

    const request = new NextRequest("http://127.0.0.1:3010/api/source-layer/amazon-preflight");
    const response = await GET(request);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; data: { status: string; exitCountry: string; errorCode: string } };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("NON_US_EXIT");
    expect(body.data.exitCountry).toBe("JP");
    expect(body.data.errorCode).toBe("AMAZON_CAPTURE_NON_US_EXIT");
  });
});
