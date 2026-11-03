import { describe, expect, it } from "vitest";
import {
  buildImprovementPlan,
  IMPROVEMENT_RULES_VERSION,
  type ImprovementPlanCause,
} from "./improvementPlan";

function cause(overrides: Partial<ImprovementPlanCause> = {}): ImprovementPlanCause {
  return {
    hypothesis: "假设 A：硅胶表面特性导致油污附着，清洗时需要反复擦洗。",
    rationale: "多条四星评论同时提到清洗困难与表面手感。",
    supportingEvidence: ["评论提到清洗费时", "评论提到表面发黏"],
    counterevidence: [],
    unknowns: ["未测量表面能", "未确认油温与清洗方式"],
    confidence: "low",
    verification: ["同条件 A/B 对照：只改表面处理，观察一次清洗后的残留量。"],
    ...overrides,
  };
}

const CASE5 = [
  cause({
    hypothesis: "多尺寸 3 件装组合 + 可重复使用叙事降低了替代一次性烘焙纸的门槛，支撑其子类头部位置。",
    rationale: "组合装与可重复使用同时出现在多条评论里。",
    supportingEvidence: ["评论提到省钱", "评论提到替代烘焙纸"],
    counterevidence: ["有评论称尺寸不适配"],
    unknowns: ["缺少非置顶评论"],
    verification: ["对比 3 件装与单一尺寸装两组 listing 的动机提及比例。"],
  }),
  cause({
    hypothesis: "子类头部位置主要来自同父体 11 个变体共享流量与评论，而非单一组合本身。",
    rationale: "变体结构显示同一父体下有 11 个成员。",
    supportingEvidence: ["父体下变体评论合并展示"],
    counterevidence: [],
    unknowns: ["无法区分评论归属"],
    verification: ["获取父体下各变体的评论归属与流量占比。"],
  }),
  cause({
    hypothesis: "「太滑、难彻底洗净」的体验来自硅胶表面与垫体过软导致无法施力，而非材质吸油。",
    rationale: "买家本人不确定是材质吸油还是太软。",
    supportingEvidence: ["评论提到表面太滑", "评论提到垫体太软难施力"],
    counterevidence: ["同一评论同时符合两种解释，不能作为区分性反证"],
    unknowns: ["未测量表面能", "未确认清洗方式"],
    verification: ["用同尺寸、不同厚度与不同表面处理的硅胶垫做清洗测试。"],
  }),
];

describe("buildImprovementPlan · 归因与展示纪律", () => {
  it("按假设文本归类归因，并始终标记根因未确认", () => {
    const plan = buildImprovementPlan({ causes: [cause()] });
    const item = plan.items[0]!;
    expect(item.attribution.primary).toBe("material");
    expect(item.attribution.all).toContain("material");
    expect(item.rootCauseStatus).toBe("ROOT_CAUSE_UNVERIFIED");
    expect(item.attribution.basis).toContain("材料与表面");
  });

  it("结构类假设给出结构候选改良对象，而不是材料模板", () => {
    const plan = buildImprovementPlan({
      causes: [cause({
        hypothesis: "假设 B：产品过软导致擦洗时无法施力，开口过窄使内壁成为清洁死角。",
        unknowns: ["未确认刚性阈值"],
      })],
    });
    const item = plan.items[0]!;
    expect(["ergonomics", "structure"]).toContain(item.attribution.primary);
    expect(item.candidateTargets.join()).toMatch(/刚性|握持|内壁|开口/);
  });

  it("验证动作按类别归档，未覆盖的类别进入缺失清单", () => {
    const plan = buildImprovementPlan({
      causes: [cause({ verification: ["对比竞品同类结构的开口宽度"] })],
    });
    const item = plan.items[0]!;
    expect(item.verificationTasks[0]!.category).toBe("competitor_comparison");
    expect(item.verificationTasks[0]!.source).toBe("RESEARCH");
    expect(item.missingVerificationCategories).toContain("sample_test");
    expect(item.missingVerificationCategories).not.toContain("competitor_comparison");
  });

  it("副作用 / 成本 / 合规全部标注为通用检查模板，不冒充本商品结论", () => {
    const plan = buildImprovementPlan({ causes: [cause()] });
    const item = plan.items[0]!;
    expect(item.sideEffects.every((entry) => entry.source === "TEMPLATE_CHECK")).toBe(true);
    expect(item.costUncertainties.every((entry) => entry.source === "TEMPLATE_CHECK")).toBe(true);
    expect(item.complianceChecks.every((entry) => entry.source === "TEMPLATE_CHECK")).toBe(true);
    expect(plan.disclaimer).toContain("不代表已确认根因");
  });

  it("只关联与原因有真实词重叠的差异化方向，不硬挂无关方向", () => {
    const plan = buildImprovementPlan({
      causes: [cause()],
      differentiationDirections: [
        "改善硅胶表面处理以降低油污附着",
        "更换外包装纸箱材质以降低运输破损",
      ],
    });
    const item = plan.items[0]!;
    expect(item.linkedDirections).toContain("改善硅胶表面处理以降低油污附着");
    expect(item.linkedDirections).not.toContain("更换外包装纸箱材质以降低运输破损");
  });

  it("不产生任何 MOQ / 报价 / 交期等供应链数值", () => {
    const plan = buildImprovementPlan({ causes: [cause()] });
    const text = JSON.stringify(plan);
    expect(text).not.toMatch(/\d+\s*(?:美元|元|USD|天|pcs|件起订)/u);
  });
});

