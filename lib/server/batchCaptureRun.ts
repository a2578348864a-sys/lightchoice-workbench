import { V3_MODULE_IDS, type V3ModuleId } from "@/lib/sourceLayer/v3ModuleEvidence";
// 本地也需要该常量（re-export 不产生本地绑定）。
import { HARD_MAX_AUTHORIZED_ITEMS } from "@/lib/sourceLayer/captureBudgetConstants";

export const BATCH_CAPTURE_RUN_SCHEMA_VERSION = "batch-capture-run.v2";

/**
 * 单元格级有界自动重试上限。failed_retryable 只有在「显式授权重试」且 attempts 未达上限时
 * 才允许再次进入本轮可执行集合；达到上限即视为本轮终态（不越权重试）。
 * 登录/CAPTCHA 永不进入此路径（落 blocked_human，需要人工）。
 */
export const MAX_CELL_AUTO_ATTEMPTS = 3;

/** 用户可见主状态。COMPLETED 仅当全部自动模块处理结束且至少有有效证据。 */
export type BatchCaptureRunStatus =
  | "WAITING"
  | "RUNNING"
  | "PARTIAL"
  | "HUMAN_REQUIRED"
  | "COMPLETED"
  | "PAUSED"
  | "FAILED"
  | "CANCELLED";

/** 单元格（asin×module）处理状态——权威进度来源。 */
export type BatchCaptureCellStatus =
  | "pending"
  | "succeeded"
  | "partial"
  | "blocked_human"
  | "failed_permanent"
  | "failed_retryable"
  | "skipped_existing"
  | "source_input_required"
  | "not_applicable";

export type BatchCaptureCell = {
  asin: string;
  module: string;
  status: BatchCaptureCellStatus;
  attempts: number;
  evidenceId: string | null;
  lastErrorCode: string | null;
  updatedAt: string;
  /**
   * 真实 EvidenceRef 通过身份校验（来源类型 + 主体绑定 asin/subjectKey 一致）。
   * 仅有字符串 evidenceId 不足以置真——这是「来源校验」而非「字段存在」。
   */
  sourceVerified: boolean;
  /** 该模块字段是否完整（非 partial）。 */
  fieldComplete: boolean;
  /**
   * 是否可被 Research 实际消费：要求 status=succeeded 且 sourceVerified 且 fieldComplete，
   * 并满足下游适配器契约（不含 partial / 来源未校验 / 字段不全）。
   * 不得仅因存在 evidenceId 就宣称 Research 已消费。
   */
  researchConsumable: boolean;
};

/**
 * 查询级 SellerSprite Product Market 结果。它属于 category 查询主体，
 * 与下方 ASIN × module 商品单元分开保存；关联商品只保存来源行与真实商品 Evidence 的绑定。
 */
export type BatchCaptureProductMarketQueryUnit = {
  queryId: string;
  category: string;
  marketplace: "US";
  filters: Record<string, string>;
  status: "pending" | "captured" | "partial" | "blocked" | "human_required" | "failed";
  querySubjectKey: string | null;
  evidenceAttachmentId: string | null;
  evidenceContentHash: string | null;
  rowsObserved: number;
  productAssociations: Array<{
    asin: string;
    rowKey: string;
    rowContentHash: string;
    baseEvidenceId: string;
    baseEvidenceVersion: number;
    baseEvidenceContentHash: string;
  }>;
  errorCode: string | null;
  updatedAt: string;
};

/** Keyword Mining receipt remains bound to one seed query; it has no implicit ASIN rows. */
export type BatchCaptureKeywordMiningQueryUnit = {
  queryId: string;
  seedKeyword: string;
  marketplace: "US";
  conditions: Record<string, string>;
  status: "pending" | "captured" | "blocked" | "human_required" | "failed";
  querySubjectKey: string | null;
  queryFingerprint: string | null;
  evidenceAttachmentId: string | null;
  evidenceContentHash: string | null;
  rowsObserved: number;
  errorCode: string | null;
  updatedAt: string;
};

export type BatchCaptureHandling = "in_progress" | "done" | "human_required" | "not_started";

/**
 * 数据质量（与「执行是否结束」分离）：
 * - unknown：尚未开始或无结论
 * - has_valid：取得通过来源校验的有效证据
 * - empty：全部处理完但无有效证据字段
 * - blocked：遇到人机/权限门槛且无有效证据
 * - source_limited：该模块需要合法来源输入/会话，尚未自动接线（真实缺口）
 */
export type BatchCaptureDataQuality = "unknown" | "has_valid" | "empty" | "blocked" | "source_limited";

export type BatchCaptureModuleOutcome = {
  module: string;
  /** 模块是否已对本轮范围全部商品到达终态（与数据完整性分离）。 */
  handling: BatchCaptureHandling;
  dataQuality: BatchCaptureDataQuality;
  /** 仅 handling=done 且 dataQuality=has_valid 时才为 true。 */
  completed: boolean;
  itemsTotal: number;
  itemsTerminal: number;
  itemsSucceeded: number;
  itemsPartial: number;
  itemsHuman: number;
  itemsFailed: number;
  itemsSkipped: number;
  itemsPending: number;
  validEvidenceCount: number;
  /** 字段完整（非 partial）的商品数。 */
  itemsFieldComplete: number;
  /** 受来源限制（需要合法来源输入/会话，尚未自动接线）的商品数。 */
  itemsSourceLimited: number;
  /** 可被 Research 实际消费的商品数。 */
  itemsResearchConsumable: number;
  message: string | null;
  errorCode: string | null;
};

