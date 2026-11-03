import type {
  FactField,
  FactMetricNature,
  FactFieldStatus,
  ProductFact,
  ProductFactBasic,
  ProductFactExtended,
  ProductFactKeyword,
  ProductFactMarket,
  ProductFactProfit,
  ProductPackageDimensions,
  ProductItemDimensions,
  ProductPackageWeight,
  ProductPrice,
  ProductFactSource,
} from "@/lib/sourceLayer/fact/types";
import type { ResearchInputBundle } from "@/lib/sourceLayer/v2/contracts";

/** Active Research Layer V1 的输入与输出合同。 */
export const RESEARCH_REPORT_SCHEMA = "research-report.v1" as const;
export const RESEARCH_ENGINE_SCHEMA = "research-engine-input.v1" as const;
export const RESEARCH_SYNTHESIS_NODE = "synthesize_research" as const;

export type ResearchEvidenceRef = {
  readonly refId: string;
  readonly source: ProductFactSource;
  readonly captureId: string;
  readonly evidenceId: string;
  readonly subjectKey: string;
  readonly capturedAt: string;
  readonly contentHash: string;
  readonly sourceUrl: string | null;
};

export type ResearchConfig = {
  readonly locale: "zh-CN";
  readonly focus: readonly ["market", "competition", "voc", "differentiation"];
  readonly maxTokens: number;
  readonly timeoutMs: number;
};

export type ReviewEvidenceSample = {
  readonly rating: number | null;
  readonly title: string | null;
  readonly text: string;
  readonly verifiedPurchase: boolean | null;
};

export type ReviewEvidenceSummaryItem = {
  readonly refId: string;
  readonly asin: string;
  readonly sampleReviews: readonly ReviewEvidenceSample[];
};

/**
 * Research 的唯一事实输入。
 *
 * 这里不允许出现 analysisJson、summary、外部工具结果或自由文本事实快照。
 * ProductFact 由 Source Layer 负责生成；Research 只消费它。
 */
export type ResearchEngineInput = {
  readonly schema: typeof RESEARCH_ENGINE_SCHEMA;
  readonly taskId: string;
  readonly candidateId: string;
  readonly runId: string;
  /** V2 链路追踪；历史调用方缺省时仍可由 captureId 关联来源证据。 */
  readonly traceId?: string | null;
  readonly productFact: ProductFact;
  readonly sourceEvidenceRefs: readonly ResearchEvidenceRef[];
  readonly researchConfig: ResearchConfig;
  /** V2 只读汇总；旧调用方缺省时仍按 ProductFact 最小链路运行。 */
  readonly researchInputBundle?: ResearchInputBundle;
  /** G3-B：从 EvidenceStore 只读汇总的评论证据摘要，供 DeepSeek 生成 VOC 商业洞察。 */
  readonly reviewEvidenceSummary?: readonly ReviewEvidenceSummaryItem[];
  /** RDO-1：单品商业成本测算假设（纯可选，缺省时保持历史 null 行为） */
  readonly economicAssumptions?: EconomicAssumptionsInput | null;
};

export type EconomicShippingMode = "sea_fast" | "sea_economy" | "air_express" | "custom_rate";

export type EconomicMetricNature = "CONFIRMED_REFERENCE" | "USER_INPUT" | "ESTIMATED" | "MISSING";

export type EconomicMetricState = "READY" | "MISSING" | "STALE_REFERENCE";

/**
 * 单位经济学的每个成本/费率都必须能回答“来自哪里、何时有效、是什么性质”。
 * 缺少字段不再静默变成 0；计算层会把对应结果标为不可计算。
 */
export type EconomicMetricMetadata = {
  readonly marketplace: string | null;
  readonly effectiveDate: string | null;
  readonly source: string | null;
  readonly metricNature: EconomicMetricNature;
  readonly currency: string | null;
  readonly state: EconomicMetricState;
};

export type EconomicAssumptionMetadataKey =
  | "sellingPrice"
  | "procurementCost"
  | "shippingRate"
  | "packageWeight"
  | "packageDimensions"
  | "fbaFee"
  | "commissionRate"
  | "targetTacosRate"
  | "exchangeRate";

export type EconomicAssumptionMetadata = Partial<Record<
  EconomicAssumptionMetadataKey,
  Partial<Omit<EconomicMetricMetadata, "state">> & { readonly staleAfterDays?: number }
