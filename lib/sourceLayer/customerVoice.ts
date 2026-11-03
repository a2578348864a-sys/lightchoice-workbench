import { contentHashOf } from "@/lib/sourceLayer/sourceAdapter";

export const CUSTOMER_VOICE_OBSERVATION_SCHEMA = "customer-voice-observation.v1" as const;
export const CUSTOMER_VOICE_ATTACHMENT_PAYLOAD_SCHEMA = "customer-voice-observation-attachment.v1" as const;
export const CUSTOMER_VOICE_ATTACHMENT_KIND = "customer_voice_observation_v1" as const;

export const CUSTOMER_VOICE_SOURCES = [
  "amazon_review",
  "reddit_post",
  "reddit_comment",
  "manual_voc",
] as const;
export type CustomerVoiceSource = (typeof CUSTOMER_VOICE_SOURCES)[number];

export const CUSTOMER_VOICE_CONTENT_TYPES = ["review", "post", "comment", "social_post"] as const;
export type CustomerVoiceContentType = (typeof CUSTOMER_VOICE_CONTENT_TYPES)[number];

export const CUSTOMER_VOICE_IDENTITY_MATCHES = ["EXACT", "VARIANT", "FAMILY", "PROBABLE", "UNRESOLVED"] as const;
export type CustomerVoiceIdentityMatch = (typeof CUSTOMER_VOICE_IDENTITY_MATCHES)[number];

export type CustomerVoiceOwnerExperience = {
  readonly claimedOwnership: boolean | null;
  readonly ownershipDuration: string | null;
  readonly useCase: string | null;
  readonly failureMode: string | null;
  readonly timeToFailure: string | null;
  readonly replacementProduct: string | null;
  readonly switchReason: string | null;
};

export type CustomerVoiceObservation = {
  readonly schemaVersion: typeof CUSTOMER_VOICE_OBSERVATION_SCHEMA;
  readonly source: CustomerVoiceSource;
  readonly subjectKey: string;
  readonly externalContentId: string;
  readonly parentContentId: string | null;
  readonly threadId: string | null;
  readonly subreddit: string | null;
  /** Reddit comment depth from the post root; null for non-comments. */
  readonly depth: number | null;
  readonly contentType: CustomerVoiceContentType;
  /** Per-capture/per-thread opaque reference only; never a profile URL or username. */
  readonly authorRef: string | null;
  readonly capturedAt: string;
  readonly publishedAt: string | null;
  readonly title: string | null;
  readonly text: string;
  readonly rating: number | null;
  readonly verifiedPurchase: boolean | null;
  readonly engagement: { readonly score: number | null; readonly commentCount: number | null } | null;
  readonly sourceUrl: string | null;
  /** Semantic SHA-256; excludes capture time, engagement, author and EvidenceStore refs. */
  readonly contentHash: string;
  readonly evidenceRefs: readonly string[];
  readonly provenance: {
    readonly provider: "amazon_dom" | "reddit_browser" | "manual_import";
    readonly method: "capture_v3_amazon_review" | "public_reddit_browser" | "manual_import";
    readonly accessBasis: "first_party_visible_page" | "public_visible_page" | "user_supplied_file" | "user_supplied_text";
    readonly sourceAttachmentId: string | null;
    readonly rawArtifactId: string | null;
    readonly providerTermsVersion: string | null;
  };
  readonly retentionPolicy: string | null;
  readonly deletionRequired: boolean;
  readonly externalDeletedAt: string | null;
  readonly identityMatch: CustomerVoiceIdentityMatch;
  readonly ownerExperience: CustomerVoiceOwnerExperience | null;
};

export type CustomerVoiceObservationInput = Omit<CustomerVoiceObservation, "schemaVersion" | "contentHash" | "subreddit" | "depth">
  & Partial<Pick<CustomerVoiceObservation, "subreddit" | "depth">>;

export type CustomerVoiceAttachmentPayload = {
  readonly schemaVersion: typeof CUSTOMER_VOICE_ATTACHMENT_PAYLOAD_SCHEMA;
  readonly subjectKey: string;
  readonly observations: readonly CustomerVoiceObservation[];
};

