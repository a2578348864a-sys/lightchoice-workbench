import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  sameOrigin: vi.fn(),
  launch: vi.fn(),
}));

vi.mock("@/lib/server/v5ApiRoute", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/v5ApiRoute")>("@/lib/server/v5ApiRoute");
  return { ...actual, readAuth: mocks.auth };
});
vi.mock("@/lib/server/accessPassword", () => ({ isTrustedWriteRequest: mocks.sameOrigin }));
vi.mock("@/lib/server/sellerSpriteBrowserLauncher", () => ({
  launchSellerSpriteBrowser: mocks.launch,
}));

import { POST } from "./route";

function postRequest(): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/source-layer/capture-environment/launch-sellersprite-browser", { method: "POST" });
}

describe("/api/source-layer/capture-environment/launch-sellersprite-browser（受控启动）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockReturnValue({ ok: true, context: { mode: "owner", token: "" } });
    mocks.sameOrigin.mockReturnValue(true);
    mocks.launch.mockResolvedValue({
      status: "started",
      endpoint: "http://127.0.0.1:9222",
      profileDir: "D:/app/.playwright-profile/sellersprite-v3",
      pid: 1234,
      readiness: { cdpReachable: true },
    });
  });

  it("身份校验失败 → 按 authResponse 拒绝", async () => {
    mocks.auth.mockReturnValueOnce({ ok: false, status: 403, code: "origin_denied", message: "请求来源校验失败。" });
    const response = await POST(postRequest());
    expect(response.status).toBe(403);
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("非 Owner 主体 → 403，不启动", async () => {
    mocks.auth.mockReturnValueOnce({ ok: true, context: { mode: "demo", token: "" } });
    const response = await POST(postRequest());
    const json = await response.json();
    expect(response.status).toBe(403);
    expect(json.error.code).toBe("owner_required");
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("来源校验失败 → 403，不启动", async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);
    const response = await POST(postRequest());
    const json = await response.json();
    expect(response.status).toBe(403);
    expect(json.error.code).toBe("origin_not_allowed");
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("已运行复用 → 200 返回 already_running 数据", async () => {
    mocks.launch.mockResolvedValueOnce({
      status: "already_running",
      endpoint: "http://127.0.0.1:9222",
      profileDir: "D:/app/.profile",
      readiness: { cdpReachable: true },
    });
    const response = await POST(postRequest());
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.status).toBe("already_running");
  });

  it("明确拒绝（端口占用等）→ 409 + 稳定错误码，供前端如实展示", async () => {
    mocks.launch.mockResolvedValueOnce({
      status: "rejected",
      code: "CDP_PORT_OCCUPIED",
      message: "端口 9222 已被其他程序占用。",
      profileDir: "D:/app/.profile",
    });
    const response = await POST(postRequest());
    const json = await response.json();
    expect(response.status).toBe(409);
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("CDP_PORT_OCCUPIED");
  });

  it("启动失败 → 500 + 错误码", async () => {
    mocks.launch.mockResolvedValueOnce({
      status: "failed",
      code: "CDP_NOT_READY_TIMEOUT",
      message: "调试端口未就绪。",
      profileDir: "D:/app/.profile",
    });
    const response = await POST(postRequest());
    const json = await response.json();
    expect(response.status).toBe(500);
    expect(json.error.code).toBe("CDP_NOT_READY_TIMEOUT");
  });
});
