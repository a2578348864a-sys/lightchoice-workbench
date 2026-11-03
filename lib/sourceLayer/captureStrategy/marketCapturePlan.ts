/**
 * 市场采集策略层（Market Capture Plan）—— 客户端安全、零服务端依赖。
 *
 * 定位：Source Layer（采集）与 Market Research（市场研究）之间**唯一**的「采集计划」概念。
 *
 *   Search → ProductBatch(Market Batch) → 【MarketCapturePlan】→ 人工一次确认 → Capture Run → 模块执行
 *
 * 边界（刻意收窄，禁止越界）：
 * - 只描述**意图、范围、预算、前置与真实能力**，不执行采集、不写证据、不新建事实存储；
 * - 不导入任何 Worker / 采集器 / 编排器，因此不会触发任何出站请求；
 * - **完整采集是目标覆盖要求，不等于八模块已具备真实采集能力**：
 *   `autoExecutable=false` 的模块保留目标与状态，但必须显式标记未自动接线 / 需来源输入，
 *   绝不为了「八模块全绿」而伪造 Worker 或把仅有回执标成成功；
 * - 市场级 / 关键词级证据与 ASIN 级证据**粒度不同**：`querySubjectKind` 如实区分，
 *   市场级结果不得机械复制成「每个 ASIN 都已完成」；
 * - 缺失值保持 null / unknown，不填 0、不臆造耗时与成功率。
 */

import { MIN_VALID_SAMPLE_COUNT } from "@/lib/marketScan/marketSampleConstants";
import {
  AUTO_CAPTURE_MODULE_COUNT,
  DEFAULT_AUTHORIZED_ITEMS,
  HARD_MAX_AUTHORIZED_ITEMS,
  HARD_MAX_SEARCH_PAGES,
  SEARCH_ITEMS_PER_PAGE,
  deriveNavigationBudget,
  deriveSearchPages,
} from "@/lib/sourceLayer/captureBudgetConstants";

export const MARKET_CAPTURE_PLAN_VERSION = "market-capture-plan.v2" as const;
export const MARKET_CAPTURE_CONFIRMATION_VERSION = "market-capture-confirmation.v1" as const;

/** 八模块唯一清单（与 Capture System V3 一致）。此处内联以避免引入 server-only 模块。 */
export const MARKET_CAPTURE_MODULE_IDS = [
  "amazon_detail",
  "amazon_search_market",
  "sellersprite_product_market",
  "reverse_asin",
  "keyword_mining_trend",
  "variation",
  "review_voc",
  "historical_trend",
] as const;
export type MarketCaptureModuleId = (typeof MARKET_CAPTURE_MODULE_IDS)[number];

export const MARKET_CAPTURE_MODULE_LABELS: Readonly<Record<MarketCaptureModuleId, string>> = {
  amazon_detail: "Amazon 商品详情",
  amazon_search_market: "Amazon 市场搜索 / Top N",
  sellersprite_product_market: "SellerSprite 商品 / 市场深度",
  reverse_asin: "SellerSprite 反查 ASIN",
  keyword_mining_trend: "关键词挖掘 / 趋势",
  variation: "父子变体 / Variation",
  review_voc: "Review / VOC",
  historical_trend: "历史趋势 / 竞争结构",
};

/** 两类策略：完整市场采集（主要模式）与快速市场扫描（可选模式）。 */
export const MARKET_CAPTURE_STRATEGY_IDS = ["full_market_capture", "quick_market_scan"] as const;
export type MarketCaptureStrategyId = (typeof MARKET_CAPTURE_STRATEGY_IDS)[number];

/** 四项基础采集能力（业务默认范围）。 */
export const BASIC_CAPTURE_MODULE_IDS = [
  "amazon_search_market",
  "amazon_detail",
  "variation",
  "review_voc",
] as const satisfies readonly MarketCaptureModuleId[];

/** 可选补充能力：必须用户明确选择并经正式计划确认才进入本轮计划矩阵。 */
export const SUPPLEMENTAL_CAPTURE_MODULE_IDS = [
  "sellersprite_product_market",
  "reverse_asin",
  "keyword_mining_trend",
  "historical_trend",
] as const satisfies readonly MarketCaptureModuleId[];

export const BASIC_CAPTURE_MODULE_LABELS: Readonly<Record<(typeof BASIC_CAPTURE_MODULE_IDS)[number], string>> = {
  amazon_search_market: "商品样本",
  amazon_detail: "商品信息",
  variation: "变体结构",
  review_voc: "评论材料 / Review / VOC",
};

export function isBasicCaptureModule(moduleId: MarketCaptureModuleId): boolean {
  return (BASIC_CAPTURE_MODULE_IDS as readonly string[]).includes(moduleId);
}

export function isSupplementalCaptureModule(moduleId: MarketCaptureModuleId): boolean {
  return (SUPPLEMENTAL_CAPTURE_MODULE_IDS as readonly string[]).includes(moduleId);
}

export const MARKET_CAPTURE_STRATEGY_LABELS: Readonly<Record<MarketCaptureStrategyId, string>> = {
  full_market_capture: "完整市场采集",
  quick_market_scan: "快速市场扫描",
};

export const MARKET_CAPTURE_STRATEGY_DESCRIPTIONS: Readonly<Record<MarketCaptureStrategyId, string>> = {
  full_market_capture: "面向市场分析的数据覆盖：目标覆盖全部八个模块，具备自动执行的模块全量执行，其余模块真实标注未自动接线。",
  quick_market_scan: "优先基础事实：详情与变体全量，其余模块按确定性分层抽样，尽快形成可用于市场研究的样本。",
};

/** 查询主体粒度：决定证据能否按 ASIN 计数。 */
export const MARKET_QUERY_SUBJECT_KINDS = ["asin", "market_query", "keyword_query", "user_supplied_file"] as const;
export type MarketQuerySubjectKind = (typeof MARKET_QUERY_SUBJECT_KINDS)[number];

/**
 * 搜索阶段模块：其证据在**搜索阶段**已经产生（Amazon 搜索结果样本），
 * 不是「确认计划后还需要重新导航执行」的任务。
 * 面板统计必须把它与后续可自动采集的模块分开，否则会把已完成的工作
 * 算成接下来还要重新做的任务（误导性计数）。
 */
export const MARKET_SEARCH_PHASE_MODULE_IDS = ["amazon_search_market"] as const;

/** 模块在本轮计划中的安排状态。 */
export const MARKET_MODULE_PLAN_STATUSES = [
  "scheduled_auto",
  "scheduled_sampled",
  "requires_source_input",
  "not_auto_wired",
  "not_scheduled",
] as const;
export type MarketModulePlanStatus = (typeof MARKET_MODULE_PLAN_STATUSES)[number];

