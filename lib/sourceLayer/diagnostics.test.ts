import { describe, expect, it } from "vitest";

import {
  createDiagnosticEvent,
  diagnosticEventToAuditInput,
  redactDiagnosticBundle,
} from "@/lib/sourceLayer/diagnostics";

describe("source layer diagnostics", () => {
  it("projects a trace event to the existing audit namespace", () => {
    const event = createDiagnosticEvent({
      parentSpanId: null,
      taskId: "task-1",
      captureId: "capture-1",
      subjectKey: "amazon:US:B000000001",
      module: "CAPTURE_GATEWAY",
      phase: "persist",
      eventType: "evidence_persisted",
      severity: "info",
      statusBefore: "VALIDATING",
      statusAfter: "READY",
      status: "succeeded",
      errorCode: null,
      reason: "evidence persisted",
      retryable: false,
      humanRequired: false,
      sourceType: "amazon_dom",
      recipeVersion: null,
      pageTemplateHash: null,
      evidenceRefs: ["ref-1", "ref-1"],
      contentHash: "hash-1",
      jevRole: "none",
      jevModelVersion: null,
      jevPromptVersion: null,
      jevConfidence: null,
      durationMs: 12,
      attempt: 1,
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    const audit = diagnosticEventToAuditInput(event);
    expect(event.schemaVersion).toBe("source-layer-diagnostic-event.v1");
    expect(event.evidenceRefs).toEqual(["ref-1"]);
    expect(audit.eventKind).toBe("diagnostic");
    expect(audit.traceId).toBe(event.traceId);
  });

  it("redacts credentials and truncates oversized diagnostic values", () => {
    const redacted = redactDiagnosticBundle({
      apiKey: "secret",
      nested: { authorization: "Bearer secret" },
      message: "x".repeat(600),
    }) as Record<string, unknown>;
    expect(redacted.apiKey).toBe("[redacted]");
    expect((redacted.nested as Record<string, unknown>).authorization).toBe("[redacted]");
    expect(String(redacted.message).length).toBeLessThanOrEqual(501);
  });
});
