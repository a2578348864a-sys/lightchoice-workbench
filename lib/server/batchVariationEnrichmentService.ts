import "server-only";

import { randomUUID } from "node:crypto";
import type { AccessContext } from "@/lib/server/accessPassword";
import type { ProductBatchItemView, ProductBatchStore } from "@/lib/productBatchStore";
import { V5CoreError, requireIdempotencyKey, withV5Receipt } from "@/lib/server/v5CoreCommon";
import { getProductBatchStore } from "@/lib/server/productBatchStoreResolver";
import {
  collectAmazonVariationsWithPlaywright,
  type AmazonVariationBrowserCollectionResult,
} from "@/lib/server/captureRecipeBrowser";
import { logAgentEvent } from "@/lib/server/agentEventLogger";
import { createEvidenceStore, type EvidenceSubjectRecord } from "@/lib/sourceLayer/server/evidenceStore";
import { captureV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import { projectVariationEvidence } from "@/lib/server/research/variationEvidenceProjection";
import { withAmazonVariationSourceSignals } from "@/lib/server/amazonVariationSourceSignals";
import type { AmazonVariationPageCapture, RawVariationPage } from "@/tools/collectors/amazon/variation-page-extract";

const OPERATION = "source-layer:batch-variation-enrich:v1";
const MAX_ITEMS_PER_RUN = 30;
const COLLECTOR_ASIN_LIMIT = 5;
const MODULE = "variation" as const;
const EVIDENCE_VERSION = "capture-system-v3-module-evidence.v1";
const ASIN_PATTERN = /^[A-Za-z0-9]{10}$/u;

export type BatchVariationStatus =
  | "complete"
  | "captured_partial"
  | "no_data_with_evidence"
  | "failed_human"
  | "failed_retryable"
  | "failed_permanent"
  | "skipped_existing"
  | "not_attempted";

export type BatchVariationItemResult = {
  itemId: string;
  asin: string;
  status: BatchVariationStatus;
  retryable: boolean;
  parentAsin: string | null;
  variantCount: number;
  evidenceId: string | null;
  evidenceVersion: string | null;
  contentHash: string | null;
  traceId: string;
  errorCode: string | null;
  limitation: string | null;
  durationMs: number;
};

export type BatchVariationRunResult = {
  summary: {
    requested: number;
    processed: number;
    complete: number;
    capturedPartial: number;
    noDataWithEvidence: number;
    failedHuman: number;
    failedRetryable: number;
    failedPermanent: number;
    skippedExisting: number;
    notAttempted: number;
    humanAborted: boolean;
  };
  items: BatchVariationItemResult[];
};

type VariationCollection = AmazonVariationBrowserCollectionResult;
type VariationPageResult = VariationCollection["results"][number];

export type BatchVariationDeps = {
  /**
   * 受控停止检查：由 BatchCaptureRun 注入。
   * 返回 true 表示当前运行已暂停/中止或导航预算耗尽 —— Worker 必须立即停止领取新工作，
   * 不再发起新的页面导航；已写入的 Evidence 保持原样。
   */
  shouldStop?(): Promise<boolean> | boolean;
  getStore(context: AccessContext): Pick<ProductBatchStore, "getBatch" | "getBatchItems">;
  getSubject(subjectKey: string): Promise<EvidenceSubjectRecord | null>;
  collect(input: {
    context: AccessContext;
    asins: ReadonlyArray<{ asin: string }>;
    traceId: string;
  }): Promise<VariationCollection>;
  saveModule(input: {
    context: AccessContext;
    asin: string;
    traceId: string;
    capturedAt: string;
    capture: AmazonVariationPageCapture | null;
    rawVariationSignals?: RawVariationPage | null;
    sourceUrl: string | null;
    outcome: "FAILED_RETRYABLE" | "FAILED_HUMAN" | "FAILED_PERMANENT";
    status: "BLOCKED_WITH_EVIDENCE" | "HUMAN_ACTION_REQUIRED";
    limitation: string;
    errorCode: string;
    retryable: boolean;
    diagnostics: Record<string, unknown> | null;
  }): Promise<{ evidenceId: string; contentHash: string }>;
  logEvent(input: { runId: string; batchId: string; item: BatchVariationItemResult }): Promise<void>;
  now(): Date;
};

function defaultDeps(): BatchVariationDeps {
  const store = createEvidenceStore("owner:v1");
  return {
    getStore: (context) => getProductBatchStore(context),
    getSubject: (subjectKey) => store.getSubject(subjectKey),
    collect: (input) => collectAmazonVariationsWithPlaywright(input),
    saveModule: async (input) => {
      const evidenceData = withAmazonVariationSourceSignals({
        outcome: input.outcome,
        traceId: input.traceId,
        variationStatus: input.capture?.status ?? null,
        parentAsin: input.capture?.parentAsin ?? null,
        currentAsin: input.capture?.currentAsin ?? input.asin,
        dimensions: input.capture?.dimensions ?? [],
        variantAsins: input.capture?.variantAsins ?? [],
        variants: input.capture?.variants ?? [],
        sourceUrl: input.sourceUrl,
        capturedAt: input.capturedAt,
        identityProof: input.capture?.identityProof ?? null,
        captureDiagnostics: input.diagnostics,
        error: { code: input.errorCode, retryable: input.retryable },
      }, input.rawVariationSignals);
      const plan = {
        context: input.context,
        sourceType: "amazon_dom" as const,
        sourceFingerprint: `variation:${input.asin}:${input.capturedAt}:${input.traceId}`,
        moduleEvidence: {
          module: MODULE,
          subjectKey: `amazon:US:${input.asin}`,
          marketplace: "US",
          capturedAt: input.capturedAt,
          provider: "Amazon",
          sourceSurface: "Amazon product detail variation JSON and DOM",
          sourceUrl: input.sourceUrl,
          acquisitionMode: "DOM_DIRECT" as const,
          metricNature: "source_observed" as const,
          status: input.status,
          limitations: [input.limitation],
          identity: {
            asin: input.asin,
            ...(input.capture?.parentAsin ? { parentAsin: input.capture.parentAsin } : {}),
          },
          data: evidenceData.data,
          evidenceOnly: true,
        },
      };
      const result = await captureV3ModuleEvidence(plan);
      return { evidenceId: result.attachment.attachmentId, contentHash: result.attachment.contentHash };
    },
    logEvent: async ({ runId, batchId, item }) => {
      try {
        await logAgentEvent({
          taskId: null,
          runId,
          module: "batch_variation_enrichment",
          event: `item_${item.status}`,
          level: item.status.startsWith("failed") ? "warn" : "info",
          message: `批次 ${batchId} 商品 ${item.asin} 的 Variation 模块状态：${item.status}。`,
          metadata: item,
        });
      } catch {
        // Agent event is diagnostic only; EvidenceStore is the module state source.
      }
    },
    now: () => new Date(),
  };
}

function normalizeBatchId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{10,64}$/u.test(value.trim())) {
    throw new V5CoreError("BATCH_ID_INVALID", "batchId 必须是有效的批次 ID。", 400);
  }
  return value.trim();
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_ITEMS_PER_RUN) {
    throw new V5CoreError("VARIATION_LIMIT_INVALID", `limit 必须是 1-${MAX_ITEMS_PER_RUN} 的整数。`, 400);
  }
  return value;
}

