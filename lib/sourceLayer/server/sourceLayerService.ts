import "server-only";

/**
 * Product Source Layer V1.2 — 服务编排（Phase 7 接入现有流程）
 *
 * 唯一合法链路：
 *   Source Adapter → Capture Package → Evidence Store → Validator
 *   → READY_FOR_RESEARCH → Product Batch / Candidate → Research Task
 *
 * 边界：
 * - 本模块不修改现有 Research 流程；交接时只使用既有 SellerSprite Candidate
 *   契约（sellersprite_candidate_source_v1）建立候选，使其无需改动即可开始研究；
 * - 采集数据永远不会直接变成 Confirmed Fact：事实仍需在任务内由人工确认；
 * - 校验不通过的产品一律不得进入研究池（fail-closed）。
 *
 * 纯编排：无网络请求、无外部抓取。
 */
import { randomUUID } from "node:crypto";

import "@/lib/sourceLayer/adapters";
import { readProductBatchItemImageSnapshot } from "@/lib/productBatchImagePresentation";
import { getProductBatchStore } from "@/lib/server/productBatchStoreResolver";
import {
  buildSellerSpriteCandidateSourceMeta,
  computeSellerSpriteRowHash,
  isCompleteInlineImageReference,
  isHttpsImageReference,
  type SellerSpriteImportRow,
  type SellerSpritePluginCapture,
  type SellerSpriteImportSummary,
} from "@/lib/server/sellerSpriteImportContract";
import { importSellerSpriteCandidates } from "@/lib/server/sellerSpriteCandidateImport";
import {
  contentHashOf,
  getSourceAdapter,
  type CaptureEvidenceRecord,
  type SourceAdapter,
} from "@/lib/sourceLayer/sourceAdapter";
import {
  defaultCaptureMethodFor,
  type CaptureEntityBindingProof,
  type CapturePackageDraft,
  type CaptureSourceType,
} from "@/lib/sourceLayer/capturePackage";
import type { AuditEntryInput } from "@/lib/sourceLayer/auditLog";
import { createSourceLayerError, type SourceLayerErrorCode } from "@/lib/sourceLayer/errorCodes";
import {
  createCaptureLifecycle,
  transitionCapture,
  type CaptureLifecycle,
  type CaptureLifecycleState,
} from "@/lib/sourceLayer/stateMachine";
import {
  targetStateForVerdict,
  validationAuditEntries,
  type CaptureValidationReport,
} from "@/lib/sourceLayer/validator";
import {
  createEvidenceStore,
  type EvidenceStore,
  type EvidenceSubjectIndexEntry,
} from "@/lib/sourceLayer/server/evidenceStore";
import type { AccessContext } from "@/lib/server/accessPassword";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import { adaptEvidenceToProductFact } from "@/lib/sourceLayer/fact/productFactAdapter";
import type { CategoryMarketCaptureBatch } from "@/lib/sourceLayer/categoryMarketCapture";
import { newSpanId, newTraceId } from "@/lib/sourceLayer/diagnostics";
import { recordDiagnosticEvent } from "@/lib/sourceLayer/server/diagnosticService";
import {
  sellerSpriteProductFactExtensionsFromSnapshot,
} from "@/lib/sourceLayer/adapters/sellerSpriteAdapter";

export const SOURCE_LAYER_INGEST_SCHEMA = "source-layer-ingest-result.v1" as const;

/** 「从商品批次接入」单次上限：避免一次请求把整个批次写进证据库。 */
export const MAX_PRODUCT_BATCH_BRIDGE_ITEMS = 50;

export type SourceLayerIngestError = {
  code: string;
  message: string;
  itemIndex: number | null;
};

export type SourceLayerCaptureItem = {
  traceId?: string;
  captureId: string;
  subjectKey: string;
  version: number;
  created: boolean;
  duplicate: boolean;
  state: CaptureLifecycleState;
  readyForResearch: boolean;
  verdict: CaptureValidationReport["verdict"];
  title: string | null;
  asin: string | null;
  price: { amount: number; currency: string } | null;
  rating: number | null;
  reviewCount: number | null;
  brand?: string | null;
  bsr: { rank: number; category: string | null } | null;
  subCategoryBsr?: number | null;
  estimatedMonthlySales?: number | null;
  estimatedMonthlyRevenueUsd?: number | null;
  imageCount: number;
  keywords: string[];
  fieldStates: CaptureEvidenceRecord["pkg"]["fieldStates"];
  riskFlags: string[];
  issues: Array<{
    code: string;
    severity: string;
    field: string | null;
    hint: string;
  }>;
  /** 审计时间线（最近 N 条，供 UI 展示「为什么失败」）。 */
  auditTail: Array<{
    sequence: number;
    eventKind: string;
    previousState: string | null;
    nextState: string | null;
    reason: string;
    timestamp: string;
    errorCode: string | null;
  }>;
  /** 状态机拒绝的跃迁（正常情况下为空；非空说明流程被门禁拦下）。 */
  transitionErrors: SourceLayerIngestError[];
  contentHash: string;
};

export type SourceLayerIngestResult = {
  schemaVersion: typeof SOURCE_LAYER_INGEST_SCHEMA;
  operator: string;
  sourceType: CaptureSourceType;
  adapterLabel: string;
  capturedAt: string;
  pageDigest: string;
  totalDrafts: number;
  quarantinedCount: number;
  readyCount: number;
  reviewCount: number;
  blockedCount: number;
  /** 采集阶段错误码（如 SELECTOR_FAILED），已全部写入审计。 */
  captureErrorCodes: string[];
  items: SourceLayerCaptureItem[];
  errors: SourceLayerIngestError[];
  traceId: string;
};

export class SourceLayerServiceError extends Error {
  constructor(
    public readonly code:
      | "adapter_not_found"
      | "source_type_unsupported"
      | "payload_missing"
      | "no_capturable_records"
      | "candidate_selection_empty"
      | "candidate_not_ready"
      | "source_retry_not_allowed",
    message: string,
  ) {
    super(message);
    this.name = "SourceLayerServiceError";
  }
}

function operatorOf(context: AccessContext): string {
  return context.mode === "owner" ? "owner:v1" : `visitor:${context.demoAccessId}`;
}

