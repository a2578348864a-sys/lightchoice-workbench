import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImprovementPlanSection } from "./ImprovementPlanSection";
import { buildImprovementPlan } from "@/lib/research/improvementPlan";

const PLAN = buildImprovementPlan({
  causes: [{
    hypothesis: "「太滑、难彻底洗净」的体验来自硅胶表面与垫体过软导致无法施力，而非材质吸油。",
    rationale: "买家本人不确定是材质吸油还是太软。",
    supportingEvidence: ["评论提到表面太滑", "评论提到垫体太软难施力"],
    counterevidence: [],
    unknowns: ["未测量表面能"],
    confidence: "low",
    verification: ["用同尺寸、不同厚度与不同表面处理的硅胶垫做清洗测试，控制油污、水温、洗洁精与施力方式。"],
  }],
});

describe("ImprovementPlanSection（04 需求单）", () => {
  const html = renderToStaticMarkup(createElement(ImprovementPlanSection, { plan: PLAN }));

  it("按三分法分组：待验证假设 / 供应商确认事项 / 开发验证要求", () => {
    expect(html).toContain("待验证假设（不是开发要求）");
    expect(html).toContain("供应商确认事项（通用检查模板，非本商品结论）");
    expect(html).toContain("开发验证要求（研究已给出的动作）");
  });

  it("同屏标注根因未确认与归因分类，避免被读成已确认缺陷", () => {
    expect(html).toContain("ROOT_CAUSE_UNVERIFIED");
    expect(html).toContain("材料与表面");
    expect(html).toContain("文本归类非确认根因");
  });

  it("产品问题时明示：仅供验证、不是正式开发要求、供应商事实未确认", () => {
    expect(html).toContain("不是正式开发要求");
    expect(html).toContain("供应商事实");
    expect(html).toContain("进入低成本验证 ≠ 可以立项 ≠ 可以下发生产");
  });

  it("显示派生规则版本，且说明它不等于研报 / 需求单版本", () => {
    expect(html).toContain("brief-improvement-rules-version");
    expect(html).toContain("improvement-plan.rules.v3");
    expect(html).toContain("不等于研报版本");
  });

  it("不显示任何 MOQ / 报价 / 交期数值", () => {
    expect(html).not.toMatch(/MOQ\s*[:：]\s*\d/u);
    expect(html).not.toMatch(/\d+\s*(?:天|pcs|件起订)/u);
  });

  it("市场问题时不得出现三分法分组，只提示回 02 市场研究", () => {
    const nonProduct = buildImprovementPlan({
      causes: [{
        hypothesis: "子类头部位置主要来自同父体 11 个变体共享流量与评论，而非单一组合本身。",
        rationale: null,
        supportingEvidence: ["父体下变体评论合并展示"],
        counterevidence: [],
        unknowns: ["无法区分评论归属"],
        confidence: "unknown",
        verification: ["获取父体下各变体的评论归属与流量占比。"],
      }],
    });
    const nonProductHtml = renderToStaticMarkup(createElement(ImprovementPlanSection, { plan: nonProduct }));
    expect(nonProductHtml).toContain("brief-improvement-0-not-product");
    expect(nonProductHtml).toContain("市场研究问题");
    expect(nonProductHtml).not.toContain("待验证假设（不是开发要求）");
    expect(nonProductHtml).not.toContain("供应商确认事项");
    expect(nonProductHtml).not.toContain("候选改良对象");
  });

  it("混合假设提示需人工拆分，且不显示产品改良对象", () => {
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
    const mixedHtml = renderToStaticMarkup(createElement(ImprovementPlanSection, { plan: mixed }));
    expect(mixedHtml).toContain("brief-improvement-0-actionability");
    expect(mixedHtml).toContain("混合或不确定（需人工拆分）");
    expect(mixedHtml).toContain("人工拆分假设或补充区分性证据");
    expect(mixedHtml).not.toContain("候选改良对象");
  });

  it("无原因假设时不渲染改良条目，只给说明", () => {
    const empty = buildImprovementPlan({ causes: [] });
    const emptyHtml = renderToStaticMarkup(createElement(ImprovementPlanSection, { plan: empty }));
    expect(emptyHtml).toContain("不要在此状态下编写开发要求");
  });
});
