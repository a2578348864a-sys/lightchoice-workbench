import "server-only";

import { randomUUID } from "node:crypto";

import type { AccessContext } from "@/lib/server/accessPassword";
import {
  V5CoreError,
  requireIdempotencyKey,
  withV5Receipt,
} from "@/lib/server/v5CoreCommon";
import { getProductBatchStore } from "@/lib/server/productBatchStoreResolver";
import {
  collectAmazonDetailWithPlaywright,
} from "@/lib/server/captureRecipeBrowser";
import { logAgentEvent } from "@/lib/server/agentEventLogger";
import { adaptEvidenceToProductFact } from "@/lib/sourceLayer/fact/productFactAdapter";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import type { CaptureEvidenceRecord } from "@/lib/sourceLayer/sourceAdapter";
import {
  createEvidenceStore,
  type EvidenceSubjectRecord,
} from "@/lib/sourceLayer/server/evidenceStore";
import type { ProductBatchItemView, ProductBatchStore } from "@/lib/productBatchStore";
import { V3_PROVIDER_CADENCE_MS } from "@/lib/sourceLayer/providerFreshness";
import { readProductBatchDetailEnrichment } from "@/lib/sourceLayer/moduleStatusPresentation";

/**
 * ProductBatch → Amazon Detail 补齐 Worker（第一阶段：仅 amazon_detail 模块）。
 *
 * 冻结边界（2026-10-07 设计冻结）：
 * - EvidenceStore 是唯一事实权威：本服务不生成任何事实，只从详情证据读回并补投影。
 * - Capture Gateway 是唯一采集路径：采集复用 collectAmazonDetailWithPlaywright，不绕行。
 * - Research 不采集：marketScanService / Research 流程保持只读，本服务不被其调用。
 * - Human Decision 最终权威：不自动 promote、不改 evidenceStatus/disposition/batchStatus。
 *
 * 状态不在数据库新增字段，全部派生自：
 * EvidenceStore（详情证据存在性）、条目 normalizedProductJson 的 enrichment 块（终态）、
 * V5OperationReceipt（run 记录）与 agent_events（逐条进度）。
 */

const ENRICHMENT_OPERATION = "source-layer:batch-detail-enrich:v1";
const ENRICHMENT_SCHEMA_VERSION = "amazon-batch-detail-enrichment.v1";
const DETAIL_MODULE = "amazon_detail";
const OWNER_SUBJECT = "owner:v1";
/** Phase 2-A 裁决：单轮上限由 MVP 的 5 提升至 30（分轮 10→20→30 批量验证所需）。 */
const MAX_ITEMS_PER_RUN = 30;
const AGENT_EVENT_MODULE = "batch_detail_enrichment";

/** 环境级失败：整轮 fail-closed 中止；retryable=true，同幂等键可续跑（已补齐条目自动跳过）。 */
const ENV_BLOCKED_ERROR_CODES = new Set([
  "LOCAL_ENVIRONMENT_REQUIRED",
  "PLAYWRIGHT_RUNTIME_MISSING",
  "MARKETPLACE_MISMATCH",
  "LOCALE_MISMATCH",
  "NON_US_EXIT",
  "AMAZON_CAPTURE_NON_US_EXIT",
]);

/** 条目级永久失败：重试无意义。 */
const PERMANENT_ERROR_CODES = new Set([
  "ASIN_INVALID",
  "ASIN_NOT_FOUND",
]);

/** 条目级人工失败：立即熔断整轮，保护 warm profile。 */
const HUMAN_ERROR_CODES = new Set([
  "CAPTCHA_DETECTED",
  "LOGIN_REQUIRED",
]);

export type BatchDetailEnrichmentItemStatus =
  | "enriched"
  | "captured_partial"
  | "skipped_enriched"
  | "failed_retryable"
  | "failed_permanent"
  | "failed_human";

