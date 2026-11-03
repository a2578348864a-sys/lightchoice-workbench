import { describe, expect, it } from "vitest";
import { buildV5NavGroups, modeBadgeLabel } from "./WorkspaceSidebar";

describe("侧栏导航（本地单用户）", () => {
  it("只保留 01-04 主链与辅助区，不含 Listing / 生图 / 持续监控入口", () => {
    const groups = buildV5NavGroups({ mode: "local_owner", v4Graph: false });
    expect(groups.map((group) => group.label)).toEqual([
      "工作台",
      "产品开发流程",
      "辅助区",
    ]);
    expect(groups.find((group) => group.label === "产品开发流程")?.items.map((item) => item.href)).toEqual([
      "/source",
      "/market-analysis",
      "/research",
      "/product-brief",
    ]);
    expect(groups.find((group) => group.label === "产品开发流程")?.items.map((item) => item.label)).toEqual([
      "01 市场采集",
      "02 市场研究",
      "03 商品深研",
      "04 产品开发需求单",
    ]);
    expect(groups.find((group) => group.label === "辅助区")?.items.map((item) => item.href)).toEqual([
      "/team",
      "/diagnostics",
    ]);
    const all = groups.flatMap((group) => group.items);
    expect(all.map((item) => item.href)).not.toContain("/monitoring");
    expect(all.map((item) => item.href)).not.toContain("/listing-studio");
    expect(all.map((item) => item.href)).not.toContain("/image-studio");
    expect(all.map((item) => item.label).join(",")).not.toMatch(/持续监控|Listing|商品图片|商品文案/);
  });

  it("本地导航不再出现演示门户 / 访客 / 登录入口", () => {
    const labels = buildV5NavGroups({ mode: "local_owner", v4Graph: true })
      .flatMap((group) => group.items.map((item) => item.label))
      .join(",");
    for (const banned of ["演示门户", "访客体验", "管理员", "登录", "密码"]) {
      expect(labels).not.toContain(banned);
    }
  });

  it("模式 Badge 文案：本地单用户下恒为空", () => {
    expect(modeBadgeLabel({ mode: "local_owner", v4Graph: true })).toBe("");
    expect(modeBadgeLabel({ mode: null, v4Graph: false })).toBe("");
  });
});
