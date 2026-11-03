import "server-only";

/**
 * Source Layer V3 Capture Gateway。
 *
 * 外部采集的唯一编排入口：
 *   source payload → CapturePackage → EvidenceStore → ProductFact → handoff
 *   → 既有 Candidate Authority
 *
 * Gateway 不调用外部服务、不做 AI 推测，也不直接写 OpportunityCandidate；
 * Candidate 写入仍由既有 Source Layer handoff → Candidate Authority 完成。
 */
import "@/lib/sourceLayer/adapters";
import {
  adaptEvidenceToProductFact,
  DISABLED_QUALITY_GATE_RESULT,
  type ProductFact,
  type ProductFactExtensions,
  type ProductFactSource,
  type QualityGateResult,
} from "@/lib/sourceLayer/fact";
import type { AccessContext } from "@/lib/server/accessPassword";
import type {
  SellerSpriteImportRow,
  SellerSpritePluginCapture,
} from "@/lib/server/sellerSpriteImportContract";
import {
  handoffCapturesToResearch,
  captureFromProductBatch,
  ingestSourceCapture,
  sourceLayerOperator,
  type SourceLayerCaptureItem,
  type SourceLayerIngestResult,
} from "@/lib/sourceLayer/server/sourceLayerService";
import {
  createEvidenceStore,
  type EvidenceStore,
} from "@/lib/sourceLayer/server/evidenceStore";
import type { CaptureSourceType, CaptureEntityBindingProof } from "@/lib/sourceLayer/capturePackage";
import {
  assertCategoryMarketCaptureBatch,
  categoryMarketSubjectKey,
  type CategoryMarketCaptureBatch,
} from "@/lib/sourceLayer/categoryMarketCapture";
import type { SourceLayerErrorCode } from "@/lib/sourceLayer/errorCodes";
import {
  buildSourceEvidenceAttachment,
  sourceEvidenceAttachmentIdFor,
  type SourceEvidenceAttachmentKind,
  type SourceEvidenceAttachment,
} from "@/lib/sourceLayer/evidenceAttachment";
import type { SourceEvidenceRef } from "@/lib/sourceLayer/evidenceRefs";
import { isSellerSpriteQuerySubjectKey } from "@/lib/sourceLayer/queryEvidenceSubject";
import { newTraceId } from "@/lib/sourceLayer/diagnostics";
import { newSpanId } from "@/lib/sourceLayer/diagnostics";
import { recordDiagnosticEvent } from "@/lib/sourceLayer/server/diagnosticService";
import {
  auditProductFactSnapshot,
  buildSemanticAssistCandidate,
  type SemanticAssistCandidate,
  type ShadowAuditResult,
} from "@/lib/sourceLayer/jev";

export const CAPTURE_GATEWAY_SCHEMA = "capture-gateway-result.v1" as const;

export type CaptureGatewaySource = ProductFactSource;
type CaptureGatewayAttachmentSource = CaptureGatewaySource | "browser_agent";

export type CaptureGatewayInput = {
  readonly context: AccessContext;
  readonly source: CaptureGatewaySource;
  readonly payload: unknown;
  readonly now?: Date;
  readonly sourceUrl?: string | null;
  readonly sourceFingerprint?: string | null;
  readonly subjectKey?: string | null;
  readonly marketplace?: string | null;
  readonly pageContext?: {
    readonly pageClass: string;
    readonly allowFields: boolean;
    readonly errorCode?: SourceLayerErrorCode | null;
    readonly reason?: string | null;
    readonly entityBinding?: CaptureEntityBindingProof | null;
  };
  /** 上游已有链路时复用；否则 Gateway 创建新的 trace。 */
  readonly traceId?: string;
  /** Jev Shadow Auditor 旁路开关；默认开启旁路审计，不修改主事实链。 */
  readonly shadowAudit?: {
    readonly enabled: boolean;
    readonly pageTemplateHash?: string | null;
    readonly previousPageTemplateHash?: string | null;
  };
};

export type CaptureGatewayResult = {
  readonly schemaVersion: typeof CAPTURE_GATEWAY_SCHEMA;
  readonly source: CaptureGatewaySource;
  readonly capturedAt: string;
  readonly capture: SourceLayerIngestResult;
  readonly productFacts: readonly ProductFact[];
  readonly qualityGate: QualityGateResult;
  readonly traceId: string;
  readonly shadowAudit: readonly ShadowAuditResult[];
  readonly semanticAssist: readonly SemanticAssistCandidate[];
};