export function sourceLayerOperator(context: AccessContext): string {
  return operatorOf(context);
}

function blockedValueOrigin(sourceType: CaptureSourceType): "page_measured" | "provider_export" | "human_manual" {
  if (sourceType === "amazon_dom" || sourceType === "browser_agent") return "page_measured";
  if (sourceType === "manual_entry") return "human_manual";
  return "provider_export";
}

/**
 * 阻断页也必须留下可复盘的零字段 Evidence：不能因为没有可提取字段就
 * 静默丢失登录墙、验证码或页面改版事件。所有业务字段明确为 null/[]，
 * 并由 Validator 根据 captureErrorCodes 进入 HUMAN_REQUIRED/RETRYABLE。
 */
function emptyDraftForBlockedCapture(input: {
  subjectKey: string;
  marketplace: string;
  sourceType: CaptureSourceType;
  sourceUrl: string | null;
  capturedAt: string;
  operator: string;
  entityBinding?: CaptureEntityBindingProof | null;
}): CapturePackageDraft {
  const valueOrigin = blockedValueOrigin(input.sourceType);
  const field = <T>(value: T, name: string) => ({
    value,
    valueOrigin,
    metricNature: "unknown" as const,
    sourceRef: `blocked_page.${name}`,
    confidence: 0,
  });
  return {
    subjectKey: input.subjectKey,
    marketplace: input.marketplace,
    fields: {
      asin: field(null, "asin"),
      title: field(null, "title"),
      brand: field(null, "brand"),
      images: field([], "images"),
      price: field(null, "price"),
      rating: field(null, "rating"),
      reviewCount: field(null, "reviewCount"),
      bsr: field(null, "bsr"),
      subCategoryBsr: field(null, "subCategoryBsr"),
      estimatedMonthlySales: field(null, "estimatedMonthlySales"),
      estimatedMonthlyRevenueUsd: field(null, "estimatedMonthlyRevenueUsd"),
      keywords: field([], "keywords"),
    },
    sourceProof: {
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl,
      capturedAt: input.capturedAt,
      captureMethod: defaultCaptureMethodFor(input.sourceType),
      operator: input.operator,
      sourceFingerprint: null,
      sourceRecordRef: null,
      ...(input.entityBinding ? { entityBinding: input.entityBinding } : {}),
    },
    replay: {
      url: input.sourceUrl,
      capturedAt: input.capturedAt,
      pageDigest: `blocked_page;source=${input.sourceType}`,
      warnings: ["page_fields_discarded_before_evidence"],
    },
  };
}

function blankDraftForBlockedCapture(input: {
  draft: CapturePackageDraft;
  sourceType: CaptureSourceType;
  sourceUrl: string | null;
  pageContext: {
    pageClass: string;
    reason?: string | null;
    entityBinding?: CaptureEntityBindingProof | null;
  };
}): CapturePackageDraft {
  const empty = emptyDraftForBlockedCapture({
    subjectKey: input.draft.subjectKey,
    marketplace: input.draft.marketplace,
    sourceType: input.sourceType,
    sourceUrl: input.sourceUrl ?? input.draft.sourceProof.sourceUrl,
    capturedAt: input.draft.sourceProof.capturedAt,
    operator: input.draft.sourceProof.operator,
    entityBinding: input.pageContext.entityBinding ?? input.draft.sourceProof.entityBinding ?? null,
  });
  return {
    ...empty,
    replay: {
      ...empty.replay,
      pageDigest: `blocked_page;class=${input.pageContext.pageClass}`,
      warnings: [
        ...empty.replay.warnings,
        ...(input.pageContext.reason ? [input.pageContext.reason] : []),
      ],
    },
  };
}

function auditTail(lifecycle: CaptureLifecycle, limit = 8): SourceLayerCaptureItem["auditTail"] {
  return lifecycle.audit.slice(-limit).map((entry) => ({
    sequence: entry.sequence,
    eventKind: entry.eventKind,
    previousState: entry.previousState,
    nextState: entry.nextState,
    reason: entry.reason,
    timestamp: entry.timestamp,
    errorCode: entry.errorCode,
  }));
}

/** 采集阶段错误码 → 审计条目（统一入口，保证两条采集路径行为一致）。 */
function captureErrorAuditEntries(input: {
  errorCodes: readonly SourceLayerErrorCode[];
  captureId: string;
  subjectKey: string;
  timestamp: string;
  operator: string;
}): AuditEntryInput[] {
  return input.errorCodes.map((code) => ({
    eventKind: "error" as const,
    reason: `采集阶段错误：${code}`,
    timestamp: input.timestamp,
    captureId: input.captureId,
    subjectKey: input.subjectKey,
    operator: input.operator,
    error: createSourceLayerError(code),
  }));
}

/**
 * 单个草稿的完整链路：状态机 → Capture Package → Validator → Evidence Store → 审计。
 *
 * 「重新采集」与「从既有 Product Batch 接入」两条入口共用这一个实现，
 * 保证两条路径的状态机、校验、版本与审计行为完全一致（不会各写一套）。
 */