describe("buildImprovementPlan · 三态可改良性闸门（A–G）", () => {
  const statusOf = (hypothesis: string) => buildImprovementPlan({ causes: [cause({ hypothesis })] }).items[0]!;

  it("A 同父体变体共享流量 → NON_PRODUCT，不派生任何改良对象", () => {
    const item = statusOf("同父体下 11 个变体共享流量，因此该 ASIN 排名靠前。");
    expect(item.actionabilityStatus).toBe("NON_PRODUCT");
    expect(item.productActionable).toBe(false);
    expect(item.candidateTargets).toEqual([]);
    expect(item.sideEffects.every((entry) => entry.text.includes("不属于产品可改良范围"))).toBe(true);
  });

  it("B 子类头部来自父体流量聚合 → NON_PRODUCT（真实 #5 第 2 条）", () => {
    const item = statusOf("子类头部位置主要来自同父体 11 个变体共享流量与评论，而非单一组合本身。");
    expect(item.actionabilityStatus).toBe("NON_PRODUCT");
    expect(item.actionabilityReason).toContain("不是产品本身的工程问题");
  });

  it("C 卡扣断裂导致流量下降 → PRODUCT_ACTIONABLE（市场词汇不得误杀产品问题）", () => {
    const item = statusOf("产品卡扣容易断裂，导致差评增加、流量下降。");
    expect(item.actionabilityStatus).toBe("PRODUCT_ACTIONABLE");
    expect(item.candidateTargets.length).toBeGreaterThan(0);
    expect(item.actionabilityBasis).toContain("卡扣");
  });

  it("D 某变体尺寸过小导致安装失败 → PRODUCT_ACTIONABLE（「变体」不是否决词）", () => {
    const item = statusOf("某变体尺寸过小，导致用户安装失败。");
    expect(item.actionabilityStatus).toBe("PRODUCT_ACTIONABLE");
    expect(item.candidateTargets.join()).toMatch(/尺寸|安装|过小|容量/);
  });

  it("E 产品与市场因素同时存在且无法区分 → MIXED_OR_UNCERTAIN，不派生确定对象", () => {
    const item = statusOf("同父体变体共享流量与评论，同时内壁结构可能导致清洗困难，两者无法区分。");
    expect(item.actionabilityStatus).toBe("MIXED_OR_UNCERTAIN");
    expect(item.productActionable).toBe(false);
    expect(item.candidateTargets).toEqual([]);
    expect(item.actionabilityReason).toContain("人工拆分");
    // 原始研究信息不得丢失：验证动作与未知仍然保留
    expect(item.unknowns.length).toBeGreaterThan(0);
  });

  it("F 硅胶表面与垫体过软导致清洗困难 → PRODUCT_ACTIONABLE（真实 #5 第 3 条）", () => {
    const item = statusOf("「太滑、难彻底洗净」的体验来自硅胶表面与垫体过软导致无法施力，而非材质吸油。");
    expect(item.actionabilityStatus).toBe("PRODUCT_ACTIONABLE");
    expect(item.attribution.primary).toBe("material");
    expect(item.verificationTasks.length).toBeGreaterThan(0);
  });

  it("G 假设本身是产品问题，但 unknowns 含「评论归属」→ 不得被误杀", () => {
    const plan = buildImprovementPlan({
      causes: [cause({
        hypothesis: "垫体过软导致施力困难，清洗时需要反复擦洗。",
        unknowns: ["评论归属无法区分", "同父体变体共享流量情况未知"],
      })],
    });
    const item = plan.items[0]!;
    // 关键：仍判产品问题（不被 unknowns 里的市场词误杀）
    expect(item.actionabilityStatus).toBe("PRODUCT_ACTIONABLE");
    expect(item.productActionable).toBe(true);
    // 但文本里没有可锚定的具体部位（材质/表面/内壁…），因此不硬给模板，转为要求人工确认
    expect(["ANCHORED", "UNRESOLVED"]).toContain(item.targetStatus);
  });

  it("完全没有可识别线索时拒绝派生（MIXED），而不是硬给一个改良部位", () => {
    const item = statusOf("说不清的某种原因。");
    expect(item.actionabilityStatus).toBe("MIXED_OR_UNCERTAIN");
    expect(item.candidateTargets).toEqual([]);
    expect(item.attribution.primary).toBe("unclassified");
  });

  it("「市场结构」复合词不会被数成产品「结构」线索", () => {
    const item = statusOf("该子类的市场结构决定了新进入者难以获得曝光。");
    expect(item.actionabilityStatus).toBe("NON_PRODUCT");
    expect(item.attribution.primary).toBe("unclassified");
  });

  it("v1 读侧投影标签不参与判定（否则「不能确认因果」会把市场假设读成混合问题）", () => {
    const prefix = "【待验证原因假设】【待验证假设：引用仅关联触发观察，不能确认因果或工程原因；需以支持、反证及验证动作检验该假设。】";
    const market = buildImprovementPlan({
      causes: [cause({ hypothesis: `${prefix}子类头部位置主要来自同父体 11 个变体共享流量与评论，而非单一组合本身。` })],
    }).items[0]!;
    expect(market.actionabilityStatus).toBe("NON_PRODUCT");
    // 展示原文保持不变：只影响判定，不改写研究文本
    expect(market.hypothesis.startsWith("【待验证原因假设】")).toBe(true);

    const product = buildImprovementPlan({
      causes: [cause({ hypothesis: `${prefix}「太滑、难彻底洗净」的体验来自硅胶表面与垫体过软导致无法施力，而非材质吸油。` })],
    }).items[0]!;
    expect(product.actionabilityStatus).toBe("PRODUCT_ACTIONABLE");
    expect(product.candidateTargets.length).toBeGreaterThan(0);
  });
});

