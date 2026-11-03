import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImprovementPlanCard } from "./ImprovementPlanCard";
import { buildImprovementPlan } from "@/lib/research/improvementPlan";

/**
 * 用 #5 真实研报（B0CFTP6JR4，DeepSeek 原始输出）里的三条原因原文做渲染断言。
 * 这条真实报告同时暴露了两个问题，正好锁死：
 *  - 第 1、2 条讨论的是「子类头部位置 / 同父体变体流量」，不是产品工程问题；
 *  - 第 3 条才是真正的产品假设（硅胶表面 + 垫体过软）。
 */
const CASE5_CAUSES = [
  {
    hypothesis: "多尺寸 3 件装组合 + 可重复使用叙事降低了替代一次性烘焙纸的门槛，支撑其子类头部位置。",
    rationale: "组合装与可重复使用同时出现在多条评论里。",
    supportingEvidence: ["评论提到省钱", "评论提到替代烘焙纸"],
    counterevidence: ["有评论称尺寸不适配"],
    unknowns: ["缺少非置顶评论"],
    confidence: "low" as const,
    verification: ["对比 3 件装与单一尺寸装两组 listing 的动机提及比例。"],
  },
  {
    hypothesis: "子类头部位置主要来自同父体 11 个变体共享流量与评论，而非单一组合本身。",
    rationale: null,
    supportingEvidence: ["父体下变体评论合并展示"],
    counterevidence: [],
    unknowns: ["无法区分评论归属"],
    confidence: "unknown" as const,
    verification: ["获取父体下各变体的评论归属与流量占比。"],
  },
  {
    hypothesis: "「太滑、难彻底洗净」的体验来自硅胶表面与垫体过软导致无法施力，而非材质吸油。",
    rationale: "买家本人不确定是材质吸油还是太软。",
    supportingEvidence: ["评论提到表面太滑", "评论提到垫体太软难施力"],
    counterevidence: ["同一评论同时符合两种解释，不能作为区分性反证"],
    unknowns: ["未测量表面能", "未确认清洗方式"],
    confidence: "low" as const,
    verification: ["用同尺寸、不同厚度与不同表面处理的硅胶垫做清洗测试，控制油污、水温、洗洁精与施力方式。"],
  },
];

