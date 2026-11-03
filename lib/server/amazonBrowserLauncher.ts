import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { resolveAmazonCaptureNetworkConfig, type AmazonCaptureProxy } from "@/lib/server/amazonCaptureBrowserConfig";
import { getProfileLockDirectory } from "@/lib/server/playwrightProfileLease.mjs";
import { resolveAmazonCaptureProfileDirectory } from "@/scripts/ops/capture-runtime-config.mjs";
import { resolveSystemBrowser, type BrowserExecutableCandidate } from "@/tools/collectors/amazon/browser-control";
import { isRecordedProcessAlive } from "@/tools/collectors/amazon/owned-process-tree";

/**
 * Amazon 专用浏览器「受控启动器」（服务端权威）。
 *
 * 与 SellerSprite CDP 启动器不同，Amazon 采集使用 Playwright persistent context，
 * 不开放远程调试端口。因此本启动器只负责：
 * - 用服务端正式配置解析的唯一 Profile 拉起一个可见 Chrome/Edge 窗口；
 * - 让用户在该窗口人工登录 Amazon；
 * - 检测同一 Profile 是否已被工作台或既有浏览器占用，避免重复启动与锁冲突。
 *
 * 它不自动登录、不关闭用户浏览器、不强制终止进程、不写入采集事实。
 */

export type AmazonBrowserLaunchErrorCode =
  | "PROFILE_IN_USE"
  | "CHROME_NOT_FOUND"
  | "PROFILE_DIR_INVALID"
  | "PROXY_INVALID"
  | "LAUNCH_IN_PROGRESS"
  | "LAUNCH_FAILED";

export type AmazonBrowserLaunchOutcome =
  | { status: "started"; pid: number }
  | { status: "already_running"; pid: number | null }
  | { status: "rejected"; code: AmazonBrowserLaunchErrorCode; message: string }
  | { status: "failed"; code: AmazonBrowserLaunchErrorCode; message: string };

export type AmazonProfileLockState = {
  /** 工作台采集/会话检查的跨进程 Profile 租约。 */
  appLease: boolean;
  /** Chromium 自己的 Profile 单实例锁。 */
  browserLock: boolean;
};

export type AmazonProfileRuntimeOccupancy = AmazonProfileLockState & {
  /** 命令行确认存在使用同一 Profile 的 Chrome 进程（Windows 无 SingletonLock 时仍可识别）。 */
  browserProcess: boolean;
};

export type AmazonBrowserProcessProbeResult = {
  checked: boolean;
  matchedPids: number[];
};

export type AmazonLauncherEnv = {
  AMAZON_CAPTURE_PROFILE_DIR?: string | undefined;
  AMAZON_CAPTURE_PROXY_URL?: string | undefined;
  [key: string]: string | undefined;
};

export type AmazonLauncherState = {
  profileDir: string;
  pid: number;
  startedAt: string;
};

export type AmazonLauncherStateStore = {
  read(): Promise<AmazonLauncherState | null>;
  write(state: AmazonLauncherState): Promise<void>;
  clear(): Promise<void>;
};

export type AmazonBrowserLauncherDeps = {
  env?: AmazonLauncherEnv;
  cwd?: string;
  spawnImpl?: typeof spawn;
  resolveBrowserImpl?: () => BrowserExecutableCandidate | null;
  lockStateProbe?: (profileDir: string) => Promise<AmazonProfileLockState>;
  processProbe?: (profileDir: string) => Promise<AmazonBrowserProcessProbeResult>;
  stateStore?: AmazonLauncherStateStore;
  statePath?: string;
  sleep?: (ms: number) => Promise<void>;
  launchProbeMs?: number;
};

let launchInFlight = false;

const DEFAULT_LAUNCH_PROBE_MS = 800;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); });
}

function defaultStateStore(path: string): AmazonLauncherStateStore {
  return {
    async read() {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AmazonLauncherState>;
        if (
          typeof parsed.profileDir !== "string"
          || !Number.isSafeInteger(parsed.pid)
          || (parsed.pid ?? 0) < 1
          || typeof parsed.startedAt !== "string"
        ) return null;
        return { profileDir: parsed.profileDir, pid: parsed.pid as number, startedAt: parsed.startedAt };
      } catch {
        return null;
      }
    },
    async write(state) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(state), "utf8");
    },
    async clear() {
      await rm(path, { force: true });
    },
  };
}

/**
 * 只允许服务端显式配置的 Amazon Profile。
 * 不调用 resolveAmazonCaptureProfileDirectory 的缺省 cwd 回退，避免误开旧
 * `.playwright-profile/amazon-us` 或新建一个与 3010 无关的空 Profile。
 */