async function captureDraftToEvidence(input: {
  draft: CapturePackageDraft;
  adapter: SourceAdapter;
  store: EvidenceStore;
  operator: string;
  now: Date;
  capturedAt: string;
  captureErrorCodes: readonly SourceLayerErrorCode[];
  auditDetail: Record<string, unknown>;
  traceId: string;
}): Promise<SourceLayerCaptureItem> {
  const { draft, adapter, store, operator, now } = input;
  const captureId = `cap-${randomUUID()}`;
  const existing = await store.getSubject(draft.subjectKey);
  const previousPackages = existing?.versions.map((item) => item.pkg) ?? [];

  let lifecycle = createCaptureLifecycle({
    captureId,
    subjectKey: draft.subjectKey,
    createdAt: input.capturedAt,
    operator,
    detail: input.auditDetail,
  });
  const transitionErrors: SourceLayerIngestError[] = [];
  const advance = (
    to: CaptureLifecycleState,
    reason: string,
    extra: { errorCode?: Parameters<typeof transitionCapture>[0]["errorCode"] } = {},
  ): void => {
    const result = transitionCapture({
      lifecycle,
      to,
      reason,
      timestamp: new Date().toISOString(),
      operator,
      errorCode: extra.errorCode ?? null,
    });
    if (result.ok) {
      lifecycle = result.lifecycle;
    } else {
      transitionErrors.push({ code: result.error.code, message: result.error.message, itemIndex: null });
    }
  };

  advance("SOURCE_CHECKING", "检查来源可信度");
  advance("CAPTURE_RUNNING", `来源采集完成（${adapter.label}）`);
  advance("NORMALIZING", "归一化为 Capture Package");

  // 归一化：版本号由 Evidence Store 分配；首次采集为 v1。
  const version = (existing?.versions.at(-1)?.version ?? 0) + 1;
  const pkg = adapter.normalize({ draft, captureId, version });

  advance("EVIDENCE_VALIDATING", "进入证据校验");
  const outcome = adapter.validate({
    pkg,
    context: { now, previousPackages, captureErrorCodes: input.captureErrorCodes },
  });
  const { pkg: validatedPkg, report } = outcome;

  advance(targetStateForVerdict(report), `校验结论：${report.verdict}`, {
    errorCode: report.issues.find((item) => item.error.severity === "blocking")?.error.code ?? null,
  });
  const evidence = adapter.createEvidence({ pkg: validatedPkg, report });
  const evidenceWithState: CaptureEvidenceRecord = {
    ...evidence,
    validation: {
      ...evidence.validation,
      captureState: lifecycle.state,
      stateEnteredAt: lifecycle.stateEnteredAt,
      captureErrorCodes: [...input.captureErrorCodes],
    },
  };
  const validationEntries = validationAuditEntries({ report, operator, captureId, subjectKey: draft.subjectKey })
    .map((entry) => ({
      ...entry,
      module: "VALIDATOR",
      phase: "validate",
      eventType: entry.eventType ?? entry.eventKind,
    }));
  const lifecycleEntries = lifecycle.audit.map((entry) => ({
    ...entry,
    module: "ORCHESTRATOR",
    phase: "capture",
    eventType: entry.eventType ?? entry.eventKind,
  }));
  const captureErrorEntries = captureErrorAuditEntries({
      errorCodes: input.captureErrorCodes,
      captureId,
      subjectKey: draft.subjectKey,
      timestamp: input.capturedAt,
      operator,
    }).map((entry) => ({
      ...entry,
      module: "EXTRACTOR",
      phase: "extract",
      eventType: entry.eventType ?? entry.eventKind,
    }));
  const traceAuditEntries = [
    ...validationEntries,
    ...lifecycleEntries,
    ...captureErrorEntries,
  ].map((entry) => ({
    ...entry,
    traceId: input.traceId,
    module: entry.module ?? "SOURCE_LAYER",
    phase: entry.phase ?? "capture",
    eventType: entry.eventType ?? entry.eventKind,
    sourceType: draft.sourceProof.sourceType,
  }));

  const stored = await store.appendEvidence({
    evidence: evidenceWithState,
    auditEntries: traceAuditEntries,
    operator,
    now,
    trace: {
      traceId: input.traceId,
      module: "SOURCE_LAYER",
      phase: "persist",
      eventType: "evidence_persisted",
      sourceType: draft.sourceProof.sourceType,
      contentHash: evidenceWithState.contentHash,
    },
  });

  const storedEvidence = stored.record.versions.find((item) => item.version === stored.version)
    ?? evidenceWithState;
  const audit = await store.getAudit(draft.subjectKey);
  return {
    traceId: input.traceId,
    captureId,
    subjectKey: draft.subjectKey,
    version: stored.version,
    created: stored.created,
    duplicate: stored.duplicate,
    state: storedEvidence.validation.captureState ?? lifecycle.state,
    readyForResearch: report.readyForResearch && storedEvidence.validation.readyForResearch,
    verdict: storedEvidence.validation.verdict,
    title: validatedPkg.fields.title,
    asin: validatedPkg.fields.asin,
    brand: validatedPkg.fields.brand,
    price: validatedPkg.fields.price,
    rating: validatedPkg.fields.rating,
    reviewCount: validatedPkg.fields.reviewCount,
    bsr: validatedPkg.fields.bsr,
    subCategoryBsr: validatedPkg.fields.subCategoryBsr,
    estimatedMonthlySales: validatedPkg.fields.estimatedMonthlySales,
    estimatedMonthlyRevenueUsd: validatedPkg.fields.estimatedMonthlyRevenueUsd,
    imageCount: validatedPkg.fields.images.length,
    keywords: validatedPkg.fields.keywords,
    fieldStates: validatedPkg.fieldStates,
    riskFlags: validatedPkg.riskFlags,
    issues: report.issues.map((item) => ({
      code: item.error.code,
      severity: item.error.severity,
      field: item.field,
      hint: item.hint,
    })),
    auditTail: auditTail({ ...lifecycle, audit }),
    transitionErrors,
    contentHash: storedEvidence.contentHash,
  };
}

/**
 * 采集入口：Adapter → Capture Package → Validator → 状态机 → Evidence Store。
 * 每个草稿独立走一遍状态机，因此单条商品失败不会污染同批次其他商品。
 */
