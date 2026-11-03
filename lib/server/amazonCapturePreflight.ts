import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

import {
  AmazonCaptureProxy,
  AmazonCaptureProxyEnv,
  resolveAmazonCaptureNetworkConfig,
} from "./amazonCaptureBrowserConfig";

export type AmazonCapturePreflightStatus =
  | "US_READY"
  | "NON_US_EXIT"
  | "UNKNOWN"
  | "PROXY_INVALID";

export type AmazonCapturePreflightResult = {
  ok: boolean;
  status: AmazonCapturePreflightStatus;
  exitCountry: string | null;
  exitCountryName?: string | null;
  proxyConfigured: boolean;
  proxyProtocol: string | null;
  failureKind: "PROXY_INVALID" | "PROXY_UNAVAILABLE" | "PROBE_TIMEOUT" | "PROBE_FAILED" | "INVALID_RESPONSE" | null;
  probeAttempts: number;
  fallbackAttempted: boolean;
  errorCode?: "AMAZON_CAPTURE_PROXY_INVALID" | "AMAZON_CAPTURE_NON_US_EXIT" | "AMAZON_CAPTURE_PREFLIGHT_FAILED" | null;
  message: string;
  checkedAt: string;
};

export type AmazonCaptureProbeResponse = {
  country: string | null;
  countryName?: string | null;
};
type ProbeResponse = AmazonCaptureProbeResponse;

export type AmazonCaptureProbeFailureKind = "PROXY_UNAVAILABLE" | "PROBE_TIMEOUT" | "PROBE_FAILED" | "INVALID_RESPONSE";
export type AmazonCaptureProbeAttemptResult = {
  response: ProbeResponse | null;
  failureKind: AmazonCaptureProbeFailureKind | null;
};

export type AmazonCaptureProbeEndpoint = "primary" | "fallback";
export type AmazonCaptureProbeAttemptFn = (
  endpoint: AmazonCaptureProbeEndpoint,
  proxy: AmazonCaptureProxy | null,
) => Promise<AmazonCaptureProbeAttemptResult>;

function classifyNetworkError(error: unknown, proxyEndpoint: boolean): AmazonCaptureProbeFailureKind {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || (error instanceof Error && error.name === "TimeoutError")) {
    return "PROBE_TIMEOUT";
  }
  if (proxyEndpoint && ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "ECONNRESET"].includes(code ?? "")) {
    return "PROXY_UNAVAILABLE";
  }
  return "PROBE_FAILED";
}

function selectFinalFailureKind(failures: AmazonCaptureProbeFailureKind[]): AmazonCaptureProbeFailureKind {
  if (failures.includes("PROXY_UNAVAILABLE")) return "PROXY_UNAVAILABLE";
  if (failures.includes("PROBE_TIMEOUT")) return "PROBE_TIMEOUT";
  if (failures.includes("INVALID_RESPONSE")) return "INVALID_RESPONSE";
  return "PROBE_FAILED";
}

const PROBE_PRIMARY_URL = "https://api.country.is/";
const PROBE_FALLBACK_URL = "https://ipwho.is/";
const DEFAULT_TIMEOUT_MS = 5000;

function parseCountryIsPayload(data: string): ProbeResponse | null {
  try {
    const json = JSON.parse(data) as { country?: unknown };
    if (typeof json.country === "string" && json.country.trim()) {
      const country = json.country.trim().toUpperCase();
      return { country, countryName: country === "US" ? "United States" : country === "JP" ? "Japan" : country };
    }
    return null;
  } catch {
    return null;
  }
}

