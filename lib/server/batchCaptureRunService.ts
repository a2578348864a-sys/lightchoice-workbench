import { createHash, randomUUID } from "node:crypto";

import type { AccessContext } from "@/lib/server/accessPassword";
import { V5CoreError } from "@/lib/server/v5CoreCommon";
import { BATCH_CAPTURE_SCOPE_DISABLED_MESSAGE, isBatchCaptureScopeAllowed } from "@/lib/server/acquisitionScope";
import { getProductBatchStore } from "@/lib/server/productBatchStoreResolver";
import { resolveBatchSearchNavigationUsed } from "@/lib/server/batchCaptureSearchNavigation";
import { isMarketCaptureStrategyId } from "@/lib/sourceLayer/captureStrategy/marketCapturePlan";
import { enrichBatchWithAmazonDetail } from "@/lib/server/batchDetailEnrichmentService";
import { enrichBatchWithVariation } from "@/lib/server/batchVariationEnrichmentService";
import { enrichBatchWithReviewVoc } from "@/lib/server/batchReviewVocEnrichmentService";
import { checkAmazonSessionReadiness } from "@/lib/server/amazonSessionReadiness";
import {
  captureSellerSpriteProductMarketQueryForBatch,
  isSellerSpriteProductMarketBcrEnabled,
  preflightSellerSpriteProductMarketBaseEvidence,
  type ProductMarketQueryExecution,
} from "@/lib/server/sellerSpriteProductMarketBatch";
import {
  captureSellerSpriteReverseAsinBatch,
  isSellerSpriteReverseAsinBcrEnabled,
  type ReverseAsinVerifiedSourceRef,
} from "@/lib/server/sellerSpriteReverseAsinBatch";
import {
  captureSellerSpriteKeywordMiningQueryForBatch,
  isSellerSpriteKeywordMiningBcrEnabled,
  type KeywordMiningQueryExecution,
} from "@/lib/server/sellerSpriteKeywordMiningBatch";
import {
  sellerSpriteKeywordMiningQuerySubjectKey,
  sellerSpriteProductMarketQuerySubjectKey,
  sellerSpriteQueryFingerprint,
  validateSellerSpriteQueryInput,
} from "@/lib/server/sellerSpriteVisibleQuery";
import {
  ADVANCEABLE_MODULES,
  AUTO_BATCH_MODULES,
  HARD_MAX_AUTHORIZED_ITEMS,
  MIN_NAVIGATION_BUDGET,
  NAVIGATIONS_PER_ITEM_PER_MODULE,
  HARD_MAX_NAVIGATION_BUDGET,
  MAX_NAVIGATION_TOP_UP,
  MAX_NAVIGATION_TOP_UP_RATIO,
  deriveNavigationBudget,
  deriveSearchPages,
  BATCH_CAPTURE_RUN_SCHEMA_VERSION,
  DEFAULT_RUN_MODULES,
  MAX_CELL_AUTO_ATTEMPTS,
  countValidEvidence,
  createCell,
  deriveBatchCaptureRunStatus,
  deriveModuleOutcomes,
  deriveProgress,
  hasUnresolvedExecution,
  isActionableCell,
  isAutoBatchModule,
  isKnownModule,
  isManualInputModule,
  isRetryableCell,
  isSearchTimeModule,
  isTerminalCell,
  parseBatchCaptureRun,
  type BatchCaptureCell,
  type BatchCaptureCellStatus,
  type BatchCaptureAuthorizationSlice,
  type BatchCaptureProductMarketQueryUnit,
  type BatchCaptureKeywordMiningQueryUnit,
  type BatchCaptureRun,
} from "@/lib/server/batchCaptureRun";
import { BATCH_CAPTURE_RUN_STATUS_LABELS } from "@/lib/sourceLayer/batchCaptureRunPresentation";
import { HARD_MAX_SEARCH_PAGES } from "@/lib/sourceLayer/captureBudgetConstants";

/**
 * 运行范围门禁：只有显式声明 `V5_ACQUISITION_SCOPE=batch_and_single` 才允许批量采集。
 * 缺省为 `single_asin_only`，在租约获取、业务写入与 worker 启动之前拒绝。
 */
function assertBatchScopeAllowed(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): void {
  if (isBatchCaptureScopeAllowed(env)) return;
  throw new V5CoreError("BATCH_CAPTURE_SCOPE_DISABLED", BATCH_CAPTURE_SCOPE_DISABLED_MESSAGE, 403);
}

const OPERATION = "source-layer:batch-capture-run:v1";
const RESOURCE_SCOPE = "owner:v1";
const IDEMPOTENCY_KEY = "batch-capture-run.v1";
const ARCHIVE_KEY_PREFIX = `${IDEMPOTENCY_KEY}:run:`;

const DEFAULT_MAX_ITEMS_PER_ADVANCE = 5;
const HARD_MAX_ITEMS_PER_ADVANCE = 30;
const DEFAULT_MAX_DRIVE_SLICES = 240;
const LEASE_MS = 120_000;
const CAS_RETRIES = 8;

/**
 * 执行阻塞回执（noteExecutionBlocked）的权威默认文案。
 * 已知错误码给出「原因 + 下一步」；未知错误码只陈述事实，不猜测原因。
 */
const DEFAULT_BLOCKED_MESSAGES: Record<string, string> = {
  LOCAL_ENVIRONMENT_REQUIRED:
    "本地采集未启用：任务已创建，但执行器无法推进。任务与授权已保留；启用本地采集后可继续执行。",
  BATCH_CAPTURE_JOB_BUSY:
    "已有执行器在推进该批次；本轮启动请求未执行，进度以服务端持久化状态为准。",
};

type ReceiptRow = {
  id: string;
  actorScope: string;
  operation: string;
  resourceKey: string;
  idempotencyKey: string;
  requestHash: string;
  status: string;
  responseJson: string | null;
  expiresAt: Date | null;
  updatedAt: Date;
};

type RepositoryClient = {
  v5OperationReceipt: {
    findUnique: (args: unknown) => Promise<ReceiptRow | null>;
    findMany: (args: unknown) => Promise<ReceiptRow[]>;
    create: (args: unknown) => Promise<ReceiptRow>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
  };
};

export type EnrichItemLike = {
  asin?: string;
  status?: string;
  evidenceId?: string | null;
  errorCode?: string | null;
  retryable?: boolean;
  captured?: boolean;
  sourceEvidenceRef?: ReverseAsinVerifiedSourceRef;
};

export type BatchCaptureRunDeps = {
  enrichDetail?: typeof enrichBatchWithAmazonDetail;
  enrichVariation?: typeof enrichBatchWithVariation;
  enrichReview?: typeof enrichBatchWithReviewVoc;
  preflightProductMarket?: typeof preflightSellerSpriteProductMarketBaseEvidence;
  runProductMarketQuery?: typeof captureSellerSpriteProductMarketQueryForBatch;
  runReverseAsin?: typeof captureSellerSpriteReverseAsinBatch;
  runKeywordMiningQuery?: typeof captureSellerSpriteKeywordMiningQueryForBatch;
  /** D2-1H：「继续」前重新检查 Amazon 登录环境（readiness 级，含真实浏览器验证）。 */
  checkSessionReadiness?: typeof checkAmazonSessionReadiness;
  now?: () => Date;
  database: RepositoryClient;
  getProductBatchStore?: typeof getProductBatchStore;
  /** 有界驱动的单 slice 后钩子（测试可观测）。 */
  onSlice?: (run: BatchCaptureRun, sliceIndex: number) => void | Promise<void>;
  /** 测试可观测：外部 Worker 调用记录。 */
  onWorkerCall?: (module: string, targetAsins: string[]) => void;
};

function requireOwner(context: AccessContext): void {
  if (context.mode !== "owner") {
    throw new V5CoreError("FORBIDDEN", "当前主体不允许操作批次自动采集任务。", 403);
  }
}

function requireAcquisitionEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env.LOCAL_ACQUISITION_ENABLED !== "true") {
    throw new V5CoreError("LOCAL_ENVIRONMENT_REQUIRED", "本地采集未启用，无法推进批次自动采集。", 409);
  }
}

function normalizeBatchId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{10,64}$/u.test(value.trim())) {
    throw new V5CoreError("BATCH_ID_INVALID", "batchId 无效。", 400);
  }
  return value.trim();
}

function normalizeLimit(value: unknown, fallback: number): number {
  const limit = value === undefined || value === null ? fallback : value;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > HARD_MAX_ITEMS_PER_ADVANCE) {
    throw new V5CoreError("BATCH_CAPTURE_LIMIT_INVALID", `limit 必须是 1-${HARD_MAX_ITEMS_PER_ADVANCE} 的整数。`, 400);
  }
  return limit;
}

function normalizeModules(value: unknown): string[] {
  if (value === undefined || value === null) {
    // 默认矩阵覆盖全部可在推进阶段表示的模块；搜索阶段模块在 start 时单独补单元格。
    return DEFAULT_RUN_MODULES.filter((module) => !isSearchTimeModule(module));
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new V5CoreError("BATCH_CAPTURE_MODULES_INVALID", "allowedModules 必须是非空数组。", 400);
  }
  const modules: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new V5CoreError("BATCH_CAPTURE_MODULES_INVALID", "allowedModules 含非法模块。", 400);
    }
    const moduleId = entry.trim();
    if (!isKnownModule(moduleId)) {
      throw new V5CoreError("BATCH_CAPTURE_MODULES_INVALID", `未知模块 ${moduleId}。`, 400);
    }
    if (isSearchTimeModule(moduleId)) {
      // 搜索阶段模块在 start 时已终态；不允许作为 advance 目标（advance 会跳过）。
      continue;
    }
    if (!isAutoBatchModule(moduleId) && !isManualInputModule(moduleId)) {
      throw new V5CoreError("BATCH_CAPTURE_MODULES_INVALID", `模块 ${moduleId} 不能进入批次推进。`, 400);
    }
    if (!modules.includes(moduleId)) modules.push(moduleId);
  }
  return modules;
}

/** 授权商品上限：必须显式提供且合法，否则 fail-closed（绝不默认 60）。 */
function requireAuthorizedItemLimit(value: unknown): number {
  if (value === undefined || value === null) {
    throw new V5CoreError(
      "AUTHORIZED_ITEM_LIMIT_REQUIRED",
      "必须显式声明本次授权的商品数量上限；服务端不会默认任何数量。",
      400,
    );
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > HARD_MAX_AUTHORIZED_ITEMS) {
    throw new V5CoreError(
      "AUTHORIZED_ITEM_LIMIT_INVALID",
      `authorizedItemLimit 必须是 1-${HARD_MAX_AUTHORIZED_ITEMS} 的整数。`,
      400,
    );
  }
  return value;
}

/**
 * 采集计划指纹：必须是一个合法的 SHA-256，否则视为未提供（旧调用方保持可用）。
 * 计划本身永远由服务端权威重算，这里只接收「已确认计划的指纹」作为绑定依据。
 */
function normalizePlanFingerprint(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new V5CoreError("BATCH_CAPTURE_PLAN_FINGERPRINT_INVALID", "采集计划指纹格式无效。", 400);
  }
  return value;
}

function normalizePlanStrategyId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !isMarketCaptureStrategyId(value)) {
    throw new V5CoreError("BATCH_CAPTURE_PLAN_STRATEGY_INVALID", "采集策略标识无效。", 400);
  }
  return value;
}

function normalizeSearchEvidence(value: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (value === undefined || value === null) return map;
  if (!Array.isArray(value)) {
    throw new V5CoreError("BATCH_CAPTURE_SEARCH_EVIDENCE_INVALID", "searchEvidence 必须是数组。", 400);
  }
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.asin !== "string" || typeof row.evidenceRef !== "string" || !row.asin.trim() || !row.evidenceRef.trim()) continue;
    map.set(row.asin.trim().toUpperCase(), row.evidenceRef.trim());
  }
  return map;
}

function normalizedProductMarketQuery(value: unknown): {
  category: string;
  filters: Record<string, string>;
  subjectKey: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new V5CoreError("BATCH_CAPTURE_PRODUCT_MARKET_QUERY_INVALID", "必须提供 Product Market 类目查询。", 400);
  }
  const record = value as Record<string, unknown>;
  try {
    const queryInput = validateSellerSpriteQueryInput({
      module: "sellersprite_product_market",
      category: record.category,
      marketplace: "US",
      ...(record.filters === undefined ? {} : { filters: record.filters }),
    }, "sellersprite_product_market");
    if (queryInput.module !== "sellersprite_product_market") throw new Error("SELLERSPRITE_QUERY_MODULE_MISMATCH");
    const filters = Object.fromEntries(Object.entries(queryInput.filters ?? {}).sort(([left], [right]) => left.localeCompare(right)));
    return {
      category: queryInput.category.normalize("NFC").trim(),
      filters,
      subjectKey: sellerSpriteProductMarketQuerySubjectKey({ ...queryInput, filters }),
    };
  } catch {
    throw new V5CoreError("BATCH_CAPTURE_PRODUCT_MARKET_QUERY_INVALID", "Product Market 类目或筛选条件不符合查询合同。", 400);
  }
}

function normalizedKeywordMiningQuery(value: unknown): {
  seedKeyword: string;
  conditions: Record<string, string>;
  subjectKey: string;
  queryFingerprint: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new V5CoreError("BATCH_CAPTURE_KEYWORD_MINING_QUERY_INVALID", "必须提供 Keyword Mining seedKeyword 查询。", 400);
  }
  const record = value as Record<string, unknown>;
  try {
    const queryInput = validateSellerSpriteQueryInput({
      module: "keyword_mining_trend",
      seedKeyword: record.seedKeyword,
      marketplace: "US",
      ...(record.conditions === undefined ? {} : { conditions: record.conditions }),
    }, "keyword_mining_trend");
    if (queryInput.module !== "keyword_mining_trend") throw new Error("SELLERSPRITE_QUERY_MODULE_MISMATCH");
    const seedKeyword = queryInput.seedKeyword.normalize("NFC").trim();
    const conditions = Object.fromEntries(Object.entries(queryInput.conditions ?? {}).sort(([left], [right]) => left.localeCompare(right)));
    const normalized = { ...queryInput, seedKeyword, conditions };
    return {
      seedKeyword,
      conditions,
      subjectKey: sellerSpriteKeywordMiningQuerySubjectKey(normalized),
      queryFingerprint: sellerSpriteQueryFingerprint(normalized, "bcr"),
    };
  } catch {
    throw new V5CoreError("BATCH_CAPTURE_KEYWORD_MINING_QUERY_INVALID", "Keyword Mining seedKeyword 或筛选条件不符合查询合同。", 400);
  }
}

function validKeywordMiningExecution(input: {
  result: KeywordMiningQueryExecution;
  query: BatchCaptureKeywordMiningQueryUnit;
}): boolean {
  const { result, query } = input;
  return result.status === "captured"
    && result.querySubjectKey === query.querySubjectKey
    && result.queryFingerprint === query.queryFingerprint
    && Boolean(result.evidenceAttachmentId?.trim())
    && typeof result.evidenceContentHash === "string"
    && /^[a-f0-9]{64}$/u.test(result.evidenceContentHash)
    && Number.isSafeInteger(result.rowsObserved) && result.rowsObserved >= 0;
}

function refreshDerived(run: BatchCaptureRun): BatchCaptureRun {
  const progress = deriveProgress(run.cells, run.progress.itemsInBatch || countItems(run.cells));
  const moduleOutcomes = deriveModuleOutcomes(run.allowedModules, run.cells);
  /**
   * 导航预算上限唯一口径 = deriveNavigationBudget(授权数, 自动模块数, 计划搜索页数)。
   *
   * 历史路径曾把「已用搜索导航数」当作 searchPages 传入，导致 30 件出现 122（计划为 121）；
   * 读写均经 refreshDerived 归一到计划值。
   *
   * **不再因 used/reserved 超计划而抬高 limit**：那会把「超出授权」静默吸收成更大的授权上限，
   * 等于放宽限制。超出时保持计划上限，remaining 由调用方夹紧到 0（fail-closed），
   * 由 NAVIGATION_BUDGET_EXHAUSTED 明确阻断，而不是悄悄放行。
   */
  const autoModuleCount = run.allowedModules.filter((module) => isAutoBatchModule(module)).length;
  const plannedLimit = deriveNavigationBudget(
    Math.max(0, run.authorizedItemLimit),
    autoModuleCount,
    deriveSearchPages(Math.max(0, run.authorizedItemLimit)),
  );
  const grantedExtra = Math.max(0, Math.floor(Number(run.navigationBudget.grantedExtra ?? 0) || 0));
  /**
   * 追加额度**双封顶**：
   *   1) 不超过推导上限本身（总额最多翻倍，避免小额授权被放大成大额采集）；
   *   2) 不超过绝对硬顶 HARD_MAX_NAVIGATION_BUDGET。
   * 注意：**不对推导上限本身做夹紧**——200 件授权的推导值（807）本就高于旧硬顶，
   * 直接夹紧会压低正常授权（既有测试已覆盖该回归）。
   */
  const cappedExtra = Math.max(0, Math.min(grantedExtra, plannedLimit, HARD_MAX_NAVIGATION_BUDGET - plannedLimit));
  const navigationBudget = {
    ...run.navigationBudget,
    grantedExtra: cappedExtra,
    limit: plannedLimit + cappedExtra,
  };
  return { ...run, progress, moduleOutcomes, navigationBudget };
}

/**
 * 只读回绑搜索阶段证据：Run 单元可能缺 evidenceId，但 EvidenceStore/批次已有合法搜索证据。
 * 不改写持久化记录；仅用于 API/UI 投影，避免把「回执未绑定」显示成「无有效证据」。
 */
export function projectBatchCaptureRunSearchEvidence(
  run: BatchCaptureRun,
  evidenceByAsin: ReadonlyMap<string, string>,
): BatchCaptureRun {
  if (evidenceByAsin.size === 0) return refreshDerived(run);
  let touched = false;
  const cells = run.cells.map((cell) => {
    if (cell.module !== "amazon_search_market" || cell.evidenceId) return cell;
    const evidenceId = evidenceByAsin.get(cell.asin.trim().toUpperCase());
    if (!evidenceId) return cell;
    touched = true;
    return { ...cell, evidenceId, sourceVerified: true };
  });
  if (!touched) return refreshDerived(run);
  return refreshDerived({ ...run, cells });
}

function countItems(cells: BatchCaptureCell[]): number {
  return new Set(cells.map((cell) => cell.asin)).size;
}

function isHumanErrorCode(code: string | null | undefined): boolean {
  return code === "CAPTCHA_DETECTED" || code === "LOGIN_REQUIRED" || code === "HUMAN_GATE_PAUSE"
    || code === "SELLERSPRITE_LOGIN_REQUIRED" || code === "SELLERSPRITE_CAPTCHA_REQUIRED"
    || code === "SELLERSPRITE_STOP_REQUIRED";
}

