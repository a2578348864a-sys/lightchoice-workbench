/**
 * 03 商品深研：VOC 证据归属 / 竞品可比性 / 开发机会 的共享展示合同。
 *
 * 设计边界（与项目架构一致）：
 * - 只读投影：不写 ProductFact、不写 EvidenceStore、不建第二个 VOC 库或第二套 Brief。
 * - 缺失保持 null / unknown，不猜测、不补 0；键值一律带来源说明。
 * - 改进假设（hypothesis）永远只是待验证方向，不得表述为既成产品事实。
 */

export const DEEP_RESEARCH_SCHEMA = "deep-research-view.v1" as const;

/** 证据强度：与既有 VOC 复现门槛（≥4 条独立评论）保持一致。 */
export type DeepResearchStrength = "recurring" | "weak" | "isolated" | "mention_only" | "insufficient";

/**
 * 单条评论对某个主题的真实态度（五类）。
 *
 * 关键词命中只能证明「提到了这个属性」，不能证明「不满意」：
 * 这就是「主题提及 vs 明确抱怨」必须分开统计的原因。
 */
export type DeepResearchVocIntent = "complaint" | "tolerated" | "mention" | "positive" | "uncertain";

/** 单条评论的主题归属（可追溯）。 */
export type DeepResearchVocQuote = {
  asin: string;
  attachmentId: string;
  contentHash: string;
  capturedAt: string;
  rating: number | null;
  reviewDate: string | null;
  /** 原文片段（已截断，保留可核对的关键句）。 */
  excerpt: string;
  /** 命中的主题关键词（中文/英文原文词）。 */
  matchedKeyword: string;
  /** 该句对主题的真实态度（五类）。 */
  intent: DeepResearchVocIntent;
  /** 保留旧字段供既有渲染兼容：positive / negative / neutral。 */
  sentenceSentiment: "negative" | "positive" | "neutral";
};

export type DeepResearchVocTheme = {
  id: string;
  label: string;
  /** 主题方向：问题(negative) / 好评(positive) / 中性描述(neutral) */
  polarity: "negative" | "positive" | "neutral";
  /** 涉及 ASIN（去重） */
  asins: string[];
  /**
   * 明确负面反馈条数（**只有这一类**参与复现门槛与开发机会）。
   * 保留旧字段名是为了兼容既有渲染；语义等于 complaintCount。
   */
  independentReviewCount: number;
  /** 提及该主题的评论数（含抱怨/接受/待核对/仅提及，不含正面） */
  mentionCount: number;
  /** 明确负面反馈（有使用障碍或明确不满） */
  complaintCount: number;
  /** 提到缺点但明确表示可以接受 */
  toleratedCount: number;
  /** 只有轻微/语境不足的表述，待人工核对 */
  uncertainCount: number;
  /** 同一主题上的正面评价条数（作为正反证据） */
  positiveCount: number;
  /** 样本分母：这些 ASIN 实际读到的去重评论总数（不含无法解析的附件） */
  sampleDenominator: number;
  /** 分 ASIN 计数与分母，避免把多 ASIN 合并成单一比例 */
  perAsin: Array<{ asin: string; count: number; denominator: number }>;
  strength: DeepResearchStrength;
  /** 代表性原文（最多 3 条，优先负面/低星） */
  quotes: DeepResearchVocQuote[];
  /** 该主题的判断限制（样本少、星级偏斜、采集缺口等） */
  limitations: string[];
};

export type DeepResearchVocProjection = {
  schemaVersion: typeof DEEP_RESEARCH_SCHEMA;
  /**
   * 生成本次投影的 VOC 规则版本（唯一来源：`lib/research/vocRuleVersion.ts`）。
   * 用于区分「当前规则实时计算」与「历史 AI 研报」；不参与 reportHash/stale 合同。
   */
  ruleVersion: string;
  /** 读取到的评论附件数量 / 去重后的评论条数 */
  attachmentsRead: number;
  reviewsRead: number;
  duplicateReviewsSuppressed: number;
  asins: string[];
  themes: DeepResearchVocTheme[];
  /** 整体样本限制与缺口（如评论数少、星级偏斜、缺少评论日期） */
  limitations: string[];
  /** 无法解析或状态不允许的附件说明 */
  rejectedAttachments: Array<{ attachmentId: string; reason: string }>;
};