>>;

/** 包装重量单位（与 ProductPackageWeight 对齐；仅包装毛重，商品净重不得代填）。 */
export type EconomicPackageWeightUnit = "kg" | "lb" | "oz" | "g";
/** 包装尺寸单位（与 ProductPackageDimensions 对齐）。 */
export type EconomicPackageDimensionUnit = "cm" | "in";

/**
 * V6 单位经济性情景假设。
 *
 * 语义纪律：
 * - 这些字段一律是**用户输入的情景假设或实询报价**，不是 Amazon 来源事实；
 *   计算层必须把它们标为 `USER_INPUT` / `ESTIMATED`，不得升级为已确认事实。
 * - `packageWeight` / `packageDimensions` 只允许填**包装**毛重与尺寸；
 *   商品本体净重/净尺寸不构成发货包装参数，不得代填。
 * - `fbaFee` / `commissionRate` 是平台费用。缺少官方费率来源时必须标注为情景假设，
 *   并由调用方通过 `metadata` 记录来源、生效日期与适用市场；禁止硬编码过期费率。
 */
export type EconomicAssumptionsInput = {
  readonly procurementCost?: {
    readonly amount: number;
    readonly currency: "USD" | "CNY";
  };
  readonly shippingMode?: EconomicShippingMode;
  readonly customShippingRatePerKg?: number;
  readonly targetTacosRate?: number;
  readonly exchangeRate?: number;
  /** 用户设定的目标销售价格；缺省时使用商品事实售价。 */
  readonly targetSellingPrice?: {
    readonly amount: number;
    readonly currency: "USD" | "CNY";
  };
  /** 单件包装重量（仅包装毛重）。 */
  readonly packageWeight?: {
    readonly value: number;
    readonly unit: EconomicPackageWeightUnit;
  };
  /** 单件包装尺寸。 */
  readonly packageDimensions?: {
    readonly length: number;
    readonly width: number;
    readonly height: number;
    readonly unit: EconomicPackageDimensionUnit;
  };
  /** 用户直接给出的单件头程物流费用（跳过计费重推导，按单件计）。 */
  readonly unitLogisticsCost?: {
    readonly amount: number;
    readonly currency: "USD" | "CNY";
  };
  /** 用户提供的 FBA 配送费用（无官方费率来源时即情景假设）。 */
  readonly fbaFee?: {
    readonly amount: number;
    readonly currency: "USD" | "CNY";
  };
  /** Amazon 平台佣金率（0–1 之间的比例）。 */
  readonly commissionRate?: number;
  /** 用户输入可选提供更精确的来源元数据；未提供时仍由计算层显式生成 USER_INPUT/MISSING。 */
  readonly metadata?: EconomicAssumptionMetadata;
};

export type UnitEconomicsCostBreakdown = {
  readonly procurementCostUsd: number;
  readonly shippingUsd: number;
  readonly landedCostUsd: number;
  readonly fbaFeeUsd: number;
  readonly adCostUsd: number;
  /** 平台佣金（仅在用户提供佣金率时出现；缺省时该键不存在，不得当作 0 使用）。 */
  readonly commissionUsd?: number;
  readonly totalCostUsd: number;
};

export type UnitEconomicsInputMetadata = {
  readonly sellingPrice: EconomicMetricMetadata;
  readonly procurementCost: EconomicMetricMetadata;
  readonly shippingRate: EconomicMetricMetadata;
  readonly packageWeight: EconomicMetricMetadata;
  readonly packageDimensions: EconomicMetricMetadata;
  readonly fbaFee: EconomicMetricMetadata;
  readonly commissionRate: EconomicMetricMetadata;
  readonly targetTacosRate: EconomicMetricMetadata;
  readonly exchangeRate: EconomicMetricMetadata;
};

/**
 * V6 单位经济性只读展示契约。
 *
 * 只承载确定性计算结果与来源性质，**不承载任何商业建议**：
 * 不得据此自动立项、自动批准或自动改写 Human Decision。
 */
export type UnitEconomicsViewLine = {
  readonly key: string;
  readonly label: string;
  readonly amountUsd: number | null;
  readonly nature: EconomicMetricNature;
  readonly source: string | null;
  readonly effectiveDate: string | null;
  readonly state: EconomicMetricState;
  readonly note: string | null;
};

