/**
 * Product Source Layer V1.2 — 采集生命周期状态机（Phase 5）
 *
 * 说明（重要边界）：
 * - 本状态机只治理「商品来源采集」这一条新链路，不替换、不修改现有
 *   Research / Listing / Image 流程的任何状态机与门禁；
 * - 状态变化必须由 transition() 产生，并强制携带 from / to / reason / timestamp；
 * - 缺少审计条目时拒绝跃迁（AUDIT_REQUIRED，fail-closed）。
 *
 * 纯模块：无 IO / 无 DB / 无随机。
 */
import {
  appendAuditEntry,
  type AuditLogEntry,
} from "@/lib/sourceLayer/auditLog";
import {
  createSourceLayerError,
  type SourceLayerError,
  type SourceLayerErrorCode,
} from "@/lib/sourceLayer/errorCodes";

export const CAPTURE_LIFECYCLE_STATES = [
  "CREATED",
  "SOURCE_CHECKING",
  "CAPTURE_RUNNING",
  "NORMALIZING",
  "EVIDENCE_VALIDATING",
  "READY_FOR_RESEARCH",
  "FAILED",
  "RETRYABLE",
  "HUMAN_REQUIRED",
  "BLOCKED",
] as const;

export type CaptureLifecycleState = (typeof CAPTURE_LIFECYCLE_STATES)[number];

export const CAPTURE_TERMINAL_STATES = ["READY_FOR_RESEARCH", "FAILED", "BLOCKED"] as const;

export const CAPTURE_EXCEPTION_STATES = [
  "FAILED",
  "RETRYABLE",
  "HUMAN_REQUIRED",
  "BLOCKED",
] as const;
export type CaptureExceptionState = (typeof CAPTURE_EXCEPTION_STATES)[number];

/** 正常主链（V1.2 五、状态机）。 */
export const CAPTURE_HAPPY_PATH = [
  "CREATED",
  "SOURCE_CHECKING",
  "CAPTURE_RUNNING",
  "NORMALIZING",
  "EVIDENCE_VALIDATING",
  "READY_FOR_RESEARCH",
] as const satisfies readonly CaptureLifecycleState[];

const TRANSITIONS: Readonly<Record<CaptureLifecycleState, readonly CaptureLifecycleState[]>> =
  Object.freeze({
    CREATED: ["SOURCE_CHECKING", "FAILED", "BLOCKED"],
    SOURCE_CHECKING: [
      "CAPTURE_RUNNING",
      "FAILED",
      "RETRYABLE",
      "HUMAN_REQUIRED",
      "BLOCKED",
    ],
    CAPTURE_RUNNING: [
      "NORMALIZING",
      "FAILED",
      "RETRYABLE",
      "HUMAN_REQUIRED",
      "BLOCKED",
    ],
    NORMALIZING: [
      "EVIDENCE_VALIDATING",
      "FAILED",
      "RETRYABLE",
      "HUMAN_REQUIRED",
      "BLOCKED",
    ],
    EVIDENCE_VALIDATING: [
      "READY_FOR_RESEARCH",
      "FAILED",
      "RETRYABLE",
      "HUMAN_REQUIRED",
      "BLOCKED",
    ],
    READY_FOR_RESEARCH: [],
    FAILED: [],
    BLOCKED: [],
    // 异常态恢复：只有可重试失败允许自动重试回主链，人工介入态必须由人工动作推进。
    RETRYABLE: ["SOURCE_CHECKING", "CAPTURE_RUNNING", "BLOCKED", "FAILED"],
    HUMAN_REQUIRED: [
      "SOURCE_CHECKING",
      "CAPTURE_RUNNING",
      "NORMALIZING",
      "EVIDENCE_VALIDATING",
      "FAILED",
      "BLOCKED",
    ],
  });

export function allowedNextStates(state: CaptureLifecycleState): readonly CaptureLifecycleState[] {
  return TRANSITIONS[state] ?? [];
}

export function canTransition(
  from: CaptureLifecycleState,
  to: CaptureLifecycleState,
): boolean {
  return allowedNextStates(from).includes(to);
}

export function isTerminalCaptureState(state: CaptureLifecycleState): boolean {
  return (CAPTURE_TERMINAL_STATES as readonly string[]).includes(state);
}

