import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type { AccessContext } from "@/lib/server/accessPassword";
import { buildResearchInputBundle } from "@/lib/server/research/researchInputBundle";
import { parseReviewImportContent } from "@/lib/server/reviewImportParser";
import {
  buildCustomerVoiceAttachmentPayload,
  buildCustomerVoiceObservation,
  customerVoiceDedupeKey,
  parseCustomerVoiceAttachmentPayload,
  type CustomerVoiceObservation,
  type CustomerVoiceObservationInput,
} from "@/lib/sourceLayer/customerVoice";
import type { SourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import { parseV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { captureEvidenceAttachmentThroughGateway } from "@/lib/sourceLayer/server/captureGateway";
import { persistRawArtifact } from "@/lib/sourceLayer/server/rawArtifactIntake";
import { sourceLayerOperator } from "@/lib/sourceLayer/server/sourceLayerService";
import type { AccessContext as EvidenceAccessContext } from "@/lib/server/accessPassword";
import { MAX_REVIEW_TEXT_LENGTH } from "@/lib/server/reviewImportParser";
import { CUSTOMER_VOICE_ATTACHMENT_KIND } from "@/lib/sourceLayer/customerVoice";
import {
  classifyRedditIdentity,
  extractOwnerExperience,
  opaqueRedditAuthorRef,
  parseVisibleRedditCommentTree,
  parseVisibleRedditPostCard,
  parseVisibleRedditCount,
  redditCommentIdFromUrl,
  safeRedditSearchNextHref,
  shouldExpandRedditComments,
  type RedditVisiblePost,
} from "@/lib/server/redditVisibleParser";

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMPORTED_OBSERVATIONS = 500;
const VOICE_ATTACHMENT_BATCH_SIZE = 20;
const REDDIT_SEARCH_ORIGIN = "https://www.reddit.com";
const REDDIT_MAX_RUN_DURATION_MS = 60_000;
const REDDIT_NAVIGATION_TIMEOUT_MS = 15_000;
const REDDIT_MAX_SEARCH_PAGES = 2;
const REDDIT_MAX_POSTS = 5;
const REDDIT_MAX_POST_DETAILS = 3;
const REDDIT_MAX_COMMENTS_PER_POST = 20;
const REDDIT_MAX_COMMENT_DEPTH = 6;
const REDDIT_COMMENT_EXPANSION_LIMIT = 2;
const AMAZON_HOSTS = new Set([
  "amazon.com", "amazon.co.uk", "amazon.ca", "amazon.de", "amazon.co.jp", "amazon.fr",
  "amazon.it", "amazon.es", "amazon.nl", "amazon.se", "amazon.pl", "amazon.com.au",
  "amazon.com.mx", "amazon.in", "amazon.sg", "amazon.ae", "amazon.sa", "amazon.com.tr",
]);

export class CustomerVoiceServiceError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
    this.name = "CustomerVoiceServiceError";
  }
}

function voiceError(code: string, message: string, status = 400): CustomerVoiceServiceError {
  return new CustomerVoiceServiceError(code, status, message);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  return normalized ? normalized.slice(0, max) : null;
}

function optionalIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asinOfSubject(subjectKey: string): string {
  const match = /^amazon:[A-Z]{2}:([A-Z0-9]{10})$/u.exec(subjectKey);
  if (!match) throw voiceError("CUSTOMER_VOICE_SUBJECT_ASIN_INVALID", "Research 主体 ASIN 无效。", 409);
  return match[1];
}

function validAmazonUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./u, "");
    return url.protocol === "https:" && !url.username && !url.password && AMAZON_HOSTS.has(host) ? url.toString() : null;
  } catch {
    return null;
  }
}

async function taskEvidence(context: AccessContext, taskId: string, recordDiagnostic = true) {
  const bundle = await buildResearchInputBundle({ context, taskId, recordDiagnostic });
  const subject = await createEvidenceStore(sourceLayerOperator(context)).getSubject(bundle.subjectKey);
  if (!subject || subject.versions.length === 0) throw voiceError("CUSTOMER_VOICE_BASE_EVIDENCE_MISSING", "当前主体没有可绑定的 Canonical Evidence。", 409);
  return { bundle, subject, asin: asinOfSubject(bundle.subjectKey) };
}

function existingVoiceKeys(attachments: readonly SourceEvidenceAttachment[], subjectKey: string): Set<string> {
  const keys = new Set<string>();
  for (const attachment of attachments) {
    if (attachment.kind !== CUSTOMER_VOICE_ATTACHMENT_KIND) continue;
    const payload = parseCustomerVoiceAttachmentPayload(attachment.payload, subjectKey);
    for (const observation of payload?.observations ?? []) keys.add(customerVoiceDedupeKey(observation));
  }
  return keys;
}

async function appendVoiceObservations(input: {
  context: AccessContext;
  subjectKey: string;
  observations: readonly CustomerVoiceObservation[];
  gatewaySource: "amazon_dom" | "manual" | "browser_agent";
  capturedAt?: string;
  sourceUrl?: string | null;
}): Promise<{ added: number; duplicate: number; attachmentId: string | null; attachmentIds?: string[] }> {
  if (input.observations.length === 0) return { added: 0, duplicate: 0, attachmentId: null };
  const store = createEvidenceStore(sourceLayerOperator(input.context));
  const subject = await store.getSubject(input.subjectKey);
  if (!subject || subject.versions.length === 0) throw voiceError("CUSTOMER_VOICE_BASE_EVIDENCE_MISSING", "当前主体没有可绑定的 Canonical Evidence。", 409);
  const existing = existingVoiceKeys(subject.attachments ?? [], input.subjectKey);
  const unique: CustomerVoiceObservation[] = [];
  const seen = new Set<string>();
  let duplicate = 0;
  for (const observation of input.observations.slice(0, MAX_IMPORTED_OBSERVATIONS)) {
    const key = customerVoiceDedupeKey(observation);
    if (existing.has(key) || seen.has(key)) {
      duplicate++;
      continue;
    }
    seen.add(key);
    unique.push(observation);
  }
  if (unique.length === 0) return { added: 0, duplicate, attachmentId: null };
  const groups = new Map<CustomerVoiceObservation["source"], CustomerVoiceObservation[]>();
  for (const observation of unique) {
    const group = groups.get(observation.source) ?? [];
    group.push(observation);
    groups.set(observation.source, group);
  }
  const attachmentIds: string[] = [];
  for (const group of groups.values()) {
    for (let offset = 0; offset < group.length; offset += VOICE_ATTACHMENT_BATCH_SIZE) {
      const payload = buildCustomerVoiceAttachmentPayload({
        subjectKey: input.subjectKey,
        observations: group.slice(offset, offset + VOICE_ATTACHMENT_BATCH_SIZE),
      });
      const gateway = await captureEvidenceAttachmentThroughGateway({
        context: input.context,
        subjectKey: input.subjectKey,
        source: input.gatewaySource,
        kind: CUSTOMER_VOICE_ATTACHMENT_KIND,
        payload: payload as unknown as Record<string, unknown>,
        sourceUrl: input.sourceUrl ?? null,
        sourceFingerprint: sha256(JSON.stringify(payload)),
        capturedAt: input.capturedAt ? new Date(input.capturedAt) : undefined,
      });
      attachmentIds.push(gateway.attachment.attachmentId);
    }
  }
  return { added: unique.length, duplicate, attachmentId: attachmentIds[0] ?? null, attachmentIds };
}

