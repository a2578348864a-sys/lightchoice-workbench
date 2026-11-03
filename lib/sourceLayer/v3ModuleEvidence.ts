import "server-only";

import type { AccessContext } from "@/lib/server/accessPassword";
import type { CaptureSourceType } from "@/lib/sourceLayer/capturePackage";
import {
  SOURCE_EVIDENCE_ATTACHMENT_KINDS,
  type SourceEvidenceAttachment,
  type SourceEvidenceAttachmentKind,
} from "@/lib/sourceLayer/evidenceAttachment";
import {
  captureEvidenceAttachmentThroughGateway,
  type CaptureGatewayAttachmentResult,
  type CaptureGatewaySource,
} from "@/lib/sourceLayer/server/captureGateway";
import {
  createEvidenceStore,
  type EvidenceSubjectRecord,
} from "@/lib/sourceLayer/server/evidenceStore";
import { persistRawArtifact } from "@/lib/sourceLayer/server/rawArtifactIntake";
import { sourceLayerOperator } from "@/lib/sourceLayer/server/sourceLayerService";
import {
  type RawArtifactKind,
  type RawArtifactAcquisitionMode,
} from "@/lib/sourceLayer/rawArtifact";
import {
  evaluateV3ProviderFreshness,
  type V3FreshnessSnapshot,
} from "@/lib/sourceLayer/providerFreshness";

/** Capture System V3 的八个正式模块。 */
export const V3_MODULE_IDS = [
  "amazon_detail",
  "amazon_search_market",
  "sellersprite_product_market",
  "reverse_asin",
  "keyword_mining_trend",
  "variation",
  "review_voc",
  "historical_trend",
] as const;
export type V3ModuleId = (typeof V3_MODULE_IDS)[number];

/** 采集方式是证据 provenance，不是能力宣称。 */
export const V3_ACQUISITION_MODES = [
  "DOM_DIRECT",
  "EXTENSION_RENDERED",
  "PAGE_NETWORK_OBSERVED",
  "VISIBLE_CHART",
  "SCREENSHOT_EVIDENCE",
  "FILE_EXPORT",
  "BROWSER_DOWNLOAD",
  "USER_ASSISTED_SESSION",
  "LOCAL_FILE_REPLAY",
] as const;
export type V3AcquisitionMode = (typeof V3_ACQUISITION_MODES)[number];

export const V3_MODULE_STATUSES = [
  "VALIDATED_AVAILABLE",
  "AVAILABLE_WITH_LIMITATION",
  "PLAN_LIMITATION",
  "BLOCKED_WITH_EVIDENCE",
  "HUMAN_ACTION_REQUIRED",
  "UNVERIFIED",
] as const;
export type V3ModuleStatus = (typeof V3_MODULE_STATUSES)[number];

export const V3_METRIC_NATURES = [
  "source_observed",
  "provider_observed",
  "provider_estimate",
  "derived",
  "provider_analysis",
] as const;
export type V3MetricNature = (typeof V3_METRIC_NATURES)[number];

export type V3ModuleIdentity = {
  asin?: string | null;
  parentAsin?: string | null;
  keyword?: string | null;
  query?: string | null;
  category?: string | null;
};

export type V3ModuleEvidence = {
  schemaVersion: "capture-system-v3-module-evidence.v1";
  module: V3ModuleId;
  subjectKey: string;
  marketplace: string;
  capturedAt: string;
  provider: string;
  sourceSurface: string;
  sourceUrl: string | null;
  providerUpdatedAt: string | null;
  freshness: V3FreshnessSnapshot;
  acquisitionMode: V3AcquisitionMode;
  metricNature: V3MetricNature;
  status: V3ModuleStatus;
  limitations: string[];
  identity: V3ModuleIdentity;
  /** 结构化可见页面数据；它是 Evidence，不是第二事实库。 */
  data: Record<string, unknown>;
  /** 没有稳定 ProductFact 投影时，显式告诉下游只能 Evidence-only 消费。 */
  evidenceOnly: boolean;
};