/** 抽样依据（仅抽样模块存在）。 */
export const MARKET_SAMPLE_BASES = ["deterministic_stratified", "none"] as const;
export type MarketSampleBasis = (typeof MARKET_SAMPLE_BASES)[number];

export type MarketCaptureBudget = {
  /** 本模块计划处理的**商品/ASIN 单元数**（不适用于市场级查询时为 0）。 */
  readonly plannedItems: number;
  /** 该模块的查询次数预算（市场级 / 关键词级模块使用）。 */
  readonly plannedQueries: number;
};

export type MarketCapturePlanEntry = {
  readonly module: MarketCaptureModuleId;
  readonly label: string;
  readonly status: MarketModulePlanStatus;
  /** 目标覆盖范围的中文说明。 */
  readonly targetCoverage: string;
  /** 查询主体粒度：asin / market_query / keyword_query / user_supplied_file。 */
  readonly querySubjectKind: MarketQuerySubjectKind;
  /** 当前是否具备可自动调度的真实采集能力（false 不得被显示成已完成）。 */
  readonly autoExecutable: boolean;
  /** 当前来源权限说明（无特殊限制时为 null）。 */
  readonly sourcePermission: string | null;
  /** 必要前置模块（必须先成功写入商品 Evidence）。 */
  readonly requiresBefore: readonly MarketCaptureModuleId[];
  readonly budget: MarketCaptureBudget;
  readonly sampled: boolean;
  readonly sampleBasis: MarketSampleBasis;
  /** 抽样/安排依据的人类可读说明；无则为 null。 */
  readonly sampleNote: string | null;
  /** 未自动接线或需来源输入时的稳定原因码；正常自动安排时为 null。 */
  readonly reasonCode: string | null;
  /** 面向用户的诚实说明。 */
  readonly reason: string;
};

export type MarketCaptureNotCovered = {
  readonly module: MarketCaptureModuleId;
  readonly label: string;
  readonly reasonCode: string;
  readonly reason: string;
};

export type MarketCapturePlan = {
  readonly schemaVersion: typeof MARKET_CAPTURE_PLAN_VERSION;
  readonly strategyId: MarketCaptureStrategyId;
  readonly strategyLabel: string;
  readonly batchId: string;
  /** 市场目标数量：用户提出的目标（不被静默截断）。 */
  readonly marketTargetItemCount: number;
  /** 当前批次容量：批次内可用的 ASIN 数。 */
  readonly batchCapacity: number;
  /** 本次运行授权数量：实际会被处理的上限。 */
  readonly authorizedItemCount: number;
  /** 因超出授权/容量而本次不处理的数量。 */
  readonly deferredItemCount: number;
  readonly entries: readonly MarketCapturePlanEntry[];
  /** 自动可执行的模块数（用于与服务端预算推导保持一致）。 */
  readonly autoExecutableModuleCount: number;
  readonly budget: {
    readonly searchPages: number;
    readonly navigationLimit: number;
    readonly navigationUsedAtStart: number;
    readonly maxItemsPerAdvance: number;
    readonly hardMaxAuthorizedItems: number;
    readonly searchItemsPerPage: number;
  };
  /** 把目标数量拆成受现有硬上限约束的多轮计划。 */
  readonly batching: {
    readonly requiresMultipleRuns: boolean;
    /** 当前已具备执行能力的轮次数（只按本批次可覆盖的商品计算，不虚构未来轮次）。 */
    readonly plannedRuns: number;
    readonly perRunAuthorizedItems: number;
    /** 市场目标中超出当前批次容量、尚无来源商品的数量。 */
    readonly itemsAwaitingSourceSamples: number;
    readonly note: string | null;
  };
  /** 本次不做、且必须在 UI 上如实保留的缺口。 */
  readonly notCovered: readonly MarketCaptureNotCovered[];
  /** 用户需要确认的内容（中文，逐条）。 */
  readonly confirmationItems: readonly string[];
  /** 执行前必须满足的前置条件。 */
  readonly preconditions: readonly string[];
  /** 计划指纹：确认时绑定，防止预算/范围被篡改后重放。 */
  readonly planFingerprint: string;
};

export class MarketCapturePlanError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MarketCapturePlanError";
  }
}

function planError(code: string, message: string): never {
  throw new MarketCapturePlanError(code, message);
}

/** 抽样规模上限：确定性分层抽样，避免只取列表前 N 个造成代表性偏差。 */
export const QUICK_SCAN_SAMPLE_MAX_ITEMS = 15;
/** 抽样模块的最小规模。 */
export const QUICK_SCAN_SAMPLE_MIN_ITEMS = 3;

type ModuleSpec = {
  readonly module: MarketCaptureModuleId;
  readonly status: MarketModulePlanStatus;
  readonly targetCoverage: string;
  readonly querySubjectKind: MarketQuerySubjectKind;
  readonly autoExecutable: boolean;
  readonly sourcePermission: string | null;
  readonly requiresBefore: readonly MarketCaptureModuleId[];
  readonly sampled: boolean;
  readonly reasonCode: string | null;
  readonly reason: string;
  /** 商品单元数：null 表示「全部授权商品」，数字表示固定/抽样值。 */
  readonly items: number | null;
  /** 查询次数：0 表示不按查询计。 */
  readonly queries: number;
  readonly sampledByDefault?: boolean;
};

type StrategySpec = {
  readonly id: MarketCaptureStrategyId;
  readonly modules: readonly ModuleSpec[];
  /** 快速扫描时按比例抽样的模块集合。 */
  readonly sampledModules: readonly MarketCaptureModuleId[];
  /** 快速扫描抽样规模推导（唯一实现）。 */
  readonly sampleSize: (authorizedItemCount: number) => number;
};

/**
 * 确定性分段抽样规模：按授权商品数推导，最少 3、最多 15，且不超过授权数。
 * 抽样由服务端按**序位分段**选点（见 selectStratifiedSampleIndices），
 * 不是取列表前 N 个，因此不会因为列表排序而系统性地偏向头部商品。
 * 注意：这只是「分段抽样」，未经统计验证不得宣称已得到统计学代表性样本。
 */
function quickScanSampleSize(authorizedItemCount: number): number {
  const items = Math.max(0, authorizedItemCount);
  if (items <= QUICK_SCAN_SAMPLE_MIN_ITEMS) return items;
  const proportional = Math.ceil(items / 5);
  return Math.min(QUICK_SCAN_SAMPLE_MAX_ITEMS, Math.max(QUICK_SCAN_SAMPLE_MIN_ITEMS, proportional));
}

/**
 * 确定性分层抽样选点：把 [0, total) 均分为 count 段，每段取中点。
 * 纯函数、可复现、与列表顺序解耦（不偏向头部，也不随机）。
 */