export async function ingestSourceCapture(input: {
  context: AccessContext;
  sourceType: CaptureSourceType;
  payload: unknown;
  now?: Date;
  sourceUrl?: string | null;
  sourceFingerprint?: string | null;
  /** 目标身份由调用方已知时用于保存停止页/登录墙的零字段失败证据。 */
  subjectKey?: string | null;
  marketplace?: string | null;
  pageContext?: {
    pageClass: string;
    allowFields: boolean;
    errorCode?: SourceLayerErrorCode | null;
    reason?: string | null;
    subjectKey?: string | null;
    marketplace?: string | null;
    entityBinding?: import("@/lib/sourceLayer/capturePackage").CaptureEntityBindingProof | null;
  };
  store?: EvidenceStore;
  traceId?: string;
}): Promise<SourceLayerIngestResult> {
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("source_layer_time_invalid");
  const adapter = getSourceAdapter(input.sourceType);
  if (!adapter) {
    throw new SourceLayerServiceError(
      "adapter_not_found",
      "该来源类型尚未接入 Adapter，无法采集。",
    );
  }
  if (input.payload === undefined || input.payload === null) {
    throw new SourceLayerServiceError("payload_missing", "请提供来源数据。");
  }
  const operator = operatorOf(input.context);
  const traceId = input.traceId ?? newTraceId();
  const capturedAt = now.toISOString();
  const store = input.store ?? createEvidenceStore(operator);

  const captured = adapter.capture({
    payload: input.payload,
    capturedAt,
    operator,
    sourceUrl: input.sourceUrl ?? null,
    sourceFingerprint: input.sourceFingerprint ?? null,
    pageContext: input.pageContext,
  });
  const captureErrorCodes = [
    ...captured.errorCodes,
    ...(input.pageContext?.errorCode ? [input.pageContext.errorCode] : []),
  ] as SourceLayerErrorCode[];
  const pageContext = input.pageContext;
  const drafts = pageContext && pageContext.allowFields === false
    ? (captured.drafts.length > 0
      ? captured.drafts.map((draft) => blankDraftForBlockedCapture({
        draft,
        sourceType: input.sourceType,
        sourceUrl: input.sourceUrl ?? null,
        pageContext,
      }))
      : (pageContext.subjectKey || input.subjectKey
        ? [blankDraftForBlockedCapture({
          draft: emptyDraftForBlockedCapture({
            subjectKey: pageContext.subjectKey ?? input.subjectKey ?? "",
            marketplace: pageContext.marketplace ?? input.marketplace ?? "US",
            sourceType: input.sourceType,
            sourceUrl: input.sourceUrl ?? null,
            capturedAt,
            operator,
            entityBinding: pageContext.entityBinding ?? null,
          }),
          sourceType: input.sourceType,
          sourceUrl: input.sourceUrl ?? null,
          pageContext,
        })]
        : []))
    : captured.drafts;
  if (drafts.length === 0) {
    throw new SourceLayerServiceError(
      "no_capturable_records",
      captureErrorCodes.length > 0
        ? "来源数据未通过采集检查，没有可用的商品记录。"
        : "来源数据中没有可采集的商品记录。",
    );
  }

  const items: SourceLayerCaptureItem[] = [];
  const errors: SourceLayerIngestError[] = [];

  for (const [index, draft] of drafts.entries()) {
    try {
      const item = await captureDraftToEvidence({
        draft,
        adapter,
        store,
        operator,
        now,
        capturedAt,
        captureErrorCodes,
        auditDetail: {
          sourceType: input.sourceType,
          ...(input.pageContext ? { pageClass: input.pageContext.pageClass } : {}),
          ...(input.pageContext?.reason ? { pageReason: input.pageContext.reason } : {}),
        },
        traceId,
      });
      items.push(item);
      for (const transitionError of item.transitionErrors) {
        errors.push({ ...transitionError, itemIndex: index });
      }
    } catch (error) {
      errors.push({
        code: error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "INTERNAL_UNEXPECTED",
        message: error instanceof Error ? error.message : "采集条目处理失败。",
        itemIndex: index,
      });
    }
  }

  const readyCount = items.filter((item) => item.readyForResearch).length;
  if (captured.quarantinedCount > 0) {
    await recordDiagnosticEvent({ context: input.context, event: { traceId, spanId: newSpanId(),
      parentSpanId: null, taskId: null, captureId: null, statusBefore: null, statusAfter: "blocked",
      subjectKey: input.subjectKey ?? `quarantine:${traceId}`, module: "SOURCE_LAYER", phase: "capture",
      eventType: "observations_quarantined", severity: "warning", status: "blocked",
      sourceType: input.sourceType, reason: `已隔离 ${captured.quarantinedCount} 条来源观测，未进入商品事实。`,
      errorCode: captureErrorCodes[0] ?? "INVALID_FORMAT", retryable: false, humanRequired: true,
      evidenceRefs: [], contentHash: null,
      recipeVersion: null, pageTemplateHash: null, jevRole: "none", jevModelVersion: null,
      jevPromptVersion: null, jevConfidence: null, durationMs: null, attempt: 1,
    } });
  }
  return {
    schemaVersion: SOURCE_LAYER_INGEST_SCHEMA,
    operator,
    sourceType: input.sourceType,
    adapterLabel: adapter.label,
    capturedAt,
    pageDigest: captured.pageDigest,
    totalDrafts: drafts.length,
    quarantinedCount: captured.quarantinedCount,
    readyCount,
    reviewCount: items.filter((item) => item.verdict === "needs_review").length,
    blockedCount: items.filter((item) => item.verdict === "blocked").length,
    captureErrorCodes: [...captureErrorCodes],
    items,
    errors,
    traceId,
  };
}

/**
 * HUMAN_REQUIRED / RETRYABLE 的显式恢复入口。
 * 不自动重放、不绕过人工门禁；调用方必须重新提交本次来源载荷，
 * 服务端只确认当前主体确实存在可恢复的最近版本，并继续复用同一条入口。
 */
export async function retrySourceCapture(
  input: Parameters<typeof ingestSourceCapture>[0] & { subjectKey: string },
): Promise<SourceLayerIngestResult> {
  const operator = operatorOf(input.context);
  const traceId = input.traceId ?? newTraceId();
  const store = input.store ?? createEvidenceStore(operator);
  const current = await store.getSubject(input.subjectKey);
  const latest = current?.versions.at(-1) ?? null;
  if (!latest) {
    throw new SourceLayerServiceError(
      "source_retry_not_allowed",
      "没有可恢复的来源采集记录，请从新的采集入口开始。",
    );
  }
  if (latest.sourceType !== input.sourceType) {
    throw new SourceLayerServiceError(
      "source_retry_not_allowed",
      "恢复来源与原采集来源不一致，请从新的采集入口开始。",
    );
  }
  const state = latest.validation.captureState;
  if (state !== "RETRYABLE" && state !== "HUMAN_REQUIRED") {
    throw new SourceLayerServiceError(
      "source_retry_not_allowed",
      "当前来源状态不允许重试；只有 RETRYABLE 或 HUMAN_REQUIRED 可由人工显式恢复。",
    );
  }
  return ingestSourceCapture(input);
}

