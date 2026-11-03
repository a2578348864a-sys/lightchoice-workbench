import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuthenticated: vi.fn(),
  checkAmazonSessionReadiness: vi.fn(),
}));

vi.mock("@/lib/server/demoGuard", () => ({
  requireAuthenticated: mocks.requireAuthenticated,
}));

vi.mock("@/lib/server/amazonSessionReadiness", () => ({
  checkAmazonSessionReadiness: mocks.checkAmazonSessionReadiness,
}));

import { GET } from "./route";

const readinessPayload = {
  ok: true,
  status: "SESSION_READY",
  sessionReady: true,
  networkPreflight: "US_READY",
  exitCountry: "US",
  exitCountryName: "United States",
  browserLaunched: true,
  hostname: "www.amazon.com",
  pageStatus: "ok",
  delivery: "US",
  language: "en-us",
  calibrationAttempted: false,
  failureStage: null,
  failureKind: null,
  elapsedMs: 4321,
  navigationElapsedMs: 4100,
  calibrationElapsedMs: 0,
  errorCode: null,
  errorName: null,
  errorDetail: null,
  message: "Amazon 会话已就绪。",
  traceId: "trace-readiness",
  checkedAt: "2026-09-23T16:00:00.000Z",
};

describe("GET /api/source-layer/amazon-session-readiness 契约测试", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("未鉴权请求返回 401", async () => {
    mocks.requireAuthenticated.mockReturnValue({
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "请先输入访问密码",
    });

    const request = new NextRequest("http://127.0.0.1:3012/api/source-layer/amazon-session-readiness");
    const response = await GET(request);
    expect(response.status).toBe(401);
    const body = await response.json() as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("unauthorized");
    expect(mocks.checkAmazonSessionReadiness).not.toHaveBeenCalled();
  });

  it("已鉴权时返回会话就绪结果，并把访问上下文交给就绪检查", async () => {
    const context = { mode: "owner", userId: "owner-1" };
    mocks.requireAuthenticated.mockReturnValue({ ok: true, context });
    mocks.checkAmazonSessionReadiness.mockResolvedValue(readinessPayload);

    const request = new NextRequest("http://127.0.0.1:3012/api/source-layer/amazon-session-readiness");
    const response = await GET(request);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; data: { status: string; sessionReady: boolean } };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("SESSION_READY");
    expect(body.data.sessionReady).toBe(true);
    expect(mocks.checkAmazonSessionReadiness).toHaveBeenCalledWith({ context });
  });

  it("就绪检查抛错时返回 500，且不暴露内部异常", async () => {
    mocks.requireAuthenticated.mockReturnValue({ ok: true, context: { mode: "owner", userId: "owner-1" } });
    mocks.checkAmazonSessionReadiness.mockRejectedValue(new Error("boom: cookie=super-secret"));

    const request = new NextRequest("http://127.0.0.1:3012/api/source-layer/amazon-session-readiness");
    const response = await GET(request);
    expect(response.status).toBe(500);
    const body = await response.json() as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("AMAZON_SESSION_READINESS_FAILED");
    expect(JSON.stringify(body)).not.toContain("super-secret");
  });
});
