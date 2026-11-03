import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  defaultLarkFetch,
  getWorkaroundAgent,
  getWorkaroundDnsServers,
  resetWorkaroundAgentForTest,
} from "./transport";

describe("Feishu Transport Hardening", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetWorkaroundAgentForTest();
    delete process.env.LARK_DIRECT_NETWORK_WORKAROUND;
    delete process.env.LARK_WORKAROUND_DNS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetWorkaroundAgentForTest();
    vi.restoreAllMocks();
  });

  it("defaults to standard public DNS without hardcoded local router IP", () => {
    const servers = getWorkaroundDnsServers();
    expect(servers).toEqual(["223.5.5.5", "119.29.29.29"]);
    expect(servers).not.toContain("192.168.1.1");
  });

  it("supports configurable workaround DNS servers", () => {
    process.env.LARK_WORKAROUND_DNS = "8.8.8.8, 1.1.1.1, 114.114.114.114";
    const servers = getWorkaroundDnsServers();
    expect(servers).toEqual(["8.8.8.8", "1.1.1.1", "114.114.114.114"]);
  });

  it("delegates to standard global fetch when workaround is OFF (default)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    const res = await defaultLarkFetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      body: JSON.stringify({ app_id: "test", app_secret: "sec" }),
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("initializes workaround agent when workaround is ON", () => {
    process.env.LARK_DIRECT_NETWORK_WORKAROUND = "1";
    process.env.LARK_WORKAROUND_DNS = "223.5.5.5";
    const agent = getWorkaroundAgent();
    expect(agent).toBeDefined();
    // Reuses cached agent
    expect(getWorkaroundAgent()).toBe(agent);
  });
});