export type V3ModuleCaptureResult = {
  moduleEvidence: V3ModuleEvidence;
  gateway: CaptureGatewayAttachmentResult;
  attachment: SourceEvidenceAttachment;
  rawArtifact: Awaited<ReturnType<typeof persistRawArtifact>>;
  evidenceStore: EvidenceSubjectRecord;
  downstream: {
    readable: true;
    evidenceOnly: boolean;
    subjectKey: string;
    attachmentId: string;
    rawArtifactId: string;
  };
};

const SUBJECT_KEY_PATTERN = /^[A-Za-z0-9:._\-|@]{1,160}$/;
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
export const MAX_V3_MODULE_DATA_BYTES = 220 * 1024;
const MAX_DEPTH = 10;
const MAX_NODES = 6000;
const CREDENTIAL_KEY_PATTERN = /^(?:authorization|cookie|set-cookie|password|passphrase|token|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)$/iu;

const ATTACHMENT_KIND_BY_MODULE: Readonly<Record<V3ModuleId, SourceEvidenceAttachmentKind>> = Object.freeze({
  amazon_detail: "v3_amazon_detail_v1",
  amazon_search_market: "v3_amazon_search_market_v1",
  sellersprite_product_market: "v3_sellersprite_product_market_v1",
  reverse_asin: "v3_reverse_asin_v1",
  keyword_mining_trend: "v3_keyword_mining_trend_v1",
  variation: "v3_variation_v1",
  review_voc: "v3_review_voc_v1",
  historical_trend: "v3_historical_trend_v1",
});

const RAW_KIND_BY_MODULE: Readonly<Record<V3ModuleId, RawArtifactKind>> = Object.freeze({
  amazon_detail: "other",
  amazon_search_market: "market_export",
  sellersprite_product_market: "market_export",
  reverse_asin: "reverse_asin_export",
  keyword_mining_trend: "keyword_export",
  variation: "variation_export",
  review_voc: "review_export",
  historical_trend: "timeseries_export",
});

const RAW_MODE_BY_ACQUISITION: Readonly<Record<V3AcquisitionMode, RawArtifactAcquisitionMode>> = Object.freeze({
  DOM_DIRECT: "dom_direct",
  EXTENSION_RENDERED: "extension_rendered",
  PAGE_NETWORK_OBSERVED: "page_network_observed",
  VISIBLE_CHART: "visible_chart",
  SCREENSHOT_EVIDENCE: "screenshot_evidence",
  FILE_EXPORT: "manual_export",
  BROWSER_DOWNLOAD: "browser_download",
  USER_ASSISTED_SESSION: "user_assisted_session",
  LOCAL_FILE_REPLAY: "local_file_replay",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string, maxLength: number, required = true): string | null {
  if (typeof value !== "string") {
    if (required) throw new Error(`V3_MODULE_${field.toUpperCase()}_REQUIRED`);
    return null;
  }
  const normalized = value.normalize("NFC").trim();
  if (!normalized) {
    if (required) throw new Error(`V3_MODULE_${field.toUpperCase()}_REQUIRED`);
    return null;
  }
  if (normalized.length > maxLength) throw new Error(`V3_MODULE_${field.toUpperCase()}_TOO_LONG`);
  return normalized;
}

function assertNoCredentialLikeKeys(value: unknown, depth = 0, state = { nodes: 0 }): void {
  state.nodes += 1;
  if (state.nodes > MAX_NODES) throw new Error("V3_MODULE_DATA_TOO_LARGE");
  if (depth > MAX_DEPTH) throw new Error("V3_MODULE_DATA_TOO_DEEP");
  if (Array.isArray(value)) {
    for (const item of value) assertNoCredentialLikeKeys(item, depth + 1, state);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) throw new Error("V3_MODULE_CREDENTIAL_FIELD_FORBIDDEN");
    assertNoCredentialLikeKeys(child, depth + 1, state);
  }
}

function validateData(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("V3_MODULE_DATA_OBJECT_REQUIRED");
  assertNoCredentialLikeKeys(value);
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_V3_MODULE_DATA_BYTES) {
    throw new Error("V3_MODULE_DATA_TOO_LARGE");
  }
  return value;
}

