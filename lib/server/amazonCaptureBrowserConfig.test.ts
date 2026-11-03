import { describe, expect, it } from "vitest";

import {
  AMAZON_CAPTURE_LOCALE,
  AMAZON_CAPTURE_PROXY_ENV_KEY,
  AMAZON_CAPTURE_TIMEZONE_ID,
  buildAmazonCaptureContextOptions,
  resolveAmazonCaptureNetworkConfig,
  resolveAmazonCaptureProxy,
  snapshotAmazonCaptureProxyEnv,
  type AmazonCaptureProxyEnv,
} from "./amazonCaptureBrowserConfig";

const env = (value: string | undefined): AmazonCaptureProxyEnv => ({ [AMAZON_CAPTURE_PROXY_ENV_KEY]: value });

describe("Amazon 采集浏览器可选美国出口代理配置", () => {
  it("未配置时完全沿用默认网络（proxy: null，且不报配置错误）", () => {
    expect(resolveAmazonCaptureProxy(env(undefined))).toEqual({ proxy: null, invalidReason: null });
    expect(resolveAmazonCaptureProxy({})).toEqual({ proxy: null, invalidReason: null });
  });

  it("每次检测和浏览器启动共用不可变的代理环境快照", () => {
    const source = env("http://127.0.0.1:7890");
    const snapshot = snapshotAmazonCaptureProxyEnv(source);
    const resolved = resolveAmazonCaptureNetworkConfig(source);
    source.AMAZON_CAPTURE_PROXY_URL = "http://127.0.0.1:9999";

    expect(snapshot.AMAZON_CAPTURE_PROXY_URL).toBe("http://127.0.0.1:7890");
    expect(resolved.env.AMAZON_CAPTURE_PROXY_URL).toBe("http://127.0.0.1:7890");
    expect(resolved.proxy).toEqual({ server: "http://127.0.0.1:7890" });
  });

  it("空串与纯空白等同于未配置", () => {
    expect(resolveAmazonCaptureProxy(env("   "))).toEqual({ proxy: null, invalidReason: null });
  });

  it("接受 http / socks5，并把账号密码从 server 中剥离", () => {
    expect(resolveAmazonCaptureProxy(env("http://127.0.0.1:8080"))).toEqual({
      proxy: { server: "http://127.0.0.1:8080" },
      invalidReason: null,
    });
    const withCredentials = resolveAmazonCaptureProxy(env("http://alice:s3cret@us-proxy.example.com:3128"));
    expect(withCredentials.invalidReason).toBeNull();
    expect(withCredentials.proxy).toEqual({
      server: "http://us-proxy.example.com:3128",
      username: "alice",
      password: "s3cret",
    });
    // 凭据绝不可以留在 server 字段里（否则会被写进启动参数/日志）。
    expect(withCredentials.proxy?.server).not.toContain("s3cret");
    expect(withCredentials.proxy?.server).not.toContain("alice");

    expect(resolveAmazonCaptureProxy(env("socks5://127.0.0.1:1080")).proxy).toEqual({ server: "socks5://127.0.0.1:1080" });
  });

  it("配置存在但不可解析时给出 invalidReason（不静默退化成未配置）", () => {
    const noScheme = resolveAmazonCaptureProxy(env("us-proxy.example.com:8080"));
    expect(noScheme.proxy).toBeNull();
    expect(noScheme.invalidReason).toContain(AMAZON_CAPTURE_PROXY_ENV_KEY);

    const badProtocol = resolveAmazonCaptureProxy(env("ftp://us-proxy.example.com:21"));
    expect(badProtocol.proxy).toBeNull();
    expect(badProtocol.invalidReason).toContain("http / socks5");
  });

  it("HTTPS proxy 在 TLS-to-proxy 未验证前必须 fail-closed 且不被宣称支持", () => {
    const httpsProxy = resolveAmazonCaptureProxy(env("https://us-proxy.example.com:8443"));
    expect(httpsProxy.proxy).toBeNull();
    expect(httpsProxy.invalidReason).toContain("https 代理尚未验证");
  });
});

describe("Amazon 采集浏览器 context 配置（唯一入口）", () => {
  it("固定美国语言与时区，不伪造 geolocation；未配置代理时明确绕过隐式系统代理", () => {
    const options = buildAmazonCaptureContextOptions({ executablePath: "C:/chrome.exe", proxy: null });
    expect(options).toEqual({
      headless: false,
      executablePath: "C:/chrome.exe",
      viewport: null,
      args: ["--no-proxy-server"],
      locale: AMAZON_CAPTURE_LOCALE,
      timezoneId: AMAZON_CAPTURE_TIMEZONE_ID,
    });
    expect(options.locale).toBe("en-US");
    expect(options.timezoneId).toBe("America/New_York");
    // 出口地区必须由真实网络决定；不通过 geolocation 伪装美国坐标。
    expect(options).not.toHaveProperty("geolocation");
    expect(options).not.toHaveProperty("proxy");
    expect(options.args).toContain("--no-proxy-server");
  });

  it("配置了美国出口代理时只透传服务器解析出的代理对象", () => {
    const options = buildAmazonCaptureContextOptions({
      executablePath: "C:/chrome.exe",
      proxy: { server: "http://us-proxy.example.com:3128" },
    });
    expect(options.proxy).toEqual({ server: "http://us-proxy.example.com:3128" });
    expect(options.args).not.toContain("--no-proxy-server");
    expect(options.locale).toBe("en-US");
  });
});
