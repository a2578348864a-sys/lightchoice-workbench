import { createHash } from "node:crypto";

import type { CaptureSourceType } from "@/lib/sourceLayer/capturePackage";
import { contentHashOf } from "@/lib/sourceLayer/sourceAdapter";
import { parseCustomerVoiceAttachmentPayload } from "@/lib/sourceLayer/customerVoice";

export const SOURCE_EVIDENCE_ATTACHMENT_SCHEMA = "source-evidence-attachment.v1" as const;
export const SOURCE_EVIDENCE_ATTACHMENT_KINDS = [
  "keyword_evidence",
  "review_evidence",
  "keepa_timeseries_v1",
  "sellersprite_market_share_v1",
  "v3_amazon_detail_v1",
  "v3_amazon_search_market_v1",
  "v3_sellersprite_product_market_v1",
  "v3_reverse_asin_v1",
  "v3_keyword_mining_trend_v1",
  "v3_variation_v1",
  "v3_review_voc_v1",
  "v3_historical_trend_v1",
  "customer_voice_observation_v1",
] as const;
export type SourceEvidenceAttachmentKind = (typeof SOURCE_EVIDENCE_ATTACHMENT_KINDS)[number];

export type SourceEvidenceAttachment = {
  schemaVersion: typeof SOURCE_EVIDENCE_ATTACHMENT_SCHEMA;
  attachmentId: string;
  subjectKey: string;
  kind: SourceEvidenceAttachmentKind;
  sourceType: CaptureSourceType;
  capturedAt: string;
  sourceUrl: string | null;
  sourceFingerprint: string | null;
  contentHash: string;
  /** 由对应的 KeywordEvidence / ReviewEvidence / Keepa / SellerSprite 解析器先校验后写入。 */
  payload: Record<string, unknown>;
};

export const MAX_SOURCE_EVIDENCE_ATTACHMENT_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCaptureSourceType(value: unknown): value is CaptureSourceType {
  return value === "amazon_dom"
    || value === "sellersprite_plugin"
    || value === "sellersprite_xlsx"
    || value === "manual_entry"
    || value === "sellersprite_api"
    || value === "keepa_export"
    || value === "excel_upload"
    || value === "public_api"
    || value === "browser_agent";
}

export function sourceEvidenceAttachmentContentHash(input: {
  kind: SourceEvidenceAttachmentKind;
  sourceType: CaptureSourceType;
  subjectKey: string;
  payload: Record<string, unknown>;
}): string {
  return contentHashOf({
    kind: input.kind,
    sourceType: input.sourceType,
    subjectKey: input.subjectKey,
    payload: input.payload,
  });
}

export function buildSourceEvidenceAttachment(input: {
  attachmentId: string;
  subjectKey: string;
  kind: SourceEvidenceAttachmentKind;
  sourceType: CaptureSourceType;
  capturedAt: string;
  sourceUrl?: string | null;
  sourceFingerprint?: string | null;
  payload: Record<string, unknown>;
}): SourceEvidenceAttachment {
  if (!input.attachmentId.trim()) throw new Error("SOURCE_ATTACHMENT_ID_REQUIRED");
  if (!input.subjectKey.trim()) throw new Error("SOURCE_ATTACHMENT_SUBJECT_REQUIRED");
  if (!SOURCE_EVIDENCE_ATTACHMENT_KINDS.includes(input.kind)) throw new Error("SOURCE_ATTACHMENT_KIND_INVALID");
  if (!isCaptureSourceType(input.sourceType)) throw new Error("SOURCE_ATTACHMENT_SOURCE_INVALID");
  if (Number.isNaN(Date.parse(input.capturedAt))) throw new Error("SOURCE_ATTACHMENT_CAPTURED_AT_INVALID");
  const serialized = JSON.stringify(input.payload);
  if (!isRecord(input.payload) || !serialized || Buffer.byteLength(serialized, "utf8") > MAX_SOURCE_EVIDENCE_ATTACHMENT_BYTES) {
    throw new Error("SOURCE_ATTACHMENT_PAYLOAD_TOO_LARGE");
  }
  if (input.kind === "customer_voice_observation_v1"
    && !parseCustomerVoiceAttachmentPayload(input.payload, input.subjectKey)) {
    throw new Error("SOURCE_ATTACHMENT_CUSTOMER_VOICE_INVALID");
  }
  return {
    schemaVersion: SOURCE_EVIDENCE_ATTACHMENT_SCHEMA,
    attachmentId: input.attachmentId.trim().slice(0, 160),
    subjectKey: input.subjectKey.trim(),
    kind: input.kind,
    sourceType: input.sourceType,
    capturedAt: input.capturedAt,
    sourceUrl: input.sourceUrl?.trim() || null,
    sourceFingerprint: input.sourceFingerprint?.trim() || null,
    contentHash: sourceEvidenceAttachmentContentHash({
      kind: input.kind,
      sourceType: input.sourceType,
      subjectKey: input.subjectKey,
      payload: input.payload,
    }),
    payload: input.payload,
  };
}

export function parseSourceEvidenceAttachment(value: unknown): SourceEvidenceAttachment | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== SOURCE_EVIDENCE_ATTACHMENT_SCHEMA) return null;
  if (typeof value.attachmentId !== "string" || !value.attachmentId.trim()) return null;
  if (typeof value.subjectKey !== "string" || !value.subjectKey.trim()) return null;
  if (!SOURCE_EVIDENCE_ATTACHMENT_KINDS.includes(value.kind as SourceEvidenceAttachmentKind)) return null;
  if (!isCaptureSourceType(value.sourceType)) return null;
  if (typeof value.capturedAt !== "string" || Number.isNaN(Date.parse(value.capturedAt))) return null;
  if (value.sourceUrl !== null && typeof value.sourceUrl !== "string") return null;
  if (value.sourceFingerprint !== null && typeof value.sourceFingerprint !== "string") return null;
  if (typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(value.contentHash)) return null;
  if (!isRecord(value.payload)) return null;
  if (value.kind === "customer_voice_observation_v1"
    && !parseCustomerVoiceAttachmentPayload(value.payload, value.subjectKey)) return null;
  const expectedHash = sourceEvidenceAttachmentContentHash({
    kind: value.kind as SourceEvidenceAttachmentKind,
    sourceType: value.sourceType,
    subjectKey: value.subjectKey,
    payload: value.payload,
  });
  if (expectedHash !== value.contentHash) return null;
  const serialized = JSON.stringify(value.payload);
  if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_SOURCE_EVIDENCE_ATTACHMENT_BYTES) return null;
  return value as unknown as SourceEvidenceAttachment;
}

export function sourceEvidenceAttachmentFileName(contentHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error("SOURCE_ATTACHMENT_HASH_INVALID");
  return `a-${contentHash}.json`;
}

export function sourceEvidenceAttachmentIdFor(contentHash: string): string {
  return `att-${createHash("sha256").update(contentHash, "utf8").digest("hex").slice(0, 24)}`;
}