export type BatchCaptureProgress = {
  itemsInBatch: number;
  /** 任一模块已到终态的唯一商品数。 */
  uniqueItemsVisited: number;
  detailSucceededItems: number;
  pendingCells: number;
  terminalCells: number;
  totalCells: number;
  validEvidenceCells: number;
  /** 字段完整（非 partial）的单元格数。 */
  fieldCompleteCells: number;
  partialCells: number;
  humanCells: number;
  failedCells: number;
  sourceLimitedCells: number;
  /** 可被 Research 实际消费的单元格数（来源+字段+下游契约均满足）。 */
  researchConsumableCells: number;
};

export type BatchCaptureRun = {
  schemaVersion: typeof BATCH_CAPTURE_RUN_SCHEMA_VERSION;
  runId: string;
  batchId: string;
  runGeneration: number;
  /** 写版本：每次成功持久化 +1，用于 CAS。 */
  version: number;
  status: BatchCaptureRunStatus;
  allowedModules: string[];
  /** 用户本次明确授权的商品数量硬上限（1..HARD_MAX）；全链路不得突破。 */
  authorizedItemLimit: number;
  /** 本次授权范围内、且已落入本批次的 ASIN 白名单（唯一可被 Worker 触碰的集合）。 */
  authorizedAsins: string[];
  /** 用户授权的每轮商品预算；任何 advance 不得超过，且不得超过 authorizedItemLimit。 */
  maxItemsPerAdvance: number;
  /**
   * 同一 run 的**共享导航预算**（搜索阶段与所有自动模块共同遵守）。
   * 所有变更都经 run 行的 CAS 条件更新，因此并发 Worker 不可能各自计数后共同突破上限。
   * 计量口径：**我方主动发起的导航**（page.goto 等）；页面内部重定向/子资源不计入，见报告边界说明。
   */
  navigationBudget: {
    limit: number;
    used: number;
    reserved: number;
    updatedAt: string;
    /**
     * 经**显式追加授权**额外获得的导航额度（默认 0）。
     * 与 `limit` 的关系：`limit = min(推导上限 + grantedExtra, HARD_MAX_NAVIGATION_BUDGET)`。
     * 之所以单独存字段而不直接写 `limit`：`limit` 每轮都由 `refreshDerived` 重算，
     * 直接写会被下一次重算覆盖，追加额度将静默丢失。
     */
    grantedExtra?: number;
  };
  /** 驱动器最多执行的 slice 数（有界驱动）。 */
  maxDriveSlices: number;
  /** 是否允许对有界可重试失败自动重试（显式授权；默认 false）。 */
  retryAuthorized: boolean;
  operator: string;
  /** 运行租约：仅持有者可写状态。 */
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  /** 权威单元格矩阵（重算进度的唯一来源）。 */
  cells: BatchCaptureCell[];
  /** 查询级结果与 asin×module cells 分开；旧回执缺失时按空数组读取。 */
  productMarketQueries: BatchCaptureProductMarketQueryUnit[];
  /** Seed-keyword query receipts are independent of the ASIN×module matrix. */
  keywordMiningQueries: BatchCaptureKeywordMiningQueryUnit[];
  moduleOutcomes: BatchCaptureModuleOutcome[];
  progress: BatchCaptureProgress;
  advances: number;
  driveSlices: number;
  lastErrorCode: string | null;
  lastMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 历史代次审计：被本代次取代的上一个 runId。 */
  supersededRunId: string | null;
  /** 事实 A：暂停请求已被接收的时间。 */
  pauseRequestedAt: string | null;
  /** 事实 B：执行器已确认停止（不再发起新导航）的时间。 */
  pauseAcknowledgedAt: string | null;
  /** 事实 A'：中止请求已被接收的时间（与 Worker 实际退出分开记录）。 */
  cancelRequestedAt: string | null;
  /**
   * 事实 B'：执行器已确认「不再领取新工作且在途操作已退出」的时间。
   * pause 与 cancel 共用：只有拿到该确认，租约才可安全释放，
   * UI 也不得仅凭 status 就宣称「已停止」。
   */
  stopAcknowledgedAt: string | null;
  /**
   * 执行代次：每次授予运行租约 +1。
   * 用于把「执行器已退出」的确认绑定到**具体一次执行**，
   * 防止旧代次的确认被用来解除新代次的阻塞。
   */
  executionEpoch: number;
  /**
   * 已获得可信退出确认的最高执行代次。
   * `executionEpoch > acknowledgedEpoch` ⇒ 存在**未确认退出**的执行器：
   * 此时不允许仅凭「租约到期」就启动冲突的新执行（租约到期只证明控制租约过期，
   * 不能证明旧执行器已停止导航、读取页面或写入证据）。
   */
  acknowledgedEpoch: number;
  /** 最近一次运行租约的持有者；租约释放后仍保留，用于绑定退出确认的租约所有者。 */
  lastLeaseOwner: string | null;
  /**
   * 退出确认来源：executor=执行器自身确认；operator=人工核对后确认；
   * control=暂停/中止时已确证没有在途执行，控制操作当场确认；null=尚无确认。
   */
  stopConfirmedBy: "executor" | "operator" | "control" | null;
  /** 人工确认恢复的原因（仅 operator 确认时存在，用于可观察的恢复追溯）。 */
  stopRecoveryReason: string | null;
  /**
   * 绑定的市场采集计划指纹（market-capture-plan.v2）。
   *
   * 语义：本运行代次**只**执行指纹对应的那个计划。计划由服务端权威重算；
   * 指纹变化（策略 / 目标数量 / 授权数量 / 批次容量 / 模块矩阵 / 导航预算任一改变）
   * 一律不允许复用本运行代次，必须显式取消后按新计划重新确认。
   * 兼容：旧代次没有该字段时为 null，不会被误判为「已按计划授权」。
   */
  planFingerprint: string | null;
  /** 绑定的市场采集策略标识（回读展示用；权威判断仍以 planFingerprint 为准）。 */
  planStrategyId: string | null;
  /** 每次明确授权的不可变追加记录；旧 Run 缺失时按首次授权 + 后续追加兼容读取。 */
  authorizationLedger?: BatchCaptureAuthorizationSlice[];
  /** 批次扩充期间的短期 CAS 锁，阻止旧 Run 同时继续或推进。 */
  expansionLock?: { authorizationId: string; acquiredAt: string } | null;
  /**
   * 导航预算追加授权的不可变台账。
   *
   * 为什么需要：`deriveNavigationBudget` 只按「授权商品数 × 自动模块数 + 搜索页数」推导，
   * **不含重试余量**。重试会消耗首轮预算，导致「预算耗尽但仍有 pending 单元」的死结。
   * 这里记录每一次显式追加（额度 / 用途 / 授权编号 / 追加后的上限），
   * 保证任何扩额都可追溯、有上限、可审计。
   */
  navigationTopUps?: BatchCaptureNavigationTopUp[];
};