function amazonReviewObservations(input: {
  subjectKey: string;
  asin: string;
  attachment: SourceEvidenceAttachment;
}): CustomerVoiceObservation[] {
  if (input.attachment.kind !== "v3_review_voc_v1" && input.attachment.kind !== "review_evidence") return [];
  if (input.attachment.kind === "review_evidence") {
    const rawPayload = input.attachment.payload;
    const payload = asRecord(rawPayload) ? rawPayload : null;
    if (!payload && !Array.isArray(rawPayload)) return [];
    const dataset = payload && asRecord(payload.dataset) ? payload.dataset : null;
    const rawReviews = Array.isArray(payload?.reviews)
      ? payload.reviews
      : (Array.isArray(dataset?.reviews)
          ? dataset.reviews
          : (Array.isArray(rawPayload) ? rawPayload : []));
    if (rawReviews.length === 0) return [];
    const payloadAsin = typeof payload?.asin === "string" ? payload.asin : null;
    if (payloadAsin && payloadAsin !== input.asin) return [];

    const output: CustomerVoiceObservation[] = [];
    for (const raw of rawReviews) {
      if (output.length >= MAX_IMPORTED_OBSERVATIONS || !asRecord(raw)) continue;
      const body = textValue(raw.body ?? raw.reviewText ?? raw.text, MAX_REVIEW_TEXT_LENGTH);
      if (!body) continue;
      const itemAsin = typeof raw.asin === "string" ? raw.asin : typeof raw.productAsin === "string" ? raw.productAsin : null;
      if (itemAsin && itemAsin !== input.asin) continue;
      const title = textValue(raw.title ?? raw.reviewTitle, 200);
      const rating = typeof raw.rating === "number" && Number.isFinite(raw.rating) && raw.rating >= 1 && raw.rating <= 5
        ? raw.rating
        : null;
      const verifiedPurchase = typeof raw.verifiedPurchase === "boolean" ? raw.verifiedPurchase : null;
      const publishedAt = optionalIso(raw.publishedAt ?? raw.reviewDate ?? raw.date);
      const sourceUrl = [raw.sourceRef, raw.sourceUrl, input.attachment.sourceUrl]
        .map(validAmazonUrl)
        .find((candidate): candidate is string => candidate !== null) ?? null;
      const contentIdentity = sha256(JSON.stringify({ title, body, rating, verifiedPurchase, publishedAt }));
      const externalId = textValue(raw.reviewId ?? raw.evidenceId ?? raw.id, 160)
        ?? `amazon-review-evidence:${contentIdentity.slice(0, 40)}`;
      const isDomCapture = (input.attachment.sourceType === "amazon_dom" || input.attachment.sourceType === "browser_agent")
        && (raw.sourceType === "browser" || typeof raw.sourceUrl === "string");
      const observationSource = isDomCapture ? "amazon_review" : "manual_voc";
      const observationInput: CustomerVoiceObservationInput = {
        source: observationSource,
        subjectKey: input.subjectKey,
        externalContentId: externalId,
        parentContentId: null,
        threadId: null,
        contentType: "review",
        authorRef: null,
        capturedAt: optionalIso(raw.capturedAt) ?? input.attachment.capturedAt,
        publishedAt,
        title,
        text: body,
        rating,
        verifiedPurchase,
        engagement: null,
        sourceUrl,
        evidenceRefs: [`attachment:${input.attachment.attachmentId}`],
        provenance: isDomCapture ? {
          provider: "amazon_dom",
          method: "capture_v3_amazon_review",
          accessBasis: "first_party_visible_page",
          sourceAttachmentId: input.attachment.attachmentId,
          rawArtifactId: null,
          providerTermsVersion: null,
        } : {
          provider: "manual_import",
          method: "manual_import",
          accessBasis: input.attachment.sourceType === "excel_upload" ? "user_supplied_file" : "user_supplied_text",
          sourceAttachmentId: input.attachment.attachmentId,
          rawArtifactId: null,
          providerTermsVersion: null,
        },
        retentionPolicy: null,
        deletionRequired: false,
        externalDeletedAt: null,
        identityMatch: isDomCapture ? "EXACT" : "UNRESOLVED",
        ownerExperience: null,
      };
      try {
        output.push(buildCustomerVoiceObservation(observationInput));
      } catch {
        // Source row is omitted if malformed
      }
    }
    return output;
  }
  const parsedEvidence = parseV3ModuleEvidence(input.attachment.payload);
  if (!parsedEvidence || parsedEvidence.module !== "review_voc" || parsedEvidence.subjectKey !== input.subjectKey
    || !["VALIDATED_AVAILABLE", "AVAILABLE_WITH_LIMITATION"].includes(parsedEvidence.status)
    || !Array.isArray(parsedEvidence.data.reviews)) return [];
  const identityAsin = parsedEvidence.identity.asin ?? null;
  if (identityAsin && identityAsin !== input.asin) return [];
  const output: CustomerVoiceObservation[] = [];
  for (const raw of parsedEvidence.data.reviews) {
    if (output.length >= MAX_IMPORTED_OBSERVATIONS || !asRecord(raw)) continue;
    const body = textValue(raw.body ?? raw.reviewText ?? raw.text, MAX_REVIEW_TEXT_LENGTH);
    if (!body) continue;
    const title = textValue(raw.title ?? raw.reviewTitle, 200);
    const rating = typeof raw.rating === "number" && Number.isFinite(raw.rating) && raw.rating >= 1 && raw.rating <= 5
      ? raw.rating
      : null;
    const verifiedPurchase = typeof raw.verifiedPurchase === "boolean" ? raw.verifiedPurchase : null;
    const publishedAt = optionalIso(raw.publishedAt ?? raw.reviewDate ?? raw.date);
    const sourceUrl = [raw.sourceRef, raw.sourceUrl, input.attachment.sourceUrl, parsedEvidence.sourceUrl]
      .map(validAmazonUrl)
      .find((candidate): candidate is string => candidate !== null) ?? null;
    const contentIdentity = sha256(JSON.stringify({ title, body, rating, verifiedPurchase, publishedAt }));
    const externalId = textValue(raw.reviewId ?? raw.id, 160)
      ?? `amazon-content:${contentIdentity.slice(0, 40)}`;
    const observationInput: CustomerVoiceObservationInput = {
      source: "amazon_review",
      subjectKey: input.subjectKey,
      externalContentId: externalId,
      parentContentId: null,
      threadId: null,
      contentType: "review",
      authorRef: null,
      capturedAt: input.attachment.capturedAt,
      publishedAt,
      title,
      text: body,
      rating,
      verifiedPurchase,
      engagement: null,
      sourceUrl,
      evidenceRefs: [`attachment:${input.attachment.attachmentId}`],
      provenance: {
        provider: "amazon_dom",
        method: "capture_v3_amazon_review",
        accessBasis: "first_party_visible_page",
        sourceAttachmentId: input.attachment.attachmentId,
        rawArtifactId: null,
        providerTermsVersion: null,
      },
      retentionPolicy: null,
      deletionRequired: false,
      externalDeletedAt: null,
      identityMatch: "EXACT",
      ownerExperience: null,
    };
    try {
      output.push(buildCustomerVoiceObservation(observationInput));
    } catch {
      // A malformed source row is omitted; the original V3 attachment remains immutable evidence.
    }
  }
  return output;
}