export function selectStratifiedSampleIndices(total: number, count: number): number[] {
  if (!Number.isSafeInteger(total) || total <= 0) return [];
  if (!Number.isSafeInteger(count) || count <= 0) return [];
  const size = Math.min(count, total);
  const indices: number[] = [];
  for (let i = 0; i < size; i += 1) {
    const index = Math.floor(((i + 0.5) * total) / size);
    const bounded = Math.min(total - 1, Math.max(0, index));
    if (!indices.includes(bounded)) indices.push(bounded);
  }
  return indices;
}

const STRATEGIES: Readonly<Record<MarketCaptureStrategyId, StrategySpec>> = {
  full_market_capture: {
    id: "full_market_capture",
    sampledModules: [],
    sampleSize: () => 0,
    modules: [
      {
        module: "amazon_search_market",
        status: "scheduled_auto",
        targetCoverage: "本批次原始搜索词的搜索结果样本",
        querySubjectKind: "market_query",
        autoExecutable: true,
        sourcePermission: null,
        requiresBefore: [],
        sampled: false,
        reasonCode: null,
        reason: "搜索阶段已完成并持久化证据；其证据按市场查询粒度保存，不复制成逐 ASIN 完成。",
        items: 0,
        queries: 1,
      },
      {
        module: "amazon_detail",
        status: "scheduled_auto",
        targetCoverage: "授权范围内的全部商品",
        querySubjectKind: "asin",
        autoExecutable: true,
        sourcePermission: null,
        requiresBefore: [],
        sampled: false,
        reasonCode: null,
        reason: "市场样本的主事实来源；按轮次分批执行，每轮不超过服务端商品预算。",
        items: null,
        queries: 0,
      },
      {
        module: "variation",
        status: "scheduled_auto",
        targetCoverage: "授权范围内的全部商品",
        querySubjectKind: "asin",
        autoExecutable: true,
        sourcePermission: null,
        requiresBefore: ["amazon_detail"],
        sampled: false,
        reasonCode: null,
        reason: "父子变体折叠影响有效样本口径，属于市场样本的一部分。",
        items: null,
        queries: 0,
      },
      {
        module: "review_voc",
        status: "scheduled_auto",
        targetCoverage: "授权范围内的全部商品",
        querySubjectKind: "asin",
        autoExecutable: true,
        sourcePermission: "公开 Top Reviews；完整评论正文受登录与分页限制",
        requiresBefore: ["amazon_detail"],
        sampled: false,
        reasonCode: null,
        reason: "评论与用户声音是需求判断的直接依据；公开片段为 partial，不等于完整评论正文。",
        items: null,
        queries: 0,
      },
      {
        module: "reverse_asin",
        status: "requires_source_input",
        targetCoverage: "授权范围内的全部商品",
        querySubjectKind: "asin",
        autoExecutable: false,
        sourcePermission: "需要本机已登录的 SellerSprite 浏览器会话；账号套餐权限未核实",
        requiresBefore: ["amazon_detail"],
        sampled: false,
        reasonCode: "SELLERSPRITE_SESSION_REQUIRED",
        reason: "需要 SellerSprite 会话与套餐权限；未接线时保留为未执行，不显示为成功。",
        items: null,
        queries: 0,
      },
      {
        module: "keyword_mining_trend",
        status: "requires_source_input",
        targetCoverage: "本批次种子关键词",
        querySubjectKind: "keyword_query",
        autoExecutable: false,
        sourcePermission: "需要本机已登录的 SellerSprite 浏览器会话；账号套餐权限未核实",
        requiresBefore: ["amazon_detail"],
        sampled: false,
        reasonCode: "SELLERSPRITE_SESSION_REQUIRED",
        reason: "关键词结果是查询级证据，不按 ASIN 计数；未接线时保留为未执行。",
        items: 0,
        queries: 1,
      },
      {
        module: "sellersprite_product_market",
        status: "requires_source_input",
        targetCoverage: "类目 / 市场级查询（非逐 ASIN）",
        querySubjectKind: "market_query",
        autoExecutable: false,
        sourcePermission: "需要本机已登录的 SellerSprite 浏览器会话；账号套餐权限未核实",
        requiresBefore: [],
        sampled: false,
        reasonCode: "SELLERSPRITE_SESSION_REQUIRED",
        reason: "类目市场结果属于市场级证据，不会复制成每个 ASIN 都已完成。",
        items: 0,
        queries: 1,
      },
      {
        module: "historical_trend",
        status: "requires_source_input",
        targetCoverage: "需要用户提供的导出文件",
        querySubjectKind: "user_supplied_file",
        autoExecutable: false,
        sourcePermission: "需要可校验的 SellerSprite 历史数据或官方导出",
        requiresBefore: [],
        sampled: false,
        reasonCode: "USER_EXPORT_REQUIRED",
        reason: "必须有真实指标与日期序列；来源不可用时保持未执行，不以单次快照替代趋势。",
        items: null,
        queries: 0,
      },
    ],
  },
  quick_market_scan: {
    id: "quick_market_scan",
    sampledModules: ["review_voc", "keyword_mining_trend"],
    sampleSize: quickScanSampleSize,
    modules: [
      {
        module: "amazon_search_market",
        status: "scheduled_auto",
        targetCoverage: "本批次原始搜索词的搜索结果样本",
        querySubjectKind: "market_query",
        autoExecutable: true,
        sourcePermission: null,
        requiresBefore: [],
        sampled: false,
        reasonCode: null,
        reason: "搜索阶段已完成；市场查询级证据不按 ASIN 复制。",
        items: 0,
        queries: 1,
      },
      {
        module: "amazon_detail",
        status: "scheduled_auto",
        targetCoverage: "授权范围内的全部商品",
        querySubjectKind: "asin",
        autoExecutable: true,
        sourcePermission: null,
        requiresBefore: [],
        sampled: false,
        reasonCode: null,
        reason: "基础事实优先，全量执行。",
        items: null,
        queries: 0,
      },
      {
        module: "variation",
        status: "scheduled_auto",
        targetCoverage: "授权范围内的全部商品",
        querySubjectKind: "asin",
        autoExecutable: true,
        sourcePermission: null,
        requiresBefore: ["amazon_detail"],
        sampled: false,
        reasonCode: null,
        reason: "变体折叠直接影响有效样本数，因此快速扫描仍全量执行。",
        items: null,
        queries: 0,
      },
      {
        module: "review_voc",
        status: "scheduled_sampled",
        targetCoverage: "确定性分层抽样的代表商品",
        querySubjectKind: "asin",
        autoExecutable: true,
        sourcePermission: "公开 Top Reviews；完整评论正文受登录与分页限制",
        requiresBefore: ["amazon_detail"],
        sampled: true,
        reasonCode: null,
        reason: "重模块（每会话商品数受限）；按分层抽样取得代表性需求信号，逐条 VOC 留在商品深研阶段。",
        items: null,
        queries: 0,
      },
      {
        module: "keyword_mining_trend",
        status: "scheduled_sampled",
        targetCoverage: "本批次种子关键词",
        querySubjectKind: "keyword_query",
        autoExecutable: false,
        sourcePermission: "需要本机已登录的 SellerSprite 浏览器会话；账号套餐权限未核实",
        requiresBefore: ["amazon_detail"],
        sampled: true,
        reasonCode: "SELLERSPRITE_SESSION_REQUIRED",
        reason: "查询级证据；会话不可用时保留为未执行。",
        items: 0,
        queries: 1,
      },
      {
        module: "reverse_asin",
        status: "not_scheduled",
        targetCoverage: "本轮不安排",
        querySubjectKind: "asin",
        autoExecutable: false,
        sourcePermission: "需要本机已登录的 SellerSprite 浏览器会话",
        requiresBefore: [],
        sampled: false,
        reasonCode: "DEEP_RESEARCH_ONLY",
        reason: "反查属于单品深挖动作，留在商品深研阶段。",
        items: 0,
        queries: 0,
      },
      {
        module: "sellersprite_product_market",
        status: "not_scheduled",
        targetCoverage: "本轮不安排",
        querySubjectKind: "market_query",
        autoExecutable: false,
        sourcePermission: "需要本机已登录的 SellerSprite 浏览器会话",
        requiresBefore: [],
        sampled: false,
        reasonCode: "DEEP_RESEARCH_ONLY",
        reason: "类目市场深度分析留在商品深研阶段。",
        items: 0,
        queries: 0,
      },
      {
        module: "historical_trend",
        status: "not_scheduled",
        targetCoverage: "本轮不安排",
        querySubjectKind: "user_supplied_file",
        autoExecutable: false,
        sourcePermission: "需要用户提供导出文件",
        requiresBefore: [],
        sampled: false,
        reasonCode: "DEEP_RESEARCH_ONLY",
        reason: "历史趋势留在商品深研阶段。",
        items: 0,
        queries: 0,
      },
    ],
  },
};