function parseIpWhoIsPayload(data: string): ProbeResponse | null {
  try {
    const json = JSON.parse(data) as { country_code?: unknown; country?: unknown };
    if (typeof json.country_code === "string" && json.country_code.trim()) {
      const country = json.country_code.trim().toUpperCase();
      const countryName = typeof json.country === "string" ? json.country.trim() : country;
      return { country, countryName };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 通过 HTTP/HTTPS CONNECT 隧道探测目标 HTTPS 地址。
 * 纯原生 Node.js 实现，零外部依赖，严格遵循 fail-closed 与超时断开。
 */
function probeThroughHttpProxy(
  targetUrl: string,
  proxy: AmazonCaptureProxy,
  parser: (data: string) => ProbeResponse | null,
  timeoutMs: number,
): Promise<AmazonCaptureProbeAttemptResult> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result: ProbeResponse | null, failureKind: AmazonCaptureProbeFailureKind | null = result ? null : "PROBE_FAILED") => {
      if (!resolved) {
        resolved = true;
        resolve({ response: result, failureKind });
      }
    };
    const finishParsed = (data: string) => {
      const result = parser(data);
      finish(result, result ? null : "INVALID_RESPONSE");
    };

    let proxyUrl: URL;
    let destUrl: URL;
    try {
      proxyUrl = new URL(proxy.server);
      destUrl = new URL(targetUrl);
    } catch {
      finish(null, "PROBE_FAILED");
      return;
    }

    const proxyPort = proxyUrl.port ? Number(proxyUrl.port) : proxyUrl.protocol === "https:" ? 443 : 80;
    const destPort = destUrl.port ? Number(destUrl.port) : 443;

    const connectHeaders: Record<string, string> = {
      Host: `${destUrl.hostname}:${destPort}`,
    };
    if (proxy.username) {
      const creds = Buffer.from(`${proxy.username}:${proxy.password || ""}`).toString("base64");
      connectHeaders["Proxy-Authorization"] = `Basic ${creds}`;
    }

    const connectReq = http.request({
      host: proxyUrl.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: `${destUrl.hostname}:${destPort}`,
      headers: connectHeaders,
      timeout: timeoutMs,
    });

    connectReq.setTimeout(timeoutMs, () => {
      connectReq.destroy();
      finish(null, "PROBE_TIMEOUT");
    });

    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        finish(null, "PROXY_UNAVAILABLE");
        return;
      }

      socket.setTimeout(timeoutMs, () => {
        socket.destroy();
        finish(null, "PROBE_TIMEOUT");
      });

      const tlsSocket = tls.connect({
        socket,
        servername: destUrl.hostname,
      }, () => {
        const clientReq = https.request({
          host: destUrl.hostname,
          port: destPort,
          path: destUrl.pathname + destUrl.search,
          method: "GET",
          headers: {
            Host: destUrl.hostname,
            "User-Agent": "LightChoice-Amazon-Preflight/1.0",
            Accept: "application/json",
          },
          createConnection: () => tlsSocket,
          timeout: timeoutMs,
        }, (clientRes) => {
          let body = "";
          clientRes.setEncoding("utf8");
          clientRes.on("data", (chunk: string) => { body += chunk; });
          clientRes.on("end", () => {
            finishParsed(body);
          });
        });

        clientReq.setTimeout(timeoutMs, () => {
          clientReq.destroy();
          finish(null, "PROBE_TIMEOUT");
        });
        clientReq.on("error", (error) => finish(null, classifyNetworkError(error, false)));
        clientReq.end();
      });

      tlsSocket.setTimeout(timeoutMs, () => {
        tlsSocket.destroy();
        finish(null, "PROBE_TIMEOUT");
      });
      tlsSocket.on("error", (error) => finish(null, classifyNetworkError(error, false)));
    });

    connectReq.on("error", (error) => finish(null, classifyNetworkError(error, true)));
    connectReq.end();
  });
}

/**
 * 通过 SOCKS5 代理隧道探测目标 HTTPS 地址。
 */
