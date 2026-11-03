/**
 * BatchCaptureRun → 用户可理解视图 的纯投影层（presentation-only）。
 *
 * 三条语义纪律（P0 阶段二纠偏）：
 * 1) 市场研究门槛与商品深研门禁**分开**，各自消费服务端权威判定，本层**不合成**统一的
 *    `research.satisfied`，避免用自造条件替代既有业务门禁：
 *      - 市场研究：服务端 `validProductSet.isSufficient`（>= MIN_VALID_SAMPLE_COUNT 有效样本）。
 *      - 商品深研：服务端 `SourceItemDTO.usageStatus === "research_ready"`（源自 evidenceStatus）。
 * 2) 「尚未接入自动采集」与「来源权限受限」分开；仅当存在真实权限类错误码时才显示后者。
 * 3) 每个百分比都必须说明它是什么进度：商品已访问 / 自动模块处理 / 有效证据覆盖 / 字段完整度。
 */
import { MIN_VALID_SAMPLE_COUNT } from "@/lib/marketScan/marketSampleConstants";
import type { BatchCaptureKeywordMiningQueryUnit, BatchCaptureProductMarketQueryUnit } from "@/lib/server/batchCaptureRun";

export const BATCH_CAPTURE_MODULE_LABELS: Record<string, string> = {
  amazon_search_market: "Amazon 搜索市场",
  amazon_detail: "Amazon 商品详情",
  variation: "父子变体",
  review_voc: "评论与 VOC",
  sellersprite_product_market: "卖家精灵商品市场",
  reverse_asin: "反查 ASIN",
  keyword_mining_trend: "关键词挖掘与趋势",
  historical_trend: "历史趋势",
};

/** 已接入自动执行器的模块（其余为缺口，不等于永久不可解）。 */
export const BATCH_CAPTURE_AUTO_MODULES: readonly string[] = ["amazon_detail", "variation", "review_voc"];

const MODULE_ORDER: readonly string[] = [
  "amazon_search_market",
  "amazon_detail",
  "variation",
  "review_voc",
  "sellersprite_product_market",
  "reverse_asin",
  "keyword_mining_trend",
  "historical_trend",
];

/** 客户端安全的八模块顺序（与官方 Registry 一致），供启动表单展示授权模块范围。 */
export const BATCH_CAPTURE_MODULE_ORDER: readonly string[] = MODULE_ORDER;

/** 只有这些真实权限/权益类错误码才允许把缺口标为「来源权限受限」。 */
export const SOURCE_PERMISSION_ERROR_CODES: ReadonlySet<string> = new Set([
  "PROVIDER_PLAN_LIMITED",
  "SOURCE_ACCESS_DENIED",
  "SELLERSPRITE_LOGIN_REQUIRED",
  "SELLERSPRITE_EXTENSION_REQUIRED",
  "EXTENSION_REQUIRED",
  "BROWSER_USE_CONNECTION_UNAVAILABLE",
  "BROWSER_USE_REMOTE_DEBUGGING_REQUIRED",
  "ACCOUNT_ENTITLEMENT_REQUIRED",
]);

export type BatchCaptureModuleWiring = "search_phase" | "auto_wired" | "not_wired" | "source_permission";

export const WIRING_LABELS: Record<BatchCaptureModuleWiring, string> = {
  search_phase: "搜索阶段",
  auto_wired: "已接自动",
  not_wired: "尚未接入自动采集",
  source_permission: "来源权限受限",
};

/**
 * 采集缺口五分类（纯展示层；**不改变**任何进度/覆盖率/研究资格计数）。
 *
 * 背景事实：`deriveModuleOutcome` 会把模块错误码统一成 `SOURCE_INPUT_REQUIRED`
 * （`lib/server/batchCaptureRun.ts`），所以真实错误码只在两处：
 *   - reverse_asin 的 `cell.lastErrorCode`；
 *   - run 的 `productMarketQueries` / `keywordMiningQueries`（status/errorCode/querySubjectKey）。
 *
 * 分类目的：让「1 个批次级查询未执行」不再被写成「N 个商品未接入」，
 * 并让来源开关关闭、需要人工导出文件、商品级失败、商品级字段不完整各自有恢复条件。
 * `product_not_captured` 是回退类：确实没有任何批次级查询/开关证据时的商品级未采集。
 */
export type BatchCaptureGapCategory =
  | "batch_query_not_executed"
  | "source_switch_disabled"
  | "human_input_required"
  | "product_capture_failed"
  | "product_field_incomplete"
  | "product_not_captured";

export const BATCH_CAPTURE_GAP_CATEGORY_LABELS: Record<BatchCaptureGapCategory, string> = {
  batch_query_not_executed: "批次级查询未执行",
  source_switch_disabled: "来源开关关闭",
  human_input_required: "需要人工输入",
  product_capture_failed: "商品级采集失败",
  product_field_incomplete: "商品级字段不完整",
  product_not_captured: "商品级未采集",
};

export type BatchCaptureGap = {
  category: BatchCaptureGapCategory;
  categoryLabel: string;
  scope: "batch_query" | "module" | "item";
  module: string | null;
  label: string;
  /** 受影响单元数（仅展示；不参与任何百分比/覆盖率计算）。 */
  affectedCount: number;
  detail: string;
  /** 恢复条件 / 下一步（只描述事实与合法动作，不承诺已修复）。 */
  recovery: string;
  /** 对应的真实错误码（如 SELLERSPRITE_*_BCR_DISABLED）；没有时为 null。 */
  reasonCode: string | null;
  /** 该缺口在旧 `gaps: string[]` 中的完整一句话（面板不再重复渲染）。 */
  text: string;
};

/** SellerSprite 真实来源执行开关关闭类错误码（来自 cell.lastErrorCode 或 query.errorCode）。 */
export const SELLERSPRITE_SWITCH_DISABLED_CODES: ReadonlySet<string> = new Set([
  "SELLERSPRITE_PRODUCT_MARKET_BCR_DISABLED",
  "SELLERSPRITE_KEYWORD_MINING_BCR_DISABLED",
  "SELLERSPRITE_REVERSE_ASIN_BCR_DISABLED",
]);

const SELLERSPRITE_SWITCH_LABELS: Record<string, string> = {
  SELLERSPRITE_PRODUCT_MARKET_BCR_DISABLED:
    "「SellerSprite 商品市场 BCR 真实来源执行」开关（SELLERSPRITE_PRODUCT_MARKET_BCR_ENABLED）",
  SELLERSPRITE_KEYWORD_MINING_BCR_DISABLED:
    "「SellerSprite 关键词挖掘 BCR 真实来源执行」开关（SELLERSPRITE_KEYWORD_MINING_BCR_ENABLED）",
  SELLERSPRITE_REVERSE_ASIN_BCR_DISABLED:
    "「SellerSprite 反查 ASIN BCR 真实来源执行」开关（SELLERSPRITE_REVERSE_ASIN_BCR_ENABLED）",
};

const QUERY_STATUS_LABELS: Record<string, string> = {
  pending: "等待有界推进",
  captured: "查询级证据已保存",
  partial: "部分查询结果",
  blocked: "前置条件阻止",
  human_required: "需要人工处理",
  failed: "查询失败",
};

/**
 * 证据去向说明（面板原样展示；不得写成「已消费」）。
 * 查询级证据与商品级附件的下游边界不同，必须分开说明。
 */
export const BATCH_CAPTURE_EVIDENCE_DESTINATION = {
  queryLevel:
    "查询级证据（sellersprite:* 主体，如 SellerSprite 商品市场 / 关键词挖掘）当前不进入 ResearchInputBundle；"
    + "只能在来源层查看，不能当作商品级研究输入。",
  productLevel:
    "商品级附件（商品详情 / 父子变体 / 评论 VOC / 反查 ASIN / 历史趋势导出）按既有边界进入研究输入；"
    + "是否已被某份研报实际消费需在研究侧另行核对，本面板不声明「已消费」。",
} as const;

export type BatchCaptureRunStatus =
  | "WAITING" | "RUNNING" | "PARTIAL" | "HUMAN_REQUIRED" | "COMPLETED" | "PAUSED" | "FAILED" | "CANCELLED";

export type BatchCaptureCellView = {
  asin: string; module: string; status: string; attempts: number;
  evidenceId: string | null; lastErrorCode: string | null;
  sourceVerified: boolean; fieldComplete: boolean; researchConsumable: boolean;
};

