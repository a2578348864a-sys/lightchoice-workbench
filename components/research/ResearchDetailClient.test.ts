import { describe, expect, it } from "vitest";

import { shouldDisableFeishuSync } from "@/components/research/ResearchDetailClient";

describe("飞书同步按钮前置禁用", () => {
  it("服务端明确飞书未配置时禁用，即使有正式报告且不忙", () => {
    expect(shouldDisableFeishuSync({ busy: false, hasFormalReport: true, feishuConfigured: false })).toBe(true);
  });

  it("飞书已配置且条件满足时保持可用", () => {
    expect(shouldDisableFeishuSync({ busy: false, hasFormalReport: true, feishuConfigured: true })).toBe(false);
  });

  it("旧响应缺失 feishuConfigured 时不额外禁用，保留既有 busy/report 门禁", () => {
    expect(shouldDisableFeishuSync({ busy: false, hasFormalReport: true })).toBe(false);
    expect(shouldDisableFeishuSync({ busy: true, hasFormalReport: true, feishuConfigured: true })).toBe(true);
    expect(shouldDisableFeishuSync({ busy: false, hasFormalReport: false, feishuConfigured: true })).toBe(true);
  });
});
