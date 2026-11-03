import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { SellerSpriteCdpReadiness } from "./captureEnvironmentReadiness";
import { launchSellerSpriteBrowser } from "./sellerSpriteBrowserLauncher";

const ready = (): SellerSpriteCdpReadiness => ({
  status: "ready",
  cdpReachable: true,
  errorCode: null,
  checkedAt: "2026-10-17T00:00:00.000Z",
  latencyMs: 1,
  message: "本机 SellerSprite CDP 接口可达。",
  nextAction: "x",
});

const unreachable = (): SellerSpriteCdpReadiness => ({
  status: "unavailable",
  cdpReachable: false,
  errorCode: "CDP_UNREACHABLE",
  checkedAt: "2026-10-17T00:00:00.000Z",
  latencyMs: null,
  message: "未能连接本机 SellerSprite CDP 接口。",
  nextAction: "y",
});

function fakeChild() {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    pid: 4242,
    unref: vi.fn(),
    once: vi.fn((event: string, callback: () => void) => {
      (handlers[event] ??= []).push(callback);
    }),
    emit(event: string) {
      for (const callback of handlers[event] ?? []) callback();
    },
  };
}

const appRoot = resolve(tmpdir(), "seller-sprite-browser-launcher-app");
const profileDir = resolve(appRoot, ".playwright-profile", "sellersprite-v3");
const foreignProfileDir = resolve(tmpdir(), "seller-sprite-foreign-profile");
const browserCandidate = { browser: "chrome", locationType: "system", executablePath: resolve(tmpdir(), "Chrome", "chrome.exe") };

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    env: {},
    cwd: appRoot,
    resolveBrowserImpl: () => browserCandidate as never,
    readinessProbe: async () => unreachable(),
    probePortImpl: async () => false,
    // 默认阻断真实网络与 CDP：需要走归属校验的用例必须显式注入
    fetchImpl: async () => { throw new Error("network disabled in tests"); },
    readBrowserCommandLineImpl: async () => null,
    sleep: async () => undefined,
    ...overrides,
  } as Parameters<typeof launchSellerSpriteBrowser>[0];
}

function cdpVersionResponse(wsUrl = "ws://127.0.0.1:9222/devtools/browser/abc") {
  return (async () => ({
    ok: true,
    json: async () => ({ Browser: "Chrome/155.0", webSocketDebuggerUrl: wsUrl }),
  })) as unknown as typeof fetch;
}

