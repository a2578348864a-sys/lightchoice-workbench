import { describe, expect, it } from "vitest";

import { buildCapturePackage, type CapturePackageDraft } from "@/lib/sourceLayer/capturePackage";
import {
  allowedNextStates,
  canTransition,
  createCaptureLifecycle,
  happyPathProgress,
  isExceptionCaptureState,
  isTerminalCaptureState,
  transitionCapture,
  CAPTURE_HAPPY_PATH,
} from "@/lib/sourceLayer/stateMachine";

const T0 = "2026-02-01T00:00:00.000Z";

function draft(): CapturePackageDraft {
  const providerExport = "provider_export" as const;
  const field = <T,>(value: T, sourceRef: string) => ({
    value,
    valueOrigin: providerExport,
    sourceRef,
    confidence: 1,
  });
  return {
    subjectKey: "amazon:US:B0FH1ZXTN1",
    marketplace: "US",
    fields: {
      asin: field("B0FH1ZXTN1", "x.asin"),
      title: field("Owala FreeSip Insulated Stainless Steel Water Bottle 24 oz", "x.title"),
      images: field(["https://m.media-amazon.com/images/I/a.jpg"], "x.images"),
      price: field({ amount: 29.99, currency: "USD" }, "x.price"),
      rating: field(4.6, "x.rating"),
      reviewCount: field(2948, "x.reviews"),
      bsr: field({ rank: 120, category: "Sports & Outdoors" }, "x.bsr"),
      keywords: field(["water bottle"], "x.keywords"),
    },
    sourceProof: {
      sourceType: "sellersprite_xlsx",
      sourceUrl: "https://www.amazon.com/dp/B0FH1ZXTN1",
      capturedAt: T0,
      captureMethod: "xlsx_export",
      operator: "owner:v1",
      sourceFingerprint: "a".repeat(64),
      sourceRecordRef: "rows=2",
    },
    replay: { url: null, capturedAt: T0, pageDigest: "sheet=US", warnings: [] },
  };
}

function lifecycle() {
  return createCaptureLifecycle({
    captureId: "cap-1",
    subjectKey: "amazon:US:B0FH1ZXTN1",
    createdAt: T0,
    operator: "owner:v1",
  });
}

describe("capture lifecycle", () => {
  it("starts at CREATED with an audit entry", () => {
    const state = lifecycle();
    expect(state.state).toBe("CREATED");
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0].nextState).toBe("CREATED");
    expect(state.audit[0].timestamp).toBe(T0);
  });

  it("walks the documented happy path and records from/to/reason/timestamp each step", () => {
    let state = lifecycle();
    const steps = CAPTURE_HAPPY_PATH.slice(1);
    for (const step of steps) {
      const result = transitionCapture({
        lifecycle: state,
        to: step,
        reason: `进入 ${step}`,
        timestamp: T0,
        operator: "owner:v1",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      state = result.lifecycle;
    }
    expect(state.state).toBe("READY_FOR_RESEARCH");
    const transitions = state.audit.filter((entry) => entry.eventKind === "state_transition");
    expect(transitions).toHaveLength(steps.length);
    for (const entry of transitions) {
      expect(entry.previousState).not.toBeNull();
      expect(entry.nextState).not.toBeNull();
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(Number.isFinite(Date.parse(entry.timestamp))).toBe(true);
    }
    expect(happyPathProgress(state.state).complete).toBe(true);
    expect(happyPathProgress("NORMALIZING").reached).toBe(4);
  });

  it("refuses to skip stages and records the refusal without changing state", () => {
    const state = lifecycle();
    const result = transitionCapture({
      lifecycle: state,
      to: "READY_FOR_RESEARCH",
      reason: "跳过前置步骤",
      timestamp: T0,
      operator: "owner:v1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TRANSITION_FORBIDDEN");
    expect(result.lifecycle.state).toBe("CREATED");
    expect(result.lifecycle.audit.at(-1)?.errorCode).toBe("TRANSITION_FORBIDDEN");
  });

  it("requires an explicit reason (AUDIT_REQUIRED, fail-closed)", () => {
    let state = lifecycle();
    const first = transitionCapture({
      lifecycle: state,
      to: "SOURCE_CHECKING",
      reason: "检查来源",
      timestamp: T0,
      operator: "owner:v1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    state = first.lifecycle;
    const result = transitionCapture({
      lifecycle: state,
      to: "CAPTURE_RUNNING",
      reason: "   ",
      timestamp: T0,
      operator: "owner:v1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("AUDIT_REQUIRED");
    expect(state.state).toBe("SOURCE_CHECKING");
  });

  it("allows RETRYABLE to re-enter the pipeline and HUMAN_REQUIRED to resume only forward", () => {
    expect(allowedNextStates("RETRYABLE")).toContain("SOURCE_CHECKING");
    expect(allowedNextStates("HUMAN_REQUIRED")).toContain("EVIDENCE_VALIDATING");
    expect(allowedNextStates("SOURCE_CHECKING")).toContain("HUMAN_REQUIRED");
    expect(canTransition("READY_FOR_RESEARCH", "CREATED")).toBe(false);
    expect(isTerminalCaptureState("READY_FOR_RESEARCH")).toBe(true);
    expect(isTerminalCaptureState("RETRYABLE")).toBe(false);
    expect(isExceptionCaptureState("BLOCKED")).toBe(true);
  });

  it("keeps the happy path shape stable", () => {
    expect([...CAPTURE_HAPPY_PATH]).toEqual([
      "CREATED",
      "SOURCE_CHECKING",
      "CAPTURE_RUNNING",
      "NORMALIZING",
      "EVIDENCE_VALIDATING",
      "READY_FOR_RESEARCH",
    ]);
  });
});

describe("state machine does not touch the capture package contract", () => {
  it("builds a package independently of lifecycle transitions", () => {
    const pkg = buildCapturePackage({ captureId: "cap-1", version: 1, draft: draft() });
    expect(pkg.fields.asin).toBe("B0FH1ZXTN1");
  });
});
