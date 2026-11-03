/**
 * V6 商业可行性与产品机会判断框架（纯展示与状态投影层）
 * 
 * 架构红线：
 * 1. 只消费已有 ProductFact、EvidenceStore、ResearchReport、VOC 数据，不建立第二事实库。
 * 2. 严格区分四层信息：已确认事实、买家原声、AI推断、商业风险与数据缺口，禁止混淆。
 * 3. 所有字段强制归入三态之一：AVAILABLE / ESTIMATED / DATA_MISSING，禁止编造成本或填零。
 * 4. 禁止商业评分，禁止自动推进 PROCEED，禁止自动生成 Product Brief，维持人工控制。
 */

import { computeThemeStrength, isVocStrengthConflict, type VocThemeStrength } from "./vocThresholds";
import type { UnitEconomicsView } from "./researchContracts";
export type { VocThemeStrength } from "./vocThresholds";

export type FieldSourceState = "AVAILABLE" | "ESTIMATED" | "DATA_MISSING";

/**
 * Human Decision 真实状态投影（对齐 Canonical 5-State：PENDING/PROCEED/VALIDATE_MORE/PAUSE/DROP；
 * WATCH 为 legacy choice 直投影兜底）。未决策 = PENDING。系统建议不写入此类型。
 */
export type HumanDecisionGate = "PENDING" | "PROCEED" | "VALIDATE_MORE" | "PAUSE" | "DROP" | "WATCH";

export interface CommercialFactItem {
  readonly key: string;
  readonly label: string;
  readonly value: string | number | null;
  readonly displayValue: string;
  readonly state: FieldSourceState;
  readonly category: "product" | "market" | "logistics_cost";
  readonly note?: string;
}

export interface VocSignalItem {
  readonly text: string;
  readonly strength?: "high" | "medium" | "low" | "weak";
  /** 由 reviewCount 按项目权威阈值推导的证据强度分级（isolated/weak/recurring）。展示层必须用它，禁止自造「高频」等强度词。 */
  readonly strengthTier: VocThemeStrength;
  /** 记录声明的 strength 与按计数重算不一致时为 true（展示层应显示「异常」而非推测）。 */
  readonly strengthConflict: boolean;
  readonly reviewCount?: number;
  readonly sentiment: "positive" | "negative";
}

export interface AiInferenceItem {
  readonly id: string;
  readonly title: string;
  readonly inference: string;
  readonly premise: string;
  readonly state: FieldSourceState;
}

export interface CommercialRiskItem {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly level: "HIGH" | "MEDIUM" | "LOW";
}

export interface DataGapItem {
  readonly field: string;
  readonly category: "商品规格" | "市场竞争" | "物流费用" | "供应链成本";
  readonly impact: string;
  readonly state: "DATA_MISSING";
}

export interface CommercialFeasibilityView {
  readonly asin: string;
  readonly role?: string;
  // 1. 已确认事实
  readonly confirmedFacts: readonly CommercialFactItem[];
  // 2. 买家真实反馈（仅正式 VOC 来源；AI 研报摘要不进入本层）
  readonly buyerVoc: {
    readonly state: FieldSourceState;
    /** 正式分析快照记录的独立评论数（与主题提及次数严格区分；未知为 null） */
    readonly independentReviewCount: number | null;
    /** 各主题 reviewCount 之和——同一评论可属多个主题，不得冒充独立样本 */
    readonly themeMentionCount: number;
    readonly themeCount: number;
    readonly positiveSignals: readonly VocSignalItem[];
    readonly negativeSignals: readonly VocSignalItem[];
    readonly summary: string;
  };
  // 3. AI 推断与假设
  readonly aiInferences: readonly AiInferenceItem[];
  // 4. 商业风险与数据缺口
  readonly commercialAssessment: {
    readonly marketAttractiveness: string;
    readonly improvementOpportunity: string;
    readonly commercialRisks: readonly CommercialRiskItem[];
    readonly dataGaps: readonly DataGapItem[];
    readonly decisionSupport: {
      /** 真实 Human Decision 状态投影；未决策 = PENDING（系统建议不写入此字段） */
      readonly currentGate: HumanDecisionGate;
      readonly humanDecided: boolean;
      readonly humanDecisionDisplay: string;
      /**
       * 人工决策是否已与当前研究版本脱钩（研究/报告/事实/证据已更新，原决策需重新确认）。
       * 为 true 时，任何「验证需求单」入口都必须保持锁定——不得用旧决策冒充当前已批准状态。
       */
      readonly decisionStale: boolean;
      readonly decisionStaleReason: string | null;
      /** 系统建议（非人工决策，固定 VALIDATE_MORE） */
      readonly systemSuggestionGate: "VALIDATE_MORE";
      readonly recommendation: string;
      readonly autoProceedBlocked: true;
      readonly nextActionNote: string;
    };
  };
}

