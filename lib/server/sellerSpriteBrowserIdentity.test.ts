import { describe, expect, it, vi } from "vitest";

import {
  classifyBrowserIdentityFromCommandLineArgs,
  normalizeProfileDirForCompare,
  profileDirFromCommandLineArgs,
  probeBrowserIdentityViaHttp,
  readBrowserCommandLineViaWebSocket,
  verifyConnectedBrowserIdentity,
} from "./sellerSpriteBrowserIdentity";

const EXPECTED = "D:/workspace/.playwright-profile/sellersprite-v3";

describe("classifyBrowserIdentityFromCommandLineArgs", () => {
  it("启动参数匹配专用 Profile → managed（分隔符/大小写/尾斜杠不敏感）", () => {
    expect(classifyBrowserIdentityFromCommandLineArgs(
      ["--enable-automation", "--user-data-dir=D:\\workspace\\.playwright-profile\\sellersprite-v3\\"],
      EXPECTED,
    )).toBe("managed");
    expect(normalizeProfileDirForCompare("D:\\A\\B\\")).toBe("d:/a/b");
  });

  it("能读到参数但 Profile 不匹配 → foreign（外部实例）", () => {
    expect(classifyBrowserIdentityFromCommandLineArgs(
      ["--user-data-dir=D:/other/daily-chrome"],
      EXPECTED,
    )).toBe("foreign");
  });

  it("读不到参数 / 无 --user-data-dir → unknown（fail-closed）", () => {
    expect(classifyBrowserIdentityFromCommandLineArgs(null, EXPECTED)).toBe("unknown");
    expect(classifyBrowserIdentityFromCommandLineArgs([], EXPECTED)).toBe("unknown");
    expect(classifyBrowserIdentityFromCommandLineArgs(["--no-first-run"], EXPECTED)).toBe("unknown");
    expect(profileDirFromCommandLineArgs(null)).toBeNull();
  });
});

describe("readBrowserCommandLineViaWebSocket（本机回环约束）", () => {
  it("非本机（或非 ws 协议）地址一律拒绝，不建立连接", async () => {
    expect(await readBrowserCommandLineViaWebSocket("ws://evil.example.com:9222/devtools/browser/x", 300)).toBeNull();
    expect(await readBrowserCommandLineViaWebSocket("http://127.0.0.1:9222/json/version", 300)).toBeNull();
    expect(await readBrowserCommandLineViaWebSocket("not a url", 300)).toBeNull();
  });
});

describe("verifyConnectedBrowserIdentity（采集入口：在同一连接对象上校验）", () => {
  const sessionFor = (args: unknown, options: { sendThrows?: boolean } = {}) => ({
    send: options.sendThrows
      ? vi.fn(async () => { throw Object.assign(new Error("Command line not returned because --enable-automation not set.")); })
      : vi.fn(async () => ({ arguments: args })),
    detach: vi.fn(async () => undefined),
  });

  it("会话读到匹配的 --user-data-dir → managed，并只 detach 本会话", async () => {
    const session = sessionFor([`--user-data-dir=${EXPECTED}`, "--enable-automation"]);
    const browser = { newBrowserCDPSession: vi.fn(async () => session) };
    await expect(verifyConnectedBrowserIdentity(browser, EXPECTED)).resolves.toBe("managed");
    expect(session.detach).toHaveBeenCalledTimes(1);
  });

  it("读到参数但 Profile 不匹配 → foreign", async () => {
    const browser = { newBrowserCDPSession: async () => sessionFor(["--user-data-dir=D:/other/profile"]) };
    await expect(verifyConnectedBrowserIdentity(browser, EXPECTED)).resolves.toBe("foreign");
  });

  it("send 抛错（外部实例无自动化标记）→ unknown", async () => {
    const browser = { newBrowserCDPSession: async () => sessionFor(null, { sendThrows: true }) };
    await expect(verifyConnectedBrowserIdentity(browser, EXPECTED)).resolves.toBe("unknown");
  });

  it("缺少会话能力 / 会话建立失败 / 返回结构异常 → unknown（不抛错）", async () => {
    await expect(verifyConnectedBrowserIdentity(null, EXPECTED)).resolves.toBe("unknown");
    await expect(verifyConnectedBrowserIdentity({}, EXPECTED)).resolves.toBe("unknown");
    const failing = { newBrowserCDPSession: async () => { throw new Error("cdp closed"); } };
    await expect(verifyConnectedBrowserIdentity(failing, EXPECTED)).resolves.toBe("unknown");
    const malformed = { newBrowserCDPSession: async () => sessionFor("not-an-array") };
    await expect(verifyConnectedBrowserIdentity(malformed, EXPECTED)).resolves.toBe("unknown");
  });

  it("detach 失败不影响判定结果", async () => {
    const session = sessionFor([`--user-data-dir=${EXPECTED}`]);
    session.detach = vi.fn(async () => { throw new Error("already detached"); });
    const browser = { newBrowserCDPSession: async () => session };
    await expect(verifyConnectedBrowserIdentity(browser, EXPECTED)).resolves.toBe("managed");
  });
});

describe("probeBrowserIdentityViaHttp（启动器/环境状态复用同一机制）", () => {
  it("仅连接本机回环 ws；远端 ws 地址不被信任 → unknown", async () => {
    const readImpl = vi.fn(async () => [`--user-data-dir=${EXPECTED}`]);
    const result = await probeBrowserIdentityViaHttp("http://127.0.0.1:9222", EXPECTED, {
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: "ws://evil.example.com:9/x" }),
      })) as unknown as typeof fetch,
      readCommandLineImpl: readImpl,
    });
    expect(result).toBe("unknown");
    expect(readImpl).not.toHaveBeenCalled();
  });

  it("探测任何异常都收敛为 unknown（不抛错）", async () => {
    const result = await probeBrowserIdentityViaHttp("http://127.0.0.1:9222", EXPECTED, {
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    expect(result).toBe("unknown");
  });
});