export type BatchCaptureNavigationTopUp = {
  authorizationId: string;
  /** 本次追加的导航额度（正整数）。 */
  amount: number;
  /** 用途说明（必填，禁止空泛描述）。 */
  purpose: string;
  /** 追加生效后的预算上限。 */
  grantedLimitAfter: number;
  grantedAt: string;
};

export type BatchCaptureAuthorizationSlice = {
  authorizationId: string;
  kind: "initial" | "expansion";
  authorizedAsins: string[];
  authorizedItemCount: number;
  /** 本次用户确认可在搜索来源中尝试发现的新增商品数；与最终命中 ASIN 数分开记录。 */
  authorizedSearchItemLimit: number;
  targetTotal: number;
  newlySearchedItemCount: number;
  reusedEvidenceItemCount: number;
  searchNavigationUsed: number;
  confirmedAt: string;
};

export const AUTO_BATCH_MODULES = [
  "amazon_detail",
  "reverse_asin",
  "variation",
  "review_voc",
] as const satisfies readonly V3ModuleId[];

export const MANUAL_INPUT_MODULES = [
  "sellersprite_product_market",
  "keyword_mining_trend",
  "historical_trend",
] as const satisfies readonly V3ModuleId[];

export const SEARCH_TIME_MODULES = ["amazon_search_market"] as const satisfies readonly V3ModuleId[];

export const ALL_CAPTURE_RUN_MODULES: readonly string[] = V3_MODULE_IDS;

/** 可在 advance/drive 中自动推进的模块（搜索阶段模块在 start 时已终态）。 */
export const ADVANCEABLE_MODULES: readonly string[] = [...AUTO_BATCH_MODULES, ...MANUAL_INPUT_MODULES];

/** 默认运行矩阵：完整八模块，使四个未自动接线模块在用户侧矩阵中真实显示缺口。 */
export const DEFAULT_RUN_MODULES: readonly string[] = ALL_CAPTURE_RUN_MODULES;

export const AUTO_MODULE_IDS: readonly string[] = AUTO_BATCH_MODULES;

/**
 * 单次采集授权商品数硬上限（与 API / collector 校验一致）。
 * 本阶段产品上限为 200 件；>200 的需求以后单独评估。
 * 注意：授权商品数 **不等于** 无限页面访问授权 —— 导航预算单独计算。
 */
// 采集预算常量与推导统一由**客户端安全**模块提供：前端与服务端共用同一实现，
// 从根上消除「前端显示一个数、后端执行另一个数」的预算差异。
export {
  HARD_MAX_AUTHORIZED_ITEMS,
  DEFAULT_AUTHORIZED_ITEMS,
  SEARCH_ITEMS_PER_PAGE,
  HARD_MAX_SEARCH_PAGES,
  NAVIGATIONS_PER_ITEM_PER_MODULE,
  MIN_NAVIGATION_BUDGET,
  HARD_MAX_NAVIGATION_BUDGET,
  MAX_NAVIGATION_TOP_UP,
  MAX_NAVIGATION_TOP_UP_RATIO,
  AUTO_CAPTURE_MODULE_COUNT,
  deriveSearchPages,
  deriveNavigationBudget,
} from "@/lib/sourceLayer/captureBudgetConstants";

export function normalizeAuthorizedItemLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > HARD_MAX_AUTHORIZED_ITEMS) {
    throw new Error("AUTHORIZED_ITEM_LIMIT_INVALID");
  }
  return value;
}

export function isAutoBatchModule(module: string): boolean {
  return (AUTO_BATCH_MODULES as readonly string[]).includes(module);
}

