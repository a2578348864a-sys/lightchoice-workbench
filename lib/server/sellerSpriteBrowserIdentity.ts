import { resolveSellerSpriteProfileDirectory } from "@/lib/server/sellerSpriteProfileConfig";

/**
 * SellerSprite CDP 浏览器「身份校验」共享模块（D2-1F）。
 *
 * 背景：9222 上可能是本工作台专用 Chrome、用户日常/其他工具的 Chrome（外来），
 * 或无法验证的实例。启动按钮、环境状态展示与**正式采集入口**必须使用
 * **同一套机制**判定身份，避免任何一端绕过校验把采集引到错误浏览器。
 *
 * 三类判定结果：
 * - `managed`：能读到启动参数且 `--user-data-dir` 等于本工作台专用 Profile；
 * - `foreign`：能读到启动参数但 Profile 不匹配（外部实例）；
 * - `unknown`：读不到 / 无法校验（含未开启 `--enable-automation` 的普通 Chrome、
 *   调试接口不可读、非本机回环地址等），一律按不可信处理（fail-closed）。
 *
 * 技术事实：Chrome 仅在带 `--enable-automation` 启动时才响应
 * `Browser.getBrowserCommandLine`——本工作台专用启动器固定携带该标记；
 * 外部普通 Chrome 通常读不到，因此天然落入 `unknown` 拒绝路径。
 */

export type SellerSpriteBrowserIdentity = "managed" | "foreign" | "unknown";

const LOOPBACK_WS_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEFAULT_COMMAND_LINE_TIMEOUT_MS = 2_000;

/** 规范化目录路径用于比较（分隔符 / 大小写 / 尾斜杠不敏感）。 */
export function normalizeProfileDirForCompare(value: string): string {
  return value.trim().replace(/[\\/]+$/u, "").replaceAll("\\", "/").toLocaleLowerCase("en-US");
}

/** 从浏览器启动参数中提取 `--user-data-dir`。 */
export function profileDirFromCommandLineArgs(args: readonly string[] | null): string | null {
  if (!args) return null;
  const hit = args.find((arg) => arg.startsWith("--user-data-dir="));
  return hit ? hit.slice("--user-data-dir=".length).trim() || null : null;
}

/** 由启动参数判定身份（读不到参数 → unknown）。 */
export function classifyBrowserIdentityFromCommandLineArgs(
  args: readonly string[] | null,
  expectedProfileDir: string,
): SellerSpriteBrowserIdentity {
  const actualDir = profileDirFromCommandLineArgs(args);
  if (!actualDir) return "unknown";
  return normalizeProfileDirForCompare(actualDir) === normalizeProfileDirForCompare(expectedProfileDir)
    ? "managed"
    : "foreign";
}

/**
 * 经 Node 全局 WebSocket（Node >= 21）直连 CDP，读取 `Browser.getBrowserCommandLine`。
 * 仅接受本机回环 ws 地址；读不到（如未开启 --enable-automation）返回 null。
 */
export async function readBrowserCommandLineViaWebSocket(
  webSocketDebuggerUrl: string,
  timeoutMs = DEFAULT_COMMAND_LINE_TIMEOUT_MS,
): Promise<string[] | null> {
  if (typeof WebSocket !== "function") return null;
  let parsed: URL;
  try {
    parsed = new URL(webSocketDebuggerUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ws:" || !LOOPBACK_WS_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  return new Promise((resolve) => {
    let settled = false;
    let socket: WebSocket | null = null;
    const done = (value: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* ignore */ }
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      socket = new WebSocket(webSocketDebuggerUrl);
    } catch {
      clearTimeout(timer);
      settled = true;
      resolve(null);
      return;
    }
    socket.addEventListener("open", () => {
      try { socket?.send(JSON.stringify({ id: 1, method: "Browser.getBrowserCommandLine" })); } catch { done(null); }
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { id?: unknown; result?: { arguments?: unknown } };
        if (message?.id === 1) {
          // error 响应（如未开启 --enable-automation）没有 result.arguments → null
          done(Array.isArray(message?.result?.arguments) ? (message.result.arguments as string[]).filter((a) => typeof a === "string") : null);
        }
      } catch { /* 忽略无法解析的帧 */ }
    });
    socket.addEventListener("error", () => done(null));
    socket.addEventListener("close", () => done(null));
  });
}

