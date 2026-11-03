import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveSellerSpriteCdpEndpoint,
  resolveSellerSpriteProfileDirectory,
} from "./sellerSpriteProfileConfig";

const appRoot = resolve(tmpdir(), "seller-sprite-profile-config-app-root");
const configuredProfileDir = resolve(tmpdir(), "seller-sprite-profiles", "sellersprite-main");

describe("resolveSellerSpriteProfileDirectory（服务端权威 Profile 解析）", () => {
  it("未配置时默认取 <cwd>/.playwright-profile/sellersprite-v3（与采集代码同规则）", () => {
    const resolved = resolveSellerSpriteProfileDirectory({}, appRoot);
    expect(resolved).toMatch(/\.playwright-profile[\\/]sellersprite-v3$/u);
    expect(resolved).toContain("app-root");
  });

  it("SELLERSPRITE_PROFILE_DIR 为绝对路径时优先使用", () => {
    const resolved = resolveSellerSpriteProfileDirectory(
      { SELLERSPRITE_PROFILE_DIR: configuredProfileDir },
      appRoot,
    );
    expect(resolved).toBe(configuredProfileDir);
    expect(resolved).toContain("sellersprite-main");
    expect(resolved).not.toContain("app-root");
  });

  it("相对路径与 UNC 网络路径一律 fail-closed（拒绝）", () => {
    expect(() => resolveSellerSpriteProfileDirectory({ SELLERSPRITE_PROFILE_DIR: "relative/dir" })).toThrow("SELLERSPRITE_PROFILE_DIR_INVALID");
    expect(() => resolveSellerSpriteProfileDirectory({ SELLERSPRITE_PROFILE_DIR: "\\\\server\\share" })).toThrow("SELLERSPRITE_PROFILE_DIR_INVALID");
    expect(() => resolveSellerSpriteProfileDirectory({ SELLERSPRITE_PROFILE_DIR: "//server/share" })).toThrow("SELLERSPRITE_PROFILE_DIR_INVALID");
  });
});

describe("resolveSellerSpriteCdpEndpoint（服务端权威端点解析）", () => {
  it("未配置时默认 http://127.0.0.1:9222", () => {
    expect(resolveSellerSpriteCdpEndpoint({})).toEqual({
      origin: "http://127.0.0.1:9222",
      host: "127.0.0.1",
      port: 9222,
    });
  });

  it("允许 localhost 与自定义回环端口（host 归一化为 127.0.0.1）", () => {
    expect(resolveSellerSpriteCdpEndpoint({ SELLERSPRITE_CDP_ENDPOINT: "http://localhost:9333" })).toEqual({
      origin: "http://localhost:9333",
      host: "127.0.0.1",
      port: 9333,
    });
  });

  it("远端主机、凭据、非 http、非法端口一律返回 null（fail-closed）", () => {
    expect(resolveSellerSpriteCdpEndpoint({ SELLERSPRITE_CDP_ENDPOINT: "http://example.com:9222" })).toBeNull();
    expect(resolveSellerSpriteCdpEndpoint({ SELLERSPRITE_CDP_ENDPOINT: "http://user:pass@127.0.0.1:9222" })).toBeNull();
    expect(resolveSellerSpriteCdpEndpoint({ SELLERSPRITE_CDP_ENDPOINT: "https://127.0.0.1:9222" })).toBeNull();
    expect(resolveSellerSpriteCdpEndpoint({ SELLERSPRITE_CDP_ENDPOINT: "http://127.0.0.1:99999" })).toBeNull();
    expect(resolveSellerSpriteCdpEndpoint({ SELLERSPRITE_CDP_ENDPOINT: "not a url" })).toBeNull();
  });
});