export async function listSourceEvidence(context: AccessContext): Promise<{
  operator: string;
  subjects: EvidenceSubjectIndexEntry[];
}> {
  const operator = operatorOf(context);
  const store = createEvidenceStore(operator);
  return { operator, subjects: await store.listSubjects() };
}

export async function getLatestCategoryMarketCapture(context: AccessContext): Promise<{
  subjectKey: string;
  batch: CategoryMarketCaptureBatch;
} | null> {
  const store = createEvidenceStore(operatorOf(context));
  return store.getLatestCategoryMarketCapture?.() ?? null;
}

export async function getSourceEvidenceDetail(
  context: AccessContext,
  subjectKey: string,
): Promise<{
  subject: Awaited<ReturnType<EvidenceStore["getSubject"]>>;
  audit: Awaited<ReturnType<EvidenceStore["getAudit"]>>;
}> {
  const operator = operatorOf(context);
  const store = createEvidenceStore(operator);
  const [subject, audit] = await Promise.all([
    store.getSubject(subjectKey),
    store.getAudit(subjectKey),
  ]);
  return { subject, audit };
}

/* ── 交接：READY_FOR_RESEARCH → Candidate（复用既有 SellerSprite 候选契约） ── */

/**
 * 把已通过校验的采集记录交接为研究候选。
 *
 * 关键设计：复用既有 `sellersprite_candidate_source_v1` 契约与既有
 * `importSellerSpriteCandidates` 服务，因此：
 * - 不需要修改 Research 架构或资格判定；
 * - Candidate 进入既有商品研究队列，可直接开始研究；
 * - 采集证据以 evidence-only 形式挂在 sourceMeta.captureEvidence 下，
 *   明确声明它只是证据，不是已确认事实。
 */