function normalizeTargetAsin(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !ASIN_PATTERN.test(value.trim())) {
    throw new V5CoreError("TARGET_ASIN_INVALID", "targetAsin 必须是 10 位字母数字 ASIN。", 400);
  }
  return value.trim().toUpperCase();
}

/** 显式目标 ASIN 集合（批量采集执行器用于「精确选择本轮商品」）。 */
function normalizeTargetAsins(value: unknown): ReadonlySet<string> | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new V5CoreError("TARGET_ASINS_INVALID", "targetAsins 必须是 ASIN 数组。", 400);
  }
  const set = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !ASIN_PATTERN.test(entry.trim())) {
      throw new V5CoreError("TARGET_ASINS_INVALID", "targetAsins 含非法 ASIN。", 400);
    }
    set.add(entry.trim().toUpperCase());
  }
  return set;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedAsin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const asin = value.trim().toUpperCase();
  return ASIN_PATTERN.test(asin) ? asin : null;
}

function matchingVariationEvidence(subject: EvidenceSubjectRecord | null, asin: string) {
  const attachments = subject?.attachments ?? [];
  const projection = projectVariationEvidence(attachments, `amazon:US:${asin}`);
  if (projection.outcome !== "complete"
    && projection.outcome !== "partial"
    && projection.outcome !== "no_variation_with_evidence") return null;
  const attachmentId = projection.evidenceRefs[0]?.captureId;
  return attachmentId ? attachments.find((attachment) => attachment.attachmentId === attachmentId) ?? null : null;
}

