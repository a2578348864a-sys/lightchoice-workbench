import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResearchExportBatchPanel, describePreflightGap } from "./ResearchExportBatchPanel";
import type { LarkPreflightResult } from "@/lib/integrations/lark/types";

describe("ResearchExportBatchPanel", () => {
  it("静态渲染默认面板结构", () => {
    const html = renderToStaticMarkup(createElement(ResearchExportBatchPanel));

    expect(html).toContain("研究批量导出 V1");
    expect(html).toContain("批量导出与多维表格同步");
    expect(html).toContain("lark-preflight-banner");
    expect(html).toContain("research-export-batch-refresh");
  });

  const basePreflight: LarkPreflightResult = {
    configured: true,
    connected: true,
    baseAccessible: true,
    tableAccessible: true,
    writable: false,
    missingFields: [],
    missingWriteFields: [],
    missingOptionalFields: [],
    incompatibleFields: [],
    fieldMapping: {},
  };

  describe("describePreflightGap（不得静默写入字段缺失）", () => {
    it("缺必须字段时标题指向必须字段并列出清单", () => {
      const gap = describePreflightGap({ ...basePreflight, missingFields: ["ASIN"], missingWriteFields: ["ASIN"] });
      expect(gap.title).toContain("缺少必须字段");
      expect(gap.detail).toContain("缺少必须字段：ASIN");
    });

    it("必须字段齐全但缺写入字段时，缺口仍被显式暴露", () => {
      const gap = describePreflightGap({
        ...basePreflight,
        missingFields: [],
        missingWriteFields: ["预估月销量"],
        missingOptionalFields: ["预估月销量"],
      });
      expect(gap.title).toContain("缺少写入字段");
      expect(gap.detail).toContain("缺少写入字段：预估月销量");
    });

    it("类型不兼容时输出精确字段名与类型对照", () => {
      const gap = describePreflightGap({
        ...basePreflight,
        incompatibleFields: [{ fieldName: "BSR", expectedType: "2", actualType: "1 (Text)" }],
      });
      expect(gap.title).toContain("字段类型不兼容");
      expect(gap.detail).toContain("BSR");
      expect(gap.detail).toContain("1 (Text) → 2");
    });
  });
});