export function isManualInputModule(module: string): boolean {
  return (MANUAL_INPUT_MODULES as readonly string[]).includes(module);
}

export function isSearchTimeModule(module: string): boolean {
  return (SEARCH_TIME_MODULES as readonly string[]).includes(module);
}

export function isKnownModule(module: string): boolean {
  return (V3_MODULE_IDS as readonly string[]).includes(module);
}

export function createCell(
  asin: string,
  module: string,
  now: string,
  status: BatchCaptureCellStatus = "pending",
): BatchCaptureCell {
  return {
    asin,
    module,
    status,
    attempts: 0,
    evidenceId: null,
    lastErrorCode: null,
    updatedAt: now,
    sourceVerified: false,
    fieldComplete: false,
    researchConsumable: false,
  };
}

const TERMINAL_STATUSES: ReadonlySet<BatchCaptureCellStatus> = new Set([
  "succeeded",
  "partial",
  "blocked_human",
  "failed_permanent",
  "failed_retryable",
  "skipped_existing",
  "source_input_required",
  "not_applicable",
]);

export function isTerminalCell(status: BatchCaptureCellStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** 有界可重试：状态为 failed_retryable 且尝试次数未达上限。 */
export function isRetryableCell(cell: BatchCaptureCell): boolean {
  return cell.status === "failed_retryable" && cell.attempts < MAX_CELL_AUTO_ATTEMPTS;
}

/** 本轮可执行（可交给 Worker 处理）：pending，或显式授权下的有界可重试。 */
export function isActionableCell(cell: BatchCaptureCell, allowRetry: boolean): boolean {
  if (cell.status === "pending") return true;
  return allowRetry && isRetryableCell(cell);
}

export function countValidEvidence(cell: BatchCaptureCell): boolean {
  return Boolean(cell.evidenceId)
    && (cell.status === "succeeded" || cell.status === "partial" || cell.status === "skipped_existing");
}

export function deriveModuleOutcome(module: string, cells: BatchCaptureCell[]): BatchCaptureModuleOutcome {
  const scoped = cells.filter((cell) => cell.module === module);
  const itemsTotal = scoped.length;
  const itemsTerminal = scoped.filter((cell) => isTerminalCell(cell.status)).length;
  const itemsSucceeded = scoped.filter((cell) => cell.status === "succeeded").length;
  const itemsPartial = scoped.filter((cell) => cell.status === "partial").length;
  const itemsHuman = scoped.filter((cell) => cell.status === "blocked_human").length;
  const itemsFailed = scoped.filter((cell) => cell.status === "failed_permanent" || cell.status === "failed_retryable").length;
  const itemsSkipped = scoped.filter((cell) => cell.status === "skipped_existing").length;
  const itemsPending = scoped.filter((cell) => cell.status === "pending").length;
  const validEvidenceCount = scoped.filter(countValidEvidence).length;
  const itemsFieldComplete = scoped.filter((cell) => cell.fieldComplete).length;
  const itemsSourceLimited = scoped.filter((cell) => cell.status === "source_input_required").length;
  const itemsResearchConsumable = scoped.filter((cell) => cell.researchConsumable).length;

  let handling: BatchCaptureHandling;
  if (itemsTotal === 0) handling = "not_started";
  else if (itemsHuman > 0) handling = "human_required";
  else handling = itemsTerminal === itemsTotal ? "done" : "in_progress";

  let dataQuality: BatchCaptureDataQuality;
  if (handling === "not_started") dataQuality = "unknown";
  else if (itemsHuman > 0 && validEvidenceCount === 0) dataQuality = "blocked";
  else if (validEvidenceCount > 0) dataQuality = "has_valid";
  else if (itemsSourceLimited > 0 && itemsSourceLimited === itemsTotal) dataQuality = "source_limited";
  else if (handling === "done") dataQuality = "empty";
  else dataQuality = "unknown";

  const completed = handling === "done" && dataQuality === "has_valid";

  let message: string | null = null;
  let errorCode: string | null = null;
  if (handling === "human_required") {
    message = "部分商品遇到登录/人机门槛，已停止自动重试，需要人工处理。";
    errorCode = "HUMAN_ACTION_REQUIRED";
  } else if (dataQuality === "source_limited") {
    message = "该模块需要合法来源输入或人工会话，尚未自动接线（真实缺口，非成功）。";
    errorCode = "SOURCE_INPUT_REQUIRED";
  } else if (handling === "done" && dataQuality === "empty") {
    message = "全部商品已处理，但未取得有效证据字段。";
    errorCode = "MODULE_NO_VALID_EVIDENCE";
  } else if (handling === "in_progress") {
    message = `已处理 ${itemsTerminal}/${itemsTotal}，仍有待执行商品。`;
  } else if (completed) {
    message = `处理结束，有效证据 ${validEvidenceCount}/${itemsTotal}，字段完整 ${itemsFieldComplete}/${itemsTotal}。`;
  }

  return {
    module,
    handling,
    dataQuality,
    completed,
    itemsTotal,
    itemsTerminal,
    itemsSucceeded,
    itemsPartial,
    itemsHuman,
    itemsFailed,
    itemsSkipped,
    itemsPending,
    validEvidenceCount,
    itemsFieldComplete,
    itemsSourceLimited,
    itemsResearchConsumable,
    message,
    errorCode,
  };
}

export function deriveProgress(cells: BatchCaptureCell[], itemsInBatch: number): BatchCaptureProgress {
  const byAsin = new Map<string, BatchCaptureCell[]>();
  for (const cell of cells) {
    const list = byAsin.get(cell.asin) ?? [];
    list.push(cell);
    byAsin.set(cell.asin, list);
  }
  let uniqueItemsVisited = 0;
  let detailSucceededItems = 0;
  for (const list of byAsin.values()) {
    // 只统计自动模块的终态：四个未自动接线模块的 source_input_required 不是「已访问」。
    if (list.some((cell) => isAutoBatchModule(cell.module)
      && cell.status !== "source_input_required"
      && isTerminalCell(cell.status))) uniqueItemsVisited += 1;
    if (list.some((cell) => cell.module === "amazon_detail" && cell.status === "succeeded")) detailSucceededItems += 1;
  }
  return {
    itemsInBatch,
    uniqueItemsVisited,
    detailSucceededItems,
    pendingCells: cells.filter((cell) => cell.status === "pending").length,
    terminalCells: cells.filter((cell) => isTerminalCell(cell.status)).length,
    totalCells: cells.length,
    validEvidenceCells: cells.filter(countValidEvidence).length,
    fieldCompleteCells: cells.filter((cell) => cell.fieldComplete).length,
    partialCells: cells.filter((cell) => cell.status === "partial").length,
    humanCells: cells.filter((cell) => cell.status === "blocked_human").length,
    failedCells: cells.filter((cell) => cell.status === "failed_permanent" || cell.status === "failed_retryable").length,
    sourceLimitedCells: cells.filter((cell) => cell.status === "source_input_required").length,
    researchConsumableCells: cells.filter((cell) => cell.researchConsumable).length,
  };
}

export function deriveModuleOutcomes(modules: readonly string[], cells: BatchCaptureCell[]): BatchCaptureModuleOutcome[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const moduleId of modules) {
    if (!seen.has(moduleId)) {
      seen.add(moduleId);
      ordered.push(moduleId);
    }
  }
  // cells 中存在但未列入 modules 的模块（典型：搜索阶段 amazon_search_market）也必须投影；
  // 否则 moduleOutcomes / UI 矩阵会少一行，与「八模块」口径不一致。
  const extraFromCells: string[] = [];
  for (const cell of cells) {
    if (!seen.has(cell.module)) {
      seen.add(cell.module);
      extraFromCells.push(cell.module);
    }
  }
  extraFromCells.sort((a, b) => {
    const ia = (V3_MODULE_IDS as readonly string[]).indexOf(a);
    const ib = (V3_MODULE_IDS as readonly string[]).indexOf(b);
    return (ia === -1 ? Number.MAX_SAFE_INTEGER : ia) - (ib === -1 ? Number.MAX_SAFE_INTEGER : ib);
  });
  return [...ordered, ...extraFromCells].map((moduleId) => deriveModuleOutcome(moduleId, cells));
}

