import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ValidationBriefPanel } from "./ValidationBriefPanel";
import { ProductConceptV5Panel } from "./ProductConceptV5Panel";
import { buildCommercialFeasibility, type BuildCommercialFeasibilityInput } from "@/lib/research/commercialFeasibility";
import { buildValidationBriefView } from "@/lib/research/validationBriefView";

/** 真实基准：B0CWPNBC4Z — 13 条独立评论，厚度痛点仅 1 条（isolated） */
function benchmarkInput(overrides: Partial<BuildCommercialFeasibilityInput> = {}): BuildCommercialFeasibilityInput {
  return {
    asin: "B0CWPNBC4Z",
    title: "Luckyiren 2 Pack Silicone Baking Mat Set, Nonstick Half Sheet, Orange/Beige",
    facts: { price: 5.99, currency: "USD", rating: 4.6, reviewCount: 975 },
    marketProvenance: { role: "benchmark" },
    humanDecision: { choice: "WATCH", canonicalStatus: "VALIDATE_MORE", scope: "FINAL" },
    vocImprovementInsights: {
      available: true,
      reviewSnapshot: { totalReviews: 13, reviewsUsed: 13 },
      themes: [
        { label: "垫子偏薄，影响烘焙时间与温度", summary: "有评论认为更薄、更廉价，需调整烘烤时间", reviewCount: 1, strength: "isolated", kind: "pain" },
        { label: "尺寸比预期小", summary: "实物比想象中小", reviewCount: 1, strength: "isolated", kind: "pain" },
        { label: "不粘效果好，烘焙食品易脱模", summary: "食物不粘，易取下", reviewCount: 8, strength: "recurring", kind: "positive" },
      ],
      nextResearchSteps: ["扩大评论抽样范围，核实厚度与尺寸相关反馈的出现频率。"],
      unknowns: ["样本仅来自 Amazon 公开 Top Reviews，数量有限，无法代表全部购买者体验。"],
      checkpoints: [
        { id: "voc_cp_1", checkpoint: "样品/验货时重点核实「垫子偏薄，影响烘焙时间与温度」（1 条买家反馈提及此问题）", sourceThemeLabel: "垫子偏薄，影响烘焙时间与温度", reviewCount: 1, evidenceRefs: ["amazon-content:aaa"] },
      ],
    },
    report: { summary: "高频走量平铺烘焙垫，类目大盘基线稳定。" },
    ...overrides,
  };
}

function renderPanel(props: Parameters<typeof ValidationBriefPanel>[0]) {
  return renderToStaticMarkup(createElement(ValidationBriefPanel, props));
}