export type UnitEconomicsViewMetric = {
  readonly key: string;
  readonly label: string;
  readonly value: number | null;
  readonly unit: "usd" | "ratio";
  readonly status: "available" | "not_computable";
  readonly reason: string | null;
};

export type UnitEconomicsView = {
  readonly schema: "unit-economics-view.v1";
  readonly status: "available" | "not_computable";
  readonly currency: string | null;
  readonly computedAt: string;
  /** true = 部分成本口径；展示层不得称为完整净利润。 */
  readonly isPartialCostBasis: boolean;
  readonly excludedCosts: readonly string[];
  /** 补齐对应输入后即可纳入的未计费用（当前仅平台佣金）。 */
  readonly conditionalExcludedCosts: readonly string[];
  /** 本模型始终不纳入的费用。 */
  readonly alwaysExcludedCosts: readonly string[];
  readonly commissionIncluded: boolean;
  readonly freightBasis: "chargeable_weight" | "per_unit" | null;
  readonly chargeableWeightKg: number | null;
  readonly sellingPrice: UnitEconomicsViewLine;
  readonly costLines: readonly UnitEconomicsViewLine[];
  readonly totalUnitCostUsd: number | null;
  readonly metrics: readonly UnitEconomicsViewMetric[];
  readonly inputProvenance: readonly UnitEconomicsViewLine[];
  readonly reasons: readonly string[];
  readonly formulaNotes: readonly string[];
};

/** RDO-2: 确定性风险规则枚举 */
export type DeterministicRiskRuleId =
  | "NEGATIVE_NET_PROFIT"
  | "LOW_GROSS_MARGIN"
  | "HIGH_FBA_RATIO"
  | "LOW_RATING_RISK"
  | "AMAZON_BUYBOX_RISK"
  | "OVERSIZE_LOGISTICS_RISK"
  | "MINOR_VARIATION_RISK"
  | "AMAZON_MONOPOLY_RISK"
  | "PRICE_WAR_COLLAPSE_RISK"
  | "HIGH_DEAL_DEPENDENCY_RISK"
  | "BRAND_OLIGOPOLY_RISK";

export type DeterministicRiskSeverity = "BLOCK" | "WARNING" | "INFO";

export type DeterministicRiskStatus = "triggered" | "passed" | "not_computable";

export type DeterministicRiskRuleResult = {
  readonly ruleId: DeterministicRiskRuleId | string;
  readonly severity: DeterministicRiskSeverity;
  readonly status: DeterministicRiskStatus;
  readonly reason: string | null;
  readonly sourceFields: readonly string[];
  readonly evidenceRefs?: readonly ResearchEvidenceRef[];
};

export type DeterministicRiskGateSummary = {
  readonly status: "passed" | "blocked" | "warning";
  readonly hasBlockingRisk: boolean;
  readonly rules: readonly DeterministicRiskRuleResult[];
  readonly blockingReasons: readonly string[];
  readonly warningReasons: readonly string[];
};

export type ResearchFactField<T> = {
  readonly value: T | null;
  readonly status: FactFieldStatus;
  readonly metricNature?: FactMetricNature;
  readonly source: ProductFactSource;
  readonly confidence: number;
  readonly capturedAt: string | null;
  readonly rawProofHash: string | null;
  readonly evidenceRefs: readonly ResearchEvidenceRef[];
};

type ProductFactFieldValue<T> = T extends FactField<infer Value> ? Value : never;

export type ResearchNarrative = {
  readonly text: string | null;
  /** Citation validity is independent of semantic fidelity; preserve refs for review. */
  readonly semanticReview?: {
    readonly status: "human_review_required" | "hypothesis";
    readonly reasons: readonly string[];
    readonly auditFindings?: readonly { readonly code: string; readonly auditArtifactHash: string; readonly reportHash: string }[];
  };
  /** AI 分析中的可追溯证据；没有可验证引用时保持空数组。 */
  readonly evidenceRefs: readonly ResearchEvidenceRef[];
};

/**
 * JEV-002：narrative 是否可作为「研究结论」使用。
 *
 * 必须有非空文本和已解析引用，且没有尚待处理的语义复核标记。
 * 引用合法不代表语义已确认；待复核内容保留引用供人工核对，但不算已核实结论。
 */
