import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/**
 * D2-1F 合同：采集环境一键启动体验。
 * - 启动只由用户点击触发（页面自动检测必须保持只读）；
 * - 请求不带任何参数（命令 / 路径 / 端口全部由服务端配置解析）；
 * - Amazon 采集是独立通道：CDP 连通不得显示为 Amazon 就绪；
 * - 固定专用 Profile 启动，不控制用户日常 Chrome。
 */
describe("采集环境一键启动（D2-1F 合同）", () => {
  const card = source("components/source/CaptureEnvironmentStatusCard.tsx");
  const launcher = source("lib/server/sellerSpriteBrowserLauncher.ts");
  const config = source("lib/server/sellerSpriteProfileConfig.ts");
  const identity = source("lib/server/sellerSpriteBrowserIdentity.ts");
  const categoryCapture = source("lib/server/sellerSpriteCategoryMarketCapture.ts");
  const visibleQuery = source("lib/server/sellerSpriteVisibleQuery.ts");
  const environmentRoute = source("app/api/source-layer/capture-environment/route.ts");

  it("提供「启动专用浏览器」入口并走受控 POST（无请求参数）", () => {
    expect(card).toContain('data-testid="capture-environment-launch-sellersprite"');
    expect(card).toContain("/api/source-layer/capture-environment/launch-sellersprite-browser");
    expect(card).toContain("启动专用浏览器");
    // POST 请求不携带 body：前端无法传入命令/路径
    const callIndex = card.indexOf("launch-sellersprite-browser");
    const callBlock = card.slice(callIndex, callIndex + 320);
    expect(callBlock).not.toContain("body:");
  });

  it("启动只由用户点击触发：挂载时的 useEffect 只做只读检测", () => {
    const effectStart = card.indexOf("useEffect(() => {");
    const effectBlock = card.slice(effectStart, effectStart + 200);
    expect(effectBlock).toContain("checkReadiness");
    expect(effectBlock).not.toContain("launchSellerspriteBrowser");
  });

  it("承诺不控制日常 Chrome，并说明固定专用 Profile", () => {
    expect(card).toContain("不会控制或影响你日常使用的 Chrome 窗口");
    expect(card).toContain("sellersprite-v3");
    expect(card).toContain('data-testid="capture-environment-open-profile"');
  });

  it("Amazon 采集独立状态与恢复指引：CDP 连通不得显示为 Amazon 就绪", () => {
    expect(card).toContain('data-testid="capture-environment-amazon-badge"');
    expect(card).toContain('data-testid="capture-environment-amazon-recovery"');
    expect(card).toContain("CDP 可达不等于 Amazon 采集已就绪");
    expect(card).toContain("LOCAL_ACQUISITION_ENABLED=true");
  });

  it("服务端启动器：固定程序与 Profile、无 headless、不做任何采集动作", () => {
    expect(launcher).toContain("resolveSellerSpriteProfileDirectory");
    expect(launcher).toContain("resolveSystemBrowser");
    expect(launcher).toContain("--user-data-dir=");
    expect(launcher).toContain("--remote-debugging-port=");
    expect(launcher).not.toContain("--headless");
    expect(launcher).not.toContain("connectOverCDP");
    expect(launcher).not.toMatch(/page\.goto|\.click\(/u);
  });

  it("D2-1F-核实2）实例归属校验：防把日常 Chrome 误判为专用实例复用", () => {
    // 专用启动带自动化标记（归属校验可读）；外部实例读不到 → fail-closed 拒绝
    expect(launcher).toContain("--enable-automation");
    expect(launcher).toContain("probeBrowserIdentityViaHttp");
    expect(launcher).toContain("CDP_ENDPOINT_FOREIGN_BROWSER");
    expect(launcher).toContain("CDP_ENDPOINT_OWNERSHIP_UNKNOWN");
    // CDP 可达时按钮仍保留归属校验入口（渲染条件不依赖 !ready）
    expect(card).toContain("复用专用浏览器");
    expect(card).toContain("校验它是否为本工作台专用实例");
  });

  it("D2-1F 收尾）正式采集入口复用同一身份校验：不建第二套机制、对身份拒绝 fail-closed", () => {
    // 共享模块承载"读启动参数 → 分类身份"的唯一实现
    expect(identity).toContain("Browser.getBrowserCommandLine");
    expect(identity).toContain("verifyConnectedBrowserIdentity");
    expect(identity).toContain("classifyBrowserIdentityFromCommandLineArgs");
    // 两个正式采集入口都在连接后、创建页面前校验身份（拒绝时不得创建页面）
    expect(categoryCapture).toContain("verifyConnectedBrowserIdentity");
    expect(categoryCapture).toContain("seller_sprite_browser_identity_mismatch");
    expect(categoryCapture).toContain("seller_sprite_browser_identity_unverified");
    expect(visibleQuery).toContain("verifyConnectedBrowserIdentity");
    expect(visibleQuery).toContain("SELLERSPRITE_BROWSER_IDENTITY_MISMATCH");
    expect(visibleQuery).toContain("SELLERSPRITE_BROWSER_IDENTITY_UNVERIFIED");
    // 「拒绝路径绝不关闭对方浏览器」由运行级测试断言（browserClose 未被调用），此处不重复源码文本断言。
  });

  it("D2-1F 收尾）环境状态三态分离：CDP 可达 / 实例身份 / 登录未验证", () => {
    expect(environmentRoute).toContain("browserIdentity");
    expect(card).toContain('data-testid="capture-environment-browser-identity"');
    expect(card).toContain('data-testid="capture-environment-identity-note"');
    expect(card).toContain('data-testid="capture-environment-login-status"');
    expect(card).toContain("SellerSprite 登录状态：尚未验证");
    expect(card).toContain("专用实例");
    expect(card).toContain("非专用实例");
    expect(card).toContain("身份未验证");
  });

  it("Profile 与端点解析集中在服务端配置模块（fail-closed）", () => {
    expect(config).toContain("SELLERSPRITE_PROFILE_DIR_INVALID");
    expect(config).toContain("SELLERSPRITE_CDP_DEFAULT_ENDPOINT");
    expect(config).toContain("LOOPBACK_HOSTS");
  });
});