function outcomeForPage(page: VariationPageResult): {
  status: Exclude<BatchVariationStatus, "skipped_existing">;
  retryable: boolean;
  errorCode: string | null;
  limitation: string | null;
} {
  switch (page.capture.status) {
    case "COMPLETE": return { status: "complete", retryable: false, errorCode: null, limitation: null };
    case "CAPTURED_PARTIAL": return { status: "captured_partial", retryable: false, errorCode: null, limitation: "variation_mapping_incomplete" };
    case "NO_VARIATION_WITH_EVIDENCE": return { status: "no_data_with_evidence", retryable: false, errorCode: null, limitation: "no_variation_with_evidence" };
    case "HUMAN_REQUIRED": return { status: "failed_human", retryable: false, errorCode: page.errorCode ?? "HUMAN_ACTION_REQUIRED", limitation: "variation_requires_human" };
    case "PAGE_CHANGED": return { status: "failed_retryable", retryable: true, errorCode: page.errorCode ?? "VARIATION_PAGE_CHANGED", limitation: "variation_page_identity_not_bound" };
    case "EXTRACTION_EMPTY_RETRYABLE": return { status: "failed_retryable", retryable: true, errorCode: page.errorCode ?? "VARIATION_EXTRACTION_EMPTY", limitation: "variation_extraction_empty_retryable" };
    case "NOT_ATTEMPTED": return { status: "not_attempted", retryable: true, errorCode: "HUMAN_GATE_PAUSE", limitation: "not_attempted_after_human_gate" };
  }
}

function existingResult(
  item: ProductBatchItemView,
  asin: string,
  attachment: NonNullable<ReturnType<typeof matchingVariationEvidence>>,
  traceId: string,
): BatchVariationItemResult {
  const payload = attachment.payload;
  const data = isRecord(payload.data) ? payload.data : {};
  const variants = Array.isArray(data.variantAsins) ? data.variantAsins : [];
  return {
    itemId: item.id,
    asin,
    status: "skipped_existing",
    retryable: false,
    parentAsin: normalizedAsin(data.parentAsin),
    variantCount: variants.length,
    evidenceId: attachment.attachmentId,
    evidenceVersion: EVIDENCE_VERSION,
    contentHash: attachment.contentHash,
    traceId: typeof data.traceId === "string" ? data.traceId : traceId,
    errorCode: null,
    limitation: Array.isArray(payload.limitations) && typeof payload.limitations[0] === "string" ? payload.limitations[0] : null,
    durationMs: 0,
  };
}

function statusFromTopLevel(collection: VariationCollection) {
  const human = collection.humanAborted || collection.status === "human_required"
    || /captcha|login|human/iu.test(collection.errorCode ?? "");
  const retryable = !human;
  return {
    outcome: human ? "FAILED_HUMAN" as const : "FAILED_RETRYABLE" as const,
    status: human ? "HUMAN_ACTION_REQUIRED" as const : "BLOCKED_WITH_EVIDENCE" as const,
    errorCode: collection.errorCode ?? (human ? "HUMAN_ACTION_REQUIRED" : "VARIATION_SOURCE_UNAVAILABLE"),
    limitation: human ? "variation_requires_human" : "variation_source_unavailable_retryable",
    retryable,
  };
}

