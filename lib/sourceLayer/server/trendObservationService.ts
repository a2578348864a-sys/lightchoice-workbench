import "server-only";

import { createHash } from "node:crypto";
import type { AccessContext } from "@/lib/server/accessPassword";
import { newSpanId, newTraceId } from "@/lib/sourceLayer/diagnostics";
import { recordDiagnosticEvent } from "@/lib/sourceLayer/server/diagnosticService";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { sourceLayerOperator } from "@/lib/sourceLayer/server/sourceLayerService";
import type { HistoryTrendDecision } from "@/tools/collectors/recipes/historyTrend";

/**
 * 把历史趋势“有来源 / 被阻断”的决定写入现有 EvidenceStore 审计链。
 *
 * BLOCKED 不等于空趋势数据：没有可靠来源时只保存可复盘的阻断决定，
 * 不创建伪造 TrendObservation，也不使用 OCR、截图或模型推断补齐历史点。
 */
export async function recordHistoryTrendDecision(input: {
  context: AccessContext;
  subjectKey: string;
  decision: HistoryTrendDecision;
  traceId?: string;
  now?: Date;
}): Promise<{ traceId: string; auditRef: string }> {
  const traceId = input.traceId ?? newTraceId();
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("TREND_DECISION_TIME_INVALID");
  const store = createEvidenceStore(sourceLayerOperator(input.context));
  const subject = await store.getSubject(input.subjectKey);
  if (!subject || subject.versions.length === 0) {
    throw new Error("TREND_SUBJECT_NOT_FOUND");
  }
  const auditRef = `trend-decision:${createHash("sha256")
    .update(JSON.stringify({ subjectKey: input.subjectKey, decision: input.decision }), "utf8")
    .digest("hex")}`;
  await recordDiagnosticEvent({
    context: input.context,
    event: {
      traceId,
      spanId: newSpanId(),
      parentSpanId: null,
      taskId: null,
      captureId: subject.versions.at(-1)?.captureId ?? null,
      subjectKey: input.subjectKey,
      module: "TREND_OBSERVATION",
      phase: "persist",
      eventType: input.decision.status === "blocked" ? "trend_source_blocked" : "trend_source_available",
      severity: input.decision.status === "blocked" ? "warning" : "info",
      statusBefore: null,
      statusAfter: input.decision.status,
      status: input.decision.status === "blocked" ? "blocked" : "succeeded",
      errorCode: input.decision.status === "blocked" ? "NO_EVIDENCE" : null,
      reason: input.decision.status === "blocked"
        ? `${input.decision.code}: ${input.decision.reason}`
        : `${input.decision.code}: reliable structured trend source is available.`,
      retryable: false,
      humanRequired: input.decision.status === "blocked",
      sourceType: "manual",
      recipeVersion: "history-trend-decision.v1",
      pageTemplateHash: null,
      evidenceRefs: input.decision.status === "blocked" ? [] : [auditRef],
      contentHash: auditRef.slice("trend-decision:".length),
      jevRole: "none",
      jevModelVersion: null,
      jevPromptVersion: null,
      jevConfidence: null,
      durationMs: null,
      attempt: 1,
      createdAt: now.toISOString(),
    },
  });
  return { traceId, auditRef };
}