describe("buildImprovementPlan · 计划状态（H/I/J）", () => {
  it("H 无支持线索 → NEEDS_MORE_EVIDENCE，且状态文案不允许进入开发", () => {
    const plan = buildImprovementPlan({ causes: [cause({ supportingEvidence: [], counterevidence: [] })] });
    expect(plan.items[0]!.evidence.level).toBe("no_support");
    expect(plan.status).toBe("NEEDS_MORE_EVIDENCE");
    expect(plan.statusLabel).toBe("证据不足，先补证据");
  });

  it("I 存在反证 → conflicting，保留反证提示且计划不给「可进入验证」", () => {
    const plan = buildImprovementPlan({ causes: [cause({ counterevidence: ["有评论称清洗很方便"] })] });
    expect(plan.items[0]!.evidence.level).toBe("conflicting");
    expect(plan.items[0]!.evidence.levelLabel).toContain("存在反证线索");
    expect(plan.items[0]!.evidence.counterCount).toBe(1);
    expect(plan.status).toBe("NEEDS_VERIFICATION");
    expect(plan.statusReason).toContain("必须先做区分性验证");
    expect(plan.statusReason).toContain("≠ 可以立项");
  });

  it("J 全部为市场问题 → NO_PRODUCT_ACTIONABLE_CAUSE，归因分布为空", () => {
    const plan = buildImprovementPlan({
      causes: [
        cause({ hypothesis: "价格带定位与广告投放决定其排名。" }),
        cause({ hypothesis: "同父体变体共享流量支撑其子类头部位置。" }),
      ],
    });
    expect(plan.status).toBe("NO_PRODUCT_ACTIONABLE_CAUSE");
    expect(plan.statusReason).toContain("回到 02 市场研究");
    expect(plan.attributionCounts).toEqual([]);
    expect(plan.items.every((item) => item.candidateTargets.length === 0)).toBe(true);
  });

  it("全部无法确认归属 → MIXED_NEEDS_HUMAN_SPLIT，不冒充「仅有市场原因」", () => {
    const plan = buildImprovementPlan({ causes: [cause({ hypothesis: "说不清的某种原因。" })] });
    expect(plan.status).toBe("MIXED_NEEDS_HUMAN_SPLIT");
    expect(plan.statusReason).toContain("人工拆分");
  });

  it("真实 #5 三条假设：前两条非产品、第三条产品，计划仍按最弱环节给出需验证", () => {
    const plan = buildImprovementPlan({ causes: CASE5 });
    expect(plan.items.map((item) => item.actionabilityStatus)).toEqual([
      "NON_PRODUCT",
      "NON_PRODUCT",
      "PRODUCT_ACTIONABLE",
    ]);
    expect(plan.actionabilityCounts).toEqual([
      { status: "PRODUCT_ACTIONABLE", label: "产品问题（可改良）", count: 1 },
      { status: "NON_PRODUCT", label: "非产品问题（市场 / 运营层）", count: 2 },
    ]);
    expect(plan.attributionCounts).toHaveLength(1);
    expect(plan.status).toBe("NEEDS_VERIFICATION");
    // 03 卡片此前把 NEEDS_VERIFICATION 标成「可进入低成本验证」，与「不能直接进入开发」自相矛盾
    expect(plan.statusLabel).toBe("需先做区分性验证");
    expect(plan.statusLabel).not.toContain("可进入低成本验证");
  });

  it("没有原因假设时返回 NO_ACTIONABLE_CAUSE，而不是伪造一条改良方向", () => {
    const plan = buildImprovementPlan({ causes: [] });
    expect(plan.status).toBe("NO_ACTIONABLE_CAUSE");
    expect(plan.items).toEqual([]);
    expect(plan.statusReason).toContain("不要在此状态下编写开发要求");
  });

  it("多条一致线索 + 有验证动作时判 READY，但明示不等于立项 / 不等于可生产", () => {
    const plan = buildImprovementPlan({ causes: [cause()] });
    expect(plan.status).toBe("READY_FOR_LOW_COST_VALIDATION");
    expect(plan.statusLabel).toContain("≠ 可以立项");
    expect(plan.statusReason).toContain("≠ 可以下发生产");
  });
});