export function isMarketCaptureStrategyId(value: unknown): value is MarketCaptureStrategyId {
  return typeof value === "string" && (MARKET_CAPTURE_STRATEGY_IDS as readonly string[]).includes(value);
}

export function isMarketCaptureModuleId(value: unknown): value is MarketCaptureModuleId {
  return typeof value === "string" && (MARKET_CAPTURE_MODULE_IDS as readonly string[]).includes(value);
}

/**
 * 计划指纹：只覆盖**影响执行范围的事实**（策略、批次、授权数量、批次容量、目标数量、模块矩阵与预算）。
 * 任何一项被篡改都会改变指纹，从而让确认无法复用旧回执。
 */
export function computeMarketCapturePlanFingerprint(input: {
  strategyId: MarketCaptureStrategyId;
  batchId: string;
  marketTargetItemCount: number;
  batchCapacity: number;
  authorizedItemCount: number;
  entries: readonly Pick<MarketCapturePlanEntry, "module" | "status" | "budget" | "autoExecutable">[];
  navigationLimit: number;
}): string {
  const canonical = {
    schemaVersion: MARKET_CAPTURE_PLAN_VERSION,
    strategyId: input.strategyId,
    batchId: input.batchId,
    marketTargetItemCount: input.marketTargetItemCount,
    batchCapacity: input.batchCapacity,
    authorizedItemCount: input.authorizedItemCount,
    navigationLimit: input.navigationLimit,
    modules: input.entries.map((entry) => ({
      module: entry.module,
      status: entry.status,
      autoExecutable: entry.autoExecutable,
      plannedItems: entry.budget.plannedItems,
      plannedQueries: entry.budget.plannedQueries,
    })),
  };
  return createFingerprintHash(JSON.stringify(canonical));
}

/**
 * 指纹哈希：使用纯 TS 的 SHA-256 实现，**服务端与浏览器共用同一实现**。
 *
 * 这样做的原因：计划既要在服务端作为权威重算，也要在浏览器端做一致性校验；
 * 若两端使用不同实现（node:crypto vs WebCrypto），一旦出现差异就会出现
 * 「页面算出的指纹和服务端不一致」的假冲突。纯实现同时让本模块保持零依赖、
 * 可被 import 进客户端 bundle。与 node:crypto 的结果一致性由单测固定。
 */
function createFingerprintHash(payload: string): string {
  return sha256Hex(payload);
}

