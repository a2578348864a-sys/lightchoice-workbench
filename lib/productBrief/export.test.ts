import { describe, expect, it } from "vitest";
import { PRODUCT_BRIEF_SCHEMA, type ProductBrief } from "./contract";
import { briefFileName, buildBriefMarkdown } from "./export";
import { buildBriefDecisionSummary } from "./briefDecisionSummary";

const baseBrief = (overrides: Partial<ProductBrief> = {}): ProductBrief => ({
  schemaVersion: PRODUCT_BRIEF_SCHEMA,
  status: "DRAFT",
  revision: 3,
  generatedAt: "2026-10-05T00:00:00.000Z",
  sourceBinding: {
    taskId: "task-1",
    researchRevision: 2,
    reportHash: "reporthash-abc",
    factHash: "facthash-abc",
    evidenceHash: "evidencehash-abc",
    marketScanId: null,
    marketSampleHash: null,
  },
  identity: { asin: "B000000001", title: "测试保温杯", imageUrl: null, brand: null, category: null, marketplace: "US" },
  projectOverview: null,
  targetUser: null,
  corePainPoints: [],
  benchmarks: [],
  differentiation: [],
  economics: {
    targetPrice: null,
    targetMarginPct: null,
    referralFee: null,
    fbaFee: null,
    logistics: null,
    estimatedTax: null,
    otherKnownCosts: null,
    currency: "USD",
    purchaseCostCeiling: { status: "NOT_COMPUTABLE", value: null, currency: "USD", formula: "目标售价 - 已知费用 - 目标利润", reason: "需要补齐输入" },
  },
  specsDirection: [],
  vocQaRedlines: [],
  risks: [],
  rationale: [],
  missingValidation: ["目标毛利率尚未由人工填写。"],
  ...overrides,
});

