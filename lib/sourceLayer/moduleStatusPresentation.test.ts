import { describe, expect, it } from "vitest";

import { projectOrchestratorReceiptStatus, projectV3ModuleFailure, projectV3ModuleStatus, readProductBatchDetailEnrichment, countReviewEvidence } from "@/lib/sourceLayer/moduleStatusPresentation";

describe("product-facing V3 module status", () => {
  it.each([
    ["human_action_required", undefined, "HUMAN_ACTION_REQUIRED"],
    ["human_action_required", "LOGIN_REQUIRED", "LOGIN_REQUIRED"],
    ["human_action_required", "CAPTCHA_DETECTED", "HUMAN_ACTION_REQUIRED"],
    ["login_required", undefined, "LOGIN_REQUIRED"],
    ["extension_required", undefined, "EXTENSION_REQUIRED"],
    ["plan_limited", undefined, "PLAN_LIMITED"],
    ["failed_retryable", undefined, "BLOCKED_WITH_EVIDENCE"],
    ["source_input_required", undefined, "HUMAN_ACTION_REQUIRED"],
    ["not_attempted", undefined, "HUMAN_ACTION_REQUIRED"],
    ["unknown", undefined, null],
  ] as const)("maps receipt status %s without inventing completion", (status, errorCode, expected) => {
    expect(projectOrchestratorReceiptStatus(status, errorCode)).toBe(expected);
  });

  it.each([
    ["VALIDATED_AVAILABLE", undefined, "COMPLETE"],
    ["AVAILABLE_WITH_LIMITATION", undefined, "AVAILABLE_WITH_LIMITATION"],
    ["PLAN_LIMITATION", undefined, "PLAN_LIMITED"],
    ["BLOCKED_WITH_EVIDENCE", "FAILED_RETRYABLE", "BLOCKED_WITH_EVIDENCE"],
    ["BLOCKED_WITH_EVIDENCE", "FAILED_PERMANENT", "BLOCKED_WITH_EVIDENCE"],
    ["HUMAN_ACTION_REQUIRED", "FAILED_HUMAN", "HUMAN_ACTION_REQUIRED"],
    ["AVAILABLE_WITH_LIMITATION", "NO_DATA_WITH_EVIDENCE", "NO_DATA_WITH_EVIDENCE"],
    ["AVAILABLE_WITH_LIMITATION", "COMPLETE", "COMPLETE"],
    ["AVAILABLE_WITH_LIMITATION", "CAPTURED_PARTIAL", "CAPTURED_PARTIAL"],
    ["UNVERIFIED", undefined, "CAPTURED_PARTIAL"],
  ] as const)("maps %s / %s to %s", (status, outcome, expected) => {
    expect(projectV3ModuleStatus({ status, outcome })).toBe(expected);
  });

  it("distinguishes login, extension, and CAPTCHA style human gates for the UI", () => {
    expect(projectV3ModuleStatus({ status: "HUMAN_ACTION_REQUIRED", errorCode: "LOGIN_REQUIRED" })).toBe("LOGIN_REQUIRED");
    expect(projectV3ModuleStatus({ status: "HUMAN_ACTION_REQUIRED", errorCode: "EXTENSION_NOT_FOUND" })).toBe("EXTENSION_REQUIRED");
    expect(projectV3ModuleStatus({ status: "HUMAN_ACTION_REQUIRED", errorCode: "CAPTCHA_REQUIRED" })).toBe("HUMAN_ACTION_REQUIRED");
  });

  it("preserves the Detail Enrichment Worker's explicit partial status when Detail evidence exists", () => {
    expect(projectV3ModuleStatus({ status: "VALIDATED_AVAILABLE", detailEnrichmentStatus: "captured_partial" })).toBe("CAPTURED_PARTIAL");
    expect(projectV3ModuleStatus({ status: "BLOCKED_WITH_EVIDENCE", detailEnrichmentStatus: "captured_partial" })).toBe("BLOCKED_WITH_EVIDENCE");
  });

  it("reads partial detail state only from an evidence-bound enrichment record", () => {
    const enrichment = {
      schemaVersion: "amazon-batch-detail-enrichment.v1",
      status: "captured_partial",
      module: "amazon_detail",
      evidenceId: "ev-detail-1",
      evidenceVersion: 2,
      contentHash: "a".repeat(64),
      capturedAt: "2026-10-06T20:52:44.047Z",
      fields: ["category", "bsr", "category"],
    };
    expect(readProductBatchDetailEnrichment(JSON.stringify({ asin: "B07BM9ZT2P", enrichment }))).toEqual({
      status: "captured_partial",
      evidenceId: "ev-detail-1",
      evidenceVersion: 2,
      contentHash: "a".repeat(64),
      capturedAt: "2026-10-06T20:52:44.047Z",
      fields: ["category", "bsr"],
    });
    expect(readProductBatchDetailEnrichment({ enrichment: { ...enrichment, contentHash: "invalid" } })).toBeNull();
    expect(readProductBatchDetailEnrichment({ enrichment: { ...enrichment, module: "variation" } })).toBeNull();
  });

  it("counts only full review bodies as full reviews", () => {
    expect(countReviewEvidence({
      reviews: [
        { completeness: "partial", reviewText: "公开 Top Reviews 片段" },
        { completeness: "full", reviewText: "完整评论正文" },
        { completeness: "full", reviewText: "   " },
        { completeness: "partial" },
        "not-an-object",
      ],
    })).toEqual({ reviewCount: 4, fullReviewCount: 1, partialReviewCount: 1 });
    expect(countReviewEvidence(undefined)).toEqual({ reviewCount: 0, fullReviewCount: 0, partialReviewCount: 0 });
  });

  it("never marks a review module COMPLETE when only public Top-Reviews snippets exist", () => {
    // Real persisted shape: outcome COMPLETE + limitation public_top_reviews_only, all cards partial.
    expect(projectV3ModuleStatus({
      status: "AVAILABLE_WITH_LIMITATION",
      outcome: "COMPLETE",
      reviewEvidence: { reviewCount: 13, fullReviewCount: 0, partialReviewCount: 13 },
    })).toBe("CAPTURED_PARTIAL");
    expect(projectV3ModuleStatus({
      status: "VALIDATED_AVAILABLE",
      outcome: "COMPLETE",
      reviewEvidence: { reviewCount: 1, fullReviewCount: 0, partialReviewCount: 1 },
    })).toBe("CAPTURED_PARTIAL");
  });

  it("keeps COMPLETE reachable once a full review body exists", () => {
    expect(projectV3ModuleStatus({
      status: "VALIDATED_AVAILABLE",
      outcome: "COMPLETE",
      reviewEvidence: { reviewCount: 5, fullReviewCount: 5, partialReviewCount: 0 },
    })).toBe("COMPLETE");
  });

  it("preserves the COMPLETE contract for non-review modules", () => {
    expect(projectV3ModuleStatus({ status: "VALIDATED_AVAILABLE", outcome: "COMPLETE", reviewEvidence: null })).toBe("COMPLETE");
    expect(projectV3ModuleStatus({ status: "VALIDATED_AVAILABLE", outcome: "COMPLETE" })).toBe("COMPLETE");
  });

  it("treats an explicit page ASIN mismatch as permanent even if the stored retry flag conflicts", () => {
    expect(projectV3ModuleFailure({
      data: {
        outcome: "FAILED_RETRYABLE",
        error: { code: "REVIEW_SOURCE_UNAVAILABLE", retryable: true },
        captureDiagnostics: { bindingReason: "page_asin_anchor_mismatch" },
      },
      limitations: ["review_page_page_unknown"],
    })).toEqual({
      outcome: "FAILED_PERMANENT",
      errorCode: "ASIN_PAGE_ANCHOR_MISMATCH",
      retryable: false,
      limitations: ["page_asin_anchor_mismatch"],
    });
  });

  it("preserves the stored module error when no stronger identity diagnostic exists", () => {
    expect(projectV3ModuleFailure({
      data: { outcome: "FAILED_RETRYABLE", error: { code: "REVIEW_EXTRACTION_EMPTY", retryable: true } },
      limitations: ["review_page_extraction_empty"],
    })).toEqual({
      outcome: "FAILED_RETRYABLE",
      errorCode: "REVIEW_EXTRACTION_EMPTY",
      retryable: true,
      limitations: ["review_page_extraction_empty"],
    });
  });
});
