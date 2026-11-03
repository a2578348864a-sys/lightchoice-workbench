import "server-only";

import type { AccessContext } from "@/lib/server/accessPassword";
import type { CaptureSourceType } from "@/lib/sourceLayer/capturePackage";
import {
  captureV3ModuleEvidence,
  readV3ModuleEvidence,
  V3_ACQUISITION_MODES,
  V3_METRIC_NATURES,
  V3_MODULE_IDS,
  V3_MODULE_STATUSES,
  type V3AcquisitionMode,
  type V3MetricNature,
  type V3ModuleId,
  type V3ModuleStatus,
} from "@/lib/sourceLayer/v3ModuleEvidence";

export const BROWSER_VISIBLE_V3_SCHEMA = "capture-system-v3-browser-visible-envelope.v1" as const;

const BROWSER_VISIBLE_ACQUISITION_MODES: readonly V3AcquisitionMode[] = [
  "DOM_DIRECT",
  "EXTENSION_RENDERED",
  "PAGE_NETWORK_OBSERVED",
  "VISIBLE_CHART",
  "SCREENSHOT_EVIDENCE",
  "USER_ASSISTED_SESSION",
  "LOCAL_FILE_REPLAY",
];

export type BrowserVisibleV3Envelope = {
  schemaVersion: typeof BROWSER_VISIBLE_V3_SCHEMA;
  module: V3ModuleId;
  subjectKey: string;
  marketplace: string;
  capturedAt: string;
  provider: string;
  sourceSurface: string;
  sourceUrl: string;
  acquisitionMode: V3AcquisitionMode;
  metricNature: V3MetricNature;
  status: V3ModuleStatus;
  limitations: string[];
  identity: Record<string, unknown>;
  data: Record<string, unknown>;
  providerUpdatedAt: string | null;
  freshnessMetricKey: string | null;
  evidenceOnly: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, code: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) throw new Error(code);
  return value.normalize("NFC").trim();
}

function parseHttpsUrl(value: unknown): string {
  const sourceUrl = requiredText(value, "BROWSER_VISIBLE_SOURCE_URL_REQUIRED", 2048);
  try {
    if (new URL(sourceUrl).protocol !== "https:") throw new Error("not_https");
  } catch {
    throw new Error("BROWSER_VISIBLE_SOURCE_URL_INVALID");
  }
  return sourceUrl;
}

function parseList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("BROWSER_VISIBLE_LIMITATIONS_INVALID");
  return value.map((item) => requiredText(item, "BROWSER_VISIBLE_LIMITATION_INVALID", 240)).slice(0, 16);
}

export function parseBrowserVisibleV3Envelope(value: unknown): BrowserVisibleV3Envelope {
  if (!isRecord(value) || value.schemaVersion !== BROWSER_VISIBLE_V3_SCHEMA) {
    throw new Error("BROWSER_VISIBLE_SCHEMA_INVALID");
  }
  const moduleId = value.module as V3ModuleId;
  if (!V3_MODULE_IDS.includes(moduleId)) throw new Error("BROWSER_VISIBLE_MODULE_INVALID");
  const acquisitionMode = value.acquisitionMode as V3AcquisitionMode;
  if (!BROWSER_VISIBLE_ACQUISITION_MODES.includes(acquisitionMode) || !V3_ACQUISITION_MODES.includes(acquisitionMode)) {
    throw new Error("BROWSER_VISIBLE_ACQUISITION_MODE_INVALID");
  }
  const metricNature = value.metricNature as V3MetricNature;
  if (!V3_METRIC_NATURES.includes(metricNature)) throw new Error("BROWSER_VISIBLE_METRIC_NATURE_INVALID");
  const status = value.status as V3ModuleStatus;
  if (!V3_MODULE_STATUSES.includes(status)) throw new Error("BROWSER_VISIBLE_STATUS_INVALID");
  const sourceUrl = parseHttpsUrl(value.sourceUrl);
  const identity = value.identity;
  const data = value.data;
  if (!isRecord(identity) || !isRecord(data)) throw new Error("BROWSER_VISIBLE_PAYLOAD_INVALID");
  const capturedAt = requiredText(value.capturedAt, "BROWSER_VISIBLE_CAPTURED_AT_REQUIRED", 64);
  if (Number.isNaN(Date.parse(capturedAt))) throw new Error("BROWSER_VISIBLE_CAPTURED_AT_INVALID");
  const providerUpdatedAt = value.providerUpdatedAt === null || value.providerUpdatedAt === undefined
    ? null
    : requiredText(value.providerUpdatedAt, "BROWSER_VISIBLE_PROVIDER_UPDATED_AT_INVALID", 64);
  if (providerUpdatedAt !== null && Number.isNaN(Date.parse(providerUpdatedAt))) {
    throw new Error("BROWSER_VISIBLE_PROVIDER_UPDATED_AT_INVALID");
  }
  return {
    schemaVersion: BROWSER_VISIBLE_V3_SCHEMA,
    module: moduleId,
    subjectKey: requiredText(value.subjectKey, "BROWSER_VISIBLE_SUBJECT_REQUIRED", 160),
    marketplace: requiredText(value.marketplace ?? "US", "BROWSER_VISIBLE_MARKETPLACE_REQUIRED", 16).toUpperCase(),
    capturedAt,
    provider: requiredText(value.provider, "BROWSER_VISIBLE_PROVIDER_REQUIRED", 120),
    sourceSurface: requiredText(value.sourceSurface, "BROWSER_VISIBLE_SURFACE_REQUIRED", 160),
    sourceUrl,
    acquisitionMode,
    metricNature,
    status,
    limitations: parseList(value.limitations),
    identity,
    data,
    providerUpdatedAt,
    freshnessMetricKey: value.freshnessMetricKey === null || value.freshnessMetricKey === undefined
      ? null
      : requiredText(value.freshnessMetricKey, "BROWSER_VISIBLE_FRESHNESS_KEY_INVALID", 80),
    evidenceOnly: value.evidenceOnly !== false,
  };
}

export async function captureBrowserVisibleV3Envelope(input: {
  context: AccessContext;
  envelope: unknown;
  sourceType: Extract<CaptureSourceType, "amazon_dom" | "sellersprite_plugin" | "manual_entry">;
  sourceFingerprint?: string | null;
}) {
  const envelope = parseBrowserVisibleV3Envelope(input.envelope);
  return captureV3ModuleEvidence({
    context: input.context,
    sourceType: input.sourceType,
    sourceFingerprint: input.sourceFingerprint,
    moduleEvidence: {
      module: envelope.module,
      subjectKey: envelope.subjectKey,
      marketplace: envelope.marketplace,
      capturedAt: envelope.capturedAt,
      provider: envelope.provider,
      sourceSurface: envelope.sourceSurface,
      sourceUrl: envelope.sourceUrl,
      providerUpdatedAt: envelope.providerUpdatedAt,
      freshnessMetricKey: envelope.freshnessMetricKey,
      acquisitionMode: envelope.acquisitionMode,
      metricNature: envelope.metricNature,
      status: envelope.status,
      limitations: envelope.limitations,
      identity: envelope.identity,
      data: envelope.data,
      evidenceOnly: envelope.evidenceOnly,
    },
  });
}

export { readV3ModuleEvidence };