/**
 * 从权威 cells 重算运行状态。只有「自动模块」参与门禁判定；四个未自动接线模块
 * 以 source_limited 出现在 moduleOutcomes 中，不会把运行错误地推成 PARTIAL/COMPLETED。
 *
 * COMPLETED 仅当：所有自动模块 handling=done，且无 pending，且至少一个自动模块 dataQuality=has_valid，
 * 且不存在未处理的可重试失败（failed_retryable 视为终态但导致 PARTIAL）。
 */
export function deriveBatchCaptureRunStatus(input: {
  modules: readonly string[];
  cells: BatchCaptureCell[];
  cancelled?: boolean;
  pausedByControl?: boolean;
  failedHard?: boolean;
}): BatchCaptureRunStatus {
  if (input.cancelled) return "CANCELLED";
  if (input.failedHard) return "FAILED";
  if (input.pausedByControl) return "PAUSED";

  const outcomes = deriveModuleOutcomes(input.modules, input.cells);
  const autoOutcomes = outcomes.filter((outcome) => isAutoBatchModule(outcome.module));
  if (!autoOutcomes.length) return "WAITING";

  const anyHuman = autoOutcomes.some((outcome) => outcome.handling === "human_required")
    || input.cells.some((cell) => cell.status === "blocked_human");
  const anySourceLimited = autoOutcomes.some((outcome) => outcome.dataQuality === "source_limited");
  const anyPending = autoOutcomes.some((outcome) => outcome.itemsPending > 0)
    || input.cells.some((cell) => cell.status === "pending");
  const allHandled = autoOutcomes.every((outcome) => outcome.handling === "done" || outcome.handling === "human_required");
  const anyValid = autoOutcomes.some((outcome) => outcome.dataQuality === "has_valid");
  const anyEmptyDone = autoOutcomes.some((outcome) => outcome.handling === "done" && outcome.dataQuality === "empty");
  const anyFailed = autoOutcomes.some((outcome) => outcome.itemsFailed > 0);

  /**
   * D2-1H：需要人工处理的单元（登录/验证码门槛）优先于「还有 pending 单元」。
   *
   * 此前 `anyPending` 分支短路在前：只要还有 pending 单元就返回 RUNNING，
   * 即使同时存在 blocked_human——于是「采集中」与「需要人工」并存、
   * 执行器实际已退出而 UI 仍显示采集中（状态与持久化单元不一致）。
   *
   * 正确语义：blocked_human 存在 = 自动执行被人工门槛挡住，剩余 pending 单元
   * 不可能被自动推进（会被同一门槛再次挡住）→ 整个 Run 进入 HUMAN_REQUIRED；
   * pending 单元保留，待人工条件恢复后由「继续」合法恢复执行。
   */
  if (anyHuman) return "HUMAN_REQUIRED";
  if (anyPending) {
    const visited = input.cells.some((cell) => isTerminalCell(cell.status));
    return visited ? "RUNNING" : "WAITING";
  }
  if (!allHandled) return "RUNNING";
  if (anySourceLimited) return "PARTIAL";
  if (anyEmptyDone && !anyValid) return "PARTIAL";
  if (anyValid && (anyFailed || anyEmptyDone)) return "PARTIAL";
  if (anyValid) return "COMPLETED";
  return "PARTIAL";
}

