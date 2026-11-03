import type { CaptureRuntimeSummary } from "@/scripts/ops/capture-runtime-config.mjs";

export type SellerSpriteCdpReadinessStatus = "ready" | "unavailable" | "misconfigured";

export type SellerSpriteCdpReadiness = {
  status: SellerSpriteCdpReadinessStatus;
  cdpReachable: boolean;
  errorCode: "CDP_ENDPOINT_INVALID" | "CDP_UNREACHABLE" | "CDP_HTTP_ERROR" | "CDP_INVALID_RESPONSE" | null;
  checkedAt: string;
  latencyMs: number | null;
  message: string;
  nextAction: string;
  amazon?: CaptureRuntimeSummary;
};

type ReadinessOptions = {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
};

const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";
const CDP_TIMEOUT_MS = 1_500;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function makeResult(input: Omit<SellerSpriteCdpReadiness, "checkedAt">, now: () => Date): SellerSpriteCdpReadiness {
  return { ...input, checkedAt: now().toISOString() };
}

function resolveCdpVersionUrl(endpointValue: string | undefined): URL | null {
  const configured = endpointValue?.trim() || DEFAULT_CDP_ENDPOINT;
  let endpoint: URL;
  try {
    endpoint = new URL(configured);
  } catch {
    return null;
  }

  if (
    endpoint.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(endpoint.hostname.toLowerCase()) ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0
  ) {
    return null;
  }

  return new URL("/json/version", endpoint.origin);
}

/**
 * Read-only check for the local SellerSprite CDP HTTP endpoint.
 * It only requests /json/version and never launches or attaches to a browser.
 */
export async function checkSellerSpriteCdpReadiness(options: ReadinessOptions = {}): Promise<SellerSpriteCdpReadiness> {
  const now = options.now ?? (() => new Date());
  const endpointValue = options.endpoint ?? process.env.SELLERSPRITE_CDP_ENDPOINT;
  const versionUrl = resolveCdpVersionUrl(endpointValue);

  if (!versionUrl) {
    return makeResult({
      status: "misconfigured",
      cdpReachable: false,
      errorCode: "CDP_ENDPOINT_INVALID",
      latencyMs: null,
      message: "SellerSprite CDP 地址配置无效；未发起连接。",
      nextAction: "将 SELLERSPRITE_CDP_ENDPOINT 配置为本机 Chrome 调试地址后重新检测。",
    }, now);
  }

  const startedAt = Date.now();
  try {
    const response = await (options.fetchImpl ?? fetch)(versionUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? CDP_TIMEOUT_MS),
    });

    if (!response.ok) {
      return makeResult({
        status: "unavailable",
        cdpReachable: false,
        errorCode: "CDP_HTTP_ERROR",
        latencyMs: Math.max(0, Date.now() - startedAt),
        message: "本机 CDP 接口已响应，但返回状态异常。",
        nextAction: "确认 CDP 地址和端口与启动中的 Chrome 一致，然后重新检测。",
      }, now);
    }

    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>).Browser !== "string" ||
      !(body as Record<string, unknown>).Browser
    ) {
      return makeResult({
        status: "unavailable",
        cdpReachable: false,
        errorCode: "CDP_INVALID_RESPONSE",
        latencyMs: Math.max(0, Date.now() - startedAt),
        message: "检测地址有响应，但不是可识别的 Chrome CDP 接口。",
        nextAction: "确认 SELLERSPRITE_CDP_ENDPOINT 指向 Chrome 的 /json/version 服务，然后重新检测。",
      }, now);
    }

    return makeResult({
      status: "ready",
      cdpReachable: true,
      errorCode: null,
      latencyMs: Math.max(0, Date.now() - startedAt),
      message: "本机 SellerSprite CDP 接口可达。",
      nextAction: "此结果只确认 CDP 连通，不验证 SellerSprite/Amazon 登录状态或页面内容。",
    }, now);
  } catch {
    return makeResult({
      status: "unavailable",
      cdpReachable: false,
      errorCode: "CDP_UNREACHABLE",
      latencyMs: Math.max(0, Date.now() - startedAt),
      message: "未能连接本机 SellerSprite CDP 接口。",
      nextAction: "启动使用本机调试端口的 Chrome；未配置自定义地址时默认端口为 9222，然后重新检测。",
    }, now);
  }
}