export async function normalizeAmazonReviewsForResearchTask(input: {
  context: AccessContext;
  taskId: string;
}) {
  const { bundle, subject, asin } = await taskEvidence(input.context, input.taskId);
  const observations = bundle.reviewEvidence.flatMap((attachment) => amazonReviewObservations({
    subjectKey: bundle.subjectKey,
    asin,
    attachment,
  }));
  const result = await appendVoiceObservations({
    context: input.context,
    subjectKey: bundle.subjectKey,
    observations,
    gatewaySource: "amazon_dom",
  });
  return { subjectKey: bundle.subjectKey, sourceCount: observations.length, ...result };
}

function parseJsonReviewRows(bytes: Uint8Array): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw voiceError("CUSTOMER_VOICE_JSON_INVALID", "JSON 文件格式无效。", 400);
  }
  const rows = Array.isArray(parsed) ? parsed : asRecord(parsed) && Array.isArray(parsed.reviews) ? parsed.reviews : null;
  if (!rows || rows.length > MAX_IMPORTED_OBSERVATIONS || rows.some((item) => !asRecord(item))) {
    throw voiceError("CUSTOMER_VOICE_JSON_SHAPE_INVALID", "JSON 必须是 reviews 数组且不超过 500 行。", 400);
  }
  return rows as Array<Record<string, unknown>>;
}

function importedReviewObservations(input: {
  subjectKey: string;
  asin: string;
  rows: readonly Record<string, unknown>[];
  rawArtifactId: string;
  capturedAt: string;
}): CustomerVoiceObservation[] {
  const observations: CustomerVoiceObservation[] = [];
  for (const row of input.rows) {
    if (observations.length >= MAX_IMPORTED_OBSERVATIONS) break;
    const rowAsin = textValue(row.asin, 10)?.toUpperCase();
    if (rowAsin && rowAsin !== input.asin) continue;
    const text = textValue(row.reviewText ?? row.body ?? row.text ?? row.content, MAX_REVIEW_TEXT_LENGTH);
    if (!text) continue;
    const title = textValue(row.reviewTitle ?? row.title ?? row.headline, 200);
    const ratingValue = row.rating;
    const rating = typeof ratingValue === "number" && Number.isFinite(ratingValue) && ratingValue >= 1 && ratingValue <= 5
      ? ratingValue
      : null;
    const verifiedPurchase = typeof row.verifiedPurchase === "boolean" ? row.verifiedPurchase : null;
    const publishedAt = optionalIso(row.reviewDate ?? row.publishedAt ?? row.date);
    const externalContentId = textValue(row.reviewId ?? row.id, 160)
      ?? `manual:${sha256(JSON.stringify({ subjectKey: input.subjectKey, title, text, rating, publishedAt })).slice(0, 40)}`;
    try {
      observations.push(buildCustomerVoiceObservation({
        source: "manual_voc",
        subjectKey: input.subjectKey,
        externalContentId,
        parentContentId: null,
        threadId: null,
        contentType: "review",
        authorRef: null,
        capturedAt: input.capturedAt,
        publishedAt,
        title,
        text,
        rating,
        verifiedPurchase,
        engagement: null,
        sourceUrl: null,
        evidenceRefs: [`rawArtifact:${input.rawArtifactId}`],
        provenance: {
          provider: "manual_import",
          method: "manual_import",
          accessBasis: "user_supplied_file",
          sourceAttachmentId: null,
          rawArtifactId: input.rawArtifactId,
          providerTermsVersion: null,
        },
        retentionPolicy: null,
        deletionRequired: false,
        externalDeletedAt: null,
        identityMatch: "UNRESOLVED",
        ownerExperience: null,
      }));
    } catch {
      // Import row remains present in the raw file, but malformed values do not enter structured VOC.
    }
  }
  return observations;
}

export async function importCustomerVoiceFile(input: {
  context: AccessContext;
  taskId: string;
  fileName: string;
  bytes: Uint8Array;
}) {
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_IMPORT_BYTES) {
    throw voiceError("CUSTOMER_VOICE_FILE_SIZE_INVALID", "文件为空或超过 5 MiB。", 413);
  }
  const { bundle, asin } = await taskEvidence(input.context, input.taskId);
  const extension = input.fileName.toLowerCase().split(".").at(-1);
  if (extension !== "csv" && extension !== "xlsx" && extension !== "json") {
    throw voiceError("CUSTOMER_VOICE_FILE_TYPE_UNSUPPORTED", "仅支持 CSV、XLSX 和 JSON。", 400);
  }
  const now = new Date().toISOString();
  let rows: Array<Record<string, unknown>>;
  if (extension === "json") {
    rows = parseJsonReviewRows(input.bytes);
  } else {
    const parsed = parseReviewImportContent(input.bytes, { defaultAsin: asin, maxReviews: MAX_IMPORTED_OBSERVATIONS });
    rows = parsed.reviews
      .filter((item) => item.asin === asin)
      .map((item) => ({
        asin: item.asin,
        reviewText: item.reviewText,
        reviewTitle: item.reviewTitle,
        rating: item.rating,
        reviewDate: item.reviewDate,
        verifiedPurchase: item.verifiedPurchase,
        reviewId: item.reviewId,
      }));
  }
  if (rows.length === 0) throw voiceError("CUSTOMER_VOICE_FILE_HAS_NO_VALID_ROWS", "文件中没有可导入的 VOC 行。", 422);
  const raw = await persistRawArtifact({
    context: input.context,
    subjectKey: bundle.subjectKey,
    sourceType: "manual_entry",
    kind: "review_export",
    fileName: `customer-voice-import.${extension}`,
    contentType: extension === "csv" ? "text/csv; charset=utf-8"
      : extension === "json" ? "application/json"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes: input.bytes,
    capturedAt: now,
    provenance: {
      provider: "manual_import",
      sourceSurface: "user_supplied_file",
      sourceUrl: null,
      sourceRecordRef: null,
      providerUpdatedAt: null,
      acquisitionMode: "file_upload",
      parserVersion: "customer-voice-import.v1",
    },
  });
  const observations = importedReviewObservations({
    subjectKey: bundle.subjectKey,
    asin,
    rows,
    rawArtifactId: raw.artifact.artifactId,
    capturedAt: now,
  });
  const result = await appendVoiceObservations({
    context: input.context,
    subjectKey: bundle.subjectKey,
    observations,
    gatewaySource: "manual",
    capturedAt: now,
  });
  return {
    subjectKey: bundle.subjectKey,
    parsedRows: rows.length,
    acceptedRows: observations.length,
    rawArtifactId: raw.artifact.artifactId,
    rawArtifactHash: raw.artifact.sha256,
    ...result,
  };
}