export type BatchCaptureModuleOutcomeView = {
  module: string; handling: string; dataQuality: string; completed: boolean;
  itemsTotal: number; itemsTerminal: number; itemsSucceeded: number; itemsPartial: number;
  itemsHuman: number; itemsFailed: number; itemsSkipped: number; itemsPending: number;
  validEvidenceCount: number; itemsFieldComplete: number; itemsSourceLimited: number;
  itemsResearchConsumable: number; message: string | null; errorCode: string | null;
};

export type BatchCaptureRunView = {
  runId: string; batchId: string; runGeneration: number; version: number;
  status: BatchCaptureRunStatus; allowedModules: string[];
  /** 本次运行的用户授权商品数量上限（服务端权威）。 */
  authorizedItemLimit?: number;
  maxItemsPerAdvance: number; maxDriveSlices: number; retryAuthorized: boolean;
  navigationBudget?: { limit: number; used: number; reserved: number; updatedAt: string };
  leaseOwner: string | null; leaseExpiresAt: string | null;
  cells: BatchCaptureCellView[]; moduleOutcomes: BatchCaptureModuleOutcomeView[];
  /** 查询级类目结果，与商品 × 模块单元分开显示。 */
  productMarketQueries?: BatchCaptureProductMarketQueryUnit[];
  /** seedKeyword 查询级结果；无明确来源关系时不会关联到 ASIN。 */
  keywordMiningQueries?: BatchCaptureKeywordMiningQueryUnit[];
  progress: {
    itemsInBatch: number; uniqueItemsVisited: number; detailSucceededItems: number;
    pendingCells: number; terminalCells: number; totalCells: number;
    validEvidenceCells: number; fieldCompleteCells: number; partialCells: number;
    humanCells: number; failedCells: number; sourceLimitedCells: number;
    researchConsumableCells: number;
  };
  advances: number; driveSlices: number;
  lastErrorCode: string | null; lastMessage: string | null;
  createdAt: string; updatedAt: string; startedAt: string | null; finishedAt: string | null;
  supersededRunId: string | null;
  pauseRequestedAt?: string | null;
  pauseAcknowledgedAt?: string | null;
  cancelRequestedAt?: string | null;
  stopAcknowledgedAt?: string | null;
  executionEpoch?: number;
  acknowledgedEpoch?: number;
  lastLeaseOwner?: string | null;
  stopConfirmedBy?: "executor" | "operator" | "control" | null;
  stopRecoveryReason?: string | null;
};

export type BatchCaptureRunTone = "emerald" | "blue" | "amber" | "rose" | "slate";

export type BatchCaptureModuleRow = {
  module: string; label: string;
  wiring: BatchCaptureModuleWiring; wiringLabel: string;
  /** 该模块本轮是否真的被自动执行器执行过。未接线/未执行一律 false。 */
  executed: boolean;
  /** 数据质量（服务端语义原样透出，不在本层改写）。 */
  handlingLabel: string;
  dataQualityLabel: string;
  dataQualityTone: BatchCaptureRunTone;
  completed: boolean;
  itemsTotal: number; itemsSucceeded: number; itemsPartial: number; itemsHuman: number;
  itemsFailed: number; itemsSkipped: number; itemsPending: number;
  validEvidenceCount: number; itemsFieldComplete: number; itemsSourceLimited: number;
  itemsResearchConsumable: number;
  /**
   * 字段完整度的真实分母：排除「复用既有证据、本轮未重新采集」的单元。
   * 复用单元既不能被算成字段缺失，也不能被算成字段完整（那是没重新校验过的）。
   */
  fieldCompleteEligible: number;
  message: string | null; errorCode: string | null;
};

/** 分层进度：每个百分比都带明确标签，禁止用单一 100% 暗示「数据采齐」。 */
export type BatchCaptureProgressView = {
  itemsInBatch: number;
  /** ① 商品已访问：任一自动模块到达终态的商品数。 */
  uniqueItemsVisited: number;
  uniqueItemsPercent: number;
  /** ② 深度处理完成：三个自动模块**全部**到达终态的商品数。 */
  deepProcessedItems: number;
  deepProcessedPercent: number;
  /** ③ 自动模块执行进度（单元级）。 */
  autoCellsTerminal: number;
  autoCellsTotal: number;
  autoExecutionPercent: number;
  /** ④ 全部单元（含未接线模块占位）。 */
  totalCells: number; terminalCells: number; pendingCells: number;
  /** ⑤ 有效证据覆盖 = 有效证据单元 / 全部单元（**含复用**的 skipped_existing 证据）。 */
  validEvidenceCells: number;
  evidenceCoveragePercent: number;
  /**
   * ⑥ 字段完整度：分母只取「本代次新采集」单元（succeeded / partial，不含搜索阶段与复用单元）。
   *
   * 为什么必须分开：复用既有证据（skipped_existing）没有重新采集，也没有重新判字段完整性，
   * 把它算成「字段不完整」会让一个已经采完的批次显示成 1/117；把它算成「字段完整」又是虚报。
   * 正确做法是把它排除在分母之外，并在标签里写明「本代次新采集」。
   */
  capturedCells: number;
  capturedFieldCompleteCells: number;
  fieldCompleteCells: number;
  fieldCompletenessPercent: number;
  /** 本代次复用既有有效证据的单元数（未重复采集）。 */
  reusedEvidenceCells: number;
  researchConsumableCells: number;
  partialCells: number; humanCells: number; failedCells: number; sourceLimitedCells: number;
  /** ⑦ 八模块总体覆盖。 */
  completedModules: number; totalModules: number;
  /** 共享导航预算（搜索阶段与所有自动模块共同遵守）。 */
  navigation: { limit: number; used: number; reserved: number; remaining: number; usedPercent: number; label: string };
  labels: {
    uniqueItems: string; deepProcessed: string; autoExecution: string;
    evidenceCoverage: string; fieldCompleteness: string; moduleCoverage: string; navigation: string;
  };
};

/** 状态与持久化单元的一致性检查：不一致必须**报告**，不能用警告掩盖。 */
export type BatchCaptureStatusConsistency = {
  consistent: boolean;
  issues: string[];
};

export type BatchCaptureResearchEligibility = {
  /** 证据具备消费候选资格（BatchCaptureRun 可判定）。 */
  evidenceCandidacy: { satisfied: boolean; consumableCells: number; consumableModules: string[]; reason: string };
  /** 市场研究样本门槛（服务端权威 validProductSet；与商品深研不是同一门禁）。 */
  marketSampleGate: { known: boolean; satisfied: boolean | null; current: number | null; required: number; reason: string };
  /** 商品深研就绪（服务端权威 usageStatus）。 */
  deepResearchReadiness: { known: boolean; readyItems: number | null; totalItems: number | null; reason: string };
  /** ResearchReport 是否已实际消费：BatchCaptureRun 不跟踪，必须显式声明未验证。 */
  researchReportConsumption: { tracked: false; reason: string };
};

export type BatchCaptureRunPresentation = {
  hasRun: boolean;
  runId: string | null; runGeneration: number | null;
  status: BatchCaptureRunStatus | null;
  statusLabel: string; tone: BatchCaptureRunTone; statusExplanation: string;
  /** 完成类状态下的补充说明：未接线模块导致的「八模块未采齐」。 */
  completionHint: string | null;
  /**
   * 停止三事实（A 请求已接收 / B Worker 已停止 / C 租约已释放）。
   * pause 与 cancel 共用同一组事实；`none` 表示当前不处于暂停/中止流程。
   */
  pausePhase: "none" | "requested" | "waiting_timeout" | "acknowledged" | "human_required";
  pausePhaseLabel: string;
  pauseFacts: { requested: boolean; workerStopped: boolean; leaseReleased: boolean; cancelRequested: boolean };
  pauseHint: string | null;
  /**
   * 执行器状态（P0 安全事实）：
   * - `none` 还没有执行器；
   * - `running` 存在有效租约；
   * - `stopped_confirmed` 执行代次已获得可信退出确认（executor 或 operator）；
   * - `unknown_needs_confirmation` 存在未确认退出的执行代次，且租约已过期 ——
   *   超时**不是**停止证明，此时不允许启动冲突的新执行，需要人工核对后确认。
   */
  executorState: "none" | "running" | "stopped_confirmed" | "unknown_needs_confirmation";
  executorStateLabel: string;
  executorStateHint: string | null;
  /** 人工确认恢复所需的精确身份；仅在 `unknown_needs_confirmation` 时给出。 */
  recoveryTarget: { runId: string; runGeneration: number; executionEpoch: number } | null;
  /** 已确认退出的最高执行代次与当前执行代次，供事实核对展示。 */
  executionEpoch: number;
  acknowledgedEpoch: number;
  stopConfirmedBy: "executor" | "operator" | "control" | null;
  stopRecoveryReason: string | null;
  progress: BatchCaptureProgressView;
  moduleMatrix: BatchCaptureModuleRow[];
  productMarketQueries: BatchCaptureProductMarketQueryUnit[];
  keywordMiningQueries: BatchCaptureKeywordMiningQueryUnit[];
  current: { asin: string; module: string; moduleLabel: string; derivedFromCheckpoint: true } | null;
  lastRunAt: string | null; lastMessage: string | null;
  lastErrorCode: string | null; lastErrorReason: string | null;
  /** 搜索样本是否已取得证据（≠ 商品深度采集完成）。 */
  searchSampleComplete: boolean;
  /** 商品深度采集是否完成（三个自动模块全部处理结束且有有效证据）。 */
  detailCaptureComplete: boolean;
  statusConsistency: BatchCaptureStatusConsistency;
  researchEligibility: BatchCaptureResearchEligibility;
  gaps: string[];
  /** 五类缺口的结构化分类（与 `gaps` 同源；面板按类型展示并给出恢复条件）。 */
  gapTriage: BatchCaptureGap[];
  /** 证据去向：查询级不进入 ResearchInputBundle；商品级按既有边界进入研究输入。 */
  evidenceDestination: typeof BATCH_CAPTURE_EVIDENCE_DESTINATION;
  actions: {
    canDrive: boolean; canPause: boolean; canResume: boolean; canCancel: boolean; canRetry: boolean;
    /** 是否还有未达重试上限的失败单元（按钮可用性的真实依据）。 */
    hasRetryableFailures: boolean;
    /** 失败单元已全部达到自动重试上限：不得再显示重试，也不得无限重试。 */
    retryExhaustedFailures: boolean;
    disabledReason: string | null;
  };
  legacyJobNotice: string | null;
};