/** 规范化已持久化单元格：兼容旧代次缺失的新字段（缺失按 false 处理）。 */
function normalizeCell(value: unknown): BatchCaptureCell | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.asin !== "string" || typeof row.module !== "string" || typeof row.status !== "string") return null;
  if (typeof row.attempts !== "number") return null;
  return {
    asin: row.asin,
    module: row.module,
    status: row.status as BatchCaptureCellStatus,
    attempts: row.attempts,
    evidenceId: typeof row.evidenceId === "string" ? row.evidenceId : null,
    lastErrorCode: typeof row.lastErrorCode === "string" ? row.lastErrorCode : null,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : new Date(0).toISOString(),
    sourceVerified: row.sourceVerified === true,
    fieldComplete: row.fieldComplete === true,
    researchConsumable: row.researchConsumable === true,
  };
}

function normalizeProductMarketQuery(value: unknown): BatchCaptureProductMarketQueryUnit | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.queryId !== "string" || !row.queryId.trim()
    || typeof row.category !== "string" || !row.category.trim()
    || row.marketplace !== "US"
    || !["pending", "captured", "partial", "blocked", "human_required", "failed"].includes(String(row.status))
    || !row.filters || typeof row.filters !== "object" || Array.isArray(row.filters)
    || !Array.isArray(row.productAssociations)
    || typeof row.rowsObserved !== "number" || !Number.isSafeInteger(row.rowsObserved) || row.rowsObserved < 0) return null;
  const filters: Record<string, string> = {};
  for (const [key, filter] of Object.entries(row.filters as Record<string, unknown>)) {
    if (typeof filter !== "string") return null;
    filters[key] = filter;
  }
  const productAssociations: BatchCaptureProductMarketQueryUnit["productAssociations"] = [];
  for (const raw of row.productAssociations) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const link = raw as Record<string, unknown>;
    if (typeof link.asin !== "string" || !/^[A-Z0-9]{10}$/u.test(link.asin)
      || typeof link.rowKey !== "string" || !link.rowKey.trim()
      || typeof link.rowContentHash !== "string" || !/^[a-f0-9]{64}$/u.test(link.rowContentHash)
      || typeof link.baseEvidenceId !== "string" || !link.baseEvidenceId.trim()
      || typeof link.baseEvidenceVersion !== "number" || !Number.isSafeInteger(link.baseEvidenceVersion) || link.baseEvidenceVersion < 1
      || typeof link.baseEvidenceContentHash !== "string" || !/^[a-f0-9]{64}$/u.test(link.baseEvidenceContentHash)) return null;
    productAssociations.push({
      asin: link.asin,
      rowKey: link.rowKey,
      rowContentHash: link.rowContentHash,
      baseEvidenceId: link.baseEvidenceId,
      baseEvidenceVersion: link.baseEvidenceVersion,
      baseEvidenceContentHash: link.baseEvidenceContentHash,
    });
  }
  return {
    queryId: row.queryId,
    category: row.category,
    marketplace: "US",
    filters,
    status: row.status as BatchCaptureProductMarketQueryUnit["status"],
    querySubjectKey: typeof row.querySubjectKey === "string" ? row.querySubjectKey : null,
    evidenceAttachmentId: typeof row.evidenceAttachmentId === "string" ? row.evidenceAttachmentId : null,
    evidenceContentHash: typeof row.evidenceContentHash === "string" ? row.evidenceContentHash : null,
    rowsObserved: row.rowsObserved,
    productAssociations,
    errorCode: typeof row.errorCode === "string" ? row.errorCode : null,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : new Date(0).toISOString(),
  };
}

function normalizeKeywordMiningQuery(value: unknown): BatchCaptureKeywordMiningQueryUnit | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.queryId !== "string" || !row.queryId.trim()
    || typeof row.seedKeyword !== "string" || !row.seedKeyword.trim()
    || row.marketplace !== "US"
    || !["pending", "captured", "blocked", "human_required", "failed"].includes(String(row.status))
    || !row.conditions || typeof row.conditions !== "object" || Array.isArray(row.conditions)
    || typeof row.rowsObserved !== "number" || !Number.isSafeInteger(row.rowsObserved) || row.rowsObserved < 0) return null;
  const conditions: Record<string, string> = {};
  for (const [key, condition] of Object.entries(row.conditions as Record<string, unknown>)) {
    if (typeof condition !== "string") return null;
    conditions[key] = condition;
  }
  return {
    queryId: row.queryId,
    seedKeyword: row.seedKeyword.normalize("NFC").trim(),
    marketplace: "US",
    conditions,
    status: row.status as BatchCaptureKeywordMiningQueryUnit["status"],
    querySubjectKey: typeof row.querySubjectKey === "string" ? row.querySubjectKey : null,
    queryFingerprint: typeof row.queryFingerprint === "string" ? row.queryFingerprint : null,
    evidenceAttachmentId: typeof row.evidenceAttachmentId === "string" ? row.evidenceAttachmentId : null,
    evidenceContentHash: typeof row.evidenceContentHash === "string" ? row.evidenceContentHash : null,
    rowsObserved: row.rowsObserved,
    errorCode: typeof row.errorCode === "string" ? row.errorCode : null,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : new Date(0).toISOString(),
  };
}

