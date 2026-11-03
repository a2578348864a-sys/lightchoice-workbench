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
vi.mock("@/lib/server/amazonBrowserLauncher", () => ({
  launchAmazonBrowser: mocks.launch,
}));

import { POST } from "./route";

function postRequest(body?: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/source-layer/capture-environment/launch-amazon-browser", {
    method: "POST",
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
}

describe("/api/source-layer/capture-environment/launch-amazon-browser（受控启动）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockReturnValue({ ok: true, context: { mode: "owner", token: "" } });
    mocks.sameOrigin.mockReturnValue(true);
    mocks.launch.mockResolvedValue({ status: "started", pid: 1234 });
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

  it("请求体参数不能控制本地进程：服务只按服务端配置调用", async () => {
    const response = await POST(postRequest({
      profileDir: "C:\\Users\\someone\\evil-profile",
      chromePath: "C:\\Windows\\System32\\cmd.exe",
      proxy: "http://evil.example:8080",
      args: ["--remote-debugging-port=9222"],
    }));
    expect(response.status).toBe(200);
    expect(mocks.launch).toHaveBeenCalledTimes(1);
    expect(mocks.launch).toHaveBeenCalledWith();
  });

  it("启动成功 → 200 started，不返回 Profile 路径或凭据", async () => {
    const response = await POST(postRequest());
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data).toEqual({ status: "started", pid: 1234 });
    expect(JSON.stringify(json)).not.toContain("profileDir");
  });

  it("已有窗口 → 200 already_running", async () => {
    mocks.launch.mockResolvedValueOnce({ status: "already_running", pid: 1234 });
    const response = await POST(postRequest());
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.status).toBe("already_running");
  });

  it.each([
    ["PROFILE_IN_USE", "Amazon 专用浏览器仍在运行。"],
    ["CHROME_NOT_FOUND", "未找到可用的 Chrome/Edge。"],
    ["PROFILE_DIR_INVALID", "Amazon 采集 Profile 路径无效。"],
    ["PROXY_INVALID", "Amazon 采集代理配置无效。"],
  ])("明确拒绝 %s → 409 + 稳定错误码", async (code, message) => {
    mocks.launch.mockResolvedValueOnce({ status: "rejected", code, message });
    const response = await POST(postRequest());
    const json = await response.json();
    expect(response.status).toBe(409);
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe(code);
  });

  it("启动失败 → 500 + 错误码", async () => {
    mocks.launch.mockResolvedValueOnce({ status: "failed", code: "LAUNCH_FAILED", message: "Chrome 进程提前退出。" });
    const response = await POST(postRequest());
    const json = await response.json();
    expect(response.status).toBe(500);
    expect(json.error.code).toBe("LAUNCH_FAILED");
  });
});