export type BatchDetailEnrichmentItemResult = {
  itemId: string;
  asin: string;
  status: BatchDetailEnrichmentItemStatus;
  captured: boolean;
  durationMs: number;
  errorCode: string | null;
  evidenceId: string | null;
  evidenceVersion: number | null;
  captureOrigin?: "CAPTURED_NOW" | "REUSED_VALID_EVIDENCE" | null;
  existingEnrichmentStatus?: "enriched" | "captured_partial";
};

export type BatchDetailEnrichmentRunResult = {
  traceId: string;
  summary: {
    total: number;
    captured: number;
    enriched: number;
    capturedPartial: number;
    failedRetryable: number;
    failedPermanent: number;
    failedHuman: number;
    skippedEnriched: number;
    humanAborted: boolean;
  };
  items: BatchDetailEnrichmentItemResult[];
  timings: {
    avgMs: number;
    p95Ms: number;
    failureRate: number;
  };
};

type DetailCaptureResult = Awaited<
  ReturnType<typeof collectAmazonDetailWithPlaywright>
>;

/** 测试注入边界：除这五个副作用入口外，其余逻辑全部纯函数。 */
export type BatchDetailEnrichmentDeps = {
  /**
   * 受控停止检查：由 BatchCaptureRun 注入。
   * 返回 true 表示当前运行已暂停/中止或导航预算耗尽 —— Worker 必须立即停止领取新工作，
   * 不再发起新的页面导航；已写入的 Evidence 保持原样。
   */
  shouldStop?(): Promise<boolean> | boolean;
  getStore(context: AccessContext): Pick<
    ProductBatchStore,
    "getBatch" | "getBatchItems" | "updateBatchItemEnrichment"
  >;
  captureAsin(input: {
    context: AccessContext;
    asin: string;
    traceId: string;
  }): Promise<DetailCaptureResult>;
  getSubject(subjectKey: string): Promise<EvidenceSubjectRecord | null>;
  factFromEvidence(evidence: CaptureEvidenceRecord): ProductFact;
  logEvent(input: {
    runId: string;
    batchId: string;
    result: BatchDetailEnrichmentItemResult;
    message: string;
  }): Promise<void>;
  now(): Date;
};

async function defaultLogEvent(input: {
  runId: string;
  batchId: string;
  result: BatchDetailEnrichmentItemResult;
  message: string;
}): Promise<void> {
  // 诊断事件写失败不得影响补齐结果（证据与条目回写均已持久化）。
  try {
    await logAgentEvent({
      taskId: null,
      runId: input.runId,
      module: AGENT_EVENT_MODULE,
      event: `item_${input.result.status}`,
      level: input.result.status.startsWith("failed") ? "warn" : "info",
      message: input.message,
      metadata: {
        batchId: input.batchId,
        ...input.result,
      },
    });
  } catch {
    return;
  }
}

function defaultDeps(): BatchDetailEnrichmentDeps {
  const store = createEvidenceStore(OWNER_SUBJECT);
  return {
    getStore: (context) => getProductBatchStore(context),
    captureAsin: (input) => collectAmazonDetailWithPlaywright(input),
    getSubject: (subjectKey) => store.getSubject(subjectKey),
    factFromEvidence: (evidence) => adaptEvidenceToProductFact({ evidence }),
    logEvent: (input) => defaultLogEvent(input),
    now: () => new Date(),
  };
}

function normalizeBatchId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{10,64}$/.test(value.trim())) {
    throw new V5CoreError("BATCH_ID_INVALID", "batchId 必须是有效的批次 ID。", 400);
  }
  return value.trim();
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_ITEMS_PER_RUN) {
    throw new V5CoreError(
      "ENRICHMENT_LIMIT_INVALID",
      `limit 必须是 1-${MAX_ITEMS_PER_RUN} 的整数。`,
      400,
    );
  }
  return value;
}

function normalizeTargetAsin(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9]{10}$/u.test(value.trim())) {
    throw new V5CoreError("TARGET_ASIN_INVALID", "targetAsin 必须是 10 位字母数字 ASIN。", 400);
  }
  return value.trim().toUpperCase();
}

