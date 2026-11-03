import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { join } from "node:path";

import { resolveSystemBrowser, type BrowserExecutableCandidate } from "@/tools/collectors/amazon/browser-control";
import {
  checkSellerSpriteCdpReadiness,
  type SellerSpriteCdpReadiness,
} from "@/lib/server/captureEnvironmentReadiness";
import { probeBrowserIdentityViaHttp } from "@/lib/server/sellerSpriteBrowserIdentity";
import {
  resolveSellerSpriteCdpEndpoint,
  resolveSellerSpriteProfileDirectory,
  type SellerSpriteCaptureEnv,
} from "@/lib/server/sellerSpriteProfileConfig";

/**
 * SellerSprite 专用浏览器「受控启动器」（服务端权威）。
 *
 * 设计约束（与项目安全边界一致）：
 * - **只服务一个固定形态**：固定 Chrome 程序（本机已安装的 Google Chrome）+ 固定专用 Profile
 *   （`SELLERSPRITE_PROFILE_DIR` 或 `<cwd>/.playwright-profile/sellersprite-v3`）+ 固定的本机调试端口
 *   （`SELLERSPRITE_CDP_ENDPOINT`，默认 9222）。**不接受**来自浏览器的程序路径、Profile 路径或命令。
 * - **不控制用户日常 Chrome**：永远携带 `--user-data-dir=<专用 Profile>` 启动；
 *   日常 Chrome 使用自己的 user-data-dir，二者互不影响。
 * - **已运行且身份为本工作台专用实例才复用**：`probeBrowserIdentityViaHttp` 判定
 *   managed→复用 / foreign→拒绝（不连接、不控制）/ unknown→拒绝（fail-closed）。
 * - **归属不明明确拒绝**：端口被占用但不是可识别的 Chrome CDP 接口 → 拒绝（不猜测、不抢占）。
 * - 该启动器只负责「把专用浏览器拉起来并确认调试端口就绪」，**不访问 SellerSprite 内容、
 *   不自动登录、不触发任何采集动作**；起始页仅打开官网首页供人工使用。
 */

export type SellerSpriteBrowserLaunchOutcome =
  | { status: "already_running"; endpoint: string; profileDir: string; readiness: SellerSpriteCdpReadiness }
  | { status: "started"; endpoint: string; profileDir: string; pid: number | null; readiness: SellerSpriteCdpReadiness }
  | { status: "rejected"; code: string; message: string; profileDir: string | null }
  | { status: "failed"; code: string; message: string; profileDir: string | null };

export type SellerSpriteBrowserLaunchDeps = {
  env?: SellerSpriteCaptureEnv;
  cwd?: string;
  spawnImpl?: typeof nodeSpawn;
  resolveBrowserImpl?: () => BrowserExecutableCandidate | null;
  readinessProbe?: (options: { endpoint: string; timeoutMs?: number }) => Promise<SellerSpriteCdpReadiness>;
  probePortImpl?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  readBrowserCommandLineImpl?: (webSocketDebuggerUrl: string, timeoutMs: number) => Promise<string[] | null>;
  sleep?: (ms: number) => Promise<void>;
};

/** 进程内启动互斥：同一时刻只允许一次启动尝试（防重复点击并发启动多个 Chrome）。 */
let launchInFlight = false;

const READY_WAIT_DEADLINE_MS = 12_000;
const READY_WAIT_STEP_MS = 250;
const EXIT_GRACE_MS = 1_200;
const PORT_PROBE_TIMEOUT_MS = 700;

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => { setTimeout(resolveWait, ms); });
}

