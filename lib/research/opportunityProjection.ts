/**
 * 03 商品深研 —— 开发机会投影（只读派生，零 AI 自由度）。
 *
 * 边界：
 * - 只消费 VOC 投影里已达「弱信号 / 复现门槛」的负面主题，不新增采集、不写库、不调用 AI。
 * - 竞品现状只引用已存的代表商品快照事实（数量 / 价格 / 标题与规格关键词），不做推断。
 * - hypothesis 永远是「待验证方向」，不是已成立的产品结论；humanStatus 恒为 pending。
 * - validations 只列需要人工/打样确认的事项，不写 MOQ、报价、交期等供应链事实。
 */

import {
  DEEP_RESEARCH_SCHEMA,
  type DeepResearchComparisonProjection,
  type DeepResearchOpportunity,
  type DeepResearchOpportunityProjection,
  type DeepResearchVocProjection,
  type DeepResearchVocTheme,
} from "@/lib/research/deepResearchTypes";
import { VOC_STRENGTH_THRESHOLDS } from "@/lib/research/vocThresholds";

export type OpportunityProjectionInput = {
  voc: DeepResearchVocProjection;
  comparison?: DeepResearchComparisonProjection | null;
};

const PENDING_COMPETITOR_STATUS = "当前未选出可比代表商品，竞品现状待补。";

const FALLBACK_HYPOTHESIS = "可作为待验证方向：针对该反馈调整产品结构或材料；是否真正改善需打样与用户试用验证。";

const FALLBACK_VALIDATIONS: readonly string[] = [
  "材料与工艺可行性：该方向能否在现有材质与工艺下实现，需供应商打样确认。",
  "成本与目标售价：改动带来的单件成本增量与目标售价空间需核算。",
  "供应链与 MOQ：需确认供应商最小起订量、开模费用与交期。",
  "用户接受度：改动后需用真实用户反馈验证问题是否真的被解决。",
  "差异化：需与代表商品的对应规格逐项比对，确认改动可被描述和验证。",
];

type ThemeOpportunityGuidance = {
  /** 待验证假设（措辞必须是方向，不是结论）。 */
  hypothesis: string;
  /** 该主题专属的待验证事项（至少 3 项）。 */
  validations: readonly string[];
  /** 竞品标题/规格中与本主题相关的关键词（只用于统计已解析到的规格，不推断性能）。 */
  specHints: readonly string[];
};

