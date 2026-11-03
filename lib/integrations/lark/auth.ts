import "server-only";

import { defaultLarkFetch } from "./transport";
import type { LarkConfig } from "./types";

type CachedToken = {
  readonly token: string;
  readonly expiresAtMs: number;
};

let cachedToken: CachedToken | null = null;

export class LarkAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 401,
  ) {
    super(message);
    this.name = "LarkAuthError";
  }
}

/**
 * 提前 5 分钟刷新 Token，避免在边界时间发生请求时 Token 失效。
 */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export async function getTenantAccessToken(
  config: LarkConfig,
  options: {
    forceRefresh?: boolean;
    fetcher?: typeof fetch;
    nowMs?: number;
  } = {},
): Promise<string> {
  const fetcher = options.fetcher ?? defaultLarkFetch;
  const now = options.nowMs ?? Date.now();

  if (
    !options.forceRefresh
    && cachedToken
    && cachedToken.expiresAtMs - now > TOKEN_EXPIRY_BUFFER_MS
  ) {
    return cachedToken.token;
  }

  const endpoint = `${config.openApiDomain}/open-apis/auth/v3/tenant_access_token/internal`;

  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        app_id: config.appId,
        app_secret: config.appSecret,
      }),
    });
  } catch (error) {
    throw new LarkAuthError(
      "lark_auth_network_error",
      `飞书鉴权网络请求失败: ${error instanceof Error ? error.message : "网络不可用"}`,
      502,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new LarkAuthError(
      "lark_auth_invalid_response",
      "飞书鉴权接口返回了非法的 JSON 载荷。",
      502,
    );
  }

  if (
    typeof payload !== "object"
    || payload === null
    || typeof (payload as { code?: unknown }).code !== "number"
  ) {
    throw new LarkAuthError(
      "lark_auth_malformed_response",
      "飞书鉴权接口返回结构不符合开放平台规范。",
      502,
    );
  }

  const data = payload as {
    code: number;
    msg?: string;
    tenant_access_token?: string;
    expire?: number;
  };

  if (data.code !== 0 || !data.tenant_access_token) {
    const errorMsg = data.msg || "未知飞书鉴权错误";
    throw new LarkAuthError(
      `lark_auth_failed_${data.code}`,
      `飞书鉴权失败 (${data.code}): ${errorMsg}`,
      response.status >= 400 ? response.status : 401,
    );
  }

  const expireSeconds = typeof data.expire === "number" && data.expire > 0 ? data.expire : 7200;
  cachedToken = {
    token: data.tenant_access_token,
    expiresAtMs: now + expireSeconds * 1000,
  };

  return cachedToken.token;
}

export function clearCachedLarkToken(): void {
  cachedToken = null;
}
