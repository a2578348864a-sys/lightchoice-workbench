import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resolveAccessContext } from "./accessPassword";
import { writeOriginOk } from "./v5ApiRoute";

afterEach(() => vi.unstubAllEnvs());
function request(host: string | null, origin?: string, method = "POST") {
  return new NextRequest("http://localhost:3011/api/source/batches", {
    method, headers: { ...(host === null ? {} : { host }), ...(origin ? { origin } : {}) },
  });
}
describe("trusted Host before local Owner authentication", () => {
  it.each(["evil.example:3011", "localhost.evil.example", "127.0.0.1.evil", "127.1",
    "localhost:65536", "localhost:0", "localhost/path", "evil@localhost:3011", null])(
    "rejects %s with and without a matching Origin", (host) => {
      for (const origin of [undefined, host ? "http://" + host : undefined]) {
        const req = request(host, origin);
        expect(resolveAccessContext(req)).toEqual({ ok: false, reason: "origin" });
        expect(writeOriginOk(req)).toBe(false);
      }
      expect(resolveAccessContext(request(host, undefined, "GET")).ok).toBe(false);
    });
  it.each(["localhost:3011", "127.0.0.1:3011", "[::1]:3011"])(
    "allows explicit loopback %s and consistently allows missing Origin", (host) => {
      const req = request(host);
      expect(resolveAccessContext(req).ok).toBe(true);
      expect(writeOriginOk(req)).toBe(true);
    });
  it("rejects cross-origin writes and only accepts an explicit public origin", () => {
    expect(resolveAccessContext(request("localhost:3011", "https://evil.example")).ok).toBe(false);
    vi.stubEnv("QX_PUBLIC_ORIGIN", "https://workbench.example");
    const configured = request("workbench.example", "https://workbench.example");
    expect(resolveAccessContext(configured).ok).toBe(true);
    expect(writeOriginOk(configured)).toBe(true);
    expect(resolveAccessContext(request("workbench.example.evil")).ok).toBe(false);
  });
});
