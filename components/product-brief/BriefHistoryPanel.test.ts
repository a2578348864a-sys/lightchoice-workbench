import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PRODUCT_BRIEF_SCHEMA, type ProductBrief } from "@/lib/productBrief/contract";
import { BriefHistoryPanel, BriefHistorySnapshot } from "./BriefHistoryPanel";

function brief(revision: number, label: string): ProductBrief {
  return {
    schemaVersion: PRODUCT_BRIEF_SCHEMA,
    status: "READY",
    revision,
    generatedAt: "2026-10-28T00:00:00.000Z",
    sourceBinding: { taskId: "fixture-task", researchRevision: 2, reportHash: "report", factHash: "fact", evidenceHash: "evidence", marketScanId: null, marketSampleHash: null },
    identity: { asin: "B000000001", title: "测试水杯", imageUrl: null, brand: null, category: null, marketplace: "US" },
    projectOverview: null,
    targetUser: null,
    corePainPoints: [],
    benchmarks: [],
    differentiation: [],
    economics: {
      targetPrice: 20,
      targetMarginPct: null,
      referralFee: null,
      fbaFee: null,
      logistics: null,
      estimatedTax: null,
      otherKnownCosts: null,
      currency: "USD",
      purchaseCostCeiling: { status: "NOT_COMPUTABLE", value: null, currency: "USD", formula: "目标售价 - 已知费用", reason: "需要补齐输入" },
    },
    specsDirection: [],
    specifications: [{ id: "spec-1", label, value: "1.2", unit: "mm", nature: "ASSUMPTION", verification: "unverified", evidenceRefs: [] }],
    vocQaRedlines: [],
    risks: [],
    rationale: [],
    missingValidation: [],
  };
}

describe("需求单历史版本", () => {
  it("为每个已保存版本提供可访问的查看入口", () => {
    const html = renderToStaticMarkup(createElement(BriefHistoryPanel, {
      history: [brief(1, "旧厚度"), brief(2, "原厚度")],
      current: brief(3, "新厚度"),
    }));
    expect(html).toContain("查看第 1 版");
    expect(html).toContain("查看第 2 版");
    expect(html).toContain("历史版本（2）");
  });

  it("回看旧版内容并说明与当前保存版本的可编辑章节差异，不提供编辑控件", () => {
    const html = renderToStaticMarkup(createElement(BriefHistorySnapshot, {
      version: brief(2, "原厚度"),
      current: brief(3, "新厚度"),
    }));
    expect(html).toContain("历史版本 · 只读");
    expect(html).toContain("与当前已保存的第 3 版比较");
    expect(html).toContain("产品方案");
    expect(html).toContain("原厚度：1.2 mm");
    expect(html).toContain("待确认假设");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<select");
  });

  it("历史正文包含分隔线时仍完整显示正文和来源", () => {
    const old = brief(2, "原厚度");
    const oldSpec = old.specifications?.[0];
    if (!oldSpec) throw new Error("测试规格缺失");
    const html = renderToStaticMarkup(createElement(BriefHistorySnapshot, {
      version: { ...old, specifications: [{ ...oldSpec, value: "第一行\n---\n第二行" }] },
      current: brief(3, "新厚度"),
    }));
    expect(html).toContain("第二行");
    expect(html).toContain("历史来源与版本标识");
    expect(html).toContain("reportHash=report");
  });
});