const THEME_GUIDANCE: Readonly<Record<string, ThemeOpportunityGuidance>> = {
  clean_difficulty: {
    hypothesis:
      "可作为待验证方向：调整内壁形状、开口宽度或可拆结构以降低清洁难度；实际改善幅度需打样与用户试用验证。",
    validations: [
      "结构/工艺可行性：宽口或可拆结构能否在现有模具与工艺下实现，需打样确认清洁面积与死角变化。",
      "成本与目标售价：结构改动与新增部件的单件成本增量、目标售价空间需核算。",
      "供应链与 MOQ：需确认新结构的开模费用、最小起订量与交期。",
      "用户接受度：需以真实用户试用验证清洁时间是否真的下降，而不是只改外观。",
      "差异化：需与代表商品的开口/结构规格逐项比对，确认差异可被描述和验证。",
    ],
    specHints: ["wide mouth", "wide-mouth", "开口", "广口", "dishwasher", "可拆", "removable", "内壁"],
  },
  slip_resistance: {
    hypothesis:
      "可作为待验证方向：优化底部防滑结构或材料（硅胶脚、纹理底面）；防滑提升幅度需在真实台面上测试验证。",
    validations: [
      "结构与材料可行性：硅胶脚/纹理底面能否与现有底座工艺兼容，需打样验证贴合强度与老化表现。",
      "成本与目标售价：新增防滑件或二次成型的成本增量需核算。",
      "供应链与 MOQ：需确认防滑件的供应商起订量、模具分摊与交期。",
      "用户接受度：需在潮湿/倾斜台面做实测，验证滑动是否真的减少。",
      "差异化：需对比代表商品是否已标注防滑结构，确认改进不是重复投入。",
    ],
    specHints: ["non-slip", "non slip", "anti-slip", "silicone", "rubber", "base", "pad", "防滑", "硅胶", "底座"],
  },
  durability: {
    hypothesis:
      "可作为待验证方向：提升关键受力部位的材料厚度或结构强度；寿命提升需以加速测试与用户长期反馈验证。",
    validations: [
      "材料与工艺可行性：加厚或换材是否影响成型、装配与外观，需打样确认。",
      "成本与目标售价：材料升级带来的单件成本增量需核算。",
      "供应链与 MOQ：需确认材料牌号可得性、最小起订量与交期。",
      "用户接受度：需以长期使用反馈或加速老化测试验证耐久性提升。",
      "差异化：需核对代表商品是否已在这些部位加强，避免重复投入。",
    ],
    specHints: ["thickness", "thick", "stainless", "steel", "材质", "厚度", "不锈钢", "reinforced"],
  },
  size_fit: {
    hypothesis:
      "可作为待验证方向：补充明确的尺寸标注与规格选项，或调整外形以适配目标场景；需以用户实测反馈验证。",
    validations: [
      "规格可行性：新增尺寸/规格是否需要新模具，需确认开发周期与打样成本。",
      "成本与目标售价：多规格带来的库存与生产成本增量需核算。",
      "供应链与 MOQ：每个规格的最小起订量与交期需分别确认。",
      "用户接受度：需验证用户是否按标注选到合适尺寸，退货原因是否下降。",
      "差异化：需比对代表商品已提供的尺寸/规格选项，确认差异点。",
    ],
    specHints: ["size", "dimension", "inch", "cm", "尺寸", "容量", "oz", "ml"],
  },
  odor: {
    hypothesis:
      "可作为待验证方向：排查材料配方与后处理工艺（如脱味、食品级材料）以降低异味；需以实物气味评估与用户反馈验证。",
    validations: [
      "材料可行性：食品级/低气味材料能否满足现有性能与成本要求，需供应商提供材质证明并打样。",
      "成本与目标售价：材料替换的成本增量需核算。",
      "供应链与 MOQ：需确认低气味材料的起订量、交期与批次稳定性。",
      "用户接受度：需做开箱气味测试（多人盲评）验证异味是否消除。",
      "差异化：需核对代表商品是否已标注食品级/无异味，确认差异可被描述。",
    ],
    specHints: ["food grade", "food-grade", "bpa", "silicone", "material", "食品级", "材质", "硅胶"],
  },
  functionality: {
    hypothesis:
      "可作为待验证方向：改进密封/配件结构（密封圈、卡扣、配件清单）以消除渗漏与缺件；需以密封测试验证。",
    validations: [
      "结构与工艺可行性：密封圈材质、压缩量与卡扣结构能否在现有模具下实现，需打样做密封测试。",
      "成本与目标售价：密封件与配件增加的成本增量需核算。",
      "供应链与 MOQ：需确认密封件供应商起订量、交期与批次一致性。",
      "用户接受度：需做倾斜/倒置渗漏测试与用户试用，验证是否真的不漏。",
      "差异化：需比对代表商品的密封结构与配件清单，确认改进点可被描述。",
    ],
    specHints: ["seal", "leak", "lid", "gasket", "leakproof", "密封", "盖子", "防漏", "pack"],
  },
  capacity_storage: {
    hypothesis:
      "可作为待验证方向：调整容量或可堆叠/可折叠结构以改善收纳；实际收纳收益需以场景实测验证。",
    validations: [
      "结构可行性：堆叠/折叠结构是否影响承重与稳定性，需打样验证。",
      "成本与目标售价：结构改动的成本增量与目标售价空间需核算。",
      "供应链与 MOQ：需确认新结构模具费用、起订量与交期。",
      "用户接受度：需在真实收纳场景（橱柜/抽屉）验证占用空间是否下降。",
      "差异化：需比对代表商品的容量与堆叠规格，确认差异可被量化描述。",
    ],
    specHints: ["capacity", "stackable", "stack", "oz", "ml", "容量", "可堆叠", "收纳", "pack"],
  },
  material_feel: {
    hypothesis:
      "可作为待验证方向：调整材料牌号、表面处理或壁厚以改善手感与质感；主观感受需以用户盲测验证。",
    validations: [
      "材料与工艺可行性：换材或表面处理（喷涂/磨砂）能否通过现有工艺实现，需打样。",
      "成本与目标售价：材料与表面处理的成本增量需核算。",
      "供应链与 MOQ：需确认材料/表面处理供应商的起订量与交期。",
      "用户接受度：需以盲测比较手感评分，验证改动是否被感知。",
      "差异化：需比对代表商品的材质与表面处理描述，确认差异点。",
    ],
    specHints: ["material", "texture", "finish", "plastic", "stainless", "材质", "纹理", "工艺", "塑料"],
  },
};