export interface BuildCommercialFeasibilityInput {
  asin: string;
  title?: string | null;
  /** 同页已有的确定性测算投影；用户输入依然不是已核实的来源事实。 */
  unitEconomics?: UnitEconomicsView | null;
  /** 由现有决策摘要提供的研究建议，不等于人工决定。 */
  recommendedNextAction?: "继续研究" | "补充数据" | "暂停" | null;
  facts?: {
    brand?: string | null;
    price?: number | null;
    currency?: string | null;
    rating?: number | null;
    reviewCount?: number | null;
    mainCategory?: string | null;
    dimensions?: string | null;
    weight?: string | null;
    material?: string | null;
    bulletPoints?: string[];
  } | null;
  marketProvenance?: {
    role?: string;
    marketScanId?: string;
    sampleHash?: string;
  } | null;
  report?: {
    summary?: string | null;
    opportunities?: ReadonlyArray<string | { text: string; evidenceRefs?: string[] }>;
    risks?: ReadonlyArray<string | { text: string; evidenceRefs?: string[] }>;
    vocAnalysis?: {
      painPoints?: ReadonlyArray<string | { text: string; evidenceRefs?: string[] }>;
      positiveSignals?: ReadonlyArray<string | { text: string; evidenceRefs?: string[] }>;
    };
  } | null;
  deepseek?: {
    status?: string;
    summary?: string | null;
    opportunities?: string[];
    risks?: string[];
    vocAnalysis?: {
      painPoints?: ReadonlyArray<string | { text: string; evidenceRefs?: string[] }>;
      positiveSignals?: ReadonlyArray<string | { text: string; evidenceRefs?: string[] }>;
    } | null;
  } | null;
  vocImprovementInsights?: {
    available: boolean;
    /** 服务端确定性派生的改进需求（仅 recurring 主题，带证据锚点） */
    requirements?: ReadonlyArray<{
      id: string;
      requirement: string;
      sourceThemeLabel: string;
      reviewCount: number;
      severityHint?: string | null;
      evidenceRefs?: readonly string[];
    }>;
    /** 服务端确定性派生的待供应商确认问题（带证据锚点） */
    checkpoints?: ReadonlyArray<{
      id: string;
      checkpoint: string;
      sourceThemeLabel: string;
      reviewCount: number;
      evidenceRefs?: readonly string[];
    }>;
    themes?: ReadonlyArray<{ label: string; summary: string; reviewCount: number; strength?: string; kind?: "pain" | "request" | "positive" }>;
    /** 正式 VOC 分析快照记录的「本样本无法证明什么」（商品级） */
    unknowns?: readonly string[];
    /** 正式 VOC 分析快照记录的「下一步研究建议」（商品级） */
    nextResearchSteps?: readonly string[];
    /** 正式 VOC 分析快照的独立评论计数（datasetSnapshot 投影） */
    reviewSnapshot?: { totalReviews?: number; reviewsUsed?: number } | null;
  } | null;
  /** 真实 Human Decision（detail.myChoice）；null/缺省 = 未决策 PENDING */
  humanDecision?: {
    choice?: "PROCEED" | "WATCH" | "DROP" | null;
    canonicalStatus?: HumanDecisionGate | null;
    scope?: "FINAL" | "TEMPORARY" | null;
    chosenAt?: string | null;
    /** 人工决策是否已与当前研究版本脱钩（由服务端 stale 判定投影，不由前端推测） */
    decisionStale?: boolean;
    decisionStaleReason?: string | null;
  } | null;
}