export async function addManualCustomerVoice(input: {
  context: AccessContext;
  taskId: string;
  observations: readonly {
    externalContentId?: string;
    contentType?: "review" | "post" | "comment" | "social_post";
    title?: string | null;
    text: string;
    rating?: number | null;
    verifiedPurchase?: boolean | null;
    publishedAt?: string | null;
  }[];
}) {
  if (input.observations.length < 1 || input.observations.length > 100) throw voiceError("CUSTOMER_VOICE_MANUAL_COUNT_INVALID", "人工 VOC 必须为 1 到 100 条。", 400);
  if (input.observations.some((item) => item.rating !== undefined && item.rating !== null
    && (typeof item.rating !== "number" || !Number.isFinite(item.rating) || item.rating < 1 || item.rating > 5)
    || item.verifiedPurchase !== undefined && item.verifiedPurchase !== null && typeof item.verifiedPurchase !== "boolean"
    || item.publishedAt !== undefined && item.publishedAt !== null && optionalIso(item.publishedAt) === null
    || item.contentType !== undefined && !["review", "post", "comment", "social_post"].includes(item.contentType))) {
    throw voiceError("CUSTOMER_VOICE_MANUAL_ITEM_INVALID", "人工 VOC 条目字段不合法。", 400);
  }
  const { bundle, asin } = await taskEvidence(input.context, input.taskId);
  const capturedAt = new Date().toISOString();
  const rows = input.observations.map((item) => ({
    externalContentId: textValue(item.externalContentId, 160),
    contentType: item.contentType ?? "review",
    title: textValue(item.title, 200),
    text: textValue(item.text, MAX_REVIEW_TEXT_LENGTH),
    rating: typeof item.rating === "number" && Number.isFinite(item.rating) && item.rating >= 1 && item.rating <= 5 ? item.rating : null,
    verifiedPurchase: typeof item.verifiedPurchase === "boolean" ? item.verifiedPurchase : null,
    publishedAt: optionalIso(item.publishedAt),
  }));
  if (rows.some((item) => !item.text || !["review", "post", "comment", "social_post"].includes(item.contentType))) {
    throw voiceError("CUSTOMER_VOICE_MANUAL_ITEM_INVALID", "人工 VOC 条目字段不合法。", 400);
  }
  const bytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: "manual-customer-voice-input.v1", rows }));
  const raw = await persistRawArtifact({
    context: input.context,
    subjectKey: bundle.subjectKey,
    sourceType: "manual_entry",
    kind: "other",
    fileName: "customer-voice-manual-entry.json",
    contentType: "application/json",
    bytes,
    capturedAt,
    provenance: {
      provider: "manual_import",
      sourceSurface: "user_supplied_text",
      sourceUrl: null,
      sourceRecordRef: null,
      providerUpdatedAt: null,
      acquisitionMode: "manual_export",
      parserVersion: "customer-voice-import.v1",
    },
  });
  const observations = rows.map((row) => buildCustomerVoiceObservation({
    source: "manual_voc",
    subjectKey: bundle.subjectKey,
    externalContentId: row.externalContentId ?? `manual:${sha256(JSON.stringify({ asin, ...row })).slice(0, 40)}`,
    parentContentId: null,
    threadId: null,
    contentType: row.contentType,
    authorRef: null,
    capturedAt,
    publishedAt: row.publishedAt,
    title: row.title,
    text: row.text as string,
    rating: row.rating,
    verifiedPurchase: row.verifiedPurchase,
    engagement: null,
    sourceUrl: null,
    evidenceRefs: [`rawArtifact:${raw.artifact.artifactId}`],
    provenance: {
      provider: "manual_import",
      method: "manual_import",
      accessBasis: "user_supplied_text",
      sourceAttachmentId: null,
      rawArtifactId: raw.artifact.artifactId,
      providerTermsVersion: null,
    },
    retentionPolicy: null,
    deletionRequired: false,
    externalDeletedAt: null,
    identityMatch: "UNRESOLVED",
    ownerExperience: null,
  }));
  const result = await appendVoiceObservations({
    context: input.context,
    subjectKey: bundle.subjectKey,
    observations,
    gatewaySource: "manual",
    capturedAt,
  });
  return { subjectKey: bundle.subjectKey, parsedRows: rows.length, rawArtifactId: raw.artifact.artifactId, rawArtifactHash: raw.artifact.sha256, ...result };
}

export async function listCustomerVoiceForResearchTask(input: {
  context: AccessContext;
  taskId: string;
}) {
  const [{ bundle, subject }, { adaptCustomerVoiceEvidenceToVocObservations, getVocAnalysis, VocAnalysisError }] = await Promise.all([
    taskEvidence(input.context, input.taskId, false),
    import("@/lib/server/vocAnalysis"),
  ]);
  const canonicalEvidence = bundle.customerVoiceEvidence ?? [];
  const canonicalAttachments = new Map(
    (subject.attachments ?? [])
      .filter((item) => item.kind === CUSTOMER_VOICE_ATTACHMENT_KIND)
      .map((item) => [item.attachmentId, item]),
  );
  const evidenceRefsMap = new Map<string, { refId: string; contentHash: string; capturedAt: string }>();
  const observationsByIdentity = new Map<string, CustomerVoiceObservation>();
  for (const group of canonicalEvidence) {
    if (group.observations.length === 0) continue;
    const attachment = canonicalAttachments.get(group.attachmentId);
    if (!attachment || attachment.contentHash !== group.contentHash) {
      throw voiceError("CUSTOMER_VOICE_CANONICAL_EVIDENCE_MISMATCH", "Buyer Voice canonical Observation 与 EvidenceStore 附件无法对应。", 409);
    }
    const payload = parseCustomerVoiceAttachmentPayload(attachment.payload, bundle.subjectKey);
    if (!payload) {
      throw voiceError("CUSTOMER_VOICE_CANONICAL_EVIDENCE_MISMATCH", "Buyer Voice canonical Observation 附件无法读取。", 409);
    }
    const persistedByIdentity = new Map(
      payload.observations.map((observation) => [customerVoiceDedupeKey(observation), observation]),
    );

    for (const projection of group.observations) {
      if (projection.refId !== `attachment:${group.attachmentId}`) {
        throw voiceError("CUSTOMER_VOICE_CANONICAL_EVIDENCE_MISMATCH", "Buyer Voice Observation 引用与 canonical 附件不一致。", 409);
      }
      const observation = persistedByIdentity.get(customerVoiceDedupeKey(projection));
      if (!observation) {
        throw voiceError("CUSTOMER_VOICE_CANONICAL_EVIDENCE_MISMATCH", "Buyer Voice Observation 无法回查到 canonical 附件原文。", 409);
      }
      if (!observationsByIdentity.has(observation.externalContentId)) {
        observationsByIdentity.set(observation.externalContentId, observation);
      }
    }

    const refId = `attachment:${attachment.attachmentId}`;
    if (!evidenceRefsMap.has(refId)) {
      evidenceRefsMap.set(refId, {
        refId,
        contentHash: attachment.contentHash,
        capturedAt: attachment.capturedAt,
      });
    }
  }
  let analyzeObservations;
  try {
    analyzeObservations = adaptCustomerVoiceEvidenceToVocObservations(canonicalEvidence);
  } catch (error) {
    if (error instanceof VocAnalysisError) {
      throw voiceError(error.code, error.message, error.status);
    }
    throw error;
  }
  const observations: CustomerVoiceObservation[] = analyzeObservations.map((analyzed) => {
    const observation = observationsByIdentity.get(analyzed.observationId);
    if (!observation) {
      throw voiceError("CUSTOMER_VOICE_CANONICAL_EVIDENCE_MISMATCH", "Buyer Voice 唯一 Observation 无法回查到 EvidenceStore 原文。", 409);
    }
    return { ...observation, evidenceRefs: analyzed.sourceEvidenceRefs };
  });
  observations.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));

  return {
    taskId: input.taskId,
    subjectKey: bundle.subjectKey,
    observations,
    count: observations.length,
    evidenceRefs: Array.from(evidenceRefsMap.values()),
    // Read the saved analysis from the existing Task result namespace. This is
    // display-only; it does not regenerate a Research Report or access legacy
    // ReviewEvidence rows as Analyze input.
    analysis: await getVocAnalysis(input.context, input.taskId),
  };
}