/** 纯 TS SHA-256。 */
export function sha256Hex(message: string): string {
  const bytes = utf8Bytes(message);
  const k = SHA256_K;
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const bitLength = bytes.length * 8;
  const withPadding = bytes.slice();
  withPadding.push(0x80);
  while (withPadding.length % 64 !== 56) withPadding.push(0);
  for (let i = 7; i >= 0; i -= 1) withPadding.push((bitLength / 2 ** (8 * i)) & 0xff);
  const w = new Array<number>(64);
  for (let offset = 0; offset < withPadding.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const base = offset + i * 4;
      w[i] = ((withPadding[base] << 24) | (withPadding[base + 1] << 16) | (withPadding[base + 2] << 8) | withPadding[base + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0; let b = h1; let c = h2; let d = h3; let e = h4; let f = h5; let g = h6; let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + k[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((value) => value.toString(16).padStart(8, "0")).join("");
}

function rotr(value: number, shift: number): number {
  return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}

function utf8Bytes(value: string): number[] {
  const out: number[] = [];
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return out;
}

const SHA256_K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

export type MarketCapturePlanInput = {
  readonly strategyId: MarketCaptureStrategyId;
  readonly batchId: string;
  /** 用户提出的市场目标数量（可以不等于批次容量）。 */
  readonly marketTargetItemCount: number;
  /** 当前批次的可用 ASIN 数。 */
  readonly batchCapacity: number;
  /** 本次运行授权数量；缺省时取 min(目标, 容量, 硬上限)，但实际调用方必须显式给出。 */
  readonly authorizedItemCount?: number;
  /** 搜索阶段已发生的导航次数（计入同一共享预算）。 */
  readonly searchNavigationUsed?: number;
  /**
   * 本轮纳入计划的补充能力（默认空 = 仅四项基础能力）。
   * 只能是 SUPPLEMENTAL_CAPTURE_MODULE_IDS 子集；未选择的补充模块不会进入 allowedModules。
   */
  readonly includedSupplementalModules?: readonly MarketCaptureModuleId[];
};

function assertSafeCount(value: unknown, code: string, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) planError(code, message);
  return value;
}

export function buildMarketCapturePlan(input: MarketCapturePlanInput): MarketCapturePlan {
  if (!isMarketCaptureStrategyId(input.strategyId)) {
    planError("capture_plan_strategy_unknown", `未知的采集策略：${String(input.strategyId)}。`);
  }
  const spec = STRATEGIES[input.strategyId];
  if (typeof input.batchId !== "string" || !input.batchId.trim()) {
    planError("capture_plan_batch_required", "采集计划必须绑定一个可信批次。");
  }
  const batchId = input.batchId.trim();
  const marketTargetItemCount = assertSafeCount(input.marketTargetItemCount, "capture_plan_target_invalid", "市场目标数量必须是 ≥ 0 的整数。");
  const batchCapacity = assertSafeCount(input.batchCapacity, "capture_plan_capacity_invalid", "批次容量必须是 ≥ 0 的整数。");
  // 容量为 0 是最常见的真实阻塞（批次没有可用 ASIN），必须给出专属原因而不是「授权数量非法」。
  if (batchCapacity < 1) {
    planError("capture_plan_capacity_empty", "当前批次没有可采集的商品（无未归档的合法 ASIN）。");
  }
  const requestedAuthorized = input.authorizedItemCount === undefined
    ? Math.min(marketTargetItemCount || batchCapacity, batchCapacity, HARD_MAX_AUTHORIZED_ITEMS)
    : assertSafeCount(input.authorizedItemCount, "capture_plan_authorized_invalid", "授权数量必须是 ≥ 0 的整数。");
  if (requestedAuthorized < 1) {
    planError("capture_plan_authorized_invalid", "授权数量至少为 1；服务端不会默认任何数量。");
  }
  if (requestedAuthorized > HARD_MAX_AUTHORIZED_ITEMS) {
    planError("capture_plan_authorized_over_hard_max", `授权数量不得超过硬上限 ${HARD_MAX_AUTHORIZED_ITEMS}。`);
  }
  const authorizedItemCount = Math.min(requestedAuthorized, batchCapacity);
  if (authorizedItemCount < 1) {
    planError("capture_plan_capacity_empty", "当前批次没有可用于采集的商品。");
  }
  const searchNavigationUsed = assertSafeCount(
    input.searchNavigationUsed ?? 0,
    "capture_plan_navigation_invalid",
    "搜索阶段导航次数必须是 ≥ 0 的整数。",
  );

  // 补充能力：默认不纳入；显式选择后才进入本轮矩阵与 allowedModules。
  const includedSupplemental = new Set<MarketCaptureModuleId>();
  for (const moduleId of input.includedSupplementalModules ?? []) {
    if (!isMarketCaptureModuleId(moduleId)) {
      planError("capture_plan_supplemental_unknown", `未知的补充能力模块：${String(moduleId)}。`);
    }
    if (!isSupplementalCaptureModule(moduleId)) {
      planError("capture_plan_supplemental_not_allowed", `模块 ${moduleId} 不是可选补充能力。`);
    }
    includedSupplemental.add(moduleId);
  }

  const sampleSize = spec.sampleSize(authorizedItemCount);
  const entries: MarketCapturePlanEntry[] = spec.modules
    .filter((moduleSpec) => isBasicCaptureModule(moduleSpec.module) || includedSupplemental.has(moduleSpec.module))
    .map((moduleSpec) => {
    const isSampled = moduleSpec.status === "scheduled_sampled";
    const plannedItems = moduleSpec.items === null
      ? (isSampled ? sampleSize : authorizedItemCount)
      : moduleSpec.items;
    return {
      module: moduleSpec.module,
      label: MARKET_CAPTURE_MODULE_LABELS[moduleSpec.module],
      status: moduleSpec.status,
      targetCoverage: moduleSpec.targetCoverage,
      querySubjectKind: moduleSpec.querySubjectKind,
      autoExecutable: moduleSpec.autoExecutable,
      sourcePermission: moduleSpec.sourcePermission,
      requiresBefore: moduleSpec.requiresBefore,
      budget: { plannedItems, plannedQueries: moduleSpec.queries },
      sampled: isSampled,
      sampleBasis: isSampled ? "deterministic_stratified" : "none",
      sampleNote: isSampled
        ? `按序位分段抽样 ${sampleSize} 件（共 ${authorizedItemCount} 件），不取列表前 N 件；仅为分段抽样，不构成统计学代表性证明。`
        : null,
      reasonCode: moduleSpec.reasonCode,
      reason: moduleSpec.reason,
    };
  });

  // 本轮纳入的模块必须完整、唯一（未选择的补充能力不进入矩阵）。
  for (const entry of entries) {
    const matches = entries.filter((candidate) => candidate.module === entry.module);
    if (matches.length !== 1) {
      planError("capture_plan_module_coverage_invalid", `采集计划的模块 ${entry.module} 必须且只能出现一次（实际 ${matches.length} 次）。`);
    }
  }
  for (const moduleId of BASIC_CAPTURE_MODULE_IDS) {
    if (!entries.some((entry) => entry.module === moduleId)) {
      planError("capture_plan_module_coverage_invalid", `采集计划缺少基础能力模块 ${moduleId}。`);
    }
  }

  const autoExecutableModuleCount = entries.filter((entry) => entry.autoExecutable).length;
  const searchPages = deriveSearchPages(authorizedItemCount);
  const navigationLimit = deriveNavigationBudget(authorizedItemCount, AUTO_CAPTURE_MODULE_COUNT, searchPages);
  if (searchNavigationUsed > navigationLimit) {
    planError(
      "capture_plan_navigation_exceeds_budget",
      `搜索阶段导航消耗 ${searchNavigationUsed} 已超过共享导航预算 ${navigationLimit}，无法生成计划。`,
    );
  }

  const deferredItemCount = Math.max(0, Math.min(marketTargetItemCount, batchCapacity) - authorizedItemCount)
    + Math.max(0, marketTargetItemCount - batchCapacity);
  /**
   * 分批能力合同（修正「requiresMultipleRuns=true 但 plannedRuns=1」的业务冲突）：
   * - 同一 ProductBatch 内 BCR 分轮执行：按 `perRunAuthorizedItems` 计算当前**已具备执行能力**的轮次；
   * - 跨不同 ProductBatch 的新增商品搜索：目标超出当前批次容量的部分**尚无来源商品**，
   *   不得凭空计算「未来一定能完成」的运行次数；
   * - 跨批次去重、统一 MarketScan：当前未支持，不得承诺自动拼成统一市场报告。
   * 三者是不同能力，分别如实报告。
   */
  const perRunAuthorizedItems = Math.min(HARD_MAX_AUTHORIZED_ITEMS, Math.max(1, batchCapacity));
  const coverableItemCount = Math.min(marketTargetItemCount, batchCapacity);
  /** 目标中超出当前批次容量、尚无来源商品的数量（需要新增符合相同市场范围的样本）。 */
  const itemsAwaitingSourceSamples = Math.max(0, marketTargetItemCount - batchCapacity);
  const plannedRuns = marketTargetItemCount <= 0
    ? 1
    : Math.max(1, Math.ceil(coverableItemCount / perRunAuthorizedItems));
  const requiresMultipleRuns = plannedRuns > 1;
  const batchingNote = itemsAwaitingSourceSamples > 0
    ? `市场目标 ${marketTargetItemCount} 件，本批次最多覆盖 ${coverableItemCount} 件，`
      + `剩余 ${itemsAwaitingSourceSamples} 件尚无来源商品，需要新增符合相同市场范围的样本。`
      + "同一批次内可按轮次分批执行，但跨批次聚合当前未支持，不会自动拼成统一市场报告。"
    : requiresMultipleRuns
      ? `市场目标 ${marketTargetItemCount} 件超过单轮授权上限 ${perRunAuthorizedItems} 件；`
        + "将在同一批次内分多轮执行（后续轮次沿用同一授权），跨批次聚合当前未支持。"
      : null;

  const notCovered = entries
    .filter((entry) => entry.status === "requires_source_input" || entry.status === "not_auto_wired" || entry.status === "not_scheduled")
    .map((entry) => ({
      module: entry.module,
      label: entry.label,
      reasonCode: entry.reasonCode ?? "NOT_AUTO_WIRED",
      reason: entry.reason,
    }));

  const confirmationItems: string[] = [
    `策略：${MARKET_CAPTURE_STRATEGY_LABELS[spec.id]}。`,
    `本次运行授权商品数量：${authorizedItemCount} 件（批次可用 ${batchCapacity} 件，市场目标 ${marketTargetItemCount} 件）。`,
    `本轮纳入计划的能力：${entries.length} 项（默认仅四项基础能力；补充能力需显式选择）；自动可执行 ${autoExecutableModuleCount} 项。`,
    `共享导航预算上限：${navigationLimit} 次（按本运行代次的授权数量单独计算，起点为搜索阶段已用 ${searchNavigationUsed} 次；上一代次的模块导航消耗不累加）。`,
    "确认后系统按此计划自动分批推进，不需要逐件点击。",
  ];
  if (itemsAwaitingSourceSamples > 0) {
    confirmationItems.push(
      `目标中有 ${itemsAwaitingSourceSamples} 件商品尚无来源样本（本批次最多覆盖 ${coverableItemCount} 件）；`
      + "需要新增符合相同市场范围的搜索批次，当前不支持跨批次自动聚合。",
    );
  }
  if (notCovered.length) {
    confirmationItems.push(`本次不覆盖：${notCovered.map((entry) => entry.label).join("、")}（原因已在计划中逐项列出）。`);
  }

  const preconditions: string[] = [];
  if (spec.id === "quick_market_scan") {
    preconditions.push(`快速扫描为分段抽样策略；建立正式市场研究仍需 ${MIN_VALID_SAMPLE_COUNT} 件有效商品。`);
  }
  preconditions.push("Amazon 详情必须先成功写入商品 Evidence，附件类模块（变体 / 评论 / 关键词）才可能写入。");
  if (entries.some((entry) => entry.autoExecutable && entry.sourcePermission !== null)) {
    preconditions.push("带来源权限说明的模块受来源会话与账号权限约束；不可用时会记录为未执行或受限，不伪造证据。");
  }
  if (deferredItemCount > 0) {
    preconditions.push(
      `本次有 ${deferredItemCount} 件商品不在本次授权范围内（超出授权上限或批次容量）；`
      + "跨批次聚合当前未支持，需要后续独立能力，不会静默截断也不会计入本次结果。",
    );
  }
  preconditions.push(
    "「同一批次内分轮执行」「跨不同批次新增商品搜索」「跨批次去重后统一 MarketScan」是三种不同能力；"
    + "后两者当前均未支持，目标数量不会因为它们而被自动凑齐。",
  );

  return {
    schemaVersion: MARKET_CAPTURE_PLAN_VERSION,
    strategyId: spec.id,
    strategyLabel: MARKET_CAPTURE_STRATEGY_LABELS[spec.id],
    batchId,
    marketTargetItemCount,
    batchCapacity,
    authorizedItemCount,
    deferredItemCount,
    entries,
    autoExecutableModuleCount,
    budget: {
      searchPages,
      navigationLimit,
      navigationUsedAtStart: searchNavigationUsed,
      maxItemsPerAdvance: Math.min(5, authorizedItemCount),
      hardMaxAuthorizedItems: HARD_MAX_AUTHORIZED_ITEMS,
      searchItemsPerPage: SEARCH_ITEMS_PER_PAGE,
    },
    batching: {
      requiresMultipleRuns,
      plannedRuns,
      perRunAuthorizedItems,
      itemsAwaitingSourceSamples,
      note: batchingNote,
    },
    notCovered,
    confirmationItems,
    preconditions,
    planFingerprint: computeMarketCapturePlanFingerprint({
      strategyId: spec.id,
      batchId,
      marketTargetItemCount,
      batchCapacity,
      authorizedItemCount,
      entries,
      navigationLimit,
    }),
  };
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * 严格解析：任何被篡改、缺字段、重复模块、负预算、非法枚举或版本不符一律返回 null（fail-closed）。
 * 服务端不接受客户端提交的计划作为权威 —— 本函数只用于回读与比对，权威计划始终由服务端重算。
 */
export function parseMarketCapturePlan(value: unknown): MarketCapturePlan | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== MARKET_CAPTURE_PLAN_VERSION) return null;
  if (!isMarketCaptureStrategyId(row.strategyId)) return null;
  if (typeof row.batchId !== "string" || !row.batchId.trim()) return null;
  if (typeof row.strategyLabel !== "string") return null;
  const numericFields = ["marketTargetItemCount", "batchCapacity", "authorizedItemCount", "deferredItemCount", "autoExecutableModuleCount"] as const;
  for (const field of numericFields) {
    const raw = row[field];
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) return null;
  }
  if ((row.authorizedItemCount as number) < 1) return null;
  if ((row.authorizedItemCount as number) > (row.batchCapacity as number)) return null;
  if (!Array.isArray(row.entries)) return null;
  if (row.entries.length < BASIC_CAPTURE_MODULE_IDS.length || row.entries.length > MARKET_CAPTURE_MODULE_IDS.length) return null;

  const entries: MarketCapturePlanEntry[] = [];
  const seen = new Set<string>();
  for (const raw of row.entries) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const entry = raw as Record<string, unknown>;
    if (!isMarketCaptureModuleId(entry.module)) return null;
    if (seen.has(entry.module)) return null;
    seen.add(entry.module);
    if (!MARKET_MODULE_PLAN_STATUSES.includes(entry.status as MarketModulePlanStatus)) return null;
    if (!MARKET_QUERY_SUBJECT_KINDS.includes(entry.querySubjectKind as MarketQuerySubjectKind)) return null;
    if (typeof entry.autoExecutable !== "boolean") return null;
    if (entry.sourcePermission !== null && typeof entry.sourcePermission !== "string") return null;
    if (typeof entry.sampled !== "boolean") return null;
    if (!MARKET_SAMPLE_BASES.includes(entry.sampleBasis as MarketSampleBasis)) return null;
    if (entry.sampleNote !== null && typeof entry.sampleNote !== "string") return null;
    if (entry.reasonCode !== null && typeof entry.reasonCode !== "string") return null;
    if (typeof entry.reason !== "string" || typeof entry.targetCoverage !== "string" || typeof entry.label !== "string") return null;
    if (!Array.isArray(entry.requiresBefore)) return null;
    const requiresBefore: MarketCaptureModuleId[] = [];
    for (const dependency of entry.requiresBefore) {
      if (!isMarketCaptureModuleId(dependency)) return null;
      requiresBefore.push(dependency);
    }
    const budget = entry.budget;
    if (typeof budget !== "object" || budget === null || Array.isArray(budget)) return null;
    const budgetRow = budget as Record<string, unknown>;
    for (const field of ["plannedItems", "plannedQueries"] as const) {
      const raw2 = budgetRow[field];
      if (typeof raw2 !== "number" || !Number.isSafeInteger(raw2) || raw2 < 0) return null;
    }
    // 抽样模块必须给出真正的抽样口径；非抽样模块不得伪装成抽样。
    if (entry.sampled !== (entry.status === "scheduled_sampled")) return null;
    if (entry.sampled && entry.sampleBasis !== "deterministic_stratified") return null;
    entries.push({
      module: entry.module,
      label: entry.label,
      status: entry.status as MarketModulePlanStatus,
      targetCoverage: entry.targetCoverage,
      querySubjectKind: entry.querySubjectKind as MarketQuerySubjectKind,
      autoExecutable: entry.autoExecutable,
      sourcePermission: (entry.sourcePermission as string | null) ?? null,
      requiresBefore,
      budget: { plannedItems: budgetRow.plannedItems as number, plannedQueries: budgetRow.plannedQueries as number },
      sampled: entry.sampled,
      sampleBasis: entry.sampleBasis as MarketSampleBasis,
      sampleNote: (entry.sampleNote as string | null) ?? null,
      reasonCode: (entry.reasonCode as string | null) ?? null,
      reason: entry.reason,
    });
  }
  for (const moduleId of BASIC_CAPTURE_MODULE_IDS) {
    if (!seen.has(moduleId)) return null;
  }
  // 补充能力：只允许已声明的 SUPPLEMENTAL 子集，不得出现未知模块。
  for (const moduleId of seen) {
    if (!isBasicCaptureModule(moduleId as MarketCaptureModuleId) && !isSupplementalCaptureModule(moduleId as MarketCaptureModuleId)) return null;
  }

  const budget = row.budget;
  if (typeof budget !== "object" || budget === null || Array.isArray(budget)) return null;
  const budgetRow = budget as Record<string, unknown>;
  for (const field of ["searchPages", "navigationLimit", "navigationUsedAtStart", "maxItemsPerAdvance", "hardMaxAuthorizedItems", "searchItemsPerPage"] as const) {
    const raw = budgetRow[field];
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) return null;
  }
  if ((budgetRow.searchPages as number) < 1 || (budgetRow.searchPages as number) > HARD_MAX_SEARCH_PAGES) return null;
  if ((budgetRow.navigationLimit as number) < 1) return null;
  if ((budgetRow.navigationUsedAtStart as number) > (budgetRow.navigationLimit as number)) return null;
  if ((budgetRow.maxItemsPerAdvance as number) < 1) return null;
  if ((budgetRow.hardMaxAuthorizedItems as number) !== HARD_MAX_AUTHORIZED_ITEMS) return null;

  const batching = row.batching;
  if (typeof batching !== "object" || batching === null || Array.isArray(batching)) return null;
  const batchingRow = batching as Record<string, unknown>;
  if (typeof batchingRow.requiresMultipleRuns !== "boolean") return null;
  if (typeof batchingRow.plannedRuns !== "number" || !Number.isSafeInteger(batchingRow.plannedRuns) || batchingRow.plannedRuns < 1) return null;
  if (typeof batchingRow.perRunAuthorizedItems !== "number" || !Number.isSafeInteger(batchingRow.perRunAuthorizedItems) || batchingRow.perRunAuthorizedItems < 1) return null;
  if (typeof batchingRow.itemsAwaitingSourceSamples !== "number" || !Number.isSafeInteger(batchingRow.itemsAwaitingSourceSamples) || batchingRow.itemsAwaitingSourceSamples < 0) return null;
  // 分批合同自洽：plannedRuns 必须等于按本批次可覆盖商品数与单轮上限推导的轮次数，
  // 且不得与 requiresMultipleRuns 矛盾（防止「requiresMultipleRuns=true 但 plannedRuns=1」重新出现）。
  const expectedPlannedRuns = Math.max(
    1,
    Math.ceil(Math.min(row.marketTargetItemCount as number, row.batchCapacity as number) / (batchingRow.perRunAuthorizedItems as number)),
  );
  if ((batchingRow.plannedRuns as number) !== expectedPlannedRuns) return null;
  if (batchingRow.requiresMultipleRuns !== (batchingRow.plannedRuns as number) > 1) return null;
  const expectedAwaiting = Math.max(0, (row.marketTargetItemCount as number) - (row.batchCapacity as number));
  if ((batchingRow.itemsAwaitingSourceSamples as number) !== expectedAwaiting) return null;
  if (batchingRow.note !== null && typeof batchingRow.note !== "string") return null;

  if (!Array.isArray(row.notCovered)) return null;
  const notCovered: MarketCaptureNotCovered[] = [];
  for (const raw of row.notCovered) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (!isMarketCaptureModuleId(item.module)) return null;
    if (typeof item.label !== "string" || typeof item.reasonCode !== "string" || typeof item.reason !== "string") return null;
    notCovered.push({ module: item.module, label: item.label, reasonCode: item.reasonCode, reason: item.reason });
  }
  if (!Array.isArray(row.confirmationItems) || !row.confirmationItems.every((item) => typeof item === "string")) return null;
  if (!Array.isArray(row.preconditions) || !row.preconditions.every((item) => typeof item === "string")) return null;
  if (typeof row.planFingerprint !== "string" || !SHA256_PATTERN.test(row.planFingerprint)) return null;

  // 指纹必须与内容自洽：篡改任一执行范围字段都会导致解析失败。
  const expected = computeMarketCapturePlanFingerprint({
    strategyId: row.strategyId,
    batchId: row.batchId,
    marketTargetItemCount: row.marketTargetItemCount as number,
    batchCapacity: row.batchCapacity as number,
    authorizedItemCount: row.authorizedItemCount as number,
    entries,
    navigationLimit: budgetRow.navigationLimit as number,
  });
  if (expected !== row.planFingerprint) return null;

  return {
    schemaVersion: MARKET_CAPTURE_PLAN_VERSION,
    strategyId: row.strategyId,
    strategyLabel: row.strategyLabel,
    batchId: row.batchId,
    marketTargetItemCount: row.marketTargetItemCount as number,
    batchCapacity: row.batchCapacity as number,
    authorizedItemCount: row.authorizedItemCount as number,
    deferredItemCount: row.deferredItemCount as number,
    entries,
    autoExecutableModuleCount: row.autoExecutableModuleCount as number,
    budget: {
      searchPages: budgetRow.searchPages as number,
      navigationLimit: budgetRow.navigationLimit as number,
      navigationUsedAtStart: budgetRow.navigationUsedAtStart as number,
      maxItemsPerAdvance: budgetRow.maxItemsPerAdvance as number,
      hardMaxAuthorizedItems: budgetRow.hardMaxAuthorizedItems as number,
      searchItemsPerPage: budgetRow.searchItemsPerPage as number,
    },
    batching: {
      requiresMultipleRuns: batchingRow.requiresMultipleRuns,
      plannedRuns: batchingRow.plannedRuns as number,
      perRunAuthorizedItems: batchingRow.perRunAuthorizedItems as number,
      itemsAwaitingSourceSamples: batchingRow.itemsAwaitingSourceSamples as number,
      note: (batchingRow.note as string | null) ?? null,
    },
    notCovered,
    confirmationItems: row.confirmationItems as string[],
    preconditions: row.preconditions as string[],
    planFingerprint: row.planFingerprint,
  };
}