describe("ValidationBriefPanel · P0-1 证据强度（禁止无据强度词）", () => {
  it("1. 单条痛点显示「孤立提及 / 尚未复现」，且全文不出现「高频痛点」", () => {
    const input = benchmarkInput();
    const view = buildCommercialFeasibility(input);
    const html = renderPanel({ isOpen: true, onClose: () => {}, asin: input.asin, title: input.title, role: "benchmark", input, summary: input.report?.summary ?? null });

    expect(html).toContain("垫子偏薄");
    expect(html).toContain("单条用户反馈（1 条），当前尚未复现");
    expect(html).not.toContain("高频痛点");
    expect(html).not.toContain("普遍差评");
    expect(html).not.toContain("多数用户不满");
    // 证据强度徽标必须呈现真实分级
    expect(html).toContain("证据强度：isolated");
    expect(view.buyerVoc.negativeSignals[0]?.strengthTier).toBe("isolated");
  });

  it("2. 2–3 条为弱信号；≥4 条标记复现，且不得把复现等同于市场普遍性", () => {
    const weak = buildCommercialFeasibility({
      asin: "B0WEAK0001",
      title: "Weak Signal Mat",
      vocImprovementInsights: {
        available: true,
        reviewSnapshot: { reviewsUsed: 10 },
        themes: [{ label: "偏薄", summary: "薄", reviewCount: 3, strength: "weak", kind: "pain" }],
      },
    });
    expect(weak.buyerVoc.negativeSignals[0]?.strengthTier).toBe("weak");

    const recurring = buildCommercialFeasibility({
      asin: "B0RECUR001",
      title: "Recurring Signal Mat",
      vocImprovementInsights: {
        available: true,
        reviewSnapshot: { reviewsUsed: 20 },
        themes: [{ label: "偏薄", summary: "薄", reviewCount: 4, strength: "recurring", kind: "pain" }],
      },
    });
    expect(recurring.buyerVoc.negativeSignals[0]?.strengthTier).toBe("recurring");

    const html = renderPanel({ isOpen: true, onClose: () => {}, asin: "B0RECUR001", title: "Recurring Signal Mat", feasibilityView: recurring });
    expect(html).toContain("已达系统复现门槛");
    // 复现 ≠ 市场普遍需求，必须带限定声明
    expect(html).toContain("不等于已证明市场普遍需求");
  });

  it("2b. 记录强度与计数矛盾时显示异常标记，不自行推测", () => {
    const view = buildCommercialFeasibility({
      asin: "B0CONFL001",
      title: "Conflict Mat",
      vocImprovementInsights: {
        available: true,
        reviewSnapshot: { reviewsUsed: 9 },
        // 声明 recurring 但计数只有 1 → 矛盾
        themes: [{ label: "偏薄", summary: "薄", reviewCount: 1, strength: "recurring", kind: "pain" }],
      },
    });
    expect(view.buyerVoc.negativeSignals[0]?.strengthConflict).toBe(true);
    const html = renderPanel({ isOpen: true, onClose: () => {}, asin: "B0CONFL001", title: "Conflict Mat", feasibilityView: view });
    expect(html).toContain("强度记录与计数不一致，待核实");
  });
});

describe("ValidationBriefPanel · P0-2 已确认事实三态（禁止虚假采集声明）", () => {
  it("3. 无 BSR 时明确显示缺失，且不出现「已采集…BSR 排名」类虚假声明", () => {
    const input = benchmarkInput({ report: undefined });
    const html = renderPanel({ isOpen: true, onClose: () => {}, asin: input.asin, title: input.title, role: "benchmark", input });

    expect(html).toContain("已确认事实 (AVAILABLE)");
    expect(html).toContain("缺失 / 无法验证 (DATA_MISSING)");
    expect(html).toContain("大类/细分 BSR 排名");
    expect(html).toContain("缺失");
    expect(html).not.toContain("商品已采集基础价格、评论数与 BSR 排名");
    expect(html).not.toContain("类目大盘存在基准销量佐证");
  });

  it("3b. ESTIMATED 不得混入已确认事实；AI 研报摘要单独标注为非事实证据", () => {
    const input = benchmarkInput();
    const view = buildCommercialFeasibility(input);
    expect(view.confirmedFacts.find((f) => f.key === "competition")?.state).toBe("ESTIMATED");
    expect(view.confirmedFacts.find((f) => f.key === "bsr")?.state).toBe("DATA_MISSING");

    const html = renderPanel({ isOpen: true, onClose: () => {}, asin: input.asin, title: input.title, role: "benchmark", input, summary: "高频走量平铺烘焙垫，类目大盘基线稳定。" });
    expect(html).toContain("来源明确的估算 (ESTIMATED)");
    expect(html).toContain("研究解释（AI 研报摘要）");
    expect(html).toContain("非事实证据");
    // 不得向用户输出内部技术结构（facts JSON）
    expect(html).not.toContain("&quot;brand&quot;");
    expect(html).not.toContain("&quot;bulletPoints&quot;");
  });

  it("4. 无正式 VOC 时保持诚实空态，不臆造痛点", () => {
    const html = renderPanel({
      isOpen: true,
      onClose: () => {},
      asin: "B0CFTP6JR4",
      title: "Silicone Baking Mat 3 Pack",
      input: { asin: "B0CFTP6JR4", title: "Silicone Baking Mat 3 Pack", facts: { price: 9.99, rating: 4.5 }, vocImprovementInsights: { available: false, themes: [], unknowns: [], nextResearchSteps: [] } },
    });
    expect(html).toContain("暂无正式 VOC 数据");
    expect(html).toContain("禁止 AI 补充臆测痛点");
    expect(html).not.toContain("高频痛点");
  });
});