/** 只探测端口是否有监听者；不发送任何数据。 */
export async function probeTcpPort(host: string, port: number, timeoutMs = PORT_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = netConnect({ host, port });
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * 受控启动 SellerSprite 专用可见 Chrome。
 * 返回结构化结果；调用方（受控 API 路由）负责鉴权与状态码映射。
 */
export async function launchSellerSpriteBrowser(deps: SellerSpriteBrowserLaunchDeps = {}): Promise<SellerSpriteBrowserLaunchOutcome> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const spawnImpl = deps.spawnImpl ?? nodeSpawn;
  const probe = deps.readinessProbe ?? ((options: { endpoint: string; timeoutMs?: number }) =>
    checkSellerSpriteCdpReadiness({ endpoint: options.endpoint, timeoutMs: options.timeoutMs }));
  const probePort = deps.probePortImpl ?? probeTcpPort;
  const sleep = deps.sleep ?? wait;

  // 1) 服务端配置解析（fail-closed）
  const endpoint = resolveSellerSpriteCdpEndpoint(env);
  if (!endpoint) {
    return {
      status: "rejected",
      code: "CDP_ENDPOINT_INVALID",
      message: "SellerSprite CDP 地址配置无效（仅支持本机 http 回环地址，如 http://127.0.0.1:9222）；未启动浏览器。",
      profileDir: null,
    };
  }
  let profileDir: string;
  try {
    profileDir = resolveSellerSpriteProfileDirectory(env, cwd);
  } catch {
    return {
      status: "rejected",
      code: "PROFILE_DIR_INVALID",
      message: "SELLERSPRITE_PROFILE_DIR 配置无效（必须是本机绝对路径）；未启动浏览器。",
      profileDir: null,
    };
  }

  // 2) 进程内互斥：防并发/重复启动
  if (launchInFlight) {
    return {
      status: "rejected",
      code: "LAUNCH_IN_PROGRESS",
      message: "已有一次启动请求正在处理；请等待当前请求完成后重新检测。",
      profileDir,
    };
  }
  launchInFlight = true;
  try {
    // 3) 已有实例：必须**先校验身份**再决定复用——
    //    9222 上可能是用户日常/其他工具启动的非专用 Chrome，误判 already_running
    //    会把采集链路引到非专用浏览器上（D2-1F 核实 2 修复；身份校验与采集入口共用同一机制）。
    const before = await probe({ endpoint: endpoint.origin, timeoutMs: 1_500 });
    if (before.cdpReachable) {
      const identity = await probeBrowserIdentityViaHttp(endpoint.origin, profileDir, {
        fetchImpl: deps.fetchImpl,
        readCommandLineImpl: deps.readBrowserCommandLineImpl,
      });
      if (identity === "managed") {
        return { status: "already_running", endpoint: endpoint.origin, profileDir, readiness: before };
      }
      if (identity === "foreign") {
        return {
          status: "rejected",
          code: "CDP_ENDPOINT_FOREIGN_BROWSER",
          message: `${endpoint.origin} 上已有 Chrome 在监听，但它使用的是其他 Profile（并非本工作台的专用实例）；系统不会连接、也不会控制它。请关闭该 Chrome 窗口（或调整 SELLERSPRITE_CDP_ENDPOINT）后，再点击「启动专用浏览器」。`,
          profileDir,
        };
      }
      return {
        status: "rejected",
        code: "CDP_ENDPOINT_OWNERSHIP_UNKNOWN",
        message: `${endpoint.origin} 上已有 Chrome 在监听，但无法验证它是本工作台的专用实例（该实例未开启自动化标记，或调试接口不可读）。为避免误用非专用浏览器，系统不会连接它；请关闭该实例后点击「启动专用浏览器」，由工作台以专用 Profile 重新启动。`,
        profileDir,
      };
    }

    // 4) 固定 Chrome 程序
    const browser = (deps.resolveBrowserImpl ?? resolveSystemBrowser)();
    if (!browser) {
      return {
        status: "rejected",
        code: "CHROME_NOT_FOUND",
        message: "未找到可用的 Chrome 程序（仅支持本机已安装的 Google Chrome）；未启动浏览器。",
        profileDir,
      };
    }

    // 5) 端口占用检查：被占用但不是可识别 CDP → 归属不明，拒绝
    const portOccupied = await probePort(endpoint.host, endpoint.port, PORT_PROBE_TIMEOUT_MS);
    if (portOccupied) {
      return {
        status: "rejected",
        code: "CDP_PORT_OCCUPIED",
        message: `端口 ${endpoint.port} 已被其他程序占用，但不返回可识别的 Chrome CDP 接口；请先处理占用该端口的程序，或调整 SELLERSPRITE_CDP_ENDPOINT 配置后重试。`,
        profileDir,
      };
    }

    // 6) 准备专用 Profile 目录并启动（可见窗口；固定参数，无任何外部输入）
    await mkdir(profileDir, { recursive: true });
    const args = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-address=${endpoint.host}`,
      `--remote-debugging-port=${endpoint.port}`,
      // 专用实例标记：使后续「归属校验」（Browser.getBrowserCommandLine）可读——
      // 外部普通 Chrome 通常没有该标记，因此读不到并被 fail-closed 拒绝复用。
      "--enable-automation",
      "--no-first-run",
      "--no-default-browser-check",
      "https://www.sellersprite.com/",
    ];
    let child: ChildProcess;
    try {
      child = spawnImpl(browser.executablePath, args, {
        detached: true,
        stdio: "ignore",
        // 可见窗口：用户需要在该浏览器中完成登录与人工操作。
        windowsHide: false,
      }) as ChildProcess;
    } catch (error) {
      return {
        status: "failed",
        code: "BROWSER_SPAWN_FAILED",
        message: `启动 Chrome 失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 200),
        profileDir,
      };
    }
    child.unref?.();
    const pid = Number.isSafeInteger(child.pid) ? (child.pid as number) : null;

    // 7) 等待调试端口就绪；进程提前退出（如 Profile 被另一个实例占用、启动被策略拒绝）如实报告
    let exited = false;
    if (typeof child.once === "function") {
      child.once("exit", () => { exited = true; });
    }
    for (let waited = 0; waited <= READY_WAIT_DEADLINE_MS; waited += READY_WAIT_STEP_MS) {
      const readiness = await probe({ endpoint: endpoint.origin, timeoutMs: 800 });
      if (readiness.cdpReachable) {
        return { status: "started", endpoint: endpoint.origin, profileDir, pid, readiness };
      }
      if (exited && waited >= 2_000) {
        await sleep(EXIT_GRACE_MS);
        const after = await probe({ endpoint: endpoint.origin, timeoutMs: 800 });
        if (after.cdpReachable) {
          return { status: "started", endpoint: endpoint.origin, profileDir, pid, readiness: after };
        }
        return {
          status: "failed",
          code: "BROWSER_EXITED_BEFORE_READY",
          message: "Chrome 进程已退出且调试端口未就绪：该专用 Profile 可能已被另一个 Chrome 窗口占用（请先关闭它），或启动被系统策略拒绝。",
          profileDir,
        };
      }
      await sleep(READY_WAIT_STEP_MS);
    }
    const last = await probe({ endpoint: endpoint.origin, timeoutMs: 800 });
    if (last.cdpReachable) {
      return { status: "started", endpoint: endpoint.origin, profileDir, pid, readiness: last };
    }
    return {
      status: "failed",
      code: "CDP_NOT_READY_TIMEOUT",
      message: `Chrome 已启动，但调试端口 ${endpoint.port} 在预期时间内未就绪；可在诊断详情中重新检测，或检查是否有安全软件阻止本地调试端口。`,
      profileDir,
    };
  } finally {
    launchInFlight = false;
  }
}