function isVerifiedReverseAsinSourceRef(input: {
  item: EnrichItemLike;
  asin: string;
}): boolean {
  const ref = input.item.sourceEvidenceRef;
  const asin = input.asin.toUpperCase();
  if (!ref || ref.subjectKey !== `amazon:US:${asin}`
    || ref.module !== "reverse_asin" || ref.sourceType !== "sellersprite_plugin"
    || !ref.baseEvidenceId.trim() || !Number.isSafeInteger(ref.baseEvidenceVersion) || ref.baseEvidenceVersion < 1
    || !/^[a-f0-9]{64}$/u.test(ref.baseEvidenceContentHash)
    || !ref.attachmentId.trim() || input.item.evidenceId !== ref.attachmentId
    || !/^[a-f0-9]{64}$/u.test(ref.attachmentContentHash)
    || !/^[a-f0-9]{64}$/u.test(ref.captureJobFingerprint)) return false;
  const queryInput = { module: "reverse_asin" as const, targetAsin: asin, marketplace: "US" as const };
  return ref.queryFingerprint === sellerSpriteQueryFingerprint(queryInput, "bcr");
}

function validProductMarketExecution(input: {
  result: ProductMarketQueryExecution;
  query: BatchCaptureProductMarketQueryUnit;
  authorizedAsins: readonly string[];
}): boolean {
  const { result, query } = input;
  if (result.status !== "captured"
    || result.querySubjectKey !== query.querySubjectKey
    || !result.evidenceAttachmentId?.trim()
    || typeof result.evidenceContentHash !== "string" || !/^[a-f0-9]{64}$/u.test(result.evidenceContentHash)
    || !Number.isSafeInteger(result.rowsObserved) || result.rowsObserved < 0
    || !Array.isArray(result.productAssociations)) return false;
  const authorized = new Set(input.authorizedAsins.map((asin) => asin.toUpperCase()));
  const seen = new Set<string>();
  for (const link of result.productAssociations) {
    if (!authorized.has(link.asin) || seen.has(link.asin)
      || !/^[A-Z0-9]{10}$/u.test(link.asin)
      || link.rowKey !== `asin:${createHash("sha256").update(link.asin).digest("hex")}`
      || !/^[a-f0-9]{64}$/u.test(link.rowContentHash)
      || !link.baseEvidenceId.trim()
      || !Number.isSafeInteger(link.baseEvidenceVersion) || link.baseEvidenceVersion < 1
      || !/^[a-f0-9]{64}$/u.test(link.baseEvidenceContentHash)) return false;
    seen.add(link.asin);
  }
  return true;
}

function mapCellStatusFromEnrich(item: Pick<EnrichItemLike, "status" | "errorCode" | "retryable">): BatchCaptureCellStatus {
  // Human gates override any nominal success and any attached evidence. The
  // reference is retained separately on the cell for traceability.
  if (isHumanErrorCode(item.errorCode)) return "blocked_human";
  if (item.status === "failed_human" || item.status === "blocked_human") return "blocked_human";
  if (item.status === "blocked_with_evidence") return item.retryable === true ? "failed_retryable" : "failed_permanent";
  if (item.status === "failed_permanent") return "failed_permanent";
  if (item.status === "failed_retryable" || item.status === "failed") return "failed_retryable";

  if (item.status === "enriched" || item.status === "complete" || item.status === "succeeded") return "succeeded";
  if (item.status === "captured_partial" || item.status === "partial" || item.status === "no_data_with_evidence") return "partial";
  if (item.status === "skipped_enriched" || item.status === "skipped_existing") return "skipped_existing";
  if (item.status === "not_attempted") return item.retryable === true ? "failed_retryable" : "failed_permanent";

  // Unknown/missing status is not proof of successful content, even when the
  // worker attached an Evidence reference. Fail closed and keep that reference.
  return "failed_permanent";
}

/**
 * 字段是否完整：只有明确「整条 enriched / succeeded」才算完整；
 * captured_partial / partial / skipped_existing 一律不完整。
 */
function isFieldComplete(status: BatchCaptureCellStatus): boolean {
  return status === "succeeded";
}

/**
 * Research 可消费判定（下游适配器契约的纯函数编码）：
 * 仅当 执行成功 + 真实 EvidenceRef 通过来源校验 + 字段完整 + 该模块属自动采集模块。
 * 不因存在 evidenceId 就宣称 Research 已消费。
 */
export function isResearchConsumable(input: {
  status: BatchCaptureCellStatus;
  sourceVerified: boolean;
  fieldComplete: boolean;
  module: string;
}): boolean {
  return input.status === "succeeded"
    && input.sourceVerified
    && input.fieldComplete
    && isAutoBatchModule(input.module);
}

type ApplyOutcome = {
  cells: BatchCaptureCell[];
  touchedAsins: Set<string>;
  /** 模块返回与待处理 ASIN 不一致（被拒绝，不更新任何 cell）。 */
  mismatched: number;
  humanGate: boolean;
};

/**
 * 只应用「真正执行且身份验证通过」的结果：
 * - item.asin 必须属于本轮请求的 ASIN 集合（否则拒绝，不更新）；
 * - 已终态且非可重试失败的 cell 幂等跳过（不重复写入 / 不重复计数）；
 * - sourceVerified 由「请求集合身份一致 + 存在 EvidenceRef」共同决定。
 */
function applyModuleResults(
  cells: BatchCaptureCell[],
  module: string,
  requestedAsins: ReadonlySet<string>,
  items: EnrichItemLike[],
  nowIso: string,
): ApplyOutcome {
  const next = cells.map((cell) => ({ ...cell }));
  const touched = new Set<string>();
  let mismatched = 0;
  let humanGate = false;
  for (const item of items) {
    if (!item.asin) {
      mismatched += 1;
      continue;
    }
    const asin = item.asin.toUpperCase();
    if (!requestedAsins.has(asin)) {
      // 模块返回了本轮未请求的 ASIN：拒绝，绝不更新。
      mismatched += 1;
      continue;
    }
    const cell = next.find((row) => row.asin === asin && row.module === module);
    if (!cell) {
      mismatched += 1;
      continue;
    }
    if (isTerminalCell(cell.status) && cell.status !== "failed_retryable" && cell.status !== "pending") {
      // 已终态且非可重试失败：幂等跳过，不重复计数。
      continue;
    }
    const hasEvidence = typeof item.evidenceId === "string" && item.evidenceId.trim().length > 0;
    const mappedStatus = mapCellStatusFromEnrich(item);
    const reverseEvidenceValid = module !== "reverse_asin" || isVerifiedReverseAsinSourceRef({ item, asin });
    const status = !reverseEvidenceValid && mappedStatus !== "blocked_human"
      ? "failed_permanent"
      : mappedStatus;
    cell.status = status;
    cell.attempts += 1;
    cell.evidenceId = hasEvidence ? (item.evidenceId as string) : cell.evidenceId;
    cell.lastErrorCode = isHumanErrorCode(item.errorCode)
      ? item.errorCode ?? null
      : !reverseEvidenceValid
        ? "SELLERSPRITE_REVERSE_ASIN_EVIDENCE_IDENTITY_INVALID"
        : item.errorCode ?? null;
    cell.updatedAt = nowIso;
    // 身份验证：本轮按精确 ASIN 请求，返回项 asin 已与请求集合比对一致。
    cell.sourceVerified = hasEvidence && reverseEvidenceValid
      && (status === "succeeded" || status === "partial" || status === "skipped_existing");
    cell.fieldComplete = isFieldComplete(status);
    cell.researchConsumable = isResearchConsumable({
      status: cell.status,
      sourceVerified: cell.sourceVerified,
      fieldComplete: cell.fieldComplete,
      module,
    });
    touched.add(asin);
    if (status === "blocked_human" || isHumanErrorCode(item.errorCode)) humanGate = true;
  }
  return { cells: next, touchedAsins: touched, mismatched, humanGate };
}

/** 本轮可执行 ASIN（精确、有界、确定性顺序）。 */
function actionableAsinsForModule(
  cells: BatchCaptureCell[],
  module: string,
  limit: number,
  allowRetry: boolean,
  authorizedAsins?: readonly string[],
): string[] {
  // 预算硬门禁：只允许触碰本 run 明确授权的 ASIN 白名单。
  const whitelist = authorizedAsins ? new Set(authorizedAsins) : null;
  const out: string[] = [];
  const scoped = cells
    .filter((cell) => cell.module === module)
    .slice()
    .sort((a, b) => a.asin.localeCompare(b.asin));
  for (const cell of scoped) {
    if (whitelist && !whitelist.has(cell.asin)) continue;
    if (!isActionableCell(cell, allowRetry)) continue;
    if (out.includes(cell.asin)) continue;
    out.push(cell.asin);
    if (out.length >= limit) break;
  }
  return out;
}

