import "server-only";

import type { AccessContext } from "@/lib/server/accessPassword";
import { createDiagnosticEvent, newSpanId, type DiagnosticEvent } from "@/lib/sourceLayer/diagnostics";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { sourceLayerOperator } from "@/lib/sourceLayer/server/sourceLayerService";

export type DiagnosticWriteResult = {
  persisted: boolean;
  event: DiagnosticEvent;
};

/**
 * API 入口的统一诊断投影。
 *
 * API 只记录已经由 Gateway 返回的 capture/evidence 关联，不重新写事实，
 * 也不把诊断失败传播为采集失败。安全关键事件仍由 recordDiagnosticEvent
 * 的 fail-closed 语义负责。
 */
export async function recordCaptureApiDiagnostic(input: {
  context: AccessContext;
  traceId: string;
  sourceType: string;
  subjectKey: string | null;
  captureId?: string | null;
  evidenceRefs?: string[];
  contentHash?: string | null;
  status: "succeeded" | "failed";
  reason: string;
  errorCode?: string | null;
  eventType?: string;
}): Promise<DiagnosticWriteResult | null> {
  if (!input.subjectKey) return null;
  return recordDiagnosticEvent({
    context: input.context,
    event: {
      traceId: input.traceId,
      spanId: newSpanId(),
      parentSpanId: null,
      taskId: null,
      captureId: input.captureId ?? null,
      subjectKey: input.subjectKey,
      module: "API",
      phase: "capture",
      eventType: input.eventType ?? (input.status === "succeeded" ? "capture_finished" : "capture_failed"),
      severity: input.status === "failed" ? "error" : "info",
      statusBefore: null,
      statusAfter: input.status,
      status: input.status,
      errorCode: input.errorCode ?? null,
      reason: input.reason,
      retryable: input.status === "failed",
      humanRequired: input.status === "failed",
      sourceType: input.sourceType,
      recipeVersion: null,
      pageTemplateHash: null,
      evidenceRefs: input.evidenceRefs ?? [],
      contentHash: input.contentHash ?? null,
      jevRole: "none",
      jevModelVersion: null,
      jevPromptVersion: null,
      jevConfidence: null,
      durationMs: null,
      attempt: 1,
    },
  });
}

/**
 * 统一诊断写入口：普通诊断 best-effort，安全审计事件 fail-closed。
 * 仍使用 EvidenceStore 的 audit 文件，不另建日志数据库或远程服务。
 */
export async function recordDiagnosticEvent(input: {
  context: AccessContext;
  event: Parameters<typeof createDiagnosticEvent>[0];
}): Promise<DiagnosticWriteResult> {
  const event = createDiagnosticEvent(input.event);
  if (!event.subjectKey) {
    if (event.eventType === "security_violation" || event.severity === "critical") {
      throw new Error("SECURITY_AUDIT_SUBJECT_REQUIRED");
    }
    return { persisted: false, event };
  }
  const store = createEvidenceStore(sourceLayerOperator(input.context));
  try {
    const append = store.appendDiagnosticEvent;
    if (!append) throw new Error("DIAGNOSTIC_STORE_UNAVAILABLE");
    await append.call(store, {
      event,
      operator: sourceLayerOperator(input.context),
      now: new Date(event.createdAt),
    });
    return { persisted: true, event };
  } catch (error) {
    if (event.eventType === "security_violation" || event.severity === "critical") {
      throw error;
    }
    return { persisted: false, event };
  }
}