function optionalAsin(value: unknown, field: string): string | null {
  const normalized = text(value, field, 10, false)?.toUpperCase() ?? null;
  if (normalized !== null && !ASIN_PATTERN.test(normalized)) {
    throw new Error(`V3_MODULE_${field.toUpperCase()}_INVALID`);
  }
  return normalized;
}

function validateIdentity(value: unknown, subjectKey: string): V3ModuleIdentity {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error("V3_MODULE_IDENTITY_INVALID");
  const identity: V3ModuleIdentity = {
    asin: optionalAsin(value.asin, "asin"),
    parentAsin: optionalAsin(value.parentAsin, "parent_asin"),
    keyword: text(value.keyword, "keyword", 240, false),
    query: text(value.query, "query", 240, false),
    category: text(value.category, "category", 240, false),
  };
  const hasIdentity = Object.values(identity).some((item) => item !== null && item !== undefined);
  if (!hasIdentity) throw new Error("V3_MODULE_IDENTITY_REQUIRED");
  const match = /^amazon:([A-Z]{2}):([A-Z0-9]{10})$/u.exec(subjectKey);
  if (identity.asin && match && identity.asin !== match[2]) {
    throw new Error("V3_MODULE_ASIN_SUBJECT_MISMATCH");
  }
  return identity;
}

function validateSourceUrl(value: unknown): string | null {
  const sourceUrl = text(value, "source_url", 2048, false);
  if (sourceUrl === null) return null;
  try {
    if (new URL(sourceUrl).protocol !== "https:") throw new Error("not_https");
  } catch {
    throw new Error("V3_MODULE_SOURCE_URL_INVALID");
  }
  return sourceUrl;
}

function sourceForGateway(sourceType: CaptureSourceType): CaptureGatewaySource {
  switch (sourceType) {
    case "amazon_dom":
    case "sellersprite_plugin":
    case "sellersprite_xlsx":
    case "keepa_export":
      return sourceType;
    case "manual_entry":
      return "manual";
    default:
      throw new Error("V3_MODULE_SOURCE_TYPE_NOT_ALLOWED");
  }
}

function subjectSafeFileName(subjectKey: string): string {
  return subjectKey.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 100) || "subject";
}