describe("buildImprovementPlan · 证据线索口径（不包装成可信度）", () => {
  it("多线索仍然只称「线索」，并给出不可外推的解读边界", () => {
    const plan = buildImprovementPlan({ causes: [cause()] });
    const evidence = plan.items[0]!.evidence;
    expect(evidence.summaryLabel).toBe("证据线索概况");
    expect(evidence.levelLabel).toContain("线索");
    expect(evidence.levelLabel).not.toContain("可信");
    expect(evidence.basis).toContain("按已持久化线索计数");
    expect(evidence.scopeNote).toContain("不是独立证据数");
    expect(evidence.scopeNote).toContain("统计显著性");
    // 模型自报的 confidence 只作为附带信息，不参与强度计算
    expect(evidence.modelConfidence).toBe("low");
    expect(evidence.level).toBe("multiple_mentions");
  });

  it("不输出任何「独立买家 / 独立证据」的可信度措辞", () => {
    const plan = buildImprovementPlan({ causes: CASE5 });
    const text = JSON.stringify(plan);
    expect(text).not.toContain("可信度评分");
    expect(text).not.toContain("独立买家数：");
  });
});

describe("buildImprovementPlan · 规则版本（K）", () => {
  it("派生结果携带规则版本、说明与稳定摘要", () => {
    const plan = buildImprovementPlan({ causes: CASE5 });
    expect(plan.rulesVersion).toBe(IMPROVEMENT_RULES_VERSION);
    expect(plan.rulesVersion).toBe("improvement-plan.rules.v3");
    expect(plan.rulesVersionNote).toContain("不等于研报版本");
    expect(plan.derivationDigest).toMatch(/^ipd-[0-9a-f]{8}$/);
  });

  it("同一输入 → 同一摘要；输入变化 → 摘要变化（可用于比对历史派生）", () => {
    const first = buildImprovementPlan({ causes: CASE5 });
    const second = buildImprovementPlan({ causes: CASE5 });
    expect(second.derivationDigest).toBe(first.derivationDigest);
    const changed = buildImprovementPlan({ causes: [CASE5[0]!, CASE5[1]!, cause()] });
    expect(changed.derivationDigest).not.toBe(first.derivationDigest);
  });

  it("规则版本不影响研报/需求单字段：只在派生对象上出现", () => {
    const plan = buildImprovementPlan({ causes: [cause()] });
    expect(plan.schema).toBe("improvement-plan.v1");
    expect(Object.keys(plan)).toEqual(expect.arrayContaining(["rulesVersion", "rulesVersionNote", "derivationDigest"]));
  });
});

