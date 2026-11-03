import { describe, expect, it, vi } from "vitest";

import { DEFAULT_MONITORING_POLICY } from "@/lib/server/continuousMonitoringContract";
import type { MonitoringEvidenceSnapshot, MonitoringEvidenceReference } from "@/lib/server/continuousMonitoringDiff";
import {
  type MonitoringRepository,
  type MonitoringRunRecord,
  type MonitoringWatchTarget,
} from "@/lib/server/continuousMonitoringRepository";
import { runMonitoringTarget } from "@/lib/server/continuousMonitoringService";

const NOW = "2026-09-27T01:00:00.000Z";

function snapshot(input: { capturedAt: string; reviewCount: number; metricNature?: "source_observed" | "provider_estimate" }): MonitoringEvidenceSnapshot {
  const metricNature = input.metricNature ?? "source_observed";
  const attachmentId = `att-${input.capturedAt.replace(/\D/gu, "").slice(-20).padStart(24, "0")}`;
  const contentHash = attachmentId.slice(-1).repeat(64);
  const evidence = {
    schemaVersion: "capture-system-v3-module-evidence.v1" as const,
    module: "amazon_detail" as const,
    subjectKey: "amazon:US:B0113UZJE2",
    marketplace: "US",
    capturedAt: input.capturedAt,
    provider: "Amazon",
    sourceSurface: "Amazon product detail DOM",
    sourceUrl: "https://www.amazon.com/dp/B0113UZJE2",
    providerUpdatedAt: null,
    freshness: { state: "unknown" as const, cadenceKey: "amazon_price" as const, ttlMs: 172_800_000, providerUpdatedAt: null, ageMs: null },
    acquisitionMode: "DOM_DIRECT" as const,
    metricNature,
    status: "VALIDATED_AVAILABLE" as const,
    limitations: [],
    identity: { asin: "B0113UZJE2" },
    data: {
      registeredFields: {
        price: { fieldNature: "DIRECT_FACT", status: "observed", value: { amount: 18.99, currency: "USD" } },
        rating: { fieldNature: "DIRECT_FACT", status: "observed", value: 4.6 },
        reviewCount: { fieldNature: "DIRECT_FACT", status: "observed", value: input.reviewCount },
      },
    },
    evidenceOnly: true,
  };
  const evidenceRef: MonitoringEvidenceReference = {
    subjectKey: evidence.subjectKey,
    module: "amazon_detail",
    attachmentId,
    contentHash,
    capturedAt: input.capturedAt,
    sourceType: "amazon_dom",
    provider: "Amazon",
    acquisitionMode: "DOM_DIRECT",
    metricNature,
    rawArtifactId: `raw-${attachmentId.slice(-24)}`,
    rawArtifactHash: contentHash,
  };
  return { sourceType: "amazon_dom", evidence, evidenceRef };
}