describe("P0-BR-A6 buildBriefMarkdown", () => {
  it("包含全部章节标题（与企划页章节顺序一致）", () => {
    const markdown = buildBriefMarkdown(baseBrief());
    for (const title of ["项目概览与定位", "研报提出的用户问题（证据待核实）", "改进方向（VOC 复现痛点派生 · 待验证假设）", "基准 / 代表商品", "差异化方向（事实 vs 假设）", "拟开发规格", "竞品-本品对照", "经济性与购买成本上限", "产品开发确认事项", "VOC 质量红线", "风险与形成理由", "验证计划（生成时快照，当前状态见「② 商业可行性确认」）", "待验证项（生成时快照，来源只读）"]) {
      expect(markdown).toContain(`## ${title}`);
    }
  });

  it("改进方向段随行导出；undefined（旧版）与空数组都显示（空）", () => {
    const withRequirements = buildBriefMarkdown(baseBrief({
      vocRequirements: [{ text: "改进方向：针对买家反馈的「表面滑」问题——多位买家反馈垫子过滑。", nature: "EVIDENCE_DERIVED", evidenceRefs: ["amazon-content:hash-a"] }],
    }));
    expect(withRequirements).toContain("## 改进方向（VOC 复现痛点派生 · 待验证假设）\n\n- [证据推导] 改进方向：针对买家反馈的「表面滑」问题——多位买家反馈垫子过滑。（证据：amazon-content:hash-a）");
    expect(buildBriefMarkdown(baseBrief({ vocRequirements: [] }))).toContain("## 改进方向（VOC 复现痛点派生 · 待验证假设）\n\n（空）");
    expect(buildBriefMarkdown(baseBrief())).toContain("## 改进方向（VOC 复现痛点派生 · 待验证假设）\n\n（空）");
  });

  it("空章节显示「（空）」而不是被删除", () => {
    const markdown = buildBriefMarkdown(baseBrief());
    expect(markdown).toContain("## 研报提出的用户问题（证据待核实）\n\n（空）");
    expect(markdown).toContain("## 产品开发确认事项\n\n（空）");
  });

  it("证据行随行标注性质与验证状态；规格行带单位与验证状态", () => {
    const markdown = buildBriefMarkdown(
      baseBrief({
        specifications: [{ id: "spec_1", label: "单品尺寸", value: "10×5×3", unit: "cm", nature: "FACT", verification: "unverified", evidenceRefs: ["evidence:ev-1"] }],
        confirmationItems: [{ id: "cfq_1", item: "起订量（MOQ）与阶梯报价是否满足首单需求", status: "待确认", reason: "需要供应商确认" }],
      }),
    );
    expect(markdown).toContain("- 单品尺寸：10×5×3 cm｜[参考记录｜未验证]（证据：evidence:ev-1）");
    expect(markdown).toContain("- 起订量（MOQ）与阶梯报价是否满足首单需求｜状态：待确认｜说明：需要供应商确认");
  });

  it("竞品对照不能导出为确认事实；来源备注保留但标为待确认", () => {
    const markdown = buildBriefMarkdown(baseBrief({
      benchmarkComparison: {
        rows: [
          { id: "cmp_price", label: "价格", ours: "10 USD", theirs: "9.99 USD", nature: "FACT", note: "对照资料来自研究来源商品 B0SOURCE；不是拟开发商品的已确认事实。" },
          { id: "cmp_custom", label: "差异点", ours: "更厚", theirs: null, nature: "FACT", note: null },
        ],
      },
    }));
    expect(markdown).toContain("价格｜本品：10 USD｜对照基准：9.99 USD｜[来源对照记录（待确认）]");
    expect(markdown).toContain("差异点｜本品：更厚｜对照基准：未采集｜[待确认假设]");
    expect(markdown).not.toContain("价格｜本品：10 USD｜对照基准：9.99 USD｜[确认事实]");
  });

  it("脚注包含 sourceBinding 四哈希与修订号，并声明未调用外部 AI", () => {
    const markdown = buildBriefMarkdown(baseBrief());
    expect(markdown).toContain("taskId=task-1");
    expect(markdown).toContain("reportHash=reporthash-abc");
    expect(markdown).toContain("factHash=facthash-abc");
    expect(markdown).toContain("evidenceHash=evidencehash-abc");
    expect(markdown).toContain("rev.3");
    expect(markdown).toContain("未调用外部 AI");
  });

  it("P3-03：经济性导出显式区分商品事实、人工输入和研究估算来源", () => {
    const markdown = buildBriefMarkdown(baseBrief({
      economics: {
        ...baseBrief().economics,
        targetPrice: 29.9,
        targetMarginPct: 25,
        referralFee: 4.2,
        provenance: {
          targetPrice: { origin: "PRODUCT_FACT", source: "ProductFact.basic.price", note: "仅作目标价草案" },
          targetMarginPct: { origin: "USER_INPUT", source: "product-brief-owner", note: "Owner 在需求单中填写或调整该项。" },
          referralFee: { origin: "RESEARCH_ESTIMATE", source: "03.unitEconomics", note: "需人工核对平台费率。" },
        },
      },
    }));
    expect(markdown).toContain("目标售价：29.9 USD｜性质：商品事实｜来源：ProductFact.basic.price｜说明：仅作目标价草案");
    expect(markdown).toContain("目标毛利率：25%｜性质：人工输入｜来源：product-brief-owner");
    expect(markdown).toContain("平台佣金（Referral fee）：4.2｜性质：03研究/估算｜来源：03.unitEconomics");
  });

  it("P3-01-B：新版研究继承字段全部进入同一份 Markdown Brief", () => {
    const markdown = buildBriefMarkdown(baseBrief({
      competitiveHypotheses: [{ text: "竞品因包装限制而没有解决问题", nature: "EVIDENCE_DERIVED", evidenceRefs: ["evidence:comp"] }],
      researchAlternatives: [{ text: "保留现状作为对照组", nature: "EVIDENCE_DERIVED", evidenceRefs: ["evidence:alt"] }],
      supportingEvidence: [{ text: "评论反复提到该问题", nature: "EVIDENCE_DERIVED", evidenceRefs: ["evidence:support"] }],
      counterevidence: [{ text: "高温环境下可能失效", nature: "EVIDENCE_DERIVED", evidenceRefs: ["evidence:counter"] }],
      researchAssumptions: [{ text: "用户是否愿意支付溢价尚未验证", nature: "ASSUMPTION", evidenceRefs: [] }],
      verificationPlan: [{ id: "v1", item: "做两周对照测试", method: "对照实验", timing: "样品阶段", status: "pending" }],
    }));
    expect(markdown).toContain("## 竞争性因果假设（研究来源）");
    expect(markdown).toContain("竞品因包装限制而没有解决问题");
    expect(markdown).toContain("## 竞争方案与保留现状备选（研究来源）");
    expect(markdown).toContain("## 支持当前解释的证据（研究来源）");
    expect(markdown).toContain("## 反证 / 可能推翻点（研究来源）");
    expect(markdown).toContain("高温环境下可能失效");
    expect(markdown).toContain("## 研究未验证假设（不得当作事实）");
    expect(markdown).toContain("用户是否愿意支付溢价尚未验证");
  });

  it("positioning/userScenarios 段随行导出；显式 null 定位不出现空引用", () => {
    const markdown = buildBriefMarkdown(
      baseBrief({
        positioning: { text: "以加固结构为核心卖点", nature: "EVIDENCE_DERIVED", evidenceRefs: ["evidence:ev-9"] },
        userScenarios: [{ text: "露营保温场景", nature: "EVIDENCE_DERIVED", evidenceRefs: ["evidence:ev-10"] }],
      }),
    );
    expect(markdown).toContain("产品定位：[证据推导] 以加固结构为核心卖点");
    expect(markdown).toContain("- [证据推导] 露营保温场景（证据：evidence:ev-10）");
    expect(buildBriefMarkdown(baseBrief())).not.toContain("产品定位：");
  });

  it("P2-02：逐原因调查进入 Markdown 时保留假设性质、为什么提出与各自验证", () => {
    const markdown = buildBriefMarkdown(baseBrief({
      causalInvestigations: [{
        hypothesis: { text: "漏水可能来自密封圈装配误差", nature: "ASSUMPTION", evidenceRefs: ["evidence:cause-1"] },
        rationale: { text: "多条评论在首次使用后即渗水", nature: "EVIDENCE_DERIVED", evidenceRefs: ["evidence:obs-1"] },
        supportingEvidence: [{ text: "评论提到首次使用即渗水", nature: "EVIDENCE_DERIVED", evidenceRefs: ["evidence:support-1"] }],
        counterevidence: [{ text: "低频使用场景未复现", nature: "EVIDENCE_DERIVED", evidenceRefs: ["evidence:counter-1"] }],
        unknowns: ["缺少拆解记录"],
        confidence: "medium",
        verification: ["抽 10 件做静置与倾斜测试"],
      }],
    }));
    expect(markdown).toContain("## 逐项原因调查（AI 假设，证据需人工核实）");
    expect(markdown).toContain("### 原因 1：漏水可能来自密封圈装配误差（待验证）");
    expect(markdown).toContain("为什么提出：多条评论在首次使用后即渗水");
    expect(markdown).toContain("AI 可信度估计：medium（并非事实确认）");
    expect(markdown).toContain("反证线索：");
    expect(markdown).toContain("低频使用场景未复现");
    expect(markdown).toContain("未知：缺少拆解记录");
    expect(markdown).toContain("验证：抽 10 件做静置与倾斜测试");
  });

  it("P2-02：原因缺少支持或反证时导出显式写未知，不省略缺口", () => {
    const markdown = buildBriefMarkdown(baseBrief({
      causalInvestigations: [{
        hypothesis: { text: "可能是包装导致", nature: "ASSUMPTION", evidenceRefs: ["evidence:cause-2"] },
        supportingEvidence: [],
        counterevidence: [],
        unknowns: [],
        confidence: "unknown",
        verification: [],
      }],
    }));
    expect(markdown).toContain("支持线索：未知");
    expect(markdown).toContain("反证线索：未知");
    expect(markdown).toContain("验证：未提供");
  });

  it("P3-03：目标售价/毛利率/佣金/物流的导出值与来源分类与持久化一致，缺失项不填 0", () => {
    const markdown = buildBriefMarkdown(baseBrief({
      economics: {
        ...baseBrief().economics,
        targetPrice: 29.99,
        targetMarginPct: 30,
        referralFee: 15,
        fbaFee: null,
        logistics: 3.2,
        estimatedTax: null,
        otherKnownCosts: null,
        currency: "USD",
        provenance: {
          targetPrice: { origin: "USER_INPUT", source: "product-brief-owner", note: "Owner 在需求单中填写或调整该项。" },
          targetMarginPct: { origin: "USER_INPUT", source: "product-brief-owner", note: "Owner 在需求单中填写或调整该项。" },
          referralFee: { origin: "USER_INPUT", source: "candidateAnalysisContext.commercialInputs.commissionRate", note: "来自人工商业输入。" },
          logistics: { origin: "USER_INPUT", source: "user_input", note: "按单件头程费用直接计入。" },
          fbaFee: { origin: "MISSING", source: null, note: "尚未提供。" },
        },
      },
    }));
    expect(markdown).toContain("- 目标售价：29.99 USD｜性质：人工输入｜来源：product-brief-owner");
    expect(markdown).toContain("- 目标毛利率：30%｜性质：人工输入｜来源：product-brief-owner");
    expect(markdown).toContain("- 平台佣金（Referral fee）：15｜性质：人工输入｜来源：candidateAnalysisContext.commercialInputs.commissionRate");
    expect(markdown).toContain("- 物流：3.2｜性质：人工输入｜来源：user_input");
    // 缺失项必须写「未提供」并标性质，不能填 0 或省略来源
    expect(markdown).toContain("- FBA 费用：未提供｜性质：未提供");
    expect(markdown).not.toContain("- FBA 费用：0");
  });

  it("改良假设章节：把原因假设推进到可开发化，并区分假设/供应商确认/开发验证", () => {
    const brief = baseBrief({
      differentiation: [
        { text: "改善硅胶表面处理以降低油污附着", nature: "ASSUMPTION", evidenceRefs: ["evidence:1"] },
        { text: "更换外包装纸箱材质以降低运输破损", nature: "ASSUMPTION", evidenceRefs: ["evidence:2"] },
      ],
      causalInvestigations: [{
        hypothesis: { text: "假设 A：硅胶表面特性导致油污附着，清洗困难", nature: "ASSUMPTION", evidenceRefs: ["evidence:1"] },
        rationale: { text: "多条评论同时提到清洗困难与表面发黏", nature: "EVIDENCE_DERIVED", evidenceRefs: ["evidence:1"] },
        supportingEvidence: [
          { text: "评论提到清洗费时", nature: "EVIDENCE_DERIVED", evidenceRefs: ["evidence:1"] },
          { text: "评论提到表面发黏", nature: "EVIDENCE_DERIVED", evidenceRefs: ["evidence:2"] },
        ],
        counterevidence: [],
        unknowns: ["未测量表面能"],
        confidence: "low",
        verification: ["同条件 A/B 对照：只改表面处理，观察一次清洗后的残留量"],
      }],
    });
    const markdown = buildBriefMarkdown(brief);
    expect(markdown).toContain("## 改良假设（可开发化 · 根因未确认）");
    expect(markdown).toContain("归因分类：材料与表面");
    expect(markdown).toContain("ROOT_CAUSE_UNVERIFIED");
    // 三分法：假设 / 供应商确认事项 / 开发验证要求 必须各自成段
    expect(markdown).toContain("**待验证假设（不是开发要求）**");
    expect(markdown).toContain("**供应商确认事项（通用检查模板，非本商品结论）**");
    expect(markdown).toContain("**开发验证要求（研究已给出的动作）**");
    // 只关联有真实词重叠的方向，不把包装问题挂到材料原因上
    expect(markdown).toContain("研报相关差异化方向：改善硅胶表面处理以降低油污附着");
    expect(markdown).not.toContain("研报相关差异化方向：更换外包装纸箱材质以降低运输破损");
    // 不产生供应链数值
    expect(markdown).not.toMatch(/MOQ[:：]\s*\d/u);
  });

  it("没有原因假设时，改良假设章节不出现，避免伪造改良方向", () => {
    const markdown = buildBriefMarkdown(baseBrief());
    expect(markdown).not.toContain("## 改良假设（可开发化 · 根因未确认）");
  });

  it("Markdown 自带派生规则版本与摘要，且声明不等于研报 / 需求单版本", () => {
    const brief = baseBrief({
      causalInvestigations: [{
        hypothesis: { text: "假设 A：硅胶表面特性导致油污附着，清洗困难", nature: "ASSUMPTION", evidenceRefs: ["evidence:1"] },
        supportingEvidence: [{ text: "评论提到清洗费时", nature: "EVIDENCE_DERIVED", evidenceRefs: ["evidence:1"] }],
        counterevidence: [],
        unknowns: ["未测量表面能"],
        confidence: "low",
        verification: ["样品清洗测试"],
      }],
    });
    const markdown = buildBriefMarkdown(brief);
    expect(markdown).toContain("派生规则版本：improvement-plan.rules.v3");
    expect(markdown).toMatch(/派生摘要：ipd-[0-9a-f]{8}/);
    expect(markdown).toContain("不等于研报版本，也不等于需求单版本");
  });

  it("市场层原因不输出三分法与候选对象，只给「不派生」与研报验证动作", () => {
    const brief = baseBrief({
      causalInvestigations: [{
        hypothesis: { text: "子类头部位置主要来自同父体 11 个变体共享流量与评论", nature: "ASSUMPTION", evidenceRefs: ["evidence:1"] },
        supportingEvidence: [{ text: "父体变体评论合并展示", nature: "EVIDENCE_DERIVED", evidenceRefs: ["evidence:1"] }],
        counterevidence: [],
        unknowns: ["无法区分评论归属"],
        confidence: "unknown",
        verification: ["获取父体下各变体的评论归属与流量占比"],
      }],
    });
    const markdown = buildBriefMarkdown(brief);
    expect(markdown).toContain("不派生产品改良对象");
    expect(markdown).toContain("回到 02 市场研究");
    expect(markdown).not.toContain("**待验证假设（不是开发要求）**");
    expect(markdown).not.toContain("候选改良对象（模板候选，需人工/供应商确认）");
    // 但研报已给出的验证动作不能丢
    expect(markdown).toContain("获取父体下各变体的评论归属与流量占比");
  });

  it("L 历史需求单缺少 causalInvestigations 时不崩溃，也不生成改良章节", () => {
    const legacy = { ...baseBrief() } as Record<string, unknown>;
    delete legacy.causalInvestigations;
    const markdown = buildBriefMarkdown(legacy as unknown as ProductBrief);
    expect(markdown).toContain("# 产品开发需求单");
    expect(markdown).not.toContain("## 改良假设（可开发化 · 根因未确认）");
  });

  it("L 历史原因条目缺 rationale / 空 unknowns 时安全派生，缺什么就写缺什么", () => {
    const legacy = {
      ...baseBrief(),
      causalInvestigations: [{
        hypothesis: { text: "卡扣容易断裂导致退货增加", nature: "ASSUMPTION", evidenceRefs: [] },
        supportingEvidence: [],
        counterevidence: [],
        unknowns: [],
        confidence: "unknown",
        verification: [],
      }],
    } as unknown as ProductBrief;
    const markdown = buildBriefMarkdown(legacy);
    expect(markdown).toContain("## 改良假设（可开发化 · 根因未确认）");
    expect(markdown).toContain("卡扣容易断裂导致退货增加");
    // 缺 rationale 不补「为什么提出」；缺 unknowns 不编未解决事项
    expect(markdown).not.toContain("为什么提出：卡扣");
    expect(markdown).toContain("未知：未提供");
  });

  it("导出首屏就是决策摘要，且与页面同一计算来源（不是另写一套判断）", () => {
    const brief = baseBrief({ status: "READY" });
    const markdown = buildBriefMarkdown(brief);
    const summary = buildBriefDecisionSummary({ brief, plan: null, stale: false });
    expect(markdown).toContain("## 决策摘要（自动汇总，不替代人工决定）");
    expect(markdown).toContain(`- 当前决策状态：${summary.headline}`);
    // 决策摘要必须出现在项目概览之前（首屏优先）
    expect(markdown.indexOf("## 决策摘要")).toBeLessThan(markdown.indexOf("## 项目概览与定位"));
  });

  it("文档状态 READY 在导出里明确「不代表已通过立项评审」", () => {
    const markdown = buildBriefMarkdown(baseBrief({ status: "READY" }));
    expect(markdown).toContain("文档状态：待评审（READY）");
    expect(markdown).toContain("不代表已通过立项评审");
    expect(markdown).toContain("人工立项状态：无人工立项记录");
  });

  it("导出与页面共用默认事实口径：估算≠真实、已持久化≠已确认", () => {
    const markdown = buildBriefMarkdown(baseBrief());
    expect(markdown).toContain("不等于供应商或性能已验证");
    expect(markdown).toContain("不等于真实值");
    expect(markdown).toContain("进入低成本验证 ≠ 可以立项 ≠ 可以下发生产");
  });

  it("没有停止条件时导出写「需人工补充」，不编造条件", () => {
    const markdown = buildBriefMarkdown(baseBrief());
    expect(markdown).toContain("尚未形成明确停止条件，需人工补充");
  });

  it("只有 VOC 问题陈述（无原因假设）时，导出标注派生输入与来源缺口", () => {
    const markdown = buildBriefMarkdown(baseBrief({
      corePainPoints: [{ text: "首次按压角落卡扣需要较大力度，安装体验存在一定费力感。", nature: "EVIDENCE_DERIVED", evidenceRefs: ["attachment:att-1"] }],
    }));
    expect(markdown).toContain("派生输入：问题陈述（VOC 观察，无原因结论）");
    expect(markdown).toContain("来源契约披露");
    expect(markdown).toContain("### 问题陈述 1：首次按压角落卡扣需要较大力度");
    expect(markdown).not.toContain("### 改良假设 1：");
  });

  it("导出经济性按四态呈现：有值就写有值，不再与正文自相矛盾", () => {
    const brief = baseBrief({
      economics: {
        targetPrice: 15.88,
        targetMarginPct: 35,
        referralFee: 2.38,
        fbaFee: null,
        logistics: 1.2,
        estimatedTax: null,
        otherKnownCosts: null,
        currency: "USD",
        purchaseCostCeiling: { status: "NOT_COMPUTABLE", value: null, currency: "USD", formula: "x", reason: "缺 FBA 费用" },
      },
    });
    const markdown = buildBriefMarkdown(brief);
    expect(markdown).toContain("**② 商业可行性确认（值不值得开发）**");
    expect(markdown).toContain("目标毛利率：35%");
    expect(markdown).toContain("平台佣金：2.38 USD");
    expect(markdown).toContain("物流成本：1.2 USD");
    expect(markdown).toContain("FBA 费用：未提供");
    // 三分类同时存在
    expect(markdown).toContain("**① 产品问题验证**");
    expect(markdown).toContain("**③ 供应商确认（能否制造 / 代价多少）**");
  });

  it("只有问题陈述时不导出任何改良对象，只说明需先补原因", () => {
    const markdown = buildBriefMarkdown(baseBrief({
      corePainPoints: [{ text: "首次按压角落卡扣需要较大力度，安装体验存在一定费力感。", nature: "EVIDENCE_DERIVED", evidenceRefs: ["attachment:att-1"] }],
    }));
    expect(markdown).toContain("尚不足以判断具体改良方向");
    expect(markdown).not.toContain("候选改良对象（模板候选，需人工/供应商确认）：可拆结构");
    expect(markdown).not.toContain("内壁形状与转折半径");
  });

  it("有原因假设且部位明确时，导出只列相关模板并标注部位关联依据", () => {
    const markdown = buildBriefMarkdown(baseBrief({
      causalInvestigations: [{
        hypothesis: { text: "硅胶表面处理使油污附着，清洗困难", nature: "ASSUMPTION", evidenceRefs: ["evidence:1"] },
        supportingEvidence: [{ text: "评论提到清洗费时", nature: "EVIDENCE_DERIVED", evidenceRefs: ["evidence:1"] }],
        counterevidence: [],
        unknowns: ["未测量表面能"],
        confidence: "low",
        verification: ["同条件 A/B 对照"],
      }],
    }));
    expect(markdown).toContain("部位关联依据：");
    expect(markdown).toContain("候选改良对象（模板候选，需人工/供应商确认）：主体材质选型");
    expect(markdown).not.toContain("内壁形状与转折半径");
  });

  it("验证计划等历史快照标注「生成时 / 当前」，不再与上方实时经济性值打架", () => {
    const brief = baseBrief({
      verificationPlan: [
        { id: "v_1", item: "目标毛利率尚未由人工填写。", method: "", timing: "", status: "pending" },
        { id: "v_2", item: "平台 referral fee 尚未提供，购买成本上限暂不能完整计算。", method: "", timing: "", status: "pending" },
      ],
      missingValidation: ["目标毛利率尚未由人工填写。", "头程/物流成本尚未提供，不能猜测。"],
      economics: {
        targetPrice: 15.88,
        targetMarginPct: 35,
        referralFee: 2.38,
        fbaFee: null,
        logistics: 1.2,
        estimatedTax: null,
        otherKnownCosts: null,
        currency: "USD",
        purchaseCostCeiling: { status: "NOT_COMPUTABLE", value: null, currency: "USD", formula: "x", reason: "缺 FBA 费用" },
      },
    });
    const markdown = buildBriefMarkdown(brief);
    // 历史原句保留（不删记录），但必须带当前状态标注
    expect(markdown).toContain("目标毛利率尚未由人工填写。");
    expect(markdown).toContain("生成时快照（当时列为缺失）；当前：目标毛利率：35%");
    expect(markdown).toContain("平台佣金：2.38 USD");
    expect(markdown).toContain("生成时快照（当时列为缺失）；当前：物流成本：1.2 USD");
    // 仍然缺失的 FBA 不得被写成已保存
    expect(markdown).not.toContain("当前：FBA 费用：有");
    expect(markdown).toContain("验证计划（生成时快照，当前状态见「② 商业可行性确认」）");
  });

  it("导出包含竞争性解释（未验证），不是只加免责声明", () => {
    const markdown = buildBriefMarkdown(baseBrief({
      corePainPoints: [{ text: "有买家指出产品非常薄（约 2-3 毫米）。", nature: "EVIDENCE_DERIVED", evidenceRefs: ["attachment:att-1"] }],
    }));
    expect(markdown).toContain("**竞争性解释（未验证，需先区分；不是本商品已确认原因）**");
    expect(markdown).toContain("区分证据：");
    expect(markdown).toContain("品类固有设计取舍");
  });

  it("文件名由 ASIN 与修订号构成", () => {
    expect(briefFileName(baseBrief())).toBe("ProductBrief_B000000001_rev3.md");
  });
});
