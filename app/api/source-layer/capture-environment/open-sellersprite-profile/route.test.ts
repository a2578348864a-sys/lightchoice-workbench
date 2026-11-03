import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  sameOrigin: vi.fn(),
  openProfile: vi.fn(),
}));

vi.mock("@/lib/server/v5ApiRoute", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/v5ApiRoute")>("@/lib/server/v5ApiRoute");
  return { ...actual, readAuth: mocks.auth };
});
vi.mock("@/lib/server/accessPassword", () => ({ isTrustedWriteRequest: mocks.sameOrigin }));
vi.mock("@/lib/server/sellerSpriteBrowserLauncher", () => ({
  openSellerSpriteProfileDirectory: mocks.openProfile,
}));

import { POST } from "./route";

function postRequest(): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/source-layer/capture-environment/open-sellersprite-profile", { method: "POST" });
}

describe("/api/source-layer/capture-environment/open-sellersprite-profile（打开专用 Profile 目录）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockReturnValue({ ok: true, context: { mode: "owner", token: "" } });
    mocks.sameOrigin.mockReturnValue(true);
    mocks.openProfile.mockResolvedValue({ status: "opened", profileDir: "D:/app/.playwright-profile/sellersprite-v3" });
  });

  it("非 Owner → 403，不打开目录", async () => {
    mocks.auth.mockReturnValueOnce({ ok: true, context: { mode: "demo", token: "" } });
    const response = await POST(postRequest());
    expect(response.status).toBe(403);
    expect(mocks.openProfile).not.toHaveBeenCalled();
  });

  it("来源校验失败 → 403", async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);
    const response = await POST(postRequest());
    expect(response.status).toBe(403);
    expect(mocks.openProfile).not.toHaveBeenCalled();
  });

  it("成功 → 200 返回服务端解析出的目录", async () => {
    const response = await POST(postRequest());
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.profileDir).toContain("sellersprite-v3");
  });

  it("配置无效等拒绝 → 409 + 错误码", async () => {
    mocks.openProfile.mockResolvedValueOnce({ status: "rejected", code: "PROFILE_DIR_INVALID", message: "配置无效。" });
    const response = await POST(postRequest());
    const json = await response.json();
    expect(response.status).toBe(409);
    expect(json.error.code).toBe("PROFILE_DIR_INVALID");
  });
});
