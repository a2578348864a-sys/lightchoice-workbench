/**
 * Product Source Layer V1.2 — Audit Log（Phase 4 / 七、Capture Replay）
 *
 * 契约：
 * 1. 每一次状态变化、每一次异常，都必须写入一条审计条目；
 * 2. 审计条目只保存可复盘的最小事实，绝不保存凭据、Cookie 或完整页面正文；
 * 3. 状态机拒绝在没有审计条目的情况下完成跃迁（AUDIT_REQUIRED，fail-closed）。
 *
 * 纯模块：无 IO / 无随机。time 必须由调用方注入。
 */
import {
  normalizeSourceLayerErrorCode,
  type SourceLayerError,
  type SourceLayerErrorCode,
  type SourceLayerErrorFamily,
  type SourceLayerErrorSeverity,
} from "@/lib/sourceLayer/errorCodes";

export const SOURCE_LAYER_AUDIT_SCHEMA = "source-layer-audit-entry.v1" as const;

/** 审计事件种类（封闭枚举）。 */
export const AUDIT_EVENT_KINDS = [
  "capture_created",
  /** 采集事件本身：即使内容重复或没有可落字段，也必须可计数、可复盘。 */
  "capture_event",
  "state_transition",
  "validation_result",
  "error",
  "evidence_persisted",
  "evidence_attachment_persisted",
  "research_handoff",
  "diagnostic",
  "security_audit",
] as const;
export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number];

export const AUDIT_MODULES = [
  "UI",
  "API",
  "ORCHESTRATOR",
  "BROWSER",
  "ENTITY_BINDING",
  "EXTRACTOR",
  "JEV_SEMANTIC_ASSIST",
  "JEV_SHADOW_AUDITOR",
  "NORMALIZER",
  "VALIDATOR",
  "CAPTURE_GATEWAY",
  "EVIDENCE_STORE",
  "SOURCE_LAYER",
  "KEYWORD_EVIDENCE",
  "REVIEW_EVIDENCE",
  "TREND_OBSERVATION",
  "RESEARCH_HANDOFF",
  "SECURITY",
] as const;
export type AuditModule = (typeof AUDIT_MODULES)[number];
export type AuditSeverity = "debug" | "info" | "warning" | "error" | "critical";
export type AuditJevRole = "none" | "semantic_assist" | "shadow_auditor";

/** 统一链路字段。全部可选，保证旧版审计文件仍可读取。 */
export type AuditTraceFields = {
  traceId?: string | null;
  spanId?: string | null;
  parentSpanId?: string | null;
  taskId?: string | null;
  module?: AuditModule | string | null;
  phase?: string | null;
  eventType?: string | null;
  severity?: AuditSeverity | null;
  statusBefore?: string | null;
  statusAfter?: string | null;
  retryable?: boolean | null;
  humanRequired?: boolean | null;
  sourceType?: string | null;
  recipeVersion?: string | null;
  pageTemplateHash?: string | null;
  evidenceRefs?: readonly string[] | null;
  contentHash?: string | null;
  jevRole?: AuditJevRole | null;
  jevModelVersion?: string | null;
  jevPromptVersion?: string | null;
  jevConfidence?: number | null;
  durationMs?: number | null;
  attempt?: number | null;
};

export type AuditLogEntry = {
  schemaVersion: typeof SOURCE_LAYER_AUDIT_SCHEMA;
  /** 单调递增序号（同一 capture 内），保证回放有确定顺序。 */
  sequence: number;
  eventKind: AuditEventKind;
  /** 状态变化四要素：from / to / reason / timestamp。 */
  previousState: string | null;
  nextState: string | null;
  reason: string;
  timestamp: string;
  captureId: string | null;
  subjectKey: string | null;
  errorCode: SourceLayerErrorCode | null;
  errorFamily: SourceLayerErrorFamily | null;
  errorSeverity: SourceLayerErrorSeverity | null;
  /** 结构化补充（键值必须为标量，禁止嵌套对象与数组以免夹带正文）。 */
  detail: Record<string, string | number | boolean | null>;
  /** 操作者/发起者（owner:v1 / visitor:sandbox / system）。 */
  operator: string;
  traceId?: string | null;
  spanId?: string | null;
  parentSpanId?: string | null;
  taskId?: string | null;
  module?: AuditModule | string | null;
  phase?: string | null;
  eventType?: string | null;
  severity?: AuditSeverity | null;
  statusBefore?: string | null;
  statusAfter?: string | null;
  retryable?: boolean | null;
  humanRequired?: boolean | null;
  sourceType?: string | null;
  recipeVersion?: string | null;
  pageTemplateHash?: string | null;
  evidenceRefs?: string[];
  contentHash?: string | null;
  jevRole?: AuditJevRole | null;
  jevModelVersion?: string | null;
  jevPromptVersion?: string | null;
  jevConfidence?: number | null;
  durationMs?: number | null;
  attempt?: number | null;
};