export function isVerifiedNarrative(narrative: ResearchNarrative | null | undefined): boolean {
  if (!narrative) return false;
  if (typeof narrative.text !== "string" || narrative.text.trim().length === 0) return false;
  if (narrative.semanticReview) return false;
  return Array.isArray(narrative.evidenceRefs) && narrative.evidenceRefs.length > 0;
}

/** Display/export warnings without modifying stored model text. */
export function formatResearchNarrative(value: ResearchNarrative | null | undefined): string | null {
  if (!value?.text?.trim()) return null;
  const text = value.semanticReview
    ? value.text.replace(/^【(?:待验证假设|待人工复核)：[^】]*】/u, "").trim()
    : value.text.trim();
  return value.semanticReview
    ? `【${value.semanticReview.status === "hypothesis" ? "待验证假设" : "待人工复核"}：${value.semanticReview.reasons.join(" ")}】${text}`
    : text;
}

export type ResearchDeterministicMetric<T> = {
  readonly value: T | null;
  readonly status: "available" | "not_computable";
  readonly evidenceRefs: readonly ResearchEvidenceRef[];
  readonly reason: string | null;
};

/**
 * 研究优先级只用于安排人工研究动作，不代表购买、盈利或爆款判断。
 */
export type ResearchPriority = "P1" | "P2" | "P3";

export type ResearchNextAction = "继续研究" | "补充数据" | "暂停";

/** RDO-3: 决策核对单项状态 */
export type DecisionChecklistStatus = "passed" | "blocked" | "warning" | "missing";

/** RDO-3: 决策前必备关键核对单项 */
export type DecisionChecklistItem = {
  readonly key:
    | "profit_margin"
    | "fba_ratio"
    | "customer_rating"
    | "buybox_competition"
    | "logistics_size"
    | "price_stability"
    | "variation_health"
    | "market_structure";
  readonly label: string;
  readonly status: DecisionChecklistStatus;
  readonly detail: string;
};

export type ResearchDecisionSummary = {
  readonly researchPriority: ResearchPriority;
  readonly recommendedNextAction: ResearchNextAction;
  readonly keyReasons: readonly string[];
  readonly blockingRisks: readonly string[];
  readonly missingInformation: readonly string[];
  /** RDO-3: 动作推荐的直接驱动原因列表（纯确定性程序生成） */
  readonly actionReasons?: readonly string[];
  /** RDO-3: 决策前关键核对清单（5 大核心维度透视） */
  readonly checklist?: readonly DecisionChecklistItem[];
};

/**
 * Research 层面的人工作业结论。
 *
 * 这是面向 Research → 决策卡 → Lark 导出的扩展契约，不替换现有
 * ProductResearchRecord 的正式 Decision Layer 状态机。它本身不触发任务
 * 状态流转，也不表达 AI 自动决策。
 */
export type ResearchDecisionStatus =
  | "pending"
  | "continue"
  | "pause"
  | "need_more_validation";

export type ResearchDecisionNextAction =
  | "continue_research"
  | "collect_more_data"
  | "prepare_listing"
  | "stop";

export const RESEARCH_DECISION_STATUS_VALUES = [
  "pending",
  "continue",
  "pause",
  "need_more_validation",
] as const satisfies readonly ResearchDecisionStatus[];

export const RESEARCH_DECISION_NEXT_ACTION_VALUES = [
  "continue_research",
  "collect_more_data",
  "prepare_listing",
  "stop",
] as const satisfies readonly ResearchDecisionNextAction[];

export function isResearchDecisionStatus(value: unknown): value is ResearchDecisionStatus {
  return typeof value === "string"
    && (RESEARCH_DECISION_STATUS_VALUES as readonly string[]).includes(value);
}

export function isResearchDecisionNextAction(value: unknown): value is ResearchDecisionNextAction {
  return typeof value === "string"
    && (RESEARCH_DECISION_NEXT_ACTION_VALUES as readonly string[]).includes(value);
}

export type ResearchDecision = {
  readonly status: ResearchDecisionStatus;
  readonly nextAction: ResearchDecisionNextAction;
  readonly notes: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  /**
   * RESEARCH-001：本条人工复核所针对的报告指纹（服务端从已存报告写入，不接受客户端伪造）。
   *
   * 报告被 force 重新生成后 reportHash 会变化，此时该复核不代表新报告，
   * 必须被视为过期：不能无标识地继续作为新报告的人工背书。
   */
  readonly reviewedReportHash: string | null;
};