const HASH = /^[a-f0-9]{64}$/u;
const SUBJECT_KEY = /^amazon:[A-Z]{2}:[A-Z0-9]{10}$/u;
const MAX_OBSERVATIONS = 500;
const MAX_TEXT_LENGTH = 5_000;
const MAX_TITLE_LENGTH = 500;
const MAX_REFS = 40;
const AMAZON_HOSTS = new Set([
  "amazon.com", "amazon.co.uk", "amazon.ca", "amazon.de", "amazon.co.jp", "amazon.fr",
  "amazon.it", "amazon.es", "amazon.nl", "amazon.se", "amazon.pl", "amazon.com.au",
  "amazon.com.mx", "amazon.in", "amazon.sg", "amazon.ae", "amazon.sa", "amazon.com.tr",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number, nullable = false): string | null {
  if (value === null || value === undefined) return nullable ? null : null;
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  if (!normalized) return nullable ? null : null;
  return normalized.length <= max ? normalized : null;
}

function iso(value: unknown, nullable = false): string | null {
  if (value === null || value === undefined || value === "") return nullable ? null : null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function safeSourceUrl(value: unknown, source: CustomerVoiceSource): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const hostname = url.hostname.toLowerCase();
    if (source === "reddit_post" || source === "reddit_comment") {
      return hostname === "www.reddit.com" || hostname === "reddit.com" ? url.toString() : null;
    }
    if (source === "amazon_review") {
      const host = hostname.startsWith("www.") ? hostname.slice(4) : hostname;
      return AMAZON_HOSTS.has(host) ? url.toString() : null;
    }
    // Manual URLs are stored only as references and are never fetched by this feature.
    return url.toString();
  } catch {
    return null;
  }
}

function validEvidenceRef(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 240
    && (/^attachment:[A-Za-z0-9_-]{1,160}$/u.test(value)
      || /^rawArtifact:raw-[a-f0-9]{24}$/u.test(value)
      || /^evidence:[A-Za-z0-9_-]{1,160}$/u.test(value));
}

function parseOwnerExperience(value: unknown): CustomerVoiceOwnerExperience | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;
  const fields = ["ownershipDuration", "useCase", "failureMode", "timeToFailure", "replacementProduct", "switchReason"] as const;
  const output: Record<string, unknown> = {
    claimedOwnership: value.claimedOwnership === null || value.claimedOwnership === undefined
      ? null
      : typeof value.claimedOwnership === "boolean" ? value.claimedOwnership : undefined,
  };
  if (output.claimedOwnership === undefined) return null;
  for (const field of fields) {
    const item = value[field];
    if (item === null || item === undefined || item === "") {
      output[field] = null;
      continue;
    }
    const normalized = boundedString(item, 500, true);
    if (normalized === null) return null;
    output[field] = normalized;
  }
  return output as CustomerVoiceOwnerExperience;
}

function semanticContent(input: Pick<CustomerVoiceObservationInput,
  "source" | "externalContentId" | "parentContentId" | "threadId" | "contentType" | "publishedAt" | "title" | "text" | "rating" | "verifiedPurchase" | "sourceUrl">) {
  return {
    source: input.source,
    externalContentId: input.externalContentId,
    parentContentId: input.parentContentId,
    threadId: input.threadId,
    contentType: input.contentType,
    publishedAt: input.publishedAt,
    title: input.title,
    text: input.text,
    rating: input.rating,
    verifiedPurchase: input.verifiedPurchase,
    sourceUrl: input.sourceUrl,
  };
}

export function customerVoiceSemanticHash(input: Pick<CustomerVoiceObservationInput,
  "source" | "externalContentId" | "parentContentId" | "threadId" | "contentType" | "publishedAt" | "title" | "text" | "rating" | "verifiedPurchase" | "sourceUrl">): string {
  const canonical = {
    ...input,
    sourceUrl: safeSourceUrl(input.sourceUrl, input.source),
  };
  if (input.sourceUrl !== null && input.sourceUrl !== undefined && canonical.sourceUrl === null) {
    throw new Error("CUSTOMER_VOICE_SOURCE_URL_INVALID");
  }
  return contentHashOf(semanticContent(canonical));
}

export function buildCustomerVoiceObservation(input: CustomerVoiceObservationInput): CustomerVoiceObservation {
  const normalized = parseCustomerVoiceObservation({
    ...input,
    subreddit: input.subreddit ?? null,
    depth: input.depth ?? (input.source === "reddit_comment" ? 0 : null),
    schemaVersion: CUSTOMER_VOICE_OBSERVATION_SCHEMA,
    contentHash: customerVoiceSemanticHash(input),
  });
  if (!normalized) throw new Error("CUSTOMER_VOICE_OBSERVATION_INVALID");
  return normalized;
}

