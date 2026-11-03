import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAmazonBrowserLaunchArguments,
  inspectAmazonProfileLockState,
  launchAmazonBrowser,
  resolveAmazonBrowserProfileDir,
  type AmazonLauncherState,
  type AmazonLauncherStateStore,
} from "./amazonBrowserLauncher";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempProfileDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lc-amazon-launch-"));
  tempDirs.push(root);
  const profileDir = join(root, "amazon-us");
  await mkdir(profileDir, { recursive: true });
  return profileDir;
}

function memoryStore(initial: AmazonLauncherState | null = null): AmazonLauncherStateStore & { current(): AmazonLauncherState | null } {
  let state = initial;
  return {
    async read() { return state; },
    async write(next) { state = next; },
    async clear() { state = null; },
    current() { return state; },
  };
}

function fakeChild(pid = 4321, exitCode: number | null = null): ChildProcess {
  return { pid, exitCode, unref: vi.fn() } as unknown as ChildProcess;
}

const browser = { browser: "chrome" as const, locationType: "system" as const, executablePath: "C:\\fake\\chrome.exe" };
const noChromeProcess = async () => ({ checked: true, matchedPids: [] });

describe("Amazon 专用浏览器启动器", () => {
  describe("Profile 解析（禁止旧目录回退）", () => {
    it("缺少 AMAZON_CAPTURE_PROFILE_DIR → 明确失败，不落到 cwd/.playwright-profile", () => {
      const result = resolveAmazonBrowserProfileDir({}, "D:\\repo");
      expect(result.profileDir).toBeNull();
      expect(result.message).toContain("未配置");
    });

    it("相对路径 → 拒绝", () => {
      const result = resolveAmazonBrowserProfileDir({ AMAZON_CAPTURE_PROFILE_DIR: ".playwright-profile/amazon-us" }, "D:\\repo");
      expect(result.profileDir).toBeNull();
    });

    it("UNC 路径 → 拒绝", () => {
      const result = resolveAmazonBrowserProfileDir({ AMAZON_CAPTURE_PROFILE_DIR: "\\\\server\\share\\amazon-us" }, "D:\\repo");
      expect(result.profileDir).toBeNull();
    });

    it("显式绝对路径 → 只使用该路径", async () => {
      const profileDir = await tempProfileDir();
      const result = resolveAmazonBrowserProfileDir({ AMAZON_CAPTURE_PROFILE_DIR: profileDir }, "D:\\repo");
      expect(result.profileDir).toBe(profileDir);
    });
  });

  describe("Profile 占用探测", () => {
    it("无租约、无 SingletonLock → 未占用", async () => {
      const profileDir = await tempProfileDir();
      await expect(inspectAmazonProfileLockState(profileDir)).resolves.toEqual({ appLease: false, browserLock: false });
    });

    it("SingletonLock 存在 → browserLock=true", async () => {
      const profileDir = await tempProfileDir();
      await writeFile(join(profileDir, "SingletonLock"), "", "utf8");
      await expect(inspectAmazonProfileLockState(profileDir)).resolves.toMatchObject({ browserLock: true });
    });
  });

  describe("启动参数", () => {
    it("固定 user-data-dir，且不开放远程调试端口", () => {
      const args = buildAmazonBrowserLaunchArguments({ profileDir: "C:\\profiles\\amazon-us", proxy: null });
      expect(args).toContain("--user-data-dir=C:\\profiles\\amazon-us");
      expect(args).toContain("--no-proxy-server");
      expect(args.join(" ")).not.toContain("remote-debugging");
      expect(args).toContain("https://www.amazon.com/");
    });

    it("配置代理时只传地址，不拼凭据", () => {
      const args = buildAmazonBrowserLaunchArguments({
        profileDir: "C:\\profiles\\amazon-us",
        proxy: { server: "http://127.0.0.1:7890", username: "user", password: "secret" },
      });
      expect(args).toContain("--proxy-server=http://127.0.0.1:7890");
      expect(args.join(" ")).not.toContain("username");
      expect(args.join(" ")).not.toContain("secret");
    });
  });

  describe("启动结果", () => {
    it("成功启动 → started，并记录 PID", async () => {
      const profileDir = await tempProfileDir();
      const store = memoryStore();
      const spawnImpl = vi.fn((_command: string, _args: string[], _options: unknown) => fakeChild(4321, null));
      const result = await launchAmazonBrowser({
        env: { AMAZON_CAPTURE_PROFILE_DIR: profileDir },
        resolveBrowserImpl: () => browser,
        spawnImpl: spawnImpl as unknown as typeof import("node:child_process").spawn,
        lockStateProbe: async () => ({ appLease: false, browserLock: false }),
        processProbe: noChromeProcess,
        stateStore: store,
        sleep: async () => undefined,
      });

      expect(result).toEqual({ status: "started", pid: 4321 });
      expect(spawnImpl).toHaveBeenCalledTimes(1);
      const args = spawnImpl.mock.calls[0]?.[1] as string[];
      expect(args).toContain(`--user-data-dir=${profileDir}`);
      expect(store.current()).toMatchObject({ profileDir, pid: 4321 });
    });

    it("同 Profile 的启动器进程仍存活 + Chromium 锁 → already_running，不重复启动", async () => {
      const profileDir = await tempProfileDir();
      const store = memoryStore({ profileDir, pid: process.pid, startedAt: "2026-11-04T00:00:00.000Z" });
      const spawnImpl = vi.fn();
      const result = await launchAmazonBrowser({
        env: { AMAZON_CAPTURE_PROFILE_DIR: profileDir },
        resolveBrowserImpl: () => browser,
        spawnImpl: spawnImpl as unknown as typeof import("node:child_process").spawn,
        lockStateProbe: async () => ({ appLease: false, browserLock: true }),
        processProbe: async () => ({ checked: true, matchedPids: [process.pid] }),
        stateStore: store,
      });

      expect(result).toEqual({ status: "already_running", pid: process.pid });
      expect(spawnImpl).not.toHaveBeenCalled();
    });

    it("进程探测不可用但启动器状态仍存活 → already_running（fail-closed 前先复用）", async () => {
      const profileDir = await tempProfileDir();
      const store = memoryStore({ profileDir, pid: process.pid, startedAt: "2026-11-04T00:00:00.000Z" });
      const spawnImpl = vi.fn();
      const result = await launchAmazonBrowser({
        env: { AMAZON_CAPTURE_PROFILE_DIR: profileDir },
        resolveBrowserImpl: () => browser,
        spawnImpl: spawnImpl as unknown as typeof import("node:child_process").spawn,
        lockStateProbe: async () => ({ appLease: false, browserLock: true }),
        processProbe: async () => ({ checked: false, matchedPids: [] }),
        stateStore: store,
      });

      expect(result).toEqual({ status: "already_running", pid: process.pid });
      expect(spawnImpl).not.toHaveBeenCalled();
    });

    it("工作台采集租约占用 → PROFILE_IN_USE，不启动", async () => {
      const profileDir = await tempProfileDir();
      const spawnImpl = vi.fn();
      const result = await launchAmazonBrowser({
        env: { AMAZON_CAPTURE_PROFILE_DIR: profileDir },
        resolveBrowserImpl: () => browser,
        spawnImpl: spawnImpl as unknown as typeof import("node:child_process").spawn,
        lockStateProbe: async () => ({ appLease: true, browserLock: false }),
        stateStore: memoryStore(),
      });

      expect(result).toMatchObject({ status: "rejected", code: "PROFILE_IN_USE" });
      expect(spawnImpl).not.toHaveBeenCalled();
    });

    it("Chromium 锁存在但没有可验证的同 Profile 进程 → PROFILE_IN_USE，不启动", async () => {
      const profileDir = await tempProfileDir();
      const spawnImpl = vi.fn();
      const result = await launchAmazonBrowser({
        env: { AMAZON_CAPTURE_PROFILE_DIR: profileDir },
        resolveBrowserImpl: () => browser,
        spawnImpl: spawnImpl as unknown as typeof import("node:child_process").spawn,
        lockStateProbe: async () => ({ appLease: false, browserLock: true }),
        processProbe: async () => ({ checked: true, matchedPids: [] }),
        stateStore: memoryStore(),
      });

      expect(result).toMatchObject({ status: "rejected", code: "PROFILE_IN_USE" });
      expect(spawnImpl).not.toHaveBeenCalled();
    });

    it("进程探测命中同 Profile Chrome → already_running", async () => {
      const profileDir = await tempProfileDir();
      const spawnImpl = vi.fn();
      const result = await launchAmazonBrowser({
        env: { AMAZON_CAPTURE_PROFILE_DIR: profileDir },
        resolveBrowserImpl: () => browser,
        spawnImpl: spawnImpl as unknown as typeof import("node:child_process").spawn,
        lockStateProbe: async () => ({ appLease: false, browserLock: true }),
        processProbe: async () => ({ checked: true, matchedPids: [9876] }),
        stateStore: memoryStore(),
      });

      expect(result).toEqual({ status: "already_running", pid: 9876 });
      expect(spawnImpl).not.toHaveBeenCalled();
    });

    it("Chrome 不存在 → CHROME_NOT_FOUND", async () => {
      const profileDir = await tempProfileDir();
      const spawnImpl = vi.fn();
      const result = await launchAmazonBrowser({
        env: { AMAZON_CAPTURE_PROFILE_DIR: profileDir },
        resolveBrowserImpl: () => null,
        spawnImpl: spawnImpl as unknown as typeof import("node:child_process").spawn,
        lockStateProbe: async () => ({ appLease: false, browserLock: false }),
        processProbe: noChromeProcess,
        stateStore: memoryStore(),
      });

      expect(result).toMatchObject({ status: "rejected", code: "CHROME_NOT_FOUND" });
      expect(spawnImpl).not.toHaveBeenCalled();
    });

    it("Profile 未配置 → PROFILE_DIR_INVALID，不回退旧目录", async () => {
      const result = await launchAmazonBrowser({
        env: {},
        resolveBrowserImpl: () => browser,
        stateStore: memoryStore(),
      });

      expect(result).toMatchObject({ status: "rejected", code: "PROFILE_DIR_INVALID" });
    });

    it("spawn 抛错 → LAUNCH_FAILED", async () => {
      const profileDir = await tempProfileDir();
      const result = await launchAmazonBrowser({
        env: { AMAZON_CAPTURE_PROFILE_DIR: profileDir },
        resolveBrowserImpl: () => browser,
        spawnImpl: (() => { throw new Error("spawn failed"); }) as unknown as typeof import("node:child_process").spawn,
        lockStateProbe: async () => ({ appLease: false, browserLock: false }),
        processProbe: noChromeProcess,
        stateStore: memoryStore(),
      });

      expect(result).toMatchObject({ status: "failed", code: "LAUNCH_FAILED" });
    });

    it("Chrome 提前退出 → LAUNCH_FAILED，不谎报窗口已打开", async () => {
      const profileDir = await tempProfileDir();
      const spawnImpl = vi.fn(() => fakeChild(4321, 1));
      const result = await launchAmazonBrowser({
        env: { AMAZON_CAPTURE_PROFILE_DIR: profileDir },
        resolveBrowserImpl: () => browser,
        spawnImpl: spawnImpl as unknown as typeof import("node:child_process").spawn,
        lockStateProbe: async () => ({ appLease: false, browserLock: false }),
        processProbe: noChromeProcess,
        stateStore: memoryStore(),
        sleep: async () => undefined,
      });

      expect(result).toMatchObject({ status: "failed", code: "LAUNCH_FAILED" });
    });

    it("进程内单飞：并发重复点击只有第一个进入启动流程", async () => {
      const profileDir = await tempProfileDir();
      let release!: () => void;
      const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
      const first = launchAmazonBrowser({
        env: { AMAZON_CAPTURE_PROFILE_DIR: profileDir },
        resolveBrowserImpl: () => browser,
        spawnImpl: vi.fn(() => fakeChild(4321, null)) as unknown as typeof import("node:child_process").spawn,
        lockStateProbe: async () => { await gate; return { appLease: false, browserLock: false }; },
        processProbe: noChromeProcess,
        stateStore: memoryStore(),
        sleep: async () => undefined,
      });
      await Promise.resolve();
      const second = await launchAmazonBrowser({
        env: { AMAZON_CAPTURE_PROFILE_DIR: profileDir },
        resolveBrowserImpl: () => browser,
        stateStore: memoryStore(),
      });
      expect(second).toMatchObject({ status: "rejected", code: "LAUNCH_IN_PROGRESS" });
      release();
      await first;
    });
  });
});