function probeThroughSocks5Proxy(
  targetUrl: string,
  proxy: AmazonCaptureProxy,
  parser: (data: string) => ProbeResponse | null,
  timeoutMs: number,
): Promise<AmazonCaptureProbeAttemptResult> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result: ProbeResponse | null, failureKind: AmazonCaptureProbeFailureKind | null = result ? null : "PROBE_FAILED") => {
      if (!resolved) {
        resolved = true;
        resolve({ response: result, failureKind });
      }
    };
    const finishParsed = (data: string) => {
      const result = parser(data);
      finish(result, result ? null : "INVALID_RESPONSE");
    };

    let proxyUrl: URL;
    let destUrl: URL;
    try {
      proxyUrl = new URL(proxy.server);
      destUrl = new URL(targetUrl);
    } catch {
      finish(null, "PROBE_FAILED");
      return;
    }

    const proxyPort = proxyUrl.port ? Number(proxyUrl.port) : 1080;
    const destPort = destUrl.port ? Number(destUrl.port) : 443;

    const socket = net.connect(proxyPort, proxyUrl.hostname);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      finish(null, "PROBE_TIMEOUT");
    });

    socket.on("error", (error) => finish(null, classifyNetworkError(error, true)));

    socket.on("connect", () => {
      // SOCKS5 认证协商
      const hasAuth = Boolean(proxy.username);
      const authMethods = hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
      socket.write(authMethods);

      let step = 0;
      socket.on("data", (data: Buffer) => {
        if (step === 0) {
          if (data[0] !== 0x05) {
            socket.destroy();
            finish(null, "PROXY_UNAVAILABLE");
            return;
          }
          const chosenMethod = data[1];
          if (chosenMethod === 0x00) {
            step = 2;
            sendConnect();
          } else if (chosenMethod === 0x02 && hasAuth) {
            step = 1;
            const u = Buffer.from(proxy.username || "");
            const p = Buffer.from(proxy.password || "");
            const authReq = Buffer.concat([
              Buffer.from([0x01, u.length]),
              u,
              Buffer.from([p.length]),
              p,
            ]);
            socket.write(authReq);
          } else {
            socket.destroy();
            finish(null, "PROXY_UNAVAILABLE");
          }
        } else if (step === 1) {
          if (data[1] !== 0x00) {
            socket.destroy();
            finish(null, "PROXY_UNAVAILABLE");
            return;
          }
          step = 2;
          sendConnect();
        } else if (step === 2) {
          if (data[1] !== 0x00) {
            socket.destroy();
            finish(null, "PROXY_UNAVAILABLE");
            return;
          }
          // 连接建立成功，移交 TLS
          socket.removeAllListeners("data");
          const tlsSocket = tls.connect({
            socket,
            servername: destUrl.hostname,
          }, () => {
            const clientReq = https.request({
              host: destUrl.hostname,
              port: destPort,
              path: destUrl.pathname + destUrl.search,
              method: "GET",
              headers: {
                Host: destUrl.hostname,
                "User-Agent": "LightChoice-Amazon-Preflight/1.0",
                Accept: "application/json",
              },
              createConnection: () => tlsSocket,
              timeout: timeoutMs,
            }, (clientRes) => {
              let body = "";
              clientRes.setEncoding("utf8");
              clientRes.on("data", (chunk: string) => { body += chunk; });
              clientRes.on("end", () => finishParsed(body));
            });

            clientReq.setTimeout(timeoutMs, () => {
              clientReq.destroy();
              finish(null, "PROBE_TIMEOUT");
            });
            clientReq.on("error", (error) => finish(null, classifyNetworkError(error, false)));
            clientReq.end();
          });

          tlsSocket.setTimeout(timeoutMs, () => {
            tlsSocket.destroy();
            finish(null, "PROBE_TIMEOUT");
          });
          tlsSocket.on("error", (error) => finish(null, classifyNetworkError(error, false)));
        }
      });

      function sendConnect() {
        const hostBuf = Buffer.from(destUrl.hostname);
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
          hostBuf,
          Buffer.from([destPort >> 8, destPort & 0xff]),
        ]);
        socket.write(req);
      }
    });
  });
}

/**
 * 直连网络探测（未配置代理时执行）。
 */
function probeDirect(
  targetUrl: string,
  parser: (data: string) => ProbeResponse | null,
  timeoutMs: number,
): Promise<AmazonCaptureProbeAttemptResult> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result: ProbeResponse | null, failureKind: AmazonCaptureProbeFailureKind | null = result ? null : "PROBE_FAILED") => {
      if (!resolved) {
        resolved = true;
        resolve({ response: result, failureKind });
      }
    };
    const finishParsed = (data: string) => {
      const result = parser(data);
      finish(result, result ? null : "INVALID_RESPONSE");
    };

    let destUrl: URL;
    try {
      destUrl = new URL(targetUrl);
    } catch {
      finish(null, "PROBE_FAILED");
      return;
    }

    const req = https.request({
      host: destUrl.hostname,
      port: 443,
      path: destUrl.pathname + destUrl.search,
      method: "GET",
      headers: {
        Host: destUrl.hostname,
        "User-Agent": "LightChoice-Amazon-Preflight/1.0",
        Accept: "application/json",
      },
      timeout: timeoutMs,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => finishParsed(body));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(null, "PROBE_TIMEOUT");
    });
    req.on("error", (error) => finish(null, classifyNetworkError(error, false)));
    req.end();
  });
}