/** 服务端权威计划推导：客户端只能提交 strategyId + 目标数量，其余一律服务端重算。 */
export function deriveAuthoritativeMarketCapturePlan(input: {
  strategyId: unknown;
  batchId: string;
  batchCapacity: number;
  marketTargetItemCount: unknown;
  authorizedItemCount?: unknown;
  searchNavigationUsed: number;
  includedSupplementalModules?: unknown;
}): MarketCapturePlan {
  if (!isMarketCaptureStrategyId(input.strategyId)) {
    planError("capture_plan_strategy_unknown", "必须选择一个已冻结的采集策略。");
  }
  const target = input.marketTargetItemCount === undefined || input.marketTargetItemCount === null
    ? input.batchCapacity
    : input.marketTargetItemCount;
  const marketTargetItemCount = assertSafeCount(
    target,
    "capture_plan_target_invalid",
    "市场目标数量必须是 ≥ 0 的整数。",
  );
  const authorizedRaw = input.authorizedItemCount === undefined || input.authorizedItemCount === null
    ? Math.min(
        Math.max(1, marketTargetItemCount === 0 ? input.batchCapacity : marketTargetItemCount),
        input.batchCapacity,
        HARD_MAX_AUTHORIZED_ITEMS,
      )
    : assertSafeCount(input.authorizedItemCount, "capture_plan_authorized_invalid", "授权数量必须是 ≥ 0 的整数。");
  const includedSupplementalModules = normalizeSupplementalModules(input.includedSupplementalModules);
  return buildMarketCapturePlan({
    strategyId: input.strategyId,
    batchId: input.batchId,
    marketTargetItemCount,
    batchCapacity: input.batchCapacity,
    authorizedItemCount: authorizedRaw,
    searchNavigationUsed: input.searchNavigationUsed,
    includedSupplementalModules,
  });
}