const ELIGIBLE_STRENGTHS: ReadonlySet<string> = new Set(["recurring", "weak"]);

function isEligible(theme: DeepResearchVocTheme): boolean {
  return theme.polarity === "negative" && ELIGIBLE_STRENGTHS.has(theme.strength);
}

function guidanceFor(theme: DeepResearchVocTheme): ThemeOpportunityGuidance {
  return THEME_GUIDANCE[theme.id] ?? {
    hypothesis: FALLBACK_HYPOTHESIS,
    validations: FALLBACK_VALIDATIONS,
    specHints: [],
  };
}

function formatAmount(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

function rowMatchesHints(
  row: DeepResearchComparisonProjection["rows"][number],
  hints: readonly string[],
): boolean {
  if (hints.length === 0) return false;
  const haystack = [
    row.title ?? "",
    ...row.specs.map((spec) => `${spec.label} ${spec.value}`),
  ].join(" ").toLowerCase();
  return hints.some((hint) => haystack.includes(hint.toLowerCase()));
}

/** 竞品现状：只用已存快照里的事实（代表商品数量 / 价格区间 / 已解析到的相关规格）。 */
function buildCompetitorStatus(theme: DeepResearchVocTheme, comparison: DeepResearchComparisonProjection | null): string {
  const rows = comparison?.rows ?? [];
  if (!comparison || !comparison.representativesSelected || rows.length === 0) {
    return PENDING_COMPETITOR_STATUS;
  }
  const priced = rows.filter((row) => row.price !== null && Number.isFinite(row.price.amount));
  const currencies = new Set(priced.map((row) => row.price?.currency ?? ""));
  let pricePhrase = "价格未提供";
  if (priced.length > 0 && currencies.size === 1) {
    const amounts = priced.map((row) => row.price?.amount ?? 0);
    const min = Math.min(...amounts);
    const max = Math.max(...amounts);
    const currency = [...currencies][0];
    pricePhrase = min === max
      ? `价格 ${formatAmount(min)} ${currency}`
      : `价格区间 ${formatAmount(min)}–${formatAmount(max)} ${currency}`;
  } else if (priced.length > 0) {
    pricePhrase = "价格因币种不一致无法给出区间";
  }
  const hints = guidanceFor(theme).specHints;
  const relatedCount = rows.filter((row) => rowMatchesHints(row, hints)).length;
  const specPhrase = relatedCount > 0
    ? `其中 ${relatedCount} 件在标题或规格中已解析到与该主题相关的规格关键词（${hints.slice(0, 4).join("、")}）`
    : "代表商品的标题与规格中暂未解析到与该主题直接相关的规格关键词";
  return `对比中 ${rows.length} 件代表商品，${pricePhrase}，${specPhrase}；以上仅来自已存快照事实，未核实实际使用表现。`;
}

function exclusionReason(theme: DeepResearchVocTheme): string {
  if (theme.polarity === "positive") {
    return `「${theme.label}」是正面反馈（${theme.positiveCount} 条评价肯定该特性），不构成待改进问题。`;
  }
  if (theme.polarity === "neutral") {
    return `「${theme.label}」是中性描述，没有明确的问题指向，不构成开发要求。`;
  }
  // 只有「明确负面反馈」才可能构成痛点；提及、可接受、待核对都不算。
  if (theme.complaintCount === 0) {
    const parts: string[] = [];
    if (theme.toleratedCount > 0) parts.push(`${theme.toleratedCount} 条明确表示可以接受`);
    if (theme.uncertainCount > 0) parts.push(`${theme.uncertainCount} 条语境不足待核对`);
    const others = parts.length > 0 ? `，其中 ${parts.join("、")}` : "";
    return `「${theme.label}」只有 ${theme.mentionCount} 条主题提及${others}；没有任何一条构成明确负面反馈，不能算痛点，更不能作为开发要求。`;
  }
  if (theme.strength === "isolated") {
    return `仅 ${theme.complaintCount} 条明确负面反馈（另有 ${theme.mentionCount - theme.complaintCount} 条提及/接受/待核对），未达弱信号门槛（≥ ${VOC_STRENGTH_THRESHOLDS.weakMin} 条），只能作为待观察线索。`;
  }
  if (theme.strength === "mention_only") {
    return `「${theme.label}」没有明确负面反馈，只有主题提及，不构成开发机会。`;
  }
  return `「${theme.label}」的样本分母或明确负面反馈数量不足（${theme.complaintCount} 条 / 分母 ${theme.sampleDenominator} 条），无法判断是否为真实问题。`;
}

function buildOpportunity(theme: DeepResearchVocTheme, comparison: DeepResearchComparisonProjection | null): DeepResearchOpportunity {
  const guidance = guidanceFor(theme);
  const validations = [...new Set(guidance.validations)];
  const complaintOnlyEvidence = theme.quotes.filter((quote) => quote.intent === "complaint");
  const evidenceQuotes = (complaintOnlyEvidence.length > 0 ? complaintOnlyEvidence : theme.quotes).slice(0, 3);
  return {
    id: `opp_${theme.id}`,
    problem: `用户反馈「${theme.label}」：${theme.complaintCount} 条明确负面反馈（共 ${theme.mentionCount} 条提及 / 样本 ${theme.sampleDenominator} 条，覆盖 ${theme.asins.length} 个 ASIN${theme.asins.length > 0 ? `：${theme.asins.join("、")}` : ""}）。`,
    strength: theme.strength,
    evidence: evidenceQuotes.map((quote) => ({
      asin: quote.asin,
      attachmentId: quote.attachmentId,
      excerpt: quote.excerpt,
      rating: quote.rating,
    })),
    competitorStatus: buildCompetitorStatus(theme, comparison),
    hypothesis: guidance.hypothesis,
    validations: validations.length >= 3 ? validations : [...FALLBACK_VALIDATIONS],
    humanStatus: "pending",
  };
}

export function buildOpportunityProjection(input: OpportunityProjectionInput): DeepResearchOpportunityProjection {
  const comparison = input.comparison ?? null;
  const themes = input.voc?.themes ?? [];
  const opportunities: DeepResearchOpportunity[] = [];
  const excluded: Array<{ theme: string; reason: string }> = [];

  for (const theme of themes) {
    if (!isEligible(theme)) {
      excluded.push({ theme: theme.label, reason: exclusionReason(theme) });
      continue;
    }
    opportunities.push(buildOpportunity(theme, comparison));
  }

  const limitations: string[] = [
    "以下开发机会只是研究建议，不是已批准的产品需求；必须经人工确认后才能进入需求单（humanStatus 恒为 pending）。",
    `机会范围受本轮评论样本限制：共 ${input.voc?.reviewsRead ?? 0} 条去重评论、${input.voc?.asins.length ?? 0} 个 ASIN；样本扩大后结论可能变化。`,
    "竞品现状只来自已存的代表商品快照（数量/价格/标题与规格关键词），未核实实际使用表现；未选出代表商品时该项待补。",
  ];
  if (excluded.length > 0) {
    limitations.push(`另有 ${excluded.length} 个主题未进入机会列表（证据不足或为正面反馈），原因见 excluded。`);
  }
  if (comparison && comparison.limitations.length > 0) {
    limitations.push(`竞品对比本身的限制同样适用：${comparison.limitations.join("；")}。`);
  }

  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA,
    opportunities,
    excluded,
    limitations,
  };
}