export type CaptureGatewayHandoffResult = CaptureGatewayResult & {
  readonly handoff: {
    readonly summary: Awaited<ReturnType<typeof handoffCapturesToResearch>>["summary"];
    readonly evidenceOnlyNote: string;
    readonly productBatchId: string | null;
  };
};

export type CaptureGatewayProductBatchResult = {
  readonly schemaVersion: typeof CAPTURE_GATEWAY_SCHEMA;
  readonly source: "sellersprite_xlsx";
  readonly capturedAt: string;
  readonly traceId: string;
  readonly capture: Awaited<ReturnType<typeof captureFromProductBatch>>;
  readonly productFacts: readonly ProductFact[];
  readonly qualityGate: QualityGateResult;
};

export type CaptureGatewayCategoryMarketResult = {
  readonly schemaVersion: typeof CAPTURE_GATEWAY_SCHEMA;
  readonly traceId: string;
  readonly subjectKey: string;
  readonly contentHash: string;
  readonly batch: CategoryMarketCaptureBatch;
  readonly created: boolean;
  readonly duplicate: boolean;
};

export type CaptureGatewayAttachmentResult = {
  readonly schemaVersion: typeof CAPTURE_GATEWAY_SCHEMA;
  readonly traceId: string;
  readonly attachment: SourceEvidenceAttachment;
  /**
   * 商品级附属证据返回真实的商品 Evidence 引用。
   * 查询级主体（SellerSprite 类目/seedKeyword 查询）没有商品版本，因此为 null ——
   * 绝不为了满足类型而伪造商品版本或占位商品。
   */
  readonly sourceEvidenceRef: SourceEvidenceRef | null;
  readonly created: boolean;
  readonly duplicate: boolean;
};

export class CaptureGatewayError extends Error {
  constructor(
    public readonly code: "evidence_missing" | "fact_adapter_failed",
    message: string,
  ) {
    super(message);
    this.name = "CaptureGatewayError";
  }
}

/**
 * Keyword/Review 等非 ProductFact 证据的统一入口。
 * 它们写入同一个 EvidenceStore 的 attachment 文件，不改变商品版本号，
 * 因此不会因为一份评论或关键词报表把商品 READY 状态降级。
 */