export async function handoffCapturesToResearch(input: {
  context: AccessContext;
  subjectKeys: readonly string[];
  now?: Date;
  /** Gateway 生成的 ProductFact；缺省时保留旧 handoff 行为。 */
  productFactsBySubjectKey?: ReadonlyMap<string, ProductFact>;
  /** 保留 SellerSprite 插件旧 sourceMeta 中的附加捕获指标。 */
  pluginCapturesBySubjectKey?: ReadonlyMap<string, SellerSpritePluginCapture>;
  /** 插件来源的原始行身份；用于保持既有 rowHash / productUrl 幂等契约。 */
  sourceRowsBySubjectKey?: ReadonlyMap<string, SellerSpriteImportRow>;
  /** 外部来源文件/插件批次指纹；缺省时使用 Evidence 集合指纹。 */
  sourceFileSha256?: string;
}): Promise<{
  summary: SellerSpriteImportSummary;
  evidenceOnlyNote: string;
  productBatchId: string | null;
}> {
  const now = input.now ?? new Date();
  const operator = operatorOf(input.context);
  const store = createEvidenceStore(operator);
  const subjects = await store.listSubjects();
  const known = new Map(subjects.map((item) => [item.subjectKey, item]));
  const requested = [...new Set(input.subjectKeys)];
  if (requested.length === 0) {
    throw new SourceLayerServiceError("candidate_selection_empty", "请先选择要进入研究池的商品。");
  }

  const rows: SellerSpriteImportRow[] = [];
  const evidenceByRowHash = new Map<string, { captureId: string; version: number; contentHash: string; riskFlags: string[] }>();

  for (const subjectKey of requested) {
    const indexEntry = known.get(subjectKey);
    if (!indexEntry) {
      throw new SourceLayerServiceError("candidate_not_ready", "该商品没有可用的来源证据。");
    }
    const subject = await store.getSubject(subjectKey);
    const latest = subject?.versions.at(-1) ?? null;
    if (!latest) {
      throw new SourceLayerServiceError("candidate_not_ready", "该商品没有可用的来源证据。");
    }
    if (!latest.validation.readyForResearch || latest.validation.verdict !== "passed") {
      throw new SourceLayerServiceError(
        "candidate_not_ready",
        "该校验未通过的商品不能进入研究池，请先处理阻断项。",
      );
    }
    const pkg = latest.pkg;
    if (!pkg.fields.asin || !pkg.fields.title) {
      throw new SourceLayerServiceError("candidate_not_ready", "该商品缺少 ASIN 或标题，不能进入研究池。");
    }
    const sourceRow = input.sourceRowsBySubjectKey?.get(subjectKey);
    const amazonUrl = sourceRow?.amazonUrl ?? pkg.sourceProof.sourceUrl;
    if (!amazonUrl || !isAmazonProductUrlFor(amazonUrl, pkg.fields.asin)) {
      throw new SourceLayerServiceError("candidate_not_ready", "证据缺少绑定到该商品的已观察 Amazon 链接，不能伪造交接链接。");
    }
    const rowHash = sourceRow?.rowHash ?? computeSellerSpriteRowHash({
      rowNumber: 1,
      asin: pkg.fields.asin,
      title: pkg.fields.title,
      amazonUrl,
    });
    const bsrRank = typeof pkg.fields.bsr?.rank === "number" && Number.isFinite(pkg.fields.bsr.rank)
      ? pkg.fields.bsr.rank
      : null;
    const keywordsList = Array.isArray(pkg.fields.keywords) ? [...pkg.fields.keywords] : [];
    const keywordText = keywordsList.filter(Boolean).join(", ") || null;
    rows.push({
      rowHash,
      rowNumber: sourceRow?.rowNumber ?? 1,
      asin: pkg.fields.asin,
      parentAsin: sourceRow?.parentAsin ?? null,
      title: pkg.fields.title,
      amazonUrl,
      // 主图：公网 https 直链优先；其次接受「完整可用」的内嵌图片
      // （XLSX 内嵌图 / 批次缓存主图）。被截断或损坏的内嵌图片一律丢弃：
      // 放行一张坏图比没有图更糟（浏览器实测无法解码，Studio 也无法抓取）。
      imageUrl: pkg.fields.images.find((url) => isHttpsImageReference(url))
        ?? pkg.fields.images.find((url) => isCompleteInlineImageReference(url))
        ?? null,
      priceUsd: pkg.fields.price?.amount ?? null,
      rating: pkg.fields.rating,
      reviewCount: pkg.fields.reviewCount,
      brand: pkg.fields.brand ?? null,
      category: pkg.fields.bsr?.category ?? null,
      // 大类 BSR 显式写进专用字段（这是 BSR，不是搜索排名）；
      // searchRank 继续写入同一数值，仅为兼容既有读取方，读取方必须优先新字段。
      rootCategoryBsr: bsrRank,
      searchRank: bsrRank,
      subCategoryBsr: typeof pkg.fields.subCategoryBsr === "number" && Number.isFinite(pkg.fields.subCategoryBsr)
        ? pkg.fields.subCategoryBsr
        : null,
      keyword: keywordText,
      estimatedMonthlySales: pkg.fields.estimatedMonthlySales ?? null,
      estimatedMonthlyRevenueUsd: pkg.fields.estimatedMonthlyRevenueUsd ?? null,
      detailAttributesRaw: null,
      skuRaw: null,
      sellingPointsRaw: null,
      // 证据引用（evidence only）：明确声明这不是已确认事实。
      sourceLayerCapture: {
        captureId: pkg.captureId,
        version: latest.version,
        contentHash: latest.contentHash,
        sourceType: pkg.sourceProof.sourceType,
        capturedAt: pkg.sourceProof.capturedAt,
        riskFlags: [...pkg.riskFlags],
        factAuthority: "evidence_only",
        keywords: keywordsList,
      },
      // ProductFact 是 Source Layer → Research 的正式事实投影：
      // 没有调用方覆盖值时，直接从本次 handoff 选中的最新 Evidence 做结构映射。
      // 该适配器不推测、不补值；缺失字段保持 missing/null，且 sourceProof 绑定同一版本。
      productFact: input.productFactsBySubjectKey?.get(subjectKey)
        ?? adaptEvidenceToProductFact({ evidence: latest }),
      pluginCapture: input.pluginCapturesBySubjectKey?.get(subjectKey)
        ?? sourceRow?.pluginCapture
        ?? null,
    });
    evidenceByRowHash.set(rowHash, {
      captureId: pkg.captureId,
      version: latest.version,
      contentHash: latest.contentHash,
      riskFlags: pkg.riskFlags,
    });
  }

  const summary = await importSellerSpriteCandidates({
    context: input.context,
    rows,
    // 既有契约要求 64 位十六进制文件指纹；这里使用本次交接证据集合的内容指纹，
    // 保证相同证据重复交接得到相同指纹（去重语义与既有 XLSX 导入一致）。
    sourceFileSha256: input.sourceFileSha256
      ?? sourceLayerFingerprint(rows.map((row) => evidenceByRowHash.get(row.rowHash)?.contentHash ?? "")),
    importedAt: now.toISOString(),
  });

  const handoffTraceId = newTraceId();
  const createdCandidateIds = new Map(summary.created.map((item) => [item.rowHash, item.candidateId]));
  for (const row of rows) {
    const evidence = evidenceByRowHash.get(row.rowHash);
    if (!evidence) continue;
    await recordDiagnosticEvent({
      context: input.context,
      event: {
        traceId: handoffTraceId,
        spanId: newSpanId(),
        parentSpanId: null,
        taskId: null,
        captureId: evidence.captureId,
        subjectKey: `amazon:US:${row.asin}`,
        module: "RESEARCH_HANDOFF",
        phase: "handoff",
        eventType: "candidate_handoff",
        severity: "info",
        statusBefore: "READY_FOR_RESEARCH",
        statusAfter: createdCandidateIds.has(row.rowHash) ? "CANDIDATE_CREATED" : "CANDIDATE_REUSED",
        status: "succeeded",
        errorCode: null,
        reason: "Source Layer evidence handed off to the existing Candidate Authority; evidence_only remains explicit.",
        retryable: false,
        humanRequired: true,
        sourceType: "source_layer",
        recipeVersion: "source-layer-handoff.v1",
        pageTemplateHash: null,
        evidenceRefs: [`amazon:US:${row.asin}:v${evidence.version}`, `candidate:${createdCandidateIds.get(row.rowHash) ?? "reused"}`],
        contentHash: evidence.contentHash,
        jevRole: "none",
        jevModelVersion: null,
        jevPromptVersion: null,
        jevConfidence: null,
        durationMs: null,
        attempt: 1,
      },
    }).catch(() => undefined);
  }

  return {
    summary,
    evidenceOnlyNote: "采集证据仅作为来源证据（evidence only），商品事实仍需在任务内人工确认。",
    productBatchId: null,
  };
}

/**
 * 交接指纹：本次进入研究池的证据集合的 SHA-256。
 * 只用于满足既有 SellerSprite 契约的 64 位十六进制格式要求，
 * 语义是「这一批证据的内容指纹」。
 */
export function sourceLayerFingerprint(contentHashes: readonly string[]): string {
  return contentHashOf([...contentHashes].sort());
}

/**
 * 从既有 Product Batch 商品提取可用的商品事实列。
 *
 * 数据来源是已持久化的 `normalizedProductJson.providerMetrics`（SellerSprite
 * 官方导出经既有 precheck 归一后的结果），不发起任何外部请求、不重新解析文件。
 * 不支持的字段一律返回 null，绝不猜测、绝不用默认值填空。
 */