describe("launchSellerSpriteBrowser（受控启动 SellerSprite 专用浏览器）", () => {
  it("CDP 端点配置非法（非本机回环）→ 拒绝，且不 spawn", async () => {
    const spawnImpl = vi.fn();
    const result = await launchSellerSpriteBrowser(baseDeps({
      env: { SELLERSPRITE_CDP_ENDPOINT: "http://10.0.0.5:9222" },
      spawnImpl,
    }));
    expect(result).toMatchObject({ status: "rejected", code: "CDP_ENDPOINT_INVALID" });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("Profile 目录配置非法（相对路径）→ 拒绝，且不 spawn", async () => {
    const spawnImpl = vi.fn();
    const result = await launchSellerSpriteBrowser(baseDeps({
      env: { SELLERSPRITE_PROFILE_DIR: "relative/profile" },
      spawnImpl,
    }));
    expect(result).toMatchObject({ status: "rejected", code: "PROFILE_DIR_INVALID" });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("CDP 已可达且校验为专用实例 → already_running 复用，绝不重复启动", async () => {
    const spawnImpl = vi.fn();
    const result = await launchSellerSpriteBrowser(baseDeps({
      readinessProbe: async () => ready(),
      fetchImpl: cdpVersionResponse(),
      readBrowserCommandLineImpl: async () => [
        `--user-data-dir=${profileDir}`,
        "--remote-debugging-port=9222",
      ],
      spawnImpl,
    }));
    expect(result).toMatchObject({ status: "already_running", endpoint: "http://127.0.0.1:9222" });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("D2-1F-核实2）9222 上是外来 Chrome（读得到参数但不匹配专用 Profile）→ 拒绝，绝不复用", async () => {
    const spawnImpl = vi.fn();
    const result = await launchSellerSpriteBrowser(baseDeps({
      readinessProbe: async () => ready(),
      fetchImpl: cdpVersionResponse(),
      readBrowserCommandLineImpl: async () => [`--user-data-dir=${foreignProfileDir}`],
      spawnImpl,
    }));
    expect(result).toMatchObject({ status: "rejected", code: "CDP_ENDPOINT_FOREIGN_BROWSER" });
    if (result.status === "rejected") expect(result.message).toContain("不会连接");
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("D2-1F-核实2）9222 上实例归属不可验证（无自动化标记/读不到参数）→ fail-closed 拒绝", async () => {
    const spawnImpl = vi.fn();
    const result = await launchSellerSpriteBrowser(baseDeps({
      readinessProbe: async () => ready(),
      fetchImpl: cdpVersionResponse(),
      readBrowserCommandLineImpl: async () => null,
      spawnImpl,
    }));
    expect(result).toMatchObject({ status: "rejected", code: "CDP_ENDPOINT_OWNERSHIP_UNKNOWN" });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("D2-1F-核实2）webSocketDebuggerUrl 指向远端地址时不被信任（防引导）→ 归属 unknown 拒绝", async () => {
    const readImpl = vi.fn(async () => [`--user-data-dir=${profileDir}`]);
    const result = await launchSellerSpriteBrowser(baseDeps({
      readinessProbe: async () => ready(),
      fetchImpl: cdpVersionResponse("ws://evil.example.com:9222/devtools/browser/x"),
      readBrowserCommandLineImpl: readImpl,
    }));
    expect(result).toMatchObject({ status: "rejected", code: "CDP_ENDPOINT_OWNERSHIP_UNKNOWN" });
    // 远端 ws 地址绝不被连接
    expect(readImpl).not.toHaveBeenCalled();
  });

  it("CDP 已可达但读不到浏览器参数时 fail-closed（不得直接复用）", async () => {
    const spawnImpl = vi.fn();
    const result = await launchSellerSpriteBrowser(baseDeps({
      readinessProbe: async () => ready(),
      fetchImpl: async () => { throw new Error("version endpoint unreachable"); },
      spawnImpl,
    }));
    expect(result).toMatchObject({ status: "rejected", code: "CDP_ENDPOINT_OWNERSHIP_UNKNOWN" });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("端口被占用但非 CDP 接口 → 明确拒绝（归属不明，不抢占）", async () => {
    const spawnImpl = vi.fn();
    const result = await launchSellerSpriteBrowser(baseDeps({
      probePortImpl: async () => true,
      spawnImpl,
    }));
    expect(result).toMatchObject({ status: "rejected", code: "CDP_PORT_OCCUPIED" });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("未找到本机 Chrome → 拒绝", async () => {
    const spawnImpl = vi.fn();
    const result = await launchSellerSpriteBrowser(baseDeps({
      resolveBrowserImpl: () => null,
      spawnImpl,
    }));
    expect(result).toMatchObject({ status: "rejected", code: "CHROME_NOT_FOUND" });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("启动成功：固定专用参数（无 headless）、等待回读到 CDP 可达后返回 started", async () => {
    let probeCount = 0;
    const readinessProbe = vi.fn(async () => {
      probeCount += 1;
      return probeCount === 1 ? unreachable() : ready();
    });
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child as never);

    const result = await launchSellerSpriteBrowser(baseDeps({ readinessProbe, spawnImpl }));

    expect(result.status).toBe("started");
    if (result.status === "started") {
      expect(result.pid).toBe(4242);
      expect(result.profileDir).toMatch(/sellersprite-v3$/u);
    }
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [executable, args] = spawnImpl.mock.calls[0] as unknown as [string, string[]];
    expect(executable).toBe(browserCandidate.executablePath);
    const joined = args.join(" ");
    expect(joined).toContain("--user-data-dir=");
    expect(joined).toContain("--remote-debugging-address=127.0.0.1");
    expect(joined).toContain("--remote-debugging-port=9222");
    // 专用实例标记：保证后续归属校验可读（外部 Chrome 通常没有该标记）
    expect(joined).toContain("--enable-automation");
    // 可见窗口（用户要人工登录/使用），且绝不带 headless
    expect(joined).not.toContain("--headless");
    expect(child.unref).toHaveBeenCalled();
  });

  it("Chrome 进程提前退出且端口未就绪 → failed（可能是 Profile 被其他实例占用）", async () => {
    const child = fakeChild();
    // 注：sleep 为即时 mock 时宏任务（setTimeout）会被饿死，因此用 probe 回调同步触发 exit，
    // 等价于生产环境中「进程很快退出」的时序。
    let probeCount = 0;
    const readinessProbe = vi.fn(async () => {
      probeCount += 1;
      if (probeCount >= 2) child.emit("exit");
      return unreachable();
    });
    const spawnImpl = vi.fn(() => child as never);
    const result = await launchSellerSpriteBrowser(baseDeps({ readinessProbe, spawnImpl }));
    expect(result).toMatchObject({ status: "failed", code: "BROWSER_EXITED_BEFORE_READY" });
  });

  it("等待超时（进程活着但端口不就绪）→ failed CDP_NOT_READY_TIMEOUT", async () => {
    const child = fakeChild();
    const result = await launchSellerSpriteBrowser(baseDeps({
      readinessProbe: async () => unreachable(),
      spawnImpl: vi.fn(() => child as never),
    }));
    expect(result).toMatchObject({ status: "failed", code: "CDP_NOT_READY_TIMEOUT" });
  });

  it("spawn 同步抛错（如 EBUSY）→ failed 且信息脱敏截断", async () => {
    const result = await launchSellerSpriteBrowser(baseDeps({
      spawnImpl: vi.fn(() => { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); }) as never,
    }));
    expect(result).toMatchObject({ status: "failed", code: "BROWSER_SPAWN_FAILED" });
    if (result.status === "failed") expect(result.message.length).toBeLessThanOrEqual(200);
  });

  it("并发/重复点击：启动进行中再次请求 → rejected LAUNCH_IN_PROGRESS", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const first = launchSellerSpriteBrowser(baseDeps({
      readinessProbe: async () => { await gate; return ready(); },
      fetchImpl: cdpVersionResponse(),
      readBrowserCommandLineImpl: async () => [`--user-data-dir=${profileDir}`],
    }));
    // 第一次调用的同步段已执行（inFlight=true），第二次请求必须被拒绝
    const second = await launchSellerSpriteBrowser(baseDeps({}));
    expect(second).toMatchObject({ status: "rejected", code: "LAUNCH_IN_PROGRESS" });
    release();
    const firstResult = await first;
    expect(firstResult.status).toBe("already_running");
  });
});
