import { afterEach, describe, expect, it, vi } from "vitest";

import { checkSellerSpriteCdpReadiness } from "./captureEnvironmentReadiness";

const fixedNow = () => new Date("2026-10-12T04:00:00.000Z");

function mockFetch(response: Partial<Response>) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ Browser: "Chrome/154.0", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/private" }),
    ...response,
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("checkSellerSpriteCdpReadiness", () => {
  it("checks only the loopback CDP version endpoint and does not expose its WebSocket URL", async () => {
    const fetchImpl = mockFetch({});

    const result = await checkSellerSpriteCdpReadiness({ fetchImpl, now: fixedNow });

    expect(result).toMatchObject({
      status: "ready",
      cdpReachable: true,
      errorCode: null,
      checkedAt: "2026-10-12T04:00:00.000Z",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:9222/json/version"),
      expect.objectContaining({ method: "GET", cache: "no-store", redirect: "error" })
    );
    expect(JSON.stringify(result)).not.toContain("webSocketDebuggerUrl");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result.nextAction).toContain("不验证");
  });

  it("returns a stable unavailable result when the local CDP endpoint cannot be reached", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED ws://secret-debugger")) as unknown as typeof fetch;

    const result = await checkSellerSpriteCdpReadiness({ fetchImpl, now: fixedNow });

    expect(result).toMatchObject({
      status: "unavailable",
      cdpReachable: false,
      errorCode: "CDP_UNREACHABLE",
      message: "未能连接本机 SellerSprite CDP 接口。",
      checkedAt: "2026-10-12T04:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("secret-debugger");
  });

  it("fails closed for non-loopback or credential-bearing endpoint configuration without making a request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const remote = await checkSellerSpriteCdpReadiness({ endpoint: "http://example.com:9222", fetchImpl, now: fixedNow });
    const credentials = await checkSellerSpriteCdpReadiness({ endpoint: "http://user:pass@127.0.0.1:9222", fetchImpl, now: fixedNow });

    expect(remote).toMatchObject({ status: "misconfigured", cdpReachable: false, errorCode: "CDP_ENDPOINT_INVALID" });
    expect(credentials).toMatchObject({ status: "misconfigured", cdpReachable: false, errorCode: "CDP_ENDPOINT_INVALID" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("distinguishes a non-CDP JSON response from an available endpoint", async () => {
    const fetchImpl = mockFetch({ json: async () => ({ message: "not a CDP response" }) });

    const result = await checkSellerSpriteCdpReadiness({ fetchImpl, now: fixedNow });

    expect(result).toMatchObject({ status: "unavailable", cdpReachable: false, errorCode: "CDP_INVALID_RESPONSE" });
  });
});