describe("ImprovementPlanCard", () => {
  const plan = buildImprovementPlan({ causes: CASE5_CAUSES });
  const html = renderToStaticMarkup(createElement(ImprovementPlanCard, { plan, stale: false }));

  it("渲染计划状态与免责声明，且不把改良假设写成结论", () => {
    expect(html).toContain("research-improvement-plan-card");
    // NEEDS_VERIFICATION 的正确说法是「需先做区分性验证」，不是「可进入低成本验证」
    expect(html).toContain("需先做区分性验证");
    expect(html).toContain("根因未确认");
    expect(html).toContain("不代表已确认根因");
  });

  it("市场层假设不渲染候选改良对象，只给「回到 02 市场研究」的说明", () => {
    // 第 1、2 条是市场 / 变体结构，绝不能派生出「内壁形状」这类错位改良对象
    expect(html).toContain("research-improvement-item-0-not-product");
    expect(html).toContain("research-improvement-item-1-not-product");
    expect(html).toContain("不是产品本身的工程问题");
    // 第 1、2 条的原因段内不得出现「候选改良对象」段落
    const firstItem = html.slice(html.indexOf("research-improvement-item-0"), html.indexOf("research-improvement-item-1"));
    expect(firstItem).not.toContain("候选改良对象");
    const secondItem = html.slice(html.indexOf("research-improvement-item-1"), html.indexOf("research-improvement-item-2"));
    expect(secondItem).not.toContain("候选改良对象");
  });

  it("产品层假设渲染三分法：候选对象 / 供应商确认模板 / 开发验证动作", () => {
    expect(html).toContain("材料与表面");
    expect(html).toContain("候选改良对象");
    expect(html).toContain("可能牺牲的其他性能");
    expect(html).toContain("合规核查");
    expect(html).toContain("用同尺寸、不同厚度与不同表面处理的硅胶垫做清洗测试");
    expect(html).toContain("存在反证");
  });

  it("归因分布只统计产品层假设（2 条市场假设不计入）", () => {
    expect(html).toContain("材料与表面 × 1");
    expect(html).not.toContain("结构设计 × 2");
  });

  it("按五层顺序展示：原因假设 → 可改良性判断 → 候选对象 → 验证要求 → 风险与未知", () => {
    const layers = ["layer-cause", "layer-actionability", "layer-targets", "layer-verification", "layer-risk"]
      .map((suffix) => html.indexOf(`research-improvement-item-2-${suffix}`));
    expect(layers.every((index) => index > 0)).toBe(true);
    expect([...layers].sort((left, right) => left - right)).toEqual(layers);
  });

  it("三态判断可区分：非产品与产品问题使用不同标签与颜色语义", () => {
    expect(html).toContain("非产品问题（市场 / 运营层）");
    expect(html).toContain("产品问题（可改良）");
    expect(html).toContain("可改良性分布");
    expect(html).toContain("非产品问题（市场 / 运营层） × 2");
  });

  it("规则版本与派生摘要显示在卡片上", () => {
    expect(html).toContain("research-improvement-rules-version");
    expect(html).toContain("improvement-plan.rules.v3");
    expect(html).toMatch(/派生摘要：ipd-[0-9a-f]{8}/);
  });

  it("线索数量称为「证据线索概况」，并明示不能当可信度或发生率", () => {
    expect(html).toContain("证据线索概况");
    expect(html).toContain("不是独立证据数");
    expect(html).not.toContain("证据强度：");
  });

  it("状态与含义不自相矛盾：不得一边说可验证一边暗示可直接开发", () => {
    const ready = buildImprovementPlan({ causes: [CASE5_CAUSES[2]!] });
    const readyHtml = renderToStaticMarkup(createElement(ImprovementPlanCard, { plan: ready, stale: false }));
    expect(readyHtml).toContain("≠ 可以立项");
    expect(readyHtml).toContain("≠ 可以下发生产");
  });

  it("混合假设渲染「需人工拆分」，且不显示候选改良对象", () => {
    const mixed = buildImprovementPlan({
      causes: [{
        hypothesis: "同父体变体共享流量与评论，同时内壁结构可能导致清洗困难，两者无法区分。",
        rationale: null,
        supportingEvidence: ["评论提到清洗困难"],
        counterevidence: [],
        unknowns: ["无法区分评论归属"],
        confidence: "low",
        verification: ["复核买家反馈并按父体拆分评论归属。"],
      }],
    });
    const mixedHtml = renderToStaticMarkup(createElement(ImprovementPlanCard, { plan: mixed, stale: false }));
    expect(mixedHtml).toContain("混合或不确定（需人工拆分）");
    expect(mixedHtml).toContain("需人工拆分假设或补充区分性证据");
    expect(mixedHtml).not.toContain("③ 候选改良对象");
    expect(mixedHtml).toContain("未派生风险 / 成本 / 合规模板");
  });

  it("报告来源已变化时必须给出 stale 提示", () => {
    const staleHtml = renderToStaticMarkup(createElement(ImprovementPlanCard, { plan, stale: true }));
    expect(staleHtml).toContain("研报引用的来源已变化");
  });

  it("没有原因假设时渲染「无改良方向」，而不是空白或伪造条目", () => {
    const empty = buildImprovementPlan({ causes: [] });
    const emptyHtml = renderToStaticMarkup(createElement(ImprovementPlanCard, { plan: empty, stale: false }));
    expect(emptyHtml).toContain("research-improvement-plan-empty");
    expect(emptyHtml).toContain("不要在此状态下编写开发要求");
  });
});
