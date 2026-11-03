/**
 * Amazon 采集浏览器配置（纯模块，无 IO）。
 *
 * 职责边界：
 * - 只描述「搜索 / 详情 / 评论」三条采集路径共用的浏览器启动参数；
 * - 代理与语言时区配置只在服务端解析，绝不进入客户端 bundle；
 * - 代理缺失时显式直连，避免 Playwright Chromium 隐式继承 Windows 系统代理而与 Node 预检分流。
 */

export type AmazonCaptureProxy = { server: string; username?: string; password?: string };

export type AmazonCaptureLaunchOptions = {
  headless: boolean;
  executablePath: string;
  viewport: null;
  args: string[];
  locale: string;
  timezoneId: string;
  proxy?: AmazonCaptureProxy;
};

export type AmazonCaptureProxyResolution = {
  proxy: AmazonCaptureProxy | null;
  invalidReason: string | null;
};

export type AmazonCaptureNetworkConfig = AmazonCaptureProxyResolution & {
  env: AmazonCaptureProxyEnv;
};

/** Freeze the only supported proxy setting for one readiness/capture operation. */
export function snapshotAmazonCaptureProxyEnv(
  env: AmazonCaptureProxyEnv = process.env,
): AmazonCaptureProxyEnv {
  return { [AMAZON_CAPTURE_PROXY_ENV_KEY]: env[AMAZON_CAPTURE_PROXY_ENV_KEY] };
}

/**
 * 只声明本模块真正读取的环境变量（当前仅 `AMAZON_CAPTURE_PROXY_URL`）。
 *
 * 额外保留索引签名有两个目的：
 * 1. 允许把 `process.env` 直接作为默认值传入（否则「纯可选属性」会触发 TS 弱类型检查 TS2559）；
 * 2. 允许测试注入普通对象，无需构造 `ProcessEnv`。
 * 注意：索引签名只是类型层面的兼容，运行时读取的键仍然只有下面声明的这一个。
 */
export type AmazonCaptureProxyEnv = {
  AMAZON_CAPTURE_PROXY_URL?: string | undefined;
  [key: string]: string | undefined;
};

/** 采集目标固定为 Amazon US 主站；这里的语言/时区与目标站点保持一致。 */
export const AMAZON_CAPTURE_LOCALE = "en-US";
export const AMAZON_CAPTURE_TIMEZONE_ID = "America/New_York";
export const AMAZON_CAPTURE_PROXY_ENV_KEY = "AMAZON_CAPTURE_PROXY_URL";
// HTTPS proxy transport is deliberately not advertised until the preflight
// path has a real TLS-to-proxy implementation and live verification. The
// supported paths below are the ones shared by Playwright and the native
// preflight probe today.
const ALLOWED_PROXY_PROTOCOLS = ["http:", "socks5:"] as const;

/**
 * Amazon 采集浏览器可选的独立出口代理（服务端配置，默认不启用）。
 *
 * - 只在 `AMAZON_CAPTURE_PROXY_URL` 显式配置时使用代理；未配置时 Playwright 显式带
 *   `--no-proxy-server`，让浏览器和原生 Node 预检都走直连，而不是继承 Windows WinINET 设置。
 * - 只读取服务端环境变量：不接受客户端传入、不写死用户代理、不落盘凭据、
 *   不修改 Windows 系统代理、WinHTTP、VPN 或全局网络配置。
 * - 配置存在但无法解析时返回 `invalidReason`（由调用方 fail-closed），
 *   不允许静默回退成「没配代理」——否则用户无法区分「代理没生效」与「环境本身不对」。
 */
export function resolveAmazonCaptureProxy(
  env: AmazonCaptureProxyEnv = process.env,
): AmazonCaptureProxyResolution {
  const raw = env[AMAZON_CAPTURE_PROXY_ENV_KEY]?.trim();
  if (!raw) return { proxy: null, invalidReason: null };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      proxy: null,
      invalidReason: `${AMAZON_CAPTURE_PROXY_ENV_KEY} 不是合法 URL（需要包含协议，例如 http://host:port）。`,
    };
  }
  if (!(ALLOWED_PROXY_PROTOCOLS as readonly string[]).includes(url.protocol)) {
    return {
      proxy: null,
      invalidReason: `${AMAZON_CAPTURE_PROXY_ENV_KEY} 仅支持 http / socks5 协议；https 代理尚未验证（当前为 ${url.protocol}）。`,
    };
  }
  if (!url.hostname) {
    return { proxy: null, invalidReason: `${AMAZON_CAPTURE_PROXY_ENV_KEY} 缺少主机名。` };
  }
  const proxy: AmazonCaptureProxy = { server: `${url.protocol}//${url.host}` };
  if (url.username) proxy.username = decodeURIComponent(url.username);
  if (url.password) proxy.password = decodeURIComponent(url.password);
  return { proxy, invalidReason: null };
}

export function resolveAmazonCaptureNetworkConfig(
  env: AmazonCaptureProxyEnv = process.env,
): AmazonCaptureNetworkConfig {
  const snapshot = snapshotAmazonCaptureProxyEnv(env);
  return { env: snapshot, ...resolveAmazonCaptureProxy(snapshot) };
}

/**
 * Amazon 采集浏览器专用的**唯一** context 配置入口（搜索 / 详情 / 评论三条路径共用）。
 *
 * 显式固定美国语言与时区，避免继承本机 zh-CN / Asia/Shanghai 导致 Amazon 返回
 * 本地化页面（已用真实浏览器取证：固定后 `<html lang>` 由 zh-cn 变为 en-us）。
 * 不设置 geolocation 伪造坐标：出口地区必须由真实网络决定，不伪装成美国。
 */
export function buildAmazonCaptureContextOptions(input: {
  executablePath: string;
  proxy?: AmazonCaptureProxy | null;
}): AmazonCaptureLaunchOptions {
  const args = input.proxy ? [] : ["--no-proxy-server"];
  return {
    headless: false,
    executablePath: input.executablePath,
    viewport: null,
    args,
    locale: AMAZON_CAPTURE_LOCALE,
    timezoneId: AMAZON_CAPTURE_TIMEZONE_ID,
    ...(input.proxy ? { proxy: input.proxy } : {}),
  };
}
