/**
 * 本地单用户运行模式契约（Local Owner）。
 *
 * 正式契约：
 *   - 运行模式恒为 local_owner；
 *   - 不读取任何环境变量（QX_RUNTIME_MODE 运行时依赖 = 0）；
 *   - 缺少任何配置都不回退到密码 / 登录 / 公开访客体系。
 */
import { afterEach, describe, expect, it } from "vitest";
import { getRuntimeMode, isPublicShowcase, isLocalOwnerNoAuthTrust } from "@/lib/server/runtimeMode";

const ENV_KEYS = ["QX_RUNTIME_MODE", "ACCESS_PASSWORD", "APP_ACCESS_PASSWORD", "PUBLIC_SHOWCASE"];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("runtimeMode — 本地单用户（Local Owner）", () => {
  it("无任何环境变量 → local_owner 且回环信任启用", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    expect(getRuntimeMode()).toBe("local_owner");
    expect(isPublicShowcase()).toBe(false);
    expect(isLocalOwnerNoAuthTrust()).toBe(true);
  });

  it("显式 QX_RUNTIME_MODE 不再影响结果（运行时依赖 = 0）", () => {
    for (const value of ["local_owner", "public_showcase", "PUBLIC_MODE", ""]) {
      process.env.QX_RUNTIME_MODE = value;
      expect(getRuntimeMode()).toBe("local_owner");
      expect(isPublicShowcase()).toBe(false);
      expect(isLocalOwnerNoAuthTrust()).toBe(true);
    }
  });

  it("缺少 QX_RUNTIME_MODE 不会回退到密码 / 登录体系", () => {
    delete process.env.QX_RUNTIME_MODE;
    delete process.env.ACCESS_PASSWORD;
    expect(getRuntimeMode()).toBe("local_owner");
    expect(isLocalOwnerNoAuthTrust()).toBe(true);
  });
});
