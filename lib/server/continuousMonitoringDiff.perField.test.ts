import { describe, expect, it } from "vitest";

import {
  evaluateMonitoringCapturePair,
  type MonitoringCaptureOutcome,
  type MonitoringEvidenceSnapshot,
  type MonitoringPolicy,
} from "@/lib/server/continuousMonitoringDiff";

/**
 * Regression coverage for the 2026-11-02 audit finding: a single unreadable field
 * (Amazon buy-box price with `conflicting_candidates`) used to void the whole run,
 * discarding valid rating and reviewCount changes.
 */

function snapshot(input: {
  capturedAt: string;
  attachmentId: string;
  contentHash: string;
  rating?: number;
  reviewCount?: number;
  fieldOverrides?: Record<string, unknown>;
}): MonitoringEvidenceSnapshot {
  const evidence = {
    schemaVersion: "capture-system-v3-module-evidence.v1" as const,
    module: "amazon_detail" as const,
    subjectKey: "amazon:US:B0DKNN9WCX",
    marketplace: "US",
    capturedAt: input.capturedAt,
    provider: "Amazon",
    sourceSurface: "Amazon product detail DOM",
    sourceUrl: "https://www.amazon.com/dp/B0DKNN9WCX",
    providerUpdatedAt: null,
    freshness: { state: "unknown" as const, cadenceKey: "amazon_price" as const, ttlMs: 172_800_000, providerUpdatedAt: null, ageMs: null },
    acquisitionMode: "DOM_DIRECT" as const,
    metricNature: "source_observed" as const,
    status: "VALIDATED_AVAILABLE" as const,
    limitations: [],
    identity: { asin: "B0DKNN9WCX" },
    data: {
      registeredFields: {
        price: { fieldNature: "DIRECT_FACT", status: "observed", value: { amount: 79.99, currency: "USD" } },
        rating: { fieldNature: "DIRECT_FACT", status: "observed", value: input.rating ?? 4.3 },
        reviewCount: { fieldNature: "DIRECT_FACT", status: "observed", value: input.reviewCount ?? 785 },
        ...(input.fieldOverrides ?? {}),
      },
      payload: { sourceMethod: "amazon_detail_dom" },
      pageFieldPresenceAudit: { generatedAt: input.capturedAt },
    },
    evidenceOnly: true,
  };
  return {
    sourceType: "amazon_dom",
    evidence,
    evidenceRef: {
      subjectKey: evidence.subjectKey,
      module: evidence.module,
      attachmentId: input.attachmentId,
      contentHash: input.contentHash,
      capturedAt: evidence.capturedAt,
      sourceType: "amazon_dom",
      provider: evidence.provider,
      acquisitionMode: evidence.acquisitionMode,
      metricNature: evidence.metricNature,
      rawArtifactId: `raw-${input.attachmentId}`,
      rawArtifactHash: input.contentHash,
    },
  };
}

const policy: MonitoringPolicy = {
  cooldownMinutes: 120,
  rules: [
    { field: "price", comparison: "numeric_delta", absoluteThreshold: 0.5, relativeThreshold: 0.05, enabled: true },
    { field: "rating", comparison: "numeric_delta", absoluteThreshold: 0.1, relativeThreshold: null, enabled: true },
    { field: "reviewCount", comparison: "numeric_delta", absoluteThreshold: 1, relativeThreshold: null, enabled: true },
  ],
};

const ambiguousPrice = {
  fieldNature: "DIRECT_FACT",
  status: "ambiguous",
  value: null,
  reason: "conflicting_candidates",
};

const BASELINE_AT = "2026-10-05T05:00:17.998Z";
const LATEST_AT = "2026-10-22T10:54:46.246Z";

function compare(previous: MonitoringEvidenceSnapshot, current: MonitoringEvidenceSnapshot) {
  const capture: MonitoringCaptureOutcome = { status: "CAPTURED", snapshot: current };
  return evaluateMonitoringCapturePair({ previous, capture, policy });
}

