import { describe, expect, it } from "vitest";

import {
  evaluateMonitoringCapturePair,
  type MonitoringCaptureOutcome,
  type MonitoringEvidenceSnapshot,
  type MonitoringPolicy,
} from "@/lib/server/continuousMonitoringDiff";

function snapshot(input: {
  capturedAt: string;
  attachmentId: string;
  contentHash: string;
  reviewCount?: number;
  rating?: number;
  title?: string;
  sourceType?: "amazon_dom" | "sellersprite_plugin";
  metricNature?: "source_observed" | "provider_estimate";
  status?: "VALIDATED_AVAILABLE" | "AVAILABLE_WITH_LIMITATION" | "BLOCKED_WITH_EVIDENCE";
  /** Overrides merged over the default registeredFields (e.g. an ambiguous price). */
  fieldOverrides?: Record<string, unknown>;
}): MonitoringEvidenceSnapshot {
  const sourceType = input.sourceType ?? "amazon_dom";
  const metricNature = input.metricNature ?? "source_observed";
  const status = input.status ?? "VALIDATED_AVAILABLE";
  const evidence = {
    schemaVersion: "capture-system-v3-module-evidence.v1" as const,
    module: "amazon_detail" as const,
    subjectKey: "amazon:US:B0113UZJE2",
    marketplace: "US",
    capturedAt: input.capturedAt,
    provider: sourceType === "amazon_dom" ? "Amazon" : "SellerSprite",
    sourceSurface: "Amazon product detail DOM",
    sourceUrl: "https://www.amazon.com/dp/B0113UZJE2",
    providerUpdatedAt: null,
    freshness: { state: "unknown" as const, cadenceKey: "amazon_price" as const, ttlMs: 172_800_000, providerUpdatedAt: null, ageMs: null },
    acquisitionMode: "DOM_DIRECT" as const,
    metricNature,
    status,
    limitations: [],
    identity: { asin: "B0113UZJE2" },
    data: {
      registeredFields: {
        price: { fieldNature: "DIRECT_FACT", status: "observed", value: { amount: 18.99, currency: "USD" } },
        rating: { fieldNature: "DIRECT_FACT", status: "observed", value: input.rating ?? 4.6 },
        reviewCount: { fieldNature: "DIRECT_FACT", status: "observed", value: input.reviewCount ?? 1032 },
        title: { fieldNature: "DIRECT_FACT", status: "observed", value: input.title ?? "Original title" },
        ...(input.fieldOverrides ?? {}),
      },
      payload: { title: input.title ?? "Original title", sourceMethod: "amazon_detail_dom" },
      pageFieldPresenceAudit: { generatedAt: input.capturedAt },
    },
    evidenceOnly: true,
  };
  return {
    sourceType,
    evidence,
    evidenceRef: {
      subjectKey: evidence.subjectKey,
      module: evidence.module,
      attachmentId: input.attachmentId,
      contentHash: input.contentHash,
      capturedAt: evidence.capturedAt,
      sourceType,
      provider: evidence.provider,
      acquisitionMode: evidence.acquisitionMode,
      metricNature,
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

describe("continuous monitoring V3 evidence comparison spike", () => {
  it("ignores evidence IDs, timestamp, hash, field ordering, and non-business metadata", () => {
    const before = snapshot({
      capturedAt: "2026-09-26T08:48:49.287Z",
      attachmentId: "att-before",
      contentHash: "a".repeat(64),
      title: "Title from first capture",
    });
    const after = snapshot({
      capturedAt: "2026-09-27T08:48:49.287Z",
      attachmentId: "att-after",
      contentHash: "b".repeat(64),
      title: "Updated title outside the first allowlist",
    });

    const result = evaluateMonitoringCapturePair({
      previous: before,
      capture: { status: "CAPTURED", snapshot: after },
      policy,
    });

    expect(result.status).toBe("NO_MEANINGFUL_CHANGE");
    expect(result.diffs).toEqual([]);
    expect(result.changeEvent).toBeNull();
  });

  it("detects a controlled reviewCount increase and keeps both evidence references and provenance", () => {
    const before = snapshot({
      capturedAt: "2026-09-26T08:48:49.287Z",
      attachmentId: "att-before",
      contentHash: "a".repeat(64),
      reviewCount: 1032,
    });
    const changedFixture = snapshot({
      capturedAt: "2026-09-27T08:48:49.287Z",
      attachmentId: "att-after",
      contentHash: "b".repeat(64),
      reviewCount: 1033,
    });

    const result = evaluateMonitoringCapturePair({
      previous: before,
      capture: { status: "CAPTURED", snapshot: changedFixture },
      policy,
    });

    expect(result.status).toBe("CHANGE_DETECTED");
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]).toMatchObject({
      field: "reviewCount",
      before: 1032,
      after: 1033,
      delta: 1,
      source: "amazon_dom",
      metricNature: "source_observed",
      previousEvidenceRef: before.evidenceRef,
      currentEvidenceRef: changedFixture.evidenceRef,
    });
    expect(result.changeEvent).toMatchObject({
      subjectKey: "amazon:US:B0113UZJE2",
      module: "amazon_detail",
      evidenceRefs: [before.evidenceRef, changedFixture.evidenceRef],
    });
  });

  it("fails closed when capture fails without producing a diff or change event", () => {
    const before = snapshot({
      capturedAt: "2026-09-26T08:48:49.287Z",
      attachmentId: "att-before",
      contentHash: "a".repeat(64),
    });
    const failedCapture: MonitoringCaptureOutcome = {
      status: "FAILED",
      errorCode: "CAPTCHA_DETECTED",
    };

    const result = evaluateMonitoringCapturePair({ previous: before, capture: failedCapture, policy });

    expect(result).toMatchObject({
      status: "RUN_FAILED",
      errorCode: "CAPTCHA_DETECTED",
      diffs: [],
      changeEvent: null,
    });
  });

  it("does not compare a different source, metric nature, subject, or blocked status", () => {
    const before = snapshot({
      capturedAt: "2026-09-26T08:48:49.287Z",
      attachmentId: "att-before",
      contentHash: "a".repeat(64),
    });
    const mismatches = [
      snapshot({ capturedAt: "2026-09-27T08:48:49.287Z", attachmentId: "att-source", contentHash: "b".repeat(64), sourceType: "sellersprite_plugin", metricNature: "provider_estimate" }),
      snapshot({ capturedAt: "2026-09-27T08:48:49.287Z", attachmentId: "att-nature", contentHash: "c".repeat(64), metricNature: "provider_estimate" }),
      { ...snapshot({ capturedAt: "2026-09-27T08:48:49.287Z", attachmentId: "att-subject", contentHash: "d".repeat(64) }), evidence: { ...before.evidence, subjectKey: "amazon:CA:B0113UZJE2" } },
      snapshot({ capturedAt: "2026-09-27T08:48:49.287Z", attachmentId: "att-blocked", contentHash: "e".repeat(64), status: "BLOCKED_WITH_EVIDENCE" }),
    ];

    for (const current of mismatches) {
      const result = evaluateMonitoringCapturePair({
        previous: before,
        capture: { status: "CAPTURED", snapshot: current as MonitoringEvidenceSnapshot },
        policy,
      });
      expect(result.status).toBe("NOT_COMPARABLE");
      expect(result.changeEvent).toBeNull();
    }
  });
});