export async function runVariationEnrichment(input: {
  context: AccessContext;
  batchId: string;
  limit: number;
  targetAsin?: string | null;
  targetAsins?: ReadonlySet<string> | null;
  forceRecapture?: boolean;
  deps: BatchVariationDeps;
}): Promise<BatchVariationRunResult> {
  const { context, batchId, limit, targetAsin = null, targetAsins = null, forceRecapture = false, deps } = input;
  const store = deps.getStore(context);
  const batch = await store.getBatch(batchId);
  if (!batch) throw new V5CoreError("BATCH_NOT_FOUND", "批次不存在。", 404);
  if (batch.batchStatus === "archived") throw new V5CoreError("BATCH_ARCHIVED", "批次已归档，不能补齐。", 409);
  if (batch.batchStatus === "blocked") throw new V5CoreError("BATCH_BLOCKED", "批次处于 blocked 状态，不能补齐。", 409);
  if (batch.batchStatus !== "ready") throw new V5CoreError("BATCH_NOT_READY", "批次尚未就绪，不能补齐。", 409, true);

  const items = (await store.getBatchItems(batchId))
    .filter((item) => !item.archivedAt && typeof item.asin === "string" && ASIN_PATTERN.test(item.asin.trim()))
    .filter((item) => !targetAsin || item.asin?.trim().toUpperCase() === targetAsin)
    .filter((item) => !targetAsins || targetAsins.has((item.asin ?? "").trim().toUpperCase()))
    .sort((a, b) => a.ordinal - b.ordinal);
  if (targetAsin && items.length === 0) {
    throw new V5CoreError("ITEM_NOT_IN_BATCH", "目标 ASIN 不属于此商品批次。", 404);
  }
  const results: BatchVariationItemResult[] = [];
  const runId = `batch-variation-${randomUUID()}`;
  const newPending: ProductBatchItemView[] = [];
  const retryablePending: ProductBatchItemView[] = [];
  for (const item of items) {
    // 逐 ASIN 停止检查：暂停/中止后不再开始下一件商品。
    if (await deps.shouldStop?.()) break;
    const asin = (item.asin as string).trim().toUpperCase();
    const subject = await deps.getSubject(`amazon:US:${asin}`);
    const hadPriorEvidence = (subject?.attachments ?? []).some((attachment) => {
      const payload = attachment.payload;
      return isRecord(payload) && payload.module === MODULE && isRecord(payload.identity)
        && normalizedAsin(payload.identity.asin) === asin;
    });
    const evidence = matchingVariationEvidence(subject, asin);
    if (evidence && !forceRecapture) {
      const result = existingResult(item, asin, evidence, runId);
      results.push(result);
      await deps.logEvent({ runId, batchId, item: result });
      continue;
    }
    (hadPriorEvidence && !forceRecapture ? retryablePending : newPending).push(item);
  }

  // First-time ASINs are prioritized so a transient page block cannot starve later items.
  const pending = [...newPending, ...retryablePending];
  let processed = 0;
  let humanAborted = false;
  for (let offset = 0; offset < pending.length && processed < limit; offset += COLLECTOR_ASIN_LIMIT) {
    const group = pending.slice(offset, Math.min(offset + COLLECTOR_ASIN_LIMIT, pending.length, offset + (limit - processed)));
    if (group.length === 0) break;
    const groupAsins = group.map((item) => (item.asin as string).trim().toUpperCase());
    const traceId = `${runId}:${randomUUID()}`;
    // 分组导航前停止检查：暂停后不再发起下一组页面导航。
    if (await deps.shouldStop?.()) break;
    let collection: VariationCollection;
    try {
      collection = await deps.collect({ context, traceId, asins: groupAsins.map((asin) => ({ asin })) });
    } catch {
      collection = {
        status: "failed", results: [], errorCode: "PLAYWRIGHT_BROWSER_FAILED", humanAborted: false,
        consoleErrors: 0, pageErrors: 0, browser: null,
      };
    }

    const byAsin = new Map(collection.results.map((result) => [result.asin.toUpperCase(), result]));
    for (const item of group) {
      const asin = (item.asin as string).trim().toUpperCase();
      const traceForItem = `${traceId}:${asin}`;
      const page = byAsin.get(asin);
      const capturedAt = deps.now().toISOString();
      let evidenceId: string | null = page?.evidenceId ?? null;
      let contentHash: string | null = page?.contentHash ?? null;
      let decision: ReturnType<typeof outcomeForPage> = page
        ? outcomeForPage(page)
        : { status: "failed_retryable", retryable: true, errorCode: "VARIATION_SOURCE_UNAVAILABLE", limitation: "variation_source_unavailable_retryable" };
      let parentAsin = page?.capture.parentAsin ?? null;
      let variantCount = page?.capture.variantAsins.length ?? 0;
      let durationMs = page?.elapsedMs ?? 0;
      const capture = page?.capture ?? null;

      if (!page) {
        const topLevel = statusFromTopLevel(collection);
        if (topLevel.outcome === "FAILED_HUMAN") {
          // A human gate can pause this ASIN before its page is visited. Do not
          // persist a per-product human failure without an observed product page.
          decision = { status: "not_attempted", retryable: true, errorCode: "HUMAN_GATE_PAUSE", limitation: "not_attempted_after_human_gate" };
        } else {
          decision = {
            status: "failed_retryable",
            retryable: topLevel.retryable,
            errorCode: topLevel.errorCode,
            limitation: topLevel.limitation,
          };
          try {
            const saved = await deps.saveModule({
              context,
              asin,
              traceId: traceForItem,
              capturedAt,
              capture: null,
              sourceUrl: null,
              outcome: topLevel.outcome,
              status: topLevel.status,
              limitation: topLevel.limitation,
              errorCode: topLevel.errorCode,
              retryable: topLevel.retryable,
              diagnostics: {
                collectorStatus: collection.status,
                consoleErrors: collection.consoleErrors,
                pageErrors: collection.pageErrors,
                humanAborted: collection.humanAborted,
              },
            });
            evidenceId = saved.evidenceId;
            contentHash = saved.contentHash;
          } catch {
            evidenceId = null;
            contentHash = null;
            decision = { status: "failed_retryable", retryable: true, errorCode: "VARIATION_EVIDENCE_PERSIST_FAILED", limitation: "variation_evidence_persist_failed" };
          }
        }
      } else if (capture?.status !== "NOT_ATTEMPTED" && (!evidenceId || !contentHash)) {
        const persistedFailure = page.errorCode ?? "VARIATION_EVIDENCE_PERSIST_FAILED";
        try {
          const human = decision.status === "failed_human";
          const saved = await deps.saveModule({
            context,
            asin,
            traceId: traceForItem,
            capturedAt: page.capture.capturedAt,
            capture: page.capture,
            rawVariationSignals: page.rawVariationSignals,
            sourceUrl: page.capture.sourceUrl,
            outcome: human ? "FAILED_HUMAN" : "FAILED_RETRYABLE",
            status: human ? "HUMAN_ACTION_REQUIRED" : "BLOCKED_WITH_EVIDENCE",
            limitation: human ? "variation_requires_human" : "variation_evidence_persist_failed",
            errorCode: persistedFailure,
            retryable: !human,
            diagnostics: { collectorErrorCode: page.errorCode, collectorElapsedMs: page.elapsedMs },
          });
          evidenceId = saved.evidenceId;
          contentHash = saved.contentHash;
        } catch {
          decision = { status: "failed_retryable", retryable: true, errorCode: "VARIATION_EVIDENCE_PERSIST_FAILED", limitation: "variation_evidence_persist_failed" };
        }
      }

      const notAttempted = capture?.status === "NOT_ATTEMPTED" || decision.status === "not_attempted";
      const status: BatchVariationStatus = notAttempted ? "not_attempted"
        : evidenceId && contentHash ? decision.status
          : decision.status === "failed_human" ? "failed_human" : "failed_retryable";
      const result: BatchVariationItemResult = {
        itemId: item.id,
        asin,
        status,
        retryable: notAttempted ? true : status === "failed_human" ? false : decision.retryable || !evidenceId,
        parentAsin,
        variantCount,
        evidenceId,
        evidenceVersion: evidenceId ? EVIDENCE_VERSION : null,
        contentHash,
        traceId: traceForItem,
        errorCode: decision.errorCode,
        limitation: decision.limitation,
        durationMs,
      };
      results.push(result);
      if (!notAttempted) processed += 1;
      await deps.logEvent({ runId, batchId, item: result });
      if (status === "failed_human") humanAborted = true;
    }
    if (collection.humanAborted || humanAborted) {
      humanAborted = true;
      const remaining = pending.slice(offset + group.length);
      for (const item of remaining) {
        const asin = (item.asin as string).trim().toUpperCase();
        const result: BatchVariationItemResult = {
          itemId: item.id,
          asin,
          status: "not_attempted",
          retryable: true,
          parentAsin: null,
          variantCount: 0,
          evidenceId: null,
          evidenceVersion: null,
          contentHash: null,
          traceId: `${traceId}:paused:${asin}`,
          errorCode: "HUMAN_GATE_PAUSE",
          limitation: "not_attempted_after_human_gate",
          durationMs: 0,
        };
        results.push(result);
        await deps.logEvent({ runId, batchId, item: result });
      }
      break;
    }
  }

  const summary = {
    requested: Math.min(limit, items.length),
    processed,
    complete: results.filter((item) => item.status === "complete").length,
    capturedPartial: results.filter((item) => item.status === "captured_partial").length,
    noDataWithEvidence: results.filter((item) => item.status === "no_data_with_evidence").length,
    failedHuman: results.filter((item) => item.status === "failed_human").length,
    failedRetryable: results.filter((item) => item.status === "failed_retryable").length,
    failedPermanent: results.filter((item) => item.status === "failed_permanent").length,
    skippedExisting: results.filter((item) => item.status === "skipped_existing").length,
    notAttempted: results.filter((item) => item.status === "not_attempted").length,
    humanAborted,
  };
  return { summary, items: results };
}