describe("ValidationBriefPanel · P1 商品级验证任务", () => {
  it("9. 验证事项来自已有正式数据（VOC 下一步建议 / 核实项 / 缺口），并标注来源", () => {
    const input = benchmarkInput();
    const brief = buildValidationBriefView({ asin: input.asin, title: input.title, role: "benchmark", input, summary: input.report?.summary ?? null });

    expect(brief.productSpecificTaskCount).toBeGreaterThan(0);
    expect(brief.taskFallbackUsed).toBe(false);
    const sources = new Set(brief.tasks.map((t) => t.source));
    expect(sources.has("research_next_step")).toBe(true);
    expect(sources.has("supplier_checkpoint")).toBe(true);
    expect(sources.has("commercial_gap")).toBe(true);
    // 每条任务都能标出来源
    expect(brief.tasks.every((t) => t.sourceLabel.length > 0)).toBe(true);

    const html = renderPanel({ isOpen: true, onClose: () => {}, asin: input.asin, title: input.title, role: "benchmark", input });
    expect(html).toContain("正式 VOC 下一步研究建议");
    expect(html).toContain("供应商/验货核实项");
    // 不得生成具体方案臆测
    expect(html).not.toContain("0.7mm");
    expect(html).not.toContain("开发新模具");
    expect(html).not.toContain("改用");
  });

  it("9b. 无任何商品专项数据时显示「暂无商品专项任务」+ 明确标注模板参考", () => {
    const brief = buildValidationBriefView({
      asin: "B0NOTASK001",
      title: "No Task Mat",
      input: { asin: "B0NOTASK001", title: "No Task Mat", vocImprovementInsights: { available: false, themes: [], unknowns: [], nextResearchSteps: [] } },
    });
    expect(brief.taskFallbackUsed).toBe(true);
    expect(brief.productSpecificTaskCount).toBe(0);
    expect(brief.tasks.every((t) => t.source === "template")).toBe(true);

    const html = renderPanel({ isOpen: true, onClose: () => {}, asin: "B0NOTASK001", title: "No Task Mat", input: { asin: "B0NOTASK001", title: "No Task Mat" } });
    expect(html).toContain("本商品暂无专项验证任务");
    expect(html).toContain("模板参考");
  });

  it("任务数量由证据决定，不做固定填充（空输入 → 无重复堆叠）", () => {
    const rich = buildValidationBriefView({ asin: "B0RICH00001", title: "Rich", input: benchmarkInput() });
    const lean = buildValidationBriefView({ asin: "B0LEAN00001", title: "Lean", input: { asin: "B0LEAN00001", title: "Lean" } });
    expect(rich.tasks.length).not.toBe(lean.tasks.length);
  });
});

describe("ValidationBriefPanel · P0-3 失效人工决策阻断", () => {
  it("6. stale 的 VALIDATE_MORE：面板显示失效提示、禁用复制，Markdown 也带失效声明", () => {
    const input = benchmarkInput({
      humanDecision: { choice: "WATCH", canonicalStatus: "VALIDATE_MORE", scope: "FINAL", decisionStale: true, decisionStaleReason: "DECISION_BINDING_CHANGED" },
    });
    const brief = buildValidationBriefView({ asin: input.asin, title: input.title, role: "benchmark", input });
    expect(brief.decision.staleBlocked).toBe(true);
    expect(brief.markdown).toContain("原人工决策需要重新确认");
    expect(brief.markdown).toContain("DECISION_BINDING_CHANGED");

    const html = renderPanel({ isOpen: true, onClose: () => {}, asin: input.asin, title: input.title, role: "benchmark", input });
    expect(html).toContain("原人工决策已失效，需重新确认后才能使用本需求单");
    expect(html).toContain("历史决策记录已保留，未被改写");
    expect(html).toContain("disabled");
  });

  it("5. 有效的 VALIDATE_MORE：面板正常呈现且无失效提示", () => {
    const input = benchmarkInput();
    const html = renderPanel({ isOpen: true, onClose: () => {}, asin: input.asin, title: input.title, role: "benchmark", input });
    expect(html).not.toContain("原人工决策已失效");
    expect(html).toContain("前置验证工单（Validation Brief）性质声明");
  });
});