export function parseBatchCaptureRun(value: unknown): BatchCaptureRun | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== BATCH_CAPTURE_RUN_SCHEMA_VERSION) return null;
  if (typeof row.runId !== "string" || typeof row.batchId !== "string") return null;
  if (typeof row.status !== "string") return null;
  if (typeof row.version !== "number") return null;
  if (!Array.isArray(row.allowedModules) || !Array.isArray(row.cells) || !Array.isArray(row.moduleOutcomes)) return null;
  const cells: BatchCaptureCell[] = [];
  for (const raw of row.cells) {
    const cell = normalizeCell(raw);
    if (!cell) return null;
    cells.push(cell);
  }
  const productMarketQueries: BatchCaptureProductMarketQueryUnit[] = [];
  const rawQueries = (row as { productMarketQueries?: unknown }).productMarketQueries;
  if (rawQueries !== undefined && !Array.isArray(rawQueries)) return null;
  for (const raw of (Array.isArray(rawQueries) ? rawQueries : [])) {
    const query = normalizeProductMarketQuery(raw);
    if (!query) return null;
    productMarketQueries.push(query);
  }
  const keywordMiningQueries: BatchCaptureKeywordMiningQueryUnit[] = [];
  const rawKeywordQueries = (row as { keywordMiningQueries?: unknown }).keywordMiningQueries;
  if (rawKeywordQueries !== undefined && !Array.isArray(rawKeywordQueries)) return null;
  for (const raw of (Array.isArray(rawKeywordQueries) ? rawKeywordQueries : [])) {
    const query = normalizeKeywordMiningQuery(raw);
    if (!query) return null;
    keywordMiningQueries.push(query);
  }
  const parsed = value as BatchCaptureRun;
  const authorizedAsins = Array.isArray((row as { authorizedAsins?: unknown }).authorizedAsins)
    ? ((row as { authorizedAsins: string[] }).authorizedAsins)
    : [...new Set(cells.map((cell) => cell.asin))];
  const authorizedItemLimit = typeof (row as { authorizedItemLimit?: unknown }).authorizedItemLimit === "number"
    ? (row as { authorizedItemLimit: number }).authorizedItemLimit
    : authorizedAsins.length;
  const rawBudget = (row as { navigationBudget?: unknown }).navigationBudget;
  const navigationBudget = rawBudget && typeof rawBudget === "object" && !Array.isArray(rawBudget)
    ? {
        limit: Number((rawBudget as { limit?: unknown }).limit ?? 0),
        used: Number((rawBudget as { used?: unknown }).used ?? 0),
        reserved: Number((rawBudget as { reserved?: unknown }).reserved ?? 0),
        updatedAt: String((rawBudget as { updatedAt?: unknown }).updatedAt ?? new Date(0).toISOString()),
        grantedExtra: Math.max(0, Number((rawBudget as { grantedExtra?: unknown }).grantedExtra ?? 0) || 0),
      }
    : { limit: 0, used: 0, reserved: 0, updatedAt: new Date(0).toISOString(), grantedExtra: 0 };
  return {
    ...parsed, cells, productMarketQueries, keywordMiningQueries, authorizedAsins, authorizedItemLimit, navigationBudget,
    navigationTopUps: normalizeNavigationTopUps((row as { navigationTopUps?: unknown }).navigationTopUps),
    authorizationLedger: normalizeAuthorizationLedger(row.authorizationLedger),
    expansionLock: normalizeExpansionLock(row.expansionLock),
    pauseRequestedAt: typeof (row as { pauseRequestedAt?: unknown }).pauseRequestedAt === "string"
      ? (row as { pauseRequestedAt: string }).pauseRequestedAt : null,
    pauseAcknowledgedAt: typeof (row as { pauseAcknowledgedAt?: unknown }).pauseAcknowledgedAt === "string"
      ? (row as { pauseAcknowledgedAt: string }).pauseAcknowledgedAt : null,
    cancelRequestedAt: typeof (row as { cancelRequestedAt?: unknown }).cancelRequestedAt === "string"
      ? (row as { cancelRequestedAt: string }).cancelRequestedAt : null,
    stopAcknowledgedAt: typeof (row as { stopAcknowledgedAt?: unknown }).stopAcknowledgedAt === "string"
      ? (row as { stopAcknowledgedAt: string }).stopAcknowledgedAt : null,
    executionEpoch: Number.isSafeInteger((row as { executionEpoch?: unknown }).executionEpoch)
      && Number((row as { executionEpoch: number }).executionEpoch) >= 0
      ? Number((row as { executionEpoch: number }).executionEpoch) : 0,
    acknowledgedEpoch: Number.isSafeInteger((row as { acknowledgedEpoch?: unknown }).acknowledgedEpoch)
      && Number((row as { acknowledgedEpoch: number }).acknowledgedEpoch) >= 0
      ? Number((row as { acknowledgedEpoch: number }).acknowledgedEpoch) : 0,
    lastLeaseOwner: typeof (row as { lastLeaseOwner?: unknown }).lastLeaseOwner === "string"
      ? (row as { lastLeaseOwner: string }).lastLeaseOwner : null,
    // 兼容三种确认来源：执行器自身 / 人工核对 / 无在途执行时的控制操作当场确认。
    stopConfirmedBy: (["executor", "operator", "control"] as const).find(
      (value) => (row as { stopConfirmedBy?: unknown }).stopConfirmedBy === value,
    ) ?? null,
    stopRecoveryReason: typeof (row as { stopRecoveryReason?: unknown }).stopRecoveryReason === "string"
      ? (row as { stopRecoveryReason: string }).stopRecoveryReason : null,
    planFingerprint: typeof (row as { planFingerprint?: unknown }).planFingerprint === "string"
      && /^[a-f0-9]{64}$/u.test((row as { planFingerprint: string }).planFingerprint)
      ? (row as { planFingerprint: string }).planFingerprint : null,
    planStrategyId: typeof (row as { planStrategyId?: unknown }).planStrategyId === "string"
      ? (row as { planStrategyId: string }).planStrategyId : null,
  };
}

