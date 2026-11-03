import "server-only";

import { randomUUID } from "node:crypto";
import type { AccessContext } from "@/lib/server/accessPassword";
import { V5CoreError, requireIdempotencyKey, withV5Receipt } from "@/lib/server/v5CoreCommon";
import { getProductBatchStore } from "@/lib/server/productBatchStoreResolver";
import { enrichBatchWithAmazonDetail } from "@/lib/server/batchDetailEnrichmentService";
import { enrichBatchWithReviewVoc } from "@/lib/server/batchReviewVocEnrichmentService";
import { enrichBatchWithVariation } from "@/lib/server/batchVariationEnrichmentService";
import { collectAmazonSearchWithPlaywright } from "@/lib/server/captureRecipeBrowser";
import { V3_MODULE_IDS, type V3ModuleId } from "@/lib/sourceLayer/v3ModuleEvidence";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { sourceLayerOperator } from "@/lib/sourceLayer/server/sourceLayerService";
import { readProductBatchDetailEnrichment } from "@/lib/sourceLayer/moduleStatusPresentation";

const OPERATION = "source-layer:capture-capability-orchestrator:v2";
const MAX_ITEMS_PER_RUN = 30;
const ASIN_PATTERN = /^[A-Za-z0-9]{10}$/u;

export type OrchestratorItemOutcome = {
  module: V3ModuleId;
  asin: string | null;
  traceId: string;
  durationMs: number;
  outcome: string;
  status: string;
  errorCode: string | null;
  message: string;
  evidenceId: string | null;
  contentHash: string | null;
};

export type OrchestratorModuleResult = {
  module: V3ModuleId;
  requested: number;
  processed: number;
  status: string;
  errorCode: string | null;
  message: string;
  traceId: string;
  durationMs: number;
  items: OrchestratorItemOutcome[];
};

export type CaptureCapabilityOrchestrationResult = {
  batchId: string;
  targetAsin: string | null;
  modules: OrchestratorModuleResult[];
  summary: {
    requestedModules: number;
    completedModules: number;
    limitedModules: number;
    failedModules: number;
    processedItems: number;
  };
};

const AMAZON_SESSION_MODULES: ReadonlySet<V3ModuleId> = new Set([
  "amazon_detail",
  "amazon_search_market",
  "variation",
  "review_voc",
]);

export async function runModulesIndependently<TModule extends string, TResult>(input: {
  modules: readonly TModule[];
  run(module: TModule): Promise<TResult>;
  onError(module: TModule, error: unknown): TResult;
  sourceGate?: {
    moduleIds: ReadonlySet<TModule>;
    isGateResult(value: TResult): boolean;
    createNotAttempted(module: TModule): TResult;
  };
}): Promise<Array<{ module: TModule; value: TResult }>> {
  const results: Array<{ module: TModule; value: TResult }> = [];
  let sourcePaused = false;
  for (const moduleId of input.modules) {
    if (sourcePaused && input.sourceGate?.moduleIds.has(moduleId)) {
      results.push({ module: moduleId, value: input.sourceGate.createNotAttempted(moduleId) });
      continue;
    }
    let value: TResult;
    try {
      value = await input.run(moduleId);
    } catch (error) {
      value = input.onError(moduleId, error);
    }
    results.push({ module: moduleId, value });
    if (input.sourceGate?.moduleIds.has(moduleId) && input.sourceGate.isGateResult(value)) sourcePaused = true;
  }
  return results;
}

function isAmazonHumanGate(result: OrchestratorModuleResult): boolean {
  return result.status === "human_action_required"
    || result.status === "login_required"
    || result.items.some((item) => /CAPTCHA|LOGIN_REQUIRED|HUMAN_ACTION_REQUIRED|HUMAN_GATE_PAUSE/iu.test(item.errorCode ?? ""));
}