export type BrowserIdentityProbeDeps = {
  fetchImpl?: typeof fetch;
  readCommandLineImpl?: (webSocketDebuggerUrl: string, timeoutMs: number) => Promise<string[] | null>;
};

/**
 * 经 HTTP（/json/version）+ WebSocket 探测端点上实例的身份。
 * 用于启动器预检与环境状态展示；任何异常一律收敛为 `unknown`（fail-closed、不抛错）。
 */
export async function probeBrowserIdentityViaHttp(
  endpointOrigin: string,
  expectedProfileDir: string,
  deps: BrowserIdentityProbeDeps = {},
): Promise<SellerSpriteBrowserIdentity> {
  try {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const response = await fetchImpl(`${endpointOrigin}/json/version`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return "unknown";
    const body: unknown = await response.json();
    const wsUrl = typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).webSocketDebuggerUrl
      : null;
    if (typeof wsUrl !== "string") return "unknown";
    let parsed: URL;
    try {
      parsed = new URL(wsUrl);
    } catch {
      return "unknown";
    }
    // 只信任本机回环 ws 地址；远端地址一律不连（防引导）——对默认与注入的读取器统一执行。
    if (parsed.protocol !== "ws:" || !LOOPBACK_WS_HOSTS.has(parsed.hostname.toLowerCase())) return "unknown";
    const args = await (deps.readCommandLineImpl ?? readBrowserCommandLineViaWebSocket)(wsUrl, DEFAULT_COMMAND_LINE_TIMEOUT_MS);
    return classifyBrowserIdentityFromCommandLineArgs(args, expectedProfileDir);
  } catch {
    return "unknown";
  }
}

/** 已连接对象上的最小 CDP 会话接口（Playwright connectOverCDP 的 Browser 提供）。 */
export type ConnectedBrowserCdp = {
  newBrowserCDPSession?: () => Promise<{
    send(method: string): Promise<unknown>;
    detach?: () => Promise<void>;
  }>;
};

/**
 * 在**已连接的浏览器对象**上校验身份（D2-1F 采集入口保护）。
 *
 * 为什么在连接后校验：对象就是本次要用的那个浏览器本身——不存在
 * 「先探测 A、后连接到 B」的 TOCTOU 缝隙（核实 2 要求的"最小充分防护"）。
 * 读不到参数（外部实例通常如此）→ `unknown`，调用方必须拒绝。
 * 校验只 `detach` 本次 CDP 会话，绝不 `browser.close()`（不关闭他人浏览器）。
 */
export async function verifyConnectedBrowserIdentity(
  browser: ConnectedBrowserCdp | null | undefined,
  expectedProfileDir: string = resolveSellerSpriteProfileDirectory(),
): Promise<SellerSpriteBrowserIdentity> {
  try {
    if (!browser || typeof browser.newBrowserCDPSession !== "function") return "unknown";
    const session = await browser.newBrowserCDPSession();
    try {
      const raw: unknown = await session.send("Browser.getBrowserCommandLine");
      const args = typeof raw === "object" && raw !== null && !Array.isArray(raw)
        && Array.isArray((raw as { arguments?: unknown }).arguments)
        ? ((raw as { arguments: unknown[] }).arguments.filter((a): a is string => typeof a === "string"))
        : null;
      return classifyBrowserIdentityFromCommandLineArgs(args, expectedProfileDir);
    } catch {
      return "unknown";
    } finally {
      try { await session.detach?.(); } catch { /* 只结束本会话，不影响浏览器本体 */ }
    }
  } catch {
    return "unknown";
  }
}