/**
 * RESEARCH-001：判断一条人工复核是否已对当前报告过期。
 *
 * fail-closed 语义：
 * - 没有复核 → false（本来就没有人工意见，谈不上过期）；
 * - 没有报告 hash → false（无从比较）；
 * - reviewedReportHash 为 null（历史遗留复核）或与当前 hash 不一致 → true。
 */
export function isResearchReviewStale(
  decision: Pick<ResearchDecision, "reviewedReportHash"> | null | undefined,
  reportHash: string | null | undefined,
): boolean {
  if (!decision) return false;
  if (typeof reportHash !== "string" || reportHash.length === 0) return false;
  return decision.reviewedReportHash !== reportHash;
}

export type ResearchFactSnapshot = {
  readonly basic: {
    readonly asin: ResearchFactField<string>;
    readonly title: ResearchFactField<string>;
    readonly image: ResearchFactField<string>;
    readonly brand: ResearchFactField<string>;
    readonly category: ResearchFactField<string>;
    readonly price: ResearchFactField<ProductPrice>;
    readonly rating: ResearchFactField<number>;
    readonly reviewCount: ResearchFactField<number>;
    readonly bulletPoints: ResearchFactField<readonly string[]>;
  };
  readonly market: {
    readonly bsr: ResearchFactField<number>;
    readonly monthlySalesEstimate: ResearchFactField<number>;
    readonly monthlyRevenueEstimate: ResearchFactField<ProductPrice>;
    readonly launchedDate: ResearchFactField<string>;
    /**
     * G2-A：SellerSprite 事实投影补齐。这些槽位在 `ProductFactMarket` 中已存在且
     * Adapter 已填充，此前仅因 Research 读取面未投影而不可见。缺省时以显式
     * `status: "missing"` 表达，绝不由本层补值。
     */
    readonly subCategoryBsr: ResearchFactField<number>;
    readonly dateFirstAvailable: ResearchFactField<string>;
    readonly buyboxSeller: ResearchFactField<string>;
    readonly fulfillmentType: ResearchFactField<string>;
    /** 第三方估算（SellerSprite 导表），`metricNature: "estimate"`；Research 不据此计算利润。 */
    readonly estimatedGrossMargin: ResearchFactField<number>;
    readonly listingQualityScore: ResearchFactField<number>;
  };
  readonly profit: {
    readonly packageWeight: ResearchFactField<ProductPackageWeight>;
    readonly packageDimensions: ResearchFactField<ProductPackageDimensions>;
    readonly fbaFee: ResearchFactField<ProductPrice>;
    /** G2-A：净重/净尺寸（与包装毛重分列，互不代填）。 */
    readonly itemWeight: ResearchFactField<ProductPackageWeight>;
    readonly itemDimensions: ResearchFactField<ProductItemDimensions>;
  };
  /** ProductFact extended facts remain separately typed and cite the same bound Evidence. */
  readonly extended?: {
    readonly [K in keyof ProductFactExtended]?: ResearchFactField<ProductFactFieldValue<NonNullable<ProductFactExtended[K]>>>;
  };
  /**
   * G2-B：SellerSprite 关键词证据投影（`monthlySearches` 为第三方估算）。
   * 缺失时 `topKeywords` 为显式 `status: "missing"`，绝不由本层补词。
   */
  readonly keywordEvidence: {
    readonly topKeywords: ResearchFactField<readonly ProductFactKeyword[]>;
  };
  /** V5.1 Phase 2: 时序指标 (Keepa 等来源) */
  readonly timeSeries?: ResearchFactTimeSeries;
  /** V5.1 Phase 2: 变体销售拆解 (SellerSprite US Sheet 等来源) */
  readonly variationAnalysis?: ResearchFactVariationAnalysis;
  /** V5.1 Phase 2: 市场集中度与自营霸盘率 (SellerSprite Brands/Sellers Sheet 等来源) */
  readonly concentration?: ResearchFactMarketConcentration;
};

export type ResearchFactTimeSeries = {
  readonly price90dMin: ResearchFactField<number>;
  readonly price90dAvg: ResearchFactField<number>;
  readonly price360dMin: ResearchFactField<number>;
  readonly bsr90dAvg: ResearchFactField<number>;
  readonly bsrDrops90d: ResearchFactField<number>;
  readonly buyBoxAmazonSharePercent: ResearchFactField<number>;
  readonly dealCount90d: ResearchFactField<number>;
};