export async function enrichBatchWithVariation(input: {
  context: AccessContext;
  batchId: unknown;
  limit: unknown;
  targetAsin?: unknown;
  targetAsins?: unknown;
  forceRecapture?: boolean;
  idempotencyKey: string;
  deps?: BatchVariationDeps;
  /** 受控停止检查（由 BatchCaptureRun 注入）；返回 true 时 Worker 立即停止领取新工作。 */
  shouldStop?: unknown;
}): Promise<{ value: BatchVariationRunResult; replayed: boolean; receiptId: string }> {
  if (input.context.mode !== "owner") throw new V5CoreError("FORBIDDEN", "当前主体不允许执行正式 Variation 批次补齐。", 403);
  const batchId = normalizeBatchId(input.batchId);
  const limit = normalizeLimit(input.limit);
  const targetAsin = normalizeTargetAsin(input.targetAsin);
  const targetAsins = normalizeTargetAsins(input.targetAsins);
  const forceRecapture = input.forceRecapture === true;
  if (forceRecapture && !targetAsin) {
    throw new V5CoreError("TARGET_ASIN_REQUIRED", "强制重采 Variation 时必须指定 targetAsin。", 400);
  }
  const baseDeps = input.deps ?? defaultDeps();
  const deps: BatchVariationDeps = typeof input.shouldStop === "function"
    ? { ...baseDeps, shouldStop: input.shouldStop as () => Promise<boolean> | boolean }
    : baseDeps;
  return withV5Receipt({
    context: input.context,
    operation: OPERATION,
    resourceKey: batchId,
    idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
    requestBody: { batchId, limit, targetAsin, targetAsins: targetAsins ? [...targetAsins].sort() : null, forceRecapture },
    execute: () => runVariationEnrichment({ context: input.context, batchId, limit, targetAsin, targetAsins, forceRecapture, deps }),
  });
}