describe("buildImprovementPlan · v5 问题陈述输入（无原因假设层）", () => {
  const DISCLOSURE = {
    sourceKind: "v5" as const,
    missingFacts: ["原因假设（competitionInsight.causalInvestigations）", "假设提出理由（rationale）", "验证动作（verification）"],
  };

  it("只有问题陈述时给出 OBSERVATION_ONLY，而不是伪造原因假设", () => {
    const plan = buildImprovementPlan({
      observations: [{ statement: "首次按压角落卡扣需要较大力度，安装体验存在一定费力感。", evidenceRefs: ["attachment:att-1"] }],
      sourceDisclosure: DISCLOSURE,
    });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.inputKind).toBe("PROBLEM_OBSERVATION");
    expect(plan.items[0]!.rootCauseStatus).toBe("ROOT_CAUSE_UNVERIFIED");
    expect(plan.status).toBe("OBSERVATION_ONLY");
    expect(plan.statusLabel).toContain("仅有问题陈述");
    expect(plan.statusReason).toContain("没有逐项原因假设");
    expect(plan.inputKinds).toEqual(["PROBLEM_OBSERVATION"]);
  });

  it("问题陈述仍过三态闸门：产品问题给模板方向，市场问题不给", () => {
    const plan = buildImprovementPlan({
      observations: [
        { statement: "首次按压角落卡扣需要较大力度，安装体验存在一定费力感。", evidenceRefs: ["a"] },
        { statement: "同父体 11 个变体共享流量与评论，因此该 ASIN 排名靠前。", evidenceRefs: ["b"] },
        { statement: "同父体变体共享流量，同时内壁结构可能导致清洗困难，两者无法区分。", evidenceRefs: ["c"] },
      ],
      sourceDisclosure: DISCLOSURE,
    });
    expect(plan.items[0]!.actionabilityStatus).toBe("PRODUCT_ACTIONABLE");
    // 只有问题陈述、没有原因假设：仍然不输出任何改良对象
    expect(plan.items[0]!.candidateTargets).toEqual([]);
    expect(plan.items[0]!.targetStatus).toBe("BLOCKED_BY_MISSING_CAUSE");
    expect(plan.items[1]!.actionabilityStatus).toBe("NON_PRODUCT");
    expect(plan.items[1]!.candidateTargets).toEqual([]);
    expect(plan.items[2]!.actionabilityStatus).toBe("MIXED_OR_UNCERTAIN");
    expect(plan.items[2]!.candidateTargets).toEqual([]);
    expect(plan.actionabilityCounts.map((entry) => entry.status)).toEqual(["PRODUCT_ACTIONABLE", "NON_PRODUCT", "MIXED_OR_UNCERTAIN"]);
  });

  it("v5 没有验证动作字段：不写建议动作冒充研究结论，并明确缺什么", () => {
    const plan = buildImprovementPlan({
      observations: [{ statement: "卡扣需要较大力度才能按压到位。", evidenceRefs: ["a"] }],
      sourceDisclosure: DISCLOSURE,
    });
    const item = plan.items[0]!;
    expect(item.verificationTasks).toEqual([]);
    expect(item.unknowns).toEqual([]);
    expect(item.missingVerificationCategories.length).toBeGreaterThan(0);
    expect(item.evidence.scopeNote).toContain("缺失不等于没有");
    expect(plan.sourceDisclosure?.missingFacts).toContain("验证动作（verification）");
    expect(plan.sourceDisclosure?.note).toContain("不补造");
  });

  it("引用条数只作线索计数：0 条引用时不给多线索结论", () => {
    const plan = buildImprovementPlan({
      observations: [{ statement: "有买家反馈尺寸偏小。", evidenceRefs: [] }],
      sourceDisclosure: DISCLOSURE,
    });
    expect(plan.items[0]!.evidence.level).toBe("no_support");
    expect(plan.items[0]!.evidence.supportingCount).toBe(0);
  });

  it("原因假设 + 问题陈述可共存，inputKinds 同时列出且摘要随输入种类变化", () => {
    const onlyObservations = buildImprovementPlan({
      observations: [{ statement: "卡扣需要较大力度。", evidenceRefs: ["a"] }],
      sourceDisclosure: DISCLOSURE,
    });
    const withCauses = buildImprovementPlan({
      causes: [cause()],
      observations: [{ statement: "卡扣需要较大力度。", evidenceRefs: ["a"] }],
    });
    expect(withCauses.inputKinds).toEqual(["CAUSE_HYPOTHESIS", "PROBLEM_OBSERVATION"]);
    expect(withCauses.items.map((item) => item.inputKind)).toEqual(["CAUSE_HYPOTHESIS", "PROBLEM_OBSERVATION"]);
    expect(withCauses.derivationDigest).not.toBe(onlyObservations.derivationDigest);
  });

  it("全部问题陈述都是市场层时仍判 NO_PRODUCT_ACTIONABLE_CAUSE，不给候选方向", () => {
    const plan = buildImprovementPlan({
      observations: [{ statement: "价格带定位与广告投放决定其排名。", evidenceRefs: ["a"] }],
      sourceDisclosure: DISCLOSURE,
    });
    expect(plan.status).toBe("NO_PRODUCT_ACTIONABLE_CAUSE");
    expect(plan.items[0]!.candidateTargets).toEqual([]);
  });
});

