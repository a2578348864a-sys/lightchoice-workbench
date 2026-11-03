import { describe, expect, it, vi } from "vitest";

import type { AccessContext } from "@/lib/server/accessPassword";
import { sourceEvidenceAttachmentContentHash } from "@/lib/sourceLayer/evidenceAttachment";
import type { EvidenceSubjectRecord } from "@/lib/sourceLayer/server/evidenceStore";
import { captureContentHashOf, type CaptureEvidenceRecord } from "@/lib/sourceLayer/sourceAdapter";
import {
  captureSellerSpriteReverseAsinBatch,
  isSellerSpriteReverseAsinBcrEnabled,
} from "./sellerSpriteReverseAsinBatch";
import { sellerSpriteQueryFingerprint } from "./sellerSpriteVisibleQuery";

// 批量 BCR 用例需显式声明运行范围；生产缺省仍为 single_asin_only（只允许单 ASIN）。
process.env.V5_ACQUISITION_SCOPE = "batch_and_single";

const owner: AccessContext = { mode: "owner", token: "" };
const ASIN = "B000000001";
const SUBJECT = `amazon:US:${ASIN}`;
const enabledEnv = { NODE_ENV: "test", LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single", SELLERSPRITE_REVERSE_ASIN_BCR_ENABLED: "true" } as NodeJS.ProcessEnv;
const disabledEnv = { NODE_ENV: "test", LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single", SELLERSPRITE_REVERSE_ASIN_BCR_ENABLED: "false" } as NodeJS.ProcessEnv;

function baseEvidence(): EvidenceSubjectRecord {
  const pkg = {
    schemaVersion: "capture-package.v1",
    captureId: `capture-${ASIN}`,
    subjectKey: SUBJECT,
    version: 1,
    marketplace: "US",
    fields: { asin: ASIN, title: "Verified product", brand: null, images: [], price: null, rating: null, reviewCount: null, bsr: null, subCategoryBsr: null, estimatedMonthlySales: null, estimatedMonthlyRevenueUsd: null, keywords: [] },
    fieldStates: {}, sourceProof: {}, replay: {}, riskFlags: [],
  } as never;
  const contentHash = captureContentHashOf(pkg as never);
  const evidence: CaptureEvidenceRecord = {
    schemaVersion: "source-evidence-record.v1",
    evidenceId: `evidence-${ASIN}`,
    captureId: `capture-${ASIN}`,
    subjectKey: SUBJECT,
    version: 1,
    sourceType: "amazon_dom",
    sourceUrl: `https://www.amazon.com/dp/${ASIN}`,
    capturedAt: "2026-10-13T00:00:00.000Z",
    contentHash,
    pkg,
    validation: { verdict: "passed", readyForResearch: false, issueCodes: [], checkedAt: "2026-10-13T00:00:00.000Z" },
    factAuthority: "evidence_only",
  };
  return {
    schemaVersion: "source-evidence-subject.v1",
    subjectKey: SUBJECT,
    marketplace: "US",
    updatedAt: "2026-10-13T00:00:00.000Z",
    operator: "owner:v1",
    versions: [evidence],
    attachments: [],
  };
}

function fixtureAttachment(input: {
  captureJobFingerprint: string;
  queryFingerprint: string;
  identityAsin?: string;
}) {
  const queryInput = { module: "reverse_asin" as const, targetAsin: ASIN, marketplace: "US" as const };
  const payload = {
    schemaVersion: "capture-system-v3-module-evidence.v1",
    module: "reverse_asin",
    subjectKey: SUBJECT,
    marketplace: "US",
    capturedAt: "2026-10-13T00:00:00.000Z",
    provider: "SellerSprite",
    sourceSurface: "SellerSprite Reverse ASIN",
    sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
    providerUpdatedAt: null,
    freshness: { cadenceKey: "reverse_asin" },
    acquisitionMode: "DOM_DIRECT",
    metricNature: "provider_estimate",
    status: "AVAILABLE_WITH_LIMITATION",
    limitations: ["visible_rows_are_not_total_rows"],
    identity: { asin: input.identityAsin ?? ASIN },
    data: {
      queryInput,
      queryIdentity: {
        module: "reverse_asin",
        subjectKey: SUBJECT,
        marketplace: "US",
        query: ASIN,
        queryFingerprint: input.queryFingerprint,
        captureJobFingerprint: input.captureJobFingerprint,
      },
      captureWindow: { captureWindowKey: "a".repeat(64), snapshotFingerprint: "b".repeat(64) },
      rowEvidenceBindings: [{ rowKey: "row-1", rowContentHash: "c".repeat(64) }],
      visibleSnapshot: { tables: [] },
    },
    evidenceOnly: true,
  };
  const contentHash = sourceEvidenceAttachmentContentHash({
    kind: "v3_reverse_asin_v1",
    sourceType: "sellersprite_plugin",
    subjectKey: SUBJECT,
    payload,
  });
  const attachment = {
    schemaVersion: "source-evidence-attachment.v1",
    attachmentId: "reverse-attachment-01",
    subjectKey: SUBJECT,
    kind: "v3_reverse_asin_v1",
    sourceType: "sellersprite_plugin",
    capturedAt: "2026-10-13T00:00:00.000Z",
    sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
    sourceFingerprint: input.queryFingerprint,
    contentHash,
    payload,
  };
  return { attachment, payload };
}

function captureEnvelope(input: {
  attachment: ReturnType<typeof fixtureAttachment>["attachment"];
  base: EvidenceSubjectRecord;
  attachmentHash?: string;
}) {
  const base = input.base.versions[0]!;
  const attachmentHash = input.attachmentHash ?? input.attachment.contentHash;
  const attachment = input.attachment;
  return {
    moduleEvidence: { module: "reverse_asin", subjectKey: SUBJECT },
    downstream: { subjectKey: SUBJECT, attachmentId: attachment.attachmentId },
    attachment: { ...attachment, contentHash: attachmentHash },
    gateway: {
      sourceEvidenceRef: { subjectKey: SUBJECT, evidenceId: base.evidenceId, version: base.version, contentHash: base.contentHash },
      attachment: { ...attachment, contentHash: attachmentHash },
    },
  } as never;
}

function makeCaptureMock(input?: {
  status?: "captured" | "limited" | "human_required" | "failed";
  errorCode?: string;
  omitCapture?: boolean;
  corruptEnvelope?: boolean;
  identityAsin?: string;
}) {
  const subject = baseEvidence();
  const base = subject.versions[0]!;
  const captureQuery = vi.fn(async (args: { queryInput: { module: "reverse_asin"; targetAsin: string; marketplace: "US" }; captureJobFingerprint: string }) => {
    const queryFingerprint = sellerSpriteQueryFingerprint(args.queryInput, "bcr");
    if (input?.status === "human_required" || input?.status === "failed") {
      return {
        status: input.status,
        module: "reverse_asin",
        sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
        snapshot: null,
        capture: null,
        errorCode: input.errorCode ?? "SELLERSPRITE_CAPTURE_FAILED",
      } as never;
    }
    const { attachment } = fixtureAttachment({
      captureJobFingerprint: args.captureJobFingerprint,
      queryFingerprint,
      identityAsin: input?.identityAsin,
    });
    subject.attachments = [...(subject.attachments ?? []), attachment as never];
    const capture = input?.omitCapture ? null : captureEnvelope({
      attachment,
      base: subject,
      attachmentHash: input?.corruptEnvelope ? "d".repeat(64) : undefined,
    });
    return {
      status: input?.status ?? "captured",
      module: "reverse_asin",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
      snapshot: {} as never,
      capture,
      windows: [{ capture }],
      traversal: { finalStatus: "COMPLETE" },
      errorCode: null,
    } as never;
  });
  return { subject, captureQuery, getSubject: async (subjectKey: string) => subjectKey === SUBJECT ? subject : null };
}

describe("SellerSprite Reverse ASIN BCR worker", () => {
  it("keeps real-source execution disabled unless both acquisition flags are enabled", async () => {
    expect(isSellerSpriteReverseAsinBcrEnabled(disabledEnv)).toBe(false);
    expect(isSellerSpriteReverseAsinBcrEnabled({ NODE_ENV: "test", SELLERSPRITE_REVERSE_ASIN_BCR_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(false);
    const fixture = makeCaptureMock();
    const result = await captureSellerSpriteReverseAsinBatch({
      context: owner, batchId: "batch-reverse-asin", limit: 1, targetAsins: [ASIN], idempotencyKey: "job-1", env: disabledEnv,
    }, fixture as never);
    expect(fixture.captureQuery).not.toHaveBeenCalled();
    expect(result.value.items[0]).toMatchObject({ status: "failed_permanent", errorCode: "SELLERSPRITE_REVERSE_ASIN_BCR_DISABLED" });
  });

  it("preflights verified product Evidence before the query and captures only the exact ASIN with one window", async () => {
    const fixture = makeCaptureMock();
    const result = await captureSellerSpriteReverseAsinBatch({
      context: owner, batchId: "batch-reverse-asin", limit: 1, targetAsins: [ASIN], idempotencyKey: "job-1", env: enabledEnv,
    }, fixture as never);
    expect(fixture.captureQuery).toHaveBeenCalledTimes(1);
    expect(fixture.captureQuery).toHaveBeenCalledWith(expect.objectContaining({
      module: "reverse_asin",
      subjectKey: SUBJECT,
      identity: { asin: ASIN },
      queryInput: { module: "reverse_asin", targetAsin: ASIN, marketplace: "US" },
      maxWindows: 1,
    }));
    expect(result.value.items[0]).toMatchObject({
      asin: ASIN,
      status: "captured_partial",
      evidenceId: "reverse-attachment-01",
      sourceEvidenceRef: {
        subjectKey: SUBJECT,
        baseEvidenceId: `evidence-${ASIN}`,
        baseEvidenceVersion: 1,
        module: "reverse_asin",
        sourceType: "sellersprite_plugin",
      },
    });
  });

  it("fails closed when base Evidence is missing, without invoking SellerSprite", async () => {
    const captureQuery = vi.fn();
    const result = await captureSellerSpriteReverseAsinBatch({
      context: owner, batchId: "batch-reverse-asin", limit: 1, targetAsins: [ASIN], idempotencyKey: "job-1", env: enabledEnv,
    }, { getSubject: async () => null, captureQuery: captureQuery as never });
    expect(captureQuery).not.toHaveBeenCalled();
    expect(result.value.items[0]).toMatchObject({ status: "failed_retryable", errorCode: "SELLERSPRITE_BASE_EVIDENCE_MISSING" });
  });

  it("rejects a hash-valid attachment whose product identity does not match the requested ASIN", async () => {
    const fixture = makeCaptureMock({ identityAsin: "B000000002" });
    const result = await captureSellerSpriteReverseAsinBatch({
      context: owner, batchId: "batch-reverse-asin", limit: 1, targetAsins: [ASIN], idempotencyKey: "job-1", env: enabledEnv,
    }, fixture as never);
    expect(result.value.items[0]).toMatchObject({ status: "failed_permanent", errorCode: "SELLERSPRITE_REVERSE_ASIN_EVIDENCE_IDENTITY_INVALID" });
  });

  it("requires a Gateway envelope for newly written evidence and verifies its source reference", async () => {
    const noEnvelope = makeCaptureMock({ omitCapture: true });
    const missing = await captureSellerSpriteReverseAsinBatch({
      context: owner, batchId: "batch-reverse-asin", limit: 1, targetAsins: [ASIN], idempotencyKey: "job-1", env: enabledEnv,
    }, noEnvelope as never);
    expect(missing.value.items[0]).toMatchObject({ status: "failed_permanent", errorCode: "SELLERSPRITE_REVERSE_ASIN_GATEWAY_RECEIPT_MISSING" });

    const wrongEnvelope = makeCaptureMock({ corruptEnvelope: true });
    const invalid = await captureSellerSpriteReverseAsinBatch({
      context: owner, batchId: "batch-reverse-asin", limit: 1, targetAsins: [ASIN], idempotencyKey: "job-1", env: enabledEnv,
    }, wrongEnvelope as never);
    expect(invalid.value.items[0]).toMatchObject({ status: "failed_permanent", errorCode: "SELLERSPRITE_REVERSE_ASIN_SOURCE_REFERENCE_INVALID" });
  });

  it.each(["SELLERSPRITE_LOGIN_REQUIRED", "SELLERSPRITE_CAPTCHA_REQUIRED", "SELLERSPRITE_STOP_REQUIRED"])(
    "maps %s to a human gate without treating it as evidence success",
    async (errorCode) => {
      const fixture = makeCaptureMock({ status: "human_required", errorCode });
      const result = await captureSellerSpriteReverseAsinBatch({
        context: owner, batchId: "batch-reverse-asin", limit: 1, targetAsins: [ASIN], idempotencyKey: "job-1", env: enabledEnv,
      }, fixture as never);
      expect(result.value.items[0]).toMatchObject({ asin: ASIN, status: "failed_human", evidenceId: null, errorCode });
    },
  );

  it("propagates a pause/cancel check before any source operation", async () => {
    const fixture = makeCaptureMock();
    const result = await captureSellerSpriteReverseAsinBatch({
      context: owner,
      batchId: "batch-reverse-asin",
      limit: 1,
      targetAsins: [ASIN],
      idempotencyKey: "job-1",
      env: enabledEnv,
      shouldStop: async () => true,
    }, fixture as never);
    expect(result.stopped).toBe(true);
    expect(fixture.captureQuery).not.toHaveBeenCalled();
    expect(result.value.items).toHaveLength(0);
  });
});