export const MAX_AUDIT_DETAIL_KEYS = 16;
export const MAX_AUDIT_REASON_LENGTH = 500;
/** 单个采集包保留的审计条目上限（超出时裁剪最旧条目，保留最新事实）。 */
export const MAX_AUDIT_ENTRIES_PER_CAPTURE = 200;

const SENSITIVE_KEY_PATTERN = /(password|passwd|secret|token|cookie|authorization|api[-_]?key|apikey|session|credential)/i;

export function sanitizeAuditDetail(
  detail: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean | null> {
  if (!detail || typeof detail !== "object") return {};
  const out: Record<string, string | number | boolean | null> = {};
  let count = 0;
  for (const [key, value] of Object.entries(detail)) {
    if (count >= MAX_AUDIT_DETAIL_KEYS) break;
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    if (value === null || typeof value === "boolean") {
      out[key.slice(0, 64)] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key.slice(0, 64)] = value;
    } else if (typeof value === "string") {
      out[key.slice(0, 64)] = value.slice(0, 300);
    }
    count += 1;
  }
  return out;
}

export type AuditEntryInput = {
  eventKind: AuditEventKind;
  reason: string;
  timestamp: string;
  previousState?: string | null;
  nextState?: string | null;
  captureId?: string | null;
  subjectKey?: string | null;
  error?: SourceLayerError | null;
  /** 允许直接传错误码字符串（如上游 Adapter 只拿到 code 时）。 */
  errorCode?: unknown;
  detail?: Record<string, unknown> | null;
  operator?: string;
} & AuditTraceFields;

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, maxLength)
    : null;
}

function boundedNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function sanitizeEvidenceRefs(value: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((ref): ref is string => typeof ref === "string")
    .map((ref) => ref.trim().slice(0, 240))
    .filter(Boolean))].slice(0, 32);
}

/**
 * 追加一条审计条目。
 * 返回新数组（不修改入参），并强制 sequence 单调递增。
 */
export function appendAuditEntry(
  entries: readonly AuditLogEntry[],
  input: AuditEntryInput,
): AuditLogEntry[] {
  const lastSequence = entries.length > 0 ? entries[entries.length - 1].sequence : 0;
  const error = input.error ?? null;
  const code = error
    ? error.code
    : input.errorCode === undefined || input.errorCode === null
      ? null
      : normalizeSourceLayerErrorCode(input.errorCode);
  const entry: AuditLogEntry = {
    schemaVersion: SOURCE_LAYER_AUDIT_SCHEMA,
    sequence: lastSequence + 1,
    eventKind: input.eventKind,
    previousState: input.previousState ?? null,
    nextState: input.nextState ?? null,
    reason: input.reason.trim().slice(0, MAX_AUDIT_REASON_LENGTH) || "unspecified",
    timestamp: input.timestamp,
    captureId: input.captureId ?? null,
    subjectKey: input.subjectKey ?? null,
    errorCode: code,
    errorFamily: error?.family ?? null,
    errorSeverity: error?.severity ?? null,
    detail: sanitizeAuditDetail(input.detail),
    operator: (input.operator ?? "system").slice(0, 80),
    traceId: boundedString(input.traceId, 128),
    spanId: boundedString(input.spanId, 128),
    parentSpanId: boundedString(input.parentSpanId, 128),
    taskId: boundedString(input.taskId, 128),
    module: boundedString(input.module, 64),
    phase: boundedString(input.phase, 64),
    eventType: boundedString(input.eventType, 96),
    severity: input.severity ?? null,
    statusBefore: boundedString(input.statusBefore ?? input.previousState, 80),
    statusAfter: boundedString(input.statusAfter ?? input.nextState, 80),
    retryable: typeof input.retryable === "boolean" ? input.retryable : null,
    humanRequired: typeof input.humanRequired === "boolean" ? input.humanRequired : null,
    sourceType: boundedString(input.sourceType, 64),
    recipeVersion: boundedString(input.recipeVersion, 96),
    pageTemplateHash: boundedString(input.pageTemplateHash, 128),
    evidenceRefs: sanitizeEvidenceRefs(input.evidenceRefs),
    contentHash: boundedString(input.contentHash, 128),
    jevRole: input.jevRole ?? null,
    jevModelVersion: boundedString(input.jevModelVersion, 96),
    jevPromptVersion: boundedString(input.jevPromptVersion, 96),
    jevConfidence: boundedNumber(input.jevConfidence, 0, 1),
    durationMs: boundedNumber(input.durationMs, 0, 86_400_000),
    attempt: boundedNumber(input.attempt, 0, 10_000),
  };
  const appended = [...entries, entry];
  return appended.length > MAX_AUDIT_ENTRIES_PER_CAPTURE
    ? appended.slice(appended.length - MAX_AUDIT_ENTRIES_PER_CAPTURE)
    : appended;
}

