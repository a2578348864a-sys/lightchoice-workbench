import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuthenticated: vi.fn(),
  checkSellerSpriteCdpReadiness: vi.fn(),
  probeBrowserIdentityViaHttp: vi.fn(),
  resolveSellerSpriteCdpEndpoint: vi.fn(),
  resolveSellerSpriteProfileDirectory: vi.fn(),
}));

vi.mock("@/lib/server/demoGuard", () => ({ requireAuthenticated: mocks.requireAuthenticated }));
vi.mock("@/lib/server/captureEnvironmentReadiness", () => ({ checkSellerSpriteCdpReadiness: mocks.checkSellerSpriteCdpReadiness }));
vi.mock("@/lib/server/sellerSpriteBrowserIdentity", () => ({ probeBrowserIdentityViaHttp: mocks.probeBrowserIdentityViaHttp }));
vi.mock("@/lib/server/sellerSpriteProfileConfig", () => ({
  resolveSellerSpriteCdpEndpoint: mocks.resolveSellerSpriteCdpEndpoint,
  resolveSellerSpriteProfileDirectory: mocks.resolveSellerSpriteProfileDirectory,
}));

import { GET } from "./route";

const readiness = {
  status: "unavailable",
  cdpReachable: false,
  errorCode: "CDP_UNREACHABLE",
  checkedAt: "2026-10-12T04:00:00.000Z",
  latencyMs: 12,
  message: "未能连接本机 SellerSprite CDP 接口。",
  nextAction: "启动使用本机调试端口的 Chrome，然后重新检测。",
};

const reachable = { ...readiness, status: "ready", cdpReachable: true, errorCode: null };

describe("GET /api/source-layer/capture-environment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSellerSpriteCdpEndpoint.mockReturnValue({ origin: "http://127.0.0.1:9222", host: "127.0.0.1", port: 9222 });
    mocks.resolveSellerSpriteProfileDirectory.mockReturnValue("D:/workspace/.playwright-profile/sellersprite-v3");
    mocks.probeBrowserIdentityViaHttp.mockResolvedValue("managed");
  });

  it("returns a stable no-store JSON result when CDP is unavailable", async () => {
    mocks.requireAuthenticated.mockReturnValue({ ok: true, context: { mode: "owner", userId: "owner-1" } });
    mocks.checkSellerSpriteCdpReadiness.mockResolvedValue(readiness);

    const response = await GET(new NextRequest("http://127.0.0.1:3010/api/source-layer/capture-environment"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toMatchObject({ ok: true, data: { ...readiness, amazon: { sessionStatus: "not_checked", browserMode: "persistent_profile" } } });
    // CDP 不可达时不进行身份探测（无从判定 ≠ 不可信）。
    expect(body.data.browserIdentity).toBeNull();
    expect(mocks.probeBrowserIdentityViaHttp).not.toHaveBeenCalled();
    expect(mocks.checkSellerSpriteCdpReadiness).toHaveBeenCalledTimes(1);
  });

  it("CDP 可达时如实透出实例身份（D2-1F：CDP 可达 ≠ 专用实例）", async () => {
    mocks.requireAuthenticated.mockReturnValue({ ok: true, context: { mode: "owner", userId: "owner-1" } });
    mocks.checkSellerSpriteCdpReadiness.mockResolvedValue(reachable);
    mocks.probeBrowserIdentityViaHttp.mockResolvedValue("foreign");

    const response = await GET(new NextRequest("http://127.0.0.1:3010/api/source-layer/capture-environment"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.browserIdentity).toBe("foreign");
    expect(mocks.probeBrowserIdentityViaHttp).toHaveBeenCalledWith(
      "http://127.0.0.1:9222",
      "D:/workspace/.playwright-profile/sellersprite-v3",
    );
  });

  it("身份探测异常时收敛为 unknown（不猜测、不报 5xx）", async () => {
    mocks.requireAuthenticated.mockReturnValue({ ok: true, context: { mode: "owner", userId: "owner-1" } });
    mocks.checkSellerSpriteCdpReadiness.mockResolvedValue(reachable);
    mocks.resolveSellerSpriteProfileDirectory.mockImplementation(() => { throw new Error("SELLERSPRITE_PROFILE_DIR_INVALID"); });

    const response = await GET(new NextRequest("http://127.0.0.1:3010/api/source-layer/capture-environment"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.browserIdentity).toBe("unknown");
  });

  it("does not perform the CDP request when the caller is rejected", async () => {
    mocks.requireAuthenticated.mockReturnValue({ ok: false, status: 403, code: "origin_denied", message: "请求来源校验失败。" });

    const response = await GET(new NextRequest("http://127.0.0.1:3010/api/source-layer/capture-environment"));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("origin_denied");
    expect(mocks.checkSellerSpriteCdpReadiness).not.toHaveBeenCalled();
  });

  it("returns a generic JSON failure without leaking thrown details", async () => {
    mocks.requireAuthenticated.mockReturnValue({ ok: true, context: { mode: "owner", userId: "owner-1" } });
    mocks.checkSellerSpriteCdpReadiness.mockRejectedValue(new Error("private debugger endpoint"));

    const response = await GET(new NextRequest("http://127.0.0.1:3010/api/source-layer/capture-environment"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("CAPTURE_ENVIRONMENT_CHECK_FAILED");
    expect(JSON.stringify(body)).not.toContain("private debugger endpoint");
  });
});
