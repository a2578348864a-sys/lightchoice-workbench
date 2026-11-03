/**
 * Source Layer V2 统一诊断契约。
 *
 * 诊断事件与 Evidence 使用同一条审计存储链路，但不是第二套日志数据库。
 * 诊断写入允许 best-effort；安全审计由调用方按 fail-closed 处理。
 * 本模块不读取网络、不读取环境变量，也不保存页面正文或凭据。
 */
import type {
  AuditEntryInput,
  AuditEventKind,
  AuditJevRole,
  AuditModule,
  AuditSeverity,
} from "@/lib/sourceLayer/auditLog";

export const DIAGNOSTIC_SCHEMA = "source-layer-diagnostic-event.v1" as const;

export type DiagnosticStatus = "started" | "succeeded" | "failed" | "blocked" | "skipped" | "needs_review";

export const DIAGNOSTIC_PHASES = [
  "capture",
  "browser",
  "extract",
  "normalize",
  "validate",
  "persist",
  "handoff",
  "research",
  "security",
  "ui",
] as const;
export type DiagnosticPhase = (typeof DIAGNOSTIC_PHASES)[number] | string;

export const DIAGNOSTIC_EVENT_TYPES = [
  "capture_started",
  "capture_finished",
  "browser_navigation",
  "page_template_observed",
  "field_extracted",
  "field_missing",
  "field_ambiguous",
  "entity_binding_checked",
  "validation_finished",
  "evidence_persisted",
  "research_handoff",
  "human_required",
  "semantic_assist_candidate",
  "shadow_audit_finished",
  "security_violation",
  "unexpected_error",
] as const;
export type DiagnosticEventType = (typeof DIAGNOSTIC_EVENT_TYPES)[number] | string;

export type DiagnosticEvent = {
  schemaVersion: typeof DIAGNOSTIC_SCHEMA;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  taskId: string | null;
  captureId: string | null;
  subjectKey: string | null;
  module: AuditModule | string;
  phase: DiagnosticPhase;
  eventType: DiagnosticEventType;
  severity: AuditSeverity;
  statusBefore: string | null;
  statusAfter: string | null;
  status: DiagnosticStatus;
  errorCode: string | null;
  reason: string;
  retryable: boolean;
  humanRequired: boolean;
  sourceType: string | null;
  recipeVersion: string | null;
  pageTemplateHash: string | null;
  evidenceRefs: string[];
  contentHash: string | null;
  jevRole: AuditJevRole;
  jevModelVersion: string | null;
  jevPromptVersion: string | null;
  jevConfidence: number | null;
  durationMs: number | null;
  attempt: number | null;
  createdAt: string;
};

export type DiagnosticEventInput = Omit<DiagnosticEvent, "schemaVersion" | "traceId" | "spanId" | "createdAt"> & {
  traceId?: string;
  spanId?: string;
  createdAt?: string;
};

const SENSITIVE_KEY = /(password|passwd|secret|token|cookie|authorization|api[-_]?key|apikey|session|credential|private)/i;

function safeId(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 128) : fallback;
}

/** ID 只用于链路关联，不携带用户输入或密钥。 */
export function newTraceId(): string {
  const candidate = globalThis.crypto?.randomUUID?.();
  return candidate ?? `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function newSpanId(): string {
  const candidate = globalThis.crypto?.randomUUID?.();
  return candidate ?? `span-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createDiagnosticEvent(input: DiagnosticEventInput): DiagnosticEvent {
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("diagnostic_created_at_invalid");
  const reason = input.reason.trim().slice(0, 500) || "unspecified";
  const refs = [...new Set(input.evidenceRefs
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().slice(0, 240))
    .filter(Boolean))].slice(0, 32);
  return {
    ...input,
    schemaVersion: DIAGNOSTIC_SCHEMA,
    traceId: safeId(input.traceId, newTraceId()),
    spanId: safeId(input.spanId, newSpanId()),
    parentSpanId: input.parentSpanId ? safeId(input.parentSpanId, "") : null,
    taskId: input.taskId ? safeId(input.taskId, "") : null,
    captureId: input.captureId ? safeId(input.captureId, "") : null,
    subjectKey: input.subjectKey ? safeId(input.subjectKey, "") : null,
    reason,
    evidenceRefs: refs,
    errorCode: input.errorCode?.trim().slice(0, 80) || null,
    statusBefore: input.statusBefore?.trim().slice(0, 80) || null,
    statusAfter: input.statusAfter?.trim().slice(0, 80) || null,
    sourceType: input.sourceType?.trim().slice(0, 64) || null,
    recipeVersion: input.recipeVersion?.trim().slice(0, 96) || null,
    pageTemplateHash: input.pageTemplateHash?.trim().slice(0, 128) || null,
    contentHash: input.contentHash?.trim().slice(0, 128) || null,
    jevModelVersion: input.jevModelVersion?.trim().slice(0, 96) || null,
    jevPromptVersion: input.jevPromptVersion?.trim().slice(0, 96) || null,
    jevConfidence: typeof input.jevConfidence === "number" && input.jevConfidence >= 0 && input.jevConfidence <= 1
      ? input.jevConfidence
      : null,
    durationMs: typeof input.durationMs === "number" && input.durationMs >= 0 ? input.durationMs : null,
    attempt: typeof input.attempt === "number" && input.attempt >= 0 ? Math.floor(input.attempt) : null,
    createdAt,
  };
}

/** 将统一事件投影到既有 AuditLog，不创建第二种持久化格式。 */
export function diagnosticEventToAuditInput(event: DiagnosticEvent): AuditEntryInput {
  const eventKind: AuditEventKind = event.eventType === "security_violation"
    ? "security_audit"
    : "diagnostic";
  return {
    eventKind,
    reason: event.reason,
    timestamp: event.createdAt,
    previousState: event.statusBefore,
    nextState: event.statusAfter,
    captureId: event.captureId,
    subjectKey: event.subjectKey,
    errorCode: event.errorCode,
    operator: "system",
    traceId: event.traceId,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    taskId: event.taskId,
    module: event.module,
    phase: event.phase,
    eventType: event.eventType,
    severity: event.severity,
    statusBefore: event.statusBefore,
    statusAfter: event.statusAfter,
    retryable: event.retryable,
    humanRequired: event.humanRequired,
    sourceType: event.sourceType,
    recipeVersion: event.recipeVersion,
    pageTemplateHash: event.pageTemplateHash,
    evidenceRefs: event.evidenceRefs,
    contentHash: event.contentHash,
    jevRole: event.jevRole,
    jevModelVersion: event.jevModelVersion,
    jevPromptVersion: event.jevPromptVersion,
    jevConfidence: event.jevConfidence,
    durationMs: event.durationMs,
    attempt: event.attempt,
    detail: {
      status: event.status,
      errorCode: event.errorCode,
      humanRequired: event.humanRequired,
    },
  };
}

/** 用于复制诊断包/UI展示的通用脱敏器；不返回凭据键，也不返回大块正文。 */
export function redactDiagnosticBundle(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => redactDiagnosticBundle(item, depth + 1));
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = "[redacted]";
      continue;
    }
    output[key.slice(0, 80)] = redactDiagnosticBundle(item, depth + 1);
  }
  return output;
}