export function isExceptionCaptureState(state: CaptureLifecycleState): boolean {
  return (CAPTURE_EXCEPTION_STATES as readonly string[]).includes(state);
}

/**
 * 采集生命周期记录：包住一个采集包的当前状态与全部审计条目。
 */
export type CaptureLifecycle = {
  state: CaptureLifecycleState;
  /** 进入当前状态的时间（审计的最后一次跃迁时间；CREATED 时为创建时间）。 */
  stateEnteredAt: string;
  audit: AuditLogEntry[];
};

export function createCaptureLifecycle(input: {
  captureId: string;
  subjectKey: string;
  createdAt: string;
  operator: string;
  detail?: Record<string, unknown>;
}): CaptureLifecycle {
  const audit = appendAuditEntry([], {
    eventKind: "capture_created",
    reason: "采集包创建",
    timestamp: input.createdAt,
    previousState: null,
    nextState: "CREATED",
    captureId: input.captureId,
    subjectKey: input.subjectKey,
    operator: input.operator,
    detail: input.detail,
  });
  return { state: "CREATED", stateEnteredAt: input.createdAt, audit };
}

export type CaptureTransitionResult =
  | { ok: true; lifecycle: CaptureLifecycle; auditEntry: AuditLogEntry }
  | { ok: false; error: SourceLayerError; lifecycle: CaptureLifecycle };

/**
 * 执行一次状态跃迁。
 * - 非法跃迁：拒绝并写入 TRANSITION_FORBIDDEN 审计（返回 ok:false，不修改状态）；
 * - 缺失审计：写入失败时返回 AUDIT_REQUIRED（fail-closed）。
 */
export function transitionCapture(input: {
  lifecycle: CaptureLifecycle;
  to: CaptureLifecycleState;
  reason: string;
  timestamp: string;
  operator: string;
  error?: SourceLayerError | null;
  errorCode?: SourceLayerErrorCode | null;
  detail?: Record<string, unknown>;
}): CaptureTransitionResult {
  const { lifecycle } = input;
  if (!canTransition(lifecycle.state, input.to)) {
    const error = createSourceLayerError("TRANSITION_FORBIDDEN", {
      detail: { from: lifecycle.state, to: input.to },
    });
    const audit = appendAuditEntry(lifecycle.audit, {
      eventKind: "error",
      reason: `非法状态跃迁 ${lifecycle.state} → ${input.to}`,
      timestamp: input.timestamp,
      previousState: lifecycle.state,
      nextState: lifecycle.state,
      error,
      operator: input.operator,
    });
    return { ok: false, error, lifecycle: { ...lifecycle, audit } };
  }
  if (typeof input.reason !== "string" || !input.reason.trim()) {
    const error = createSourceLayerError("AUDIT_REQUIRED", {
      detail: { from: lifecycle.state, to: input.to },
      message: "状态变化必须带 reason。",
    });
    return { ok: false, error, lifecycle };
  }

  const audit = appendAuditEntry(lifecycle.audit, {
    eventKind: "state_transition",
    reason: input.reason,
    timestamp: input.timestamp,
    previousState: lifecycle.state,
    nextState: input.to,
    error: input.error ?? null,
    errorCode: input.error ? null : input.errorCode ?? null,
    operator: input.operator,
    detail: input.detail,
  });
  const written = audit[audit.length - 1];
  if (!written || written.nextState !== input.to) {
    return {
      ok: false,
      error: createSourceLayerError("AUDIT_REQUIRED"),
      lifecycle,
    };
  }
  return {
    ok: true,
    auditEntry: written,
    lifecycle: { state: input.to, stateEnteredAt: written.timestamp, audit },
  };
}

/** 主链是否完整走完（用于验收与展示）。 */
export function happyPathProgress(state: CaptureLifecycleState): {
  reached: number;
  total: number;
  complete: boolean;
} {
  const index = (CAPTURE_HAPPY_PATH as readonly string[]).indexOf(state);
  return {
    reached: index >= 0 ? index + 1 : 0,
    total: CAPTURE_HAPPY_PATH.length,
    complete: state === "READY_FOR_RESEARCH",
  };
}