export type ResearchFactVariationAnalysis = {
  readonly childSales: ResearchFactField<number>;
  readonly parentTotalSales: ResearchFactField<number>;
  readonly currentAsinSalesShare: ResearchFactField<number>;
  readonly isDominantVariation: ResearchFactField<boolean>;
  readonly isMinorVariation: ResearchFactField<boolean>;
};

export type ResearchFactMarketConcentration = {
  readonly brandCr5Share: ResearchFactField<number>;
  readonly amazon1pShare: ResearchFactField<number>;
  readonly sellerMarketShare: ResearchFactField<number>;
  readonly sellerOriginDomesticRatio: ResearchFactField<number>;
};

export type ResearchReport = {
  readonly schema: typeof RESEARCH_REPORT_SCHEMA;
  readonly taskId: string;
  readonly candidateId: string;
  readonly runId: string;
  readonly subjectKey: string;
  readonly generatedAt: string;
  readonly generationStatus: "completed" | "degraded";
  readonly node: typeof RESEARCH_SYNTHESIS_NODE;
  readonly facts: ResearchFactSnapshot;
  /** 仅总结本报告已有内容；不替代人工决策，也不生成商业事实。 */
  readonly decisionSummary: ResearchDecisionSummary;
  readonly executiveSummary: {
    readonly analysis: ResearchNarrative;
    readonly keyPoints: readonly ResearchNarrative[];
  };
  readonly marketOpportunity: {
    readonly facts: Pick<ResearchFactSnapshot["market"], "bsr" | "monthlySalesEstimate" | "monthlyRevenueEstimate" | "launchedDate" | "subCategoryBsr" | "dateFirstAvailable" | "buyboxSeller" | "fulfillmentType" | "estimatedGrossMargin" | "listingQualityScore">;
    readonly analysis: ResearchNarrative;
  };
  readonly competitionInsight: {
    readonly analysis: ResearchNarrative;
    readonly differentiationSuggestions: readonly ResearchNarrative[];
    /** P2-04/P3-01-B：把观察到的问题背后的竞争性因果假设单独保留，不能埋进泛化摘要。 */
    readonly causalHypotheses?: readonly ResearchNarrative[];
    /** 单条竞争性原因与各自证据、未知和验证动作；始终是待人工验证的假设。 */
    readonly causalInvestigations?: readonly {
      readonly hypothesis: ResearchNarrative;
      /**
       * P2-02：为什么提出这个假设（触发它的事实/观察）。
       * 与 hypothesis 分开记录，避免把「观察到的现象」和「据此推测的原因」混成一句。
       */
      readonly rationale?: ResearchNarrative;
      readonly supportingEvidence: readonly ResearchNarrative[];
      readonly counterevidence: readonly ResearchNarrative[];
      readonly unknowns: readonly string[];
      readonly confidence: "low" | "medium" | "high" | "unknown";
      readonly verification: readonly string[];
    }[];
    /** 可与当前方向比较的实质备选，包括保留现状、缩小场景或停止。 */
    readonly alternatives?: readonly ResearchNarrative[];
    /** 支持当前竞争性解释的证据摘要（每项仍须带合法 evidenceRefs）。 */
    readonly supportingEvidence?: readonly ResearchNarrative[];
    /** 可能推翻竞争性解释的证据摘要（每项仍须带合法 evidenceRefs）。 */
    readonly counterevidence?: readonly ResearchNarrative[];
    /** 针对问题/方案的最低成本验证或停止条件。 */
    readonly verificationItems?: readonly ResearchNarrative[];
  };
  readonly vocAnalysis: {
    readonly analysis: ResearchNarrative;
    readonly painPoints: readonly ResearchNarrative[];
  };
  readonly unitEconomics: {
    readonly facts: Pick<ResearchFactSnapshot["basic"], "price"> & Pick<ResearchFactSnapshot["profit"], "fbaFee" | "packageWeight" | "packageDimensions"> & Pick<ResearchFactSnapshot["market"], "estimatedGrossMargin">;
    readonly deterministic: {
      /** 仅计算售价扣除 FBA 费后的已知金额，不称为利润。 */
      readonly knownRevenueAfterFbaFee: ResearchDeterministicMetric<ProductPrice>;
      /** 缺少采购、头程等成本时明确不可计算，绝不由 AI 猜测。 */
      readonly grossProfit: ResearchDeterministicMetric<ProductPrice>;
      /** RDO-1: 毛利率 (grossProfit / price) */
      readonly grossMargin?: ResearchDeterministicMetric<number>;
      /** RDO-1: 净利润 (price - totalCost) */
      readonly netProfit?: ResearchDeterministicMetric<ProductPrice>;
      /** RDO-1: 净利率 (netProfit / price) */
      readonly netMargin?: ResearchDeterministicMetric<number>;
      /** R4-B: 净利润相对于到岸投入成本的确定性 ROI。 */
      readonly roi?: ResearchDeterministicMetric<number>;
      /** RDO-1: 保本售价 */
      readonly breakEvenPrice?: ResearchDeterministicMetric<ProductPrice>;
      /** V5.1 Phase 2: 历史破位价抗压净利润 */
      readonly stressNetProfit?: ResearchDeterministicMetric<ProductPrice>;
      /** V5.1 Phase 2: 历史破位价抗压毛利率 */
      readonly stressMargin?: ResearchDeterministicMetric<number>;
      /** RDO-1: 成本分解明细 */
      readonly costBreakdown?: UnitEconomicsCostBreakdown | null;
      /** RDO-1: 本次测算使用的商业假设 */
      readonly assumptionsUsed?: EconomicAssumptionsInput | null;
      /** R4-B: 各成本/费率的来源、性质、币种和新鲜度。 */
      readonly inputMetadata?: UnitEconomicsInputMetadata;
    };
    readonly analysis: ResearchNarrative;
  };
  readonly supplyChain: {
    readonly facts: Pick<ResearchFactSnapshot["profit"], "packageWeight" | "packageDimensions" | "itemWeight" | "itemDimensions">;
    readonly analysis: ResearchNarrative;
  };
  readonly riskAssessment: {
    readonly analysis: ResearchNarrative;
    readonly risks: readonly ResearchNarrative[];
    /** 风险对应的验证、停止或升级动作；不等于风险已解决。 */
    readonly verificationItems?: readonly ResearchNarrative[];
    /** RDO-2: 确定性硬规则风控门禁结果（纯程序逻辑，零 AI 介入） */
    readonly deterministicGate?: DeterministicRiskGateSummary;
  };
  readonly citationIndex: readonly {
    readonly fieldPath: string;
    /**
     * RESEARCH-002：本条引用来自确定性事实字段还是 AI narrative。
     * 历史报告可能缺失该字段，读取时一律按 "fact" 处理（与旧语义一致）。
     */
    readonly source?: "fact" | "narrative";
    readonly evidenceRefs: readonly ResearchEvidenceRef[];
  }[];
  /**
   * JEV-002：AI 生成了文本、但没有任何可追溯证据引用的内容。
   *
   * 这些内容**不是研究结论**：它们被显式移出各分析字段（对应字段的 text 为 null），
   * 只能作为「未验证假设」展示与提示，不得用于导出结论、人工背书或业务决策。
   *
   * 可选是为了兼容历史报告（历史报告可能仍有缺引用的内联文本，
   * 由展示层按 isVerifiedNarrative 兜底标注）。
   */
  readonly unverifiedAssumptions?: readonly ResearchNarrative[];
  /** Operational run audit only; never source evidence or human approval. */
  readonly audit?: {
    readonly status: "complete" | "incomplete";
    readonly artifactId: string;
    readonly inputHash: string;
    readonly errorCode: string | null;
    readonly redacted: boolean;
  };
  readonly ai: {
    readonly provider: "deepseek";
    readonly status: "completed" | "degraded";
    readonly errorCode: string | null;
    /** 失败时的原始错误摘要（provider 返回或被截断的说明）；历史报告无此字段。 */
    readonly errorDetail?: string | null;
    /**
     * P5-04：模型与 usage。历史报告没有这些字段（可选），
     * 缺失时按「不可核算」处理，不得用估算值或 0 顶替。
     */
    readonly model?: string | null;
    readonly requestedModel?: string | null;
    readonly modelMismatch?: boolean;
    readonly usage?: {
      readonly promptTokens: number | null;
      readonly completionTokens: number | null;
      readonly totalTokens: number | null;
      readonly elapsedMs: number | null;
    };
  };
};