/**
 * 从标题/卖点提取套装数量（仅「标题字面推断」，不是结构化包装事实）。
 *
 * 语义约束：
 * - 标题出现 `4-Pack` / `3 Pack` / `2件装` 等，只作为 ESTIMATED 展示，
 *   必须注明「标题显示，尚待核实包装规格」，不得升级为 AVAILABLE 事实；
 * - 标题未标注时不按 1 件兜底，保持 DATA_MISSING（null），避免把未知包装数量
 *   当成确认的单件装并进一步污染单位价格 / 成本口径。
 */
function extractPackCount(
  title?: string | null,
  bulletPoints?: string[],
): { count: number | null; state: FieldSourceState; note?: string } {
  if (!title && (!bulletPoints || bulletPoints.length === 0)) {
    return { count: null, state: "DATA_MISSING", note: "缺少标题与卖点，包装数量未知" };
  }
  const text = `${title || ""} ${(bulletPoints || []).join(" ")}`;
  // 兼容 "4-Pack" / "4 pack" / "4件装" / "Pack of 4"
  const match = text.match(/(\d+)\s*[-–—]?\s*(?:pack|pcs|piece|set|count|片装|件装)/i)
    ?? text.match(/\bpack\s+of\s+(\d+)\b/i);
  if (match && match[1]) {
    const val = parseInt(match[1], 10);
    if (!Number.isNaN(val) && val > 0) {
      return {
        count: val,
        state: "ESTIMATED",
        note: `标题显示 ${val} 件装，尚待核实包装规格（未经结构化包装事实确认）`,
      };
    }
  }
  return { count: null, state: "DATA_MISSING", note: "标题未标注包装数量，不按 1 件兜底" };
}

/**
 * 辅助从标题提取材质。
 * 关键：标题里的材质词只是来源声明，不是已确认材料 —— 必须标 ESTIMATED 并写明"标题声明"，
 * 否则会与「已确认商品与市场事实」层混淆（P2-01）。
 */
function extractMaterial(materialFromFact?: string | null, title?: string | null): { material: string | null; state: FieldSourceState; note?: string } {
  if (materialFromFact && materialFromFact.trim()) {
    return { material: materialFromFact.trim(), state: "AVAILABLE" };
  }
  if (title) {
    if (/silicone/i.test(title)) return { material: "Silicone (硅胶)", state: "ESTIMATED", note: "来自商品标题的材质声明，未经结构化材质属性确认" };
    if (/stainless steel/i.test(title)) return { material: "Stainless Steel (不锈钢)", state: "ESTIMATED", note: "来自商品标题的材质声明，未经结构化材质属性确认" };
  }
  return { material: null, state: "DATA_MISSING" };
}

/** 辅助从标题提取品牌 */
function extractBrand(brandFromFact?: string | null, title?: string | null): { brand: string | null; state: FieldSourceState } {
  if (brandFromFact && brandFromFact.trim()) {
    return { brand: brandFromFact.trim(), state: "AVAILABLE" };
  }
  if (title) {
    const firstWord = title.trim().split(/\s+/)[0];
    if (firstWord && firstWord.length >= 3 && !/^(the|a|an|\d+|silicone|baking|nonstick|large)$/i.test(firstWord)) {
      return { brand: firstWord, state: "ESTIMATED" };
    }
  }
  return { brand: null, state: "DATA_MISSING" };
}