/**
 * 显式目标 ASIN 集合（批量采集执行器用于「精确选择本轮商品」）。
 * 与单个 targetAsin 互斥语义一致：只处理集合内的条目，集合外条目一律不触碰。
 */
function normalizeTargetAsins(value: unknown): ReadonlySet<string> | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new V5CoreError("TARGET_ASINS_INVALID", "targetAsins 必须是 ASIN 数组。", 400);
  }
  const set = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !/^[A-Za-z0-9]{10}$/u.test(entry.trim())) {
      throw new V5CoreError("TARGET_ASINS_INVALID", "targetAsins 含非法 ASIN。", 400);
    }
    set.add(entry.trim().toUpperCase());
  }
  return set;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 判定「该 ASIN 是否已有 amazon_detail 详情证据」并解析出对应证据版本。
 * 附件 payload.module === "amazon_detail" 是权威判别位（搜索证据 amazon_search_market 不算）；
 * 附件与版本的关联 = capturedAt 精确匹配（同一次采集派生，毫秒级一致）。
 * 关联失败一律返回 null（视为无详情证据 → 走重新采集，fail-safe 不误跳过）。
 */
export async function resolveDetailEvidence(
  getSubject: BatchDetailEnrichmentDeps["getSubject"],
  asin: string,
  fallbackCapturedAt?: string,
  now = new Date(),
): Promise<CaptureEvidenceRecord | null> {
  const normalizedAsin = asin.trim().toUpperCase();
  const subjectKey = `amazon:US:${normalizedAsin}`;
  const subject = await getSubject(subjectKey);
  if (!subject || subject.subjectKey !== subjectKey || !Number.isFinite(now.getTime())) return null;
  const detailAttachments = (subject.attachments ?? [])
    .filter((attachment) => {
      const payload = attachment.payload;
      const identity = isRecord(payload) && isRecord(payload.identity) ? payload.identity : null;
      return attachment.subjectKey === subjectKey
        && attachment.sourceType === "amazon_dom"
        && attachment.kind === "v3_amazon_detail_v1"
        && isRecord(payload)
        && payload.module === DETAIL_MODULE
        && payload.subjectKey === subjectKey
        && payload.marketplace === "US"
        && typeof payload.capturedAt === "string"
        && identity?.asin === normalizedAsin;
    })
    .sort((a, b) => String(b.payload.capturedAt).localeCompare(String(a.payload.capturedAt)));
  const versions = [...subject.versions].sort((a, b) => b.version - a.version);
  const isUsableVersion = (version: CaptureEvidenceRecord | undefined): version is CaptureEvidenceRecord => {
    if (!version || !isRecord(version.pkg) || !isRecord(version.pkg.fields) || !isRecord(version.pkg.sourceProof)) return false;
    const binding = isRecord(version.pkg.sourceProof.entityBinding) ? version.pkg.sourceProof.entityBinding : null;
    const upper = (value: unknown) => typeof value === "string" ? value.trim().toUpperCase() : null;
    if (version.subjectKey !== subjectKey
      || version.sourceType !== "amazon_dom"
      || version.pkg.subjectKey !== subjectKey
      || upper(version.pkg.marketplace) !== "US"
      || upper(version.pkg.fields.asin) !== normalizedAsin
      || typeof version.contentHash !== "string"
      || !/^[a-f0-9]{64}$/iu.test(version.contentHash)
      || !Number.isSafeInteger(version.version)
      || version.version < 1
      || !binding?.bound
      || upper(binding.expectedAsin) !== normalizedAsin
      || upper(binding.observedAsin) !== normalizedAsin
      || upper(binding.urlAsin) !== normalizedAsin
      || upper(binding.expectedMarketplace) !== "US"
      || upper(binding.observedMarketplace) !== "US"
      || upper(binding.urlMarketplace) !== "US") return false;
    const capturedAt = Date.parse(version.capturedAt);
    const age = now.getTime() - capturedAt;
    return Number.isFinite(capturedAt)
      && age >= 0
      && age <= V3_PROVIDER_CADENCE_MS.amazon_detail_snapshot;
  };
  for (const attachment of detailAttachments) {
    const capturedAt = String(attachment.payload.capturedAt);
    const matched = versions.find((version) => version.capturedAt === capturedAt);
    if (isUsableVersion(matched)) return matched;
  }
  if (fallbackCapturedAt) {
    const matched = versions.find((version) => version.capturedAt === fallbackCapturedAt);
    if (isUsableVersion(matched)) return matched;
  }
  return null;
}

