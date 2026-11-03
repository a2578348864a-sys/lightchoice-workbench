/**
 * 本地单用户认证契约测试（Local Owner）。
 *
 * 正式契约：服务只绑定回环；身份由服务端隐式建立；不存在密码 / 登录 / 访客 / public_showcase。
 * 缺少任何认证相关环境变量都不得回退到登录体系。
 *
 * 对象级授权 / Research / Decision CAS / Evidence / Provider 校验 / proof signing / CSRF
 * 由各自既有测试套件独立覆盖（本文件只验证身份层与同源层契约）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { resolveAccessContext, getAccessContext, checkAccessPassword } from "@/lib/server/accessPassword";
import { requireAuthenticated, requireOwnerOnly } from "@/lib/server/demoGuard";
import { getRuntimeMode, isLocalOwnerNoAuthTrust, isPublicShowcase } from "@/lib/server/runtimeMode";

const AUTH_ENV_KEYS = ["ACCESS_PASSWORD", "APP_ACCESS_PASSWORD", "QX_RUNTIME_MODE", "PUBLIC_SHOWCASE"];

function req(path: string, init?: { method?: string; headers?: Record<string, string> }): NextRequest {
  return new NextRequest("http://127.0.0.1:3010" + path, {
    method: init?.method ?? "GET",
    headers: { host: "127.0.0.1:3010", ...init?.headers },
  });
}

beforeEach(() => {
  for (const key of AUTH_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of AUTH_ENV_KEYS) delete process.env[key];
});

describe("契约 1-2：缺少认证环境变量仍正常运行", () => {
  it("ACCESS_PASSWORD 不存在 → 运行模式仍为 local_owner", () => {
    delete process.env.ACCESS_PASSWORD;
    expect(getRuntimeMode()).toBe("local_owner");
    expect(isLocalOwnerNoAuthTrust()).toBe(true);
  });

  it("QX_RUNTIME_MODE 不存在 → 运行模式仍为 local_owner（不回退登录）", () => {
    delete process.env.QX_RUNTIME_MODE;
    expect(getRuntimeMode()).toBe("local_owner");
    expect(isPublicShowcase()).toBe(false);
  });
});

describe("契约 3-4：本机请求不因未登录被拒", () => {
  it("GET / 与核心 API 的本机请求 → 解析为 Local Owner", () => {
    for (const path of ["/", "/api/home/summary", "/api/source/batches", "/api/source/amazon-products", "/api/feishu-sync/connection"]) {
      const resolved = resolveAccessContext(req(path));
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(resolved.context.mode).toBe("owner");
      expect(getAccessContext(req(path))?.mode).toBe("owner");
      expect(checkAccessPassword(req(path))).toBeNull();
    }
  });

  it("requireAuthenticated / requireOwnerOnly 均返回 owner 上下文", () => {
    const a = requireAuthenticated(req("/api/home/summary"));
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.context.mode).toBe("owner");
    const o = requireOwnerOnly(req("/api/tasks", { method: "POST" }));
    expect(o.ok).toBe(true);
    if (o.ok) expect(o.context.mode).toBe("owner");
  });
});

describe("契约 10：CSRF / 同源仍然 fail-closed", () => {
  it("变更请求携带跨站 Origin → 拒绝", () => {
    const resolved = resolveAccessContext(req("/api/tasks", {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
    }));
    expect(resolved).toEqual({ ok: false, reason: "origin" });
  });

  it("同源 Origin → 放行", () => {
    const resolved = resolveAccessContext(req("/api/tasks", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3010" },
    }));
    expect(resolved.ok).toBe(true);
  });

  it("无 Origin 的变更请求 → 放行（非 Cookie 认证，无 ambient CSRF 面）", () => {
    const resolved = resolveAccessContext(req("/api/tasks", { method: "POST" }));
    expect(resolved.ok).toBe(true);
  });

  it("跨站 Origin 的读请求不受影响（GET 无 CSRF 面）", () => {
    const resolved = resolveAccessContext(req("/api/home/summary", {
      headers: { origin: "https://evil.example.com" },
    }));
    expect(resolved.ok).toBe(true);
  });
});

describe("契约 12：不存在登录 / 访客回退通道", () => {
  it("携带任意 x-access-password 头不再产生身份差异", () => {
    const withHeader = resolveAccessContext(req("/api/x", { headers: { "x-access-password": "anything" } }));
    const withoutHeader = resolveAccessContext(req("/api/x"));
    expect(withHeader).toEqual(withoutHeader);
  });

  it("不产生 demo / 访客身份", () => {
    const resolved = resolveAccessContext(req("/api/x", { headers: { cookie: "__Host-lqx_guest=whatever" } }));
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.context.mode).not.toBe("demo");
  });
});
