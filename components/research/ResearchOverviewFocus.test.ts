import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResearchOverviewFocus, type ResearchOverviewFocusProps } from "./ResearchOverviewFocus";

const base: ResearchOverviewFocusProps = {
  title: "Silicone Baking Mat",
  asin: "B0TEST0001",
  marketplace: "US",
  imageUrl: null,
  brand: "TestBrand",
  category: "Baking Mats",
  price: 12.99,
  currency: "USD",
  rating: 4.4,
  reviewCount: 1280,
  marketSource: {
    scanId: "cmvfixture0001",
    sampleKey: "cmvfixture0001:B0TEST0001",
    role: "benchmark",
    note: "基准款，价格带中位",
    sampleHash: "abcdef0123456789abcdef",
  },
  researchRevision: 3,
  reportState: "valid",
  decision: { label: "继续推进", reason: "证据基本齐全", stale: false },
  question: "你已记录「继续推进」；本页核对支撑这项判断的证据是否仍然成立。",
  finding: "同价位段中，清洗困难是最集中的负面反馈。",
  findingSource: "来自当前已保存研报",
  unknown: "耐高温寿命只有单条评论提到。",
  unknownSource: "来自 VOC 快照",
  missing: ["供应商报价未提供"],
  coverage: { facts: 6, reviews: 42, themes: 3, risk: "1 项提醒" },
  primary: { label: "查看需求单", href: "/product-brief?taskId=t1" },
  onOpenMaterial: () => {},
  onOpenDecision: () => {},
};

describe("ResearchOverviewFocus 诚实呈现", () => {
  it("受限报告首屏展示采信限制，不把历史观点突出为关键发现或报告有效", () => {
    const html = renderToStaticMarkup(createElement(ResearchOverviewFocus, {
      ...base,
      finding: "这是已验证、可被营销放大的核心卖点。",
      consumptionNotice: "研报存在超过证据强度的结论，原文保留，请补证后重新审查。",
    }));
    expect(html).toContain("报告暂停采信");
    expect(html).toContain("请补证后重新审查");
    expect(html).toContain("原文保留在研报区");
    expect(html).not.toContain("可被营销放大的核心卖点");
    expect(html).not.toContain("关键发现");
    expect(html).not.toContain("报告有效");
  });
  it("有报告与有效决定时展示商品、版本与主行动", () => {
    const html = renderToStaticMarkup(createElement(ResearchOverviewFocus, base));
    expect(html).toContain("Silicone Baking Mat");
    expect(html).toContain("B0TEST0001");
    expect(html).toContain("基准商品");
    expect(html).toContain("rev.3");
    expect(html).toContain("报告有效");
    expect(html).toContain("继续推进");
    expect(html).toContain("查看需求单");
    expect(html).toContain("1 项提醒");
    expect(html).not.toContain("历史：");
  });

  it("来源失效时把决定标为历史并要求重新确认，不冒充当前结论", () => {
    const html = renderToStaticMarkup(createElement(ResearchOverviewFocus, {
      ...base,
      reportState: "stale",
      decision: { label: "继续推进", reason: null, stale: true },
      primary: { label: "更新研报后重新确认", onClick: () => {} },
    }));
    expect(html).toContain("历史：继续推进");
    expect(html).toContain("不再作为当前有效结论");
    expect(html).toContain("更新研报后重新确认");
    expect(html).not.toContain("查看需求单");
  });

  it("没有正式研报时不摆出推测结论，覆盖读数保持未知", () => {
    const html = renderToStaticMarkup(createElement(ResearchOverviewFocus, {
      ...base,
      researchRevision: null,
      reportState: "missing",
      decision: null,
      finding: null,
      findingSource: null,
      unknown: null,
      unknownSource: null,
      coverage: { facts: 2, reviews: null, themes: 0, risk: null },
      primary: { label: "查看研报与生成入口", onClick: () => {} },
    }));
    expect(html).toContain("尚无正式研报");
    expect(html).toContain("不展示推测结论");
    expect(html).toContain("尚未决定");
    expect(html).toContain("未评估");
    expect(html).toContain("未记录可读数");
    expect(html).not.toContain("查看需求单");
  });
});