/**
 * 构造补齐后的 normalizedProductJson：纯 additive。
 * 只允许：① reference.brand/category/bsr 在原值为 null 时以详情证据值填充；
 * ② 新增/累积顶层 enrichment 溯源块。comparisonFacts/image 等其余字段逐字节保留；
 * itemHash 不更新（保持「采集时点 reference 哈希」语义，详情溯源在 enrichment 块内）。
 *
 * G-03 字段级来源纪律：
 * `enrichment.evidenceId / evidenceVersion / contentHash / capturedAt` 只描述
 * **本次补齐运行**所使用的证据，**不得**被任何消费方当作「已填充字段的来源」。
 * 每个字段的真实来源记录在 `enrichment.fieldProvenance`，并且**跨多次补齐累积**：
 * 早先运行填进去的字段继续指向当时供应该字段的证据，不会被后续运行的证据身份顶掉。
 */
export const FIELD_PROVENANCE_SCHEMA = "amazon-batch-detail-field-provenance.v1";

export type BatchDetailFieldProvenanceEntry = {
  readonly field: string;
  readonly evidenceId: string;
  readonly evidenceVersion: number;
  readonly contentHash: string;
  readonly capturedAt: string;
};

/**
 * 只读解析已持久化的字段级来源块。任何一条不满足证据完整性要求的记录都会被丢弃，
 * 不做推断、不做补全 —— 缺来源宁可缺，也不能把字段挂到未供给它的版本上。
 */
export function readBatchDetailFieldProvenance(value: unknown): BatchDetailFieldProvenanceEntry[] {
  if (!isRecord(value)) return [];
  const block = value.fieldProvenance;
  if (!isRecord(block) || block.schemaVersion !== FIELD_PROVENANCE_SCHEMA || !Array.isArray(block.entries)) return [];
  const entries: BatchDetailFieldProvenanceEntry[] = [];
  for (const raw of block.entries) {
    if (!isRecord(raw)) continue;
    if (typeof raw.field !== "string" || !raw.field.trim()) continue;
    if (typeof raw.evidenceId !== "string" || !raw.evidenceId.trim()) continue;
    if (typeof raw.evidenceVersion !== "number" || !Number.isInteger(raw.evidenceVersion) || raw.evidenceVersion < 1) continue;
    if (typeof raw.contentHash !== "string" || !/^[a-f0-9]{64}$/iu.test(raw.contentHash)) continue;
    if (typeof raw.capturedAt !== "string" || !Number.isFinite(Date.parse(raw.capturedAt))) continue;
    entries.push({
      field: raw.field,
      evidenceId: raw.evidenceId,
      evidenceVersion: raw.evidenceVersion,
      contentHash: raw.contentHash,
      capturedAt: raw.capturedAt,
    });
  }
  return entries;
}

