import { describe, expect, it } from "vitest";
import { buildCommercialFeasibility } from "./commercialFeasibility";
import type { UnitEconomicsView } from "./researchContracts";

describe("commercialFeasibility", () => {
  it("Benchmark (B0CWPNBC4Z)：正式 VOC 计数分离 + 人工决策 WATCH 投影", () => {
    const view = buildCommercialFeasibility({
      asin: "B0CWPNBC4Z",
      title: "Luckyiren 2 Pack Silicone Baking Mat Set, Nonstick Half Sheet, Orange/Beige",
      facts: {
        price: 5.99,
        currency: "USD",
        rating: 4.6,
        reviewCount: 975,
        brand: null,
        mainCategory: null,
        dimensions: "16.54 x 11.62 inches",
        weight: null,
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

    // 1. 已确认事实
    expect(view.asin).toBe("B0CWPNBC4Z");
    expect(view.role).toBe("benchmark");
    const priceFact = view.confirmedFacts.find((f) => f.key === "price");
    expect(priceFact?.state).toBe("AVAILABLE");
    expect(priceFact?.displayValue).toBe("5.99 USD");
    const packFact = view.confirmedFacts.find((f) => f.key === "packCount");
    // 标题字面推断不是结构化包装事实：只能 ESTIMATED，不得升级为 AVAILABLE
    expect(packFact?.state).toBe("ESTIMATED");
    expect(packFact?.displayValue).toBe("2 件装");
    expect(packFact?.note).toContain("尚待核实包装规格");
    for (const key of ["cogs", "fbaFee", "moq"]) {
      expect(view.confirmedFacts.find((f) => f.key === key)?.state).toBe("DATA_MISSING");
    }
    // 价位段仅客观归档
    const competition = view.confirmedFacts.find((f) => f.key === "competition");
    expect(competition?.displayValue).toBe("低于 $8 价位段");
    expect(competition?.state).toBe("ESTIMATED");

    // 2. 正式 VOC：独立评论数与主题提及次数严格分开（13 独立 vs 13 提及≠混用）
    expect(view.buyerVoc.state).toBe("AVAILABLE");
    expect(view.buyerVoc.independentReviewCount).toBe(13);
    expect(view.buyerVoc.themeMentionCount).toBe(13);
    expect(view.buyerVoc.themeCount).toBe(2);
    expect(view.buyerVoc.positiveSignals.length).toBeGreaterThan(0);
    expect(view.buyerVoc.negativeSignals.length).toBeGreaterThan(0);
    expect(view.buyerVoc.summary).toContain("独立评论 13 条");
    expect(view.buyerVoc.summary).toContain("主题提及 13 次");
    expect(view.buyerVoc.summary).not.toContain("静电吸灰");

    // 3. AI 层：有研报来源才有推断；转述与推断分开
    expect(view.aiInferences.length).toBeGreaterThan(0);
    expect(view.aiInferences.every((inf) => inf.state === "ESTIMATED")).toBe(true);

    // 4. 风险与门禁
    expect(view.commercialAssessment.commercialRisks.some((r) => r.id === "risk-low-price")).toBe(true);
    expect(view.commercialAssessment.dataGaps.length).toBeGreaterThanOrEqual(5);

    // 5. 人工决策与系统建议分离
    expect(view.commercialAssessment.decisionSupport.currentGate).toBe("VALIDATE_MORE");
    expect(view.commercialAssessment.decisionSupport.humanDecided).toBe(true);
    expect(view.commercialAssessment.decisionSupport.humanDecisionDisplay).toContain("人工已决策：WATCH");
    expect(view.commercialAssessment.decisionSupport.systemSuggestionGate).toBe("VALIDATE_MORE");
    expect(view.commercialAssessment.decisionSupport.autoProceedBlocked).toBe(true);

    // 6. 价格阈值不推导刚需/毛利结论
    expect(view.commercialAssessment.marketAttractiveness).toContain("5.99");
    expect(view.commercialAssessment.marketAttractiveness).toContain("待验证");
    expect(view.commercialAssessment.marketAttractiveness).not.toContain("高频刚需");
    expect(view.commercialAssessment.marketAttractiveness).not.toContain("纯走量");
    const lowPriceRisk = view.commercialAssessment.commercialRisks.find((r) => r.id === "risk-low-price");
    expect(lowPriceRisk?.detail).toContain("待验证");
    expect(lowPriceRisk?.detail).not.toContain("毛利空间极窄");
  });

  it("Newcomer (B0HFS7K4GP)：未决策保持 PENDING，AI 研报摘要不进 VOC 层", () => {
    const view = buildCommercialFeasibility({
      asin: "B0HFS7K4GP",
      title: "Leakproof Silicone Baking Mat with Snap Lock Edges Nonstick Oven Liners",
      facts: { price: 15.88, currency: "USD", rating: 5.0, reviewCount: 2 },
      marketProvenance: { role: "newcomer" },
      humanDecision: null,
      vocImprovementInsights: {
        available: true,
        reviewSnapshot: { totalReviews: 2, reviewsUsed: 2 },
        themes: [
          { label: "首次扣合需较大力气", summary: "第一次按压角部卡扣需要较大的力气", reviewCount: 1, strength: "medium", kind: "pain" },
        ],
      },
      deepseek: {
        status: "done",
        summary: "溢价定位创新款。",
        vocAnalysis: {
          positiveSignals: ["400°F 烘焙卡扣保持锁定", "烤箱内零泄漏"],
          painPoints: ["首次按压角落卡扣需要较大力度"],
        },
      },
    });

    const priceFact = view.confirmedFacts.find((f) => f.key === "price");
    expect(priceFact?.state).toBe("AVAILABLE");
    expect(priceFact?.displayValue).toBe("15.88 USD");

    // 未决策 = PENDING（不得把系统建议写进人工门禁）
    expect(view.commercialAssessment.decisionSupport.currentGate).toBe("PENDING");
    expect(view.commercialAssessment.decisionSupport.humanDecided).toBe(false);
    expect(view.commercialAssessment.decisionSupport.humanDecisionDisplay).toContain("待人工决策");
    expect(view.commercialAssessment.decisionSupport.systemSuggestionGate).toBe("VALIDATE_MORE");

    // 修4：AI 研报摘要不得进入第二层 VOC，也不得撑起 AVAILABLE
    expect(view.buyerVoc.positiveSignals.some((s) => s.text.includes("400°F"))).toBe(false);
    expect(view.buyerVoc.negativeSignals.some((s) => s.text.includes("较大力度"))).toBe(false);
    // 正式主题仍在（kind=pain → 差评框）
    expect(view.buyerVoc.negativeSignals.some((s) => s.text.includes("首次扣合"))).toBe(true);
    // AI 转述归入第三层并带“非正式”标注（2 正向 + 1 痛点 = 3）
    const transcripts = view.aiInferences.filter((i) => i.title.includes("AI 研报买家反馈转述"));
    expect(transcripts.length).toBe(3);
    expect(transcripts.every((i) => i.premise.includes("不构成正式 VOC"))).toBe(true);

    // 独立评论 2 ≠ 主题提及 1
    expect(view.buyerVoc.independentReviewCount).toBe(2);
    expect(view.buyerVoc.themeMentionCount).toBe(1);

    // 修5：价格阈值中性化
    expect(view.commercialAssessment.marketAttractiveness).toContain("15.88");
    expect(view.commercialAssessment.marketAttractiveness).toContain("待验证");
    expect(view.commercialAssessment.marketAttractiveness).not.toContain("< $6");
    expect(view.commercialAssessment.marketAttractiveness).not.toContain("溢价空间（当前标价");
    expect(view.commercialAssessment.decisionSupport.recommendation).not.toContain("低单价竞争白热化");
    expect(view.commercialAssessment.decisionSupport.recommendation).not.toContain("同质化竞争激烈");
  });

  it("Pain Point (B0CFTP6JR4)：无正式 VOC 时诚实 DATA_MISSING，无默认产品方案", () => {
    const view = buildCommercialFeasibility({
      asin: "B0CFTP6JR4",
      title: "Koolstuffs Silicone Baking Mat, Nonstick and Reusable, 3 Pack",
      facts: { price: 9.99, currency: "USD", rating: 4.7, reviewCount: 3 },
      marketProvenance: { role: "pain_point" },
      humanDecision: null,
      vocImprovementInsights: { available: false, themes: [], reviewSnapshot: null },
    });

    const packFact = view.confirmedFacts.find((f) => f.key === "packCount");
    expect(packFact?.displayValue).toBe("3 件装");
    const brandFact = view.confirmedFacts.find((f) => f.key === "brand");
    expect(brandFact?.state).toBe("ESTIMATED");
    expect(brandFact?.value).toBe("Koolstuffs");

    // 修4：无正式 VOC = DATA_MISSING，零编造
    expect(view.buyerVoc.state).toBe("DATA_MISSING");
    expect(view.buyerVoc.independentReviewCount).toBeNull();
    expect(view.buyerVoc.positiveSignals.length).toBe(0);
    expect(view.buyerVoc.negativeSignals.length).toBe(0);
    expect(view.buyerVoc.summary).toContain("尚无正式 VOC 分析记录");
    expect(view.commercialAssessment.improvementOpportunity).toContain("待验证");

    // 修1：无研报来源时 AI 层为空——绝不生成“玻璃纤维/加厚”默认方案
    expect(view.aiInferences.length).toBe(0);
    expect(JSON.stringify(view)).not.toContain("玻璃纤维");

    // 修5：$9.99 不得被判低价带
    expect(view.commercialAssessment.marketAttractiveness).toContain("9.99");
    expect(view.commercialAssessment.marketAttractiveness).not.toContain("< $6");
    expect(view.commercialAssessment.marketAttractiveness).toContain("待验证");

    // 修3：未决策 PENDING
    expect(view.commercialAssessment.decisionSupport.currentGate).toBe("PENDING");
    expect(view.commercialAssessment.decisionSupport.humanDecided).toBe(false);
  });

  it("AI 研报摘要无正式来源时不得把 VOC 层升级为 AVAILABLE", () => {
    const view = buildCommercialFeasibility({
      asin: "B0AIROSSUM0",
      title: "Test Mat",
      facts: { price: 10, currency: "USD", reviewCount: 100 },
      deepseek: {
        status: "done",
        summary: "研报摘要。",
        vocAnalysis: { positiveSignals: ["买家认可不粘"], painPoints: ["有评论提到太薄"] },
      },
    });

    expect(view.buyerVoc.state).toBe("DATA_MISSING");
    expect(view.buyerVoc.positiveSignals.length).toBe(0);
    expect(view.buyerVoc.negativeSignals.length).toBe(0);
    expect(view.aiInferences.some((i) => i.title.includes("非正式 VOC"))).toBe(true);
  });

  it("kind 分类与关键词兜底：痛点不入正向框，不粘不入差评框", () => {
    const view = buildCommercialFeasibility({
      asin: "B0HFS7K4GP",
      title: "Leakproof Silicone Baking Mat with Snap Lock Edges",
      facts: { price: 15.88, currency: "USD", rating: 5.0, reviewCount: 2 },
      vocImprovementInsights: {
        available: true,
        reviewSnapshot: { reviewsUsed: 2 },
        themes: [
          { label: "首次扣合需较大力气", summary: "第一次按压角部卡扣需要较大的力气", reviewCount: 1, strength: "medium", kind: "pain" },
          { label: "正向认可", summary: "表现良好", reviewCount: 1, strength: "high", kind: "positive" },
        ],
      },
    });

    expect(view.buyerVoc.negativeSignals.some((s) => s.text.includes("首次扣合"))).toBe(true);
    expect(view.buyerVoc.positiveSignals.some((s) => s.text.includes("首次扣合"))).toBe(false);
    expect(view.buyerVoc.positiveSignals.some((s) => s.text.includes("正向认可"))).toBe(true);

    const view2 = buildCommercialFeasibility({
      asin: "B0TESTPOS0",
      title: "Test Mat",
      facts: { price: 10, currency: "USD", reviewCount: 10 },
      vocImprovementInsights: {
        available: true,
        themes: [{ label: "易清洗与不粘", summary: "烤饼干不粘盘容易水洗", reviewCount: 10, strength: "high" }],
      },
    });
    expect(view2.buyerVoc.positiveSignals.some((s) => s.text.includes("易清洗"))).toBe(true);
    expect(view2.buyerVoc.negativeSignals.some((s) => s.text.includes("易清洗"))).toBe(false);
    // 无快照 → 独立评论数未知（不得用主题提及冒充）
    expect(view2.buyerVoc.independentReviewCount).toBeNull();
    expect(view2.buyerVoc.themeMentionCount).toBe(10);
    expect(view2.buyerVoc.summary).toContain("独立评论数未随分析快照记录");
  });

  it("全空输入：VOC/决策/AI 层全部诚实降级", () => {
    const view = buildCommercialFeasibility({
      asin: "B0UNKNOWN00",
      title: null,
      facts: null,
    });

    expect(view.asin).toBe("B0UNKNOWN00");
    const missingCount = view.confirmedFacts.filter((f) => f.state === "DATA_MISSING").length;
    expect(missingCount).toBeGreaterThanOrEqual(8);
    expect(view.buyerVoc.state).toBe("DATA_MISSING");
    expect(view.buyerVoc.independentReviewCount).toBeNull();
    expect(view.buyerVoc.themeMentionCount).toBe(0);
    expect(view.buyerVoc.positiveSignals.length).toBe(0);
    expect(view.aiInferences.length).toBe(0);
    expect(view.commercialAssessment.decisionSupport.currentGate).toBe("PENDING");
    expect(view.commercialAssessment.decisionSupport.systemSuggestionGate).toBe("VALIDATE_MORE");
    expect(view.commercialAssessment.decisionSupport.autoProceedBlocked).toBe(true);
    expect(JSON.stringify(view)).not.toContain("玻璃纤维");
  });

  it("包装数量：连字符 4-Pack 可解析，但只作标题推断（ESTIMATED）", () => {
    const view = buildCommercialFeasibility({
      asin: "B07PR9NM54",
      title: "Rubbermaid Cleverstore 95 Qt Clear Storage Bins with Lids, 4-Pack, Stackable, BPA-Free, Made in USA",
      facts: { price: 111.6, currency: "USD", rating: 4.2, reviewCount: null },
    });
    const packFact = view.confirmedFacts.find((f) => f.key === "packCount");
    expect(packFact?.value).toBe(4);
    expect(packFact?.displayValue).toBe("4 件装");
    expect(packFact?.state).toBe("ESTIMATED");
    expect(packFact?.note).toContain("尚待核实包装规格");
  });

  it("包装数量：标题未标注时保持未知，不按 1 件兜底", () => {
    const view = buildCommercialFeasibility({
      asin: "B0NOPACK001",
      title: "Clear Plastic Storage Bin with Latching Lid",
      facts: { price: 20, currency: "USD" },
    });
    const packFact = view.confirmedFacts.find((f) => f.key === "packCount");
    expect(packFact?.value).toBeNull();
    expect(packFact?.state).toBe("DATA_MISSING");
    expect(packFact?.displayValue).toContain("未知");
    expect(packFact?.note).toContain("不按 1 件兜底");
  });

  it("VOC 空态文案不得声称「未采集」，须指向 VOC 层的合法评论证据", () => {
    const view = buildCommercialFeasibility({
      asin: "B07PR9NM54",
      title: "Rubbermaid Cleverstore 95 Qt Clear Storage Bins with Lids, 4-Pack",
      facts: { price: 111.6, currency: "USD" },
      vocImprovementInsights: { available: false, themes: [], reviewSnapshot: null },
    });
    expect(view.buyerVoc.state).toBe("DATA_MISSING");
    expect(view.buyerVoc.summary).not.toContain("未采集");
    expect(view.buyerVoc.summary).toContain("不等于商品没有评论证据");
  });

  it("标题里的材质词只是来源声明：标 ESTIMATED 并说明未结构化确认，不当已确认材料", () => {
    const view = buildCommercialFeasibility({
      asin: "B0TESTMAT1",
      title: "Silicone Baking Mat Non-slip Large",
      facts: { price: 12, currency: "USD", rating: 4.5, reviewCount: 10, material: null },
    });
    const material = view.confirmedFacts.find((item) => item.key === "material");
    expect(material?.state).toBe("ESTIMATED");
    expect(material?.value).toBe("Silicone (硅胶)");
    expect(material?.note).toContain("标题");
    // 结构化材质属性存在时才允许 AVAILABLE
    const structured = buildCommercialFeasibility({
      asin: "B0TESTMAT2",
      title: "Silicone Baking Mat",
      facts: { price: 12, currency: "USD", rating: 4.5, reviewCount: 10, material: "Platinum silicone" },
    });
    expect(structured.confirmedFacts.find((item) => item.key === "material")?.state).toBe("AVAILABLE");
  });

  it("已有成本情景时不再声称采购价和配送费均缺失，仍保留未纳入费用的限制", () => {
    const unitEconomics = {
      status: "available",
      isPartialCostBasis: true,
      excludedCosts: ["退货与售后损失", "关税与进口税"],
      reasons: [],
      inputProvenance: [
        { key: "procurementCost", nature: "USER_INPUT" },
        { key: "shippingRate", nature: "USER_INPUT" },
        { key: "fbaFee", nature: "USER_INPUT" },
        { key: "packageDimensions", nature: "MISSING" },
      ],
    } as unknown as UnitEconomicsView;
    const view = buildCommercialFeasibility({
      asin: "B0TESTCOST",
      facts: { price: 5.99, currency: "USD" },
      unitEconomics,
    });
    expect(view.commercialAssessment.dataGaps.map((gap) => gap.field)).not.toContain("采购成本 (COGS)");
    expect(view.commercialAssessment.dataGaps.map((gap) => gap.field)).not.toContain("FBA 配送费与体积重");
    expect(view.commercialAssessment.dataGaps.map((gap) => gap.field)).toContain("单件包装重量与尺寸");
    expect(view.commercialAssessment.dataGaps.map((gap) => gap.field)).toContain("外箱包装规格尺寸");
    const text = JSON.stringify(view.commercialAssessment);
    expect(text).not.toContain("采购成本、FBA 费用与头程均缺失");
    expect(text).not.toContain("必须由人工核实供应商阶梯报价及包装尺寸后");
    expect(text).toContain("退货与售后损失");
    expect(text).toContain("情景");
  });

  it("旧人工决定仍保留原状态，但必须明确标成需要重新确认的历史记录", () => {
    const view = buildCommercialFeasibility({
      asin: "B0TESTOLD",
      humanDecision: { choice: "PROCEED", canonicalStatus: "PROCEED", decisionStale: true, decisionStaleReason: "DECISION_BINDING_CHANGED" },
    });
    expect(view.commercialAssessment.decisionSupport.currentGate).toBe("PROCEED");
    expect(view.commercialAssessment.decisionSupport.humanDecisionDisplay).toContain("历史");
    expect(view.commercialAssessment.decisionSupport.humanDecisionDisplay).toContain("需重新确认");
    expect(view.commercialAssessment.decisionSupport.decisionStaleReason).toBe("DECISION_BINDING_CHANGED");
  });
});
