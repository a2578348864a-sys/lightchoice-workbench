import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerVoiceResearchEvidence } from "@/lib/sourceLayer/v2/contracts";

const mocks = vi.hoisted(() => ({
  callAiJson: vi.fn(),
  getReviewEvidence: vi.fn(),
  readReviewEvidenceSnapshot: vi.fn(),
  mutateTaskResultJson: vi.fn(),
  persistedResult: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/server/aiClient", () => ({ callAiJson: mocks.callAiJson }));
vi.mock("@/lib/server/reviewEvidence", () => ({
  VOC_ANALYSIS_NAMESPACE: "vocAnalysis",
  getReviewEvidence: mocks.getReviewEvidence,
  readReviewEvidenceSnapshot: mocks.readReviewEvidenceSnapshot,
}));
vi.mock("@/lib/server/taskResultJsonMutation", () => ({
  TaskResultJsonMutationError: class TaskResultJsonMutationError extends Error {
    constructor(
      public readonly code: string,
      public readonly status: number,
      message: string,
    ) {
      super(message);
      this.name = "TaskResultJsonMutationError";
    }
  },
  mutateTaskResultJson: mocks.mutateTaskResultJson,
}));

import { adaptCustomerVoiceEvidenceToVocObservations, analyzeVoc, getVocAnalysis, VocAnalysisError } from "@/lib/server/vocAnalysis";
import { TaskResultJsonMutationError } from "@/lib/server/taskResultJsonMutation";

const context = { mode: "owner", token: "" } as const;
const sourceAttachmentId = "raw-review-source-1";
const observationId = "amazon-review-external-id-1";

function group(ids: readonly string[], attachmentId: string): CustomerVoiceResearchEvidence {
  return {
    attachmentId,
    contentHash: "b".repeat(64),
    source: "amazon_review",
    observationCount: ids.length,
    omittedCount: 0,
    observations: ids.map((externalContentId) => ({
      refId: `attachment:${attachmentId}`,
      externalContentId,
      contentHash: "a".repeat(64),
      source: "amazon_review",
      evidenceRefs: [`attachment:${sourceAttachmentId}`],
      limitations: ["public_top_reviews_only"],
      parentContentId: null,
      threadId: null,
      subreddit: null,
      depth: null,
      contentType: "review",
      title: "Strong build",
      text: `The product feels sturdy. Source row ${externalContentId}.`,
      rating: 5,
      verifiedPurchase: true,
      publishedAt: "2026-09-01T00:00:00.000Z",
      engagement: null,
      authorRef: null,
      provenance: {
        provider: "amazon_dom",
        method: "capture_v3_amazon_review",
        accessBasis: "first_party_visible_page",
        sourceAttachmentId,
        rawArtifactId: null,
        providerTermsVersion: null,
      },
      identityMatch: "EXACT",
      ownerExperience: null,
    })),
  };
}

function analyzeInput(customerVoiceEvidence = [group([observationId], "customer-voice-att-1")]) {
  return {
    context,
    taskId: "task-fixture",
    candidateId: "candidate-fixture",
    subjectKey: "amazon:US:B000000001",
    customerVoiceEvidence,
    expectedStorageVersion: { resultJsonHash: "hash-fixture", updatedAt: "2026-09-01T00:00:00.000Z" },
  };
}

const successfulAiResult = (evidenceRefs: string[] = [observationId]) => ({
  ok: true,
  providerCallStarted: true,
  diagnostics: { model: "authorized-provider-test" },
  data: {
    positiveThemes: [{ label: "结实耐用", summary: "观察提到产品结构牢固。", evidenceRefs }],
    painPointThemes: [],
    usageScenarios: [],
    recurringRequests: [],
    conflicts: [],
    weakSignals: [],
    unknowns: [],
    nextResearchSteps: [],
  },
});

describe("VOC consumes canonical ResearchInputBundle Customer Voice only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persistedResult = null;
    mocks.readReviewEvidenceSnapshot.mockImplementation(async () => ({
      updatedAt: "2026-09-01T00:00:00.000Z",
      resultJson: JSON.stringify(mocks.persistedResult ?? {}),
      candidateId: "candidate-fixture",
    }));
    mocks.mutateTaskResultJson.mockImplementation(async (input: { mutate: (current: Record<string, unknown>) => { result: Record<string, unknown>; value: unknown } }) => {
      const outcome = input.mutate({});
      mocks.persistedResult = outcome.result;
      return { value: outcome.value };
    });
  });

  it("deduplicates duplicate canonical observations across two attachments without losing either citation chain", () => {
    const ids = Array.from({ length: 13 }, (_, index) => `amazon-review-${index + 1}`);
    const observations = adaptCustomerVoiceEvidenceToVocObservations([
      group(ids, "customer-voice-attachment-a"),
      group(ids, "customer-voice-attachment-b"),
    ]);

    expect(observations).toHaveLength(13);
    expect(observations.map((item) => item.observationId)).toEqual(ids);
    expect(observations[0]?.observationId).toBe(ids[0]);
    expect(observations[0]?.bindings.map((binding) => binding.observationAttachmentRef)).toEqual([
      "attachment:customer-voice-attachment-a",
      "attachment:customer-voice-attachment-b",
    ]);
    expect(observations[0]?.bindings[0]).toMatchObject({
      source: "amazon_review",
      sourceEvidenceRefs: [`attachment:${sourceAttachmentId}`],
      limitations: ["public_top_reviews_only"],
      identityMatch: "EXACT",
      provenance: { provider: "amazon_dom", method: "capture_v3_amazon_review", sourceAttachmentId },
    });
  });

  it("fails closed before Provider when canonical Customer Voice is empty, regardless of legacy ReviewEvidence", async () => {
    mocks.getReviewEvidence.mockResolvedValue({ dataset: { reviews: [{ evidenceId: "legacy-row" }] } });

    await expect(analyzeVoc(analyzeInput([]))).rejects.toMatchObject({
      name: "VocAnalysisError",
      code: "NO_CUSTOMER_VOICE_DATA",
      status: 400,
    } satisfies Partial<VocAnalysisError>);

    expect(mocks.getReviewEvidence).not.toHaveBeenCalled();
    expect(mocks.callAiJson).not.toHaveBeenCalled();
    expect(mocks.mutateTaskResultJson).not.toHaveBeenCalled();
  });

  it("does not retry a failed Provider response or persist an error analysis", async () => {
    mocks.callAiJson.mockResolvedValue({
      ok: false,
      providerCallStarted: true,
      error: { code: "json_parse_error", message: "invalid response" },
    });

    await expect(analyzeVoc(analyzeInput())).rejects.toMatchObject({
      name: "VocAnalysisError",
      code: "VOC_PROVIDER_HUMAN_REQUIRED",
      status: 503,
    } satisfies Partial<VocAnalysisError>);

    expect(mocks.callAiJson).toHaveBeenCalledOnce();
    expect(mocks.mutateTaskResultJson).not.toHaveBeenCalled();
    expect(mocks.persistedResult).toBeNull();
  });

  it("persists only a successful observation citation and can read it back with its attachment source", async () => {
    mocks.callAiJson.mockResolvedValue(successfulAiResult());

    const result = await analyzeVoc(analyzeInput());
    const providerRequest = mocks.callAiJson.mock.calls[0]?.[0] as { messages: Array<{ role: string; content: string }> };
    const providerInput = JSON.parse(providerRequest.messages.find((message) => message.role === "user")?.content ?? "{}") as {
      observations?: Array<Record<string, unknown>>;
    };

    expect(result.analysis.model).toBe("authorized-provider-test");
    expect(providerInput.observations?.[0]).toMatchObject({
      observationId,
      limitations: ["public_top_reviews_only"],
      sourceEvidenceRefs: [`attachment:${sourceAttachmentId}`],
    });
    expect(result.gateResult).toBe("pass");
    expect(result.analysis.themes.positiveThemes[0]?.evidenceRefs).toEqual([observationId]);
    expect(result.analysis.observationEvidence).toEqual([{
      observationId,
      bindings: [{
        observationAttachmentRef: "attachment:customer-voice-att-1",
        observationAttachmentHash: "b".repeat(64),
        sourceEvidenceRefs: [`attachment:${sourceAttachmentId}`],
        limitations: ["public_top_reviews_only"],
        source: "amazon_review",
        contentHash: "a".repeat(64),
        identityMatch: "EXACT",
        provenance: {
          provider: "amazon_dom",
          method: "capture_v3_amazon_review",
          accessBasis: "first_party_visible_page",
          sourceAttachmentId,
          rawArtifactId: null,
          providerTermsVersion: null,
        },
      }],
    }]);
    expect(mocks.mutateTaskResultJson).toHaveBeenCalledOnce();
    expect(mocks.persistedResult?.vocAnalysis).toMatchObject({
      schema: "voc-analysis.v1",
      datasetSnapshot: { totalObservations: 1, observationsUsed: 1, sampledObservations: [observationId] },
      themes: { positiveThemes: [{ evidenceRefs: [observationId], observationCount: 1, reviewCount: 1 }] },
    });
    await expect(getVocAnalysis(context, "task-fixture")).resolves.toMatchObject({
      schema: "voc-analysis.v1",
      observationEvidence: [{ observationId, bindings: [{ observationAttachmentRef: "attachment:customer-voice-att-1" }] }],
      themes: { positiveThemes: [{ evidenceRefs: [observationId] }] },
    });
    expect(mocks.getReviewEvidence).not.toHaveBeenCalled();
  });

  it("does not report completion when Task result CAS rejects the save", async () => {
    mocks.callAiJson.mockResolvedValue(successfulAiResult());
    mocks.mutateTaskResultJson.mockRejectedValueOnce(
      new TaskResultJsonMutationError("stale_storage_version", 409, "任务已更新，请刷新后重试。"),
    );

    await expect(analyzeVoc(analyzeInput())).rejects.toMatchObject({
      name: "VocAnalysisError",
      code: "stale_storage_version",
      status: 409,
    });

    expect(mocks.callAiJson).toHaveBeenCalledOnce();
    expect(mocks.mutateTaskResultJson).toHaveBeenCalledOnce();
    expect(mocks.persistedResult).toBeNull();
  });

  it("rejects output refs outside the canonical observations", async () => {
    mocks.callAiJson.mockResolvedValue(successfulAiResult(["review-evidence-not-in-bundle"]));

    const result = await analyzeVoc(analyzeInput());

    expect(result.gateResult).toBe("fail");
    expect(result.analysis.themes.positiveThemes).toEqual([]);
    expect(result.unverified).toHaveLength(1);
    expect(result.unverified[0]?.evidenceRefs).toEqual([]);
    expect(JSON.stringify(mocks.persistedResult)).not.toContain("review-evidence-not-in-bundle");
  });
});