/** 归一化预算追加台账：丢弃结构不完整的条目，避免脏数据抬高预算。 */
function normalizeNavigationTopUps(value: unknown): BatchCaptureNavigationTopUp[] {
  if (!Array.isArray(value)) return [];
  const out: BatchCaptureNavigationTopUp[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.authorizationId !== "string" || !row.authorizationId.trim()
      || typeof row.amount !== "number" || !Number.isSafeInteger(row.amount) || row.amount <= 0
      || typeof row.purpose !== "string" || !row.purpose.trim()
      || typeof row.grantedLimitAfter !== "number" || !Number.isSafeInteger(row.grantedLimitAfter)
      || typeof row.grantedAt !== "string") continue;
    out.push({
      authorizationId: row.authorizationId,
      amount: row.amount,
      purpose: row.purpose,
      grantedLimitAfter: row.grantedLimitAfter,
      grantedAt: row.grantedAt,
    });
  }
  return out;
}

function normalizeAuthorizationLedger(value: unknown): BatchCaptureAuthorizationSlice[] {
  if (!Array.isArray(value)) return [];
  const ledger: BatchCaptureAuthorizationSlice[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.authorizationId !== "string" || !row.authorizationId.trim()
      || (row.kind !== "initial" && row.kind !== "expansion")
      || !Array.isArray(row.authorizedAsins)
      || typeof row.authorizedItemCount !== "number" || !Number.isSafeInteger(row.authorizedItemCount) || row.authorizedItemCount < 0
      || typeof row.targetTotal !== "number" || !Number.isSafeInteger(row.targetTotal) || row.targetTotal < 0
      || typeof row.newlySearchedItemCount !== "number" || !Number.isSafeInteger(row.newlySearchedItemCount) || row.newlySearchedItemCount < 0
      || typeof row.reusedEvidenceItemCount !== "number" || !Number.isSafeInteger(row.reusedEvidenceItemCount) || row.reusedEvidenceItemCount < 0
      || typeof row.searchNavigationUsed !== "number" || !Number.isSafeInteger(row.searchNavigationUsed) || row.searchNavigationUsed < 0
      || typeof row.confirmedAt !== "string") continue;
    const authorizedAsins = row.authorizedAsins.filter((asin): asin is string => typeof asin === "string" && /^[A-Z0-9]{10}$/u.test(asin));
    if (authorizedAsins.length !== row.authorizedAsins.length || authorizedAsins.length !== row.authorizedItemCount) continue;
    ledger.push({
      authorizationId: row.authorizationId,
      kind: row.kind,
      authorizedAsins,
      authorizedItemCount: row.authorizedItemCount,
      authorizedSearchItemLimit: typeof row.authorizedSearchItemLimit === "number"
        && Number.isSafeInteger(row.authorizedSearchItemLimit) && row.authorizedSearchItemLimit >= 0
        ? row.authorizedSearchItemLimit : row.authorizedItemCount,
      targetTotal: row.targetTotal,
      newlySearchedItemCount: row.newlySearchedItemCount,
      reusedEvidenceItemCount: row.reusedEvidenceItemCount,
      searchNavigationUsed: row.searchNavigationUsed,
      confirmedAt: row.confirmedAt,
    });
  }
  return ledger;
}

function normalizeExpansionLock(value: unknown): { authorizationId: string; acquiredAt: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return typeof row.authorizationId === "string" && row.authorizationId.trim()
    && typeof row.acquiredAt === "string"
    ? { authorizationId: row.authorizationId, acquiredAt: row.acquiredAt }
    : null;
}

/**
 * 是否存在**未确认退出**的执行器。
 * 只有 `executionEpoch > acknowledgedEpoch` 才算「执行打开」——
 * 租约到期、leaseOwner 被清空都不构成安全证明。
 */
export function hasUnresolvedExecution(run: Pick<BatchCaptureRun, "executionEpoch" | "acknowledgedEpoch">): boolean {
  return run.executionEpoch > run.acknowledgedEpoch;
}
