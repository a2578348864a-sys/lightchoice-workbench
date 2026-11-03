import net, { type Socket } from "node:net";
import { describe, expect, it } from "vitest";

import { checkAmazonCapturePreflight } from "./amazonCapturePreflight";

describe("Amazon 采集环境出口预检契约测试", () => {
  it("当网络探测返回美国出口（US）时，预检通过且状态为 US_READY", async () => {
    const result = await checkAmazonCapturePreflight({
      env: { AMAZON_CAPTURE_PROXY_URL: "http://127.0.0.1:7890" },
      probeFn: async () => ({ country: "US", countryName: "United States" }),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("US_READY");
    expect(result.exitCountry).toBe("US");
    expect(result.exitCountryName).toBe("United States");
    expect(result.proxyConfigured).toBe(true);
    expect(result.proxyProtocol).toBe("http");
    expect(result.errorCode).toBeNull();
    expect(result.message).toContain("符合 Amazon US 采集要求");
  });

  it("当网络探测返回日本出口（JP）时，预检被拦截且状态为 NON_US_EXIT（fail-closed）", async () => {
    const result = await checkAmazonCapturePreflight({
      env: { AMAZON_CAPTURE_PROXY_URL: "http://127.0.0.1:7890" },
      probeFn: async () => ({ country: "JP", countryName: "Japan" }),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("NON_US_EXIT");
    expect(result.exitCountry).toBe("JP");
    expect(result.exitCountryName).toBe("Japan");
    expect(result.errorCode).toBe("AMAZON_CAPTURE_NON_US_EXIT");
    expect(result.message).toContain("当前采集出口不是美国");
    expect(result.message).toContain("Japan / JP");
    expect(result.message).toContain("fail-closed");
    expect(result.message).toContain("请将代理节点切换为美国出口后重试");
    expect(result.message).toContain("专用浏览器会话偏好");
    expect(result.message).toContain("只有美国出口预检通过后");
    expect(result.message).toContain("一次正常校准");
    expect(result.message).not.toContain("根据出口 IP 自动");
  });

  it("当网络探测返回中国出口（CN）时，预检同样被拦截为 NON_US_EXIT", async () => {
    const result = await checkAmazonCapturePreflight({
      env: {},
      probeFn: async () => ({ country: "CN", countryName: "China" }),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("NON_US_EXIT");
    expect(result.exitCountry).toBe("CN");
    expect(result.errorCode).toBe("AMAZON_CAPTURE_NON_US_EXIT");
    expect(result.proxyConfigured).toBe(false);
    expect(result.proxyProtocol).toBeNull();
  });

  it("当网络探测超时或失败时，预检拦截为 UNKNOWN 并给出重试引导（fail-closed）", async () => {
    const result = await checkAmazonCapturePreflight({
      env: { AMAZON_CAPTURE_PROXY_URL: "http://127.0.0.1:7890" },
      probeFn: async () => null,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("UNKNOWN");
    expect(result.exitCountry).toBeNull();
    expect(result.errorCode).toBe("AMAZON_CAPTURE_PREFLIGHT_FAILED");
    expect(result.message).toContain("出口探测网络失败");
    expect(result.failureKind).toBe("PROBE_FAILED");
    expect(result.message).toContain("fail-closed");
  });

  it("当代理配置格式不合法时，预检拦截为 PROXY_INVALID", async () => {
    const result = await checkAmazonCapturePreflight({
      env: { AMAZON_CAPTURE_PROXY_URL: "not-a-valid-url" },
      probeFn: async () => ({ country: "US" }),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("PROXY_INVALID");
    expect(result.errorCode).toBe("AMAZON_CAPTURE_PROXY_INVALID");
    expect(result.message).toContain("不是合法 URL");
  });

  it("代理凭据（密码/Token）与完整 IP 绝不泄露在预检结果中", async () => {
    const result = await checkAmazonCapturePreflight({
      env: { AMAZON_CAPTURE_PROXY_URL: "http://secret_user:super_secret_pass@127.0.0.1:7890" },
      probeFn: async () => ({ country: "JP", countryName: "Japan" }),
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("super_secret_pass");
    expect(serialized).not.toContain("secret_user");
    // 确认没有暴露 IP 字段
    expect((result as Record<string, unknown>).ip).toBeUndefined();
  });

  it("预检探测器接收到的代理参数与配置严格一致", async () => {
    let capturedProxy: unknown = null;
    await checkAmazonCapturePreflight({
      env: { AMAZON_CAPTURE_PROXY_URL: "http://127.0.0.1:7890" },
      probeFn: async (proxy) => {
        capturedProxy = proxy;
        return { country: "US" };
      },
    });

    expect(capturedProxy).toEqual({ server: "http://127.0.0.1:7890" });
  });

  it("代理未配置时预检使用直连配置，不读取系统代理信息", async () => {
    let capturedProxy: unknown = "not-set";
    const result = await checkAmazonCapturePreflight({
      env: {},
      probeFn: async (proxy) => {
        capturedProxy = proxy;
        return { country: "US" };
      },
    });

    expect(result).toMatchObject({ status: "US_READY", proxyConfigured: false, failureKind: null });
    expect(capturedProxy).toBeNull();
  });

  it("备用出口探测在主探测超时后返回 US，记录两次尝试且仍通过门禁", async () => {
    const attempted: string[] = [];
    const result = await checkAmazonCapturePreflight({
      env: { AMAZON_CAPTURE_PROXY_URL: "http://127.0.0.1:7890" },
      probeAttemptFn: async (endpoint) => {
        attempted.push(endpoint);
        return endpoint === "primary"
          ? { response: null, failureKind: "PROBE_TIMEOUT" }
          : { response: { country: "US", countryName: "United States" }, failureKind: null };
      },
    });

    expect(attempted).toEqual(["primary", "fallback"]);
    expect(result).toMatchObject({ status: "US_READY", probeAttempts: 2, fallbackAttempted: true, failureKind: null });
  });

  it("两个探测都失败时保留可行动的失败类别并 fail-closed", async () => {
    const result = await checkAmazonCapturePreflight({
      env: { AMAZON_CAPTURE_PROXY_URL: "http://127.0.0.1:7890" },
      probeAttemptFn: async (endpoint) => endpoint === "primary"
        ? { response: null, failureKind: "PROBE_TIMEOUT" }
        : { response: null, failureKind: "INVALID_RESPONSE" },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "UNKNOWN",
      failureKind: "PROBE_TIMEOUT",
      probeAttempts: 2,
      fallbackAttempted: true,
    });
    expect(result.message).toContain("探测超时");
    expect(result.message).toContain("包含备用探测");
  });

  it("配置代理本地拒绝连接时归类 PROXY_UNAVAILABLE，不发送任何外部探测", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local test server did not bind a TCP port.");
    const port = address.port;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

    const result = await checkAmazonCapturePreflight({
      env: { AMAZON_CAPTURE_PROXY_URL: `http://127.0.0.1:${port}` },
      timeoutMs: 100,
    });

    expect(result).toMatchObject({ status: "UNKNOWN", failureKind: "PROXY_UNAVAILABLE", probeAttempts: 2 });
    expect(result.message).toContain("代理拒绝连接");
  });

  it("本地代理不响应 CONNECT 时分类为 PROBE_TIMEOUT，且仅尝试主备各一次", async () => {
    const sockets = new Set<Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local timeout server did not bind a TCP port.");

    try {
      const result = await checkAmazonCapturePreflight({
        env: { AMAZON_CAPTURE_PROXY_URL: `http://127.0.0.1:${address.port}` },
        timeoutMs: 60,
      });
      expect(result).toMatchObject({ status: "UNKNOWN", failureKind: "PROBE_TIMEOUT", probeAttempts: 2, fallbackAttempted: true });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