async function performProbe(
  targetUrl: string,
  parser: (data: string) => ProbeResponse | null,
  proxy: AmazonCaptureProxy | null,
  timeoutMs: number,
): Promise<AmazonCaptureProbeAttemptResult> {
  if (!proxy) {
    return probeDirect(targetUrl, parser, timeoutMs);
  }
  const protocol = new URL(proxy.server).protocol;
  if (protocol === "socks5:") {
    return probeThroughSocks5Proxy(targetUrl, proxy, parser, timeoutMs);
  }
  return probeThroughHttpProxy(targetUrl, proxy, parser, timeoutMs);
}

export type AmazonCaptureProbeFn = (
  proxy: AmazonCaptureProxy | null,
) => Promise<ProbeResponse | null>;

type ProbeSequenceResult = {
  response: ProbeResponse | null;
  failureKind: AmazonCaptureProbeFailureKind | null;
  probeAttempts: number;
  fallbackAttempted: boolean;
};

function hasCountry(result: AmazonCaptureProbeAttemptResult): result is AmazonCaptureProbeAttemptResult & { response: ProbeResponse } {
  return Boolean(result.response?.country?.trim());
}

async function runProbeSequence(
  proxy: AmazonCaptureProxy | null,
  attempt: AmazonCaptureProbeAttemptFn,
): Promise<ProbeSequenceResult> {
  let primary: AmazonCaptureProbeAttemptResult;
  try {
    primary = await attempt("primary", proxy);
  } catch {
    primary = { response: null, failureKind: "PROBE_FAILED" };
  }
  if (hasCountry(primary)) {
    return { response: primary.response, failureKind: null, probeAttempts: 1, fallbackAttempted: false };
  }

  let fallback: AmazonCaptureProbeAttemptResult;
  try {
    fallback = await attempt("fallback", proxy);
  } catch {
    fallback = { response: null, failureKind: "PROBE_FAILED" };
  }
  if (hasCountry(fallback)) {
    return { response: fallback.response, failureKind: null, probeAttempts: 2, fallbackAttempted: true };
  }

  return {
    response: null,
    failureKind: selectFinalFailureKind([
      primary.failureKind ?? "INVALID_RESPONSE",
      fallback.failureKind ?? "INVALID_RESPONSE",
    ]),
    probeAttempts: 2,
    fallbackAttempted: true,
  };
}

/**
 * 默认出口探测器（主备双活探测）。
 */