export function resolveAmazonBrowserProfileDir(
  env: AmazonLauncherEnv = process.env,
  cwd = process.cwd(),
): { profileDir: string | null; message: string | null } {
  const configured = env.AMAZON_CAPTURE_PROFILE_DIR?.trim();
  if (!configured) {
    return { profileDir: null, message: "AMAZON_CAPTURE_PROFILE_DIR 未配置；未启动浏览器。" };
  }
  if (!isAbsolute(configured) || configured.startsWith("\\\\") || configured.startsWith("//")) {
    return { profileDir: null, message: "AMAZON_CAPTURE_PROFILE_DIR 必须是本机绝对路径；未启动浏览器。" };
  }
  try {
    return { profileDir: resolveAmazonCaptureProfileDirectory(env, cwd), message: null };
  } catch {
    return { profileDir: null, message: "AMAZON_CAPTURE_PROFILE_DIR 路径无效；未启动浏览器。" };
  }
}

/** 固定参数、无远程调试端口、无客户端输入。 */
export function buildAmazonBrowserLaunchArguments(input: {
  profileDir: string;
  proxy: AmazonCaptureProxy | null;
}): string[] {
  const args = [
    `--user-data-dir=${input.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (input.proxy) {
    // 只传代理地址，不把用户名/密码拼进命令行，也不写入任何文件。
    args.push(`--proxy-server=${input.proxy.server}`);
  } else {
    // 与采集路径一致：未配置采集代理时显式直连，避免继承 Windows 系统代理。
    args.push("--no-proxy-server");
  }
  args.push("https://www.amazon.com/");
  return args;
}

export async function inspectAmazonProfileLockState(profileDir: string): Promise<AmazonProfileLockState> {
  const browserLock = existsSync(join(profileDir, "SingletonLock"));
  let lockDir: string;
  try {
    lockDir = await getProfileLockDirectory(profileDir);
  } catch {
    // 无法确认租约状态时 fail-closed，不允许启动第二个实例。
    return { appLease: true, browserLock };
  }
  if (!existsSync(lockDir)) return { appLease: false, browserLock };

  // 只把「同机且进程仍存活」的租约视为占用；已退出进程留下的 stale 租约交给
  // acquirePlaywrightProfileLock 的既有恢复逻辑处理，避免一次崩溃永久卡住会话检查。
  try {
    const owner = JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")) as {
      pid?: unknown;
      host?: unknown;
    };
    if (typeof owner.host !== "string" || !Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1) {
      return { appLease: true, browserLock };
    }
    if (owner.host !== hostname()) return { appLease: true, browserLock };
    return { appLease: isRecordedProcessAlive(owner.pid as number), browserLock };
  } catch {
    return { appLease: true, browserLock };
  }
}

/**
 * 只读查询 Chrome 进程命令行，确认是否存在使用同一 Profile 的窗口。
 * 失败时返回 checked=false，由调用方决定 fail-closed 或回退。
 */
export async function probeAmazonProfileChromeProcesses(
  profileDir: string,
): Promise<AmazonBrowserProcessProbeResult> {
  if (process.platform !== "win32") return { checked: false, matchedPids: [] };
  const script = [
    "$ErrorActionPreference='Stop'",
    "$p=$env:LC_AMAZON_PROFILE",
    "$procs=@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\")",
    "if($procs.Count -eq 0){Write-Output 'NONE';exit 0}",
    "$m=@()",
    "foreach($x in $procs){if($x.CommandLine -and $x.CommandLine.ToLower().Contains($p.ToLower())){$m+=[string]$x.ProcessId}}",
    "if($m.Count -gt 0){Write-Output ('MATCH:'+($m -join ','))}else{Write-Output 'OTHER'}",
  ].join(";");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
    env: { ...process.env, LC_AMAZON_PROFILE: profileDir },
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return { checked: false, matchedPids: [] };
  }
  const output = result.stdout.trim();
  if (output.startsWith("MATCH:")) {
    return {
      checked: true,
      matchedPids: output.slice("MATCH:".length).split(",").map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0),
    };
  }
  if (output === "NONE" || output === "OTHER") return { checked: true, matchedPids: [] };
  return { checked: false, matchedPids: [] };
}

/**
 * 会话检查与启动器共用的占用判定：
 * - 工作台租约 / Chromium 锁；
 * - Windows 上没有 SingletonLock 时，用进程命令行确认同 Profile Chrome。
 */
export async function inspectAmazonProfileRuntimeOccupancy(
  profileDir: string,
  deps: { processProbe?: (profileDir: string) => Promise<AmazonBrowserProcessProbeResult> } = {},
): Promise<AmazonProfileRuntimeOccupancy> {
  const locks = await inspectAmazonProfileLockState(profileDir);
  if (locks.browserLock) return { ...locks, browserProcess: true };
  const probe = await (deps.processProbe ?? probeAmazonProfileChromeProcesses)(profileDir);
  return {
    ...locks,
    browserProcess: probe.checked && probe.matchedPids.length > 0,
  };
}

/**
 * 受控启动 Amazon 专用可见浏览器。
 * 返回结构化结果；调用方（受控 API 路由）负责鉴权与 HTTP 状态映射。
 */
export async function launchAmazonBrowser(
  deps: AmazonBrowserLauncherDeps = {},
): Promise<AmazonBrowserLaunchOutcome> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const spawnImpl = deps.spawnImpl ?? spawn;
  const resolveBrowser = deps.resolveBrowserImpl ?? resolveSystemBrowser;
  const lockStateProbe = deps.lockStateProbe ?? inspectAmazonProfileLockState;
  const processProbe = deps.processProbe ?? probeAmazonProfileChromeProcesses;
  const store = deps.stateStore ?? defaultStateStore(deps.statePath ?? join(homedir(), ".lightchoice-v5", "amazon-browser-launcher.json"));
  const sleep = deps.sleep ?? defaultSleep;
  const launchProbeMs = deps.launchProbeMs ?? DEFAULT_LAUNCH_PROBE_MS;

  const resolved = resolveAmazonBrowserProfileDir(env, cwd);
  if (!resolved.profileDir) {
    return { status: "rejected", code: "PROFILE_DIR_INVALID", message: resolved.message ?? "Amazon 采集 Profile 路径无效；未启动浏览器。" };
  }
  const profileDir = resolved.profileDir;

  const network = resolveAmazonCaptureNetworkConfig(env);
  if (network.invalidReason) {
    return { status: "rejected", code: "PROXY_INVALID", message: "Amazon 采集代理配置无效；未启动浏览器。" };
  }

  if (launchInFlight) {
    return { status: "rejected", code: "LAUNCH_IN_PROGRESS", message: "已有一次启动请求正在处理；请稍后重试。" };
  }
  launchInFlight = true;
  try {
    const lockState = await lockStateProbe(profileDir);
    if (lockState.appLease) {
      return { status: "rejected", code: "PROFILE_IN_USE", message: "Amazon 采集 Profile 正在被工作台使用；未重复启动浏览器。" };
    }

    const state = await store.read().catch(() => null);

    // Windows Chrome 不保证在 user-data-dir 下留下 SingletonLock；不能只靠锁文件判断
    // 是否已有窗口。先按命令行确认同 Profile 的 Chrome 进程，再决定复用或拒绝。
    const probe = await processProbe(profileDir);
    if (probe.checked && probe.matchedPids.length > 0) {
      return { status: "already_running", pid: probe.matchedPids[0] ?? null };
    }
    if (!probe.checked) {
      if (state?.profileDir === profileDir && isRecordedProcessAlive(state.pid)) {
        return { status: "already_running", pid: state.pid };
      }
      return {
        status: "rejected",
        code: "PROFILE_IN_USE",
        message: "无法确认 Amazon 采集 Profile 是否已被占用；为防重复启动，本次未打开浏览器。",
      };
    }
    if (lockState.browserLock) {
      return {
        status: "rejected",
        code: "PROFILE_IN_USE",
        message: "Amazon 采集 Profile 已被其他程序占用；请关闭该浏览器/程序后再试。",
      };
    }

    // 没有同 Profile 进程、也没有占用锁时，旧的启动器状态只可能是 stale；清理后按新启动处理。
    if (state) await store.clear().catch(() => undefined);

    const browser = resolveBrowser();
    if (!browser) {
      return { status: "rejected", code: "CHROME_NOT_FOUND", message: "未找到可用的 Chrome/Edge；未启动浏览器。" };
    }

    await mkdir(profileDir, { recursive: true });
    const args = buildAmazonBrowserLaunchArguments({ profileDir, proxy: network.proxy });

    let child: ChildProcess;
    try {
      child = spawnImpl(browser.executablePath, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      }) as ChildProcess;
    } catch {
      return { status: "failed", code: "LAUNCH_FAILED", message: "启动 Chrome 失败；未确认窗口已打开。" };
    }
    child.unref?.();
    const pid = Number.isSafeInteger(child.pid) ? (child.pid as number) : null;
    if (pid === null) {
      return { status: "failed", code: "LAUNCH_FAILED", message: "Chrome 启动后未返回进程号；未确认窗口已打开。" };
    }

    // 给进程一个很短的观察窗口：Profile 被其他实例占用或启动被策略拒绝时，
    // Chrome 会很快退出；此时不能向用户宣称窗口已经打开。
    await sleep(launchProbeMs);
    if (child.exitCode !== null) {
      return { status: "failed", code: "LAUNCH_FAILED", message: "Chrome 进程提前退出；未确认窗口已打开。" };
    }

    await store.write({ profileDir, pid, startedAt: new Date().toISOString() }).catch(() => undefined);
    return { status: "started", pid };
  } finally {
    launchInFlight = false;
  }
}
