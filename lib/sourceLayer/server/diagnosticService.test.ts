import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessContext } from "@/lib/server/accessPassword";

const mocks = vi.hoisted(() => ({
  appendDiagnosticEvent: vi.fn(),
}));

vi.mock("@/lib/sourceLayer/server/evidenceStore", () => ({
  createEvidenceStore: vi.fn(() => ({ appendDiagnosticEvent: mocks.appendDiagnosticEvent })),
}));

vi.mock("@/lib/sourceLayer/server/sourceLayerService", () => ({
  sourceLayerOperator: vi.fn(() => "owner:v1"),
}));

import { recordDiagnosticEvent } from "@/lib/sourceLayer/server/diagnosticService";

const CONTEXT: AccessContext = { mode: "owner", token: "test-token" };

function event(overrides: Record<string, unknown> = {}) {
  return {
    traceId: "trace-security-test",
    spanId: "span-security-test",
    parentSpanId: null,
    taskId: "task-security-test",
    captureId: "capture-security-test",
    subjectKey: "amazon:US:B0SECURITY1",
    module: "SECURITY",
    phase: "security",
    eventType: "security_violation",
    severity: "critical" as const,
    statusBefore: "VALIDATING",
    statusAfter: "BLOCKED",
    status: "failed" as const,
    errorCode: "AI_GENERATED_AS_FACT",
    reason: "validator rejected an AI-generated fact claim",
    retryable: false,
    humanRequired: true,
    sourceType: "amazon_dom",
    recipeVersion: "capture-test.v1",
    pageTemplateHash: null,
    evidenceRefs: ["amazon:US:B0SECURITY1:v1"],
    contentHash: null,
    jevRole: "none" as const,
    jevModelVersion: null,
    jevPromptVersion: null,
    jevConfidence: null,
    durationMs: null,
    attempt: 1,
    ...overrides,
  };
}

describe("diagnostic service failure policy", () => {
  beforeEach(() => {
    mocks.appendDiagnosticEvent.mockReset();
    mocks.appendDiagnosticEvent.mockResolvedValue(undefined);
  });

  it("persists security events through the existing EvidenceStore", async () => {
    const result = await recordDiagnosticEvent({ context: CONTEXT, event: event() });
    expect(result.persisted).toBe(true);
    expect(mocks.appendDiagnosticEvent).toHaveBeenCalledTimes(1);
    expect(mocks.appendDiagnosticEvent.mock.calls[0]?.[0].event.eventType).toBe("security_violation");
  });

  it("keeps ordinary diagnostic failures best-effort", async () => {
    mocks.appendDiagnosticEvent.mockRejectedValueOnce(new Error("diagnostic store unavailable"));
    const result = await recordDiagnosticEvent({
      context: CONTEXT,
      event: event({
        eventType: "field_missing",
        severity: "warning",
        status: "needs_review",
      }),
    });
    expect(result.persisted).toBe(false);
  });

  it("fails closed when a critical security audit cannot be persisted", async () => {
    mocks.appendDiagnosticEvent.mockRejectedValueOnce(new Error("security audit store unavailable"));
    await expect(recordDiagnosticEvent({ context: CONTEXT, event: event() }))
      .rejects.toThrow("security audit store unavailable");
  });

  it("rejects a security event without a subject boundary", async () => {
    await expect(recordDiagnosticEvent({ context: CONTEXT, event: event({ subjectKey: null }) }))
      .rejects.toThrow("SECURITY_AUDIT_SUBJECT_REQUIRED");
    expect(mocks.appendDiagnosticEvent).not.toHaveBeenCalled();
  });
});