export async function defaultNetworkProbe(
  proxy: AmazonCaptureProxy | null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProbeResponse | null> {
  const result = await runProbeSequence(proxy, (endpoint, currentProxy) => endpoint === "primary"
    ? performProbe(PROBE_PRIMARY_URL, parseCountryIsPayload, currentProxy, timeoutMs)
    : performProbe(PROBE_FALLBACK_URL, parseIpWhoIsPayload, currentProxy, timeoutMs));
  return result.response;
}

/**
 * 执行 Amazon 采集环境出口预检。
 *
 * 核心保障：
 * 1. 预检与 Playwright 采集共用同一操作级代理快照；未配置时两侧都强制直连；
 * 2. 任何非美出口（JP、CN、HK 等）一律判定为 NON_US_EXIT，阻断后续采集；
 * 3. 任何敏感凭据（IP、密码、Token）绝不出现在返回结果中；
 * 4. 出口预检异常一律 fail-closed，阻止进入未知网络采集。
 */
export async function checkAmazonCapturePreflight(options: {
  env?: AmazonCaptureProxyEnv;
  probeFn?: AmazonCaptureProbeFn;
  probeAttemptFn?: AmazonCaptureProbeAttemptFn;
  timeoutMs?: number;
} = {}): Promise<AmazonCapturePreflightResult> {
  const checkedAt = new Date().toISOString();
  const networkConfig = resolveAmazonCaptureNetworkConfig(options.env ?? process.env);
  const resolution = networkConfig;

  if (resolution.invalidReason) {
    return {
      ok: false,
      status: "PROXY_INVALID",
      exitCountry: null,
      proxyConfigured: true,
      proxyProtocol: null,
      failureKind: "PROXY_INVALID",
      probeAttempts: 0,
      fallbackAttempted: false,
      errorCode: "AMAZON_CAPTURE_PROXY_INVALID",
      message: resolution.invalidReason,
      checkedAt,
    };
  }

  const proxy = resolution.proxy;
  const proxyConfigured = Boolean(proxy);
  let proxyProtocol: string | null = null;
  if (proxy) {
    try {
      proxyProtocol = new URL(proxy.server).protocol.replace(":", "");
    } catch {
      proxyProtocol = null;
    }
  }

  const defaultAttempt: AmazonCaptureProbeAttemptFn = (endpoint, currentProxy) => endpoint === "primary"
    ? performProbe(PROBE_PRIMARY_URL, parseCountryIsPayload, currentProxy, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    : performProbe(PROBE_FALLBACK_URL, parseIpWhoIsPayload, currentProxy, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let sequence: ProbeSequenceResult;
  if (options.probeAttemptFn) {
    sequence = await runProbeSequence(proxy, options.probeAttemptFn);
  } else if (options.probeFn) {
    try {
      const response = await options.probeFn(proxy);
      sequence = {
        response,
        failureKind: response?.country ? null : "PROBE_FAILED",
        probeAttempts: 1,
        fallbackAttempted: false,
      };
    } catch {
      sequence = { response: null, failureKind: "PROBE_FAILED", probeAttempts: 1, fallbackAttempted: false };
    }
  } else {
    sequence = await runProbeSequence(proxy, defaultAttempt);
  }
  const probeResult = sequence.response;

  if (!probeResult || !probeResult.country) {
    const failureKind = sequence.failureKind ?? "PROBE_FAILED";
    const cause = failureKind === "PROXY_UNAVAILABLE"
      ? "配置的代理拒绝连接或无法建立隧道"
      : failureKind === "PROBE_TIMEOUT"
        ? "网络出口探测超时"
        : failureKind === "INVALID_RESPONSE"
          ? "出口探测服务没有返回有效国家码"
          : "出口探测网络失败";
    return {
      ok: false,
      status: "UNKNOWN",
      exitCountry: null,
      proxyConfigured,
      proxyProtocol,
      failureKind,
      probeAttempts: sequence.probeAttempts,
      fallbackAttempted: sequence.fallbackAttempted,
      errorCode: "AMAZON_CAPTURE_PREFLIGHT_FAILED",
      message: `${cause}，无法确认出口国家（已尝试 ${sequence.probeAttempts} 次${sequence.fallbackAttempted ? "，包含备用探测" : ""}）。为避免误采，已按 fail-closed 拦截，未启动采集浏览器。`,
      checkedAt,
    };
  }

  const exitCountry = probeResult.country;
  const exitCountryName = probeResult.countryName ?? exitCountry;

  if (exitCountry === "US") {
    return {
      ok: true,
      status: "US_READY",
      exitCountry: "US",
      exitCountryName,
      proxyConfigured,
      proxyProtocol,
      failureKind: null,
      probeAttempts: sequence.probeAttempts,
      fallbackAttempted: sequence.fallbackAttempted,
      errorCode: null,
      message: "采集出口为美国 (US)，符合 Amazon US 采集要求。",
      checkedAt,
    };
  }

  return {
    ok: false,
    status: "NON_US_EXIT",
    exitCountry,
    exitCountryName,
    proxyConfigured,
    proxyProtocol,
    failureKind: null,
    probeAttempts: sequence.probeAttempts,
    fallbackAttempted: sequence.fallbackAttempted,
    errorCode: "AMAZON_CAPTURE_NON_US_EXIT",
    message: `当前采集出口不是美国（检测到 ${exitCountryName} / ${exitCountry}）。Amazon 配送地区和币种可能同时受网络出口与专用浏览器会话偏好影响。已按 fail-closed 拦截，未启动采集浏览器。请将代理节点切换为美国出口后重试并重新检测；只有美国出口预检通过后，页面仍显示非美国配送地区时，才会进行一次正常校准。`,
    checkedAt,
  };
}