export type OpenSellerSpriteProfileOutcome =
  | { status: "opened"; profileDir: string }
  | { status: "rejected"; code: string; message: string };

/**
 * 在本机文件管理器中打开 SellerSprite 专用 Profile 目录（辅助入口）。
 * 仅打开服务端解析出的固定目录；目录不存在时先创建，便于用户查看登录态文件与调试。
 */
export async function openSellerSpriteProfileDirectory(
  deps: Pick<SellerSpriteBrowserLaunchDeps, "env" | "cwd" | "spawnImpl"> = {},
): Promise<OpenSellerSpriteProfileOutcome> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  let profileDir: string;
  try {
    profileDir = resolveSellerSpriteProfileDirectory(env, cwd);
  } catch {
    return { status: "rejected", code: "PROFILE_DIR_INVALID", message: "SELLERSPRITE_PROFILE_DIR 配置无效（必须是本机绝对路径）。" };
  }
  if (process.platform !== "win32") {
    return { status: "rejected", code: "PLATFORM_UNSUPPORTED", message: "当前平台不支持自动打开目录；请手动访问该 Profile 路径。" };
  }
  await mkdir(profileDir, { recursive: true });
  const explorerPath = join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe");
  const child = (deps.spawnImpl ?? nodeSpawn)(explorerPath, [profileDir], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref?.();
  return { status: "opened", profileDir };
}