export type BatchCaptureLegacyJobView = { status: string; total: number; processed: number } | null;
/** 父组件从服务端批次投影透传的市场研究样本门槛。 */
export type BatchCaptureSampleGate = { sufficient: boolean; current: number; required: number } | null;
/** 父组件从服务端条目投影透传的商品深研就绪计数。 */
export type BatchCaptureDeepResearchItems = { ready: number; total: number } | null;

const STATUS_LABELS: Record<BatchCaptureRunStatus, string> = {
  WAITING: "等待启动", RUNNING: "采集中", PARTIAL: "部分完成", HUMAN_REQUIRED: "需要人工处理",
  COMPLETED: "已完成", PAUSED: "已暂停", FAILED: "失败", CANCELLED: "已中止",
};
/**
 * 运行控制状态 → 中文标签（与 BatchCaptureRunPanel 同源，供计划面板等处复用）。
 * 注意：这只是**控制状态**，不等于真实来源采集成功；
 * 「已取得证据 / 可进入研究」必须由单元回执与 Evidence 另行判定。
 */
export const BATCH_CAPTURE_RUN_STATUS_LABELS: Record<BatchCaptureRunStatus, string> = STATUS_LABELS;
const STATUS_TONES: Record<BatchCaptureRunStatus, BatchCaptureRunTone> = {
  WAITING: "slate", RUNNING: "blue", PARTIAL: "amber", HUMAN_REQUIRED: "amber",
  COMPLETED: "emerald", PAUSED: "amber", FAILED: "rose", CANCELLED: "slate",
};
const HANDLING_LABELS: Record<string, string> = {
  not_started: "未开始", in_progress: "进行中", done: "执行结束", human_required: "需人工",
};
/** 未接线（或仅有来源权限要求）的模块本轮未被自动执行器执行。 */
const NOT_EXECUTED_LABEL = "未执行";
const DATA_QUALITY_LABELS: Record<string, string> = {
  unknown: "结果未知", has_valid: "已取得有效证据", empty: "无有效字段",
  blocked: "受限（无有效证据）", source_limited: "尚未接入自动采集",
};
const DATA_QUALITY_TONES: Record<string, BatchCaptureRunTone> = {
  unknown: "slate", has_valid: "emerald", empty: "amber", blocked: "amber", source_limited: "amber",
};
const ERROR_REASON_LABELS: Record<string, string> = {
  HUMAN_ACTION_REQUIRED: "遇到登录或验证码门槛，已停止自动重试，需要人工处理。",
  SOURCE_INPUT_REQUIRED: "该模块尚未接入自动采集，需要合法来源输入或人工会话。",
  MODULE_NO_VALID_EVIDENCE: "全部商品已处理，但未取得有效证据字段。",
  ENRICH_EMPTY_RESULT: "本轮请求的商品没有返回可用结果，已记为可重试失败。",
  BATCH_CAPTURE_CAS_CONFLICT: "任务状态已被其他操作更新（暂停/中止/并发执行），本轮结果未写入。",
  BATCH_CAPTURE_JOB_BUSY: "已有执行器在推进该批次。",
  LOCAL_ENVIRONMENT_REQUIRED: "本地采集未启用，无法推进。",
  MODULE_EXECUTION_FAILED: "模块执行失败。",
};

const TERMINAL_CELL_STATUSES: ReadonlySet<string> = new Set([
  "succeeded", "partial", "blocked_human", "failed_permanent", "failed_retryable",
  "skipped_existing", "source_input_required", "not_applicable",
]);

function isTerminal(status: string): boolean { return TERMINAL_CELL_STATUSES.has(status); }
function pct(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}
function moduleLabel(module: string): string { return BATCH_CAPTURE_MODULE_LABELS[module] ?? module; }
function describeError(code: string | null | undefined): string | null {
  if (!code) return null;
  return ERROR_REASON_LABELS[code] ?? `最近阻塞代码：${code}`;
}
function outcomeFor(run: BatchCaptureRunView, module: string): BatchCaptureModuleOutcomeView | null {
  return run.moduleOutcomes.find((outcome) => outcome.module === module) ?? null;
}
export function autoModulesOf(run: BatchCaptureRunView): string[] {
  return run.allowedModules.filter((module) => BATCH_CAPTURE_AUTO_MODULES.includes(module));
}
/** 缺口分类：默认「尚未接入自动采集」，仅真实权限码才升级为「来源权限受限」。 */
export function wiringFor(module: string, errorCode?: string | null): BatchCaptureModuleWiring {
  if (module === "amazon_search_market") return "search_phase";
  if (BATCH_CAPTURE_AUTO_MODULES.includes(module)) return "auto_wired";
  if (errorCode && SOURCE_PERMISSION_ERROR_CODES.has(errorCode)) return "source_permission";
  return "not_wired";
}

function emptyRow(module: string): BatchCaptureModuleRow {
  return {
    module, label: moduleLabel(module),
    wiring: wiringFor(module), wiringLabel: WIRING_LABELS[wiringFor(module)],
    executed: false, handlingLabel: NOT_EXECUTED_LABEL, dataQualityLabel: "结果未知", dataQualityTone: "slate", completed: false,
    itemsTotal: 0, itemsSucceeded: 0, itemsPartial: 0, itemsHuman: 0, itemsFailed: 0,
    itemsSkipped: 0, itemsPending: 0, validEvidenceCount: 0, itemsFieldComplete: 0,
    itemsSourceLimited: 0, itemsResearchConsumable: 0, fieldCompleteEligible: 0,
    message: null, errorCode: null,
  };
}

/** 恒含八行的模块矩阵；缺失模块以「未开始」占位，不从矩阵消失。 */
export function buildBatchCaptureModuleMatrix(run: BatchCaptureRunView | null): BatchCaptureModuleRow[] {
  // 不按 allowedModules 过滤：allowedModules 是 advance 白名单（不含搜索阶段模块），
  // 若用它裁剪行数，UI 会只剩 7 行，与八模块定义/统计口径不一致。
  return MODULE_ORDER.map((module) => {
    const outcome = run ? outcomeFor(run, module) : null;
    if (!outcome) return emptyRow(module);
    const wiring = wiringFor(module, outcome.errorCode);
    // 只有「已接自动」与「搜索阶段」模块本轮真的被自动执行器执行过；
    // 未接线 / 仅在来源权限要求下的模块，执行列一律显示「未执行」，绝不显示「执行结束」。
    const executed = wiring === "auto_wired" || wiring === "search_phase";
    return {
      module, label: moduleLabel(module), wiring, wiringLabel: WIRING_LABELS[wiring], executed,
      handlingLabel: executed ? (HANDLING_LABELS[outcome.handling] ?? outcome.handling) : NOT_EXECUTED_LABEL,
      dataQualityLabel: DATA_QUALITY_LABELS[outcome.dataQuality] ?? outcome.dataQuality,
      dataQualityTone: DATA_QUALITY_TONES[outcome.dataQuality] ?? "slate",
      completed: outcome.completed,
      itemsTotal: outcome.itemsTotal, itemsSucceeded: outcome.itemsSucceeded,
      itemsPartial: outcome.itemsPartial, itemsHuman: outcome.itemsHuman,
      itemsFailed: outcome.itemsFailed, itemsSkipped: outcome.itemsSkipped,
      itemsPending: outcome.itemsPending, validEvidenceCount: outcome.validEvidenceCount,
      itemsFieldComplete: outcome.itemsFieldComplete, itemsSourceLimited: outcome.itemsSourceLimited,
      itemsResearchConsumable: outcome.itemsResearchConsumable,
      // 复用单元的字段完整性没有被本轮重新校验 → 从分母排除，避免把「复用」显示成「字段不完整」
      fieldCompleteEligible: Math.max(0, outcome.itemsTotal - outcome.itemsSkipped),
      message: outcome.message, errorCode: outcome.errorCode,
    };
  });
}

