import "server-only";

import { createHash } from "node:crypto";

import type { AccessContext } from "@/lib/server/accessPassword";
import {
  captureSellerSpriteVisibleQuery,
  sellerSpriteQueryFingerprint,
  type SellerSpriteQueryInput,
  type SellerSpriteVisibleQueryResult,
} from "@/lib/server/sellerSpriteVisibleQuery";
import {
  preflightSellerSpriteProductMarketBaseEvidence,
  type ProductMarketBaseEvidence,
} from "@/lib/server/sellerSpriteProductMarketBatch";
import { sourceEvidenceAttachmentContentHash, type SourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import type { EvidenceSubjectRecord } from "@/lib/sourceLayer/server/evidenceStore";
import type { V3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";

const REVERSE_ASIN_URL = "https://www.sellersprite.com/v3/keyword-reverse/";
const ASIN_PATTERN = /^[A-Z0-9]{10}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export type ReverseAsinVerifiedSourceRef = {
  subjectKey: string;
  baseEvidenceId: string;
  baseEvidenceVersion: number;
  baseEvidenceContentHash: string;
  attachmentId: string;
  attachmentContentHash: string;
  module: "reverse_asin";
  sourceType: "sellersprite_plugin";
  queryFingerprint: string;
  captureJobFingerprint: string;
};

export type ReverseAsinBatchItem = {
  asin: string;
  status: "captured_partial" | "skipped_existing" | "failed_retryable" | "failed_permanent" | "failed_human";
  evidenceId: string | null;
  errorCode: string | null;
  sourceEvidenceRef?: ReverseAsinVerifiedSourceRef;
};

export type ReverseAsinBatchResult = {
  value: { items: ReverseAsinBatchItem[] };
  replayed: boolean;
  receiptId: string;
  stopped?: boolean;
};

type ReverseAsinWorkerDeps = {
  getSubject?: (subjectKey: string) => Promise<EvidenceSubjectRecord | null>;
  captureQuery?: typeof captureSellerSpriteVisibleQuery;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isSellerSpriteReverseAsinBcrEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOCAL_ACQUISITION_ENABLED === "true"
    && env.SELLERSPRITE_REVERSE_ASIN_BCR_ENABLED === "true";
}

function matchesReverseAttachment(input: {
  attachment: SourceEvidenceAttachment;
  subjectKey: string;
  asin: string;
  queryFingerprint: string;
  captureJobFingerprint: string;
}): boolean {
  const { attachment } = input;
  if (attachment.subjectKey !== input.subjectKey
    || attachment.kind !== "v3_reverse_asin_v1"
    || attachment.sourceType !== "sellersprite_plugin"
    || !HASH_PATTERN.test(attachment.contentHash)
    || sourceEvidenceAttachmentContentHash({
      kind: attachment.kind,
      sourceType: attachment.sourceType,
      subjectKey: attachment.subjectKey,
      payload: attachment.payload,
    }) !== attachment.contentHash) return false;

  const payload = attachment.payload as unknown as V3ModuleEvidence;
  const data = isRecord(payload.data) ? payload.data : null;
  const queryInput = data && isRecord(data.queryInput) ? data.queryInput : null;
  const queryIdentity = data && isRecord(data.queryIdentity) ? data.queryIdentity : null;
  const captureWindow = data && isRecord(data.captureWindow) ? data.captureWindow : null;
  const bindings = data?.rowEvidenceBindings;
  return payload.schemaVersion === "capture-system-v3-module-evidence.v1"
    && payload.module === "reverse_asin"
    && payload.subjectKey === input.subjectKey
    && payload.metricNature === "provider_estimate"
    && isRecord(payload.identity)
    && payload.identity.asin === input.asin
    && queryInput?.module === "reverse_asin"
    && queryInput.targetAsin === input.asin
    && queryInput.marketplace === "US"
    && queryIdentity?.module === "reverse_asin"
    && queryIdentity.subjectKey === input.subjectKey
    && queryIdentity.marketplace === "US"
    && queryIdentity.query === input.asin
    && queryIdentity.queryFingerprint === input.queryFingerprint
    && queryIdentity.captureJobFingerprint === input.captureJobFingerprint
    && Boolean(captureWindow && HASH_PATTERN.test(String(captureWindow.captureWindowKey ?? "")))
    && Boolean(captureWindow && HASH_PATTERN.test(String(captureWindow.snapshotFingerprint ?? "")))
    && Array.isArray(bindings)
    && bindings.every((binding) => isRecord(binding)
      && typeof binding.rowKey === "string" && binding.rowKey.length > 0
      && typeof binding.rowContentHash === "string" && HASH_PATTERN.test(binding.rowContentHash));
}

function matchingStoredAttachment(input: {
  subject: EvidenceSubjectRecord | null;
  subjectKey: string;
  asin: string;
  queryFingerprint: string;
  captureJobFingerprint: string;
}): SourceEvidenceAttachment | null {
  return input.subject?.attachments?.find((attachment) => matchesReverseAttachment({
    attachment,
    subjectKey: input.subjectKey,
    asin: input.asin,
    queryFingerprint: input.queryFingerprint,
    captureJobFingerprint: input.captureJobFingerprint,
  })) ?? null;
}

function sourceReferenceMatches(input: {
  capture: NonNullable<SellerSpriteVisibleQueryResult["capture"]>;
  base: ProductMarketBaseEvidence;
  subjectKey: string;
  queryFingerprint: string;
  captureJobFingerprint: string;
  attachment: SourceEvidenceAttachment;
}): boolean {
  const ref = input.capture.gateway.sourceEvidenceRef;
  // Reverse ASIN 是商品级证据：没有商品 Evidence 引用即不成立，fail-closed。
  if (!ref) return false;
  return ref.subjectKey === input.subjectKey
    && ref.evidenceId === input.base.evidenceId
    && ref.version === input.base.version
    && ref.contentHash === input.base.contentHash
    && input.capture.moduleEvidence.module === "reverse_asin"
    && input.capture.moduleEvidence.subjectKey === input.subjectKey
    && input.capture.downstream.subjectKey === input.subjectKey
    && input.capture.downstream.attachmentId === input.attachment.attachmentId
    && input.capture.attachment.attachmentId === input.attachment.attachmentId
    && input.capture.attachment.contentHash === input.attachment.contentHash
    && input.capture.gateway.attachment.contentHash === input.attachment.contentHash
    && matchesReverseAttachment({
      attachment: input.attachment,
      subjectKey: input.subjectKey,
      asin: input.subjectKey.slice("amazon:US:".length),
      queryFingerprint: input.queryFingerprint,
      captureJobFingerprint: input.captureJobFingerprint,
    });
}

function emptyItem(asin: string, status: ReverseAsinBatchItem["status"], errorCode: string): ReverseAsinBatchItem {
  return { asin, status, evidenceId: null, errorCode };
}

/**
 * Reverse ASIN runs through the existing V3 Gateway and product Evidence subject.
 * Visible windows are intentionally bounded to one per ASIN; partial window evidence
 * never marks the BCR cell complete or Research-consumable.
 */
export async function captureSellerSpriteReverseAsinBatch(input: {
  context: AccessContext;
  batchId: string;
  limit: number;
  targetAsins: readonly string[];
  idempotencyKey: string;
  shouldStop?: () => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
}, deps: ReverseAsinWorkerDeps = {}): Promise<ReverseAsinBatchResult> {
  const requested = [...new Set(input.targetAsins.map((asin) => asin.trim().toUpperCase()))].slice(0, input.limit);
  if (!isSellerSpriteReverseAsinBcrEnabled(input.env)) {
    return {
      value: { items: requested.map((asin) => emptyItem(asin, "failed_permanent", "SELLERSPRITE_REVERSE_ASIN_BCR_DISABLED")) },
      replayed: false,
      receiptId: input.idempotencyKey,
    };
  }
  if (requested.some((asin) => !ASIN_PATTERN.test(asin))) {
    return {
      value: { items: requested.map((asin) => emptyItem(asin, "failed_permanent", "SELLERSPRITE_TARGET_ASIN_INVALID")) },
      replayed: false,
      receiptId: input.idempotencyKey,
    };
  }

  const preflight = await preflightSellerSpriteProductMarketBaseEvidence({
    context: input.context,
    authorizedAsins: requested,
  }, deps.getSubject ? { getSubject: deps.getSubject } : {});
  const queryable = requested.filter((asin) => preflight.evidenceByAsin.has(asin));
  const missing = new Set(preflight.missingAsins);
  const items: ReverseAsinBatchItem[] = requested
    .filter((asin) => missing.has(asin))
    .map((asin) => emptyItem(asin, "failed_retryable", "SELLERSPRITE_BASE_EVIDENCE_MISSING"));
  const captureQuery = deps.captureQuery ?? captureSellerSpriteVisibleQuery;
  const getSubject = deps.getSubject ?? (async (subjectKey: string) => {
    const { createEvidenceStore } = await import("@/lib/sourceLayer/server/evidenceStore");
    const { sourceLayerOperator } = await import("@/lib/sourceLayer/server/sourceLayerService");
    return createEvidenceStore(sourceLayerOperator(input.context)).getSubject(subjectKey);
  });

  for (const asin of queryable) {
    if (await input.shouldStop?.()) {
      return { value: { items }, replayed: false, receiptId: input.idempotencyKey, stopped: true };
    }
    const subjectKey = `amazon:US:${asin}`;
    const base = preflight.evidenceByAsin.get(asin)!;
    const queryInput: Extract<SellerSpriteQueryInput, { module: "reverse_asin" }> = {
      module: "reverse_asin",
      targetAsin: asin,
      marketplace: "US",
    };
    const queryFingerprint = sellerSpriteQueryFingerprint(queryInput, "bcr");
    const captureJobFingerprint = hashFingerprint(`${input.idempotencyKey}:reverse_asin:${asin}`);
    let before: EvidenceSubjectRecord | null;
    try {
      before = await getSubject(subjectKey);
    } catch {
      items.push(emptyItem(asin, "failed_retryable", "SELLERSPRITE_EVIDENCE_READBACK_FAILED"));
      continue;
    }
    const beforeIds = new Set((before?.attachments ?? []).map((attachment) => attachment.attachmentId));
    const result = await captureQuery({
      context: input.context,
      module: "reverse_asin",
      sourceUrl: REVERSE_ASIN_URL,
      subjectKey,
      identity: { asin },
      queryInput,
      accountAccessFingerprint: "bcr",
      captureJobFingerprint,
      attemptGeneration: 1,
      maxWindows: 1,
      shouldStop: input.shouldStop,
    });
    if (result.errorCode === "SELLERSPRITE_CAPTURE_JOB_STOPPED" || await input.shouldStop?.()) {
      return { value: { items }, replayed: false, receiptId: input.idempotencyKey, stopped: true };
    }
    if (result.status === "human_required" || result.errorCode === "SELLERSPRITE_LOGIN_REQUIRED"
      || result.errorCode === "SELLERSPRITE_CAPTCHA_REQUIRED" || result.errorCode === "SELLERSPRITE_STOP_REQUIRED") {
      items.push(emptyItem(asin, "failed_human", result.errorCode ?? "SELLERSPRITE_HUMAN_GATE_REQUIRED"));
      continue;
    }
    if (result.status === "unavailable" || result.status === "failed" || result.status === "query_error" || result.status === "empty") {
      const retryable = /CDP_UNAVAILABLE|RUNTIME_MISSING|TIMEOUT|NETWORK/iu.test(result.errorCode ?? "");
      items.push(emptyItem(asin, retryable ? "failed_retryable" : "failed_permanent", result.errorCode ?? "SELLERSPRITE_REVERSE_ASIN_QUERY_FAILED"));
      continue;
    }

    let after: EvidenceSubjectRecord | null;
    try {
      after = await getSubject(subjectKey);
    } catch {
      items.push(emptyItem(asin, "failed_retryable", "SELLERSPRITE_EVIDENCE_READBACK_FAILED"));
      continue;
    }
    const postflight = await preflightSellerSpriteProductMarketBaseEvidence({
      context: input.context,
      authorizedAsins: [asin],
    }, deps.getSubject ? { getSubject: deps.getSubject } : {});
    const currentBase = postflight.evidenceByAsin.get(asin);
    if (!currentBase || currentBase.evidenceId !== base.evidenceId
      || currentBase.version !== base.version || currentBase.contentHash !== base.contentHash) {
      items.push(emptyItem(asin, "failed_permanent", "SELLERSPRITE_BASE_EVIDENCE_CHANGED"));
      continue;
    }
    const attachment = matchingStoredAttachment({
      subject: after,
      subjectKey,
      asin,
      queryFingerprint,
      captureJobFingerprint,
    });
    if (!attachment) {
      items.push(emptyItem(asin, "failed_permanent", "SELLERSPRITE_REVERSE_ASIN_EVIDENCE_IDENTITY_INVALID"));
      continue;
    }
    const capture = result.windows?.find((window) => window.capture)?.capture ?? result.capture;
    const existedBefore = beforeIds.has(attachment.attachmentId);
    // A newly appended Evidence attachment must be tied to the Gateway envelope returned by
    // this execution. A readback alone can only be reused when the exact same job fingerprint
    // was already present before the call (idempotent replay).
    if (!capture && !existedBefore) {
      items.push(emptyItem(asin, "failed_permanent", "SELLERSPRITE_REVERSE_ASIN_GATEWAY_RECEIPT_MISSING"));
      continue;
    }
    if (capture && !sourceReferenceMatches({
      capture,
      base,
      subjectKey,
      queryFingerprint,
      captureJobFingerprint,
      attachment,
    })) {
      items.push(emptyItem(asin, "failed_permanent", "SELLERSPRITE_REVERSE_ASIN_SOURCE_REFERENCE_INVALID"));
      continue;
    }
    const verifiedSourceEvidenceRef: ReverseAsinVerifiedSourceRef = {
      subjectKey,
      baseEvidenceId: base.evidenceId,
      baseEvidenceVersion: base.version,
      baseEvidenceContentHash: base.contentHash,
      attachmentId: attachment.attachmentId,
      attachmentContentHash: attachment.contentHash,
      module: "reverse_asin",
      sourceType: "sellersprite_plugin",
      queryFingerprint,
      captureJobFingerprint,
    };
    items.push({
      asin,
      status: existedBefore ? "skipped_existing" : "captured_partial",
      evidenceId: attachment.attachmentId,
      errorCode: result.status === "limited" || result.traversal?.finalStatus !== "COMPLETE"
        ? "SELLERSPRITE_VISIBLE_EVIDENCE_PARTIAL"
        : null,
      sourceEvidenceRef: verifiedSourceEvidenceRef,
    });
  }
  return { value: { items }, replayed: false, receiptId: input.idempotencyKey };
}