function notAttemptedAfterAmazonGate(moduleId: V3ModuleId, targetAsin: string | null, limit: number): OrchestratorModuleResult {
  const traceId = `capture-v2-${randomUUID()}`;
  const startedAt = Date.now();
  const item = itemOutcome({
    module: moduleId,
    asin: targetAsin,
    traceId,
    startedAt,
    outcome: "NOT_ATTEMPTED",
    status: "not_attempted",
    errorCode: "HUMAN_GATE_PAUSE",
    message: "本轮较早的 Amazon 模块遇到登录或验证码门禁，后续 Amazon 页面导航已暂停。完成人工处理后可单独重试；其他来源继续执行。",
  });
  return moduleResult({
    module: moduleId,
    requested: targetAsin ? 1 : limit,
    traceId,
    startedAt,
    status: "not_attempted",
    errorCode: item.errorCode,
    message: item.message,
    items: [item],
  });
}

function normalizeBatchId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{10,64}$/u.test(value.trim())) {
    throw new V5CoreError("BATCH_ID_INVALID", "batchId 必须是有效的批次 ID。", 400);
  }
  return value.trim();
}

function normalizeTargetAsin(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !ASIN_PATTERN.test(value.trim())) {
    throw new V5CoreError("TARGET_ASIN_INVALID", "targetAsin 必须是 10 位字母数字 ASIN。", 400);
  }
  return value.trim().toUpperCase();
}

function normalizeModules(value: unknown): V3ModuleId[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > V3_MODULE_IDS.length) {
    throw new V5CoreError("MODULES_INVALID", "modules 必须包含 1-8 个正式 V3 模块。", 400);
  }
  const modules = [...new Set(value.filter((item): item is V3ModuleId =>
    typeof item === "string" && V3_MODULE_IDS.includes(item as V3ModuleId),
  ))];
  if (modules.length !== value.length) throw new V5CoreError("MODULES_INVALID", "modules 中包含无效或重复模块。", 400);
  return modules;
}

export function summarizeOutcome(status: string): "completed" | "limited" | "failed" {
  if (["complete", "completed", "captured_partial", "no_data_with_evidence", "skipped_existing", "skipped_enriched"].includes(status)) return "completed";
  if (["partial", "source_input_required", "human_action_required", "login_required", "extension_required", "plan_limited", "not_attempted", "blocked_with_evidence", "failed_human"].includes(status)) return "limited";
  return "failed";
}

function itemOutcome(input: {
  module: V3ModuleId;
  asin: string | null;
  traceId: string;
  startedAt: number;
  outcome: string;
  status: string;
  errorCode?: string | null;
  message: string;
  evidenceId?: string | null;
  contentHash?: string | null;
}): OrchestratorItemOutcome {
  return {
    module: input.module,
    asin: input.asin,
    traceId: input.traceId,
    durationMs: Math.max(0, Date.now() - input.startedAt),
    outcome: input.outcome,
    status: input.status,
    errorCode: input.errorCode ?? null,
    message: input.message,
    evidenceId: input.evidenceId ?? null,
    contentHash: input.contentHash ?? null,
  };
}

async function detailContentHash(batchId: string, context: AccessContext, asin: string, evidenceId: string | null): Promise<string | null> {
  if (!evidenceId) return null;
  const item = (await getProductBatchStore(context).getBatchItems(batchId)).find((row) => row.asin?.trim().toUpperCase() === asin);
  if (!item) return null;
  const enrichment = readProductBatchDetailEnrichment(item.normalizedProductJson);
  return enrichment?.evidenceId === evidenceId ? enrichment.contentHash : null;
}

function moduleResult(input: {
  module: V3ModuleId;
  requested: number;
  traceId: string;
  startedAt: number;
  status: string;
  errorCode?: string | null;
  message: string;
  items?: OrchestratorItemOutcome[];
}): OrchestratorModuleResult {
  return {
    module: input.module,
    requested: input.requested,
    processed: (input.items ?? []).filter((item) => !["skipped_existing", "skipped_enriched", "not_attempted"].includes(item.status)).length,
    status: input.status,
    errorCode: input.errorCode ?? null,
    message: input.message,
    traceId: input.traceId,
    durationMs: Math.max(0, Date.now() - input.startedAt),
    items: input.items ?? [],
  };
}