function buildProgress(run: BatchCaptureRunView, matrix: BatchCaptureModuleRow[]): BatchCaptureProgressView {
  const auto = autoModulesOf(run);
  const byAsin = new Map<string, BatchCaptureCellView[]>();
  for (const cell of run.cells) byAsin.set(cell.asin, [...(byAsin.get(cell.asin) ?? []), cell]);
  let uniqueItemsVisited = 0;
  let deepProcessedItems = 0;
  for (const list of byAsin.values()) {
    if (list.some((c) => auto.includes(c.module) && isTerminal(c.status))) uniqueItemsVisited += 1;
    if (auto.length > 0 && auto.every((module) =>
      list.some((c) => c.module === module && isTerminal(c.status)))) deepProcessedItems += 1;
  }
  const autoCells = run.cells.filter((c) => auto.includes(c.module));
  const autoCellsTerminal = autoCells.filter((c) => isTerminal(c.status)).length;
  const validEvidenceCells = run.progress.validEvidenceCells;
  /**
   * 「本代次新采集」= 非搜索阶段、且本轮真正采集到证据的单元（succeeded / partial）。
   * 复用证据（skipped_existing）不在其中：它们没有重新采集，不能用来算字段完整度。
   */
  const capturedCells = run.cells.filter((c) => c.module !== "amazon_search_market"
    && (c.status === "succeeded" || c.status === "partial"));
  const capturedFieldCompleteCells = capturedCells.filter((c) => c.fieldComplete).length;
  const reusedEvidenceCells = run.cells.filter((c) => c.status === "skipped_existing").length;
  const completedModules = matrix.filter((row) => row.completed).length;
  const items = run.progress.itemsInBatch;
  return {
    itemsInBatch: items,
    uniqueItemsVisited, uniqueItemsPercent: pct(uniqueItemsVisited, items),
    deepProcessedItems, deepProcessedPercent: pct(deepProcessedItems, items),
    autoCellsTerminal, autoCellsTotal: autoCells.length, autoExecutionPercent: pct(autoCellsTerminal, autoCells.length),
    totalCells: run.progress.totalCells, terminalCells: run.progress.terminalCells, pendingCells: run.progress.pendingCells,
    validEvidenceCells, evidenceCoveragePercent: pct(validEvidenceCells, run.progress.totalCells),
    capturedCells: capturedCells.length,
    capturedFieldCompleteCells,
    // 兼容字段：与「本代次新采集字段完整」同值，分母由调用方用 capturedCells。
    fieldCompleteCells: capturedFieldCompleteCells,
    fieldCompletenessPercent: pct(capturedFieldCompleteCells, capturedCells.length),
    reusedEvidenceCells,
    researchConsumableCells: run.progress.researchConsumableCells,
    partialCells: run.progress.partialCells, humanCells: run.progress.humanCells,
    failedCells: run.progress.failedCells, sourceLimitedCells: run.progress.sourceLimitedCells,
    completedModules, totalModules: matrix.length,
    navigation: (() => {
      const budget = run.navigationBudget ?? { limit: 0, used: 0, reserved: 0, updatedAt: new Date(0).toISOString() };
      const remaining = Math.max(0, budget.limit - budget.used - budget.reserved);
      return {
        limit: budget.limit, used: budget.used, reserved: budget.reserved, remaining,
        usedPercent: budget.limit > 0 ? Math.round((budget.used / budget.limit) * 100) : 0,
        label: "页面导航预算（已用 / 上限，含搜索阶段）",
      };
    })(),
    labels: {
      uniqueItems: "商品已访问（任一自动模块已处理）",
      deepProcessed: "深度处理完成（三个自动模块全部处理完）",
      autoExecution: "自动模块处理进度（单元级）",
      evidenceCoverage: "有效证据覆盖（含复用证据单元 / 全部单元）",
      fieldCompleteness: "字段完整度（本代次新采集单元 / 本代次新采集）",
      moduleCoverage: "八模块总体覆盖（已完成模块 / 全部模块）",
      navigation: "页面导航预算（已用 / 上限，含搜索阶段）",
    },
  };
}

/** 状态与单元矩阵一致性：不一致必须显式报告。 */
export function checkStatusConsistency(run: BatchCaptureRunView): BatchCaptureStatusConsistency {
  const issues: string[] = [];
  const active = run.status === "RUNNING" || run.status === "WAITING";
  if (active && run.progress.pendingCells === 0) {
    issues.push(`状态为「${STATUS_LABELS[run.status]}」但没有任何待处理单元：持久化状态与单元矩阵不一致，进度百分比不可信。`);
  }
  if (run.status === "WAITING" && run.progress.uniqueItemsVisited > 0) {
    issues.push("状态为「等待启动」但已有处理记录：状态可能滞后。");
  }
  if (run.status === "COMPLETED" && run.progress.validEvidenceCells === 0) {
    issues.push("状态为「已完成」但没有任何有效证据单元。");
  }
  if (run.status === "RUNNING" && run.progress.humanCells > 0) {
    issues.push("状态为「采集中」但已存在需要人工处理的单元：应转入暂停/需人工。");
  }
  if (run.leaseOwner && ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(run.status)) {
    issues.push("运行已到终态但仍持有运行租约。");
  }
  return { consistent: issues.length === 0, issues };
}

function buildResearchEligibility(input: {
  run: BatchCaptureRunView;
  matrix: BatchCaptureModuleRow[];
  sampleGate: BatchCaptureSampleGate;
  deepResearchItems: BatchCaptureDeepResearchItems;
  detailCaptureComplete: boolean;
}): BatchCaptureResearchEligibility {
  const { run, sampleGate, deepResearchItems } = input;
  const consumableModules = input.matrix.filter((row) => row.itemsResearchConsumable > 0).map((row) => row.module);
  const consumableCells = run.progress.researchConsumableCells;
  const evidenceSatisfied = consumableCells > 0;
  const evidenceReason = evidenceSatisfied
    ? `已有 ${consumableCells} 个单元通过来源校验且字段完整，具备被研究消费的候选资格（覆盖模块：${consumableModules.map(moduleLabel).join("、")}）。`
    : "没有任何单元同时满足「来源校验通过 + 字段完整」，不具备研究消费候选资格。";

  const required = sampleGate?.required ?? MIN_VALID_SAMPLE_COUNT;
  const marketSampleGate: BatchCaptureResearchEligibility["marketSampleGate"] = sampleGate
    ? {
        known: true, satisfied: sampleGate.sufficient, current: sampleGate.current, required,
        reason: sampleGate.sufficient
          ? `市场研究样本门槛已满足（有效商品 ${sampleGate.current} / ${required}）。`
          : `市场研究样本门槛未满足：当前有效商品 ${sampleGate.current}，至少需要 ${required}。`,
      }
    : {
        known: false, satisfied: null, current: null, required,
        reason: "尚未取得服务端权威样本门槛判定（validProductSet），无法判断市场研究资格。",
      };

  const deepResearchReadiness: BatchCaptureResearchEligibility["deepResearchReadiness"] = deepResearchItems
    ? {
        known: true, readyItems: deepResearchItems.ready, totalItems: deepResearchItems.total,
        reason: deepResearchItems.total > 0
          ? `已加载 ${deepResearchItems.total} 件商品；其中商品深研就绪（服务端 usageStatus=research_ready）${deepResearchItems.ready} 件。`
          : "商品条目已加载，但该批次当前没有商品条目。",
      }
    : {
        known: false, readyItems: null, totalItems: null,
        reason: "商品条目尚未加载（或加载失败），无法判断商品深研就绪数量。",
      };

  return {
    evidenceCandidacy: { satisfied: evidenceSatisfied, consumableCells, consumableModules, reason: evidenceReason },
    marketSampleGate,
    deepResearchReadiness,
    researchReportConsumption: {
      tracked: false,
      reason: "BatchCaptureRun 不跟踪研报消费；是否存在已实际消费这些证据的 ResearchReport，需要在研究侧另行核对。",
    },
  };
}

