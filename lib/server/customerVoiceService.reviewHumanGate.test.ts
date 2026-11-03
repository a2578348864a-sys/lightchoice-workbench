import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  collect: vi.fn(),
  getSubject: vi.fn(),
  captureAttachment: vi.fn(),
  captureModule: vi.fn(),
}));

vi.mock("@/lib/server/research/researchInputBundle", () => ({
  buildResearchInputBundle: vi.fn(async () => ({ subjectKey: "amazon:US:B0HUMGATE1" })),
}));
vi.mock("@/lib/sourceLayer/server/sourceLayerService", () => ({ sourceLayerOperator: vi.fn(() => "owner:v1") }));
vi.mock("@/lib/sourceLayer/server/evidenceStore", () => ({ createEvidenceStore: vi.fn(() => ({ getSubject: state.getSubject })) }));
vi.mock("@/lib/sourceLayer/server/captureGateway", () => ({ captureEvidenceAttachmentThroughGateway: state.captureAttachment }));
vi.mock("@/lib/sourceLayer/v3ModuleEvidence", () => ({
  captureV3ModuleEvidence: state.captureModule,
  parseV3ModuleEvidence: vi.fn(() => null),
}));
vi.mock("@/lib/server/captureRecipeBrowser", () => ({ collectAmazonReviewsWithPlaywright: state.collect }));
vi.mock("@/lib/sourceLayer/diagnostics", () => ({ newTraceId: vi.fn(() => "trace-review-human-gate") }));

import { collectAmazonReviewsForResearchTask, CustomerVoiceServiceError } from "@/lib/server/customerVoiceService";

const CONTEXT = { mode: "owner", token: "" } as const;

describe("collectAmazonReviewsForResearchTask human gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.getSubject.mockResolvedValue({ subjectKey: "amazon:US:B0HUMGATE1", versions: [{}], attachments: [] });
    state.captureAttachment.mockResolvedValue({ attachment: { attachmentId: "unused", contentHash: "a".repeat(64) } });
    state.captureModule.mockResolvedValue({ attachment: { attachmentId: "unused", contentHash: "b".repeat(64) } });
  });

  it.each([
    ["CAPTCHA_DETECTED", "captcha_required"],
    ["LOGIN_REQUIRED", "login_required"],
  ] as const)("keeps %s as a non-retryable human action and writes no review evidence", async (errorCode, pageStatus) => {
    state.collect.mockResolvedValue({
      status: "human_required",
      items: [],
      pageResults: [{ asin: "B0HUMGATE1", status: pageStatus, note: "human gate", extractedCount: 0 }],
      errorCode,
      errorMessage: "Amazon requires human action.",
      consoleErrors: 0,
      pageErrors: 0,
      browser: null,
    });

    await expect(collectAmazonReviewsForResearchTask({ context: CONTEXT, taskId: "task-human-gate" }))
      .rejects.toMatchObject({ code: errorCode, status: 409 });
    expect(state.captureAttachment).not.toHaveBeenCalled();
    expect(state.captureModule).not.toHaveBeenCalled();
  });

  it("returns an explicit no-public-reviews result without calling review or module writers", async () => {
    state.collect.mockResolvedValue({
      status: "failed",
      items: [],
      pageResults: [{ asin: "B0HUMGATE1", status: "confirmed_no_reviews", note: "none shown", extractedCount: 0 }],
      errorCode: "REVIEW_SOURCE_UNAVAILABLE",
      errorMessage: "No public reviews.",
      consoleErrors: 0,
      pageErrors: 0,
      browser: null,
    });

    await expect(collectAmazonReviewsForResearchTask({ context: CONTEXT, taskId: "task-no-reviews" }))
      .resolves.toMatchObject({ collectedCount: 0, added: 0, warning: expect.stringContaining("暂无公开评论") });
    expect(state.captureAttachment).not.toHaveBeenCalled();
    expect(state.captureModule).not.toHaveBeenCalled();
  });
});