function inputRequiredResult(module: V3ModuleId, asin: string | null, traceId: string, startedAt: number): OrchestratorModuleResult {
  const sellerSpriteModules: V3ModuleId[] = ["sellersprite_product_market", "reverse_asin", "keyword_mining_trend"];
  if (sellerSpriteModules.includes(module)) {
    const item = itemOutcome({
      module, asin, traceId, startedAt,
      outcome: "HUMAN_ACTION_REQUIRED",
      status: "human_action_required",
      errorCode: "BROWSER_USE_CONNECTION_UNAVAILABLE",
      message: "本机 SellerSprite 浏览器会话尚未连接，暂时无法读取页面。连接已登录的 SellerSprite 浏览器后可重试；账号套餐权限尚未核实。",
    });
    return moduleResult({ module, requested: 1, traceId, startedAt, status: item.status, errorCode: item.errorCode, message: item.message, items: [item] });
  }
  const message = module === "historical_trend"
    ? "此模块需要 SellerSprite 历史导出或用户自带 Keepa CSV/XLSX；当前没有可验证的导入文件。"
    : module === "amazon_search_market"
      ? "市场搜索按批次原始搜索词采集，不能按单个 ASIN 重跑。请在批次级触发，或检查原搜索词是否存在。"
      : "此模块需要已验证的专属来源输入；当前没有可安全自动执行的来源。";
  const item = itemOutcome({
    module, asin, traceId, startedAt,
    outcome: "SOURCE_INPUT_REQUIRED",
    status: "source_input_required",
    errorCode: module === "historical_trend" ? "TREND_EXPORT_REQUIRED" : "MODULE_SOURCE_INPUT_REQUIRED",
    message,
  });
  return moduleResult({ module, requested: 1, traceId, startedAt, status: item.status, errorCode: item.errorCode, message, items: [item] });
}