export function createBatchCaptureRunService(deps: BatchCaptureRunDeps) {
  const table = deps.database.v5OperationReceipt;
  const now = deps.now ?? (() => new Date());
  const enrichDetail = deps.enrichDetail ?? enrichBatchWithAmazonDetail;
  const enrichVariation = deps.enrichVariation ?? enrichBatchWithVariation;
  const enrichReview = deps.enrichReview ?? enrichBatchWithReviewVoc;
  const preflightProductMarket = deps.preflightProductMarket ?? preflightSellerSpriteProductMarketBaseEvidence;
  const runProductMarketQuery = deps.runProductMarketQuery ?? captureSellerSpriteProductMarketQueryForBatch;
  const runReverseAsin = deps.runReverseAsin ?? captureSellerSpriteReverseAsinBatch;
  const runKeywordMiningQuery = deps.runKeywordMiningQuery ?? captureSellerSpriteKeywordMiningQueryForBatch;
  const resolveStore = deps.getProductBatchStore ?? getProductBatchStore;

  function whereUnique(batchId: string, idempotencyKey: string = IDEMPOTENCY_KEY) {
    return {
      where: {
        actorScope_operation_resourceKey_idempotencyKey: {
          actorScope: RESOURCE_SCOPE,
          operation: OPERATION,
          resourceKey: batchId,
          idempotencyKey,
        },
      },
    };
  }

  function mapRow(row: ReceiptRow | null): BatchCaptureRun | null {
    if (!row || row.actorScope !== RESOURCE_SCOPE || row.operation !== OPERATION || !row.responseJson) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.responseJson);
    } catch {
      return null;
    }
    const run = parseBatchCaptureRun(parsed);
    if (!run || run.batchId !== row.resourceKey || run.status !== row.status || run.runId !== row.id) return null;
    return run;
  }

  async function findRow(batchId: string): Promise<ReceiptRow | null> {
    return (await table.findUnique(whereUnique(batchId))) as ReceiptRow | null;
  }

  async function getRun(batchId: string): Promise<BatchCaptureRun | null> {
    const normalizedBatchId = normalizeBatchId(batchId);
    const row = await findRow(normalizedBatchId);
    const current = mapRow(row);
    if (!row || !current) return current;
    /**
     * D2-1H 状态自愈：历史缺陷可能把「执行器已退出、单元矩阵已是终态」的 Run 留在 RUNNING，
     * 页面于是同时显示「采集中」与「执行器已确认退出」，且后续追加预算 / 恢复 / 新建代次
     * 都会被「任务仍在执行」挡住，用户只能反复点同一个按钮。
     *
     * 原实现只在**读取时投影**推导状态、不落库（GET 不改写）。这带来读写不一致：
     * `getRun` 返回 PARTIAL，而持久化记录仍是 RUNNING —— 执行器据此拒绝启动
     * （`EXECUTOR_NOT_STARTED`），门禁又据此拒绝追加预算（`BATCH_CAPTURE_RUN_STILL_ACTIVE`）。
     *
     * 现在：**在确证执行器已退出时把校准结果落库**，让持久化状态与单元矩阵一致。
     * 安全条件（全部满足才写）：
     *   1) 持久化状态是 RUNNING / WAITING（在途态）；
     *   2) 推导结果是 PARTIAL / COMPLETED / HUMAN_REQUIRED（终态或可收口态）；
     *   3) 没有有效运行租约、也没有未确认退出的执行代次 —— 否则可能是执行器正在跑。
     * 控制态（PAUSED / CANCELLED / FAILED）从不覆盖；CAS 失败时退化为只读投影，绝不阻塞读取。
     */
    if (current.status === "RUNNING" || current.status === "WAITING") {
      const derived = deriveBatchCaptureRunStatus({
        modules: current.allowedModules,
        cells: current.cells,
      });
      const derivedLabel = BATCH_CAPTURE_RUN_STATUS_LABELS[derived] ?? derived;
      const persistedLabel = BATCH_CAPTURE_RUN_STATUS_LABELS[current.status] ?? current.status;
      if (derived !== current.status && derived !== "CANCELLED" && derived !== "PAUSED" && derived !== "FAILED") {
        const executorGone = !hasLiveLease(current) && !hasUnresolvedExecution(current);
        const message = executorGone
          ? `执行器已退出，任务状态已按已保存的商品单元校准为「${derivedLabel}」。`
          : `服务端根据已保存的商品单元判断为「${derivedLabel}」；历史运行摘要仍为「${persistedLabel}」，本次读取未改写任务记录。`;
        const projected = { ...refreshDerived(current), status: derived, lastMessage: message };
        if (executorGone) {
          const timestamp = now().toISOString();
          const written = await casWrite(row, refreshDerived({
            ...current,
            version: current.version + 1,
            status: derived,
            // 保留 lastErrorCode：它承载「执行阻塞回执」等诊断，自愈只修状态，不抹诊断。
            lastMessage: message,
            updatedAt: timestamp,
          }), null);
          if (written) return written;
        }
        return projected;
      }
    }
    // 只读重算 moduleOutcomes/progress：历史 Run 的持久化 outcomes 可能缺搜索阶段模块，
    // 必须以 cells 为权威在读取时投影八模块，否则 UI/API 仍显示 7 行。
    return refreshDerived(current);
  }

  function requestHashFor(run: BatchCaptureRun, version: number): string {
    return `${run.runId}:${version}`;
  }

  function rowData(run: BatchCaptureRun, expiresAt: Date | null) {
    return {
      status: run.status,
      responseJson: JSON.stringify(run),
      requestHash: requestHashFor(run, run.version),
      expiresAt,
    };
  }

  /**
   * 真正的数据库原子条件更新（CAS）：WHERE 里带上「读到的整行身份」
   * （id + status + updatedAt + responseJson），UPDATE 与版本检查在同一 SQL 语句内完成，
   * 不可分离。count===1 表示本次写入合法；count===0 表示状态已被其他写者改变。
   *
   * 失败不重试（外部采集已经发生），直接 fail-closed，避免旧结果覆盖新状态。
   */
  async function casWrite(
    expected: ReceiptRow,
    run: BatchCaptureRun,
    expiresAt: Date | null,
  ): Promise<BatchCaptureRun | null> {
    const changed = await table.updateMany({
      where: {
        id: expected.id,
        actorScope: RESOURCE_SCOPE,
        operation: OPERATION,
        resourceKey: expected.resourceKey,
        idempotencyKey: expected.idempotencyKey,
        status: expected.status,
        updatedAt: expected.updatedAt,
        responseJson: expected.responseJson,
      },
      data: rowData(run, expiresAt),
    });
    if (changed.count !== 1) return null;
    const fresh = await findRow(run.batchId);
    return mapRow(fresh);
  }

  async function persistResultOrThrow(expected: ReceiptRow, run: BatchCaptureRun, expiresAt: Date | null): Promise<BatchCaptureRun> {
    const written = await casWrite(expected, run, expiresAt);
    if (!written) {
      throw new V5CoreError(
        "BATCH_CAPTURE_CAS_CONFLICT",
        "任务状态已被其他操作更新（暂停/中止/新代次或并发执行），本轮结果未写入。",
        409,
        true,
      );
    }
    return written;
  }

  async function archiveGeneration(oldRow: ReceiptRow, oldRun: BatchCaptureRun, strict = false): Promise<void> {
    // 旧代次在同一 V5OperationReceipt 表内以每代次独立 idempotencyKey 归档，可独立读取审计。
    const archiveKey = `${ARCHIVE_KEY_PREFIX}${oldRun.runId}`;
    const archivedRun = { ...oldRun, expansionLock: null };
    const changed = await table.updateMany({
      where: strict
        ? {
            id: oldRow.id,
            actorScope: RESOURCE_SCOPE,
            operation: OPERATION,
            resourceKey: oldRow.resourceKey,
            idempotencyKey: oldRow.idempotencyKey,
            status: oldRow.status,
            updatedAt: oldRow.updatedAt,
            responseJson: oldRow.responseJson,
          }
        : { id: oldRow.id },
      data: strict
        ? {
            idempotencyKey: archiveKey,
            status: archivedRun.status,
            responseJson: JSON.stringify(archivedRun),
            requestHash: requestHashFor(archivedRun, archivedRun.version),
          }
        : { idempotencyKey: archiveKey },
    });
    if (strict && changed.count !== 1) {
      throw new V5CoreError("BATCH_CAPTURE_CAS_CONFLICT", "扩充期间原运行状态已变化；已拒绝创建新代次。", 409, true);
    }
  }

  async function createCurrentRow(run: BatchCaptureRun): Promise<BatchCaptureRun> {
    await table.create({
      data: {
        id: run.runId,
        actorScope: RESOURCE_SCOPE,
        operation: OPERATION,
        resourceKey: run.batchId,
        idempotencyKey: IDEMPOTENCY_KEY,
        requestHash: requestHashFor(run, run.version),
        status: run.status,
        responseJson: JSON.stringify(run),
        expiresAt: null,
        createdAt: new Date(run.createdAt),
        updatedAt: new Date(run.updatedAt),
      },
    });
    const fresh = await findRow(run.batchId);
    const created = mapRow(fresh);
    if (!created) throw new V5CoreError("BATCH_CAPTURE_PERSIST_FAILED", "批次采集任务写入失败。", 500);
    return created;
  }

  async function reserveExpansion(input: {
    context: AccessContext;
    batchId: unknown;
    authorizationId: unknown;
  }): Promise<BatchCaptureRun> {
    assertBatchScopeAllowed();
    requireOwner(input.context);
    const batchId = normalizeBatchId(input.batchId);
    const authorizationId = typeof input.authorizationId === "string" ? input.authorizationId.trim() : "";
    if (!/^[A-Za-z0-9_-]{12,80}$/u.test(authorizationId)) {
      throw new V5CoreError("CAPTURE_EXPANSION_AUTHORIZATION_ID_INVALID", "扩充授权记录编号无效。", 400);
    }
    const row = await findRow(batchId);
    const run = mapRow(row);
    if (!row || !run) throw new V5CoreError("BATCH_CAPTURE_RUN_NOT_FOUND", "请先确认当前批次的采集计划。", 404);
    if (run.expansionLock?.authorizationId === authorizationId) return run;
    if (run.expansionLock) assertExpansionUnlocked(run, "再次扩充批次");

    const derived = (run.status === "RUNNING" || run.status === "WAITING")
      ? deriveBatchCaptureRunStatus({ modules: run.allowedModules, cells: run.cells })
      : run.status;
    if (derived === "RUNNING" || derived === "WAITING") {
      throw new V5CoreError(
        "BATCH_CAPTURE_RUN_STILL_ACTIVE",
        "当前采集任务仍在运行或等待执行；请先让它完成，或暂停并等待执行器确认退出，再扩充批次。",
        409,
        true,
      );
    }
    if (!["HUMAN_REQUIRED", "PAUSED", "COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(derived)) {
      throw new V5CoreError("BATCH_CAPTURE_RUN_STATE_UNKNOWN", "无法确认当前任务处于可安全扩充的状态。", 409);
    }
    assertNoUnresolvedExecution(run, "扩充当前批次");
    const timestamp = now().toISOString();
    return persistResultOrThrow(row, {
      ...run,
      version: run.version + 1,
      status: derived,
      expansionLock: { authorizationId, acquiredAt: timestamp },
      updatedAt: timestamp,
    }, null);
  }

  async function releaseExpansion(input: {
    context: AccessContext;
    batchId: unknown;
    authorizationId: unknown;
    message?: string;
  }): Promise<BatchCaptureRun | null> {
    requireOwner(input.context);
    const batchId = normalizeBatchId(input.batchId);
    const authorizationId = typeof input.authorizationId === "string" ? input.authorizationId.trim() : "";
    const row = await findRow(batchId);
    const run = mapRow(row);
    if (!row || !run || run.expansionLock?.authorizationId !== authorizationId) return run;
    const timestamp = now().toISOString();
    return casWrite(row, {
      ...run,
      version: run.version + 1,
      expansionLock: null,
      ...(input.message ? { lastMessage: input.message } : {}),
      updatedAt: timestamp,
    }, null);
  }

  /**
   * 导航预算**追加授权**（显式 / 有界 / 可审计）。
   *
   * 真实缺陷背景：`deriveNavigationBudget` = 授权商品数 × 自动模块数 + 搜索页数，**不含重试余量**。
   * 只要出现可重试失败，重试就会吃掉首轮预算，最终出现「预算耗尽但仍有 pending 单元」的死结
   * （批次 1607279a 实测：91/91 用尽、21 个 pending）。
   *
   * 本方法**不是**取消门禁：
   * - 必须 owner 鉴权 + 显式授权编号（与批次扩充同一编号规则）；
   * - 必须写明用途；单次增量与总上限双重受限（MAX_NAVIGATION_TOP_UP / HARD_MAX_NAVIGATION_BUDGET）；
   * - 执行中（RUNNING/WAITING 或持有有效租约）一律拒绝，避免与在途执行器争用计数；
   * - 每次追加都写入 `navigationTopUps` 台账（额度/用途/追加后上限/时间），可追溯。
   */
  async function authorizeNavigationTopUp(input: {
    context: AccessContext;
    batchId: unknown;
    authorizationId: unknown;
    amount: unknown;
    purpose: unknown;
  }): Promise<BatchCaptureRun> {
    assertBatchScopeAllowed();
    requireOwner(input.context);
    const batchId = normalizeBatchId(input.batchId);
    const authorizationId = typeof input.authorizationId === "string" ? input.authorizationId.trim() : "";
    if (!/^[A-Za-z0-9_-]{12,80}$/u.test(authorizationId)) {
      throw new V5CoreError("CAPTURE_BUDGET_TOPUP_AUTHORIZATION_ID_INVALID", "预算追加授权编号无效（需 12–80 位字母/数字/下划线/连字符）。", 400);
    }
    const purpose = typeof input.purpose === "string" ? input.purpose.trim() : "";
    if (purpose.length < 4 || purpose.length > 200) {
      throw new V5CoreError("CAPTURE_BUDGET_TOPUP_PURPOSE_REQUIRED", "必须填写预算追加用途（4–200 字），以便审计追溯。", 400);
    }
    const amount = typeof input.amount === "number" ? input.amount : Number(input.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_NAVIGATION_TOP_UP) {
      throw new V5CoreError("CAPTURE_BUDGET_TOPUP_AMOUNT_INVALID", `追加额度必须是 1–${MAX_NAVIGATION_TOP_UP} 的整数。`, 400);
    }
    const row = await findRow(batchId);
    const run = mapRow(row);
    if (!row || !run) throw new V5CoreError("BATCH_CAPTURE_RUN_NOT_FOUND", "请先确认当前批次的采集计划。", 404);
    const existingTopUps = run.navigationTopUps ?? [];
    // 幂等：同一授权编号只记账一次，重复提交不重复加额。
    if (existingTopUps.some((entry) => entry.authorizationId === authorizationId)) return run;
    if (run.status === "RUNNING" || run.status === "WAITING" || hasLiveLease(run)) {
      throw new V5CoreError(
        "BATCH_CAPTURE_RUN_STILL_ACTIVE",
        "当前采集任务仍在执行或持有运行租约；请先暂停并确认执行器退出，再追加导航预算。",
        409,
        true,
      );
    }
    assertNoUnresolvedExecution(run, "追加导航预算");
    const autoModuleCount = run.allowedModules.filter((module) => isAutoBatchModule(module)).length;
    const plannedLimit = deriveNavigationBudget(
      Math.max(0, run.authorizedItemLimit),
      autoModuleCount,
      deriveSearchPages(Math.max(0, run.authorizedItemLimit)),
    );
    const currentExtra = Math.max(0, Math.floor(Number(run.navigationBudget.grantedExtra ?? 0) || 0));
    const nextExtra = currentExtra + amount;
    // 双封顶：总额不超过「推导上限 × 2」与「绝对硬顶」两者的较小值。
    const nextLimit = Math.min(plannedLimit + nextExtra, plannedLimit * (1 + MAX_NAVIGATION_TOP_UP_RATIO), HARD_MAX_NAVIGATION_BUDGET);
    if (nextLimit <= run.navigationBudget.limit) {
      throw new V5CoreError(
        "CAPTURE_BUDGET_TOPUP_AT_HARD_CAP",
        `导航预算已达上限（推导 ${plannedLimit} × ${1 + MAX_NAVIGATION_TOP_UP_RATIO}，绝对硬顶 ${HARD_MAX_NAVIGATION_BUDGET}），不再追加；剩余单元请另建代次或缩小范围。`,
        409,
      );
    }
    const timestamp = now().toISOString();
    const topUp = {
      authorizationId,
      amount,
      purpose,
      grantedLimitAfter: nextLimit,
      grantedAt: timestamp,
    };
    return persistResultOrThrow(row, refreshDerived({
      ...run,
      version: run.version + 1,
      navigationBudget: { ...run.navigationBudget, grantedExtra: nextExtra, updatedAt: timestamp },
      navigationTopUps: [...existingTopUps, topUp],
      lastMessage: `已追加导航预算 +${amount}（用途：${purpose}）；新上限 ${nextLimit}，已用 ${run.navigationBudget.used}。`,
      updatedAt: timestamp,
    }), null);
  }

  async function startExpansion(input: {
    context: AccessContext;
    batchId: unknown;
    authorizationId: unknown;
    targetTotal: unknown;
    authorizedSearchItemLimit: unknown;
    previousSearchNavigationUsed: unknown;
    expansionSearchNavigationUsed: unknown;
    newlyCapturedAsins: unknown;
    searchEvidence: unknown;
  }): Promise<{ run: BatchCaptureRun; created: boolean; newlyAuthorizedAsins: string[] }> {
    assertBatchScopeAllowed();
    requireOwner(input.context);
    const batchId = normalizeBatchId(input.batchId);
    const authorizationId = typeof input.authorizationId === "string" ? input.authorizationId.trim() : "";
    const targetTotal = requireAuthorizedItemLimit(input.targetTotal);
    const authorizedSearchItemLimit = input.authorizedSearchItemLimit;
    const previousSearchNavigationUsed = input.previousSearchNavigationUsed;
    const expansionSearchNavigationUsed = input.expansionSearchNavigationUsed;
    if (!Number.isSafeInteger(authorizedSearchItemLimit) || Number(authorizedSearchItemLimit) < 0
      || Number(authorizedSearchItemLimit) > HARD_MAX_AUTHORIZED_ITEMS
      || !Number.isSafeInteger(previousSearchNavigationUsed) || Number(previousSearchNavigationUsed) < 0
      || !Number.isSafeInteger(expansionSearchNavigationUsed) || Number(expansionSearchNavigationUsed) < 0) {
      throw new V5CoreError("BATCH_CAPTURE_SEARCH_NAVIGATION_INVALID", "扩充搜索导航回执无效。", 409);
    }
    if (Number(previousSearchNavigationUsed) + Number(expansionSearchNavigationUsed) > HARD_MAX_SEARCH_PAGES) {
      throw new V5CoreError("CAPTURE_EXPANSION_SEARCH_BUDGET_EXCEEDED", "累计 Amazon 搜索页数超过单批硬上限；已拒绝建立扩充运行代次。", 409);
    }
    const row = await findRow(batchId);
    const existing = mapRow(row);
    if (!row || !existing) throw new V5CoreError("BATCH_CAPTURE_RUN_NOT_FOUND", "扩充前的运行记录不存在。", 404);
    if (existing.expansionLock?.authorizationId !== authorizationId) {
      throw new V5CoreError("BATCH_CAPTURE_EXPANSION_LOCK_LOST", "扩充锁已变化；已拒绝启动并发运行代次。", 409, true);
    }
    assertNoUnresolvedExecution(existing, "建立扩充运行代次");
    if (["RUNNING", "WAITING"].includes(existing.status)) {
      throw new V5CoreError("BATCH_CAPTURE_RUN_STILL_ACTIVE", "旧运行已恢复执行；已拒绝并发扩充。", 409, true);
    }

    const store = resolveStore(input.context);
    const batch = await store.getBatch(batchId);
    if (!batch || batch.batchStatus !== "ready") {
      throw new V5CoreError("BATCH_NOT_READY", "只有 ready 批次可以建立扩充运行代次。", 409);
    }
    const items = (await store.getBatchItems(batchId))
      .filter((item) => !item.archivedAt && typeof item.asin === "string" && /^[A-Z0-9]{10}$/iu.test(item.asin.trim()));
    const batchAsins = [...new Set(items.map((item) => item.asin!.trim().toUpperCase()))];
    if (batchAsins.length > targetTotal) {
      throw new V5CoreError("CAPTURE_EXPANSION_TARGET_CHANGED", "批次商品数已超过确认的目标，请刷新后重新确认。", 409, true);
    }
    const oldAuthorized = new Set(existing.authorizedAsins.map((asin) => asin.toUpperCase()));
    const newlyAuthorizedAsins = batchAsins.filter((asin) => !oldAuthorized.has(asin));
    const authorizedAsins = [...new Set([...oldAuthorized, ...newlyAuthorizedAsins])];
    if (authorizedAsins.length > targetTotal || authorizedAsins.length > HARD_MAX_AUTHORIZED_ITEMS) {
      throw new V5CoreError("CAPTURE_EXPANSION_AUTHORIZATION_LIMIT", "扩充授权超过本次目标或单批硬上限。", 409);
    }
    const searchEvidence = normalizeSearchEvidence(input.searchEvidence);
    const existingCellAsins = new Set(existing.cells.map((cell) => cell.asin.toUpperCase()));
    const newCellAsins = newlyAuthorizedAsins.filter((asin) => !existingCellAsins.has(asin));
    const newlyCapturedAsins = Array.isArray(input.newlyCapturedAsins)
      ? new Set(input.newlyCapturedAsins.filter((asin): asin is string => typeof asin === "string").map((asin) => asin.toUpperCase()))
      : new Set<string>();
    const timestamp = now().toISOString();
    const addedCells: BatchCaptureCell[] = [];
    for (const asin of newCellAsins) {
      const evidenceId = searchEvidence.get(asin) ?? null;
      const searchCell = createCell(asin, "amazon_search_market", timestamp, evidenceId ? "succeeded" : "partial");
      searchCell.evidenceId = evidenceId;
      searchCell.sourceVerified = Boolean(evidenceId);
      searchCell.fieldComplete = false;
      searchCell.researchConsumable = false;
      addedCells.push(searchCell);
      for (const moduleId of existing.allowedModules) {
        if (isAutoBatchModule(moduleId)) addedCells.push(createCell(asin, moduleId, timestamp, "pending"));
        else addedCells.push(createCell(asin, moduleId, timestamp, "source_input_required"));
      }
    }

    const priorLedger: BatchCaptureAuthorizationSlice[] = existing.authorizationLedger?.length
      ? existing.authorizationLedger
      : [{
          authorizationId: existing.runId,
          kind: "initial",
          authorizedAsins: existing.authorizedAsins.map((asin) => asin.toUpperCase()),
          authorizedItemCount: existing.authorizedAsins.length,
          authorizedSearchItemLimit: existing.authorizedAsins.length,
          targetTotal: existing.authorizedItemLimit,
          newlySearchedItemCount: existing.authorizedAsins.length,
          reusedEvidenceItemCount: 0,
          searchNavigationUsed: Number(previousSearchNavigationUsed),
          confirmedAt: existing.createdAt,
        }];
    const ledger: BatchCaptureAuthorizationSlice[] = [...priorLedger, {
      authorizationId,
      kind: "expansion",
      authorizedAsins: newlyAuthorizedAsins,
      authorizedItemCount: newlyAuthorizedAsins.length,
      authorizedSearchItemLimit: Number(authorizedSearchItemLimit),
      targetTotal,
      newlySearchedItemCount: newlyAuthorizedAsins.filter((asin) => newlyCapturedAsins.has(asin)).length,
      reusedEvidenceItemCount: newlyAuthorizedAsins.filter((asin) => !newlyCapturedAsins.has(asin)).length,
      searchNavigationUsed: Number(expansionSearchNavigationUsed),
      confirmedAt: timestamp,
    }];
    /**
     * 导航预算作用域唯一口径：**每个运行代次各有一份**。
     *
     * limit = deriveNavigationBudget(本次代次授权商品数, 自动模块数, 计划搜索页数)；
     * used 起点 = 该批次**累计搜索阶段**导航消耗（previous + expansion），与「按计划新建代次」
     * （`start` → resolveBatchSearchNavigationUsed）完全同口径，也与计划预览的
     * navigationUsedAtStart 一致。
     *
     * 历史缺陷：这里曾写成 `used = existing.navigationBudget.used + expansionSearchNavigationUsed`，
     * 把上一代次的**模块导航**消耗继承进新代次，而新代次的 limit 已按扩充后的全量商品重算 →
     * 同一批工作被计费两次。线上 944e1e2c 的 114/121 就是这么来的（起点 22 = 上一代 21 + 搜索 1，
     * 而它自己的 3 个自动模块又重新规划了全部 30 件）；随后只要再规划一轮就会误报预算耗尽。
     *
     * 不继承旧模块消耗也不会放宽限制：旧代次已完成/已跳过单元的 cells 会随代次保留且不再是 pending，
     * 新代次只会为「真正还需要采集的单元」预留额度。
     */
    const autoModuleCount = existing.allowedModules.filter((module) => isAutoBatchModule(module)).length;
    const plannedLimit = deriveNavigationBudget(
      authorizedAsins.length,
      autoModuleCount,
      deriveSearchPages(authorizedAsins.length),
    );
    const cumulativeSearchNavigationUsed = Number(previousSearchNavigationUsed) + Number(expansionSearchNavigationUsed);
    // cells = 旧单元 + 新单元；旧搜索单元若缺 evidenceId，用本轮已核验的搜索证据回绑（不伪造）。
    const cells = [...existing.cells, ...addedCells].map((cell) => {
      if (cell.module !== "amazon_search_market" || cell.evidenceId) return cell;
      const evidenceId = searchEvidence.get(cell.asin.trim().toUpperCase());
      if (!evidenceId) return cell;
      return { ...cell, evidenceId, sourceVerified: true };
    });
    const derived = deriveBatchCaptureRunStatus({ modules: existing.allowedModules, cells });
    const status = existing.status === "PAUSED" ? "PAUSED" : derived;
    const next = refreshDerived({
      ...existing,
      runId: randomUUID(),
      runGeneration: existing.runGeneration + 1,
      version: 0,
      status,
      authorizedItemLimit: authorizedAsins.length,
      authorizedAsins,
      maxItemsPerAdvance: Math.min(existing.maxItemsPerAdvance, Math.max(1, authorizedAsins.length)),
      navigationBudget: {
        limit: plannedLimit,
        used: Math.min(cumulativeSearchNavigationUsed, plannedLimit),
        reserved: 0,
        updatedAt: timestamp,
      },
      leaseOwner: null,
      leaseExpiresAt: null,
      cells,
      progress: { ...existing.progress, itemsInBatch: authorizedAsins.length },
      authorizationLedger: ledger,
      expansionLock: null,
      advances: 0,
      driveSlices: 0,
      executionEpoch: 0,
      acknowledgedEpoch: 0,
      lastLeaseOwner: null,
      stopConfirmedBy: null,
      stopRecoveryReason: null,
      pauseRequestedAt: status === "PAUSED" ? existing.pauseRequestedAt : null,
      pauseAcknowledgedAt: status === "PAUSED" ? existing.pauseAcknowledgedAt : null,
      cancelRequestedAt: null,
      stopAcknowledgedAt: null,
      startedAt: status === "RUNNING" || status === "WAITING" ? timestamp : existing.startedAt,
      finishedAt: status === "HUMAN_REQUIRED" || status === "PAUSED" || status === "PARTIAL"
        || status === "COMPLETED" || status === "FAILED" || status === "CANCELLED" ? timestamp : null,
      lastErrorCode: status === "HUMAN_REQUIRED" ? existing.lastErrorCode : null,
      lastMessage: status === "HUMAN_REQUIRED"
        ? "批次已扩充，原有人工处理单元与未完成进度已保留；完成登录/验证后点击继续，系统会重新检查环境并只推进未完成单元。"
        : status === "PAUSED"
          ? "批次已扩充，原有未完成进度已保留；请确认旧执行器已退出后再继续。"
          : null,
      updatedAt: timestamp,
      supersededRunId: existing.runId,
    });

    await archiveGeneration(row, existing, true);
    try {
      return { run: await createCurrentRow(next), created: true, newlyAuthorizedAsins };
    } catch (error) {
      // 代次创建失败时尽力恢复当前键；旧 Run 的证据与单元格从未被删除。
      await table.updateMany({
        where: { id: row.id, idempotencyKey: `${ARCHIVE_KEY_PREFIX}${existing.runId}` },
        data: {
          idempotencyKey: IDEMPOTENCY_KEY,
          status: existing.status,
          responseJson: JSON.stringify({ ...existing, expansionLock: null }),
          requestHash: requestHashFor(existing, existing.version),
        },
      }).catch(() => undefined);
      throw error;
    }
  }

  async function start(input: {
    context: AccessContext;
    batchId: unknown;
    allowedModules?: unknown;
    maxItemsPerAdvance?: unknown;
    maxDriveSlices?: unknown;
    operator?: string;
    searchEvidence?: unknown;
    /** 用户本次明确授权的商品数量硬上限；缺失即 fail-closed。 */
    authorizedItemLimit?: unknown;
    /** 搜索阶段已经发生的导航次数（计入同一共享预算）。 */
    searchNavigationUsed?: unknown;
    /** 已确认的市场采集计划指纹；提供时本运行代次只执行该计划。 */
    planFingerprint?: unknown;
    /** 计划策略标识（回读展示用）。 */
    planStrategyId?: unknown;
  }): Promise<{ run: BatchCaptureRun; created: boolean }> {
    requireOwner(input.context);
    // 运行范围门禁：默认只允许单 ASIN 采集，批量创建在任何读写/租约之前拒绝。
    assertBatchScopeAllowed();
    const batchId = normalizeBatchId(input.batchId);
    const authorizedItemLimit = requireAuthorizedItemLimit(input.authorizedItemLimit);
    const planFingerprint = normalizePlanFingerprint(input.planFingerprint);
    const planStrategyId = normalizePlanStrategyId(input.planStrategyId);
    const allowedModules = normalizeModules(input.allowedModules);
    // 每轮预算不得超过本次授权上限。
    const maxItemsPerAdvance = Math.min(
      normalizeLimit(input.maxItemsPerAdvance, DEFAULT_MAX_ITEMS_PER_ADVANCE),
      authorizedItemLimit,
    );
    const searchEvidence = normalizeSearchEvidence(input.searchEvidence);
    const store = resolveStore(input.context);
    const batch = await store.getBatch(batchId);
    if (!batch) throw new V5CoreError("BATCH_NOT_FOUND", "商品批次不存在。", 404);
    if (batch.batchStatus !== "ready") throw new V5CoreError("BATCH_NOT_READY", "只有 ready 批次可以启动自动采集。", 409);
    /**
     * 搜索阶段导航消耗只能来自服务端持久化的批次回执，禁止客户端把已发生的真实消耗清零。
     * - 批次回执可核验 ⇒ 以回执为准；调用方声明值必须与之相等（不等一律拒绝）。
     * - 批次可证明没有搜索阶段 ⇒ 允许使用调用方（服务端）声明的值，取较大者，绝不低估消耗。
     * - 批次由搜索采集产生但缺少导航回执 ⇒ 明确阻断，不伪造、不默认 0。
     */
    const searchNavigationResolution = resolveBatchSearchNavigationUsed(batch);
    if (!searchNavigationResolution.known) {
      throw new V5CoreError(searchNavigationResolution.code, searchNavigationResolution.reason, 409);
    }
    const declaredSearchNavigationUsed = typeof input.searchNavigationUsed === "number"
      && Number.isSafeInteger(input.searchNavigationUsed) && input.searchNavigationUsed >= 0
      ? input.searchNavigationUsed
      : null;
    if (searchNavigationResolution.provenance === "search_stage_receipt"
      && declaredSearchNavigationUsed !== null
      && declaredSearchNavigationUsed !== searchNavigationResolution.used) {
      throw new V5CoreError(
        "BATCH_CAPTURE_SEARCH_NAVIGATION_MISMATCH",
        `声明的搜索阶段导航消耗 ${declaredSearchNavigationUsed} 与批次回执 ${searchNavigationResolution.used} 不一致；`
        + "已拒绝启动，不会采用较低值。",
        409,
      );
    }
    const authoritativeSearchNavigationUsed = Math.max(
      searchNavigationResolution.used,
      declaredSearchNavigationUsed ?? 0,
    );
    const batchItems = (await store.getBatchItems(batchId))
      .filter((item) => !item.archivedAt && item.asin)
      .slice()
      .sort((a, b) => (Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0)));
    const allAsins = [...new Set(batchItems.map((item) => String(item.asin).toUpperCase()))];
    if (!allAsins.length) throw new V5CoreError("BATCH_HAS_NO_ASINS", "该批次没有可采集的 ASIN。", 409);
    // 预算硬门禁：只允许授权范围内的 ASIN 进入运行矩阵与白名单。
    const asins = allAsins.slice(0, authorizedItemLimit);

    const existingRow = await findRow(batchId);
    const existing = mapRow(existingRow);
    if (existing && existing.status !== "CANCELLED" && existing.status !== "FAILED") {
      /**
       * 计划绑定校验：同一批次已存在运行代次时，只有**同一计划指纹**才允许幂等复用。
       * 这保证「用户确认的计划」与实际执行的运行严格对应：
       * 计划一旦变化（策略 / 授权数量 / 目标数量 / 模块矩阵 / 导航预算），
       * 不允许悄悄沿用一个按旧计划授权的运行，必须显式取消后重新确认。
       */
      if (planFingerprint && existing.planFingerprint && existing.planFingerprint !== planFingerprint) {
        throw new V5CoreError(
          "BATCH_CAPTURE_PLAN_MISMATCH",
          "该批次已存在按另一个采集计划授权的运行；请先取消当前运行，再按新计划确认。",
          409,
          false,
          true,
          { existingPlanStrategyId: existing.planStrategyId, runId: existing.runId },
        );
      }
      if (planFingerprint && !existing.planFingerprint) {
        throw new V5CoreError(
          "BATCH_CAPTURE_PLAN_UNBOUND_RUN_EXISTS",
          "该批次已存在未绑定采集计划的运行；请先取消当前运行，再按确认的计划创建新运行。",
          409,
          false,
          true,
          { runId: existing.runId },
        );
      }
      return { run: existing, created: false };
    }
    /**
     * 旧代次已中止/失败，但旧执行器可能尚未退出：
     * **只要存在未确认退出的执行代次，就不得创建新代次** —— 无论租约是否已到期。
     */
    if (existing) assertNoUnresolvedExecution(existing, "启动新的运行代次");

    const timestamp = now().toISOString();
    const cells: BatchCaptureCell[] = [];
    for (const asin of asins) {
      // 搜索阶段模块：搜索已成功并持久化证据（若调用方提供引用则绑定，否则记为执行结束但未记录证据）。
      const evidenceRef = searchEvidence.get(asin) ?? null;
      const searchCell = createCell(asin, "amazon_search_market", timestamp, "succeeded");
      searchCell.evidenceId = evidenceRef;
      searchCell.sourceVerified = Boolean(evidenceRef);
      searchCell.fieldComplete = false;
      searchCell.researchConsumable = false;
      cells.push(searchCell);
      for (const moduleId of allowedModules) {
        if (isAutoBatchModule(moduleId)) {
          cells.push(createCell(asin, moduleId, timestamp, "pending"));
        } else {
          // 四个未自动接线模块：在用户侧八模块矩阵中真实显示缺口，不从默认任务消失。
          cells.push(createCell(asin, moduleId, timestamp, "source_input_required"));
        }
      }
    }

    const maxDriveSlices = typeof input.maxDriveSlices === "number" && input.maxDriveSlices >= 1
      ? Math.floor(input.maxDriveSlices)
      : DEFAULT_MAX_DRIVE_SLICES;
    const autoModuleCount = allowedModules.filter((module) => isAutoBatchModule(module)).length;
    const searchNavigationUsed = authoritativeSearchNavigationUsed;
    const navigationLimit = deriveNavigationBudget(authorizedItemLimit, autoModuleCount, deriveSearchPages(authorizedItemLimit));
    const navigationBudget = {
      limit: navigationLimit,
      used: Math.min(searchNavigationUsed, navigationLimit),
      reserved: 0,
      updatedAt: timestamp,
    };

    const base: BatchCaptureRun = {
      schemaVersion: BATCH_CAPTURE_RUN_SCHEMA_VERSION,
      runId: randomUUID(),
      batchId,
      runGeneration: (existing?.runGeneration ?? 0) + 1,
      version: 0,
      status: "WAITING",
      allowedModules,
      authorizedItemLimit,
      authorizedAsins: asins,
      maxItemsPerAdvance,
      navigationBudget,
      maxDriveSlices,
      retryAuthorized: false,
      operator: input.operator ?? "owner",
      leaseOwner: null,
      leaseExpiresAt: null,
      cells,
      productMarketQueries: [],
      keywordMiningQueries: [],
      moduleOutcomes: [],
      progress: {
        itemsInBatch: asins.length,
        uniqueItemsVisited: 0,
        detailSucceededItems: 0,
        pendingCells: cells.filter((cell) => cell.status === "pending").length,
        terminalCells: cells.filter((cell) => isTerminalCell(cell.status)).length,
        totalCells: cells.length,
        validEvidenceCells: 0,
        fieldCompleteCells: 0,
        partialCells: 0,
        humanCells: 0,
        failedCells: 0,
        sourceLimitedCells: 0,
        researchConsumableCells: 0,
      },
      advances: 0,
      driveSlices: 0,
      lastErrorCode: null,
      lastMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      finishedAt: null,
      supersededRunId: existing ? existing.runId : null,
      pauseRequestedAt: null,
      pauseAcknowledgedAt: null,
      cancelRequestedAt: null,
      stopAcknowledgedAt: null,
      executionEpoch: 0,
      acknowledgedEpoch: 0,
      lastLeaseOwner: null,
      stopConfirmedBy: null,
      stopRecoveryReason: null,
      planFingerprint,
      planStrategyId,
    };
    const run = refreshDerived(base);

    // 归档旧代次（若有），使旧运行可独立读取审计，而不是被直接覆盖。
    if (existingRow && existing) {
      await archiveGeneration(existingRow, existing);
    }
    try {
      return { run: await createCurrentRow(run), created: true };
    } catch (error) {
      const racedRow = await findRow(batchId);
      const raced = mapRow(racedRow);
      if (raced) return { run: raced, created: false };
      throw error;
    }
  }

  async function prepareProductMarketQuery(input: {
    context: AccessContext;
    batchId: unknown;
    query: unknown;
  }): Promise<BatchCaptureRun> {
    assertBatchScopeAllowed();
    requireOwner(input.context);
    const batchId = normalizeBatchId(input.batchId);
    const normalized = normalizedProductMarketQuery(input.query);
    const row = await findRow(batchId);
    const current = mapRow(row);
    if (!row || !current) throw new V5CoreError("BATCH_CAPTURE_RUN_NOT_FOUND", "请先启动该商品批次的自动采集运行。", 404);
    assertExpansionUnlocked(current, "准备商品市场查询");
    if (!current.allowedModules.includes("sellersprite_product_market")) {
      throw new V5CoreError("BATCH_CAPTURE_PRODUCT_MARKET_NOT_ALLOWED", "当前批次未授权卖家精灵商品市场模块。", 409);
    }
    const existing = current.productMarketQueries[0];
    const timestamp = now().toISOString();
    if (existing) {
      if (existing.querySubjectKey !== normalized.subjectKey) {
        throw new V5CoreError("BATCH_CAPTURE_PRODUCT_MARKET_QUERY_EXISTS", "本轮已记录另一项 Product Market 类目查询；请使用新的批次运行。", 409);
      }
      if (existing.status !== "blocked" || existing.errorCode !== "SELLERSPRITE_PRODUCT_MARKET_BASE_EVIDENCE_MISSING") {
        return current;
      }
      const rearmed: BatchCaptureProductMarketQueryUnit = {
        ...existing,
        status: "pending",
        errorCode: null,
        updatedAt: timestamp,
      };
      return persistResultOrThrow(row, refreshDerived({
        ...current,
        version: current.version + 1,
        productMarketQueries: [rearmed],
        lastErrorCode: null,
        lastMessage: "已重新排入类目查询前置检查；不会自动启用真实来源。",
        updatedAt: timestamp,
      }), row.expiresAt);
    }
    const queryUnit: BatchCaptureProductMarketQueryUnit = {
      queryId: randomUUID(),
      category: normalized.category,
      marketplace: "US",
      filters: normalized.filters,
      status: "pending",
      querySubjectKey: normalized.subjectKey,
      evidenceAttachmentId: null,
      evidenceContentHash: null,
      rowsObserved: 0,
      productAssociations: [],
      errorCode: null,
      updatedAt: timestamp,
    };
    return persistResultOrThrow(row, refreshDerived({
      ...current,
      version: current.version + 1,
      productMarketQueries: [queryUnit],
      // 查询级导航只能消耗 run 上已有的共享授权预算，绝不在此抬高 limit：
      // limit 由 start() 依据用户显式授权的 authorizedItemLimit 推导，任何
      // prepare/retry/resume 都不得把它变成「无授权扩容」。
      lastErrorCode: null,
      lastMessage: "已建立独立的类目查询单元；商品矩阵不会因此标记完成。",
      updatedAt: timestamp,
    }), row.expiresAt);
  }

  async function prepareKeywordMiningQuery(input: {
    context: AccessContext;
    batchId: unknown;
    query: unknown;
  }): Promise<BatchCaptureRun> {
    assertBatchScopeAllowed();
    requireOwner(input.context);
    const batchId = normalizeBatchId(input.batchId);
    const normalized = normalizedKeywordMiningQuery(input.query);
    const row = await findRow(batchId);
    const current = mapRow(row);
    if (!row || !current) throw new V5CoreError("BATCH_CAPTURE_RUN_NOT_FOUND", "请先启动该商品批次的自动采集运行。", 404);
    assertExpansionUnlocked(current, "准备关键词查询");
    if (!current.allowedModules.includes("keyword_mining_trend")) {
      throw new V5CoreError("BATCH_CAPTURE_KEYWORD_MINING_NOT_ALLOWED", "当前批次未授权 SellerSprite Keyword Mining 模块。", 409);
    }
    const existing = current.keywordMiningQueries[0];
    const timestamp = now().toISOString();
    if (existing) {
      if (existing.querySubjectKey !== normalized.subjectKey) {
        throw new V5CoreError("BATCH_CAPTURE_KEYWORD_MINING_QUERY_EXISTS", "本轮已记录另一项 seedKeyword 查询；请使用新的批次运行。", 409);
      }
      if (existing.status !== "blocked") return current;
      const rearmed: BatchCaptureKeywordMiningQueryUnit = {
        ...existing, status: "pending", errorCode: null, updatedAt: timestamp,
      };
      return persistResultOrThrow(row, refreshDerived({
        ...current,
        version: current.version + 1,
        keywordMiningQueries: [rearmed],
        lastErrorCode: null,
        lastMessage: "已重新排入 seedKeyword 查询前置检查；不会自动启用真实来源。",
        updatedAt: timestamp,
      }), row.expiresAt);
    }
    const queryUnit: BatchCaptureKeywordMiningQueryUnit = {
      queryId: randomUUID(),
      seedKeyword: normalized.seedKeyword,
      marketplace: "US",
      conditions: normalized.conditions,
      status: "pending",
      querySubjectKey: normalized.subjectKey,
      queryFingerprint: normalized.queryFingerprint,
      evidenceAttachmentId: null,
      evidenceContentHash: null,
      rowsObserved: 0,
      errorCode: null,
      updatedAt: timestamp,
    };
    return persistResultOrThrow(row, refreshDerived({
      ...current,
      version: current.version + 1,
      keywordMiningQueries: [queryUnit],
      // 与 Product Market 同一规则：查询导航只能消耗既有共享预算，不得抬高 limit。
      lastErrorCode: null,
      lastMessage: "已建立独立 seedKeyword 查询单元；关键词行不会自动投影到 ASIN。",
      updatedAt: timestamp,
    }), row.expiresAt);
  }

  type LeaseState = { run: BatchCaptureRun; row: ReceiptRow };

  /** 运行租约是否仍在有效期内（只表示控制租约未过期，**不表示**执行器已退出）。 */
  function hasLiveLease(run: BatchCaptureRun): boolean {
    return Boolean(run.leaseOwner && run.leaseExpiresAt
      && Date.parse(run.leaseExpiresAt) > now().getTime());
  }

  /**
   * 执行代次保护（P0）：
   *
   * 「租约到期」只能证明**控制租约过期**，不能证明旧执行器已停止导航、读取页面
   * 或写入证据。因此冲突判定不能用租约有效期，而必须用「执行代次是否已确认退出」：
   * `executionEpoch > acknowledgedEpoch` ⇒ 存在未确认退出的执行器 ⇒ 必须 fail-closed。
   *
   * 解除阻塞只有两条可信路径：
   *   1. 执行器自身确认退出（`acknowledgeStop`，必须匹配租约所有者与执行代次）；
   *   2. 人工核对后确认（`recoverStalledExecution`，必须匹配运行代次/执行代次并给出原因）。
   */
  /**
   * 「执行未关闭」判定：满足任一条即视为存在未确认退出的执行器。
   * - 仍有未确认退出的执行代次（`executionEpoch > acknowledgedEpoch`）；
   * - 或运行租约仍在有效期内（有人持有租约即有人可能在执行）；
   * - 或已发出暂停/中止请求但停止事实未确认（epoch 可能被历史数据提前对齐，stopAck 仍为空——
   *   此时不得同时宣称「已退出」与「未停止」，必须阻断重试直至人工/执行器确认）。
   */
  function hasUnconfirmedStopRequest(run: BatchCaptureRun): boolean {
    if (run.executionEpoch <= 0) return false;
    const requested = Boolean(run.pauseRequestedAt || run.cancelRequestedAt);
    if (!requested) return false;
    if (run.stopAcknowledgedAt || run.pauseAcknowledgedAt) return false;
    /**
     * 根因修复（444/944 批次反复中断）：停止确认为空 **本身不是**「执行器生死未知」的证据。
     *
     * 只有能证明「执行器仍可能存在并继续导航」的两个事实才升级为未知：
     *   1. 仍有未关闭的执行代次（executionEpoch > acknowledgedEpoch）；
     *   2. 运行租约仍在有效期内（有人持租约就可能有人在外采）。
     *
     * 反例（正式批次 944e1e2c 的真实形态）：暂停/中止请求已写入、停止确认为空，
     * 但执行代次已由持久化写入关闭（acknowledgedEpoch >= executionEpoch）且无有效租约。
     * 该组合只可能来自「停止请求到达时执行器早已退出」——关闭代次的写入（releaseLease /
     * 终态 slice / acknowledgeStop）都发生在所有 Worker 返回之后，不可能隐藏在途导航。
     * 历史上把它当成未知，会让「继续 / 重试 / 新建运行代次」永久 409，
     * 用户只能反复点同一个按钮，最终被迫走人工核对；而同一份状态在 acquireLease
     * 里本来就被判定为「可以开始新执行」——两处口径必须一致，否则形成自锁。
     */
    return run.executionEpoch > run.acknowledgedEpoch || hasLiveLease(run);
  }

  function hasOpenExecution(run: BatchCaptureRun): boolean {
    return hasUnresolvedExecution(run) || hasLiveLease(run) || hasUnconfirmedStopRequest(run);
  }

  function assertExpansionUnlocked(run: BatchCaptureRun, action: string): void {
    if (!run.expansionLock) return;
    throw new V5CoreError(
      "BATCH_CAPTURE_EXPANSION_BUSY",
      `批次正在扩充（授权记录 ${run.expansionLock.authorizationId}），暂不能${action}；扩充完成后刷新状态再继续。`,
      409,
      true,
    );
  }

  function assertNoUnresolvedExecution(run: BatchCaptureRun, action: string): void {
    if (!hasOpenExecution(run)) return;
    const live = hasLiveLease(run);
    const stopPending = Boolean(run.pauseRequestedAt || run.cancelRequestedAt)
      && !run.stopAcknowledgedAt && !run.pauseAcknowledgedAt;
    throw new V5CoreError(
      "BATCH_CAPTURE_EXECUTION_STATE_UNKNOWN",
      `执行代次 ${run.executionEpoch} 未获得退出确认（已确认 ${run.acknowledgedEpoch}），暂不能${action}。`
        + (stopPending ? "已请求暂停/中止，正在等待该执行器确认退出。" : "")
        + (live
          ? "运行租约仍在有效期内：在途采集操作尚未退出。"
          : "租约已过期，但执行代次仍未关闭——超时不是停止证明。")
        + "请等待执行器自行确认退出；确认旧采集进程不再存活后，可使用人工确认恢复。",
      409,
      true,
    );
  }

  /** 与 `assertNoUnresolvedExecution` 等价，但用于「暂停中继续」场景，保留既有错误码语义。 */
  function assertResumeSafe(run: BatchCaptureRun): void {
    if (!hasOpenExecution(run)) return;
    if (hasLiveLease(run)) {
      throw new V5CoreError(
        "BATCH_CAPTURE_PAUSE_IN_PROGRESS",
        "暂停仍在进行：在途采集操作尚未退出，暂不能继续（请稍后重试）。",
        409,
        true,
      );
    }
    throw new V5CoreError(
      "BATCH_CAPTURE_EXECUTION_STATE_UNKNOWN",
      `暂停请求已收到，但执行代次 ${run.executionEpoch} 未获得退出确认（租约已过期）。`
      + "超时不等于执行器已停止；请先核对旧采集进程确实不再存活，再使用人工确认恢复。",
      409,
      true,
    );
  }

  function navigationRemaining(run: BatchCaptureRun): number {
    return Math.max(0, run.navigationBudget.limit - run.navigationBudget.used - run.navigationBudget.reserved);
  }

  /**
   * 并发安全地预留导航额度：读行 → 检查 → CAS 写 reserved。
   * 所有 Worker 共享同一 run 行，因此不存在「各自计数后共同突破上限」。
   */
  async function reserveNavigation(batchId: string, count: number): Promise<{ run: BatchCaptureRun; granted: number }> {
    for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
      const row = await findRow(batchId);
      const run = mapRow(row);
      if (!row || !run) throw new V5CoreError("BATCH_CAPTURE_RUN_NOT_FOUND", "尚未创建批次自动采集任务。", 404);
      const remaining = navigationRemaining(run);
      const granted = Math.max(0, Math.min(count, remaining));
      if (granted === 0) return { run, granted: 0 };
      const next = {
        ...run,
        version: run.version + 1,
        navigationBudget: { ...run.navigationBudget, reserved: run.navigationBudget.reserved + granted, updatedAt: now().toISOString() },
        updatedAt: now().toISOString(),
      };
      const written = await casWrite(row, next, row.expiresAt);
      if (written) return { run: written, granted };
    }
    throw new V5CoreError("BATCH_CAPTURE_CAS_CONFLICT", "预留导航预算失败，请稍后重试。", 409, true);
  }

  /** 结算：reserved → used。失败不抛（结算不应阻塞收尾），但会留下可审计的 reserved 残留。 */
  async function settleNavigation(batchId: string, reservedCount: number, usedCount: number): Promise<void> {
    for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
      const row = await findRow(batchId);
      const run = mapRow(row);
      if (!row || !run) return;
      const release = Math.max(0, reservedCount - usedCount);
      const next = {
        ...run,
        version: run.version + 1,
        navigationBudget: {
          ...run.navigationBudget,
          reserved: Math.max(0, run.navigationBudget.reserved - reservedCount),
          used: run.navigationBudget.used + Math.max(0, usedCount),
          updatedAt: now().toISOString(),
        },
        updatedAt: now().toISOString(),
      };
      void release;
      const written = await casWrite(row, next, row.expiresAt);
      if (written) return;
    }
    // 不再静默：结算失败会让额度被多占（更保守，不会突破上限），但必须可观测。
    console.error("[batch-capture-run] NAVIGATION_SETTLE_FAILED", JSON.stringify({
      batchId, reservedCount, usedCount, stage: "settle", timestamp: now().toISOString(),
    }));
  }

  /** 在外部 Worker 执行前，用数据库 CAS 持久化运行租约与执行身份。 */
  async function acquireLease(
    batchId: string,
    owner: string,
    options: { resumeRetryable?: boolean } = {},
  ): Promise<LeaseState> {
    for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
      const row = await findRow(batchId);
      const run = mapRow(row);
      if (!row || !run) throw new V5CoreError("BATCH_CAPTURE_RUN_NOT_FOUND", "尚未创建批次自动采集任务。", 404);
      assertExpansionUnlocked(run, "启动执行器");
      /**
       * 终态不再授予租约。例外：PARTIAL 且仍有未达上限的可重试失败单元，
       * 且调用方明确要求自动重试（resumeRetryable）——这类「部分完成」还有合法的后续工作，
       * 必须能继续推进，而不是让「开始自动采集」按钮点了没反应。
       * 该分支仍走同一套租约/代次/未关闭执行检查，不会产生第二个并发执行器。
       */
      const resumeRetryable = options.resumeRetryable === true
        && run.status === "PARTIAL"
        && run.cells.some((cell) => isRetryableCell(cell));
      if (!resumeRetryable
        && ["PAUSED", "CANCELLED", "COMPLETED", "PARTIAL", "HUMAN_REQUIRED", "FAILED"].includes(run.status)) {
        return { run, row };
      }
      const current = now();
      const activeLease = run.leaseOwner
        && run.leaseExpiresAt
        && Date.parse(run.leaseExpiresAt) > current.getTime();
      if (activeLease && run.leaseOwner !== owner) {
        throw new V5CoreError("BATCH_CAPTURE_JOB_BUSY", "已有执行器在推进该批次。", 409, true);
      }
      // 租约已过期但存在未确认退出的执行器时，同样不得授予新租约：
      // 否则「超时」会被当成停止证明，新旧执行器并发操作同一来源资源。
      if (!activeLease && run.leaseOwner !== owner && hasUnresolvedExecution(run)) {
        throw new V5CoreError(
          "BATCH_CAPTURE_EXECUTION_STATE_UNKNOWN",
          `执行代次 ${run.executionEpoch} 未获得退出确认（已确认 ${run.acknowledgedEpoch}）；`
          + "租约到期不等于执行器已停止，暂不能开始新的执行。",
          409,
          true,
        );
      }
      const leaseExpiresAt = new Date(current.getTime() + LEASE_MS);
      const leased: BatchCaptureRun = {
        ...run,
        // WAITING 与「PARTIAL 但仍有可自动重试单元」都进入 RUNNING：UI 才会显示采集中并继续轮询。
        status: run.status === "WAITING" || resumeRetryable ? "RUNNING" : run.status,
        version: run.version + 1,
        updatedAt: current.toISOString(),
        leaseOwner: owner,
        // 每次授予租约都开启一个新的执行代次：该代次必须被确认退出后才算关闭。
        lastLeaseOwner: owner,
        executionEpoch: run.executionEpoch + 1,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        startedAt: run.startedAt ?? current.toISOString(),
      };
      const written = await casWrite(row, leased, leaseExpiresAt);
      if (written) return { run: written, row: (await findRow(batchId)) as ReceiptRow };
      // CAS 失败：说明有并发写者；重读后再判断（尚未执行任何外部采集）。
    }
    throw new V5CoreError("BATCH_CAPTURE_CAS_CONFLICT", "获取运行租约失败，请稍后重试。", 409, true);
  }

  async function releaseLease(state: LeaseState, extra: Partial<BatchCaptureRun> = {}): Promise<BatchCaptureRun> {
    const current = now();
    const released: BatchCaptureRun = {
      ...state.run,
      ...extra,
      version: state.run.version + 1,
      updatedAt: current.toISOString(),
      leaseOwner: null,
      leaseExpiresAt: null,
      // 调用方只在「本次执行循环已结束」时释放租约，因此该代次可确认关闭。
      acknowledgedEpoch: Math.max(state.run.acknowledgedEpoch, state.run.executionEpoch),
    };
    const written = await casWrite(state.row, released, null);
    if (!written) {
      // 释放失败通常意味着并发控制（暂停/中止/新代次）已接管；把最新状态读回返回，不覆盖。
      const latest = await getRun(state.run.batchId);
      if (latest) return latest;
      throw new V5CoreError("BATCH_CAPTURE_CAS_CONFLICT", "释放租约时状态已变更。", 409, true);
    }
    return written;
  }

  const FINISHED_STATUSES = ["COMPLETED", "PARTIAL", "HUMAN_REQUIRED", "FAILED", "CANCELLED"];

  /** 执行一个 slice：假定已持有租约。返回写回后的运行状态。 */
  async function runOneSlice(input: {
    context: AccessContext;
    batchId: string;
    state: LeaseState;
    requestedLimit: number;
    allowRetry: boolean;
    idempotencyKey: string;
    fromDrive: boolean;
    env?: NodeJS.ProcessEnv;
  }): Promise<BatchCaptureRun> {
    const { context, batchId, requestedLimit, allowRetry, fromDrive, env } = input;
    let state = input.state;
    let current = state.run;
    const effectiveLimit = Math.min(requestedLimit, current.maxItemsPerAdvance);
    const executionIdentity = {
      runId: current.runId,
      runGeneration: current.runGeneration,
      executionEpoch: current.executionEpoch,
      leaseOwner: current.leaseOwner,
    };

    /** Stop checks also cover query-level workers; each one can access an external source. */
    const shouldStop = async (): Promise<boolean> => {
      const latest = await getRun(batchId);
      if (!latest) return true;
      if (["PAUSED", "CANCELLED", "HUMAN_REQUIRED"].includes(latest.status)) return true;
      return latest.runId !== executionIdentity.runId
        || latest.runGeneration !== executionIdentity.runGeneration
        || latest.executionEpoch !== executionIdentity.executionEpoch
        || latest.leaseOwner !== executionIdentity.leaseOwner;
    };
    const finishBeforeExternalWork = async (): Promise<BatchCaptureRun> => {
      const latest = await getRun(batchId);
      if (!latest) return current;
      const sameExecution = latest.runId === executionIdentity.runId
        && latest.runGeneration === executionIdentity.runGeneration
        && latest.executionEpoch === executionIdentity.executionEpoch
        && latest.leaseOwner === executionIdentity.leaseOwner;
      if (sameExecution && (latest.status === "PAUSED" || latest.status === "CANCELLED") && !latest.stopAcknowledgedAt) {
        return await acknowledgeStop({
          context,
          batchId,
          runId: executionIdentity.runId,
          executionEpoch: executionIdentity.executionEpoch,
          leaseOwner: executionIdentity.leaseOwner,
        }) ?? latest;
      }
      return latest;
    };
    if (await shouldStop()) return finishBeforeExternalWork();

    /** Query scope is resolved before any Worker can navigate. */
    let productMarketPreflightReady = false;
    const initialProductMarketQuery = current.productMarketQueries[0];
    if (initialProductMarketQuery?.status === "pending") {
      let gateCode: string | null = null;
      if (!isSellerSpriteProductMarketBcrEnabled(env)) {
        gateCode = "SELLERSPRITE_PRODUCT_MARKET_BCR_DISABLED";
      } else {
        try {
          const preflight = await preflightProductMarket({ context, authorizedAsins: current.authorizedAsins });
          if (preflight.ready) productMarketPreflightReady = true;
          else gateCode = "SELLERSPRITE_PRODUCT_MARKET_BASE_EVIDENCE_MISSING";
        } catch {
          gateCode = "SELLERSPRITE_PRODUCT_MARKET_BASE_EVIDENCE_PREFLIGHT_UNAVAILABLE";
        }
      }
      if (gateCode) {
        const blockedQuery: BatchCaptureProductMarketQueryUnit = {
          ...initialProductMarketQuery,
          status: "blocked",
          errorCode: gateCode,
          updatedAt: now().toISOString(),
        };
        const blockedRun = refreshDerived({
          ...current,
          version: current.version + 1,
          productMarketQueries: [blockedQuery],
          lastErrorCode: gateCode,
          lastMessage: gateCode === "SELLERSPRITE_PRODUCT_MARKET_BASE_EVIDENCE_MISSING"
            ? "类目查询已阻止：至少一件商品缺少可核验的基础 Evidence。先完成合法商品证据采集，再重新检查；未打开 SellerSprite 页面。"
            : gateCode === "SELLERSPRITE_PRODUCT_MARKET_BCR_DISABLED"
              ? "SellerSprite Product Market 的 BCR 真实来源执行开关默认关闭；查询已保留，未打开浏览器。"
              : "无法核验商品基础 Evidence；为安全起见未打开 SellerSprite 页面。",
          updatedAt: now().toISOString(),
        });
        const written = await casWrite(state.row, blockedRun, state.row.expiresAt);
        if (!written) throw new V5CoreError("BATCH_CAPTURE_CAS_CONFLICT", "Product Market 前置检查状态发生并发变化。", 409, true);
        state = { run: written, row: (await findRow(batchId)) as ReceiptRow };
        current = state.run;
      }
    }

    const keywordMiningEnabled = isSellerSpriteKeywordMiningBcrEnabled(env);
    const initialKeywordMiningQuery = current.keywordMiningQueries[0];
    if (initialKeywordMiningQuery?.status === "pending" && !keywordMiningEnabled) {
      const blockedQuery: BatchCaptureKeywordMiningQueryUnit = {
        ...initialKeywordMiningQuery,
        status: "blocked",
        errorCode: "SELLERSPRITE_KEYWORD_MINING_BCR_DISABLED",
        updatedAt: now().toISOString(),
      };
      const blockedRun = refreshDerived({
        ...current,
        version: current.version + 1,
        keywordMiningQueries: [blockedQuery],
        lastErrorCode: blockedQuery.errorCode,
        lastMessage: "seedKeyword 查询已记录；真实来源执行开关默认关闭，未打开浏览器。",
        updatedAt: now().toISOString(),
      });
      const written = await casWrite(state.row, blockedRun, state.row.expiresAt);
      if (!written) throw new V5CoreError("BATCH_CAPTURE_CAS_CONFLICT", "Keyword Mining 前置检查状态发生并发变化。", 409, true);
      state = { run: written, row: (await findRow(batchId)) as ReceiptRow };
      current = state.run;
    }

    // A control request may arrive while the non-navigating query preflight is
    // in progress. Do not reserve budget or start any page worker afterwards.
    if (await shouldStop()) return finishBeforeExternalWork();

    /**
     * Reserve only for actionable module×ASIN units. Partial grants are allocated
     * in stable module order; no module receives a free navigation when its quota is 0.
     */
    const autoModules = current.allowedModules.filter((module) => isAutoBatchModule(module));
    const reverseAsinEnabled = isSellerSpriteReverseAsinBcrEnabled(env);
    let cells = current.cells.map((cell) => ({ ...cell }));
    let humanGate = false;
    let stopRequested = false;
    /**
     * 本轮「已授权但确认没有打开页面」的 ASIN 单元数（worker 明确返回 skipped_existing / skipped_enriched）。
     * 结算时把这些额度退回：跳过是因为已有合法证据，没有发生导航，不能算作已消耗，
     * 否则同一批已完成模块会被反复计费（线上 114/121 的重复计费来源之一）。
     */
    let moduleNavigationsNotPerformed = 0;
    const moduleNotes: string[] = [];
    let productMarketNavigationPerformed = false;
    let keywordMiningNavigationPerformed = false;
    let anySourceOperationStarted = false;
    if (!reverseAsinEnabled) {
      let limited = 0;
      for (const cell of cells) {
        if (cell.module !== "reverse_asin" || cell.status !== "pending") continue;
        cell.status = "source_input_required";
        cell.lastErrorCode = "SELLERSPRITE_REVERSE_ASIN_BCR_DISABLED";
        cell.updatedAt = now().toISOString();
        limited += 1;
      }
      if (limited > 0) moduleNotes.push(`reverse_asin: 真实来源执行开关关闭，${limited} 个单元保留为来源受限；未打开浏览器。`);
    }
    const activeAutoModules = autoModules.filter((module) => module !== "reverse_asin" || reverseAsinEnabled);
    const plannedAsinsByModule = new Map(activeAutoModules.map((module) => [
      module,
      actionableAsinsForModule(cells, module, effectiveLimit, allowRetry, current.authorizedAsins),
    ]));
    const moduleNavigationDemand = [...plannedAsinsByModule.values()].reduce((sum, asins) => sum + asins.length, 0);
    const productMarketNavigationPlanned = productMarketPreflightReady
      && current.productMarketQueries.some((query) => query.status === "pending");
    const keywordMiningNavigationPlanned = keywordMiningEnabled
      && current.keywordMiningQueries.some((query) => query.status === "pending");
    const wantedNavigations = moduleNavigationDemand
      + (productMarketNavigationPlanned ? 1 : 0)
      + (keywordMiningNavigationPlanned ? 1 : 0);
    const reservation = wantedNavigations > 0
      ? await reserveNavigation(batchId, wantedNavigations)
      : { run: state.run, granted: 0 };
    if (wantedNavigations > 0 && reservation.granted === 0) {
      const blocked = refreshDerived({
        ...reservation.run,
        cells,
        status: "PARTIAL",
        lastErrorCode: "NAVIGATION_BUDGET_EXHAUSTED",
        lastMessage: "导航预算已耗尽，已停止发起新的页面访问；已取得的证据保留。",
        finishedAt: now().toISOString(),
      });
      const blockedRow = (await findRow(batchId)) as ReceiptRow;
      const written = await casWrite(blockedRow, blocked, null);
      if (written) return written;
      throw new V5CoreError("BATCH_CAPTURE_CAS_CONFLICT", "导航预算耗尽后状态写回失败。", 409, true);
    }
    // 预留已推进版本号：刷新行快照，避免后续 CAS 自冲突。
    state = { run: reservation.run, row: (await findRow(batchId)) as ReceiptRow };
    const nowIso = now().toISOString();

    /**
     * 查询级导航额度不足时，必须在**打开任何来源页面之前**阻断：
     * 只拿到部分额度意味着共享预算已耗尽，此时不得让查询单元停留在 pending
     * 上反复重试，也不得为了让它可执行而抬高 limit。
     */
    if (reservation.granted < wantedNavigations
      && (productMarketNavigationPlanned || keywordMiningNavigationPlanned)) {
      const blockedAt = now().toISOString();
      const blockedCode = "SELLERSPRITE_QUERY_NAVIGATION_BUDGET_INSUFFICIENT";
      const blockedProductMarket = productMarketNavigationPlanned
        ? current.productMarketQueries.map((query) => query.status === "pending"
          ? { ...query, status: "blocked" as const, errorCode: blockedCode, updatedAt: blockedAt }
          : query)
        : current.productMarketQueries;
      const blockedKeywordMining = keywordMiningNavigationPlanned
        ? current.keywordMiningQueries.map((query) => query.status === "pending"
          ? { ...query, status: "blocked" as const, errorCode: blockedCode, updatedAt: blockedAt }
          : query)
        : current.keywordMiningQueries;
      moduleNotes.push("查询级导航额度不足：已在打开任何来源页面前阻断，未消耗额外额度。");
      const blockedRun = refreshDerived({
        ...current,
        version: current.version + 1,
        productMarketQueries: blockedProductMarket,
        keywordMiningQueries: blockedKeywordMining,
        lastErrorCode: blockedCode,
        lastMessage: "共享导航预算不足以执行查询级导航，已阻断查询；商品证据采集按已授权额度继续。",
        updatedAt: blockedAt,
      });
      const blockedWritten = await casWrite(state.row, blockedRun, state.row.expiresAt);
      if (!blockedWritten) {
        throw new V5CoreError("BATCH_CAPTURE_CAS_CONFLICT", "查询级导航额度不足时状态写回失败。", 409, true);
      }
      state = { run: blockedWritten, row: (await findRow(batchId)) as ReceiptRow };
      current = state.run;
    }

    let remainingModuleNavigations = Math.min(reservation.granted, moduleNavigationDemand);
    const grantedAsinsByModule = new Map<string, string[]>();
    for (const moduleId of activeAutoModules) {
      const planned = plannedAsinsByModule.get(moduleId) ?? [];
      const grantedForModule = Math.min(planned.length, remainingModuleNavigations);
      grantedAsinsByModule.set(moduleId, planned.slice(0, grantedForModule));
      remainingModuleNavigations -= grantedForModule;
    }

    for (const moduleId of current.allowedModules) {
      if (!isAutoBatchModule(moduleId) || (moduleId === "reverse_asin" && !reverseAsinEnabled)) continue;
      const targetAsins = grantedAsinsByModule.get(moduleId) ?? [];
      if (targetAsins.length === 0) continue;
      if (await shouldStop()) {
        stopRequested = true;
        break;
      }
      const requested = new Set(targetAsins);
      anySourceOperationStarted = true;
      deps.onWorkerCall?.(moduleId, targetAsins);
      try {
        let runner: () => Promise<{ value: unknown; stopped?: boolean }>;
        switch (moduleId) {
          case "amazon_detail":
            runner = () => enrichDetail({
              context, batchId, limit: targetAsins.length, targetAsins, shouldStop,
              idempotencyKey: `${input.idempotencyKey}:${moduleId}`,
            });
            break;
          case "reverse_asin":
            runner = () => runReverseAsin({
                context, batchId, limit: targetAsins.length, targetAsins, shouldStop, env,
                idempotencyKey: `${input.idempotencyKey}:${moduleId}`,
              });
            break;
          case "variation":
            runner = () => enrichVariation({
                  context, batchId, limit: targetAsins.length, targetAsins, shouldStop,
                  idempotencyKey: `${input.idempotencyKey}:${moduleId}`,
                });
            break;
          case "review_voc":
            runner = () => enrichReview({
                  context, batchId, limit: targetAsins.length, targetAsins, shouldStop,
                  idempotencyKey: `${input.idempotencyKey}:${moduleId}`,
                });
            break;
          default:
            throw new V5CoreError("BATCH_CAPTURE_MODULE_DISPATCH_UNSUPPORTED", `自动采集模块 ${moduleId} 没有执行器。`, 409);
        }
        const result = await runner();
        if (moduleId === "reverse_asin" && (result.stopped === true || await shouldStop())) {
          stopRequested = true;
          break;
        }
        const items = Array.isArray((result.value as { items?: EnrichItemLike[] }).items)
          ? ((result.value as { items: EnrichItemLike[] }).items)
          : [];
        /**
         * 只把「worker 明确声明未采集、仅复用既有证据」的授权单元退额为未消耗：
         * detail 的 skipped_enriched / variation·review 的 skipped_existing。
         * 其余情形（空结果、抛错、其它状态）一律仍按已消耗结算——宁可保守，不得伪造剩余额度。
         */
        {
          const skipped = new Set<string>();
          const attempted = new Set<string>();
          for (const item of items) {
            const asin = typeof item.asin === "string" ? item.asin.trim().toUpperCase() : "";
            if (!asin || !requested.has(asin)) continue;
            if (item.status === "skipped_existing" || item.status === "skipped_enriched") skipped.add(asin);
            else attempted.add(asin);
          }
          for (const asin of skipped) if (!attempted.has(asin)) moduleNavigationsNotPerformed += 1;
        }
        if (!items.length) {
          // 空结果：只标记「本轮真正尝试过」的 ASIN，绝不任意把前 N 个商品标记为已尝试。
          let marked = 0;
          for (const cell of cells) {
            if (cell.module === moduleId && requested.has(cell.asin) && cell.status === "pending") {
              cell.status = "failed_retryable";
              cell.attempts += 1;
              cell.lastErrorCode = "ENRICH_EMPTY_RESULT";
              cell.updatedAt = nowIso;
              marked += 1;
            }
          }
          moduleNotes.push(`${moduleId}: 空结果 ${marked} 条（仅标记本轮请求的 ASIN）`);
        } else {
          const applied = applyModuleResults(cells, moduleId, requested, items, nowIso);
          cells = applied.cells;
          if (applied.humanGate) humanGate = true;
          moduleNotes.push(
            `${moduleId}: 推进 ${applied.touchedAsins.size} 商品`
            + (applied.mismatched ? `，拒绝不一致返回 ${applied.mismatched} 条` : ""),
          );
        }
      } catch (error) {
        const explicitErrorCode = error instanceof Error && "code" in error
          ? (error as Error & { code?: unknown }).code
          : null;
        const code = error instanceof V5CoreError
          ? error.code
          : typeof explicitErrorCode === "string" && explicitErrorCode.trim().length > 0
            ? explicitErrorCode
            : "MODULE_EXECUTION_FAILED";
        const message = error instanceof Error ? error.message : "模块执行失败。";
        if (code === "LOCAL_ENVIRONMENT_REQUIRED" || code === "AMAZON_CAPTURE_PREFLIGHT_FAILED" || isHumanErrorCode(code)) {
          humanGate = true;
        }
        let marked = 0;
        const cellStatus: BatchCaptureCellStatus = isHumanErrorCode(code) ? "blocked_human" : "failed_retryable";
        for (const cell of cells) {
          if (cell.module === moduleId && requested.has(cell.asin) && (cell.status === "pending" || cell.status === "failed_retryable")) {
            cell.status = cellStatus;
            cell.attempts += 1;
            cell.lastErrorCode = code;
            cell.updatedAt = nowIso;
            marked += 1;
          }
        }
        moduleNotes.push(`${moduleId}: ${message}`);
          if (cellStatus === "blocked_human") humanGate = true;
      }

      /**
       * 增量持久化：一个模块完成即落库。
       * 之前只在 slice 结束时写一次，导致「详情/变体已成功、评论很慢」时
       * 已完成进度在 UI 上完全不可见（advances 长期为 0）。
       * 这里保持 advances 语义不变（仍在 slice 结束时 +1），只提前保存 cells 与说明。
       */
      const partial = refreshDerived({
        ...state.run,
        cells,
        status: state.run.status === "WAITING" ? "RUNNING" : state.run.status,
        leaseOwner: state.run.leaseOwner,
        leaseExpiresAt: new Date(now().getTime() + LEASE_MS).toISOString(),
        lastErrorCode: humanGate ? "HUMAN_ACTION_REQUIRED" : state.run.lastErrorCode,
        lastMessage: moduleNotes.length ? moduleNotes.join("；") : state.run.lastMessage,
      });
      const partialWritten = await casWrite(
        state.row,
        partial,
        new Date(now().getTime() + LEASE_MS),
      );
      if (!partialWritten) {
        throw new V5CoreError(
          "BATCH_CAPTURE_CAS_CONFLICT",
          "任务状态已被其他操作更新（暂停/中止/新代次或并发执行），本轮结果未写入。",
          409,
          true,
        );
      }
      state = { run: partialWritten, row: (await findRow(batchId)) as ReceiptRow };
      if (humanGate) break;
    }

    if (stopRequested) {
      // The worker has exited after a pause/cancel/supersession signal. Do not run
      // the separate Product Market query or persist this slice's stale snapshot.
      // Conservatively settle the whole reservation because an in-flight worker may
      // already have navigated before observing the stop.
      await settleNavigation(batchId, reservation.granted, anySourceOperationStarted ? reservation.granted : 0);
      let latest = await getRun(batchId);
      // 只有在执行器真正退出循环之后才确认停止并释放租约（pause 与 cancel 同一确认）。
      // 确认必须绑定本次 slice 自己的运行代次 + 执行代次 + 租约所有者。
      if (latest && (latest.status === "PAUSED" || latest.status === "CANCELLED") && !latest.stopAcknowledgedAt) {
        latest = (await acknowledgeStop({
          context,
          batchId,
          runId: current.runId,
          executionEpoch: current.executionEpoch,
          leaseOwner: current.leaseOwner ?? current.lastLeaseOwner,
        })) ?? latest;
      }
      return latest ?? current;
    }

    const productMarketQuery = state.run.productMarketQueries[0];
    if (!humanGate && productMarketNavigationPlanned && productMarketQuery?.status === "pending"
      && reservation.granted >= wantedNavigations && !(await shouldStop())) {
      anySourceOperationStarted = true;
      deps.onWorkerCall?.("sellersprite_product_market", []);
      const shouldStop = async (): Promise<boolean> => {
        const latest = await getRun(batchId);
        return !latest || ["PAUSED", "CANCELLED", "HUMAN_REQUIRED"].includes(latest.status)
          || latest.runId !== executionIdentity.runId || latest.runGeneration !== executionIdentity.runGeneration
          || latest.executionEpoch !== executionIdentity.executionEpoch || latest.leaseOwner !== executionIdentity.leaseOwner;
      };
      let execution: ProductMarketQueryExecution;
      try {
        execution = await runProductMarketQuery({
          context,
          query: { category: productMarketQuery.category, filters: productMarketQuery.filters },
          authorizedAsins: current.authorizedAsins,
          shouldStop,
          env,
        });
      } catch (error) {
        execution = {
          status: isHumanErrorCode(error instanceof V5CoreError ? error.code : null) ? "human_required" : "failed",
          navigationPerformed: true,
          querySubjectKey: null,
          evidenceAttachmentId: null,
          evidenceContentHash: null,
          rowsObserved: 0,
          productAssociations: [],
          errorCode: error instanceof V5CoreError ? error.code : "SELLERSPRITE_PRODUCT_MARKET_QUERY_FAILED",
        };
      }
      productMarketNavigationPerformed = execution.navigationPerformed;
      const validCapture = validProductMarketExecution({ result: execution, query: productMarketQuery, authorizedAsins: current.authorizedAsins });
      const updatedQuery: BatchCaptureProductMarketQueryUnit = validCapture
        ? {
            ...productMarketQuery,
            status: "captured",
            querySubjectKey: execution.querySubjectKey,
            evidenceAttachmentId: execution.evidenceAttachmentId,
            evidenceContentHash: execution.evidenceContentHash,
            rowsObserved: execution.rowsObserved,
            productAssociations: execution.productAssociations,
            errorCode: null,
            updatedAt: now().toISOString(),
          }
        : {
            ...productMarketQuery,
            status: execution.status === "human_required" ? "human_required"
              : execution.status === "blocked" ? "blocked"
                : "failed",
            querySubjectKey: productMarketQuery.querySubjectKey,
            evidenceAttachmentId: null,
            evidenceContentHash: null,
            rowsObserved: 0,
            productAssociations: [],
            errorCode: execution.status === "captured"
              ? "SELLERSPRITE_PRODUCT_MARKET_EVIDENCE_IDENTITY_INVALID"
              : execution.errorCode ?? "SELLERSPRITE_PRODUCT_MARKET_QUERY_FAILED",
            updatedAt: now().toISOString(),
          };
      if (updatedQuery.status === "human_required") humanGate = true;
      moduleNotes.push(validCapture
        ? `sellersprite_product_market: 类目查询已保存 ${updatedQuery.rowsObserved} 条查询级商品行，验证关联 ${updatedQuery.productAssociations.length} 个已授权商品；ASIN×模块单元保持未完成。`
        : `sellersprite_product_market: ${updatedQuery.errorCode ?? "查询未完成"}；未写入商品单元。`);
      const partial = refreshDerived({
        ...state.run,
        productMarketQueries: [updatedQuery],
        status: state.run.status === "WAITING" ? "RUNNING" : state.run.status,
        leaseOwner: state.run.leaseOwner,
        leaseExpiresAt: new Date(now().getTime() + LEASE_MS).toISOString(),
        lastErrorCode: updatedQuery.errorCode,
        lastMessage: moduleNotes.join("；"),
        updatedAt: now().toISOString(),
      });
      const partialWritten = await casWrite(state.row, partial, new Date(now().getTime() + LEASE_MS));
      if (!partialWritten) throw new V5CoreError("BATCH_CAPTURE_CAS_CONFLICT", "Product Market 查询结果已执行但批次版本被其他操作更新，未覆盖新状态。", 409, true);
      state = { run: partialWritten, row: (await findRow(batchId)) as ReceiptRow };
      current = state.run;
    }

    const keywordQuery = state.run.keywordMiningQueries[0];
    if (!humanGate && keywordMiningNavigationPlanned && keywordQuery?.status === "pending"
      && reservation.granted >= wantedNavigations && !(await shouldStop())) {
      anySourceOperationStarted = true;
      deps.onWorkerCall?.("keyword_mining_trend", []);
      const shouldStop = async (): Promise<boolean> => {
        const latest = await getRun(batchId);
        return !latest || ["PAUSED", "CANCELLED", "HUMAN_REQUIRED"].includes(latest.status)
          || latest.runId !== executionIdentity.runId || latest.runGeneration !== executionIdentity.runGeneration
          || latest.executionEpoch !== executionIdentity.executionEpoch || latest.leaseOwner !== executionIdentity.leaseOwner;
      };
      let execution: KeywordMiningQueryExecution;
      try {
        execution = await runKeywordMiningQuery({
          context,
          query: { seedKeyword: keywordQuery.seedKeyword, conditions: keywordQuery.conditions },
          shouldStop,
          env,
        });
      } catch (error) {
        execution = {
          status: isHumanErrorCode(error instanceof V5CoreError ? error.code : null) ? "human_required" : "failed",
          navigationPerformed: false,
          querySubjectKey: null,
          queryFingerprint: null,
          evidenceAttachmentId: null,
          evidenceContentHash: null,
          rowsObserved: 0,
          errorCode: error instanceof V5CoreError ? error.code : "SELLERSPRITE_KEYWORD_MINING_QUERY_FAILED",
        };
      }
      if (execution.stopped || await shouldStop()) {
        await settleNavigation(batchId, reservation.granted, reservation.granted);
        let latest = await getRun(batchId);
        // 查询级 Worker 与 ASIN Worker 遵守同一停止确认规则。
        if (latest && (latest.status === "PAUSED" || latest.status === "CANCELLED") && !latest.stopAcknowledgedAt) {
          latest = (await acknowledgeStop({
            context,
            batchId,
            runId: current.runId,
            executionEpoch: current.executionEpoch,
            leaseOwner: current.leaseOwner ?? current.lastLeaseOwner,
          })) ?? latest;
        }
        return latest ?? current;
      }
      keywordMiningNavigationPerformed = execution.navigationPerformed;
      const validCapture = validKeywordMiningExecution({ result: execution, query: keywordQuery });
      const updatedQuery: BatchCaptureKeywordMiningQueryUnit = validCapture
        ? {
            ...keywordQuery,
            status: "captured",
            querySubjectKey: execution.querySubjectKey,
            queryFingerprint: execution.queryFingerprint,
            evidenceAttachmentId: execution.evidenceAttachmentId,
            evidenceContentHash: execution.evidenceContentHash,
            rowsObserved: execution.rowsObserved,
            errorCode: null,
            updatedAt: now().toISOString(),
          }
        : {
            ...keywordQuery,
            status: execution.status === "human_required" ? "human_required"
              : execution.status === "blocked" ? "blocked"
                : "failed",
            evidenceAttachmentId: null,
            evidenceContentHash: null,
            rowsObserved: 0,
            errorCode: execution.status === "captured"
              ? "SELLERSPRITE_KEYWORD_MINING_EVIDENCE_IDENTITY_INVALID"
              : execution.errorCode ?? "SELLERSPRITE_KEYWORD_MINING_QUERY_FAILED",
            updatedAt: now().toISOString(),
          };
      if (updatedQuery.status === "human_required") humanGate = true;
      moduleNotes.push(validCapture
        ? `keyword_mining_trend: seedKeyword 查询 Evidence 已保存 ${updatedQuery.rowsObserved} 条关键词级结果；未投影到任何 ASIN。`
        : `keyword_mining_trend: ${updatedQuery.errorCode ?? "查询未完成"}；未写入 ASIN 商品单元。`);
      const partial = refreshDerived({
        ...state.run,
        keywordMiningQueries: [updatedQuery],
        status: state.run.status === "WAITING" ? "RUNNING" : state.run.status,
        leaseOwner: state.run.leaseOwner,
        leaseExpiresAt: new Date(now().getTime() + LEASE_MS).toISOString(),
        lastErrorCode: updatedQuery.errorCode,
        lastMessage: moduleNotes.join("；"),
        updatedAt: now().toISOString(),
      });
      const partialWritten = await casWrite(state.row, partial, new Date(now().getTime() + LEASE_MS));
      if (!partialWritten) throw new V5CoreError("BATCH_CAPTURE_CAS_CONFLICT", "Keyword Mining 查询结果已执行但批次版本被其他操作更新，未覆盖新状态。", 409, true);
      state = { run: partialWritten, row: (await findRow(batchId)) as ReceiptRow };
      current = state.run;
    }

    /**
     * 结算导航预算：只把**确有导航证据**的额度计为已用。
     *
     * 1) 模块额度：worker 明确返回 skipped_existing / skipped_enriched 的单元没有打开页面，
     *    退回为未消耗（moduleNavigationsNotPerformed）。这是「已成功模块跳过时不重复占用预算」的唯一实现。
     *    空结果 / 抛错 / 其它状态仍按已消耗 —— 宁可保守，不伪造剩余额度。
     * 2) 查询额度：分配顺序是模块优先、查询在后，因此查询真正拿到额度当且仅当
     *    `granted > moduleNavigationDemand`；只退「拿到但确认没导航」的查询额度。
     *
     * 必须在计算 `next` **之前**执行并刷新 state：否则 `next` 会携带预留态快照，
     * 写回时把结算结果覆盖掉（这正是上一轮 reserved 不归零的根因）。
     */
    const queryNavigationsGranted = Math.max(0, reservation.granted - moduleNavigationDemand);
    const unusedQueryNavigations = Math.min(
      queryNavigationsGranted,
      Number(productMarketNavigationPlanned && !productMarketNavigationPerformed)
        + Number(keywordMiningNavigationPlanned && !keywordMiningNavigationPerformed),
    );
    const reusableModuleNavigations = Math.min(moduleNavigationDemand, moduleNavigationsNotPerformed);
    const navigationUsed = Math.max(
      0,
      reservation.granted - unusedQueryNavigations - reusableModuleNavigations,
    );
    await settleNavigation(batchId, reservation.granted, navigationUsed);
    const settled = await getRun(batchId);
    if (settled) {
      state = { run: settled, row: (await findRow(batchId)) as ReceiptRow };
    }

    // 结算期间也可能收到 pause/cancel，必须以最新控制状态为准；不能再由 cells 推导覆盖。
    // 此处所有已启动的 Worker 与查询均已返回，因此可以绑定当前执行身份确认停止。
    const latestRow = await findRow(batchId);
    const latestRun = mapRow(latestRow);
    if (!latestRow || !latestRun) {
      throw new V5CoreError("BATCH_CAPTURE_RUN_NOT_FOUND", "采集运行记录在片尾结算时消失。", 404);
    }
    const identityStillCurrent = latestRun.runId === executionIdentity.runId
      && latestRun.runGeneration === executionIdentity.runGeneration
      && latestRun.executionEpoch === executionIdentity.executionEpoch
      && latestRun.leaseOwner === executionIdentity.leaseOwner;
    if (!identityStillCurrent) return latestRun;
    if (latestRun.status === "PAUSED" || latestRun.status === "CANCELLED") {
      if (!latestRun.stopAcknowledgedAt) {
        return await acknowledgeStop({
          context,
          batchId,
          runId: executionIdentity.runId,
          executionEpoch: executionIdentity.executionEpoch,
          leaseOwner: executionIdentity.leaseOwner,
        }) ?? latestRun;
      }
      return latestRun;
    }

    /**
     * D2-1H：人工门禁的收尾状态与 derive 语义统一为 HUMAN_REQUIRED——
     * 存在 blocked_human 单元时整个 Run 必须进入「需要人工处理」，
     * 而不是笼统的「已暂停」：前者对用户可解释（缺什么、怎么办），
     * 后者与「用户主动暂停」混淆，也正是「采集中/执行器已退出」矛盾的来源之一。
     * HUMAN_REQUIRED 已在 FINISHED_STATUSES 中：租约释放、代次关闭、finishedAt 一致生效。
     */
    const status = deriveBatchCaptureRunStatus({
      modules: current.allowedModules,
      cells,
    });
    const finalStatus = humanGate && status !== "CANCELLED" ? "HUMAN_REQUIRED" : status;
    const keepLeaseForAutomaticRetry = fromDrive && allowRetry && !humanGate
      && finalStatus === "PARTIAL" && cells.some((cell) => isRetryableCell(cell));
    const clearLease = (FINISHED_STATUSES.includes(finalStatus) || finalStatus === "PAUSED")
      && !keepLeaseForAutomaticRetry;
    const leaseExpiresAtIso = clearLease ? null : new Date(now().getTime() + LEASE_MS).toISOString();
    /**
     * 只有真正终态才关闭执行代次。暂停/中止 **不得** 在此抬高 acknowledgedEpoch：
     * 否则出现「exec==ack 但 stopAcknowledgedAt 为空」——UI 同时显示已退出与未停止，
     * 且重试会绕过「执行器是否确认停止」的保护。暂停的关闭必须由 acknowledgeStop
     * 或人工 recover 完成。
     */
    const closeExecutionEpoch = FINISHED_STATUSES.includes(finalStatus) && !keepLeaseForAutomaticRetry;

    const next = refreshDerived({
      ...state.run,
      cells,
      advances: current.advances + 1,
      driveSlices: fromDrive ? current.driveSlices + 1 : current.driveSlices,
      status: finalStatus,
      leaseOwner: clearLease ? null : state.run.leaseOwner,
      leaseExpiresAt: leaseExpiresAtIso,
      acknowledgedEpoch: closeExecutionEpoch
        ? Math.max(state.run.acknowledgedEpoch, state.run.executionEpoch)
        : state.run.acknowledgedEpoch,
      lastErrorCode: humanGate ? "HUMAN_ACTION_REQUIRED" : null,
      lastMessage: humanGate
        ? "遇到登录/人机或环境门槛，已停止自动推进并标记为需要人工处理；请在专用浏览器完成登录或验证后点击继续，系统会重新检查环境并只推进未完成单元。"
        : moduleNotes.length ? moduleNotes.join("；") : null,
      finishedAt: FINISHED_STATUSES.includes(finalStatus) ? nowIso : null,
    });

    // 持有租约期间写回：保持租约有效并续期；终态或暂停则释放租约。
    const expiresAt = clearLease ? null : new Date(leaseExpiresAtIso as string);
    const written = await casWrite(state.row, next, expiresAt);
    if (!written) {
      throw new V5CoreError(
        "BATCH_CAPTURE_CAS_CONFLICT",
        "任务状态已被其他操作更新（暂停/中止/新代次或并发执行），本轮结果未写入。",
        409,
        true,
      );
    }
    return written;
  }

  async function advance(input: {
    context: AccessContext;
    batchId: unknown;
    maxItemsPerAdvance?: unknown;
    env?: NodeJS.ProcessEnv;
    idempotencyKey?: string;
    leaseOwner?: string;
    allowRetry?: boolean;
  }): Promise<BatchCaptureRun> {
    assertBatchScopeAllowed();
    requireOwner(input.context);
    requireAcquisitionEnabled(input.env);
    const batchId = normalizeBatchId(input.batchId);
    const leaseOwner = input.leaseOwner ?? `advance-${randomUUID()}`;
    const requested = normalizeLimit(input.maxItemsPerAdvance, DEFAULT_MAX_ITEMS_PER_ADVANCE);
    const allowRetry = input.allowRetry === true;

    const state = await acquireLease(batchId, leaseOwner);
    if (state.run.status === "PAUSED") {
      throw new V5CoreError("BATCH_CAPTURE_RUN_PAUSED", "任务已暂停，请先继续。", 409);
    }
    if (state.run.status === "CANCELLED") {
      throw new V5CoreError("BATCH_CAPTURE_RUN_CANCELLED", "任务已中止。", 409);
    }
    if (["COMPLETED", "PARTIAL", "HUMAN_REQUIRED", "FAILED"].includes(state.run.status)) {
      return state.run;
    }
    const idempotencyKey = input.idempotencyKey ?? `batch-capture:${batchId}:${state.run.runId}:${state.run.advances}`;
    const written = await runOneSlice({
      context: input.context,
      batchId,
      state,
      requestedLimit: requested,
      allowRetry,
      idempotencyKey,
      fromDrive: false,
      env: input.env,
    });
    if (FINISHED_STATUSES.includes(written.status)) return written;
    return releaseLease({ run: written, row: (await findRow(batchId)) as ReceiptRow });
  }

  async function drive(input: {
    context: AccessContext;
    batchId: unknown;
    env?: NodeJS.ProcessEnv;
    maxSlices?: number;
    leaseOwner?: string;
    allowRetry?: boolean;
  }): Promise<BatchCaptureRun> {
    assertBatchScopeAllowed();
    requireOwner(input.context);
    requireAcquisitionEnabled(input.env);
    const batchId = normalizeBatchId(input.batchId);
    const leaseOwner = input.leaseOwner ?? `drive-${randomUUID()}`;
    /**
     * 「一次启动 → 自动推进」：drive 默认允许**有界自动重试**。
     *
     * 约束（三步同时成立才重试）：
     *   1. 单元为 failed_retryable 且 attempts < MAX_CELL_AUTO_ATTEMPTS（硬上限，测试覆盖）；
     *   2. 仍受导航预算与来源门禁约束（runOneSlice 内部照常预留/结算）；
     *   3. 上一片必须真的推进过（cell 指纹变化），否则立即停止，不空转、不无限重试。
     *
     * 只有调用方显式传 allowRetry:false 才禁用（例如只想推进一步、或测试并发保护）。
     */
    const allowRetry = input.allowRetry !== false;
    const maxSlices = typeof input.maxSlices === "number" && input.maxSlices >= 1
      ? Math.min(Math.floor(input.maxSlices), 1000)
      : DEFAULT_MAX_DRIVE_SLICES;

    const cellFingerprint = (run: BatchCaptureRun): string =>
      run.cells.map((cell) => `${cell.asin}:${cell.module}:${cell.status}:${cell.attempts}`).join("|");
    /** 是否仍有未达重试上限的可重试失败（只有这类单元才值得继续自动重试）。 */
    const hasRetryableCells = (run: BatchCaptureRun): boolean => run.cells.some((cell) => isRetryableCell(cell));

    const initial = await acquireLease(batchId, leaseOwner, { resumeRetryable: allowRetry });
    if (["PAUSED", "CANCELLED", "COMPLETED", "PARTIAL", "HUMAN_REQUIRED", "FAILED"].includes(initial.run.status)) {
      return initial.run;
    }

    let state = initial;
    for (let slices = 0; slices < maxSlices; slices += 1) {
      /**
       * 终态即结束；唯一例外是「PARTIAL 且仍有未达上限的可重试失败」——
       * 这类单元还能自动恢复，drive 必须继续（否则用户得手动点重试）。
       */
      if (state.run.status === "PARTIAL") {
        if (!allowRetry || !hasRetryableCells(state.run)) return state.run;
      } else if (["PAUSED", "CANCELLED", "COMPLETED", "HUMAN_REQUIRED", "FAILED"].includes(state.run.status)) {
        return state.run;
      }
      if (state.run.driveSlices >= (state.run.maxDriveSlices ?? DEFAULT_MAX_DRIVE_SLICES)) {
        const bounded = await releaseLease(state, {
          lastMessage: "已达本轮有界驱动上限，进度已保留，可再次 drive。",
        });
        return bounded;
      }
      const fingerprintBefore = cellFingerprint(state.run);
      const written = await runOneSlice({
        context: input.context,
        batchId,
        state,
        requestedLimit: state.run.maxItemsPerAdvance,
        allowRetry,
        idempotencyKey: `batch-capture:${batchId}:${state.run.runId}:${state.run.advances}`,
        fromDrive: true,
        env: input.env,
      });
      await deps.onSlice?.(written, slices);
      /**
       * PARTIAL 且仍有可重试失败：说明本轮还有能自动恢复的单元，继续下一片重试，
       * 不把「还有可重试失败」当成结束（这是「需要反复点重试」的根因之一）。
       * 若该片没有任何推进（指纹未变），立即停止，避免退避期空转。
       */
      if (allowRetry && written.status === "PARTIAL" && hasRetryableCells(written)) {
        if (cellFingerprint(written) !== fingerprintBefore) {
          state = { run: written, row: (await findRow(batchId)) as ReceiptRow };
          continue;
        }
        const stalled = await releaseLease({ run: written, row: (await findRow(batchId)) as ReceiptRow }, {
          lastMessage: "仍有达到重试上限前的失败单元，但本轮没有可立即推进的工作（退避或来源门禁）；进度已保存，稍后再次启动会继续。",
        });
        return stalled;
      }
      if (["PAUSED", "CANCELLED", "COMPLETED", "PARTIAL", "HUMAN_REQUIRED", "FAILED"].includes(written.status)) {
        return written;
      }
      state = { run: written, row: (await findRow(batchId)) as ReceiptRow };
    }
    const bounded = await releaseLease(state, {
      lastMessage: `已驱动 ${maxSlices} 片，进度已持久化。`,
    });
    return bounded;
  }

  async function control(input: {
    context: AccessContext;
    batchId: unknown;
    action: "pause" | "resume" | "cancel" | "retry";
  }): Promise<BatchCaptureRun> {
    requireOwner(input.context);
    // 运行范围门禁：pause / cancel 是安全动作，始终允许；resume / retry 会重新驱动执行，必须受限。
    if (input.action === "resume" || input.action === "retry") assertBatchScopeAllowed();
    const batchId = normalizeBatchId(input.batchId);
    let row = await findRow(batchId);
    let current = mapRow(row);
    if (!row || !current) throw new V5CoreError("BATCH_CAPTURE_RUN_NOT_FOUND", "尚未创建批次自动采集任务。", 404);
    assertExpansionUnlocked(current, "修改采集任务状态");
    const timestamp = now().toISOString();

    if (input.action === "pause") {
      if (current.status === "COMPLETED" || current.status === "CANCELLED") return current;
      /**
       * 根因修复：没有在途执行时，暂停**当场成立**。
       *
       * 历史缺陷：暂停请求无条件写入 pauseRequestedAt 并把 stopAcknowledgedAt 置空，
       * 但确认只能由「在途执行器」补写。若此刻根本没有执行器（租约为空且执行代次已关闭——
       * 例如任务刚跑完一片、处于 PARTIAL/HUMAN_REQUIRED/WAITING），这条「等待停止」标记
       * 永远无人确认，于是 resume/retry/新建代次会被这条幽灵标记反复拒绝，
       * 用户只能反复点击同一个按钮。正确做法：把「无在途执行」这一事实当场落库为停止确认。
       */
      const inFlight = hasLiveLease(current) || hasUnresolvedExecution(current);
      if (!inFlight) {
        return persistResultOrThrow(row, {
          ...current,
          version: current.version + 1,
          status: "PAUSED",
          pauseRequestedAt: current.pauseRequestedAt ?? timestamp,
          pauseAcknowledgedAt: timestamp,
          stopAcknowledgedAt: timestamp,
          stopConfirmedBy: "control",
          leaseOwner: null,
          leaseExpiresAt: null,
          lastMessage: "已暂停：暂停时没有在途采集操作，立即生效；已保存的进度与证据不受影响。",
          updatedAt: timestamp,
        }, null);
      }
      /**
       * 事实 A：暂停请求已接收（存在在途执行）。
       * **故意保留运行租约**：若在途 Worker 尚未退出就清空租约，用户立即 resume 会启动
       * 第二个执行器并与旧 Worker 并行。租约将自然到期（LEASE_MS），期间 resume 会被拒绝。
       */
      return persistResultOrThrow(row, {
        ...current,
        version: current.version + 1,
        status: "PAUSED",
        pauseRequestedAt: current.pauseRequestedAt ?? timestamp,
        pauseAcknowledgedAt: null,
        stopAcknowledgedAt: null,
        lastMessage: "已收到暂停请求；正在等待在途采集操作退出。",
        updatedAt: timestamp,
      }, row.expiresAt);
    }
    if (input.action === "cancel") {
      /**
       * 事实 A'：中止请求已接收。
       *
       * 与 pause 同一规则：存在在途执行时**故意保留运行租约**（防止旧 Worker 未退出就新建代次
       * 导致两个执行器并行操作同一来源资源），由执行器或人工确认退出后释放；
       * 没有在途执行时中止当场生效并写入停止确认——否则会留下无人能确认的幽灵停止请求，
       * 使「新建运行代次」被永久拒绝（本批次 944e1e2c 的实际死锁形态）。
       */
      const inFlight = hasLiveLease(current) || hasUnresolvedExecution(current);
      return persistResultOrThrow(row, {
        ...current,
        version: current.version + 1,
        status: "CANCELLED",
        cancelRequestedAt: current.cancelRequestedAt ?? timestamp,
        stopAcknowledgedAt: inFlight ? null : timestamp,
        stopConfirmedBy: inFlight ? null : "control",
        leaseOwner: inFlight ? current.leaseOwner : null,
        leaseExpiresAt: inFlight ? current.leaseExpiresAt : null,
        finishedAt: timestamp,
        acknowledgedEpoch: inFlight
          ? current.acknowledgedEpoch
          : Math.max(current.acknowledgedEpoch, current.executionEpoch),
        lastMessage: inFlight
          ? "已收到中止请求；正在等待在途采集操作退出，期间不会启动新的运行代次。"
          : "已中止：中止时没有在途采集操作，立即生效；已保存的进度与证据不受影响，可重新确认采集计划创建新运行代次。",
        updatedAt: timestamp,
      }, inFlight ? row.expiresAt : null);
    }
    if (input.action === "retry") {
      // 与 UI canRetry 一致：仅 PARTIAL / PAUSED 可直接重试；CANCELLED 需新代次，RUNNING 用 resume。
      if (current.status !== "PARTIAL" && current.status !== "PAUSED") {
        throw new V5CoreError(
          "BATCH_CAPTURE_RETRY_NOT_ALLOWED",
          `当前任务状态为「${BATCH_CAPTURE_RUN_STATUS_LABELS[current.status] ?? current.status}」，不能直接重试。`
          + (current.status === "CANCELLED"
            ? "已中止的任务请重新确认采集计划创建新运行代次。"
            : current.status === "RUNNING" || current.status === "WAITING"
              ? "任务仍在等待/执行中；请使用「继续」或先暂停并确认停止后再重试。"
              : current.status === "HUMAN_REQUIRED"
                ? "存在需要人工处理的单元；请先在专用浏览器完成登录/验证后点击继续。"
                : "请刷新后按当前状态选择正确操作。"),
          409,
          true,
        );
      }
      // 与 start 同一保护：旧执行器未确认退出（含「已请求暂停但无停止确认」）时不得重启。
      assertNoUnresolvedExecution(current, "授权重试");
      // 有界、明确授权的重试：只重置未达尝试上限的 failed_retryable 单元格。
      const cells = current.cells.map((cell) =>
        cell.status === "failed_retryable" && cell.attempts < MAX_CELL_AUTO_ATTEMPTS
          ? { ...cell, status: "pending" as const, lastErrorCode: null, updatedAt: timestamp }
          : { ...cell });
      const recomputed = deriveBatchCaptureRunStatus({ modules: current.allowedModules, cells });
      const next = refreshDerived({
        ...current,
        version: current.version + 1,
        cells,
        retryAuthorized: true,
        status: recomputed === "WAITING" ? "RUNNING" : recomputed,
        // 安全条件已通过：清理旧暂停/中止标记，使新一轮 drive 不被旧请求锁住。
        pauseRequestedAt: null,
        pauseAcknowledgedAt: null,
        cancelRequestedAt: null,
        stopAcknowledgedAt: null,
        stopConfirmedBy: null,
        stopRecoveryReason: null,
        lastErrorCode: null,
        finishedAt: null,
        lastMessage: "已授权有界重试未达上限的可重试失败；旧暂停/中止标记已清理，准备启动执行器。",
        updatedAt: timestamp,
      });
      return persistResultOrThrow(row, next, null);
    }
    if (current.status === "CANCELLED") {
      throw new V5CoreError("BATCH_CAPTURE_RUN_CANCELLED", "已中止的任务不能直接继续，请重新启动新的运行代次。", 409);
    }
    if (input.action === "resume") {
      /**
       * D2-1H：「继续」= 重新检查，不是只改状态。
       *
       * 1) 状态自愈：以持久化 cells 为权威重新推导（修复历史卡在 RUNNING 的
       *    「采集中 + 执行器已退出 + 人工单元未处理」组合状态）；
       * 2) 人工单元检查：存在需要人工处理的单元（登录/验证码门槛）→ 明确拒绝，
       *    不启动执行器；待用户在专用浏览器完成人工处理后重试；
       * 3) 通过才置 RUNNING——由路由层触发执行器重新驱动（drive 内部会重新
       *    预检登录环境与执行资格，并跳过已完成单元，不重复采集）。
       */
      assertResumeSafe(current);
      const derived = deriveBatchCaptureRunStatus({
        modules: current.allowedModules,
        cells: current.cells,
      });
      if (derived !== current.status && derived !== "CANCELLED") {
        const healed = await persistResultOrThrow(row, {
          ...current,
          version: current.version + 1,
          status: derived,
          lastMessage: `状态已按持久化单元重新校准为「${BATCH_CAPTURE_RUN_STATUS_LABELS[derived] ?? derived}」。`,
          updatedAt: timestamp,
        }, row.expiresAt);
        current = healed;
        row = (await findRow(batchId)) as ReceiptRow;
      }
      if (current.status === "HUMAN_REQUIRED") {
        const humanCells = current.cells.filter((cell) => cell.status === "blocked_human");
        const humanCodes = [...new Set(humanCells
          .map((cell) => cell.lastErrorCode)
          .filter((code): code is string => typeof code === "string" && code.length > 0))];
        const blockedSummary = `存在 ${humanCells.length} 个需要人工处理的单元`
          + `（${humanCodes.length > 0 ? humanCodes.join("、") : "登录 / 验证码门槛"}）`;
        /**
         * D2-1H：人工门槛不是死锁——「继续」时真实复查 Amazon 登录环境
         * （readiness 级，会启动真实浏览器验证），而非只读任务状态：
         * - 环境已恢复 → 仅重置 blocked_human 单元为 pending（保留 attempts 计数，
         *   已完成/已有证据单元一律不动），随后进入下方统一 RUNNING 分支，
         *   由执行器重新预检资格并跳过已完成单元，不重复采集；
         * - 环境未恢复 → 明确阻断并说明真实原因，不启动执行器；
         * - 未装配复查能力（测试/无 Amazon 通道）→ 保守拒绝，绝不盲目放行。
         */
        if (humanCells.length > 0 && deps.checkSessionReadiness) {
          const readiness = await deps.checkSessionReadiness({ context: input.context });
          if (!readiness.ok || !readiness.sessionReady) {
            const reason = readiness.message
              || (readiness.errorCode ? `（${readiness.errorCode}）` : "")
              || "登录环境检查未通过";
            throw new V5CoreError(
              "BATCH_CAPTURE_HUMAN_REQUIRED",
              `${blockedSummary}；已重新检查登录环境但仍未恢复：${reason}`
              + "请先在专用浏览器中完成登录或人工验证，然后再点击继续；未处理前系统不会启动执行器。",
              409,
              true,
            );
          }
          const resetCells = current.cells.map((cell) => cell.status === "blocked_human"
            ? { ...cell, status: "pending" as const, lastErrorCode: null, updatedAt: timestamp }
            : cell);
          return persistResultOrThrow(row, {
            ...current,
            version: current.version + 1,
            cells: resetCells,
            status: "RUNNING",
            lastErrorCode: null,
            pauseRequestedAt: null,
            pauseAcknowledgedAt: null,
            cancelRequestedAt: null,
            stopAcknowledgedAt: null,
            stopConfirmedBy: null,
            stopRecoveryReason: null,
            lastMessage: "登录环境已恢复；需要人工处理的单元已合法重置，执行器将重新检查执行资格后推进剩余单元。",
            updatedAt: timestamp,
          }, null);
        }
        throw new V5CoreError(
          "BATCH_CAPTURE_HUMAN_REQUIRED",
          `${blockedSummary}：`
          + "请先在专用浏览器中完成登录或人工验证，然后再点击继续；未处理前系统不会启动执行器。",
          409,
          true,
        );
      }
      /**
       * 已收口且**没有可推进单元**时不再强制写成 RUNNING。
       *
       * 历史缺陷：这里无条件把状态改成 RUNNING，再由路由触发执行器；
       * 但当单元矩阵没有 pending、failed 也都达到重试上限时，执行器读取到 PARTIAL
       * 会拒绝启动，于是持久化状态停在「RUNNING + 无执行器」，
       * 后续追加预算 / 恢复 / 新建代次全部被「任务仍在执行」挡住，用户只能反复点继续。
       * 正确做法：没有可推进的工作时保持已校准的终态，明确告知下一步操作。
       *
       * 若仍有 pending 或未达重试上限的失败单元（可由 drive 的 allowRetry 推进），
       * 继续走下面的 RUNNING 分支，交由执行器处理。
       */
      const hasActionable = current.cells.some((cell) => cell.status === "pending"
        || (cell.status === "failed_retryable" && cell.attempts < MAX_CELL_AUTO_ATTEMPTS));
      if (!hasActionable && (current.status === "PARTIAL" || current.status === "COMPLETED")) {
        return persistResultOrThrow(row, {
          ...current,
          version: current.version + 1,
          lastErrorCode: null,
          pauseRequestedAt: null,
          pauseAcknowledgedAt: null,
          cancelRequestedAt: null,
          stopAcknowledgedAt: null,
          stopConfirmedBy: null,
          stopRecoveryReason: null,
          lastMessage: current.status === "COMPLETED"
            ? "任务已完成，没有需要继续的单元。"
            : "任务已部分完成且当前没有可推进的单元（无 pending；失败单元均已达到重试上限）；如需补采请使用「重试可重试失败」或重新确认计划。",
          updatedAt: timestamp,
        }, null);
      }
      return persistResultOrThrow(row, {
        ...current,
        version: current.version + 1,
        status: "RUNNING",
        lastErrorCode: null,
        pauseRequestedAt: null,
        pauseAcknowledgedAt: null,
        cancelRequestedAt: null,
        stopAcknowledgedAt: null,
        stopConfirmedBy: null,
        stopRecoveryReason: null,
        lastMessage: "已继续；执行器将重新检查登录环境与执行资格后推进剩余单元。",
        updatedAt: timestamp,
      }, null);
    }

    // pause / cancel / retry 均已提前 return；resume 已覆盖其余路径。此兜底防御未来新增 action 漏分支。
    throw new V5CoreError("BATCH_CAPTURE_INVALID_ACTION", "不支持的任务操作。", 400);
  }

  /**
   * 事实 B/B'：执行器确认「已停止领取新工作、在途操作已退出」。
   *
   * 绑定要求（防止普通 API 调用伪造退出证明）：
   * - `runId` 必须等于当前运行（旧代次的确认不能作用于新代次）；
   * - `executionEpoch` 必须等于当前执行代次（旧执行的确认不能关闭新执行）；
   * - `leaseOwner` 必须等于当前或最近一次租约持有者（只有持有者知道该令牌）。
   */
  async function acknowledgeStop(input: {
    context: AccessContext;
    batchId: unknown;
    runId?: unknown;
    executionEpoch?: unknown;
    leaseOwner?: unknown;
  }): Promise<BatchCaptureRun | null> {
    requireOwner(input.context);
    const batchId = normalizeBatchId(input.batchId);
    const row = await findRow(batchId);
    const current = mapRow(row);
    if (!row || !current) return null;

    const suppliedRunId = typeof input.runId === "string" && input.runId.trim() ? input.runId.trim() : null;
    const suppliedEpoch = Number.isSafeInteger(input.executionEpoch) ? Number(input.executionEpoch) : null;
    const suppliedOwner = typeof input.leaseOwner === "string" && input.leaseOwner.trim() ? input.leaseOwner.trim() : null;
    const ownerMatches = suppliedOwner !== null
      && (suppliedOwner === current.leaseOwner || suppliedOwner === current.lastLeaseOwner);
    const bindingValid = suppliedRunId !== null && suppliedEpoch !== null && ownerMatches
      && suppliedRunId === current.runId && suppliedEpoch === current.executionEpoch;

    /**
     * 绑定不成立时**不得关闭执行代次**（否则普通 API 调用可以伪造「执行器已退出」）。
     * 只有在当前不存在任何未关闭执行时，才允许仅写入 UI 事实 B（不影响安全判定）。
     */
    if (!bindingValid) {
      if (hasOpenExecution(current)) return current;
      if (current.stopAcknowledgedAt) return current;
      if (current.status !== "PAUSED" && current.status !== "CANCELLED") return current;
      const uiOnlyTimestamp = now().toISOString();
      return persistResultOrThrow(row, {
        ...current,
        version: current.version + 1,
        stopAcknowledgedAt: uiOnlyTimestamp,
        ...(current.status === "PAUSED" ? { pauseAcknowledgedAt: uiOnlyTimestamp } : {}),
        lastMessage: current.status === "CANCELLED"
          ? "在途采集操作已退出，已中止。"
          : "在途采集操作已退出，已暂停。",
        updatedAt: uiOnlyTimestamp,
      }, null);
    }

    if (current.status !== "PAUSED" && current.status !== "CANCELLED") {
      // 终态（正常结束）也允许关闭该执行代次，但不改动停止语义字段。
      if (current.acknowledgedEpoch >= current.executionEpoch) return current;
      const closedAt = now().toISOString();
      return persistResultOrThrow(row, {
        ...current,
        version: current.version + 1,
        acknowledgedEpoch: current.executionEpoch,
        stopConfirmedBy: "executor",
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: closedAt,
      }, null);
    }
    if (current.acknowledgedEpoch >= current.executionEpoch && current.stopAcknowledgedAt) return current;
    const timestamp = now().toISOString();
    return persistResultOrThrow(row, {
      ...current,
      version: current.version + 1,
      stopAcknowledgedAt: timestamp,
      stopConfirmedBy: "executor",
      acknowledgedEpoch: current.executionEpoch,
      ...(current.status === "PAUSED" ? { pauseAcknowledgedAt: timestamp } : {}),
      // 确认停止后才安全释放租约（事实 C）。
      leaseOwner: null,
      leaseExpiresAt: null,
      lastMessage: current.status === "CANCELLED"
        ? "在途采集操作已退出，已中止。"
        : "在途采集操作已退出，已暂停。",
      updatedAt: timestamp,
    }, null);
  }

  /**
   * 人工确认恢复：旧进程异常退出、没有可靠停止回执时的唯一人工入口。
   *
   * 安全约束：
   * - 必须提供当前运行的 `runId` + `runGeneration` + `executionEpoch` 精确匹配，
   *   任何一项不符一律拒绝（防止确认被用于其他代次）；
   * - 必须给出非空 `reason`（可观察的恢复原因），并记录 `stopConfirmedBy="operator"`；
   * - 只关闭执行代次与租约，**不删除任何已合法保存的 Evidence、不改动 cells 与预算**。
   *
   * 这是人工入口，不是「一键清空租约」：调用方必须先核对旧采集进程确实不再存活。
   */
  async function recoverStalledExecution(input: {
    context: AccessContext;
    batchId: unknown;
    runId: unknown;
    runGeneration: unknown;
    executionEpoch: unknown;
    reason: unknown;
  }): Promise<BatchCaptureRun> {
    requireOwner(input.context);
    const batchId = normalizeBatchId(input.batchId);
    const row = await findRow(batchId);
    const current = mapRow(row);
    if (!row || !current) throw new V5CoreError("BATCH_CAPTURE_RUN_NOT_FOUND", "尚未创建批次自动采集任务。", 404);

    const runId = typeof input.runId === "string" && input.runId.trim() ? input.runId.trim() : null;
    const runGeneration = Number.isSafeInteger(input.runGeneration) ? Number(input.runGeneration) : null;
    const executionEpoch = Number.isSafeInteger(input.executionEpoch) ? Number(input.executionEpoch) : null;
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (reason.length < 8 || reason.length > 400) {
      throw new V5CoreError("BATCH_CAPTURE_RECOVERY_REASON_REQUIRED", "人工确认恢复必须给出 8–400 字的核对原因。", 400);
    }
    if (runId !== current.runId || runGeneration !== current.runGeneration || executionEpoch !== current.executionEpoch) {
      throw new V5CoreError(
        "BATCH_CAPTURE_STOP_CONFIRMATION_STALE",
        "确认身份与当前运行不一致（runId / 运行代次 / 执行代次必须精确匹配）；已拒绝，未改动任何状态。",
        409,
        true,
      );
    }
    if (!hasOpenExecution(current)) {
      /**
       * 没有未确认退出的执行器时，唯一还能恢复的是「失效代次遗留的预算预留」：
       * 旧执行器在 slice 中途被杀 → `reserveNavigation` 已把额度从 remaining 扣走，
       * 但 `settleNavigation` 永远不会再执行，`reserved` 就被永久占用，
       * 使剩余单元再也拿不到预算（批次 1607279a 实测遗留 10 次）。
       *
       * 只有在**确认没有有效租约**时才允许清理；仍在持有租约的执行器其预留不得被动。
       */
      if (current.navigationBudget.reserved <= 0) {
        throw new V5CoreError("BATCH_CAPTURE_RECOVERY_NOT_REQUIRED", "当前没有未确认退出的执行器，也没有遗留的预算预留，无需人工确认。", 409);
      }
    }
    /**
     * 活跃租约 = 可能仍在执行的执行器。此时既不能确认代次、也不能清预留：
     * 清掉它的 reserved 会让它在结算时把额度「减成负数」，并可能让并发 slice 突破上限。
     * 必须先等租约自然过期（或由执行器自己确认退出）。
     */
    if (hasLiveLease(current)) {
      throw new V5CoreError(
        "BATCH_CAPTURE_RECOVERY_LEASE_ACTIVE",
        "该运行仍持有有效的执行租约，说明执行器可能仍在运行；请等待其自行确认退出或租约到期后再恢复。",
        409,
        true,
      );
    }
    const openExecution = hasOpenExecution(current);
    const releasedReserved = Math.max(0, current.navigationBudget.reserved);
    const timestamp = now().toISOString();
    return persistResultOrThrow(row, {
      ...current,
      version: current.version + 1,
      // 只有确实存在未确认代次时才推进 acknowledgedEpoch；单纯清理预留不应伪造代次确认。
      ...(openExecution ? { acknowledgedEpoch: Math.max(current.acknowledgedEpoch, current.executionEpoch) } : {}),
      ...(releasedReserved > 0
        ? {
            navigationBudget: {
              ...current.navigationBudget,
              reserved: 0,
              updatedAt: timestamp,
            },
          }
        : {}),
      stopConfirmedBy: "operator",
      stopRecoveryReason: reason,
      stopAcknowledgedAt: current.stopAcknowledgedAt ?? timestamp,
      ...(current.status === "PAUSED" ? { pauseAcknowledgedAt: current.pauseAcknowledgedAt ?? timestamp } : {}),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastMessage: openExecution
        ? `已人工确认执行器状态并解除阻塞（原因：${reason}）；已合法保存的证据保持不变。`
          + (releasedReserved > 0 ? `同时清理了失效执行代次遗留的 ${releasedReserved} 次导航预算预留。` : "")
        : `已清理失效执行代次遗留的 ${releasedReserved} 次导航预算预留（原因：${reason}）；未改动任何单元状态与证据。`,
      updatedAt: timestamp,
    }, null);
  }

  /** 兼容旧调用名；语义已扩展为 pause + cancel 的统一停止确认。 */
  const acknowledgePause = acknowledgeStop;

  /**
   * 执行尝试被阻塞的持久化回执（fail-soft）。
   *
   * 为什么需要：异步执行器在后台驱动 run 时，环境门禁 / 前置校验等早期失败
   * 只会进入进程日志，run 本身保持原状——用户与刷新后的系统都无法知道
   * 「为什么没有被推进」（历史缺陷：界面显示「等待启动」永远不变、无原因）。
   * 本方法把这类失败以 run 级回执（lastErrorCode / lastMessage）持久化，
   * 供 UI 如实展示原因与下一步。
   *
   * 边界：
   * - 只写 runId 匹配且未处于终态（CANCELLED/COMPLETED/FAILED）的当前代次；
   * - **不改变**运行状态、执行代次、租约、单元矩阵与任何授权字段；
   * - CAS 失败（并发更新）静默放弃——回执是辅助信息，绝不覆盖主状态写入。
   */
  async function noteExecutionBlocked(input: {
    context: AccessContext;
    batchId: unknown;
    runId?: unknown;
    code: unknown;
    message?: unknown;
  }): Promise<BatchCaptureRun | null> {
    requireOwner(input.context);
    const batchId = normalizeBatchId(input.batchId);
    const code = typeof input.code === "string" && input.code.trim() ? input.code.trim() : null;
    if (!code) return null;
    const suppliedMessage = typeof input.message === "string" && input.message.trim() ? input.message.trim() : null;
    const message = suppliedMessage ?? DEFAULT_BLOCKED_MESSAGES[code]
      ?? `执行未能推进（${code}）；任务与已保存的状态保持不变，可稍后重试。`;
    const row = await findRow(batchId).catch(() => null);
    const current = mapRow(row);
    if (!row || !current) return null;
    if (typeof input.runId === "string" && input.runId.trim() && input.runId.trim() !== current.runId) return null;
    if (current.status === "CANCELLED" || current.status === "COMPLETED" || current.status === "FAILED") return null;
    const timestamp = now().toISOString();
    return casWrite(row, {
      ...current,
      version: current.version + 1,
      lastErrorCode: code,
      lastMessage: message,
      updatedAt: timestamp,
    }, row.expiresAt).catch(() => null);
  }

  async function status(input: { context: AccessContext; batchId: unknown }): Promise<BatchCaptureRun | null> {
    requireOwner(input.context);
    return getRun(normalizeBatchId(input.batchId));
  }

  /** 列出该批次的全部运行代次（当前 + 归档），用于独立审计，不建立第二套事实库。 */
  async function listRuns(input: { context: AccessContext; batchId: unknown }): Promise<BatchCaptureRun[]> {
    requireOwner(input.context);
    const batchId = normalizeBatchId(input.batchId);
    const rows = (await table.findMany({
      where: { actorScope: RESOURCE_SCOPE, operation: OPERATION, resourceKey: batchId },
      orderBy: { createdAt: "asc" },
    })) as ReceiptRow[];
    return rows
      .flatMap((row) => {
        const run = mapRow(row);
        return run ? [run] : [];
      })
      .sort((a, b) => a.runGeneration - b.runGeneration);
  }

  return {
    start,
    reserveExpansion,
    releaseExpansion,
    startExpansion,
    authorizeNavigationTopUp,
    prepareProductMarketQuery,
    prepareKeywordMiningQuery,
    advance,
    drive,
    control,
    status,
    listRuns,
    getRun,
    acknowledgePause,
    acknowledgeStop,
    recoverStalledExecution,
    noteExecutionBlocked,
  };
}

export type BatchCaptureRunService = ReturnType<typeof createBatchCaptureRunService>;