function normalizeSupplementalModules(value: unknown): MarketCaptureModuleId[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    planError("capture_plan_supplemental_invalid", "补充能力必须是数组。");
  }
  const unique: MarketCaptureModuleId[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isMarketCaptureModuleId(item) || !isSupplementalCaptureModule(item)) {
      planError("capture_plan_supplemental_invalid", `非法补充能力：${String(item)}。`);
    }
    if (!unique.includes(item)) unique.push(item);
  }
  return unique;
}

/** 默认目标数量（UI 与测试共用）。 */
export const DEFAULT_MARKET_TARGET_ITEM_COUNT = DEFAULT_AUTHORIZED_ITEMS;

/**
 * 八模块的四类统计（A1：区分搜索阶段与后续采集，禁止把已完成的搜索算成待执行任务）。
 *
 * 完整与快速两种策略使用同一推导口径；四个桶互斥且穷尽，总数恒等于 8：
 * - `searchPhase`：搜索阶段已产生来源证据的模块（amazon_search_market）；
 * - `subsequentAuto`：确认计划后可自动执行的模块（不含搜索阶段）；
 * - `requiresSourceInput`：需要额外来源输入（会话 / 导出文件）的模块；
 * - `notScheduled`：本轮不安排、但仍在八模块视图中如实保留的模块。
 *
 * 注意：统计只回答「计划怎么安排」，不回答「证据是否已存在」——
 * 搜索证据是否存在/可核验由 batchContext.searchNavigationKnown 单独如实显示。
 */