describe("ValidationBriefPanel · §7 页面与 Markdown 一致", () => {
  it("10. 强度措辞、缺失事实、门禁与任务来源在页面与 Markdown 完全一致", () => {
    const input = benchmarkInput();
    const brief = buildValidationBriefView({ asin: input.asin, title: input.title, role: "benchmark", input, summary: input.report?.summary ?? null });
    const html = renderPanel({ isOpen: true, onClose: () => {}, asin: input.asin, title: input.title, role: "benchmark", input, summary: input.report?.summary ?? null });

    // 强度措辞一致
    expect(brief.markdown).toContain("单条用户反馈（1 条），当前尚未复现");
    expect(html).toContain("单条用户反馈（1 条），当前尚未复现");
    // 「高频」只能作为被引用的研报摘要原文出现在「研究解释（非事实证据）」区，
    // 不得作为强度断言出现在方向/主题措辞中
    expect(brief.markdown).not.toContain("高频痛点");
    expect(html).not.toContain("高频痛点");
    expect(html).not.toContain("买家高频");

    // 缺失事实一致
    expect(brief.markdown).toContain("缺失 / 无法验证 (DATA_MISSING)");
    expect(brief.markdown).toContain("大类/细分 BSR 排名");
    expect(html).toContain("缺失 / 无法验证 (DATA_MISSING)");

    // 任务与来源一致
    for (const task of brief.tasks) {
      expect(brief.markdown).toContain(task.title);
      expect(brief.markdown).toContain(task.sourceLabel);
    }
    // 独立评论数 ≠ 主题提及数，两处口径一致
    expect(brief.markdown).toContain("独立评论数：13 条");
    expect(html).toContain("独立评论数 13 条");
  });
});

describe("ProductConceptV5Panel 出口分流门禁", () => {
  it("5b. 有效 VALIDATE_MORE → 展示「生成验证需求单」出口", () => {
    const html = renderToStaticMarkup(createElement(ProductConceptV5Panel, {
      taskId: "task-test-1", disabled: false, fallbackSummary: "研究测试摘要", humanDecisionGate: "VALIDATE_MORE",
    }));
    expect(html).toContain("需补充验证 (VALIDATE_MORE)");
    expect(html).toContain("生成验证需求单");
    expect(html).not.toContain("原人工决策已失效");
  });

  it("6b. stale 的 VALIDATE_MORE → 出口被阻断且提示需重新确认", () => {
    const html = renderToStaticMarkup(createElement(ProductConceptV5Panel, {
      taskId: "task-test-1", disabled: false, fallbackSummary: "研究测试摘要",
      humanDecisionGate: "VALIDATE_MORE", humanDecisionStale: true, humanDecisionStaleReason: "DECISION_BINDING_CHANGED",
    }));
    expect(html).toContain("原人工决策已失效，需重新确认");
    expect(html).toContain("生成验证需求单 (需重新确认)");
    expect(html).toContain("DECISION_BINDING_CHANGED");
    expect(html).not.toContain(">生成验证需求单<");
  });

  it("8. PROCEED → 仍走正式产品开发需求单路径", () => {
    const html = renderToStaticMarkup(createElement(ProductConceptV5Panel, {
      taskId: "task-test-2", disabled: false, fallbackSummary: "研究测试摘要", humanDecisionGate: "PROCEED",
    }));
    expect(html).toContain("已继续推进 (PROCEED)");
    expect(html).toContain("生成产品开发需求单");
    expect(html).toContain("/product-brief?taskId=task-test-2");
  });

  it("7. PENDING / PAUSE / DROP → 保持门禁锁定，不得越权生成", () => {
    for (const gate of ["PENDING", "PAUSE", "DROP"]) {
      const html = renderToStaticMarkup(createElement(ProductConceptV5Panel, {
        taskId: "task-test-3", disabled: false, fallbackSummary: "研究测试摘要", humanDecisionGate: gate,
      }));
      expect(html).toContain("前置决断门禁未解锁");
      expect(html).toContain("生成需求单 (需先决断)");
      expect(html).not.toContain("生成验证需求单<");
      expect(html).not.toContain("/product-brief?taskId=");
    }
  });
});