describe("候选对象部位锚点（rules.v3：不输出无关模板）", () => {
  it("卡扣安装费力（只有问题陈述）：不派生任何改良对象，只记录涉及部位并要求先补原因", () => {
    const plan = buildImprovementPlan({
      observations: [{ statement: "首次按压角落卡扣需要较大力度，安装体验存在一定费力感。", evidenceRefs: ["a"] }],
    });
    const item = plan.items[0]!;
    expect(item.actionabilityStatus).toBe("PRODUCT_ACTIONABLE");
    expect(item.targetStatus).toBe("BLOCKED_BY_MISSING_CAUSE");
    expect(item.candidateTargets).toEqual([]);
    expect(item.partAnchors).toContain("卡扣");
    expect(item.targetNote).toContain("尚不足以判断具体改良方向");
    expect(item.candidateTargets.join()).not.toMatch(/内壁|底部|密封|可拆结构/);
  });

  it("有原因假设但只有宽泛类别、没有部位词时，不输出任何模板并要求人工确认部位", () => {
    const plan = buildImprovementPlan({
      causes: [cause({ hypothesis: "结构设计存在明显问题，用户抱怨难以使用。", unknowns: [] })],
    });
    const item = plan.items[0]!;
    expect(item.actionabilityStatus).toBe("PRODUCT_ACTIONABLE");
    expect(item.targetStatus).toBe("UNRESOLVED");
    expect(item.candidateTargets).toEqual([]);
    expect(item.targetNote).toContain("现有规则不足以确定具体改良部位");
    expect(item.partAnchors).toEqual([]);
  });

  it("有原因假设且部位词明确时，只输出对应模板（材质 + 表面）", () => {
    const plan = buildImprovementPlan({
      causes: [cause({ hypothesis: "硅胶表面用几次就发黏，油污残留洗不掉。", unknowns: [] })],
    });
    const item = plan.items[0]!;
    expect(item.targetStatus).toBe("ANCHORED");
    expect(item.candidateTargets.length).toBeLessThanOrEqual(2);
    expect(item.candidateTargets.join()).toMatch(/材质|表面/);
    expect(item.candidateTargets.join()).not.toMatch(/内壁|开口|防呆/);
  });

  it("非产品问题不进入候选对象，targetStatus 为 NOT_APPLICABLE", () => {
    const plan = buildImprovementPlan({
      causes: [cause({ hypothesis: "同父体 11 个变体共享流量与评论，支撑子类头部位置。" })],
    });
    expect(plan.items[0]!.targetStatus).toBe("NOT_APPLICABLE");
    expect(plan.items[0]!.candidateTargets).toEqual([]);
  });
});

