import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./AmazonCapturePanel.tsx", import.meta.url), "utf8");

describe("AmazonCapturePanel 出口预检与环境可控性契约测试", () => {
  it("必须调用 /api/source-layer/amazon-preflight 获取出口状态", () => {
    expect(source).toContain('"/api/source-layer/amazon-preflight"');
    expect(source).toContain("checkPreflight");
  });

  it("包含重新检查按钮与 RefreshCw 交互", () => {
    expect(source).toContain("重新检查");
    expect(source).toContain("<RefreshCw");
  });

  it("打开弹窗即自动检测出口并读取真实 Session Readiness", () => {
    expect(source).toContain('"/api/source-layer/amazon-session-readiness"');
    expect(source).toContain("if (nextPreflight.status === \"US_READY\")");
    expect(source).toContain("void checkPreflight(true)");
    expect(source).toContain("onClick={() => void checkPreflight(true)}");
    expect(source).toContain('data-testid="amazon-session-readiness"');
    expect(source).toContain("Chrome/Edge 已启动");
    expect(source).toContain("sessionReadiness.errorCode ?? sessionReadiness.status");
  });

  it("区分网络/会话/授权状态，并在会话未通过时禁止提交", () => {
    expect(source).toContain("sessionReadiness.sessionReady && (mode !== \"search\"");
    expect(source).toContain('data-testid="capture-authorization-status"');
    expect(source).toContain("需登录");
    expect(source).toContain("已开放");
    expect(source).toContain("未开放");
    expect(source).toContain("登录状态");
    expect(source).toContain("signedIn");
  });

  it("当出口非美时，禁用提交并提示切换美国节点", () => {
    expect(source).toContain("preflight.status === \"US_READY\"");
    expect(source).toContain("canSubmit");
    expect(source).toContain("请切换美国节点后重新检查");
    expect(source).toContain("非美国出口");
  });

  it("展示条包含美国就绪状态和非美出口告警文案", () => {
    expect(source).toContain('networkReady ? "美国 · 已通过检查"');
    expect(source).toContain("已通过检查");
    expect(source).toContain("实际采集：");
    expect(source).toContain("当前出口非美国，采集已禁用");
    expect(source).toContain("请切换美国节点后重新检查");
    expect(source).toContain("出口通过不代表登录、配送地区、语言和页面可读性全部通过");
    expect(source).not.toContain("Amazon 会根据出口 IP 自动将配送地和价格切换为当地站点");
  });

  it("UI 代码中绝不包含明文凭据或密码/Secret/Token", () => {
    expect(source).not.toMatch(/password|secret|super_secret|proxy_auth|authorization_bearer/i);
  });
});
