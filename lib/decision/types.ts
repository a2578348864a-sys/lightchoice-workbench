/**
 * lib/decision/types.ts
 *
 * Decision Provider 层核心类型定义。
 *
 * 架构约束：
 * - ProductFacts 字段全部来自候选的已有来源元数据（sellerSprite 快照字段），不从 EvidenceStore 直接读取；
 * - ProductDecision 是纯分析层输出，不是已确认事实，不能修改 Evidence；
 * - DecisionSnapshot 与 Human Decision 严格分离：AI 分析 ≠ 人工决策。
 *
 * 调用规范：
 * - 业务层统一通过 decisionEngine.ts 调用，禁止直接 import 具体 provider；
 * - 新 provider 只需实现 DecisionProvider 接口并在 providers/index.ts 注册。
 */

// ── 输入：来自候选商品的可观察事实 ────────────────────────────────

/**
 * ProductFacts — 送入 AI 分析的输入事实集合。
 *
 * 所有字段均来自候选商品的已有字段（sourceMetaJson / analysisJson），
 * 不允许在此处补充任何未经记录的外部数据。
 * null 表示该字段在候选中缺失，AI 可据此给出"数据不足"提示。
 */
export type ProductFacts = {
  /** 商品标题（来自 sellerSprite 快照） */
  title: string | null;
  /** 品牌（来自 sellerSprite 快照） */
  brand: string | null;
  /** 品类（来自 sellerSprite 快照） */
  category: string | null;
  /** 美元定价 */
  price: number | null;
  /** 星级评分（0–5） */
  rating: number | null;
  /** 评论数 */
  reviewCount: number | null;
  /** 大类 BSR 排名（数值越小越好） */
  rootCategoryBsr: number | null;
  /** 小类 BSR 排名（数值越小越好） */
  subCategoryBsr: number | null;
  /** 估算月销量（第三方估算，非已确认事实） */
  estimatedMonthlySales: number | null;
  /** 估算月收入（USD，第三方估算） */
  estimatedMonthlyRevenueUsd: number | null;
  /** ASIN（Amazon 商品标识） */
  asin: string | null;
  /** 市场（如 Amazon US） */
  marketplace: string | null;
};

// ── 输出：AI 分析层结论 ───────────────────────────────────────────

/**
 * DecisionPriority — AI 建议的研究优先级。
 * P1：强烈建议优先研究；P2：可研究；P3：优先级较低。
 */
export type DecisionPriority = "P1" | "P2" | "P3";

/**
 * DecisionStatus — AI 分析结论状态。
 * - completed：正常分析完成
 * - pending：Provider 仍在等待或业务层明确表示待处理
 * - failed：Provider 不可用/分析失败；不代表自动切换到另一个 Provider
 */
export type DecisionStatus = "completed" | "pending" | "failed";

/**
 * ProductDecision — AI 分析层输出。
 *
 * 语义约束：
 * - 这是「AI 建议」，不是已确认事实，不是人工决策；
 * - 不能自动修改候选状态；
 * - 不能绕过 Human Gate；
 * - 展示时必须明确标注「AI 建议」。
 */
export type ProductDecision = {
  /** 研究优先级建议（P1/P2/P3） */
  priority: DecisionPriority;
  /** 综合评分（0–100，仅作参考） */
  score: number;
  /** 分析结论状态 */
  status: DecisionStatus;
  /** 置信度（0–1） */
  confidence: number;
  /** 建议原因列表（简短中文表述，最多 5 条） */
  reasons: string[];
  /** 风险提示列表（最多 3 条） */
  risks: string[];
  /** 输出该结论的 provider 标识 */
  provider: string;
  /** 使用的模型标识（对 mock 为 "mock"） */
  model: string;
  /** 分析执行时刻（ISO 8601） */
  timestamp: string;
};

// ── 快照：可追溯的 AI 分析记录 ───────────────────────────────────

/**
 * DecisionSnapshot — 可追溯的 AI 分析快照。
 *
 * 数据关系：
 *   Evidence（证据层事实）← 三层严格分离 → Human Decision（人工最终决策）
 *         ↕
 *   DecisionSnapshot（AI 分析层数据）
 *
 * 保存方式：追加到候选的 analysisJson 中，不覆盖证据，不修改事实。
 */
export type DecisionSnapshot = {
  /** 快照协议版本 */
  schema: "decision-snapshot.v1";
  /** 生成该快照的 provider */
  provider: string;
  /** 使用的模型标识 */
  model: string;
  /** 输入 facts 的 SHA-256 内容指纹（防篡改追溯） */
  inputFactsHash: string;
  /** AI 输出结论 */
  output: ProductDecision;
  /** 快照创建时刻（ISO 8601） */
  createdAt: string;
};

// ── Provider 接口 ─────────────────────────────────────────────────

/**
 * DecisionProvider — 可插拔 AI 决策供应商接口。
 *
 * 规范：
 * - 实现类不应包含任何业务判断逻辑（例如"P1 门槛是销量 > 1000"这类规则应在 decisionEngine 中定义）；
 * - 实现类只负责：API Key 读取、请求格式转换、响应格式转换、错误处理；
 * - 任何 API 级别错误（超时 / 限流 / Key 失效）必须通过返回 pending/failed 状态处理，不能抛出未捕获异常，也不能偷偷换成 Mock。
 */
export interface DecisionProvider {
  /** Provider 唯一标识符 */
  readonly providerId: string;

  /**
   * 分析商品研究价值，返回 AI 建议。
   * 失败时返回 pending/failed 状态而非抛出。
   */
  analyzeProduct(facts: ProductFacts): Promise<ProductDecision>;

  /**
   * 分析研究优先级（相对于同批候选的相对排序）。
   * 单候选场景可复用 analyzeProduct 结果。
   */
  analyzeResearchPriority(facts: ProductFacts): Promise<ProductDecision>;
}
