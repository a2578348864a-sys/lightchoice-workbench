import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ callAiJson: vi.fn() }));
vi.mock("@/lib/server/aiClient", () => ({ callAiJson: mocks.callAiJson }));

import type { MonitoringEvidenceReference, MonitoringFieldDiff } from "@/lib/server/continuousMonitoringDiff";
import { explainMonitoringChange, setMonitoringExplanationClientForTests } from "@/lib/server/continuousMonitoringAi";

const previous: MonitoringEvidenceReference = {
  subjectKey: "amazon:US:B0113UZJE2",
  module: "amazon_detail",
  attachmentId: "att-previous",
  contentHash: "a".repeat(64),
  capturedAt: "2026-09-26T01:00:00.000Z",
  sourceType: "amazon_dom",
  provider: "Amazon",
  acquisitionMode: "DOM_DIRECT",
  metricNature: "source_observed",
  rawArtifactId: "raw-previous",
  rawArtifactHash: "b".repeat(64),
};
const current: MonitoringEvidenceReference = {
  ...previous,
  attachmentId: "att-current",
  contentHash: "c".repeat(64),
  capturedAt: "2026-09-27T01:00:00.000Z",
  rawArtifactId: "raw-current",
  rawArtifactHash: "d".repeat(64),
};
const diff: MonitoringFieldDiff = {
  field: "reviewCount",
  comparison: "numeric_delta",
  before: 1_032,
  after: 1_033,
  delta: 1,
  relativeDelta: 1 / 1_032,
  unit: "reviews",
  absoluteThreshold: 1,
  relativeThreshold: null,
  source: "amazon_dom",
  metricNature: "source_observed",
  previousEvidenceRef: previous,
  currentEvidenceRef: current,
};

describe("monitoring AI explanation boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMonitoringExplanationClientForTests(null);
    delete process.env.CONTINUOUS_MONITORING_AI_EXPLANATION_ENABLED;
  });

  it("does not call any provider unless the explicit feature gate is enabled", async () => {
    const result = await explainMonitoringChange({ diffs: [diff], evidenceRefs: [previous, current] });
    expect(result).toEqual({ status: "UNAVAILABLE", code: "AI_EXPLANATION_DISABLED" });
    expect(mocks.callAiJson).not.toHaveBeenCalled();
  });

  it("sends only deterministic changes and allowed references, then validates returned references", async () => {
    process.env.CONTINUOUS_MONITORING_AI_EXPLANATION_ENABLED = "true";
    mocks.callAiJson.mockResolvedValue({
      ok: true,
      data: { explanation: "评论数较上次增加 1。", evidenceAttachmentIds: [previous.attachmentId, current.attachmentId] },
    });

    const result = await explainMonitoringChange({ diffs: [diff], evidenceRefs: [previous, current] });

    expect(result).toEqual({ status: "AVAILABLE", explanation: "评论数较上次增加 1。", evidenceRefs: [previous, current] });
    const request = mocks.callAiJson.mock.calls[0][0];
    expect(request.maxTokens).toBeLessThanOrEqual(360);
    expect(request.timeoutMs).toBeLessThanOrEqual(20_000);
    const promptText = JSON.stringify(request.messages);
    expect(promptText).toContain("deterministicChanges");
    expect(promptText).toContain("allowedEvidenceRefs");
    expect(promptText).not.toContain("rawPageHtml");
  });

  it("rejects model-invented evidence references and turns provider errors into unavailable", async () => {
    process.env.CONTINUOUS_MONITORING_AI_EXPLANATION_ENABLED = "true";
    mocks.callAiJson.mockResolvedValueOnce({
      ok: true,
      data: { explanation: "变化已核对。", evidenceAttachmentIds: ["att-invented"] },
    }).mockResolvedValueOnce({ ok: false, error: { code: "provider_error", message: "not surfaced" } });

    const invalid = await explainMonitoringChange({ diffs: [diff], evidenceRefs: [previous, current] });
    const failed = await explainMonitoringChange({ diffs: [diff], evidenceRefs: [previous, current] });
    expect(invalid).toEqual({ status: "UNAVAILABLE", code: "AI_REFERENCE_SCOPE_INVALID" });
    expect(failed).toEqual({ status: "UNAVAILABLE", code: "AI_PROVIDER_UNAVAILABLE" });
  });
});