describe("问题性质与竞争性解释（P5-v6）", () => {
  it("「薄」类问题被标为属性观察，并给出竞品/成本/规格差异等竞争性解释", () => {
    const plan = buildImprovementPlan({
      observations: [{ statement: "有买家指出产品非常薄（约 2-3 毫米），描述中未提及厚度。", evidenceRefs: ["a"] }],
    });
    const item = plan.items[0]!;
    expect(item.problemNature).toBe("PROPERTY_OBSERVATION");
    expect(item.competitiveExplanations.length).toBeGreaterThan(0);
    expect(item.competitiveExplanations.map((entry) => entry.label).join()).toMatch(/品类固有|价格段|宣传与实测/);
    // 竞争性解释必须带区分证据，不能只是免责声明
    expect(item.competitiveExplanations.every((entry) => entry.discriminatingEvidence.length > 0)).toBe(true);
    // 属性观察仍然没有改良对象
    expect(item.candidateTargets).toEqual([]);
  });

  it("「卡扣需要较大力度」判为使用难度观察，不当作属性缺陷", () => {
    const plan = buildImprovementPlan({
      observations: [{ statement: "首次按压角落卡扣需要较大力度，安装体验存在一定费力感。", evidenceRefs: ["a"] }],
    });
    const item = plan.items[0]!;
    expect(item.problemNature).toBe("UNCLEAR");
    expect(item.competitiveExplanations.map((entry) => entry.label).join()).toMatch(/首次使用|操作角度|结构公差/);
    expect(item.targetStatus).toBe("BLOCKED_BY_MISSING_CAUSE");
  });

  it("「实测 47 英寸短于宣传 48 英寸」保留为缺陷主张（未达规格）", () => {
    const plan = buildImprovementPlan({
      observations: [{ statement: "有买家反馈收到的产品实测为47英寸，短于宣传的48英寸。", evidenceRefs: ["a"] }],
    });
    expect(plan.items[0]!.problemNature).toBe("DEFECT_CLAIM");
  });
});
