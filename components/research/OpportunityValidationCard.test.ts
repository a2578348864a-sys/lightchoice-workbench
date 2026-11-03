import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpportunityValidationCard } from "./OpportunityValidationCard";
import { buildCommercialFeasibility } from "@/lib/research/commercialFeasibility";

describe("OpportunityValidationCard", () => {
  // 1. benchmark 商品正常展示
  it("1. benchmark 商品正常展示：角色、独立VOC分离、信号、缺口与下一步", () => {
    const feasibilityView = buildCommercialFeasibility({
      asin: "B0CWPNBC4Z",
      title: "Luckyiren 2 Pack Silicone Baking Mat Set, Nonstick Half Sheet, Orange/Beige",
      facts: {
        price: 5.99,
        currency: "USD",
        rating: 4.6,
        reviewCount: 975,
        dimensions: "16.54 x 11.62 inches",
        material: "Silicone",
      },
      marketProvenance: { role: "benchmark" },
      humanDecision: { choice: "WATCH", canonicalStatus: "VALIDATE_MORE", scope: "FINAL" },
      vocImprovementInsights: {
        available: true,
        reviewSnapshot: { totalReviews: 13, reviewsUsed: 13 },
        themes: [
          { label: "材质偏薄", summary: "垫子厚度偏轻薄容易受热移位", reviewCount: 3, strength: "medium", kind: "pain" },
          { label: "易清洗与不粘", summary: "烤饼干不粘盘容易水洗", reviewCount: 10, strength: "high", kind: "positive" },
        ],
      },
      report: {
        summary: "高频走量平铺烘焙垫，性价比极高。",
        opportunities: [{ text: "探索加厚版结构以解决偏薄痛点" }],
      },
    });

    const html = renderToStaticMarkup(
      createElement(OpportunityValidationCard, {
        asin: "B0CWPNBC4Z",
        title: "Luckyiren 2 Pack Silicone Baking Mat Set, Nonstick Half Sheet, Orange/Beige",
        role: "benchmark",
        feasibilityView,
        nextAction: "补充数据",
      })
    );

    // 商品与角色展示
    expect(html).toContain("B0CWPNBC4Z");
    expect(html).toContain("Luckyiren 2 Pack");
    expect(html).toContain("基准品 (Benchmark)");

    // 独立评论数与主题提及分离展示
    expect(html).toContain("独立评论 <b>13</b> 条");
    expect(html).toContain("累计主题提及 <b>13</b> 次");
    expect(html).toContain("独立评论数 ≠ 主题提及次数");

    // 信号展示
    expect(html).toContain("材质偏薄");
    expect(html).toContain("易清洗与不粘");

    // 验证方向
    expect(html).toContain("验证方向");
    expect(html).toContain("待验证");
    expect(html).toContain("AI 推断，非事实证据，需要人工验证");

    // 验证缺口
    expect(html).toContain("进入下一步前需要核实什么？");
    expect(html).toContain("采购成本 (COGS)");

    // 下一步动作三态约束（此处数据缺口存在，推导为补充数据）
    expect(html).toContain("建议下一步动作");
    expect(html).toContain("补充数据");
  });

  // 2. 无 VOC：显示 DATA_MISSING，不出现虚假痛点
  it("2. 无 VOC：显示 DATA_MISSING，不出现虚假痛点与编造文案", () => {
    const feasibilityView = buildCommercialFeasibility({
      asin: "B0CFTP6JR4",
      title: "Silicone Baking Mat 3 Pack",
      facts: {
        price: 9.99,
        currency: "USD",
        rating: 4.5,
        reviewCount: 350,
      },
      marketProvenance: { role: "pain_point" },
      humanDecision: null, // 未决策
      vocImprovementInsights: {
        available: false, // 无正式 VOC
        themes: [],
        requirements: [],
        checkpoints: [],
      },
    });

    const html = renderToStaticMarkup(
      createElement(OpportunityValidationCard, {
        asin: "B0CFTP6JR4",
        title: "Silicone Baking Mat 3 Pack",
        role: "pain_point",
        feasibilityView,
      })
    );

    // 来源状态三态：DATA_MISSING
    expect(html).toContain("DATA_MISSING");
    expect(html).toContain("暂无正式 VOC 数据");
    expect(html).toContain("系统拒绝以 AI 脑补或默认话术填充虚假痛点");

    // 确保不出现编造的虚假痛点
    expect(html).not.toContain("高频认可不粘与易清洁特性");
    expect(html).not.toContain("贴合度");
  });

  // 3. 人工决策与系统建议必须分别展示，缺少权威建议时不能凭固定值冒充。
  it("3. 人工决策为 PENDING 且没有系统建议时，分别展示未决断和暂不可用", () => {
    const feasibilityView = buildCommercialFeasibility({
      asin: "B0NEWCOMER1",
      title: "New Silicone Mat",
      marketProvenance: { role: "newcomer" },
      humanDecision: null, // 真实人工状态为 PENDING
    });

    const html = renderToStaticMarkup(
      createElement(OpportunityValidationCard, {
        asin: "B0NEWCOMER1",
        title: "New Silicone Mat",
        role: "newcomer",
        feasibilityView,
      })
    );

    // 人工决策部分：未决断 (PENDING)
    expect(html).toContain("人工决策:");
    expect(html).toContain("未决断 (PENDING)");

    // 系统建议部分：独立呈现缺失状态，并标明非人工决策
    expect(html).toContain("系统建议（非人工决策）:");
    expect(html).toContain("暂不可用");
    expect(html).not.toContain(">VALIDATE_MORE</span>");

    // 验证二者在不同 DOM 结构中独立存在
    expect(html).toContain('data-testid="opportunity-human-decision"');
    expect(html).toContain('data-testid="opportunity-system-suggestion"');
  });

  // 4. 禁止文案检查：不能出现“自动推荐开发”、“立即立项”、“确定机会”等
  it("4. 禁止文案安全扫描：杜绝自动立项与夸大定性文案", () => {
    const feasibilityView = buildCommercialFeasibility({
      asin: "B0BENCHMARK1",
      title: "Test Mat",
      marketProvenance: { role: "benchmark" },
      humanDecision: { choice: "PROCEED", canonicalStatus: "PROCEED" },
    });

    const html = renderToStaticMarkup(
      createElement(OpportunityValidationCard, {
        asin: "B0BENCHMARK1",
        title: "Test Mat",
        role: "benchmark",
        feasibilityView,
      })
    );

    // 严格禁止文案
    expect(html).not.toContain("自动推荐开发");
    expect(html).not.toContain("立即立项");
    expect(html).not.toContain("确定机会");

    // 禁止具体产品方案参数硬编码
    expect(html).not.toContain("开发0.7mm加厚款");
    expect(html).not.toContain("设计XX结构");

    // 必须有守卫文案
    expect(html).toContain("禁止自动推进 PROCEED");
    expect(html).toContain("最终决策由人工在页面右侧完成");
  });

  it("失效的人工决定标为历史记录，不得要求先核价才能形成需求单", () => {
    const feasibilityView = buildCommercialFeasibility({
      asin: "B0OLDDECISION",
      humanDecision: { choice: "PROCEED", canonicalStatus: "PROCEED", decisionStale: true },
    });
    const html = renderToStaticMarkup(createElement(OpportunityValidationCard, {
      asin: "B0OLDDECISION",
      feasibilityView,
      nextAction: "继续研究",
    }));
    expect(html).toContain("历史决定 · 需重新确认");
    expect(html).not.toContain("严禁跳过核价直接生成需求单");
    expect(html).toContain("继续研究");
  });
});