export function extractProductBatchFactFields(normalizedProductJson: string): {
  title: string | null;
  price: number | null;
  rating: number | null;
  reviewCount: number | null;
  bsr: { rank: number; category: string | null } | null;
  brand: string | null;
  productUrl: string | null;
  estimatedMonthlySales: number | null;
  estimatedMonthlyRevenueUsd: number | null;
} {
  const empty = {
    title: null,
    price: null,
    rating: null,
    reviewCount: null,
    bsr: null,
    brand: null,
    productUrl: null,
    estimatedMonthlySales: null,
    estimatedMonthlyRevenueUsd: null,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizedProductJson);
  } catch {
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return empty;
  const metrics = (parsed as { providerMetrics?: unknown }).providerMetrics;
  if (typeof metrics !== "object" || metrics === null || Array.isArray(metrics)) return empty;
  const table = metrics as Record<string, unknown>;

  const resolved = (field: string): unknown => {
    const metric = table[field];
    if (typeof metric !== "object" || metric === null) return null;
    const record = metric as { applicability?: unknown; normalized?: unknown };
    return record.applicability === "available" ? record.normalized ?? null : null;
  };
  const text = (value: unknown): string | null => (
    typeof value === "string" && value.trim() ? value.trim() : null
  );
  const finite = (value: unknown, min: number, max: number): number | null => (
    typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null
  );

  const bsrRank = finite(resolved("rootCategoryBsr"), 1, 1_000_000_000);
  const rootCategory = text(resolved("rootCategory"));
  return {
    title: text(resolved("productTitle")),
    price: finite(resolved("price"), 0, 1_000_000),
    rating: finite(resolved("rating"), 0, 5),
    reviewCount: (() => {
      const value = finite(resolved("reviews"), 0, 1_000_000_000);
      return value === null ? null : Math.round(value);
    })(),
    bsr: bsrRank === null ? null : { rank: Math.round(bsrRank), category: rootCategory },
    brand: text(resolved("brand")),
    productUrl: text(resolved("productUrl")),
    // 估算月销量 / 月销售额在既有 providerMetrics 里已经落库（同 Candidate 侧读法），
    // 此前桥接漏读，导致 ProductFact.market 的估算字段恒为 missing。
    // 只做读取与范围裁剪，不换算、不补值。
    estimatedMonthlySales: (() => {
      const value = finite(resolved("estimatedMonthlySales"), 0, 1_000_000_000);
      return value === null ? null : Math.round(value);
    })(),
    estimatedMonthlyRevenueUsd: finite(resolved("estimatedMonthlyRevenue"), 0, 1_000_000_000),
  };
}

function extractProductBatchSubCategoryBsr(normalizedProductJson: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizedProductJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const metrics = (parsed as { providerMetrics?: unknown }).providerMetrics;
  if (typeof metrics !== "object" || metrics === null || Array.isArray(metrics)) return null;
  const metric = (metrics as Record<string, unknown>).subCategoryBsr;
  if (typeof metric !== "object" || metric === null || Array.isArray(metric)) return null;
  const record = metric as { applicability?: unknown; normalized?: unknown };
  if (record.applicability !== "available") return null;
  const value = record.normalized;
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 1 && value <= 1_000_000_000
      ? Math.round(value)
      : null;
  }
  if (!Array.isArray(value)) return null;
  const first = value.find((item) => (
    typeof item === "number" && Number.isFinite(item) && item >= 1 && item <= 1_000_000_000
  ));
  return typeof first === "number" ? Math.round(first) : null;
}

type SellerSpriteBatchSnapshot = Parameters<
  typeof sellerSpriteProductFactExtensionsFromSnapshot
>[0]["snapshot"];

function parseSellerSpriteBatchSnapshot(value: string | null): SellerSpriteBatchSnapshot | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const candidate = parsed as {
    schemaVersion?: unknown;
    sourceFileSha256?: unknown;
    records?: unknown;
  };
  if (candidate.schemaVersion !== "sellersprite-market-snapshot.v3"
    || typeof candidate.sourceFileSha256 !== "string"
    || !Array.isArray(candidate.records)) {
    return null;
  }
  return parsed as SellerSpriteBatchSnapshot;
}

/**
 * 「Product Batch → Evidence」只读桥接。
 *
 * 让已经在商品批次里的商品也能获得统一的来源证据入口，不需要重新采集：
 * 商品事实列取自既有批次的 providerMetrics，来源证明指向原始 SellerSprite
 * 导出文件指纹，因此版本历史与审计同「重新采集」路径完全一致。
 */