function setup(input: { baseline?: MonitoringEvidenceReference | null; lastMeaningfulChangeAt?: string | null } = {}) {
  const watch: MonitoringWatchTarget = {
    id: "watch-one",
    subjectKey: "amazon:US:B0113UZJE2",
    captureModule: "amazon_detail",
    enabled: true,
    schedule: "daily@09:00",
    timezone: "Asia/Shanghai",
    policy: DEFAULT_MONITORING_POLICY,
    lastRunAt: null,
    lastMeaningfulChangeAt: input.lastMeaningfulChangeAt ?? null,
    nextRunAt: "2026-09-28T01:00:00.000Z",
    activeRunId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const state: {
    began: boolean;
    completed: Parameters<MonitoringRepository["completeRun"]>[0] | null;
    failed: Parameters<MonitoringRepository["failRun"]>[0] | null;
    run: MonitoringRunRecord | null;
  } = { began: false, completed: null, failed: null, run: null };
  const repository: MonitoringRepository = {
    createWatch: async () => watch,
    getWatch: async () => watch,
    listWatches: async () => [watch],
    updateWatch: async () => watch,
    listDueWatches: async () => [],
    latestBaseline: async () => input.baseline ?? null,
    beginRun: async (begin) => {
      state.began = true;
      const run: MonitoringRunRecord = {
        id: begin.runId,
        watchTargetId: begin.watchTargetId,
        triggerType: begin.triggerType,
        status: "RUNNING",
        outcome: "RUNNING",
        startedAt: begin.startedAt,
        finishedAt: null,
        previousEvidenceRef: null,
        currentEvidenceRef: null,
        changeSummary: null,
        errorCode: null,
        errorMessage: null,
        aiExplanation: null,
      };
      state.run = run;
      return { kind: "STARTED", watch, run };
    },
    completeRun: async (complete) => {
      state.completed = complete;
      state.run = {
        id: complete.runId,
        watchTargetId: complete.watchTargetId,
        triggerType: "MANUAL",
        status: "SUCCEEDED",
        outcome: complete.outcome,
        startedAt: NOW,
        finishedAt: complete.finishedAt,
        previousEvidenceRef: complete.previousEvidenceRef,
        currentEvidenceRef: complete.currentEvidenceRef,
        changeSummary: complete.changeSummary,
        errorCode: null,
        errorMessage: null,
        aiExplanation: complete.aiExplanation,
      };
    },
    failRun: async (failure) => {
      state.failed = failure;
      state.run = {
        id: failure.runId,
        watchTargetId: failure.watchTargetId,
        triggerType: "MANUAL",
        status: "FAILED",
        outcome: "RUN_FAILED",
        startedAt: NOW,
        finishedAt: failure.finishedAt,
        previousEvidenceRef: failure.previousEvidenceRef,
        currentEvidenceRef: null,
        changeSummary: null,
        errorCode: failure.errorCode,
        errorMessage: failure.errorMessage,
        aiExplanation: null,
      };
    },
    listRuns: async () => [],
    getRun: async () => state.run,
    recoverInterruptedRuns: async () => 0,
  };
  return { watch, repository, state };
}

describe("continuous monitoring service", () => {
  it("establishes the first successful V3 capture as a baseline without invoking AI", async () => {
    const context = setup();
    const current = snapshot({ capturedAt: NOW, reviewCount: 1_032 });
    const explain = vi.fn(async () => ({ status: "AVAILABLE" as const, explanation: "unused" }));
    const result = await runMonitoringTarget({ watchTargetId: context.watch.id, triggerType: "MANUAL" }, {
      repository: context.repository,
      capture: async () => ({ status: "CAPTURED", snapshot: current }),
      explain,
      now: () => new Date(NOW),
    });
    expect(result.status).toBe("STARTED");
    expect(context.state.completed?.outcome).toBe("BASELINE_ESTABLISHED");
    expect(context.state.completed?.currentEvidenceRef).toEqual(current.evidenceRef);
    expect(context.state.failed).toBeNull();
    expect(explain).not.toHaveBeenCalled();
  });

  it("persists a meaningful deterministic change even when AI explanation is unavailable", async () => {
    const previous = snapshot({ capturedAt: "2026-09-26T01:00:00.000Z", reviewCount: 1_032 });
    const current = snapshot({ capturedAt: NOW, reviewCount: 1_033 });
    const context = setup({ baseline: previous.evidenceRef });
    const explain = vi.fn(async () => ({ status: "UNAVAILABLE" as const, code: "AI_PROVIDER_UNAVAILABLE" }));
    const result = await runMonitoringTarget({ watchTargetId: context.watch.id, triggerType: "MANUAL" }, {
      repository: context.repository,
      capture: async () => ({ status: "CAPTURED", snapshot: current }),
      loadSnapshot: async () => previous,
      explain,
      now: () => new Date(NOW),
    });
    expect(result.status).toBe("STARTED");
    expect(context.state.completed).toMatchObject({
      outcome: "CHANGE_DETECTED",
      meaningfulChange: true,
      previousEvidenceRef: previous.evidenceRef,
      currentEvidenceRef: current.evidenceRef,
      aiExplanation: { status: "UNAVAILABLE", code: "AI_PROVIDER_UNAVAILABLE" },
    });
    expect(context.state.completed?.changeSummary).toMatchObject({
      meaningfulChange: true,
      diffs: [{ field: "reviewCount", before: 1_032, after: 1_033, delta: 1 }],
    });
    expect(explain).toHaveBeenCalledTimes(1);
  });

  it("records real diffs during cooldown without emitting another event or calling AI", async () => {
    const previous = snapshot({ capturedAt: "2026-09-26T01:00:00.000Z", reviewCount: 1_032 });
    const current = snapshot({ capturedAt: NOW, reviewCount: 1_033 });
    const context = setup({
      baseline: previous.evidenceRef,
      lastMeaningfulChangeAt: "2026-09-27T00:30:00.000Z",
    });
    const explain = vi.fn(async () => ({ status: "AVAILABLE" as const, explanation: "unused" }));
    await runMonitoringTarget({ watchTargetId: context.watch.id, triggerType: "MANUAL" }, {
      repository: context.repository,
      capture: async () => ({ status: "CAPTURED", snapshot: current }),
      loadSnapshot: async () => previous,
      explain,
      now: () => new Date(NOW),
    });
    expect(context.state.completed?.outcome).toBe("COOLDOWN_SUPPRESSED");
    expect(context.state.completed?.meaningfulChange).toBe(false);
    expect(context.state.completed?.changeSummary.diffs).toHaveLength(1);
    expect(context.state.completed?.aiExplanation).toMatchObject({ status: "SKIPPED_COOLDOWN" });
    expect(explain).not.toHaveBeenCalled();
  });

  it("keeps blocked capture separate from business changes", async () => {
    const previous = snapshot({ capturedAt: "2026-09-26T01:00:00.000Z", reviewCount: 1_032 });
    const context = setup({ baseline: previous.evidenceRef });
    const explain = vi.fn(async () => ({ status: "AVAILABLE" as const, explanation: "unused" }));
    await runMonitoringTarget({ watchTargetId: context.watch.id, triggerType: "SCHEDULED" }, {
      repository: context.repository,
      capture: async () => ({ status: "HUMAN_ACTION_REQUIRED", errorCode: "CAPTCHA_DETECTED" }),
      explain,
      now: () => new Date(NOW),
    });
    expect(context.state.failed).toMatchObject({ errorCode: "CAPTCHA_DETECTED" });
    expect(context.state.completed).toBeNull();
    expect(explain).not.toHaveBeenCalled();
  });

  it("turns common capture failures into specific next-step guidance", async () => {
    const cases = [
      ["LOCAL_ENVIRONMENT_REQUIRED", "本次未能检查 Amazon 页面：当前本地采集环境未连接。请检查系统诊断中的本地采集状态后重试。"],
      ["AMAZON_CAPTURE_NON_US_EXIT", "本次未能检查 Amazon 页面：当前网络出口不是美国。请检查网络出口状态后重试。"],
    ] as const;

    for (const [errorCode, errorMessage] of cases) {
      const context = setup();
      await runMonitoringTarget({ watchTargetId: context.watch.id, triggerType: "MANUAL" }, {
        repository: context.repository,
        capture: async () => ({ status: "FAILED", errorCode }),
        now: () => new Date(NOW),
      });
      expect(context.state.failed).toMatchObject({ errorCode, errorMessage });
      expect(context.state.completed).toBeNull();
    }
  });

  it("fails closed on estimated-vs-observed provenance and missing prior Evidence readback", async () => {
    const estimated = snapshot({ capturedAt: "2026-09-26T01:00:00.000Z", reviewCount: 1_032, metricNature: "provider_estimate" });
    const current = snapshot({ capturedAt: NOW, reviewCount: 1_033 });
    const context = setup({ baseline: estimated.evidenceRef });
    await runMonitoringTarget({ watchTargetId: context.watch.id, triggerType: "MANUAL" }, {
      repository: context.repository,
      capture: async () => ({ status: "CAPTURED", snapshot: current }),
      loadSnapshot: async () => estimated,
      now: () => new Date(NOW),
    });
    expect(context.state.completed?.outcome).toBe("NOT_COMPARABLE");
    expect(context.state.completed?.meaningfulChange).toBe(false);
    expect(context.state.completed?.changeSummary.reason).toBe("evidence_identity_provenance_status_or_order_mismatch");

    const missingContext = setup({ baseline: estimated.evidenceRef });
    await runMonitoringTarget({ watchTargetId: missingContext.watch.id, triggerType: "MANUAL" }, {
      repository: missingContext.repository,
      capture: async () => ({ status: "CAPTURED", snapshot: current }),
      loadSnapshot: async () => null,
      now: () => new Date(NOW),
    });
    expect(missingContext.state.completed?.outcome).toBe("NOT_COMPARABLE");
    expect(missingContext.state.completed?.currentEvidenceRef).toEqual(current.evidenceRef);
  });
});
