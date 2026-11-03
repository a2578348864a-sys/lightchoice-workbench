import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTenantAccessToken, clearCachedLarkToken, LarkAuthError } from "./auth";
import type { LarkConfig } from "./types";

describe("Lark Auth", () => {
  const dummyConfig: LarkConfig = {
    appId: "cli_dummy_123",
    appSecret: "sec_dummy_abc",
    appToken: "app_dummy_token",
    tableId: "tbl_dummy_table",
    openApiDomain: "https://open.feishu.cn",
  };

  beforeEach(() => {
    clearCachedLarkToken();
  });

  it("成功获取 tenant_access_token 并缓存", async () => {
    let callCount = 0;
    const mockFetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      expect(url).toBe("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal");
      const body = JSON.parse(init?.body as string);
      expect(body.app_id).toBe("cli_dummy_123");
      expect(body.app_secret).toBe("sec_dummy_abc");

      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          tenant_access_token: "t-mock-token-abc",
          expire: 7200,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const token1 = await getTenantAccessToken(dummyConfig, { fetcher: mockFetcher, nowMs: 1000 });
    expect(token1).toBe("t-mock-token-abc");
    expect(callCount).toBe(1);

    // 第二次调用应命中缓存，不发起网络请求
    const token2 = await getTenantAccessToken(dummyConfig, { fetcher: mockFetcher, nowMs: 2000 });
    expect(token2).toBe("t-mock-token-abc");
    expect(callCount).toBe(1);
  });

  it("当 Token 接近过期（< 5 分钟）时自动刷新", async () => {
    let callCount = 0;
    const mockFetcher = vi.fn(async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          tenant_access_token: `t-token-${callCount}`,
          expire: 600, // 10 分钟
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const baseTime = 1_000_000;
    const token1 = await getTenantAccessToken(dummyConfig, { fetcher: mockFetcher, nowMs: baseTime });
    expect(token1).toBe("t-token-1");
    expect(callCount).toBe(1);

    // 6 分钟后（剩余 4 分钟 < 5 分钟缓冲），应触发自动刷新
    const token2 = await getTenantAccessToken(dummyConfig, {
      fetcher: mockFetcher,
      nowMs: baseTime + 6 * 60 * 1000,
    });
    expect(token2).toBe("t-token-2");
    expect(callCount).toBe(2);
  });

  it("当飞书返回错误码时抛出 LarkAuthError", async () => {
    const mockFetcher = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          code: 99991663,
          msg: "app secret is invalid",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    });

    await expect(getTenantAccessToken(dummyConfig, { fetcher: mockFetcher })).rejects.toThrow(LarkAuthError);
  });
});