function rawBytesForEvidence(evidence: V3ModuleEvidence): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({
    schemaVersion: evidence.schemaVersion,
    acquisitionMode: evidence.acquisitionMode,
    evidence,
  }, null, 2)}\n`);
}

export function attachmentKindForV3Module(module: V3ModuleId): SourceEvidenceAttachmentKind {
  return ATTACHMENT_KIND_BY_MODULE[module];
}

export function rawArtifactKindForV3Module(module: V3ModuleId): RawArtifactKind {
  return RAW_KIND_BY_MODULE[module];
}

export function buildV3ModuleEvidence(input: {
  module: V3ModuleId;
  subjectKey: string;
  marketplace?: string;
  capturedAt: string;
  provider: string;
  sourceSurface: string;
  sourceUrl?: string | null;
  providerUpdatedAt?: string | null;
  freshnessMetricKey?: string | null;
  freshnessNow?: Date | string | number;
  acquisitionMode: V3AcquisitionMode;
  metricNature: V3MetricNature;
  status: V3ModuleStatus;
  limitations?: readonly string[];
  identity: V3ModuleIdentity;
  data: Record<string, unknown>;
  evidenceOnly?: boolean;
}): V3ModuleEvidence {
  if (!V3_MODULE_IDS.includes(input.module)) throw new Error("V3_MODULE_ID_INVALID");
  if (!SUBJECT_KEY_PATTERN.test(input.subjectKey.trim())) throw new Error("V3_MODULE_SUBJECT_INVALID");
  const capturedAt = text(input.capturedAt, "captured_at", 64) as string;
  if (Number.isNaN(Date.parse(capturedAt))) throw new Error("V3_MODULE_CAPTURED_AT_INVALID");
  const provider = text(input.provider, "provider", 120) as string;
  const sourceSurface = text(input.sourceSurface, "source_surface", 160) as string;
  const providerUpdatedAt = text(input.providerUpdatedAt, "provider_updated_at", 64, false);
  if (providerUpdatedAt !== null && Number.isNaN(Date.parse(providerUpdatedAt))) {
    throw new Error("V3_MODULE_PROVIDER_UPDATED_AT_INVALID");
  }
  if (!V3_ACQUISITION_MODES.includes(input.acquisitionMode)) throw new Error("V3_MODULE_ACQUISITION_MODE_INVALID");
  if (!V3_METRIC_NATURES.includes(input.metricNature)) throw new Error("V3_MODULE_METRIC_NATURE_INVALID");
  if (!V3_MODULE_STATUSES.includes(input.status)) throw new Error("V3_MODULE_STATUS_INVALID");
  const limitations = [...new Set((input.limitations ?? []).map((item) => text(item, "limitation", 240) as string))].slice(0, 16);
  if ((input.status === "PLAN_LIMITATION" || input.status === "AVAILABLE_WITH_LIMITATION" || input.status === "BLOCKED_WITH_EVIDENCE")
    && limitations.length === 0) {
    throw new Error("V3_MODULE_LIMITATION_REQUIRED");
  }
  const subjectKey = input.subjectKey.trim();
  const identity = validateIdentity(input.identity, subjectKey);
  const data = validateData(input.data);
  const freshness = evaluateV3ProviderFreshness({
    module: input.module,
    metricKey: input.freshnessMetricKey,
    providerUpdatedAt,
    now: input.freshnessNow ?? capturedAt,
  });
  return {
    schemaVersion: "capture-system-v3-module-evidence.v1",
    module: input.module,
    subjectKey,
    marketplace: (text(input.marketplace ?? "US", "marketplace", 16) as string).toUpperCase(),
    capturedAt,
    provider,
    sourceSurface,
    sourceUrl: validateSourceUrl(input.sourceUrl),
    providerUpdatedAt,
    freshness,
    acquisitionMode: input.acquisitionMode,
    metricNature: input.metricNature,
    status: input.status,
    limitations,
    identity,
    data,
    evidenceOnly: input.evidenceOnly ?? true,
  };
}

export function parseV3ModuleEvidence(value: unknown): V3ModuleEvidence | null {
  if (!isRecord(value) || value.schemaVersion !== "capture-system-v3-module-evidence.v1") return null;
  try {
    return buildV3ModuleEvidence({
      module: value.module as V3ModuleId,
      subjectKey: String(value.subjectKey ?? ""),
      marketplace: String(value.marketplace ?? ""),
      capturedAt: String(value.capturedAt ?? ""),
      provider: String(value.provider ?? ""),
      sourceSurface: String(value.sourceSurface ?? ""),
      sourceUrl: value.sourceUrl === null ? null : String(value.sourceUrl ?? ""),
      providerUpdatedAt: value.providerUpdatedAt === null ? null : String(value.providerUpdatedAt ?? ""),
      freshnessMetricKey: isRecord(value.freshness) && typeof value.freshness.cadenceKey === "string"
        ? value.freshness.cadenceKey
        : null,
      acquisitionMode: value.acquisitionMode as V3AcquisitionMode,
      metricNature: value.metricNature as V3MetricNature,
      status: value.status as V3ModuleStatus,
      limitations: Array.isArray(value.limitations) ? value.limitations.map(String) : [],
      identity: isRecord(value.identity) ? value.identity as V3ModuleIdentity : {},
      data: isRecord(value.data) ? value.data : {},
      evidenceOnly: value.evidenceOnly === true,
    });
  } catch {
    return null;
  }
}

export async function captureV3ModuleEvidence(input: {
  context: AccessContext;
  moduleEvidence: Parameters<typeof buildV3ModuleEvidence>[0];
  sourceType: CaptureSourceType;
  sourceFingerprint?: string | null;
}): Promise<V3ModuleCaptureResult> {
  const moduleEvidence = buildV3ModuleEvidence(input.moduleEvidence);
  const source = sourceForGateway(input.sourceType);
  const now = new Date(moduleEvidence.capturedAt);
  const gateway = await captureEvidenceAttachmentThroughGateway({
    context: input.context,
    subjectKey: moduleEvidence.subjectKey,
    source,
    kind: attachmentKindForV3Module(moduleEvidence.module),
    payload: moduleEvidence as unknown as Record<string, unknown>,
    sourceUrl: moduleEvidence.sourceUrl,
    sourceFingerprint: input.sourceFingerprint ?? null,
    capturedAt: now,
  });
  const bytes = rawBytesForEvidence(moduleEvidence);
  const rawArtifact = await persistRawArtifact({
    context: input.context,
    subjectKey: moduleEvidence.subjectKey,
    sourceType: input.sourceType,
    kind: rawArtifactKindForV3Module(moduleEvidence.module),
    fileName: `v3-${moduleEvidence.module}-${subjectSafeFileName(moduleEvidence.subjectKey)}.json`,
    contentType: "application/json",
    bytes,
    capturedAt: moduleEvidence.capturedAt,
    provenance: {
      provider: moduleEvidence.provider,
      sourceSurface: moduleEvidence.sourceSurface,
      sourceUrl: moduleEvidence.sourceUrl,
      sourceRecordRef: moduleEvidence.identity.asin ?? moduleEvidence.identity.keyword ?? moduleEvidence.identity.query ?? null,
      providerUpdatedAt: moduleEvidence.providerUpdatedAt,
      acquisitionMode: RAW_MODE_BY_ACQUISITION[moduleEvidence.acquisitionMode],
      parserVersion: "capture-system-v3-module.v1",
    },
  });
  const store = createEvidenceStore(sourceLayerOperator(input.context));
  const evidenceStore = await store.getSubject(moduleEvidence.subjectKey);
  if (!evidenceStore) throw new Error("V3_MODULE_EVIDENCE_STORE_READBACK_FAILED");
  const persistedAttachment = evidenceStore.attachments?.find((item) => item.attachmentId === gateway.attachment.attachmentId);
  const persistedArtifact = evidenceStore.rawArtifacts?.find((item) => item.sha256 === rawArtifact.artifact.sha256);
  if (!persistedAttachment || !persistedArtifact) throw new Error("V3_MODULE_EVIDENCE_STORE_BINDING_FAILED");
  return {
    moduleEvidence,
    gateway,
    attachment: persistedAttachment,
    rawArtifact,
    evidenceStore,
    downstream: {
      readable: true,
      evidenceOnly: moduleEvidence.evidenceOnly,
      subjectKey: moduleEvidence.subjectKey,
      attachmentId: persistedAttachment.attachmentId,
      rawArtifactId: persistedArtifact.artifactId,
    },
  };
}

export async function readV3ModuleEvidence(input: {
  context: AccessContext;
  subjectKey: string;
  module?: V3ModuleId;
}): Promise<{
  subjectKey: string;
  modules: V3ModuleEvidence[];
  evidenceStore: EvidenceSubjectRecord | null;
}> {
  if (!SUBJECT_KEY_PATTERN.test(input.subjectKey.trim())) throw new Error("V3_MODULE_SUBJECT_INVALID");
  if (input.module !== undefined && !V3_MODULE_IDS.includes(input.module)) throw new Error("V3_MODULE_ID_INVALID");
  const store = createEvidenceStore(sourceLayerOperator(input.context));
  const evidenceStore = await store.getSubject(input.subjectKey.trim());
  const modules = (evidenceStore?.attachments ?? [])
    .filter((attachment) => input.module === undefined || attachment.kind === attachmentKindForV3Module(input.module))
    .map((attachment) => parseV3ModuleEvidence(attachment.payload))
    .filter((item): item is V3ModuleEvidence => item !== null)
    .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
  return { subjectKey: input.subjectKey.trim(), modules, evidenceStore };
}

export function isV3AttachmentKind(value: unknown): value is SourceEvidenceAttachmentKind {
  return typeof value === "string" && SOURCE_EVIDENCE_ATTACHMENT_KINDS.includes(value as SourceEvidenceAttachmentKind);
}