describe("per-field comparison with an unreadable field", () => {
  it("keeps rating and reviewCount changes when price is ambiguous", () => {
    const result = compare(
      snapshot({ capturedAt: BASELINE_AT, attachmentId: "att-before", contentHash: "a".repeat(64), rating: 4.3, reviewCount: 785 }),
      snapshot({
        capturedAt: LATEST_AT,
        attachmentId: "att-after",
        contentHash: "b".repeat(64),
        rating: 4.2,
        reviewCount: 826,
        fieldOverrides: { price: ambiguousPrice },
      }),
    );

    expect(result.status).toBe("CHANGE_DETECTED");
    if (result.status !== "CHANGE_DETECTED") throw new Error("unreachable");
    expect(result.diffs.map((diff) => diff.field).sort()).toEqual(["rating", "reviewCount"]);
    expect(result.diffs.find((diff) => diff.field === "rating")).toMatchObject({ before: 4.3, after: 4.2, delta: -0.1 });
    expect(result.uncomparable).toEqual([
      { field: "price", reason: "field_status_ambiguous", detail: "conflicting_candidates" },
    ]);
    expect(result.changeEvent?.evidenceRefs).toHaveLength(2);
  });

  it("returns NOT_COMPARABLE only when every enabled field is unreadable", () => {
    const result = compare(
      snapshot({ capturedAt: BASELINE_AT, attachmentId: "att-before", contentHash: "a".repeat(64) }),
      snapshot({
        capturedAt: LATEST_AT,
        attachmentId: "att-after",
        contentHash: "b".repeat(64),
        fieldOverrides: {
          price: ambiguousPrice,
          rating: { fieldNature: "DIRECT_FACT", status: "missing", value: null },
          reviewCount: { fieldNature: "DIRECT_FACT", status: "missing", value: null },
        },
      }),
    );

    expect(result.status).toBe("NOT_COMPARABLE");
    if (result.status !== "NOT_COMPARABLE") throw new Error("unreachable");
    expect(result.reason.startsWith("all_enabled_fields_not_comparable:")).toBe(true);
    expect(result.diffs).toEqual([]);
    expect(result.uncomparable).toHaveLength(3);
    expect(result.changeEvent).toBeNull();
  });

  it("keeps NO_MEANINGFUL_CHANGE with the gap recorded when comparable fields did not move", () => {
    const result = compare(
      snapshot({ capturedAt: BASELINE_AT, attachmentId: "att-before", contentHash: "a".repeat(64), rating: 4.3, reviewCount: 785 }),
      snapshot({
        capturedAt: LATEST_AT,
        attachmentId: "att-after",
        contentHash: "b".repeat(64),
        rating: 4.3,
        reviewCount: 785,
        fieldOverrides: { price: ambiguousPrice },
      }),
    );

    expect(result.status).toBe("NO_MEANINGFUL_CHANGE");
    if (result.status !== "NO_MEANINGFUL_CHANGE") throw new Error("unreachable");
    expect(result.diffs).toEqual([]);
    expect(result.uncomparable).toEqual([
      { field: "price", reason: "field_status_ambiguous", detail: "conflicting_candidates" },
    ]);
  });

  it("treats an exact 0.1 star drop as a meaningful change despite float subtraction", () => {
    const result = compare(
      snapshot({ capturedAt: BASELINE_AT, attachmentId: "att-before", contentHash: "a".repeat(64), rating: 4.3, reviewCount: 785 }),
      snapshot({ capturedAt: LATEST_AT, attachmentId: "att-after", contentHash: "b".repeat(64), rating: 4.2, reviewCount: 785 }),
    );

    expect(result.status).toBe("CHANGE_DETECTED");
    if (result.status !== "CHANGE_DETECTED") throw new Error("unreachable");
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]).toMatchObject({ field: "rating", before: 4.3, after: 4.2, delta: -0.1 });
  });

  it("never emits a diff or change event for an unreadable field", () => {
    const result = compare(
      snapshot({ capturedAt: BASELINE_AT, attachmentId: "att-before", contentHash: "a".repeat(64), rating: 4.3, reviewCount: 785 }),
      snapshot({
        capturedAt: LATEST_AT,
        attachmentId: "att-after",
        contentHash: "b".repeat(64),
        rating: 4.3,
        reviewCount: 785,
        fieldOverrides: { price: ambiguousPrice },
      }),
    );

    expect(result.diffs.some((diff) => diff.field === "price")).toBe(false);
    expect(result.changeEvent).toBeNull();
  });

  it("treats a currency change as uncomparable but still compares other fields", () => {
    const result = compare(
      snapshot({ capturedAt: BASELINE_AT, attachmentId: "att-before", contentHash: "a".repeat(64), reviewCount: 785 }),
      snapshot({
        capturedAt: LATEST_AT,
        attachmentId: "att-after",
        contentHash: "b".repeat(64),
        reviewCount: 826,
        fieldOverrides: {
          price: { fieldNature: "DIRECT_FACT", status: "observed", value: { amount: 130, currency: "CNY" } },
        },
      }),
    );

    expect(result.status).toBe("CHANGE_DETECTED");
    if (result.status !== "CHANGE_DETECTED") throw new Error("unreachable");
    expect(result.uncomparable).toEqual([{ field: "price", reason: "unit_mismatch", detail: "USD->CNY" }]);
    expect(result.diffs.map((diff) => diff.field)).toEqual(["reviewCount"]);
  });

  it("does not compare when capture failed, even with an unreadable field in policy", () => {
    const result = evaluateMonitoringCapturePair({
      previous: snapshot({ capturedAt: BASELINE_AT, attachmentId: "att-before", contentHash: "a".repeat(64) }),
      capture: { status: "FAILED", errorCode: "CAPTCHA_DETECTED" },
      policy,
    });

    expect(result).toMatchObject({ status: "RUN_FAILED", errorCode: "CAPTCHA_DETECTED", diffs: [], changeEvent: null });
  });
});