function sumCounts(counts: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const value of counts.values()) total += value;
  return total;
}

function gapItem(input: Omit<BatchCaptureGap, "categoryLabel" | "text">): BatchCaptureGap {
  return {
    ...input,
    categoryLabel: BATCH_CAPTURE_GAP_CATEGORY_LABELS[input.category],
    text: `${input.detail} 恢复条件：${input.recovery}`,
  };
}

function switchRecovery(code: string | null): string {
  const label = code ? SELLERSPRITE_SWITCH_LABELS[code] : null;
  return `${label ? `在采集环境开启${label}` : "在采集环境开启对应的 SellerSprite BCR 真实来源执行开关"}`
    + "，并保持本地采集开启后，在采集计划重新确认并重跑；已保存的证据不会被删除。";
}

/** 批次级查询缺口：1 个查询就是一个批次级任务，不按 ASIN 数重复计数。 */
function batchQueryGap(
  row: BatchCaptureModuleRow,
  query: BatchCaptureProductMarketQueryUnit | BatchCaptureKeywordMiningQueryUnit,
): BatchCaptureGap {
  const subject = "seedKeyword" in query ? `seedKeyword ${query.seedKeyword}` : `类目 ${query.category}`;
  const errorCode = query.errorCode;
  const switchOff = errorCode !== null && SELLERSPRITE_SWITCH_DISABLED_CODES.has(errorCode);
  const statusLabel = QUERY_STATUS_LABELS[query.status] ?? query.status;
  return gapItem({
    category: switchOff ? "source_switch_disabled" : "batch_query_not_executed",
    scope: "batch_query",
    module: row.module,
    label: row.label,
    affectedCount: 1,
    detail: `1 个批次级查询：${subject} · 状态 ${statusLabel} · 原因（${errorCode ?? "未返回错误码"}）。`
      + (switchOff ? "该查询属于批次级，不会按 ASIN 逐个补齐。" : ""),
    recovery: switchOff
      ? switchRecovery(errorCode)
      : "在采集计划中重新确认该批次级查询后重跑，或按错误码修正前置条件；查询级结果不会按 ASIN 逐个补齐。",
    reasonCode: errorCode,
  });
}

/**
 * 把模块矩阵 + 真实单元/查询回执整理为五类缺口（+ 商品级未采集回退类）。
 * 只读展示层：不读写 run、不改变任何计数。
 */
export function buildGapTriage(run: BatchCaptureRunView, moduleMatrix: BatchCaptureModuleRow[]): BatchCaptureGap[] {
  const items: BatchCaptureGap[] = [];
  for (const row of moduleMatrix) {
    const cells = run.cells.filter((cell) => cell.module === row.module);
    const failureCounts = new Map<string, number>();
    const switchCellCounts = new Map<string, number>();
    const switchFailedCounts = new Map<string, number>();
    let switchLimitedCells = 0;
    for (const cell of cells) {
      const failed = cell.status === "failed_retryable" || cell.status === "failed_permanent";
      if (failed) {
        const code = cell.lastErrorCode ?? "UNKNOWN";
        failureCounts.set(code, (failureCounts.get(code) ?? 0) + 1);
      }
      if (cell.lastErrorCode && SELLERSPRITE_SWITCH_DISABLED_CODES.has(cell.lastErrorCode)
        && (failed || cell.status === "source_input_required")) {
        switchCellCounts.set(cell.lastErrorCode, (switchCellCounts.get(cell.lastErrorCode) ?? 0) + 1);
        if (failed) switchFailedCounts.set(cell.lastErrorCode, (switchFailedCounts.get(cell.lastErrorCode) ?? 0) + 1);
        if (cell.status === "source_input_required") switchLimitedCells += 1;
      }
    }

    // ① 批次级查询（product / keyword）：有查询单元时只按查询表述，绝不退回「N 个商品未接入」。
    let batchQueryHandled = false;
    if (row.module === "sellersprite_product_market" || row.module === "keyword_mining_trend") {
      const queries = row.module === "sellersprite_product_market"
        ? run.productMarketQueries ?? []
        : run.keywordMiningQueries ?? [];
      if (queries.length > 0) {
        batchQueryHandled = true;
        for (const query of queries) {
          if (query.status === "captured") continue;
          items.push(batchQueryGap(row, query));
        }
      } else {
        /**
         * 计划里这两个模块本来就是「1 个批次级查询」（items:0 / queries:1），
         * 本批次却一个查询单元都没创建。此时绝不能退化成「N 个商品未接入」——
         * 那会把「1 个查询没做」误报成「30 个商品没采」。按批次级查询如实说明。
         */
        batchQueryHandled = true;
        items.push(gapItem({
          category: "batch_query_not_executed",
          scope: "module",
          module: row.module,
          label: row.label,
          affectedCount: 1,
          detail: `${row.label}：本批次没有创建批次级查询（计划为 1 个${row.module === "sellersprite_product_market" ? "类目" : "种子关键词"}查询），因此 0/1 查询已执行；该模块按批次查询计数，不会按 ASIN 逐个补齐。`,
          recovery: `在采集计划中确认该批次级查询并重跑；真实来源执行还需打开对应 SellerSprite BCR 开关（${row.module === "sellersprite_product_market" ? "SELLERSPRITE_PRODUCT_MARKET_BCR_ENABLED" : "SELLERSPRITE_KEYWORD_MINING_BCR_ENABLED"}）并保持专用浏览器会话可用。`,
          reasonCode: "BATCH_QUERY_NOT_CREATED",
        }));
      }
    }

    // ② 来源开关关闭（reverse_asin 的真实错误码只在 cell 上；模块 errorCode 已被统一成 SOURCE_INPUT_REQUIRED）。
    if (row.module === "reverse_asin" && switchCellCounts.size > 0) {
      const codes = [...switchCellCounts.keys()];
      items.push(gapItem({
        category: "source_switch_disabled",
        scope: "module",
        module: row.module,
        label: row.label,
        affectedCount: sumCounts(switchCellCounts),
        detail: `反查 ASIN：真实来源执行开关关闭（${codes.join("、")}），${sumCounts(switchCellCounts)} 个商品单元未采集——本轮没有打开浏览器。`,
        recovery: switchRecovery(codes[0] ?? null),
        reasonCode: codes[0] ?? null,
      }));
    }

    // ③ 需要人工输入：历史趋势当前唯一合法来源是用户自带导出文件。
    const humanInputModule = row.module === "historical_trend" && row.itemsSourceLimited > 0;
    if (humanInputModule) {
      items.push(gapItem({
        category: "human_input_required",
        scope: "module",
        module: row.module,
        label: row.label,
        affectedCount: row.itemsSourceLimited,
        detail: `历史趋势：${row.itemsSourceLimited} 个商品需要用户提供导出文件（SellerSprite 历史导出或 Keepa CSV/XLSX）；当前没有可验证的导入文件。`,
        recovery: "由用户导入合法导出文件后重新检查；系统不会自动打开外部页面，也不会用 AI 推断补历史数据。",
        reasonCode: "USER_EXPORT_REQUIRED",
      }));
    }

    // 商品级未采集（回退类）：只在没有批次级查询可代表该模块时才成立。
    const remainingLimited = Math.max(0, row.itemsSourceLimited
      - (row.module === "reverse_asin" ? switchLimitedCells : 0));
    if (!batchQueryHandled && !humanInputModule && row.wiring !== "source_permission" && remainingLimited > 0) {
      items.push(gapItem({
        category: "product_not_captured",
        scope: "module",
        module: row.module,
        label: row.label,
        affectedCount: remainingLimited,
        detail: `${row.label}：${remainingLimited} 个商品尚未接入自动采集（当前执行器只覆盖 Amazon 详情/变体/评论三个模块）。`,
        recovery: "在采集计划中重新确认后重跑，或等待该模块接入自动采集器；这些商品单元不会因为其他模块成功而自动完成。",
        reasonCode: null,
      }));
    }

    // ④ 商品级采集失败：开关关闭类已归入「来源开关关闭」，不重复计数。
    if (row.itemsFailed > 0) {
      const switchFailed = sumCounts(switchFailedCounts);
      const remainingFailed = Math.max(0, row.itemsFailed - switchFailed);
      const extractionEmpty = Math.min(
        remainingFailed,
        (failureCounts.get("REVIEW_EXTRACTION_EMPTY") ?? 0) + (failureCounts.get("REVIEW_SOURCE_UNAVAILABLE") ?? 0),
      );
      if (extractionEmpty > 0) {
        items.push(gapItem({
          category: "product_capture_failed",
          scope: "item",
          module: row.module,
          label: row.label,
          affectedCount: extractionEmpty,
          detail: `${row.label}：${extractionEmpty} 个商品评论抽取为空（页面可访问、已重试到上限）。`,
          recovery: "证据只能证明「本轮未提取到评论」，是否确实没有公开评论仍待核实——不是采集成功，也不是已确认的空数据；"
            + "如需重新尝试，请在采集计划中重新确认新的运行代次。",
          reasonCode: "REVIEW_EXTRACTION_EMPTY",
        }));
      }
      const variationEmpty = Math.min(
        Math.max(0, remainingFailed - extractionEmpty),
        failureCounts.get("VARIATION_EXTRACTION_EMPTY") ?? 0,
      );
      if (variationEmpty > 0) {
        /**
         * 变体抽取为空**不得**写成「该商品没有变体」。
         *
         * 真实证据形态（批次 1607279a 的 10 个单元）：页面已绑定（urlAsin=pageAsin、
         * productContainerFound=true），但 `variationRootFound=false`、`jsonStateFound=false`、
         * `mappedVariantCount=0`，且 `explicitNoVariation=false` ——
         * 既没有变体数据，也没有页面显式声明「无变体」，属于**无法判定**，不是已确认的空数据。
         * 只有 `NO_VARIATION_WITH_EVIDENCE`（有显式无变体证据）才是真正的空数据，那类单元不会计入 failed。
         */
        items.push(gapItem({
          category: "product_capture_failed",
          scope: "item",
          module: row.module,
          label: row.label,
          affectedCount: variationEmpty,
          detail: `${row.label}：${variationEmpty} 个商品变体抽取为空（页面已绑定，但未发现变体根元素，也没有「无变体」标记）。`,
          recovery: "证据只能证明「本轮未提取到变体」；是否确实没有变体仍待人工核实——不是采集成功，也不是已确认的空数据。"
            + "如需重新尝试，请在采集计划中重新确认新的运行代次。",
          reasonCode: "VARIATION_EXTRACTION_EMPTY",
        }));
      }
      const otherFailures = Math.max(0, remainingFailed - extractionEmpty - variationEmpty);
      if (otherFailures > 0) {
        const firstCode = [...failureCounts.entries()]
          .find(([code]) => !SELLERSPRITE_SWITCH_DISABLED_CODES.has(code)
            && code !== "REVIEW_EXTRACTION_EMPTY" && code !== "REVIEW_SOURCE_UNAVAILABLE"
            && code !== "VARIATION_EXTRACTION_EMPTY")?.[0] ?? null;
        items.push(gapItem({
          category: "product_capture_failed",
          scope: "item",
          module: row.module,
          label: row.label,
          affectedCount: otherFailures,
          detail: `${row.label}：${otherFailures} 个商品采集失败（部分可重试）。`,
          recovery: "按模块矩阵中的最后错误码判断：达到自动重试上限（3 次）的失败不会无限重试；"
            + "如需重新尝试，请在采集计划中重新确认新的运行代次。",
          reasonCode: firstCode,
        }));
      }
    }

    // ⑤ 商品级字段不完整（partial）：已保存有效证据，缺失字段保持 null。
    if (row.itemsPartial > 0) {
      items.push(gapItem({
        category: "product_field_incomplete",
        scope: "item",
        module: row.module,
        label: row.label,
        affectedCount: row.itemsPartial,
        detail: `${row.label}：${row.itemsPartial} 个商品只取得部分数据（已保存有效证据，缺失字段保持 null）。`,
        recovery: "按具体字段核实是页面未提供还是解析口径待调整；不等同于采集失败，缺失值不猜测、不补造。",
        reasonCode: null,
      }));
    }
  }
  return items;
}