export function buildEnrichedReferenceJson(input: {
  reference: Record<string, unknown>;
  fact: ProductFact;
  evidence: Pick<CaptureEvidenceRecord, "evidenceId" | "version" | "contentHash" | "capturedAt">
    & Partial<Pick<CaptureEvidenceRecord, "captureId" | "subjectKey">>;
  captureOrigin?: "CAPTURED_NOW" | "REUSED_VALID_EVIDENCE";
  now: Date;
}): { json: string; status: "enriched" | "captured_partial"; fields: string[] } {
  const reference = input.reference;
  const brand = input.fact.basic.brand.value ?? null;
  const category = input.fact.basic.category.value ?? null;
  const bsrRank = input.fact.market.bsr.value;
  const bsr = bsrRank !== null
    ? { rank: bsrRank, category: input.fact.basic.category.value ?? null }
    : null;

  const filled: string[] = [];
  if (reference.brand == null && brand != null) {
    reference.brand = brand;
    filled.push("brand");
  }
  if (reference.category == null && category != null) {
    reference.category = category;
    filled.push("category");
  }
  if (reference.bsr == null && bsr != null) {
    reference.bsr = bsr;
    filled.push("bsr");
  }

  // 字段级来源：先继承历史运行写入的来源，再用本次真正填充的字段覆盖/新增。
  // 本次未填充的字段不改变其来源 —— 这正是「不得用当前版本 evidenceId 包装历史字段」的要求。
  const provenanceByField = new Map<string, BatchDetailFieldProvenanceEntry>();
  for (const entry of readBatchDetailFieldProvenance(reference.enrichment)) {
    provenanceByField.set(entry.field, entry);
  }
  for (const field of filled) {
    provenanceByField.set(field, {
      field,
      evidenceId: input.evidence.evidenceId,
      evidenceVersion: input.evidence.version,
      contentHash: input.evidence.contentHash,
      capturedAt: input.evidence.capturedAt,
    });
  }

  const status = reference.brand != null && reference.category != null && reference.bsr != null
    ? "enriched"
    : "captured_partial";
  reference.enrichment = {
    schemaVersion: ENRICHMENT_SCHEMA_VERSION,
    status,
    module: DETAIL_MODULE,
    // 本次运行所使用的证据（仅用于解释「这一轮做了什么」，不是字段来源）。
sourceType: "amazon_dom",
    ...(typeof reference.asin === "string" ? { asin: reference.asin.toUpperCase() } : {}),
    ...(input.evidence.subjectKey ? { subjectKey: input.evidence.subjectKey } : {}),
    evidenceId: input.evidence.evidenceId,
    ...(input.evidence.captureId ? { captureId: input.evidence.captureId } : {}),
    evidenceVersion: input.evidence.version,
    contentHash: input.evidence.contentHash,
    capturedAt: input.evidence.capturedAt,
    enrichedAt: input.now.toISOString(),
    // 本次运行填充的字段列表。
...(input.captureOrigin ? { captureOrigin: input.captureOrigin } : {}),
    fields: filled,
    fieldProvenance: {
      schemaVersion: FIELD_PROVENANCE_SCHEMA,
      // 每个字段的真实供给证据（跨运行累积）。
      entries: [...provenanceByField.values()].sort((a, b) =>
        a.field.localeCompare(b.field) || a.evidenceId.localeCompare(b.evidenceId)),
    },
  };
  return { json: JSON.stringify(reference), status, fields: filled };
}

type CaptureFailureClass = "env" | "human" | "permanent" | "retryable";

function classifyCaptureFailure(errorCode: string | null): CaptureFailureClass {
  if (errorCode && HUMAN_ERROR_CODES.has(errorCode)) return "human";
  if (errorCode && PERMANENT_ERROR_CODES.has(errorCode)) return "permanent";
  if (errorCode && ENV_BLOCKED_ERROR_CODES.has(errorCode)) return "env";
  return "retryable";
}

