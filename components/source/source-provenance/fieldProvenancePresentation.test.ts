import { describe, expect, it } from "vitest";

import {
  describeFieldProvenanceRelation,
  fieldLabel,
  fieldReasonLabel,
  fieldStatusLabel,
  formatFieldValue,
  formatProvenanceTime,
} from "./fieldProvenancePresentation";

describe("T04 字段来源展示映射", () => {
  it("常见字段使用中文标签，未知字段保留原值", () => {
    expect(fieldLabel("bsr")).toBe("BSR 排名");
    expect(fieldLabel("reviewCount")).toBe("评论数");
    expect(fieldLabel("unknown_field")).toBe("unknown_field");
  });

  it("字段状态与原因映射为可读中文", () => {
    expect(fieldStatusLabel("observed")).toBe("已取得");
    expect(fieldStatusLabel("ambiguous")).toBe("待核对");
    expect(fieldStatusLabel("missing")).toBe("缺失");
    expect(fieldReasonLabel("conflicting_candidates")).toContain("多个候选值");
    expect(fieldReasonLabel("unknown_reason")).toContain("高级信息");
  });

  it("字段值格式化不补 0，金额对象按币种展示", () => {
    expect(formatFieldValue(null)).toBe("—");
    expect(formatFieldValue("")).toBe("—");
    expect(formatFieldValue({ amount: 14.97, currency: "USD" })).toBe("USD 14.97");
    expect(formatFieldValue(["a", "b"])).toBe("a；b");
    expect(formatFieldValue("x".repeat(130))).toContain("…");
  });

  it("字段来源关系明确历史版本不可直接读取", () => {
    const text = describeFieldProvenanceRelation({
      field: "bsr",
      evidenceId: "ev-cap-1",
      evidenceVersion: 2,
      contentHash: "a".repeat(64),
      capturedAt: "2026-10-21T17:07:22.045Z",
    });
    expect(text).toContain("版本 2");
    expect(text).toContain("历史内容");
    expect(text).toContain("不把最新模块内容");
  });

  it("时间格式化缺失时明确未知", () => {
    expect(formatProvenanceTime(null)).toBe("时间未记录");
    expect(formatProvenanceTime("not-a-date")).toBe("时间未记录");
    expect(formatProvenanceTime("2026-10-21T17:07:22.045Z")).toMatch(/2026/);
  });
});