async function persistRedditRaw(context: EvidenceAccessContext, subjectKey: string, capturedAt: string, attempt: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(attempt));
  return persistRawArtifact({
    context,
    subjectKey,
    sourceType: "browser_agent",
    kind: "other",
    fileName: "reddit-visible-capture.json",
    contentType: "application/json",
    bytes,
    capturedAt,
    provenance: {
      provider: "reddit_browser",
      sourceSurface: "public_visible_reddit_page",
      sourceUrl: typeof attempt === "object" && attempt !== null && "requestedUrl" in attempt
        && typeof attempt.requestedUrl === "string" ? attempt.requestedUrl : REDDIT_SEARCH_ORIGIN,
      sourceRecordRef: null,
      providerUpdatedAt: null,
      acquisitionMode: "browser_dom",
      parserVersion: "reddit-visible-capture.v1",
    },
  });
}

function classifyRedditPageFailure(status: number | null, title: string, visibleText: string, allowMissingVisibleStatus = false): string | null {
  const text = `${title}\n${visibleText}`;
  if (/captcha|verify (?:that )?you(?:'|’)re human|prove you(?:'|’)re human|unusual traffic/iu.test(text)) return "CAPTCHA_DETECTED";
  if (/log in to continue|sign in to continue|you must be logged in|log in to view|sign in to view/iu.test(text)) return "LOGIN_REQUIRED";
  if (status === 429 || /you are doing that too much|rate.?limit|try again later/iu.test(text)) return "RATE_LIMITED";
  if (status === 403) return "AUTOMATION_BLOCKED";
  if (/removed by (?:the )?moderators|removed by reddit/iu.test(text)) return "CONTENT_REMOVED";
  if (/this post has been deleted|post was deleted|comment has been deleted/iu.test(text)) return "CONTENT_DELETED";
  if (status === 404 || /page not found|we couldn't find that page/iu.test(text)) return "PAGE_NOT_FOUND";
  if (status === null && allowMissingVisibleStatus) return null;
  if (status === null || status >= 500 || status < 200) return "NETWORK_ERROR";
  if (status >= 400) return "NETWORK_ERROR";
  return null;
}

export async function collectPublicRedditVoice(input: {
  context: AccessContext;
  taskId: string;
  query: string;
}) {
  const query = input.query.normalize("NFC").trim().slice(0, 120);
  if (query.length < 2) throw voiceError("REDDIT_QUERY_INVALID", "Reddit 搜索词至少需要 2 个字符。", 400);
  const { bundle, asin } = await taskEvidence(input.context, input.taskId);
  const capturedAt = new Date().toISOString();
  const discoveredAt = capturedAt;
  const captureSalt = randomBytes(16).toString("hex");
  const deadline = Date.now() + REDDIT_MAX_RUN_DURATION_MS;
  const search = new URL("/search/", REDDIT_SEARCH_ORIGIN);
  search.searchParams.set("q", query);
  search.searchParams.set("type", "link");
  const attempt: Record<string, unknown> = {
    schemaVersion: "reddit-visible-capture-attempt.v1",
    capturedAt,
    discoveredAt,
    query,
    requestedUrl: search.toString(),
    method: "playwright-visible-dom",
    limits: {
      maxPosts: REDDIT_MAX_POSTS,
      maxCommentsPerPost: REDDIT_MAX_COMMENTS_PER_POST,
      maxDepth: REDDIT_MAX_COMMENT_DEPTH,
      maxRunDurationMs: REDDIT_MAX_RUN_DURATION_MS,
      navigationTimeoutMs: REDDIT_NAVIGATION_TIMEOUT_MS,
      commentExpansionLimit: REDDIT_COMMENT_EXPANSION_LIMIT,
      maxSearchPages: REDDIT_MAX_SEARCH_PAGES,
      maxPostDetails: REDDIT_MAX_POST_DETAILS,
    },
    status: "pending",
    responseStatus: null,
    finalUrl: null,
    pageTitle: null,
    searchPagesVisited: [] as Array<{ url: string; responseStatus: number | null }>,
    discoveredPosts: [] as Array<{ postId: string; discoveredAt: string; sourceUrl: string; searchUrl: string; title: string | null }>,
    postCount: 0,
    commentCount: 0,
    failure: null,
  };
  let posts: RedditVisiblePost[] = [];
  let externalBlocked = false;
  let browser: import("playwright").Browser | null = null;
  try {
    const { chromium } = await import("playwright");
    const remainingForLaunch = Math.max(1, Math.min(REDDIT_NAVIGATION_TIMEOUT_MS, deadline - Date.now()));
    browser = await chromium.launch({ channel: "chrome", headless: true, timeout: remainingForLaunch });
    const page = await browser.newPage();
    const remaining = () => deadline - Date.now();
    const ensureTime = () => {
      const left = remaining();
      if (left <= 0) throw Object.assign(new Error("REDDIT_RUN_DEADLINE"), { name: "TimeoutError" });
      page.setDefaultTimeout(Math.min(5_000, left));
      page.setDefaultNavigationTimeout(Math.min(REDDIT_NAVIGATION_TIMEOUT_MS, left));
      return left;
    };
    const visibleText = async (scope: import("playwright").Locator, selector: string): Promise<string | null> => {
      const locator = scope.locator(selector).first();
      if (!(await locator.isVisible().catch(() => false))) return null;
      return textValue(await locator.innerText().catch(() => ""), 5_000)
        ?? textValue(await locator.getAttribute("aria-label").catch(() => null), 5_000);
    };
    const visibleAttribute = async (scope: import("playwright").Locator, selector: string, name: string): Promise<string | null> => {
      const locator = scope.locator(selector).first();
      if (!(await locator.isVisible().catch(() => false))) return null;
      return locator.getAttribute(name).catch(() => null);
    };
    const addVisibleSearchResults = async (searchUrl: string) => {
      ensureTime();
      const cards = page.locator("shreddit-post");
      const cardCount = Math.min(await cards.count(), REDDIT_MAX_POSTS - posts.length);
      for (let index = 0; index < cardCount; index++) {
        ensureTime();
        const card = cards.nth(index);
        if (!(await card.isVisible().catch(() => false))) continue;
        const title = await visibleText(card, 'a[slot="title"], h3');
        const body = await visibleText(card, '[slot="text-body"]');
        const permalink = await visibleAttribute(card, 'a[href*="/comments/"]', "href");
        if (!permalink || !(body ?? title)) continue;
        const authorIdentity = await visibleText(card, 'a[href*="/user/"], a[href*="/u/"]');
        const time = await visibleAttribute(card, "time[datetime]", "datetime");
        const scoreText = await visibleText(card, '[slot*="score"], faceplate-number, [aria-label*="vote" i]');
        const commentCountText = await visibleText(card, '[slot*="comment-count"], a[href*="/comments/"] [aria-label*="comment" i]');
        const post = parseVisibleRedditPostCard({
          title,
          body,
          permalink,
          publishedAt: time,
          authorRef: opaqueRedditAuthorRef(authorIdentity, captureSalt),
          score: parseVisibleRedditCount(scoreText),
          commentCount: parseVisibleRedditCount(commentCountText),
        });
        if (!post || posts.some((existing) => existing.externalContentId === post.externalContentId)) continue;
        posts.push(post);
        (attempt.discoveredPosts as Array<{ postId: string; discoveredAt: string; sourceUrl: string; searchUrl: string; title: string | null }>).push({
          postId: post.externalContentId,
          discoveredAt: new Date().toISOString(),
          sourceUrl: post.sourceUrl,
          searchUrl,
          title: post.title,
        });
      }
    };

    ensureTime();
    const response = await page.goto(search.toString(), { waitUntil: "domcontentloaded", timeout: ensureTime() });
    let responseStatus = response?.status() ?? null;
    let currentSearchUrl = page.url();
    (attempt.searchPagesVisited as Array<{ url: string; responseStatus: number | null }>).push({ url: currentSearchUrl, responseStatus });
    attempt.responseStatus = responseStatus;
    attempt.finalUrl = currentSearchUrl;
    attempt.pageTitle = await page.title().catch(() => "");
    const visitedSearchUrls = new Set([currentSearchUrl]);
    let searchPageFailure: string | null = null;

    for (let pageNumber = 0; pageNumber < REDDIT_MAX_SEARCH_PAGES; pageNumber++) {
      ensureTime();
      const title = await page.title().catch(() => "");
      const pageText = (await page.locator("body").innerText().catch(() => "")).slice(0, 1_000);
      const host = new URL(page.url()).hostname.toLowerCase();
      if (!new Set(["reddit.com", "www.reddit.com"]).has(host)) {
        searchPageFailure = "AUTOMATION_BLOCKED";
        break;
      }
      searchPageFailure = classifyRedditPageFailure(responseStatus, title, pageText, pageNumber > 0 && responseStatus === null);
      if (searchPageFailure) break;
      const cardCount = await page.locator("shreddit-post").count();
      if (cardCount === 0) {
        searchPageFailure = /no results|no posts found|did not match any posts|try another search/iu.test(`${title}\n${pageText}`)
          ? "NO_RELEVANT_POSTS"
          : "DOM_UNSUPPORTED";
        break;
      }
      await addVisibleSearchResults(page.url());
      if (posts.length >= REDDIT_MAX_POSTS || pageNumber + 1 >= REDDIT_MAX_SEARCH_PAGES) break;

      const nextLink = page.locator('a[rel="next"], a[aria-label*="next" i]').first();
      if (!(await nextLink.isVisible().catch(() => false))) break;
      const nextHref = await nextLink.getAttribute("href").catch(() => null);
      const safeNext = safeRedditSearchNextHref(nextHref, page.url(), query);
      if (!safeNext || visitedSearchUrls.has(safeNext)) break;
      ensureTime();
      await nextLink.click({ timeout: Math.min(5_000, remaining()) });
      await page.waitForTimeout(Math.min(250, Math.max(1, remaining())));
      currentSearchUrl = page.url();
      if (!safeRedditSearchNextHref(currentSearchUrl, safeNext, query) && currentSearchUrl !== safeNext) break;
      visitedSearchUrls.add(currentSearchUrl);
      responseStatus = null;
      (attempt.searchPagesVisited as Array<{ url: string; responseStatus: number | null }>).push({ url: currentSearchUrl, responseStatus });
    }

    attempt.responseStatus = responseStatus;
    attempt.finalUrl = page.url();
    if (searchPageFailure && searchPageFailure !== "NO_RELEVANT_POSTS") {
      attempt.failure = searchPageFailure;
      externalBlocked = true;
      attempt.status = "blocked";
    } else if (searchPageFailure === "NO_RELEVANT_POSTS" && posts.length === 0) {
      attempt.failure = "NO_RELEVANT_POSTS";
      attempt.status = "complete_empty";
    } else {
      const enriched: RedditVisiblePost[] = [];
      for (const post of posts) {
        ensureTime();
        if (enriched.length >= REDDIT_MAX_POST_DETAILS) {
          enriched.push(post);
          continue;
        }
        const detailResponse = await page.goto(post.sourceUrl, {
          waitUntil: "domcontentloaded",
          timeout: ensureTime(),
        });
        const detailStatus = detailResponse?.status() ?? null;
        const detailTitle = await page.title().catch(() => "");
        const detailText = (await page.locator("body").innerText().catch(() => "")).slice(0, 1_000);
        const detailHasVisiblePost = await page.locator("shreddit-post").first().isVisible().catch(() => false);
        const detailFailure = classifyRedditPageFailure(detailStatus, detailTitle, detailText)
          ?? (!detailHasVisiblePost ? "DOM_UNSUPPORTED" : null);
        if (detailFailure) {
          attempt.failure = detailFailure;
          attempt.responseStatus = detailStatus;
          attempt.finalUrl = page.url();
          enriched.push(post);
          externalBlocked = true;
          break;
        }

        for (let expand = 0; expand < REDDIT_COMMENT_EXPANSION_LIMIT; expand++) {
          ensureTime();
          const buttons = await page.getByRole("button").all();
          let clicked = false;
          for (const button of buttons) {
            ensureTime();
            if (!(await button.isVisible().catch(() => false))) continue;
            const label = await button.innerText().catch(() => "");
            if (!shouldExpandRedditComments(label, true)) continue;
            await button.click({ timeout: Math.min(2_000, remaining()) }).catch(() => undefined);
            await page.waitForTimeout(Math.min(250, Math.max(1, remaining())));
            clicked = true;
            break;
          }
          if (!clicked) break;
        }

        const commentNodes = page.locator("shreddit-comment");
        const visibleCommentNodeCount = await commentNodes.count();
        const rawComments: Array<{
          externalContentId: string;
          parentId: string | null;
          depth: number | null;
          text: string;
          permalink: string | null;
          publishedAt: string | null;
          authorRef: string | null;
          score: number | null;
        }> = [];
        for (let commentIndex = 0; commentIndex < Math.min(visibleCommentNodeCount, REDDIT_MAX_COMMENTS_PER_POST); commentIndex++) {
          ensureTime();
          const comment = commentNodes.nth(commentIndex);
          if (!(await comment.isVisible().catch(() => false))) continue;
          const text = await visibleText(comment, '[slot="comment"]');
          if (!text) continue;
          const permalink = await visibleAttribute(comment, 'a[href*="/comments/"], a[slot*="permalink"]', "href");
          const externalContentId = redditCommentIdFromUrl(permalink, page.url(), `${post.externalContentId}\n${text}`);
          const parentId = await comment.getAttribute("parentid").catch(() => null)
            ?? await comment.getAttribute("parent-id").catch(() => null)
            ?? post.externalContentId;
          const rawDepth = await comment.getAttribute("depth").catch(() => null);
          const parsedDepth = rawDepth && /^\d+$/u.test(rawDepth) ? Number(rawDepth) : null;
          const authorIdentity = await visibleText(comment, 'a[href*="/user/"], a[href*="/u/"]');
          const time = await visibleAttribute(comment, "time[datetime]", "datetime");
          const scoreText = await visibleText(comment, '[slot*="score"], faceplate-number, [aria-label*="vote" i]');
          rawComments.push({
            externalContentId,
            parentId,
            depth: parsedDepth,
            text,
            permalink,
            publishedAt: time,
            authorRef: opaqueRedditAuthorRef(authorIdentity, captureSalt),
            score: parseVisibleRedditCount(scoreText),
          });
        }
        const subreddit = post.subreddit;
        post.comments.push(...parseVisibleRedditCommentTree({
          threadId: post.externalContentId,
          subreddit,
          maxDepth: REDDIT_MAX_COMMENT_DEPTH,
          comments: rawComments,
        }));
        enriched.push(post);
      }
      posts = enriched;
      attempt.postCount = posts.length;
      attempt.commentCount = posts.reduce((sum, post) => sum + post.comments.length, 0);
      if (attempt.status === "pending") attempt.status = posts.length > 0 ? "complete" : "complete_empty";
      if (posts.length === 0 && !attempt.failure) attempt.failure = "NO_RELEVANT_POSTS";
      (attempt as Record<string, unknown>).postCommentOutcomes = [] as Array<{ postId: string; outcome: "CAPTURED" | "NO_COMMENTS" }>;
      for (const post of posts) {
        if (post.comments.length === 0) {
          (attempt.postCommentOutcomes as Array<{ postId: string; outcome: "CAPTURED" | "NO_COMMENTS" }>).push({
            postId: post.externalContentId,
            outcome: "NO_COMMENTS",
          });
        } else {
          (attempt.postCommentOutcomes as Array<{ postId: string; outcome: "CAPTURED" | "NO_COMMENTS" }>).push({
            postId: post.externalContentId,
            outcome: "CAPTURED",
          });
        }
      }
    }
  } catch (error) {
    const isTimeout = error instanceof Error && (/timeout/iu.test(error.name) || /deadline|timeout/iu.test(error.message));
    attempt.status = posts.length > 0 ? "partial_blocked" : "blocked";
    attempt.failure = isTimeout ? "TIMEOUT" : "NETWORK_ERROR";
    externalBlocked = true;
  } finally {
    await browser?.close().catch(() => undefined);
  }

  attempt.postCount = posts.length;
  attempt.commentCount = posts.reduce((sum, post) => sum + post.comments.length, 0);
  const raw = await persistRedditRaw(input.context, bundle.subjectKey, capturedAt, {
    ...attempt,
    posts: posts.map((post) => ({ ...post, comments: post.comments })),
  });
  if (posts.length === 0) {
    return {
      status: externalBlocked ? "external_blocked" : "complete_empty",
      failure: attempt.failure,
      responseStatus: attempt.responseStatus,
      rawArtifactId: raw.artifact.artifactId,
      rawArtifactHash: raw.artifact.sha256,
      added: 0,
      commentCount: 0,
    };
  }
  const rawArtifactRef = `rawArtifact:${raw.artifact.artifactId}`;
  const observations: CustomerVoiceObservation[] = [];
  for (const post of posts) {
    const productTitle = bundle.productFact?.basic.title.value ?? "";
    const postIdentity = classifyRedditIdentity(`${post.title ?? ""}\n${post.text}`, asin, productTitle);
    observations.push(buildCustomerVoiceObservation({
      source: "reddit_post",
      subjectKey: bundle.subjectKey,
      externalContentId: post.externalContentId,
      parentContentId: null,
      threadId: post.externalContentId,
      subreddit: post.subreddit,
      depth: null,
      contentType: "post",
      authorRef: post.authorRef,
      capturedAt,
      publishedAt: post.publishedAt,
      title: post.title,
      text: post.text,
      rating: null,
      verifiedPurchase: null,
      engagement: { score: post.score, commentCount: post.commentCount },
      sourceUrl: post.sourceUrl,
      evidenceRefs: [rawArtifactRef],
      provenance: {
        provider: "reddit_browser",
        method: "public_reddit_browser",
        accessBasis: "public_visible_page",
        sourceAttachmentId: null,
        rawArtifactId: raw.artifact.artifactId,
        providerTermsVersion: null,
      },
      retentionPolicy: null,
      deletionRequired: false,
      externalDeletedAt: null,
      identityMatch: postIdentity,
      ownerExperience: extractOwnerExperience(`${post.title ?? ""}\n${post.text}`),
    }));
    for (const comment of post.comments) {
      observations.push(buildCustomerVoiceObservation({
        source: "reddit_comment",
        subjectKey: bundle.subjectKey,
        externalContentId: comment.externalContentId,
        parentContentId: comment.parentContentId,
        threadId: post.externalContentId,
        subreddit: comment.subreddit,
        depth: comment.depth,
        contentType: "comment",
        authorRef: comment.authorRef,
        capturedAt,
        publishedAt: comment.publishedAt,
        title: null,
        text: comment.text,
        rating: null,
        verifiedPurchase: null,
        engagement: { score: comment.score, commentCount: null },
        sourceUrl: comment.sourceUrl,
        evidenceRefs: [rawArtifactRef],
        provenance: {
          provider: "reddit_browser",
          method: "public_reddit_browser",
          accessBasis: "public_visible_page",
          sourceAttachmentId: null,
          rawArtifactId: raw.artifact.artifactId,
          providerTermsVersion: null,
        },
        retentionPolicy: null,
        deletionRequired: false,
        externalDeletedAt: null,
        identityMatch: classifyRedditIdentity(comment.text, asin, productTitle),
        ownerExperience: extractOwnerExperience(comment.text),
      }));
    }
  }
  const persisted = await appendVoiceObservations({
    context: input.context,
    subjectKey: bundle.subjectKey,
    observations,
    gatewaySource: "browser_agent",
    capturedAt,
    sourceUrl: search.toString(),
  });
  return {
    status: externalBlocked ? "partial_external_block" : "complete",
    failure: attempt.failure,
    responseStatus: attempt.responseStatus,
    rawArtifactId: raw.artifact.artifactId,
    rawArtifactHash: raw.artifact.sha256,
    postCount: posts.length,
    commentCount: posts.reduce((sum, post) => sum + post.comments.length, 0),
    ...persisted,
  };
}


export async function collectAmazonReviewsForResearchTask(input: {
  context: AccessContext;
  taskId: string;
}) {
  const { bundle, asin } = await taskEvidence(input.context, input.taskId);
  if (!asin) throw voiceError("TASK_ASIN_MISSING", "当前任务缺少有效 ASIN，无法采集 Amazon 评论。", 400);

  const { collectAmazonReviewsWithPlaywright } = await import("@/lib/server/captureRecipeBrowser");
  const { newTraceId } = await import("@/lib/sourceLayer/diagnostics");
  const traceId = newTraceId();
  const collectResult = await collectAmazonReviewsWithPlaywright({
    context: input.context,
    asins: [{ asin, role: "current_candidate" }],
    traceId,
  });

  if (collectResult.status === "human_required") {
    const pageGate = collectResult.pageResults.find((page) => page.status === "captcha_required" || page.status === "login_required");
    const errorCode = collectResult.errorCode
      ?? (pageGate?.status === "login_required" ? "LOGIN_REQUIRED" : "CAPTCHA_DETECTED");
    throw voiceError(
      errorCode,
      collectResult.errorMessage ?? "Amazon 评论采集需要人工处理登录或验证码页面；没有自动重试。",
      409,
    );
  }
  if (collectResult.pageResults.some((page) => page.status === "confirmed_no_reviews")) {
    return {
      subjectKey: bundle.subjectKey,
      asin,
      collectedCount: 0,
      added: 0,
      warning: "Amazon 页面明确显示暂无公开评论；本次未生成 Review 或 VOC 数据。",
    };
  }

  if (collectResult.status === "failed") {
    throw voiceError(collectResult.errorCode ?? "COLLECT_FAILED", collectResult.errorMessage ?? "Amazon 评论采集失败。", 409);
  }
  if (collectResult.status === "unavailable") {
    throw voiceError(collectResult.errorCode ?? "COLLECT_UNAVAILABLE", collectResult.errorMessage ?? "浏览器采集能力当前不可用。", 409);
  }
  const reviews = collectResult.items.map((item) => ({
    asin: item.asin,
    sourceProductRole: item.role,
    reviewText: item.reviewText ?? item.title,
    verifiedPurchase: item.verifiedPurchase ?? null,
    rating: item.rating,
    reviewDate: item.date ?? undefined,
    sourceUrl: item.sourceUrl ?? undefined,
    sourceRef: item.sourceUrl ?? undefined,
    bindingNote: item.bindingNote ?? undefined,
    sourceType: "browser" as const,
    bindingKind: "browser_verified" as const,
  }));

  if (reviews.length === 0) {
    return {
      subjectKey: bundle.subjectKey,
      asin,
      collectedCount: 0,
      added: 0,
      warning: "页面访问成功，但未解析到公开评论内容。",
    };
  }

  await captureEvidenceAttachmentThroughGateway({
    context: input.context,
    subjectKey: bundle.subjectKey,
    source: "amazon_dom",
    kind: "review_evidence",
    sourceFingerprint: `review:${input.taskId}:${asin}`,
    payload: {
      schema: "review-evidence-attachment.v1",
      asin,
      reviews,
    },
  });

  const { captureV3ModuleEvidence } = await import("@/lib/sourceLayer/v3ModuleEvidence");
  await captureV3ModuleEvidence({
    context: input.context,
    sourceType: "amazon_dom",
    moduleEvidence: {
      module: "review_voc",
      subjectKey: bundle.subjectKey,
      marketplace: "US",
      capturedAt: new Date().toISOString(),
      provider: "Amazon",
      sourceSurface: "Amazon public Top Reviews DOM",
      sourceUrl: reviews[0]?.sourceUrl ?? null,
      acquisitionMode: "DOM_DIRECT",
      metricNature: "source_observed",
      status: "AVAILABLE_WITH_LIMITATION",
      limitations: ["public_top_reviews_only"],
      identity: { asin },
      data: {
        reviewCount: reviews.length,
        reviews,
      },
      evidenceOnly: true,
    },
  });

  const normResult = await normalizeAmazonReviewsForResearchTask({
    context: input.context,
    taskId: input.taskId,
  });

  return {
    subjectKey: bundle.subjectKey,
    asin,
    collectedCount: reviews.length,
    added: normResult.added,
  };
}

export async function analyzeVocForResearchTask(input: {
  context: AccessContext;
  taskId: string;
  expectedStorageVersion?: { resultJsonHash: string; updatedAt: string };
}) {
  const [{ readReviewEvidenceSnapshot }, { buildResearchInputBundle }, { analyzeVoc }] = await Promise.all([
    import("@/lib/server/reviewEvidence"),
    import("@/lib/server/research/researchInputBundle"),
    import("@/lib/server/vocAnalysis"),
  ]);
  const bundle = await buildResearchInputBundle({
    context: input.context,
    taskId: input.taskId,
    recordDiagnostic: false,
  });
  const customerVoiceEvidence = bundle.customerVoiceEvidence ?? [];
  if (!customerVoiceEvidence.some((group) => group.observations.length > 0)) {
    throw voiceError("NO_CUSTOMER_VOICE_DATA", "当前任务还没有 canonical Customer Voice Observation，请先采集或归一化证据。", 400);
  }

  // This snapshot is used only as the Task result CAS version for vocAnalysis.v1;
  // it is never an input source for VOC and cannot trigger legacy evidence fallback/import.
  const snapshot = input.expectedStorageVersion
    ? null
    : await readReviewEvidenceSnapshot(input.context, input.taskId);
  const storageVersion = input.expectedStorageVersion ?? {
    resultJsonHash: createHash("sha256").update(snapshot!.resultJson, "utf8").digest("hex"),
    updatedAt: snapshot!.updatedAt instanceof Date ? snapshot!.updatedAt.toISOString() : String(snapshot!.updatedAt),
  };

  const result = await analyzeVoc({
    context: input.context,
    taskId: input.taskId,
    expectedStorageVersion: storageVersion,
    candidateId: bundle.candidateId,
    subjectKey: bundle.subjectKey,
    customerVoiceEvidence,
  });

  return {
    analysis: result.analysis,
    unverifiedCount: result.unverified.length,
    gateResult: result.gateResult,
  };
}