async function runEnrichment(input: {
  context: AccessContext;
  batchId: string;
  limit: number;
  traceId?: string;
  targetAsin?: string | null;
  targetAsins?: ReadonlySet<string> | null;
  forceRecapture?: boolean;
  deps: BatchDetailEnrichmentDeps;
}): Promise<BatchDetailEnrichmentRunResult> {
  const { context, batchId, limit, targetAsin = null, targetAsins = null, forceRecapture = false, traceId: requestedTraceId, deps } = input;
  const store = deps.getStore(context);
  const batch = await store.getBatch(batchId);
  if (!batch) {
    throw new V5CoreError("BATCH_NOT_FOUND", "批次不存在。", 404);
  }
  if (batch.batchStatus === "archived") {
    throw new V5CoreError("BATCH_ARCHIVED", "批次已归档，不能补齐。", 409);
  }
  if (batch.batchStatus === "blocked") {
    throw new V5CoreError("BATCH_BLOCKED", "批次处于 blocked 状态，不能补齐。", 409);
  }
  if (batch.batchStatus !== "ready") {
    throw new V5CoreError("BATCH_NOT_READY", "批次尚未就绪，不能补齐。", 409, true);
  }

  const items = (await store.getBatchItems(batchId))
    .filter((item) => !item.archivedAt && typeof item.asin === "string" && item.asin.trim())
    .filter((item) => !targetAsin || item.asin?.trim().toUpperCase() === targetAsin)
    .filter((item) => !targetAsins || targetAsins.has((item.asin ?? "").trim().toUpperCase()))
    .sort((a, b) => a.ordinal - b.ordinal);
  if (targetAsin && items.length === 0) {
    throw new V5CoreError("ITEM_NOT_IN_BATCH", "目标 ASIN 不属于此商品批次。", 404);
  }

  const results: BatchDetailEnrichmentItemResult[] = [];
  const traceId = requestedTraceId ?? `batch-detail-enrich-${randomUUID()}`;
  let humanAborted = false;
  // 已补齐条目的跳过不计入本轮工作量预算，limit 只约束「实际做了事」的条目数。
  const workDone = () => results.filter((result) => result.status !== "skipped_enriched").length;

  for (const item of items) {
    if (workDone() >= limit || humanAborted) break;
    // 逐 ASIN 停止检查：暂停/中止后不再开始下一件商品，也不发起下一次导航。
    if (await deps.shouldStop?.()) {
      humanAborted = true;
      break;
    }
    const asin = (item.asin as string).trim().toUpperCase();
    const startedAt = deps.now().getTime();

    let reference: Record<string, unknown>;
    try {
      reference = JSON.parse(item.normalizedProductJson) as Record<string, unknown>;
    } catch {
      const result: BatchDetailEnrichmentItemResult = {
        itemId: item.id,
        asin,
        status: "failed_permanent",
        captured: false,
        durationMs: 0,
        errorCode: "REFERENCE_JSON_INVALID",
        evidenceId: null,
        evidenceVersion: null,
      };
      results.push(result);
      await deps.logEvent({ runId: traceId, batchId, result, message: `条目 ${asin} 的 normalizedProductJson 无法解析。` });
      continue;
    }
    const existingEnrichment = readProductBatchDetailEnrichment(reference);
    /**
     * 只有**完整**投影（brand / category / bsr 齐全 = status "enriched"）才允许直接跳过。
     *
     * 根因修复（7 个 captured_partial 被当成已补齐）：partial 只表示「有合法证据但字段不完整」，
     * 直接 skipped_enriched 会让这些商品永远停在部分完成。现在 partial 走补采：
     * 跳过「复用既有证据」这条免导航捷径，真正访问一次详情页；
     * 补采只填 null 字段（buildEnrichedReferenceJson 的 reference.xxx == null 判定），
     * 已有字段与其字段级来源保持不变，因此不会覆盖或重复写入已有效的内容。
     */
    const partialNeedsSupplement = existingEnrichment?.status === "captured_partial" && !forceRecapture;
    if (existingEnrichment && existingEnrichment.status === "enriched" && !forceRecapture) {
      results.push({
        itemId: item.id,
        asin,
        status: "skipped_enriched",
        existingEnrichmentStatus: existingEnrichment.status,
        captured: false,
        durationMs: 0,
        errorCode: null,
        evidenceId: existingEnrichment.evidenceId,
        evidenceVersion: existingEnrichment.evidenceVersion,
        captureOrigin: existingEnrichment.captureOrigin ?? null,
      });
      continue;
    }

    // 已有详情证据 → 跳过采集，仅投影补齐（搜索证据 amazon_search_market 不算详情证据）。
    // captured_partial 例外：必须真实补采，不能被「已有证据」再次短路。
    let evidence = forceRecapture || partialNeedsSupplement
      ? null
      : await resolveDetailEvidence(deps.getSubject, asin, undefined, deps.now());
    let captured = false;

    if (!evidence) {
      const capture = await deps.captureAsin({ context, asin, traceId });
      if (capture.status === "unavailable") {
        throw new V5CoreError(
          "ENV_BLOCKED",
          capture.errorMessage ?? "本地采集环境不可用，整轮补齐已中止（未影响已补齐条目）。",
          409,
          true,
        );
      }
      // 熔断只认明确的真人墙（验证码/登录）。human_required/blocked 若携带非真人错误码
      //（如不存在 ASIN 的 PAGE_CHANGED），按错误码分类继续本轮，不中断不锁键。
      const humanCode = capture.errorCode != null && HUMAN_ERROR_CODES.has(capture.errorCode);
      if (humanCode) {
        const result: BatchDetailEnrichmentItemResult = {
          itemId: item.id,
          asin,
          status: "failed_human",
          captured: false,
          durationMs: deps.now().getTime() - startedAt,
          errorCode: capture.errorCode,
          evidenceId: null,
          evidenceVersion: null,
        };
        results.push(result);
        await deps.logEvent({ runId: traceId, batchId, result, message: `条目 ${asin} 需要人工处理，整轮补齐已熔断。` });
        humanAborted = true;
        break;
      }
      if (capture.status !== "captured" || !capture.capture) {
        const failureClass = classifyCaptureFailure(capture.errorCode);
        if (failureClass === "env") {
          throw new V5CoreError(
            "ENV_BLOCKED",
            capture.errorMessage ?? "出口/市场环境校验失败，整轮补齐已中止（未影响已补齐条目）。",
            409,
            true,
          );
        }
        const result: BatchDetailEnrichmentItemResult = {
          itemId: item.id,
          asin,
          status: failureClass === "permanent" ? "failed_permanent" : "failed_retryable",
          captured: false,
          durationMs: deps.now().getTime() - startedAt,
          errorCode: capture.errorCode ?? "CAPTURE_FAILED",
          evidenceId: null,
          evidenceVersion: null,
        };
        results.push(result);
        await deps.logEvent({ runId: traceId, batchId, result, message: `条目 ${asin} 采集失败：${result.errorCode}` });
        continue;
      }
      captured = true;
      evidence = await resolveDetailEvidence(deps.getSubject, asin, capture.capture.capturedAt, deps.now());
      if (!evidence) {
        // 证据已落库但读回失败：fail-closed 记为可重试（下一轮 FRESH 路径可补投影）。
        const result: BatchDetailEnrichmentItemResult = {
          itemId: item.id,
          asin,
          status: "failed_retryable",
          captured: true,
          durationMs: deps.now().getTime() - startedAt,
          errorCode: "EVIDENCE_NOT_RESOLVED",
          evidenceId: null,
          evidenceVersion: null,
        };
        results.push(result);
        await deps.logEvent({ runId: traceId, batchId, result, message: `条目 ${asin} 证据已采集但读回失败，下一轮可补投影。` });
        continue;
      }
    }

    const fact = deps.factFromEvidence(evidence);
    const enriched = buildEnrichedReferenceJson({
      reference,
      fact,
      evidence,
      captureOrigin: captured ? "CAPTURED_NOW" : "REUSED_VALID_EVIDENCE",
      now: deps.now(),
    });
    await store.updateBatchItemEnrichment(batchId, item.id, {
      normalizedProductJson: enriched.json,
    });
    const result: BatchDetailEnrichmentItemResult = {
      itemId: item.id,
      asin,
      status: enriched.status,
      captured,
      durationMs: deps.now().getTime() - startedAt,
      errorCode: null,
      evidenceId: evidence.evidenceId,
      evidenceVersion: evidence.version,
      captureOrigin: captured ? "CAPTURED_NOW" : "REUSED_VALID_EVIDENCE",
    };
    results.push(result);
    await deps.logEvent({
      runId: traceId,
      batchId,
      result,
      message: `条目 ${asin} 补齐完成（${enriched.fields.length ? enriched.fields.join("/") : "无新增字段"}）。`,
    });
  }

  const counted = results.filter((result) => result.status !== "skipped_enriched");
  const durations = counted.map((result) => result.durationMs).sort((a, b) => a - b);
  const total = counted.length;
  const summary = {
    total,
    captured: counted.filter((result) => result.captured).length,
    enriched: counted.filter((result) => result.status === "enriched").length,
    capturedPartial: counted.filter((result) => result.status === "captured_partial").length,
    failedRetryable: counted.filter((result) => result.status === "failed_retryable").length,
    failedPermanent: counted.filter((result) => result.status === "failed_permanent").length,
    failedHuman: counted.filter((result) => result.status === "failed_human").length,
    skippedEnriched: results.length - counted.length,
    humanAborted,
  };
  const failures = summary.failedRetryable + summary.failedPermanent + summary.failedHuman;
  return {
    traceId,
    summary,
    items: results,
    timings: {
      avgMs: total > 0 ? Math.round(durations.reduce((sum, value) => sum + value, 0) / total) : 0,
      // 最近邻秩 P95：N 小（MVP=5）时近似最大值，仅作记录基线。
      p95Ms: total > 0 ? durations[Math.min(durations.length, Math.max(1, Math.ceil(0.95 * total))) - 1] ?? 0 : 0,
      failureRate: total > 0 ? Number((failures / total).toFixed(4)) : 0,
    },
  };
}