export type DeepResearchComparabilityLevel =
  /** 规格/单位一致，可直接比较单价 */
  | "comparable"
  /** 规格或单位不同，不能直接比单价 */
  | "spec_differs"
  /** 缺少关键事实（价格/包装数量/品类），无法判断 */
  | "unknown";

export type DeepResearchCompetitorRow = {
  asin: string;
  subjectKey: string;
  role: "benchmark" | "newcomer" | "pain_point" | null;
  roleLabel: string;
  /** 代表商品选择时的备注（用户手写理由） */
  roleNote: string | null;
  title: string | null;
  brand: string | null;
  category: string | null;
  price: { amount: number; currency: string } | null;
  /** 包装数量：仅当标题里能明确解析时才给出，并标注来源。 */
  packCount: { value: number; source: "title"; raw: string } | null;
  /** 每件单价：仅当包装数量已知且所有对比行同品类同单位口径时计算。 */
  unitPrice: { amount: number; currency: string; unitLabel: string } | null;
  rating: number | null;
  reviewCount: number | null;
  bsr: unknown;
  /** 已观察到的规格（容量/尺寸/数量等），键为规格名、值为原文 */
  specs: Array<{ label: string; value: string; source: "title" }>;
  /** 事实来源时间（快照 capturedAt） */
  capturedAt: string | null;
  /** 缺失字段（不猜） */
  missing: string[];
  comparability: { level: DeepResearchComparabilityLevel; reason: string };
};

export type DeepResearchComparisonProjection = {
  schemaVersion: typeof DEEP_RESEARCH_SCHEMA;
  scanId: string | null;
  scanName: string | null;
  /** 是否已选择代表商品（false 时 rows 可能为空） */
  representativesSelected: boolean;
  roleCoverage: Array<"benchmark" | "newcomer" | "pain_point">;
  rows: DeepResearchCompetitorRow[];
  /** 关键差异（只在有事实的维度上列出） */
  differences: Array<{ dimension: string; summary: string; asins: string[] }>;
  limitations: string[];
};

export type DeepResearchOpportunity = {
  id: string;
  /** 用户问题：来自真实评论的主题 */
  problem: string;
  strength: DeepResearchStrength;
  /** 证据引用（可追溯到 ASIN / 附件 / 原文） */
  evidence: Array<{ asin: string; attachmentId: string; excerpt: string; rating: number | null }>;
  /** 竞品现状：来自可比性投影的事实描述 */
  competitorStatus: string;
  /** 改进假设：只是待验证方向 */
  hypothesis: string;
  /** 待验证事项（材料/工艺/成本/供应链/用户接受度） */
  validations: string[];
  /** 人工处理状态：投影永远从 pending 开始，不代替 Human Decision */
  humanStatus: "pending";
};

export type DeepResearchOpportunityProjection = {
  schemaVersion: typeof DEEP_RESEARCH_SCHEMA;
  opportunities: DeepResearchOpportunity[];
  /** 被明确排除的观察（证据不足/无法判断），给用户看「为什么不构成机会」 */
  excluded: Array<{ theme: string; reason: string }>;
  limitations: string[];
};

export type DeepResearchPayload = {
  schemaVersion: typeof DEEP_RESEARCH_SCHEMA;
  taskId: string;
  generatedAt: string;
  voc: DeepResearchVocProjection;
  comparison: DeepResearchComparisonProjection;
  opportunities: DeepResearchOpportunityProjection;
};
