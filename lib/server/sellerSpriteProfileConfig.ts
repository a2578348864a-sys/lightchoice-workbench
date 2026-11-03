import { isAbsolute, resolve } from "node:path";

/**
 * SellerSprite 采集环境配置解析（纯函数，无 IO）。
 *
 * 职责边界：
 * - 只描述「专用 Profile 目录」与「本机 CDP 端点」两个服务端权威配置；
 * - 不接受任何来自浏览器的路径 / 命令 / 端口输入；
 * - 非法配置一律 fail-closed（抛错或返回 null），调用方负责转成明确错误。
 *
 * 一致的默认规则（与 sellerSpriteVisibleBrowser / sellerSpriteCategoryMarketCapture 历史行为对齐）：
 * - Profile：`SELLERSPRITE_PROFILE_DIR`（绝对本机路径）优先，缺省 `<cwd>/.playwright-profile/sellersprite-v3`；
 * - CDP：`SELLERSPRITE_CDP_ENDPOINT`（仅本机 http 地址）优先，缺省 `http://127.0.0.1:9222`。
 */

export const SELLERSPRITE_CDP_DEFAULT_ENDPOINT = "http://127.0.0.1:9222";
export const SELLERSPRITE_PROFILE_DIR_ENV_KEY = "SELLERSPRITE_PROFILE_DIR";
export const SELLERSPRITE_CDP_ENDPOINT_ENV_KEY = "SELLERSPRITE_CDP_ENDPOINT";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type SellerSpriteCaptureEnv = {
  SELLERSPRITE_PROFILE_DIR?: string | undefined;
  SELLERSPRITE_CDP_ENDPOINT?: string | undefined;
  [key: string]: string | undefined;
};

/**
 * 解析 SellerSprite 专用 Chrome Profile 目录（服务端权威）。
 *
 * - 未配置：与本项目其它 SellerSprite 路径一致，使用 `<cwd>/.playwright-profile/sellersprite-v3`；
 * - 已配置：必须是本机绝对路径（拒绝 UNC / 相对路径），保证「启动的浏览器」与
 *   「采集代码认为的 Profile」始终是同一个目录。
 */
export function resolveSellerSpriteProfileDirectory(
  env: SellerSpriteCaptureEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const configured = env[SELLERSPRITE_PROFILE_DIR_ENV_KEY]?.trim();
  if (!configured) return resolve(cwd, ".playwright-profile", "sellersprite-v3");
  if (!isAbsolute(configured) || configured.startsWith("\\\\") || configured.startsWith("//")) {
    throw new Error("SELLERSPRITE_PROFILE_DIR_INVALID");
  }
  return resolve(configured);
}

export type SellerSpriteCdpEndpoint = {
  /** 规范化 origin（如 http://127.0.0.1:9222），用于构造 /json/version 检查地址。 */
  origin: string;
  /** 归一化主机（仅 127.0.0.1），用于调试端口绑定与 TCP 探测。 */
  host: string;
  port: number;
};

/**
 * 解析本机 CDP 端点（服务端权威）。
 *
 * 只接受 `http://` + 回环地址（127.0.0.1 / localhost / [::1]）且不带凭据；
 * 其它输入返回 null（fail-closed），由调用方给出明确错误——绝不连接远端地址。
 */
export function resolveSellerSpriteCdpEndpoint(
  env: SellerSpriteCaptureEnv = process.env,
): SellerSpriteCdpEndpoint | null {
  const configured = env[SELLERSPRITE_CDP_ENDPOINT_ENV_KEY]?.trim() || SELLERSPRITE_CDP_DEFAULT_ENDPOINT;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return null;
  }
  if (
    url.protocol !== "http:"
    || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    || url.username.length > 0
    || url.password.length > 0
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    return null;
  }
  const port = url.port ? Number(url.port) : 80;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
  return { origin: url.origin, host: "127.0.0.1", port };
}