/** 把 BatchCaptureRun（+ 服务端批次/条目投影 + 旧 Job 只读摘要）投影为用户视图。 */
export function describeBatchCaptureRun(input: {
  run: BatchCaptureRunView | null;
  legacyJob?: BatchCaptureLegacyJobView;
  sampleGate?: BatchCaptureSampleGate;
  deepResearchItems?: BatchCaptureDeepResearchItems;
}): BatchCaptureRunPresentation {
  const { run, legacyJob = null, sampleGate = null, deepResearchItems = null } = input;
  const moduleMatrix = buildBatchCaptureModuleMatrix(run);

  if (!run) {
    const legacyNotice = legacyJob
      ? `该批次仍有历史「详情补齐任务」记录（${legacyJob.processed}/${legacyJob.total}），它只作为历史数据保留，不会被自动领取；当前批次没有自动采集执行器。`
      : null;
    return {
      hasRun: false, runId: null, runGeneration: null, status: null,
      statusLabel: "未启动自动采集", tone: "slate",
      statusExplanation: "该批次还没有自动采集执行器；可重新执行一次采集，或查看历史记录。",
      completionHint: null,
      pausePhase: "none", pausePhaseLabel: "", pauseFacts: { requested: false, workerStopped: false, leaseReleased: false, cancelRequested: false }, pauseHint: null,
      executorState: "none", executorStateLabel: "尚无执行器", executorStateHint: null,
      recoveryTarget: null, executionEpoch: 0, acknowledgedEpoch: 0, stopConfirmedBy: null, stopRecoveryReason: null,
      progress: buildProgress({ ...EMPTY_RUN, allowedModules: [], cells: [], moduleOutcomes: [] }, moduleMatrix),
      moduleMatrix, current: null, lastRunAt: null, lastMessage: null,
      productMarketQueries: [],
      keywordMiningQueries: [],
      lastErrorCode: null, lastErrorReason: null,
      searchSampleComplete: false, detailCaptureComplete: false,
      statusConsistency: { consistent: true, issues: [] },
      researchEligibility: {
        evidenceCandidacy: { satisfied: false, consumableCells: 0, consumableModules: [], reason: "尚未启动自动采集，没有可进入研究的候选证据。" },
        marketSampleGate: sampleGate
          ? { known: true, satisfied: sampleGate.sufficient, current: sampleGate.current, required: sampleGate.required, reason: sampleGate.sufficient ? "市场研究样本门槛已满足。" : `市场研究样本门槛未满足：当前 ${sampleGate.current} / ${sampleGate.required}。` }
          : { known: false, satisfied: null, current: null, required: MIN_VALID_SAMPLE_COUNT, reason: "尚未取得服务端权威样本门槛判定。" },
        deepResearchReadiness: deepResearchItems
          ? { known: true, readyItems: deepResearchItems.ready, totalItems: deepResearchItems.total, reason: `商品深研就绪：${deepResearchItems.ready} / ${deepResearchItems.total}。` }
          : { known: false, readyItems: null, totalItems: null, reason: "尚未读取商品条目状态。" },
        researchReportConsumption: { tracked: false, reason: "BatchCaptureRun 不跟踪研报消费。" },
      },
      gaps: ["自动采集执行器尚未启动。"],
      gapTriage: [],
      evidenceDestination: BATCH_CAPTURE_EVIDENCE_DESTINATION,
      actions: {
    canDrive: false, canPause: false, canResume: false, canCancel: false, canRetry: false,
    hasRetryableFailures: false, retryExhaustedFailures: false,
    disabledReason: "该批次没有自动采集执行器。",
  },
      legacyJobNotice: legacyNotice,
    };
  }

  const status = run.status;
  const autoOutcomes = run.moduleOutcomes.filter((outcome) => BATCH_CAPTURE_AUTO_MODULES.includes(outcome.module));
  const searchOutcome = outcomeFor(run, "amazon_search_market");
  const searchSampleComplete = Boolean(searchOutcome && searchOutcome.validEvidenceCount > 0);
  const detailCaptureComplete = autoOutcomes.length > 0
    && autoOutcomes.every((outcome) => outcome.handling === "done")
    && autoOutcomes.some((outcome) => outcome.dataQuality === "has_valid");

  const progress = buildProgress(run, moduleMatrix);
  const statusConsistency = checkStatusConsistency(run);
  const researchEligibility = buildResearchEligibility({ run, matrix: moduleMatrix, sampleGate, deepResearchItems, detailCaptureComplete });

  /**
   * 缺口分诊（五类 + 回退类）：
   * - 批次级查询未执行 vs 来源开关关闭：product/keyword 有查询单元时**只**按查询表述，
   *   不再把 1 个批次级查询说成 N 个商品未接入；没有查询单元时才退回商品级表述。
   * - reverse_asin 按 cell.lastErrorCode 的真码归到「来源开关关闭」或「商品级未采集」。
   * - historical_trend 归到「需要人工输入」（用户导出文件）。
   * - 商品级失败 / 字段不完整逐模块表述，仍保持「待核实/不猜测」语义。
   * 分类只影响文案与恢复指引，不改变 progress / moduleMatrix 的任何计数。
   */
  const gapTriage = buildGapTriage(run, moduleMatrix);
  const gaps: string[] = gapTriage.map((gap) => gap.text);
  const otherGaps: string[] = [];
  for (const row of moduleMatrix) {
    // 来源权限受限不属于五类采集缺口；沿用既有事实表述（仅真实权限码才会走到这里）。
    if (row.wiring === "source_permission" && row.itemsSourceLimited > 0) {
      otherGaps.push(`${row.label}：${row.itemsSourceLimited} 个商品受来源权限限制（有真实权限/权益证据）。`);
    }
    if (row.itemsHuman > 0) otherGaps.push(`${row.label}：${row.itemsHuman} 个商品需要人工处理（登录/验证码）。`);
    if (row.handlingLabel === "执行结束" && row.dataQualityLabel === "无有效字段") {
      otherGaps.push(`${row.label}：执行已结束但未取得有效字段。`);
    }
  }
  if (statusConsistency.issues.length > 0) otherGaps.push(...statusConsistency.issues.map((issue) => `状态一致性：${issue}`));
  gaps.push(...otherGaps);
  if (!gaps.length) gaps.push("当前没有受限、失败或需人工处理的记录。");

  // P0-2：底层状态机不变；仅当本轮自动模块执行结束、仍有未接线模块时，主状态文案改为
  // 「本轮自动采集已结束」，并显式提示八模块数据尚未采齐。
  const modulesNotWired = moduleMatrix.filter((row) => !row.executed && row.itemsSourceLimited > 0);
  let statusLabel = STATUS_LABELS[status];
  let completionHint: string | null = null;
  if (status === "COMPLETED" && modulesNotWired.length > 0) {
    statusLabel = "本轮自动采集已结束";
    completionHint = "八模块数据尚未采齐；当前未接线模块不属于本轮自动采集范围。";
  }

  const legacyJobNotice = legacyJob
    ? `本批次同时存在历史「详情补齐任务」记录（${legacyJob.processed}/${legacyJob.total}）。它以只读历史保留，不会被自动领取；上方进度是当前唯一权威。`
    : null;

  /**
   * 停止三事实：只有拿到「Worker 已停止」的确认，才显示真正的「已暂停 / 已中止」。
   * 仅凭 status=PAUSED/CANCELLED 不能宣称浏览器已经停止。
   * 中止请求与 Worker 实际退出分开记录：cancelRequestedAt ≠ stopAcknowledgedAt。
   *
   * 例外（D2-1E）：从未启动过执行的任务（executionEpoch=0 且无任何租约历史）
   * 不存在「在途 Worker」——暂停/中止当场生效，不得显示成
   * 「等待超时或需要检查」（那会让用户以为中止没有成功）。
   */
  const executionEpoch = run.executionEpoch ?? 0;
  const acknowledgedEpoch = run.acknowledgedEpoch ?? 0;
  const neverExecuted = executionEpoch === 0 && !run.lastLeaseOwner;
  const leaseActive = Boolean(run.leaseOwner && run.leaseExpiresAt && Date.parse(run.leaseExpiresAt) > Date.now());
  const unresolvedExecution = executionEpoch > acknowledgedEpoch;
  /**
   * 执行代次已由持久化写入关闭且无有效租约：可以确证「没有在途执行」。
   * 关闭代次的写入（releaseLease / 终态 slice / acknowledgeStop）都发生在所有 Worker 返回之后，
   * 因此即使 stopAcknowledgedAt 为空（停止请求到达时执行器早已退出），也不存在在途导航。
   */
  const epochClosedWithoutLease = executionEpoch > 0 && !unresolvedExecution && !leaseActive;
  const stopAcknowledged = Boolean(run.stopAcknowledgedAt ?? run.pauseAcknowledgedAt)
    || neverExecuted
    || epochClosedWithoutLease;
  const facts = {
    requested: Boolean(run.pauseRequestedAt),
    workerStopped: stopAcknowledged,
    leaseReleased: !run.leaseOwner,
    cancelRequested: Boolean(run.cancelRequestedAt),
  };
  let pausePhase: BatchCaptureRunPresentation["pausePhase"] = "none";
  let pausePhaseLabel = "";
  let pauseHint: string | null = null;
  if (status === "HUMAN_REQUIRED") {
    /**
     * D2-1H：需要人工处理是**独立的显式状态**，不与「采集中 / 已暂停」混写。
     * 人工单元（登录 / 验证码门槛）存在时执行器已退出；pending 单元保留，
     * 待人工条件恢复后由「继续」合法恢复（未恢复时继续会被服务端拒绝）。
     */
    pausePhase = "human_required";
    pausePhaseLabel = "需要人工处理";
    pauseHint = `存在 ${run.progress.humanCells} 个需要人工处理的单元（登录 / 验证码门槛）；`
      + "请在专用浏览器中完成登录或人工验证，然后点击「继续」恢复执行；"
      + "未处理前继续会被拒绝，执行器不会启动，已完成模块不会被重复采集。";
  } else if (status === "PAUSED") {
    if (facts.workerStopped) {
      pausePhase = "acknowledged";
      pausePhaseLabel = "已暂停";
    } else if (leaseActive) {
      pausePhase = "requested";
      pausePhaseLabel = "正在暂停";
      pauseHint = "暂停请求已收到；在途采集操作尚未退出，系统不会启动新的商品或模块。";
    } else {
      pausePhase = "waiting_timeout";
      pausePhaseLabel = "暂停等待超时或需要检查";
      pauseHint = "暂停请求已收到，但未收到执行器停止确认（可能进程异常退出）。租约到期不等于执行器已停止；恢复前请核对旧采集进程并人工确认。";
    }
  } else if (status === "CANCELLED") {
    if (facts.workerStopped) {
      pausePhase = "acknowledged";
      pausePhaseLabel = "已中止";
    } else if (leaseActive) {
      pausePhase = "requested";
      pausePhaseLabel = "正在中止";
      pauseHint = "中止请求已收到；在途采集操作尚未退出。在其获得可信退出确认前，不会启动新的运行代次。";
    } else {
      pausePhase = "waiting_timeout";
      pausePhaseLabel = "中止等待超时或需要检查";
      pauseHint = "中止请求已收到，但未收到执行器停止确认（可能进程异常退出）。租约到期不等于执行器已停止；新建运行前请核对旧采集进程并人工确认。";
    }
  }

  /**
   * 执行器状态：以「执行代次是否已关闭 **且** 是否仍有有效租约」为准。
   *
   * 根因修复：停止确认字段为空**本身不是**「执行器生死未知」的证据。
   * 只有「代次仍未关闭」或「租约仍有效」才说明执行器可能还在导航；
   * 代次已被持久化写入关闭且无租约时，停止请求只是「到达时执行器已退出」，
   * 必须显示为已确认退出，否则会与后端判定相反，把用户永久挡在
   * 「执行器状态未知 / 需要人工确认」的死锁里（正式批次 944e1e2c 的实际形态）。
   */
  const stopRequested = Boolean(run.pauseRequestedAt || run.cancelRequestedAt);
  const stopConfirmed = Boolean(run.stopAcknowledgedAt ?? run.pauseAcknowledgedAt)
    || neverExecuted
    || epochClosedWithoutLease;
  const unconfirmedStopRequest = executionEpoch > 0 && stopRequested && !stopConfirmed
    && (unresolvedExecution || leaseActive);
  let executorState: BatchCaptureRunPresentation["executorState"] = "none";
  let executorStateLabel = "尚无执行器";
  let executorStateHint: string | null = null;
  let recoveryTarget: BatchCaptureRunPresentation["recoveryTarget"] = null;
  if (run.leaseOwner && leaseActive) {
    executorState = "running";
    executorStateLabel = "执行中";
    executorStateHint = "存在有效的运行租约：当前有执行器在推进该批次。";
  } else if (unresolvedExecution || unconfirmedStopRequest) {
    executorState = "unknown_needs_confirmation";
    executorStateLabel = "执行器状态未知，需要确认";
    executorStateHint = unconfirmedStopRequest && !unresolvedExecution
      ? `已请求${run.cancelRequestedAt ? "中止" : "暂停"}，但运行租约仍有效（执行代次 ${executionEpoch} / 已确认 ${acknowledgedEpoch}）。`
        + "在途采集操作尚未退出——需要等待其退出或核对旧进程，不能视为已停止。"
        + "请先核对旧采集进程确实不再存活，再使用人工确认恢复。"
      : `执行代次 ${executionEpoch} 未获得退出确认（已确认 ${acknowledgedEpoch}），且运行租约已过期。`
        + "租约超时不能证明旧执行器已停止；在其获得可信退出确认前，不会启动冲突的新执行。"
        + "请先核对旧采集进程确实不再存活，再使用人工确认恢复。";
    recoveryTarget = { runId: run.runId, runGeneration: run.runGeneration, executionEpoch };
  } else if (executionEpoch > 0) {
    executorState = "stopped_confirmed";
    executorStateLabel = "执行器已确认退出";
    executorStateHint = run.stopConfirmedBy === "operator"
      ? `执行代次 ${executionEpoch} 由人工核对后确认退出${run.stopRecoveryReason ? `（原因：${run.stopRecoveryReason}）` : ""}。`
      : run.stopConfirmedBy === "control"
        ? `执行代次 ${executionEpoch} 已关闭；暂停/中止时没有在途采集操作，停止当场生效。`
        : stopRequested && !(run.stopAcknowledgedAt ?? run.pauseAcknowledgedAt)
          // 历史数据：停止请求到达时执行器已退出，未单独回执；代次已关闭 = 无在途执行。
          ? `执行代次 ${executionEpoch} 已关闭（停止请求到达时执行器已退出，未单独回执停止），不存在在途采集操作。`
          : `执行代次 ${executionEpoch} 由执行器自身确认退出。`;
  } else {
    executorState = "none";
    executorStateLabel = "尚无执行器";
    executorStateHint = null;
  }

  /**
   * D2-1H：「采集中」与「执行器已退出」并存时必须给出明确解释，
   * 不能让两个徽标互相矛盾而无说明。该组合意味着执行已异常停止
   * （进度已持久化），正确动作是点击「继续」重新发起有界驱动。
   */
  const executorExitedButRunning =
    status === "RUNNING"
    && !leaseActive
    && executorState === "stopped_confirmed"
    && executionEpoch > 0
    && acknowledgedEpoch >= executionEpoch;

  const executorUnknown = executorState === "unknown_needs_confirmation";
  /**
   * 按钮必须反映「点下去真的有事可做」：
   * - 失败单元达到自动重试硬上限（MAX_CELL_AUTO_ATTEMPTS = 3，与 server/batchCaptureRun 同值）后，
   *   重试不会重置任何单元、再次推进也没有可执行工作 → 不得再显示可用按钮（否则就是「点了没反应」）。
   * - PARTIAL 只有在仍有 pending 或未达上限的可重试单元时，才允许「开始自动采集」继续推进。
   */
  const retryableCells = run.cells.filter((cell) => cell.status === "failed_retryable" && cell.attempts < 3).length;
  const pendingCells = run.cells.filter((cell) => cell.status === "pending").length;
  const actions = {
    canDrive: status === "WAITING" || status === "RUNNING" || status === "PAUSED"
      || (status === "PARTIAL" && (pendingCells > 0 || retryableCells > 0)),
    canPause: status === "WAITING" || status === "RUNNING",
    // D2-1H：HUMAN_REQUIRED 也允许点击「继续」——服务端会重新检查人工单元，
    // 未处理时明确拒绝并说明原因；处理完成后同一按钮恢复合法执行。
    canResume: (status === "PAUSED" || status === "HUMAN_REQUIRED") && !executorUnknown,
    canCancel: status !== "COMPLETED" && status !== "CANCELLED",
    // 执行器状态未知时禁用普通重试，引导先核实旧进程 / 人工确认恢复；
    // 达到重试上限的失败也不显示重试（服务端不会重置，点了只会误导）。
    canRetry: retryableCells > 0
      && (status === "PARTIAL" || status === "PAUSED")
      && !executorUnknown,
    hasRetryableFailures: retryableCells > 0,
    retryExhaustedFailures: progress.failedCells > 0 && retryableCells === 0,
    disabledReason: status === "COMPLETED" ? "批次已完成，无需再推进。"
      : status === "CANCELLED" ? "批次已中止；如需继续请重新启动新的运行代次。"
      : executorUnknown
        ? "执行器停止状态未确认：请先核对旧采集进程是否已退出，并使用「人工确认恢复」后再重试。"
        : progress.failedCells > 0 && retryableCells === 0 && status !== "RUNNING"
          ? "失败单元已达到自动重试上限（3 次）；系统不会无限重试，请按最后错误原因判断是否重新确认计划。"
          : null,
  };

  return {
    hasRun: true, runId: run.runId, runGeneration: run.runGeneration, status,
    statusLabel: pausePhase === "requested"
      ? (status === "CANCELLED" ? "正在中止" : "正在暂停")
      : pausePhase === "waiting_timeout"
        ? (status === "CANCELLED" ? "中止等待超时" : "暂停等待超时")
        : statusLabel,
    tone: STATUS_TONES[status],
    statusExplanation: (run.lastMessage ?? "任务状态由持久化断点决定；刷新页面不会改变真实进度。")
      + (epochClosedWithoutLease && stopRequested && !(run.stopAcknowledgedAt ?? run.pauseAcknowledgedAt)
        // 历史回执是「正在等待在途采集退出」，但代次已关闭且无租约 → 必须当场解释，不让两句话互相矛盾。
        ? ` 该${run.cancelRequestedAt ? "中止" : "暂停"}请求未收到执行器单独回执；执行代次 ${executionEpoch} 已关闭且无有效租约，说明提出请求时已没有在途采集操作，此处按「已停止」呈现。`
        : "")
      + (executorExitedButRunning
        ? " 注意：执行器已确认退出，但任务仍显示「采集中」——这表示执行已停止（进度已持久化保存）；请点击「继续」重新发起执行，或刷新查看最新状态。"
        : "")
      + (completionHint ? ` ${completionHint}` : ""),
    completionHint,
    progress, moduleMatrix, current: deriveCurrent(run), lastRunAt: run.updatedAt ?? null,
    productMarketQueries: run.productMarketQueries ?? [],
    keywordMiningQueries: run.keywordMiningQueries ?? [],
    lastMessage: run.lastMessage, lastErrorCode: run.lastErrorCode, lastErrorReason: describeError(run.lastErrorCode),
    searchSampleComplete, detailCaptureComplete, statusConsistency, researchEligibility, gaps, gapTriage, actions, legacyJobNotice,
    evidenceDestination: BATCH_CAPTURE_EVIDENCE_DESTINATION,
    pausePhase, pausePhaseLabel, pauseFacts: facts, pauseHint,
    executorState, executorStateLabel, executorStateHint, recoveryTarget,
    executionEpoch, acknowledgedEpoch,
    stopConfirmedBy: run.stopConfirmedBy ?? null, stopRecoveryReason: run.stopRecoveryReason ?? null,
  };
}