export async function captureFromProductBatch(input: {
  context: AccessContext;
  /** 指定批次；缺省时沿用当前激活批次。 */
  productBatchId?: string;
  /** 指定单个商品；缺省时接入当前批次内全部商品（有上限）。 */
  productBatchItemId?: string;
  now?: Date;
}): Promise<{
  traceId: string;
  productBatchId: string;
  batchName: string;
  requestedItemIds: string[];
  skippedItemIds: string[];
  items: SourceLayerCaptureItem[];
  errors: SourceLayerIngestError[];
  readyCount: number;
  reviewCount: number;
  blockedCount: number;
}> {
  await import("@/lib/sourceLayer/adapters");
  const adapter = getSourceAdapter("sellersprite_xlsx");
  if (!adapter) {
    throw new SourceLayerServiceError("adapter_not_found", "SellerSprite Adapter 未注册。");
  }
  const store = getProductBatchStore(input.context);
  const selection = await store.getSelection();
  const requestedBatchId = input.productBatchId?.trim() || selection?.activeProductBatchId;
  if (!requestedBatchId) {
    throw new SourceLayerServiceError("candidate_not_ready", "请先选择一个当前商品批次。");
  }
  const batch = await store.getBatch(requestedBatchId);
  if (!batch || batch.batchStatus !== "ready") {
    throw new SourceLayerServiceError("candidate_not_ready", "当前商品批次尚不可用。");
  }
  const allItems = await store.getBatchItems(batch.id);
  const requested = input.productBatchItemId
    ? allItems.filter((candidate) => candidate.id === input.productBatchItemId)
    : allItems.slice(0, MAX_PRODUCT_BATCH_BRIDGE_ITEMS);
  if (requested.length === 0) {
    throw new SourceLayerServiceError("candidate_not_ready", "该商品不在当前商品批次中。");
  }

  const operator = operatorOf(input.context);
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("source_layer_time_invalid");
  const traceId = newTraceId();
  const capturedAt = now.toISOString();
  const evidenceStore = createEvidenceStore(operator);
  const batchSnapshot = parseSellerSpriteBatchSnapshot(batch.normalizedSnapshotJson);

  const items: SourceLayerCaptureItem[] = [];
  const errors: SourceLayerIngestError[] = [];
  const skippedItemIds: string[] = [];

  for (const [index, item] of requested.entries()) {
    if (!item.asin) {
      // 没有 ASIN 就没有可核验的商品身份：跳过并显式上报，不伪造主体。
      skippedItemIds.push(item.id);
      errors.push({
        code: "FIELD_MISSING",
        message: "该商品缺少 ASIN，无法建立来源证据。",
        itemIndex: index,
      });
      continue;
    }
    const facts = extractProductBatchFactFields(item.normalizedProductJson);
    const snapshotExtensions = batchSnapshot && item.asin
      ? sellerSpriteProductFactExtensionsFromSnapshot({
        snapshot: batchSnapshot,
        asin: item.asin,
      })
      : null;
    // 没有可验证的原始商品页 URL 时保持 null：不得根据 ASIN 静默
    // 拼接 .com URL，因为这会把错误站点/错误主体伪装成实体绑定证明。
    const productUrl = facts.productUrl && isAmazonProductUrlFor(facts.productUrl, item.asin)
      ? facts.productUrl
      : null;
    // 复用既有图片投影读取批次缓存的主图（已做 base64 / 魔数 / 大小校验）。
    // 没有缓存就不是图片缺失的借口——保持缺失并让 Validator 标注 image_missing。
    const cachedImage = readProductBatchItemImageSnapshot(item.imageSnapshotJson);
    const draft: CapturePackageDraft = {
      subjectKey: `amazon:US:${item.asin}`,
      marketplace: "US",
      fields: {
        asin: {
          value: item.asin,
          valueOrigin: "provider_export",
          sourceRef: "product_batch.providerMetrics.asin",
        },
        title: {
          value: facts.title,
          valueOrigin: "provider_export",
          sourceRef: "product_batch.providerMetrics.productTitle",
        },
        brand: {
          value: facts.brand,
          valueOrigin: "provider_export",
          sourceRef: "product_batch.providerMetrics.brand",
        },
        images: {
          // 批次只缓存一张主图；只有一张是真实状态，不补图。
          value: cachedImage ? [cachedImage.dataUrl] : [],
          valueOrigin: "provider_export",
          sourceRef: "product_batch.imageSnapshot",
        },
        price: {
          value: facts.price === null ? null : { amount: facts.price, currency: batch.currency },
          valueOrigin: "provider_export",
          sourceRef: "product_batch.providerMetrics.price",
        },
        rating: {
          value: facts.rating,
          valueOrigin: "provider_export",
          sourceRef: "product_batch.providerMetrics.rating",
        },
        reviewCount: {
          value: facts.reviewCount,
          valueOrigin: "provider_export",
          sourceRef: "product_batch.providerMetrics.reviews",
        },
        bsr: {
          value: facts.bsr,
          valueOrigin: "provider_export",
          sourceRef: "product_batch.providerMetrics.rootCategoryBsr",
        },
        subCategoryBsr: {
          value: extractProductBatchSubCategoryBsr(item.normalizedProductJson),
          valueOrigin: "provider_export",
          sourceRef: "product_batch.providerMetrics.subCategoryBsr",
        },
        // 第三方估算：原样透传既有 providerMetrics 值，缺失保持 null。
        // valueOrigin 沿用本桥接既有取值（与同链路其它 provider 字段一致），
        // 估算性质由 MarketScan 的 factValues.valueSource = PROVIDER_ESTIMATE 显式表达，
        // 不在此处新造 valueOrigin 枚举值。
        estimatedMonthlySales: {
          value: facts.estimatedMonthlySales,
          valueOrigin: "provider_export",
          metricNature: "estimate",
          sourceRef: "product_batch.providerMetrics.estimatedMonthlySales",
        },
        estimatedMonthlyRevenueUsd: {
          value: facts.estimatedMonthlyRevenueUsd,
          valueOrigin: "provider_export",
          metricNature: "estimate",
          sourceRef: "product_batch.providerMetrics.estimatedMonthlyRevenue",
        },
        keywords: {
          value: [],
          valueOrigin: "provider_export",
          sourceRef: "product_batch.keywords",
        },
      },
      ...(snapshotExtensions ? { extensions: snapshotExtensions } : {}),
      sourceProof: {
        sourceType: "sellersprite_xlsx",
        sourceUrl: productUrl,
        capturedAt,
        captureMethod: "xlsx_export",
        operator,
        sourceFingerprint: batch.sourceFileSha256,
        sourceRecordRef: item.id,
      },
      replay: {
        url: productUrl,
        capturedAt,
        pageDigest: `product_batch;batchId=${batch.id};itemId=${item.id};reportType=${batch.reportType}`,
        warnings: ["bridged_from_product_batch"],
      },
    };

    try {
      const captured = await captureDraftToEvidence({
        draft,
        adapter,
        store: evidenceStore,
        operator,
        now,
        capturedAt,
        captureErrorCodes: [],
        auditDetail: {
          sourceType: "sellersprite_xlsx",
          bridgedFromProductBatchId: batch.id,
          bridgedFromProductBatchItemId: item.id,
        },
        traceId,
      });
      items.push(captured);
      for (const transitionError of captured.transitionErrors) {
        errors.push({ ...transitionError, itemIndex: index });
      }
    } catch (error) {
      errors.push({
        code: error instanceof Error && "code" in error
          ? String((error as { code: unknown }).code)
          : "INTERNAL_UNEXPECTED",
        message: error instanceof Error ? error.message : "批次商品接入来源证据失败。",
        itemIndex: index,
      });
    }
  }

  return {
    traceId,
    productBatchId: batch.id,
    batchName: batch.batchName,
    requestedItemIds: requested.map((item) => item.id),
    skippedItemIds,
    items,
    errors,
    readyCount: items.filter((item) => item.readyForResearch).length,
    reviewCount: items.filter((item) => item.verdict === "needs_review").length,
    blockedCount: items.filter((item) => item.verdict === "blocked").length,
  };
}

/** 只接受指向同一 ASIN 的 Amazon 商品页 URL；不接受默认 URL 猜测。 */
function isAmazonProductUrlFor(value: string, asin: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    if (host !== "amazon.com" && !host.endsWith(".amazon.com")) return false;
    const urlAsin = /\/(?:dp|gp\/product)\/([A-Za-z0-9]{10})(?:[/?]|$)/i.exec(url.pathname)?.[1];
    return urlAsin?.toUpperCase() === asin;
  } catch {
    return false;
  }
}

export { buildSellerSpriteCandidateSourceMeta };