export function parseCustomerVoiceObservation(value: unknown): CustomerVoiceObservation | null {
  if (!isRecord(value) || value.schemaVersion !== CUSTOMER_VOICE_OBSERVATION_SCHEMA) return null;
  if (!(CUSTOMER_VOICE_SOURCES as readonly unknown[]).includes(value.source)) return null;
  const source = value.source as CustomerVoiceSource;
  const subjectKey = boundedString(value.subjectKey, 80);
  if (!subjectKey || !SUBJECT_KEY.test(subjectKey)) return null;
  const externalContentId = boundedString(value.externalContentId, 200);
  if (!externalContentId || /[\u0000-\u001f]/u.test(externalContentId)) return null;
  const parentContentId = boundedString(value.parentContentId, 200, true);
  const threadId = boundedString(value.threadId, 200, true);
  if (value.parentContentId !== null && value.parentContentId !== undefined && parentContentId === null) return null;
  if (value.threadId !== null && value.threadId !== undefined && threadId === null) return null;
  const subreddit = boundedString(value.subreddit, 64, true);
  if (value.subreddit !== null && value.subreddit !== undefined && subreddit === null) return null;
  if (subreddit !== null && ((source !== "reddit_post" && source !== "reddit_comment")
    || !/^[A-Za-z0-9_]{2,21}$/u.test(subreddit))) return null;
  const depth = value.depth === null || value.depth === undefined
    ? null
    : typeof value.depth === "number" && Number.isSafeInteger(value.depth) && value.depth >= 0 && value.depth <= 32
      ? value.depth
      : undefined;
  if (depth === undefined || (source === "reddit_comment") !== (depth !== null)) return null;
  if (!(CUSTOMER_VOICE_CONTENT_TYPES as readonly unknown[]).includes(value.contentType)) return null;
  const contentType = value.contentType as CustomerVoiceContentType;
  const authorRef = boundedString(value.authorRef, 80, true);
  if (value.authorRef !== null && value.authorRef !== undefined
    && (!authorRef || !/^anon:[a-f0-9]{24}$/u.test(authorRef))) return null;
  const capturedAt = iso(value.capturedAt);
  if (!capturedAt) return null;
  const publishedAt = iso(value.publishedAt, true);
  if (value.publishedAt !== null && value.publishedAt !== undefined && value.publishedAt !== "" && !publishedAt) return null;
  const title = boundedString(value.title, MAX_TITLE_LENGTH, true);
  if (value.title !== null && value.title !== undefined && value.title !== "" && title === null) return null;
  const text = boundedString(value.text, MAX_TEXT_LENGTH);
  if (!text) return null;
  const rating = value.rating === null || value.rating === undefined
    ? null
    : typeof value.rating === "number" && Number.isFinite(value.rating) && value.rating >= 1 && value.rating <= 5
      ? value.rating
      : undefined;
  if (rating === undefined || (source === "reddit_post" || source === "reddit_comment") && rating !== null) return null;
  const verifiedPurchase = value.verifiedPurchase === null || value.verifiedPurchase === undefined
    ? null
    : typeof value.verifiedPurchase === "boolean" ? value.verifiedPurchase : undefined;
  if (verifiedPurchase === undefined || (source === "reddit_post" || source === "reddit_comment") && verifiedPurchase !== null) return null;
  let engagement: CustomerVoiceObservation["engagement"] = null;
  if (value.engagement !== null && value.engagement !== undefined) {
    if (!isRecord(value.engagement)) return null;
    const score = value.engagement.score === null ? null
      : typeof value.engagement.score === "number" && Number.isSafeInteger(value.engagement.score) ? value.engagement.score : undefined;
    const commentCount = value.engagement.commentCount === null ? null
      : typeof value.engagement.commentCount === "number" && Number.isSafeInteger(value.engagement.commentCount) && value.engagement.commentCount >= 0 ? value.engagement.commentCount : undefined;
    if (score === undefined || commentCount === undefined) return null;
    engagement = { score, commentCount };
  }
  const sourceUrl = safeSourceUrl(value.sourceUrl, source);
  if (value.sourceUrl !== null && value.sourceUrl !== undefined && sourceUrl === null) return null;
  if (!isRecord(value.provenance)) return null;
  const provenance = value.provenance;
  const methodBySource: Record<CustomerVoiceSource, CustomerVoiceObservation["provenance"]["method"]> = {
    amazon_review: "capture_v3_amazon_review",
    reddit_post: "public_reddit_browser",
    reddit_comment: "public_reddit_browser",
    manual_voc: "manual_import",
  };
  const providerBySource: Record<CustomerVoiceSource, CustomerVoiceObservation["provenance"]["provider"]> = {
    amazon_review: "amazon_dom",
    reddit_post: "reddit_browser",
    reddit_comment: "reddit_browser",
    manual_voc: "manual_import",
  };
  const accessBySource: Record<CustomerVoiceSource, CustomerVoiceObservation["provenance"]["accessBasis"]> = {
    amazon_review: "first_party_visible_page",
    reddit_post: "public_visible_page",
    reddit_comment: "public_visible_page",
    manual_voc: "user_supplied_file",
  };
  const manualAccessAllowed = source === "manual_voc"
    && (provenance.accessBasis === "user_supplied_file" || provenance.accessBasis === "user_supplied_text");
  if (provenance.provider !== providerBySource[source]
    || provenance.method !== methodBySource[source]
    || provenance.accessBasis !== accessBySource[source] && !manualAccessAllowed) return null;
  const provider = provenance.provider as CustomerVoiceObservation["provenance"]["provider"];
  const method = provenance.method as CustomerVoiceObservation["provenance"]["method"];
  const accessBasis = provenance.accessBasis as CustomerVoiceObservation["provenance"]["accessBasis"];
  const sourceAttachmentId = boundedString(provenance.sourceAttachmentId, 160, true);
  const rawArtifactId = boundedString(provenance.rawArtifactId, 80, true);
  const providerTermsVersion = boundedString(provenance.providerTermsVersion, 120, true);
  if (provenance.sourceAttachmentId !== null && provenance.sourceAttachmentId !== undefined && sourceAttachmentId === null) return null;
  if (provenance.rawArtifactId !== null && provenance.rawArtifactId !== undefined
    && (!rawArtifactId || !/^raw-[a-f0-9]{24}$/u.test(rawArtifactId))) return null;
  if (provenance.providerTermsVersion !== null && provenance.providerTermsVersion !== undefined && providerTermsVersion === null) return null;
  if (source === "amazon_review" && !sourceAttachmentId) return null;
  if (source === "manual_voc" && !rawArtifactId && !sourceAttachmentId) return null;
  if ((source === "reddit_post" || source === "reddit_comment") && !rawArtifactId) return null;
  if (source === "reddit_post" && (contentType !== "post" && contentType !== "social_post")) return null;
  if (source === "reddit_comment" && contentType !== "comment") return null;
  if (source === "amazon_review" && contentType !== "review") return null;
  if (source === "reddit_comment" && (!parentContentId || !threadId)) return null;
  if (!(CUSTOMER_VOICE_IDENTITY_MATCHES as readonly unknown[]).includes(value.identityMatch)) return null;
  const identityMatch = value.identityMatch as CustomerVoiceIdentityMatch;
  if (source === "amazon_review" && identityMatch !== "EXACT") return null;
  const ownerExperience = parseOwnerExperience(value.ownerExperience);
  if (value.ownerExperience !== null && value.ownerExperience !== undefined && ownerExperience === null) return null;
  if (source !== "reddit_post" && source !== "reddit_comment" && ownerExperience !== null) return null;
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > MAX_REFS) return null;
  const evidenceRefs = value.evidenceRefs.map((ref) => typeof ref === "string" ? ref.trim() : "");
  if (evidenceRefs.length === 0
    || evidenceRefs.some((ref) => !validEvidenceRef(ref))
    || new Set(evidenceRefs).size !== evidenceRefs.length) return null;
  if (source === "amazon_review" && !evidenceRefs.includes(`attachment:${provenance.sourceAttachmentId}`)) return null;
  if (source === "manual_voc" && provenance.sourceAttachmentId && !evidenceRefs.includes(`attachment:${provenance.sourceAttachmentId}`)) return null;
  if (source === "manual_voc" && provenance.rawArtifactId && !evidenceRefs.includes(`rawArtifact:${provenance.rawArtifactId}`)) return null;
  if ((source === "reddit_post" || source === "reddit_comment")
    && !evidenceRefs.includes(`rawArtifact:${provenance.rawArtifactId}`)) return null;
  const retentionPolicy = boundedString(value.retentionPolicy, 160, true);
  if (value.retentionPolicy !== null && value.retentionPolicy !== undefined && retentionPolicy === null) return null;
  if (typeof value.deletionRequired !== "boolean") return null;
  const externalDeletedAt = iso(value.externalDeletedAt, true);
  if (value.externalDeletedAt !== null && value.externalDeletedAt !== undefined && value.externalDeletedAt !== "" && !externalDeletedAt) return null;
  if (typeof value.contentHash !== "string" || !HASH.test(value.contentHash)) return null;
  const normalizedInput = {
    source,
    externalContentId,
    parentContentId,
    threadId,
    subreddit,
    depth,
    contentType,
    publishedAt,
    title,
    text,
    rating,
    verifiedPurchase,
    sourceUrl,
  };
  if (contentHashOf(semanticContent(normalizedInput)) !== value.contentHash) return null;
  return {
    schemaVersion: CUSTOMER_VOICE_OBSERVATION_SCHEMA,
    source,
    subjectKey,
    externalContentId,
    parentContentId,
    threadId,
    subreddit,
    depth,
    contentType,
    authorRef,
    capturedAt,
    publishedAt,
    title,
    text,
    rating,
    verifiedPurchase,
    engagement,
    sourceUrl,
    contentHash: value.contentHash,
    evidenceRefs,
    provenance: {
      provider,
      method,
      accessBasis,
      sourceAttachmentId,
      rawArtifactId,
      providerTermsVersion,
    },
    retentionPolicy,
    deletionRequired: value.deletionRequired,
    externalDeletedAt,
    identityMatch,
    ownerExperience,
  };
}