export async function captureEvidenceAttachmentThroughGateway(input: {
  readonly context: AccessContext;
  readonly subjectKey: string;
  readonly source: CaptureGatewayAttachmentSource;
  readonly kind: SourceEvidenceAttachmentKind;
  readonly payload: Record<string, unknown>;
  readonly sourceUrl?: string | null;
  readonly sourceFingerprint?: string | null;
  readonly capturedAt?: Date;
  /** 上游已有链路时复用；否则为附属证据生成新的 trace。 */
  readonly traceId?: string;
}): Promise<CaptureGatewayAttachmentResult> {
  const now = input.capturedAt ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("capture_gateway_time_invalid");
  const traceId = input.traceId ?? newTraceId();
  const startedAt = Date.now();
  const operator = sourceLayerOperator(input.context);
  const store = createEvidenceStore(operator);
  let attachment: SourceEvidenceAttachment | null = null;
  try {
    await recordGatewayDiagnostic({
      context: input.context,
      source: input.source,
      traceId,
      subjectKey: input.subjectKey,
      eventType: "attachment_capture_started",
      status: "started",
      reason: "Capture Gateway accepted an auxiliary evidence attachment.",
    });
    const subject = await store.getSubject(input.subjectKey);
    const latest = subject?.versions.at(-1);
    // 查询级主体（SellerSprite 类目查询 / seedKeyword 查询）没有商品版本，
    // 仍写入同一 EvidenceStore 的同一主体目录，但不生成商品级 SourceEvidenceRef。
    const querySubject = isSellerSpriteQuerySubjectKey(input.subjectKey);
    if (!latest && !querySubject) {
      throw new CaptureGatewayError("evidence_missing", "附属证据没有绑定到已存在的商品 Evidence。");
    }
    const sourceType = input.source === "browser_agent"
      ? "browser_agent"
      : captureSourceTypeFor(input.source);
    const provisional = buildSourceEvidenceAttachment({
      attachmentId: "pending",
      subjectKey: input.subjectKey,
      kind: input.kind,
      sourceType,
      capturedAt: now.toISOString(),
      sourceUrl: input.sourceUrl ?? null,
      sourceFingerprint: input.sourceFingerprint ?? null,
      payload: input.payload,
    });
    attachment = buildSourceEvidenceAttachment({
      ...provisional,
      attachmentId: sourceEvidenceAttachmentIdFor(provisional.contentHash),
    });
    const appendAttachment = store.appendAttachment;
    if (!appendAttachment) {
      throw new CaptureGatewayError("evidence_missing", "当前 EvidenceStore 不支持附属证据写入。");
    }
    const stored = await appendAttachment.call(store, {
      attachment,
      operator,
      now,
    });
    const sourceEvidenceRef = latest
      ? {
        subjectKey: input.subjectKey,
        captureId: latest.captureId,
        evidenceId: latest.evidenceId,
        version: latest.version,
        contentHash: latest.contentHash,
        attachmentId: stored.attachment.attachmentId,
        attachmentHash: stored.attachment.contentHash,
      }
      : null;
    await recordGatewayDiagnostic({
      context: input.context,
      source: input.source,
      traceId,
      subjectKey: input.subjectKey,
      eventType: "attachment_persisted",
      status: "succeeded",
      reason: querySubject
        ? "Query-scoped evidence attachment persisted in the existing EvidenceStore without a product version."
        : "Auxiliary evidence attachment persisted in the existing EvidenceStore.",
      evidenceRefs: sourceEvidenceRef
        ? [sourceEvidenceRef.attachmentId, `evidence:${sourceEvidenceRef.evidenceId}`]
        : [`attachment:${stored.attachment.attachmentId}`],
      contentHash: stored.attachment.contentHash,
      durationMs: Date.now() - startedAt,
    });
    return {
      schemaVersion: CAPTURE_GATEWAY_SCHEMA,
      traceId,
      attachment: stored.attachment,
      created: stored.created,
      duplicate: stored.duplicate,
      sourceEvidenceRef,
    };
  } catch (error) {
    await recordGatewayDiagnostic({
      context: input.context,
      source: input.source,
      traceId,
      subjectKey: input.subjectKey,
      eventType: "attachment_capture_failed",
      status: "failed",
      reason: "Capture Gateway could not persist the auxiliary evidence attachment.",
      errorCode: gatewayErrorCode(error),
      contentHash: attachment?.contentHash ?? null,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

function captureSourceTypeFor(source: CaptureGatewaySource): CaptureSourceType {
  switch (source) {
    case "manual":
      return "manual_entry";
    case "amazon_dom":
    case "sellersprite_plugin":
    case "sellersprite_xlsx":
    case "keepa_export":
      return source;
    default: {
      const exhaustiveCheck: never = source;
      throw new Error(`Unsupported gateway source: ${exhaustiveCheck}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function subjectKeyForAsin(asin: unknown): string | null {
  if (typeof asin !== "string") return null;
  const normalized = asin.trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(normalized) ? `amazon:US:${normalized}` : null;
}

function pluginRowsOf(payload: unknown): SellerSpriteImportRow[] {
  const rows = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.rows)
      ? payload.rows
      : [];
  return rows.filter((row): row is SellerSpriteImportRow => isRecord(row)
    && typeof row.asin === "string"
    && typeof row.title === "string"
    && typeof row.amazonUrl === "string"
    && typeof row.rowHash === "string");
}

function diagnosticSubjectKey(input: Pick<CaptureGatewayInput, "subjectKey" | "payload">): string | null {
  if (input.subjectKey && /^[A-Za-z0-9:._\-|@]{1,160}$/.test(input.subjectKey)) return input.subjectKey;
  if (Array.isArray(input.payload)) {
    const first = input.payload.find((item) => isRecord(item));
    return subjectKeyForAsin(first && first.asin);
  }
  return isRecord(input.payload) ? subjectKeyForAsin(input.payload.asin) : null;
}

async function recordGatewayDiagnostic(input: {
  context: AccessContext;
  source: CaptureGatewayAttachmentSource;
  traceId: string;
  subjectKey: string | null;
  module?: string;
  eventType: string;
  status: "started" | "succeeded" | "failed";
  reason: string;
  errorCode?: string | null;
  evidenceRefs?: string[];
  contentHash?: string | null;
  durationMs?: number | null;
  severity?: "debug" | "info" | "warning" | "error" | "critical";
  humanRequired?: boolean;
  pageTemplateHash?: string | null;
  jevRole?: "none" | "semantic_assist" | "shadow_auditor";
}): Promise<void> {
  if (!input.subjectKey) return;
  await recordDiagnosticEvent({
    context: input.context,
    event: {
      traceId: input.traceId,
      spanId: newSpanId(),
      parentSpanId: null,
      taskId: null,
      captureId: null,
      subjectKey: input.subjectKey,
      module: input.module ?? "CAPTURE_GATEWAY",
      phase: input.status === "started" ? "capture" : "persist",
      eventType: input.eventType,
      severity: input.severity ?? (input.status === "failed" ? "error" : "info"),
      statusBefore: null,
      statusAfter: input.status,
      status: input.status,
      errorCode: input.errorCode ?? null,
      reason: input.reason,
      retryable: input.status === "failed",
      humanRequired: input.humanRequired ?? false,
      sourceType: input.source,
      recipeVersion: null,
      pageTemplateHash: input.pageTemplateHash ?? null,
      evidenceRefs: input.evidenceRefs ?? [],
      contentHash: input.contentHash ?? null,
      jevRole: input.jevRole ?? "none",
      jevModelVersion: null,
      jevPromptVersion: null,
      jevConfidence: null,
      durationMs: input.durationMs ?? null,
      attempt: 1,
    },
  }).catch(() => undefined);
}

function gatewayErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && code.trim() ? code.trim().slice(0, 80) : null;
  }
  return error instanceof Error ? error.name.slice(0, 80) : null;
}

function pluginExtensionsBySubject(
  payload: unknown,
): ReadonlyMap<string, ProductFactExtensions> {
  const extensions = new Map<string, ProductFactExtensions>();
  for (const row of pluginRowsOf(payload)) {
    const subjectKey = subjectKeyForAsin(row.asin);
    if (!subjectKey) continue;
    const listingDate = row.pluginCapture?.listingDate ?? null;
    extensions.set(subjectKey, { launchedDate: listingDate });
  }
  return extensions;
}

function pluginCapturesBySubject(
  payload: unknown,
): ReadonlyMap<string, SellerSpritePluginCapture> {
  const captures = new Map<string, SellerSpritePluginCapture>();
  for (const row of pluginRowsOf(payload)) {
    const subjectKey = subjectKeyForAsin(row.asin);
    if (!subjectKey || !row.pluginCapture) continue;
    captures.set(subjectKey, row.pluginCapture);
  }
  return captures;
}

function directExtensionsBySubject(
  source: CaptureGatewaySource,
  payload: unknown,
): ReadonlyMap<string, ProductFactExtensions> {
  if (source === "sellersprite_plugin") return pluginExtensionsBySubject(payload);
  if (!isRecord(payload)) return new Map();
  const subjectKey = subjectKeyForAsin(payload.asin);
  if (!subjectKey) return new Map();

  // 仅透传调用方已经给出的结构化字段；不从标题、类目或价格推断任何值。
  const extensions: ProductFactExtensions = {
    ...(Array.isArray(payload.bulletPoints)
      ? {
        bulletPoints: payload.bulletPoints.filter(
          (value): value is string => typeof value === "string",
        ),
      }
      : {}),
    ...(typeof payload.launchedDate === "string"
      ? { launchedDate: payload.launchedDate }
      : {}),
  };
  return new Map([[subjectKey, extensions]]);
}

async function productFactsFromItems(input: {
  source: CaptureGatewaySource;
  items: readonly Pick<SourceLayerCaptureItem, "subjectKey" | "version">[];
  store: EvidenceStore;
  extensionsBySubject: ReadonlyMap<string, ProductFactExtensions>;
}): Promise<ProductFact[]> {
  const facts: ProductFact[] = [];
  for (const item of input.items) {
    const subject = await input.store.getSubject(item.subjectKey);
    const evidence = subject?.versions.find((version) => version.version === item.version);
    if (!evidence) {
      throw new CaptureGatewayError(
        "evidence_missing",
        `采集结果 ${item.subjectKey}@v${item.version} 没有对应 Evidence。`,
      );
    }
    try {
      facts.push(adaptEvidenceToProductFact({
        evidence,
        source: input.source,
        // CapturePackage 的扩展字段已经经过 Adapter/normalizeExtensions
        // 校验；优先使用同一份 Evidence 中的扩展，调用方只提供兼容的
        // 外层补充，避免详情页的规格字段在 Gateway 适配时丢失。
        extensions: {
          ...(input.extensionsBySubject.get(item.subjectKey) ?? {}),
          ...(evidence.pkg.extensions ?? {}),
        },
      }));
    } catch (error) {
      throw new CaptureGatewayError(
        "fact_adapter_failed",
        error instanceof Error ? error.message : "Product Fact 适配失败。",
      );
    }
  }
  return facts;
}

async function productFactsFromEvidence(input: {
  source: CaptureGatewaySource;
  capture: SourceLayerIngestResult;
  store: EvidenceStore;
  extensionsBySubject: ReadonlyMap<string, ProductFactExtensions>;
}): Promise<ProductFact[]> {
  return productFactsFromItems({
    source: input.source,
    items: input.capture.items,
    store: input.store,
    extensionsBySubject: input.extensionsBySubject,
  });
}

const SEMANTIC_ASSIST_FIELD_PATHS = [
  ["basic", "title"],
  ["basic", "brand"],
  ["basic", "category"],
  ["basic", "price"],
  ["basic", "image"],
  ["market", "bsr"],
  ["market", "monthlySalesEstimate"],
  ["market", "launchedDate"],
  ["profit", "packageWeight"],
  ["profit", "packageDimensions"],
  ["profit", "fbaFee"],
] as const;

/**
 * 只把确定性提取缺口包装成 Jev 候选旁路，不尝试补值。
 * 这里没有模型调用；候选永远是 missing/needs_review，且带有同一份
 * Evidence 引用，便于后续真正的 Semantic Assist 在同一契约下接入。
 */
function semanticAssistForFacts(input: {
  source: CaptureGatewaySource;
  facts: readonly ProductFact[];
  items: readonly Pick<SourceLayerCaptureItem, "subjectKey" | "version" | "contentHash" | "issues">[];
  captureErrorCodes: readonly string[];
  pageTemplateHash?: string | null;
}): SemanticAssistCandidate[] {
  if (input.source === "manual") return [];
  const allowedTriggers = new Set([
    "SELECTOR_MISS",
    "SELECTOR_FAILED",
    "DOM_CHANGED",
    "FIELD_AMBIGUOUS",
  ] as const);
  const candidates: SemanticAssistCandidate[] = [];
  for (const fact of input.facts) {
    const item = input.items.find((candidate) => candidate.subjectKey === fact.subjectKey);
    if (!item) continue;
    const triggerCode = item.issues
      .map((issue) => issue.code)
      .find((code): code is "SELECTOR_MISS" | "SELECTOR_FAILED" | "DOM_CHANGED" | "FIELD_AMBIGUOUS" => allowedTriggers.has(code as never))
      ?? input.captureErrorCodes.find((code): code is "SELECTOR_MISS" | "SELECTOR_FAILED" | "DOM_CHANGED" | "FIELD_AMBIGUOUS" => allowedTriggers.has(code as never));
    // 缺失字段本身不等于选择器失败：价格未展示、详情页没有 FBA 费等
    // 正常缺口不能触发 Jev，更不能被伪装成“需要模型补齐”。
    if (!triggerCode) continue;
    const evidenceRef = `${item.subjectKey}:v${item.version}`;
    const groups = fact as unknown as Record<string, Record<string, { status?: string }> | undefined>;
    for (const [group, field] of SEMANTIC_ASSIST_FIELD_PATHS) {
      if (candidates.length >= 32) break;
      if (groups[group]?.[field]?.status !== "missing") continue;
      const result = buildSemanticAssistCandidate({
        targetField: `${group}.${field}`,
        candidateValue: null,
        normalizedValue: null,
        evidenceRefs: [evidenceRef],
        confidence: 0,
        reason: `确定性采集触发 ${triggerCode}；保留 missing，不进行 AI 补全。`,
        triggerCode,
        decision: "missing",
        modelVersion: null,
        promptVersion: null,
        recipeVersion: "capture-gateway.v1",
        pageTemplateHash: input.pageTemplateHash ?? null,
        evidenceHash: item.contentHash,
      });
      if (result.ok) candidates.push(result.candidate);
    }
  }
  return candidates;
}

/**
 * 统一采集入口。所有 source payload 先通过旧 CapturePackage / Validator /
 * EvidenceStore，再生成 ProductFact；旧 CapturePackage 不被替换。
 */
export async function captureThroughGateway(
  input: CaptureGatewayInput,
): Promise<CaptureGatewayResult> {
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("capture_gateway_time_invalid");
  const operator = sourceLayerOperator(input.context);
  const traceId = input.traceId ?? newTraceId();
  const diagnosticStartedAt = Date.now();
  const diagnosticSubject = diagnosticSubjectKey(input);
  await recordGatewayDiagnostic({
    context: input.context,
    source: input.source,
    traceId,
    subjectKey: diagnosticSubject,
    eventType: "capture_started",
    status: "started",
    reason: "Capture Gateway accepted a source payload.",
  });
  const store = createEvidenceStore(operator);
  let capture: SourceLayerIngestResult;
  try {
    capture = await ingestSourceCapture({
      context: input.context,
      sourceType: captureSourceTypeFor(input.source),
      payload: input.payload,
      now,
      sourceUrl: input.sourceUrl ?? null,
      sourceFingerprint: input.sourceFingerprint ?? null,
      subjectKey: input.subjectKey ?? null,
      marketplace: input.marketplace ?? null,
      pageContext: input.pageContext
        ? {
          ...input.pageContext,
          subjectKey: input.subjectKey ?? null,
          marketplace: input.marketplace ?? null,
        }
        : undefined,
      store,
      traceId,
    });
  } catch (error) {
    await recordGatewayDiagnostic({
      context: input.context,
      source: input.source,
      traceId,
      subjectKey: diagnosticSubject,
      eventType: "capture_failed",
      status: "failed",
      reason: "Capture Gateway could not persist the source payload.",
      errorCode: gatewayErrorCode(error),
      durationMs: Date.now() - diagnosticStartedAt,
    });
    throw error;
  }

  let productFacts: ProductFact[];
  try {
    productFacts = await productFactsFromEvidence({
      source: input.source,
      capture,
      store,
      extensionsBySubject: directExtensionsBySubject(input.source, input.payload),
    });
  } catch (error) {
    await recordGatewayDiagnostic({
      context: input.context,
      source: input.source,
      traceId,
      subjectKey: diagnosticSubject ?? capture.items[0]?.subjectKey ?? null,
      eventType: "product_fact_adapter_failed",
      status: "failed",
      reason: "Evidence was persisted but ProductFact projection failed.",
      errorCode: gatewayErrorCode(error),
      evidenceRefs: capture.items.map((item) => `${item.subjectKey}:v${item.version}`),
      contentHash: capture.items[0]?.contentHash ?? null,
      durationMs: Date.now() - diagnosticStartedAt,
    });
    throw error;
  }
  const shadowAudit = (input.shadowAudit?.enabled ?? true)
    ? productFacts.map((fact) => auditProductFactSnapshot({
      fact,
      evidenceRefs: [fact.sourceProof.evidenceId],
      pageTemplateHash: input.shadowAudit?.pageTemplateHash,
      previousPageTemplateHash: input.shadowAudit?.previousPageTemplateHash,
      now: now.toISOString(),
    }))
    : [];
  const semanticAssist = semanticAssistForFacts({
    source: input.source,
    facts: productFacts,
    items: capture.items,
    captureErrorCodes: capture.captureErrorCodes,
    pageTemplateHash: input.shadowAudit?.pageTemplateHash,
  });
  for (const candidate of semanticAssist) {
    await recordGatewayDiagnostic({
      context: input.context,
      source: input.source,
      traceId,
      module: "JEV_SEMANTIC_ASSIST",
      subjectKey: candidate.evidenceRefs[0]?.split(":v")[0] ?? diagnosticSubject,
      eventType: "semantic_assist_candidate",
      status: "succeeded",
      severity: "warning",
      reason: candidate.reason,
      evidenceRefs: candidate.evidenceRefs,
      contentHash: candidate.evidenceHash,
      pageTemplateHash: candidate.pageTemplateHash,
      jevRole: "semantic_assist",
    });
  }
  for (const [index, result] of shadowAudit.entries()) {
    await recordGatewayDiagnostic({
      context: input.context,
      source: input.source,
      traceId,
      module: "JEV_SHADOW_AUDITOR",
      subjectKey: result.evidenceRefs.length > 0
        ? productFacts[index]?.subjectKey ?? diagnosticSubject ?? capture.items[index]?.subjectKey ?? null
        : null,
      eventType: "shadow_audit_finished",
      status: "succeeded",
      severity: result.status === "PASS" ? "info" : "warning",
      reason: `Shadow Auditor completed with status ${result.status}; result is sidecar-only.`,
      evidenceRefs: result.evidenceRefs,
      contentHash: capture.items[0]?.contentHash ?? null,
      pageTemplateHash: result.pageTemplateHash,
      jevRole: "shadow_auditor",
    });
  }

  const result = {
    schemaVersion: CAPTURE_GATEWAY_SCHEMA,
    source: input.source,
    capturedAt: capture.capturedAt,
    capture,
    productFacts,
    traceId,
    shadowAudit,
    semanticAssist,
    // Phase 1 只定义接口，质量门禁默认关闭，不影响现有流程。
    qualityGate: DISABLED_QUALITY_GATE_RESULT,
  };
  await recordGatewayDiagnostic({
    context: input.context,
    source: input.source,
    traceId,
    subjectKey: diagnosticSubject ?? capture.items[0]?.subjectKey ?? null,
    eventType: "capture_finished",
    status: "succeeded",
    reason: "Capture Gateway persisted Evidence and produced ProductFact projections.",
    evidenceRefs: capture.items.map((item) => `${item.subjectKey}:v${item.version}`),
    contentHash: capture.items[0]?.contentHash ?? null,
    durationMs: Date.now() - diagnosticStartedAt,
  });
  return result;
}

/**
 * SellerSprite Plugin Confirm 专用收口：Capture Gateway → Evidence →
 * ProductFact → 既有 Source Layer handoff → Candidate Authority。
 */
export async function captureAndHandoffSellerSpritePlugin(input: {
  readonly context: AccessContext;
  readonly rows: readonly SellerSpriteImportRow[];
  readonly sourceFileSha256: string;
  readonly now?: Date;
}): Promise<CaptureGatewayHandoffResult> {
  const rows = input.rows.map((row) => ({ ...row, asin: row.asin.trim().toUpperCase() }));
  const captured = await captureThroughGateway({
    context: input.context,
    source: "sellersprite_plugin",
    payload: rows,
    now: input.now,
    sourceFingerprint: input.sourceFileSha256,
  });
  const factsBySubject = new Map(captured.productFacts.map((fact) => [fact.subjectKey, fact]));
  const capturesBySubject = pluginCapturesBySubject(rows);
  const rowsBySubject = new Map(rows.flatMap((row) => { const key = subjectKeyForAsin(row.asin); return key ? [[key, row] as const] : []; }));
  const readySubjectKeys = captured.capture.items
    .filter((item) => item.readyForResearch)
    .map((item) => item.subjectKey);
  const summary = readySubjectKeys.length === 0
    ? { created: [], skipped: [], conflicts: [] }
    : await handoffCapturesToResearch({
      context: input.context,
      subjectKeys: readySubjectKeys,
      now: input.now ?? new Date(captured.capturedAt),
      productFactsBySubjectKey: factsBySubject,
      pluginCapturesBySubjectKey: capturesBySubject,
      sourceRowsBySubjectKey: rowsBySubject,
      sourceFileSha256: input.sourceFileSha256,
    });

  return {
    ...captured,
    handoff: {
      summary: "summary" in summary ? summary.summary : summary,
      evidenceOnlyNote: "summary" in summary
        ? summary.evidenceOnlyNote
        : "采集证据仅作为来源证据（evidence only），商品事实仍需在任务内人工确认。",
      productBatchId: "summary" in summary ? summary.productBatchId : null,
    },
  };
}

/**
 * SellerSprite XLSX Confirm 专用收口。
 *
 * XLSX 旧入口仍由上游安全预解析器负责文件、Token 与选行校验；这里接收
 * 已由服务端重建的原始字节和选中行，统一落 Evidence，再复用同一 handoff。
 * 未选中的行可以进入 Evidence 版本台账，但不会被晋级为 Candidate。
 */
export async function captureAndHandoffSellerSpriteXlsx(input: {
  readonly context: AccessContext;
  readonly bytes: Uint8Array;
  readonly rows: readonly SellerSpriteImportRow[];
  readonly sourceFileSha256: string;
  readonly now?: Date;
}): Promise<CaptureGatewayHandoffResult> {
  const captured = await captureThroughGateway({
    context: input.context,
    source: "sellersprite_xlsx",
    payload: input.bytes,
    now: input.now,
    sourceFingerprint: input.sourceFileSha256,
  });
  const selectedSubjectKeys = [...new Set(input.rows.flatMap((row) => { const key = subjectKeyForAsin(row.asin); return key ? [key] : []; }))];
  const factsBySubject = new Map(captured.productFacts.map((fact) => [fact.subjectKey, fact]));
  const rowsBySubject = new Map(input.rows.flatMap((row) => { const key = subjectKeyForAsin(row.asin); return key ? [[key, row] as const] : []; }));
  const itemsBySubject = new Map(captured.capture.items.map((item) => [item.subjectKey, item]));
  const readySubjectKeys = selectedSubjectKeys.filter((subjectKey) => {
    const item = itemsBySubject.get(subjectKey);
    return item?.readyForResearch === true;
  });
  if (readySubjectKeys.length !== selectedSubjectKeys.length) {
    throw new CaptureGatewayError(
      "evidence_missing",
      "选中的 SellerSprite XLSX 行没有全部生成可交接 Evidence。",
    );
  }
  const summary = readySubjectKeys.length === 0
    ? { created: [], skipped: [], conflicts: [] }
    : await handoffCapturesToResearch({
      context: input.context,
      subjectKeys: readySubjectKeys,
      now: input.now ?? new Date(captured.capturedAt),
      productFactsBySubjectKey: factsBySubject,
      sourceRowsBySubjectKey: rowsBySubject,
      sourceFileSha256: input.sourceFileSha256,
    });

  return {
    ...captured,
    handoff: {
      summary: "summary" in summary ? summary.summary : summary,
      evidenceOnlyNote: "summary" in summary
        ? summary.evidenceOnlyNote
        : "采集证据仅作为来源证据（evidence only），商品事实仍需在任务内人工确认。",
      productBatchId: "summary" in summary ? summary.productBatchId : null,
    },
  };
}

/**
 * Category Market Capture 是市场主体级 Evidence，不是 ProductFact。
 * 它使用同一 EvidenceStore 与 Gateway 诊断链，不进入商品版本或 Research handoff。
 */
export async function captureCategoryMarketBatchThroughGateway(input: {
  readonly context: AccessContext;
  readonly batch: CategoryMarketCaptureBatch;
  readonly now?: Date;
}): Promise<CaptureGatewayCategoryMarketResult> {
  assertCategoryMarketCaptureBatch(input.batch);
  const subjectKey = categoryMarketSubjectKey(input.batch.category.nodeId);
  const now = input.now ?? new Date(input.batch.capturedAt);
  if (Number.isNaN(now.getTime())) throw new Error("capture_gateway_time_invalid");
  const traceId = newTraceId();
  const startedAt = Date.now();
  const store = createEvidenceStore(sourceLayerOperator(input.context));

  await recordGatewayDiagnostic({
    context: input.context,
    source: "sellersprite_plugin",
    traceId,
    subjectKey,
    module: "CATEGORY_MARKET_CAPTURE",
    eventType: "category_market_capture_started",
    status: "started",
    reason: "Capture Gateway accepted a SellerSprite category market batch.",
  });

  try {
    if (!store.appendCategoryMarketCapture) {
      throw new CaptureGatewayError("evidence_missing", "当前 EvidenceStore 不支持类目市场快照写入。");
    }
    const stored = await store.appendCategoryMarketCapture({
      subjectKey,
      batch: input.batch,
      operator: sourceLayerOperator(input.context),
      now,
    });
    await recordGatewayDiagnostic({
      context: input.context,
      source: "sellersprite_plugin",
      traceId,
      subjectKey,
      module: "CATEGORY_MARKET_CAPTURE",
      eventType: "category_market_capture_persisted",
      status: "succeeded",
      reason: "Category market evidence persisted in the existing EvidenceStore.",
      evidenceRefs: [stored.batch.batchId, `category-market:${stored.contentHash}`],
      contentHash: stored.contentHash,
      durationMs: Date.now() - startedAt,
    });
    return {
      schemaVersion: CAPTURE_GATEWAY_SCHEMA,
      traceId,
      subjectKey: stored.subjectKey,
      contentHash: stored.contentHash,
      batch: stored.batch,
      created: stored.created,
      duplicate: stored.duplicate,
    };
  } catch (error) {
    await recordGatewayDiagnostic({
      context: input.context,
      source: "sellersprite_plugin",
      traceId,
      subjectKey,
      module: "CATEGORY_MARKET_CAPTURE",
      eventType: "category_market_capture_failed",
      status: "failed",
      reason: "Capture Gateway could not persist the category market batch.",
      errorCode: gatewayErrorCode(error),
      contentHash: null,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

/**
 * ProductBatch 是已落库的离线来源快照；它仍复用既有只读桥接逻辑，但 API
 * 入口统一经过 Gateway，并在返回前补齐同一套 ProductFact 投影与关闭态
 * QualityGate 结果。
 */
export async function captureProductBatchThroughGateway(input: {
  readonly context: AccessContext;
  readonly productBatchId?: string;
  readonly productBatchItemId?: string;
  readonly now?: Date;
}): Promise<CaptureGatewayProductBatchResult> {
  const capture = await captureFromProductBatch(input);
  const now = input.now ?? new Date();
  const store = createEvidenceStore(sourceLayerOperator(input.context));
  const productFacts = await productFactsFromItems({
    source: "sellersprite_xlsx",
    items: capture.items,
    store,
    extensionsBySubject: new Map(),
  });
  return {
    schemaVersion: CAPTURE_GATEWAY_SCHEMA,
    source: "sellersprite_xlsx",
    capturedAt: capture.items[0]?.auditTail[0]?.timestamp ?? now.toISOString(),
    traceId: capture.traceId,
    capture,
    productFacts,
    qualityGate: DISABLED_QUALITY_GATE_RESULT,
  };
}