/** 生成决策摘要时使用的报告主体，避免把摘要当作事实输入。 */
export type ResearchReportCore = Omit<ResearchReport, "decisionSummary">;

export type ResearchReportGeneration = {
  readonly report: ResearchReport;
  readonly reportHash: string;
  readonly generatedAt: string;
  readonly aiProviderCallStarted: boolean;
};

export type ProductFactBasicField = keyof ProductFactBasic;
export type ProductFactMarketField = keyof ProductFactMarket;
export type ProductFactProfitField = keyof ProductFactProfit;

export type AnyProductFactField = FactField<unknown>;

/**
 * Research Export Layer V1 — 导出记录标准契约。
 * 为飞书多维表格及外部协作系统提供稳定的平铺与聚合资产快照。
 * 严禁由 AI 重新生成，所有字段必须直接来源于已保存的报告、事实与决策。
 */
export type ResearchExportRecord = {
  readonly taskId: string;
  readonly candidateId: string;
  /** Source Layer 的跨站点业务主键；新商品池同步以它代替 bare ASIN。 */
  readonly subjectKey?: string;
  readonly product: {
    readonly asin: string | null;
    readonly title: string | null;
    readonly image: string | null;
    readonly category: string | null;
  };
  readonly market: {
    readonly price: { readonly amount: number; readonly currency: string } | null;
    readonly sales: number | null;
    readonly bsr: number | null;
  };
  readonly research: {
    readonly summary: string | null;
    readonly priority: ResearchPriority;
    readonly opportunity: string | null;
    readonly risks: readonly string[];
    /**
     * JEV-002：无证据引用的 AI 文本（仅提示用途，绝不作为研究结论导出）。
     */
    readonly unverifiedAssumptions: readonly string[];
    /**
     * P5：每条待验证原因的**验证动作**（同条件对照 / 观察指标 / 停止条件）。
     *
     * 此前导出只带 summary / risks，产品开发最需要的「下一步怎么验证」被整段丢掉；
     * 2026-10-29 的完整报告里两条原因各有 1 条验证设计，导出侧却是 0。
     * 这里导出的是**假设的验证设计**，不是结论；hypothesis 保持原文，
     * 不因为被导出就被视为已核实。字段可选，旧记录不受影响。
     */
    readonly causalVerification?: readonly {
      readonly hypothesis: string | null;
      readonly confidence: "low" | "medium" | "high" | "unknown";
      readonly actions: readonly string[];
    }[];
  };
  readonly humanDecision: {
    readonly status: ResearchDecisionStatus;
    readonly nextAction: ResearchDecisionNextAction;
    readonly notes: string;
    /** RESEARCH-001：复核所针对的报告指纹。 */
    readonly reviewedReportHash: string | null;
    /**
     * RESEARCH-001：报告 hash 已变化，本条人工复核针对的是旧版报告。
     * true 表示必须重新复核后该意见才对新报告有效。
     */
    readonly reviewStale: boolean;
  } | null;
  readonly evidence: {
    readonly auditStatus?: "complete" | "incomplete";
    /** Current read-only claim check; does not rewrite the report or human decision. */
    readonly claimAuditVerdict?: import("./evidenceAudit").ResearchClaimAudit["verdict"];
    readonly reportHash: string;
    readonly generatedAt: string;
    /**
     * RESEARCH-002：**整份报告**的引用数量 = 事实字段引用 ∪ narrative 引用，按 refId 去重。
     * 不再只是 facts.* 的字段条数。
     */
    readonly citationCount: number;
    /** 仅 facts.* 字段携带的引用数量（去重后）。 */
    readonly factCitationCount: number;
    /** 仅 AI narrative 携带的引用数量（去重后）。 */
    readonly narrativeCitationCount: number;
    /** 无证据引用的 AI 假设条数（不计入 citationCount）。 */
    readonly unverifiedAssumptionCount: number;
  };
};

/**
 * Research Export Batch V1：一组已完成 ResearchReport 的只读导出快照。
 *
 * 该契约只描述端内导出文件，不代表飞书 API 调用，也不触发任何 AI 或
 * Research 生命周期动作。items 必须由 ResearchExportRecord 纯函数投影得到。
 */
export const RESEARCH_EXPORT_BATCH_VERSION = "research-export-batch.v1" as const;

export type ResearchExportBatch = {
  readonly exportVersion: typeof RESEARCH_EXPORT_BATCH_VERSION;
  readonly generatedAt: string;
  readonly items: readonly ResearchExportRecord[];
};