function deriveCurrent(run: BatchCaptureRunView): BatchCaptureRunPresentation["current"] {
  if (run.status !== "RUNNING") return null;
  const auto = autoModulesOf(run);
  const pending = run.cells
    .filter((cell) => cell.status === "pending" && auto.includes(cell.module))
    .sort((a, b) => MODULE_ORDER.indexOf(a.module) - MODULE_ORDER.indexOf(b.module) || a.asin.localeCompare(b.asin));
  const next = pending[0];
  if (!next) return null;
  return { asin: next.asin, module: next.module, moduleLabel: moduleLabel(next.module), derivedFromCheckpoint: true };
}

const EMPTY_RUN: BatchCaptureRunView = {
  runId: "", batchId: "", runGeneration: 0, version: 0, status: "WAITING", allowedModules: [],
  maxItemsPerAdvance: 0, maxDriveSlices: 0, retryAuthorized: false, leaseOwner: null, leaseExpiresAt: null,
  cells: [], moduleOutcomes: [],
  productMarketQueries: [],
  keywordMiningQueries: [],
  progress: {
    itemsInBatch: 0, uniqueItemsVisited: 0, detailSucceededItems: 0, pendingCells: 0, terminalCells: 0,
    totalCells: 0, validEvidenceCells: 0, fieldCompleteCells: 0, partialCells: 0, humanCells: 0,
    failedCells: 0, sourceLimitedCells: 0, researchConsumableCells: 0,
  },
  navigationBudget: { limit: 0, used: 0, reserved: 0, updatedAt: new Date(0).toISOString() },
  advances: 0, driveSlices: 0, lastErrorCode: null, lastMessage: null,
  createdAt: "", updatedAt: "", startedAt: null, finishedAt: null, supersededRunId: null,
};