async function executeModule(input: {
  context: AccessContext;
  batchId: string;
  batchQuery: string | null;
  module: V3ModuleId;
  targetAsin: string | null;
  limit: number;
  idempotencyKey: string;
}): Promise<OrchestratorModuleResult> {
  const startedAt = Date.now();
  const traceId = `capture-v2-${randomUUID()}`;
  if (["amazon_detail", "variation", "review_voc"].includes(input.module)) {
    if (!input.targetAsin && input.module === "amazon_detail") {
      const result = await enrichBatchWithAmazonDetail({
        context: input.context, batchId: input.batchId, limit: input.limit,
        idempotencyKey: `${input.idempotencyKey}:detail`,
      });
      const items = await Promise.all(result.value.items.map(async (item) => itemOutcome({
        module: input.module,
        asin: item.asin,
        traceId,
        startedAt,
        outcome: item.status.toUpperCase(),
        status: item.status,
        errorCode: item.errorCode,
        message: item.errorCode ? "详情采集未完成；可根据失败状态重试。" : "详情处理已返回商品级结果。",
        evidenceId: item.evidenceId,
        contentHash: await detailContentHash(input.batchId, input.context, item.asin, item.evidenceId),
      })));
      const status = items.some((item) => item.status.startsWith("failed")) ? "partial" : "completed";
      return moduleResult({ module: input.module, requested: result.value.items.length, traceId, startedAt, status, message: "Detail 模块独立完成本轮处理。", items });
    }
    if (!input.targetAsin) {
      const worker = input.module === "variation" ? enrichBatchWithVariation : enrichBatchWithReviewVoc;
      const result = await worker({
        context: input.context, batchId: input.batchId, limit: input.limit,
        idempotencyKey: `${input.idempotencyKey}:${input.module}`,
      });
      const items = result.value.items.map((item) => itemOutcome({
        module: input.module,
        asin: item.asin,
        traceId: item.traceId,
        startedAt,
        outcome: item.status.toUpperCase(),
        status: item.status,
        errorCode: item.errorCode,
        message: item.limitation ?? "模块已返回商品级结果。",
        evidenceId: item.evidenceId,
        contentHash: item.contentHash,
      }));
      const status = items.some((item) => item.status === "failed_human") ? "human_action_required"
        : items.some((item) => item.status === "failed_retryable" || item.status === "failed_permanent") ? "partial"
          : "completed";
      return moduleResult({ module: input.module, requested: result.value.summary.requested, traceId, startedAt, status, message: `${input.module} 模块独立完成本轮处理。`, items });
    }
    if (input.module === "amazon_detail") {
      const result = await enrichBatchWithAmazonDetail({
        context: input.context, batchId: input.batchId, limit: 1, targetAsin: input.targetAsin, forceRecapture: true,
        idempotencyKey: `${input.idempotencyKey}:detail:${input.targetAsin}`,
      });
      const items = await Promise.all(result.value.items.map(async (item) => itemOutcome({
        module: input.module, asin: item.asin, traceId, startedAt,
        outcome: item.status.toUpperCase(), status: item.status, errorCode: item.errorCode,
        message: item.errorCode ? "详情重采未完成；请查看限制说明。" : "已重采并更新详情证据。",
        evidenceId: item.evidenceId,
        contentHash: await detailContentHash(input.batchId, input.context, item.asin, item.evidenceId),
      })));
      return moduleResult({ module: input.module, requested: 1, traceId, startedAt, status: items[0]?.status ?? "failed_retryable", message: "Detail 单 ASIN 重采已返回。", items });
    }
    const result = input.module === "variation"
      ? await enrichBatchWithVariation({
          context: input.context, batchId: input.batchId, limit: 1, targetAsin: input.targetAsin, forceRecapture: true,
          idempotencyKey: `${input.idempotencyKey}:variation:${input.targetAsin}`,
        })
      : await enrichBatchWithReviewVoc({
          context: input.context, batchId: input.batchId, limit: 1, targetAsin: input.targetAsin, forceRecapture: true,
          idempotencyKey: `${input.idempotencyKey}:review:${input.targetAsin}`,
        });
    const items = result.value.items.map((item) => itemOutcome({
      module: input.module, asin: item.asin, traceId: item.traceId, startedAt,
      outcome: item.status.toUpperCase(), status: item.status, errorCode: item.errorCode,
      message: item.limitation ?? "模块已返回商品级重采结果。", evidenceId: item.evidenceId, contentHash: item.contentHash,
    }));
    return moduleResult({ module: input.module, requested: 1, traceId, startedAt, status: items[0]?.status ?? "failed_retryable", message: `${input.module} 单 ASIN 重采已返回。`, items });
  }

  if (input.module === "amazon_search_market" && !input.targetAsin && input.batchQuery?.trim()) {
    const result = await collectAmazonSearchWithPlaywright({
      context: input.context,
      query: input.batchQuery,
      pages: 2,
      maxAppearances: 60,
      traceId,
    });
    if (result.status !== "captured") {
      const status = result.status === "human_required" ? "human_action_required" : "failed_retryable";
      const item = itemOutcome({
        module: input.module, asin: null, traceId: result.traces[0]?.traceId ?? traceId, startedAt,
        outcome: result.status.toUpperCase(), status, errorCode: result.errorCode,
        message: result.errorMessage ?? "Amazon 搜索本轮未完成；没有重建 ProductBatch。",
      });
      return moduleResult({ module: input.module, requested: 60, traceId: item.traceId, startedAt, status, errorCode: item.errorCode, message: item.message, items: [item] });
    }
    const evidenceStore = createEvidenceStore(sourceLayerOperator(input.context));
    const items = (await Promise.all(result.captures.flatMap((capture) => capture.capture.items.map(async (evidence) => {
      const asin = evidence.asin?.toUpperCase() ?? null;
      const subject = await evidenceStore.getSubject(evidence.subjectKey);
      const attachment = (subject?.attachments ?? [])
        .filter((entry) => {
          const payload = entry.payload;
          return typeof payload === "object" && payload !== null && !Array.isArray(payload)
            && (payload as Record<string, unknown>).module === "amazon_search_market"
            && typeof (payload as Record<string, unknown>).identity === "object"
            && (payload as { identity?: Record<string, unknown> }).identity?.asin === asin;
        })
        .sort((left, right) => String(right.capturedAt).localeCompare(String(left.capturedAt)))[0];
      return itemOutcome({
        module: input.module, asin, traceId: capture.traceId, startedAt,
        outcome: "CAPTURED_PARTIAL", status: "captured_partial",
        errorCode: null,
        message: "已保存 Amazon 搜索页观察证据；结果受当前页数和条数预算限制。",
        evidenceId: attachment?.attachmentId ?? null, contentHash: attachment?.contentHash ?? null,
      });
    })))).filter((item) => item.evidenceId !== null && item.contentHash !== null);
    return moduleResult({ module: input.module, requested: 60, traceId, startedAt, status: items.length ? "captured_partial" : "failed_retryable", message: `Amazon 搜索模块完成，新增/更新 ${items.length} 条商品证据；没有新建 ProductBatch。`, items });
  }

  return inputRequiredResult(input.module, input.targetAsin, traceId, startedAt);
}