/** 多个错误一次性入审计。 */
export function appendAuditEntries(
  entries: readonly AuditLogEntry[],
  inputs: readonly AuditEntryInput[],
): AuditLogEntry[] {
  return inputs.reduce<AuditLogEntry[]>((acc, input) => appendAuditEntry(acc, input), [...entries]);
}

export function parseAuditLogEntry(value: unknown): AuditLogEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== SOURCE_LAYER_AUDIT_SCHEMA) return null;
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 1) return null;
  if (!AUDIT_EVENT_KINDS.includes(record.eventKind as AuditEventKind)) return null;
  if (typeof record.reason !== "string") return null;
  if (typeof record.timestamp !== "string" || !Number.isFinite(Date.parse(record.timestamp))) {
    return null;
  }
  if (record.errorCode !== null && record.errorCode !== undefined
    && normalizeSourceLayerErrorCode(record.errorCode) === "INTERNAL_UNEXPECTED"
    && record.errorCode !== "INTERNAL_UNEXPECTED") {
    return null;
  }
  return record as unknown as AuditLogEntry;
}

export function parseAuditLog(value: unknown): AuditLogEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: AuditLogEntry[] = [];
  for (const item of value) {
    const parsed = parseAuditLogEntry(item);
    if (!parsed) return [];
    entries.push(parsed);
  }
  return entries;
}

/** 回放：按序号升序返回某个来源相关的时间线（只读，不改数据）。 */
export function replayAuditTimeline(
  entries: readonly AuditLogEntry[],
  query: { captureId?: string | null; subjectKey?: string | null; errorCode?: SourceLayerErrorCode | null } = {},
): AuditLogEntry[] {
  return [...entries]
    .filter((entry) => (query.captureId ? entry.captureId === query.captureId : true))
    .filter((entry) => (query.subjectKey ? entry.subjectKey === query.subjectKey : true))
    .filter((entry) => (query.errorCode ? entry.errorCode === query.errorCode : true))
    .sort((left, right) => left.sequence - right.sequence);
}

/** 复盘摘要：回答「数据为什么失败」。 */
export type AuditFailureSummary = {
  failed: boolean;
  errorCodes: SourceLayerErrorCode[];
  lastReason: string | null;
  lastState: string | null;
};

export function summarizeAuditFailures(entries: readonly AuditLogEntry[]): AuditFailureSummary {
  const errorEntries = entries.filter((entry) => entry.errorCode !== null);
  const last = errorEntries.length > 0 ? errorEntries[errorEntries.length - 1] : null;
  return {
    failed: errorEntries.length > 0 || (last !== null && last.errorSeverity === "blocking"),
    errorCodes: [...new Set(errorEntries.map((entry) => entry.errorCode as SourceLayerErrorCode))],
    lastReason: last?.reason ?? null,
    lastState: last?.nextState ?? last?.previousState ?? null,
  };
}