export type MarketCaptureModuleClassCounts = {
  readonly searchPhase: number;
  readonly subsequentAuto: number;
  readonly requiresSourceInput: number;
  readonly notScheduled: number;
  readonly total: number;
};

export function classifyMarketCapturePlanModules(
  plan: Pick<MarketCapturePlan, "entries">,
): MarketCaptureModuleClassCounts {
  let searchPhase = 0;
  let subsequentAuto = 0;
  let requiresSourceInput = 0;
  let notScheduled = 0;
  for (const entry of plan.entries) {
    const isSearchPhase = (MARKET_SEARCH_PHASE_MODULE_IDS as readonly string[]).includes(entry.module);
    if (isSearchPhase) {
      searchPhase += 1;
      continue;
    }
    if (entry.status === "not_scheduled" || entry.status === "not_auto_wired") {
      notScheduled += 1;
      continue;
    }
    if (entry.status === "requires_source_input") {
      requiresSourceInput += 1;
      continue;
    }
    // scheduled_auto / scheduled_sampled：具备自动执行能力才算「后续可自动采集」，
    // 否则（如抽样安排但无来源会话）归入「需要来源输入」，不冒充可自动执行。
    if (entry.autoExecutable) subsequentAuto += 1;
    else requiresSourceInput += 1;
  }
  return {
    searchPhase,
    subsequentAuto,
    requiresSourceInput,
    notScheduled,
    total: plan.entries.length,
  };
}