export async function orchestrateCaptureCapabilityModules(input: {
  context: AccessContext;
  batchId: unknown;
  modules: unknown;
  targetAsin?: unknown;
  limit?: unknown;
  idempotencyKey: string;
}): Promise<{ value: CaptureCapabilityOrchestrationResult; replayed: boolean; receiptId: string }> {
  if (input.context.mode !== "owner") throw new V5CoreError("FORBIDDEN", "当前主体不允许执行正式采集编排。", 403);
  const batchId = normalizeBatchId(input.batchId);
  const modules = normalizeModules(input.modules);
  const targetAsin = normalizeTargetAsin(input.targetAsin);
  const limit = input.limit === undefined ? 30 : input.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ITEMS_PER_RUN) {
    throw new V5CoreError("MODULE_ORCHESTRATOR_LIMIT_INVALID", `limit 必须是 1-${MAX_ITEMS_PER_RUN} 的整数。`, 400);
  }
  const store = getProductBatchStore(input.context);
  const batch = await store.getBatch(batchId);
  if (!batch) throw new V5CoreError("BATCH_NOT_FOUND", "批次不存在。", 404);
  if (batch.batchStatus !== "ready") throw new V5CoreError("BATCH_NOT_READY", "只有 ready 批次可以执行采集编排。", 409, true);
  if (targetAsin) {
    const items = await store.getBatchItems(batchId);
    if (!items.some((item) => !item.archivedAt && item.asin?.trim().toUpperCase() === targetAsin)) {
      throw new V5CoreError("ITEM_NOT_IN_BATCH", "目标 ASIN 不属于此商品批次。", 404);
    }
  }
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const resourceKey = `${batchId}:${targetAsin ?? "batch"}`;

  return withV5Receipt({
    context: input.context,
    operation: OPERATION,
    resourceKey,
    idempotencyKey,
    requestBody: { batchId, modules, targetAsin, limit },
    execute: async () => {
      const outcomes = await runModulesIndependently<V3ModuleId, OrchestratorModuleResult>({
        modules,
        sourceGate: {
          moduleIds: AMAZON_SESSION_MODULES,
          isGateResult: (value) => isAmazonHumanGate(value as OrchestratorModuleResult),
          createNotAttempted: (moduleId) => notAttemptedAfterAmazonGate(moduleId as V3ModuleId, targetAsin, limit),
        },
        run: (module) => executeModule({
          context: input.context,
          batchId,
          batchQuery: batch.query,
          module,
          targetAsin,
          limit: targetAsin ? 1 : limit,
          idempotencyKey,
        }),
        onError: (module, error) => {
          const traceId = `capture-v2-${randomUUID()}`;
          const message = error instanceof Error ? error.message : "模块执行失败，其他模块会继续。";
          return moduleResult({
            module, requested: targetAsin ? 1 : limit, traceId, startedAt: Date.now(),
            status: "failed_retryable", errorCode: error instanceof V5CoreError ? error.code : "MODULE_EXECUTION_FAILED",
            message,
            items: [itemOutcome({
              module, asin: targetAsin, traceId, startedAt: Date.now(),
              outcome: "FAILED_RETRYABLE", status: "failed_retryable",
              errorCode: error instanceof V5CoreError ? error.code : "MODULE_EXECUTION_FAILED",
              message, evidenceId: null, contentHash: null,
            })],
          });
        },
      });
      const results = outcomes.map((row) => row.value);
      const outcomeClasses = results.map((row) => summarizeOutcome(row.status));
      return {
        batchId,
        targetAsin,
        modules: results,
        summary: {
          requestedModules: results.length,
          completedModules: outcomeClasses.filter((row) => row === "completed").length,
          limitedModules: outcomeClasses.filter((row) => row === "limited").length,
          failedModules: outcomeClasses.filter((row) => row === "failed").length,
          processedItems: results.reduce((sum, row) => sum + row.processed, 0),
        },
      };
    },
  });
}