/**
 * 纯函数：构建商业可行性与产品机会判断四层结构
 */
export function buildCommercialFeasibility(input: BuildCommercialFeasibilityInput): CommercialFeasibilityView {
  const { asin, title, facts, marketProvenance, report, vocImprovementInsights } = input;
  const role = marketProvenance?.role;
  const hasEconomicInput = (key: string) => input.unitEconomics?.inputProvenance
    .some((line) => line.key === key && line.nature !== "MISSING") === true;

  // 1. 已确认事实 (Confirmed Facts)
  const packInfo = extractPackCount(title, facts?.bulletPoints);
  const materialInfo = extractMaterial(facts?.material, title);
  const brandInfo = extractBrand(facts?.brand, title);

  const priceVal = facts?.price ?? null;
  const ratingVal = facts?.rating ?? null;
  const reviewVal = facts?.reviewCount ?? null;
  const currencyVal = facts?.currency || "USD";

  const confirmedFacts: CommercialFactItem[] = ([
    // 商品层
    {
      key: "title",
      label: "商品标题",
      value: title || null,
      displayValue: title || "缺失 (DATA_MISSING)",
      state: title ? "AVAILABLE" : "DATA_MISSING",
      category: "product",
      note: "来源：Amazon 详情页观测",
    },
    {
      key: "price",
      label: "当前售价",
      value: priceVal,
      displayValue: priceVal !== null ? `${priceVal} ${currencyVal}` : "缺失 (DATA_MISSING)",
      state: priceVal !== null ? "AVAILABLE" : "DATA_MISSING",
      category: "product",
      note: "来源：页面快照挂牌价",
    },
    {
      key: "rating",
      label: "买家评分",
      value: ratingVal,
      displayValue: ratingVal !== null ? `${ratingVal.toFixed(1)} ★` : "缺失 (DATA_MISSING)",
      state: ratingVal !== null ? "AVAILABLE" : "DATA_MISSING",
      category: "product",
    },
    {
      key: "reviewCount",
      label: "评论基数",
      value: reviewVal,
      displayValue: reviewVal !== null ? `${reviewVal.toLocaleString()} 条` : "缺失 (DATA_MISSING)",
      state: reviewVal !== null ? "AVAILABLE" : "DATA_MISSING",
      category: "product",
    },
    {
      key: "brand",
      label: "品牌归属",
      value: brandInfo.brand,
      displayValue: brandInfo.brand || "缺失 (DATA_MISSING)",
      state: brandInfo.state,
      category: "product",
      note: brandInfo.state === "ESTIMATED" ? "推断自标题首词，未有结构化品牌凭证" : undefined,
    },
    {
      key: "material",
      label: "主体材质",
      value: materialInfo.material,
      displayValue: materialInfo.material || "缺失 (DATA_MISSING)",
      state: materialInfo.state,
      note: materialInfo.note,
      category: "product",
    },
    {
      key: "packCount",
      label: "包装规格/件数",
      value: packInfo.count,
      displayValue: packInfo.count !== null
        ? `${packInfo.count} 件装`
        : "未知 (DATA_MISSING)",
      state: packInfo.state,
      category: "product",
      note: packInfo.note,
    },
    {
      key: "dimensions",
      label: "商品尺寸",
      value: facts?.dimensions || null,
      displayValue: facts?.dimensions || "缺失 (DATA_MISSING)",
      state: facts?.dimensions ? "AVAILABLE" : "DATA_MISSING",
      category: "product",
    },
    {
      key: "mainCategory",
      label: "主营类目",
      value: facts?.mainCategory || null,
      displayValue: facts?.mainCategory || "缺失 (DATA_MISSING)",
      state: facts?.mainCategory ? "AVAILABLE" : "DATA_MISSING",
      category: "market",
    },
    // 市场层
    {
      key: "bsr",
      label: "大类/细分 BSR 排名",
      value: null,
      displayValue: "缺失 (DATA_MISSING)",
      state: "DATA_MISSING",
      category: "market",
      note: "页面证据未包含有效排名节点",
    },
    {
      key: "competition",
      label: "价格带归档（阈值）",
      value: priceVal,
      displayValue: priceVal !== null
        ? (priceVal < 8 ? "低于 $8 价位段" : priceVal < 15 ? "$8–$15 价位段" : "高于 $15 价位段")
        : "缺失 (DATA_MISSING)",
      state: priceVal !== null ? "ESTIMATED" : "DATA_MISSING",
      category: "market",
      note: "仅按固定价格阈值归档的客观价位段；不构成竞争激烈程度或刚需判断（待验证）",
    },
    // 物流与成本相关（必须保持诚实，严禁假造）
    {
      key: "weight",
      label: "单品/包装重量",
      value: facts?.weight || null,
      displayValue: facts?.weight || "缺失 (DATA_MISSING)",
      state: facts?.weight ? "AVAILABLE" : "DATA_MISSING",
      category: "logistics_cost",
    },
    {
      key: "packageDimensions",
      label: "物流外包装尺寸",
      value: null,
      displayValue: "缺失 (DATA_MISSING)",
      state: "DATA_MISSING",
      category: "logistics_cost",
      note: "缺乏外箱分段数据，无法精确计算 FBA",
    },
    {
      key: "fbaFee",
      label: "FBA 配送费用",
      value: null,
      displayValue: "缺失 (DATA_MISSING)",
      state: "DATA_MISSING",
      category: "logistics_cost",
      note: "无官方计费凭证，严禁预估",
    },
    {
      key: "cogs",
      label: "头程及采购成本",
      value: null,
      displayValue: "缺失 (DATA_MISSING)",
      state: "DATA_MISSING",
      category: "logistics_cost",
      note: "未对接供应商询价，严禁编造",
    },
    {
      key: "moq",
      label: "最小起订量 (MOQ)",
      value: null,
      displayValue: "缺失 (DATA_MISSING)",
      state: "DATA_MISSING",
      category: "logistics_cost",
      note: "未对接工厂，严禁编造",
    },
  ] satisfies CommercialFactItem[]).filter((fact) => {
    // 人工成本由同页的测算卡按原始性质展示，不在来源事实区域继续假称缺失。
    if (fact.key === "fbaFee" && hasEconomicInput("fbaFee")) return false;
    if (fact.key === "cogs" && (hasEconomicInput("procurementCost") || hasEconomicInput("shippingRate"))) return false;
    return true;
  });

  // 2. 买家真实反馈 —— 仅正式 VOC 来源（vocImprovementInsights，来自正式 vocAnalysis 记录）
  const positiveSignals: VocSignalItem[] = [];
  const negativeSignals: VocSignalItem[] = [];
  let themeMentionCount = 0;

  const formalVocAvailable = vocImprovementInsights?.available === true;
  if (formalVocAvailable && Array.isArray(vocImprovementInsights?.themes)) {
    for (const theme of vocImprovementInsights.themes) {
      themeMentionCount += theme.reviewCount || 0;
      // 上游 painPointThemes/positiveThemes 已按类目分类，优先用类目；无类目时才用关键词兜底，
      // 且先剥离“不粘”等品类正面词，避免把正向主题误判进差评层。
      const rawThemeText = `${theme.label} ${theme.summary}`;
      const isNeg = theme.kind === "positive"
        ? false
        : theme.kind === "pain"
          ? true
          : /痛点|问题|薄|小|灰|移位|粘|损坏|cheap|thin|small|dirt|smell/i.test(rawThemeText.replace(/不粘/g, ""));
      const item: VocSignalItem = {
        text: `${theme.label}：${theme.summary}`,
        strength: (theme.strength as VocSignalItem["strength"]) || (theme.reviewCount >= 4 ? "high" : "weak"),
        strengthTier: computeThemeStrength(theme.reviewCount),
        strengthConflict: isVocStrengthConflict(theme.reviewCount, theme.strength),
        reviewCount: theme.reviewCount,
        sentiment: isNeg ? "negative" : "positive",
      };
      if (isNeg) {
        negativeSignals.push(item);
      } else {
        positiveSignals.push(item);
      }
    }
  }
  // 确定性排序：提及次数降序，同次数按文本升序（保证展示与导出顺序稳定一致）
  const byMentionDesc = (a: VocSignalItem, b: VocSignalItem) =>
    (b.reviewCount ?? 0) - (a.reviewCount ?? 0) || a.text.localeCompare(b.text);
  positiveSignals.sort(byMentionDesc);
  negativeSignals.sort(byMentionDesc);

  const themeCount = vocImprovementInsights?.themes?.length ?? 0;
  const independentReviewCount = formalVocAvailable
    ? (vocImprovementInsights?.reviewSnapshot?.reviewsUsed ?? null)
    : null;
  const hasFormalVoc = formalVocAvailable && (themeCount > 0 || (independentReviewCount ?? 0) > 0);
  // AVAILABLE 只由正式 VOC 来源决定；report/deepseek 的 AI 研报摘要不升级为已确认原声
  const vocState: FieldSourceState = hasFormalVoc ? "AVAILABLE" : "DATA_MISSING";

  const vocSummary = !hasFormalVoc
    ? "尚无正式 VOC 分析记录（本层不消费 AI 研报摘要冒充原声）。这不等于商品没有评论证据：已合法采集的评论附件由「VOC 痛点」层按当前规则版本投影，请以该层口径为准。"
    : independentReviewCount !== null
      ? `正式 VOC 分析：独立评论 ${independentReviewCount} 条，覆盖 ${themeCount} 个主题（正向 ${positiveSignals.length} / 负向 ${negativeSignals.length}；主题提及 ${themeMentionCount} 次——同一评论可属多个主题，不等于独立样本数）。`
      : `正式 VOC 分析：覆盖 ${themeCount} 个主题（正向 ${positiveSignals.length} / 负向 ${negativeSignals.length}；主题提及 ${themeMentionCount} 次）；独立评论数未随分析快照记录。`;

  // 3. AI 推断与假设 —— 只要有真实来源（研报/deepseek）就展示；无来源时留空（显示待验证），绝不生成默认产品方案
  const aiInferences: AiInferenceItem[] = [];
  const oppSource = report?.opportunities || input.deepseek?.opportunities;
  if (Array.isArray(oppSource)) {
    oppSource.forEach((op, idx) => {
      const text = typeof op === "string" ? op : (op && typeof op.text === "string" ? op.text : "");
      if (text) {
        aiInferences.push({
          id: `inf-op-${idx}`,
          title: "产品改进或差异化假设",
          inference: text,
          premise: "来自研报机会项——算法推断，非平台确认事实",
          state: "ESTIMATED",
        });
      }
    });
  }
  const summaryText = report?.summary || input.deepseek?.summary;
  if (summaryText && typeof summaryText === "string") {
    aiInferences.push({
      id: "inf-summary",
      title: "定位推断与竞品对标",
      inference: summaryText,
      premise: "来自研报摘要的综合提炼——算法推断，须人工验证",
      state: "ESTIMATED",
    });
  }
  // AI 研报的买家反馈转述：归入 AI 层明确标注，不进第二层 VOC（修：AI 摘要不得升级为已确认原声）
  const vocSource = report?.vocAnalysis || input.deepseek?.vocAnalysis;
  if (vocSource) {
    const transcripts: Array<{ id: string; text: string }> = [];
    if (Array.isArray(vocSource.positiveSignals)) {
      vocSource.positiveSignals.forEach((sig, idx) => {
        const text = typeof sig === "string" ? sig : (sig && typeof sig.text === "string" ? sig.text : "");
        if (text) transcripts.push({ id: `inf-voc-pos-${idx}`, text });
      });
    }
    if (Array.isArray(vocSource.painPoints)) {
      vocSource.painPoints.forEach((p, idx) => {
        const text = typeof p === "string" ? p : (p && typeof p.text === "string" ? p.text : "");
        if (text) transcripts.push({ id: `inf-voc-pain-${idx}`, text });
      });
    }
    transcripts.forEach((t) => {
      aiInferences.push({
        id: t.id,
        title: "AI 研报买家反馈转述（非正式 VOC）",
        inference: t.text,
        premise: "AI 研报对评论的转述摘要——不构成正式 VOC 来源，不计入第二层已确认原声",
        state: "ESTIMATED",
      });
    });
  }
  // 注意：不再注入任何默认“加厚/玻璃纤维”等无商品证据支持的产品方案推断。

  // 4. 商业风险与数据缺口 —— 消费同页测算，避免把已填情景写成缺失或已证实盈利。
  const economics = input.unitEconomics;
  const economicsNote = economics?.status === "available"
    ? `已有成本情景测算；${economics.excludedCosts.length ? `尚未纳入 ${economics.excludedCosts.join("、")}。` : "仍需核实费用和输入来源。"}情景结果不等于真实净利润。`
    : economics?.status === "not_computable"
      ? `当前测算不可计算${economics.reasons.length ? `：${economics.reasons.join("；")}` : "。请查看成本测算中的输入状态"}；已填内容仍需按来源性质核实。`
      : "当前未读取到成本测算结果；实际费用与盈利情况仍待核实。";
  const commercialRisks: CommercialRiskItem[] = [];
  if (priceVal !== null && priceVal < 7.0) {
    commercialRisks.push({
      id: "risk-low-price",
      title: "低价位段单位经济学未验证",
      detail: `当前标价 $${priceVal} 属低价位段（固定阈值归档）；实际毛利仍待验证，需结合费用与来源核实，不凭标价判断毛利高低。`,
      level: "HIGH",
    });
  }
  commercialRisks.push({
    id: "risk-barrier",
    title: "同质化风险待验证",
    detail: "工艺门槛与竞对跟进速度需要结合当前商品和竞对证据核实，不能仅凭品类推断。",
    level: "MEDIUM",
  });
  commercialRisks.push({
    id: "risk-missing-data",
    title: "单位经济学（Unit Economics）未经验证",
    detail: economicsNote,
    level: "HIGH",
  });

  const dataGaps: DataGapItem[] = ([
    { field: "采购成本 (COGS)", category: "供应链成本", impact: "直接决定保本售价，严禁预估", state: "DATA_MISSING" },
    { field: "开模与起订量 (MOQ)", category: "供应链成本", impact: "决定首批试错资金占用与库存风险", state: "DATA_MISSING" },
    { field: "FBA 配送费与体积重", category: "物流费用", impact: "决定低单价耗材是否被物流费穿仓", state: "DATA_MISSING" },
    { field: "单件包装重量与尺寸", category: "商品规格", impact: "影响计费重；用户输入仍需核实，不能用商品净尺寸代替包装尺寸。", state: "DATA_MISSING" },
    { field: "BSR / 类目精准排名", category: "市场竞争", impact: "无法客观核算类目头部真实出单集中度", state: "DATA_MISSING" },
    { field: "外箱包装规格尺寸", category: "商品规格", impact: "影响头程海运拼箱计费与仓储费率", state: "DATA_MISSING" },
    { field: "类目竞对与需求结构", category: "市场竞争", impact: "市场刚需、溢价空间与竞争激烈程度均无法由价格阈值推导", state: "DATA_MISSING" },
  ] satisfies DataGapItem[]).filter((gap) => {
    if (gap.field === "采购成本 (COGS)" && hasEconomicInput("procurementCost")) return false;
    if (gap.field === "FBA 配送费与体积重" && hasEconomicInput("fbaFee")) return false;
    if (gap.field === "单件包装重量与尺寸" && hasEconomicInput("packageWeight") && hasEconomicInput("packageDimensions")) return false;
    return true;
  });

  // 系统建议（非人工决策；措辞中性，仅从正式 VOC 计数与成本缺口派生）
  const hasStrongPain = negativeSignals.length >= 2;
  const hasAnyFormalSignal = positiveSignals.length > 0 || negativeSignals.length > 0;
  const recommendation = `${hasAnyFormalSignal
    ? `已有 ${negativeSignals.length} 项负向主题和 ${positiveSignals.length} 项正向主题，具体强度请查看原声。`
    : "尚无可用的正式 VOC 主题，买家反馈需要继续核实。"} ${economicsNote}`;

  // 真实 Human Decision 投影（未决策 = PENDING；已决策优先 canonicalStatus，系统建议不写入 currentGate）
  const humanChoice = input.humanDecision?.choice ?? null;
  const rawCanonical = input.humanDecision?.canonicalStatus ?? null;
  const currentGate: HumanDecisionGate = humanChoice === null ? "PENDING" : rawCanonical ?? humanChoice;
  const humanDecided = humanChoice !== null;
  const decisionStale = input.humanDecision?.decisionStale === true;
  const humanDecisionParts: string[] = [];
  if (humanDecided) {
    humanDecisionParts.push(`${decisionStale ? "历史人工决定（需重新确认）" : "人工已决策"}：${humanChoice}`);
    if (input.humanDecision?.canonicalStatus) humanDecisionParts.push(input.humanDecision.canonicalStatus);
    if (input.humanDecision?.scope) humanDecisionParts.push(input.humanDecision.scope);
  } else {
    humanDecisionParts.push("待人工决策（PENDING）——尚无正式 Human Decision");
  }
  const humanDecisionDisplay = humanDecisionParts.join(" · ");

  // 人工决策失效投影（由服务端 stale 判定透传，前端不自行推断）
  const decisionStaleReason = decisionStale ? (input.humanDecision?.decisionStaleReason ?? "RESEARCH_EVIDENCE_CHANGED") : null;

  return {
    asin,
    role,
    confirmedFacts,
    buyerVoc: {
      state: vocState,
      independentReviewCount,
      themeMentionCount,
      themeCount,
      positiveSignals,
      negativeSignals,
      summary: vocSummary,
    },
    aiInferences,
    commercialAssessment: {
      marketAttractiveness: priceVal === null
        ? "当前售价缺失（DATA_MISSING），无法评估市场吸引力。"
        : `当前标价 $${priceVal}（价格事实）。市场刚需、溢价空间与竞争激烈程度均【待验证】——需类目需求证据、出单数据与竞对样本；不以固定价格阈值推导上述结论。`,
      improvementOpportunity: !hasAnyFormalSignal
        ? "尚无正式 VOC 反馈分析，改进方向的可解决性【待验证】，待 VOC 数据补齐后判断。"
        : hasStrongPain
          ? `已记录 ${negativeSignals.length} 项负向痛点（详见第二层原声），改进方向具备工程解决性假设，须经人工与样板验证。`
          : "现有原声未记录复现级负向痛点；溢价支撑性【待验证】，需谨慎开模。",
      commercialRisks,
      dataGaps,
      decisionSupport: {
        currentGate,
        humanDecided,
        humanDecisionDisplay,
        decisionStale,
        decisionStaleReason,
        systemSuggestionGate: "VALIDATE_MORE",
        recommendation,
        autoProceedBlocked: true,
        nextActionNote: decisionStale
          ? "研究或证据已更新，原人工决策需要重新确认后才能继续。AI 不自动推进立项，系统建议不等于人工决策。"
          : "缺少报价本身不妨碍继续研究；是否继续或形成需求单，以人工决定和现有门禁为准。",
      },
    },
  };
}