export async function enrichBatchWithAmazonDetail(input: {
  context: AccessContext;
  batchId: unknown;
  limit: unknown;
  targetAsin?: unknown;
  targetAsins?: unknown;
  forceRecapture?: boolean;
  traceId?: string;
  idempotencyKey: string;
  deps?: BatchDetailEnrichmentDeps;
  /** 受控停止检查（由 BatchCaptureRun 注入）；返回 true 时 Worker 立即停止领取新工作。 */
  shouldStop?: unknown;
}): Promise<{ value: BatchDetailEnrichmentRunResult; replayed: boolean; receiptId: string }> {
  if (input.context.mode !== "owner") {
    throw new V5CoreError("FORBIDDEN", "当前主体不允许执行批次详情补齐。", 403);
  }
  const batchId = normalizeBatchId(input.batchId);
  const limit = normalizeLimit(input.limit);
  const targetAsin = normalizeTargetAsin(input.targetAsin);
  const targetAsins = normalizeTargetAsins(input.targetAsins);
  const forceRecapture = input.forceRecapture === true;
  if (forceRecapture && !targetAsin) {
    throw new V5CoreError("TARGET_ASIN_REQUIRED", "强制重采详情时必须指定 targetAsin。", 400);
  }
  const baseDeps = input.deps ?? defaultDeps();
  const deps: BatchDetailEnrichmentDeps = typeof input.shouldStop === "function"
    ? { ...baseDeps, shouldStop: input.shouldStop as () => Promise<boolean> | boolean }
    : baseDeps;
  return withV5Receipt({
    context: input.context,
    operation: ENRICHMENT_OPERATION,
    resourceKey: batchId,
    idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
    requestBody: { batchId, limit, targetAsin, targetAsins: targetAsins ? [...targetAsins].sort() : null, forceRecapture },
    execute: () => runEnrichment({ context: input.context, batchId, limit, targetAsin, targetAsins, forceRecapture, traceId: input.traceId, deps }),
  });
}