export function buildCustomerVoiceAttachmentPayload(input: {
  readonly subjectKey: string;
  readonly observations: readonly CustomerVoiceObservation[];
}): CustomerVoiceAttachmentPayload {
  const parsed = parseCustomerVoiceAttachmentPayload({
    schemaVersion: CUSTOMER_VOICE_ATTACHMENT_PAYLOAD_SCHEMA,
    subjectKey: input.subjectKey,
    observations: input.observations,
  }, input.subjectKey);
  if (!parsed) throw new Error("CUSTOMER_VOICE_ATTACHMENT_PAYLOAD_INVALID");
  return parsed;
}

export function parseCustomerVoiceAttachmentPayload(
  value: unknown,
  expectedSubjectKey?: string,
): CustomerVoiceAttachmentPayload | null {
  if (!isRecord(value)
    || value.schemaVersion !== CUSTOMER_VOICE_ATTACHMENT_PAYLOAD_SCHEMA
    || typeof value.subjectKey !== "string"
    || !SUBJECT_KEY.test(value.subjectKey)
    || expectedSubjectKey !== undefined && value.subjectKey !== expectedSubjectKey
    || !Array.isArray(value.observations)
    || value.observations.length < 1
    || value.observations.length > MAX_OBSERVATIONS) return null;
  const observations: CustomerVoiceObservation[] = [];
  const dedupeKeys = new Set<string>();
  let payloadSource: CustomerVoiceSource | null = null;
  for (const raw of value.observations) {
    const observation = parseCustomerVoiceObservation(raw);
    if (!observation || observation.subjectKey !== value.subjectKey
      || payloadSource !== null && observation.source !== payloadSource) return null;
    payloadSource ??= observation.source;
    const dedupeKey = `${observation.externalContentId}:${observation.contentHash}`;
    if (dedupeKeys.has(dedupeKey)) return null;
    dedupeKeys.add(dedupeKey);
    observations.push(observation);
  }
  return {
    schemaVersion: CUSTOMER_VOICE_ATTACHMENT_PAYLOAD_SCHEMA,
    subjectKey: value.subjectKey,
    observations,
  };
}

export function customerVoiceDedupeKey(observation: Pick<CustomerVoiceObservation, "externalContentId" | "contentHash">): string {
  return `${observation.externalContentId}:${observation.contentHash}`;
}
