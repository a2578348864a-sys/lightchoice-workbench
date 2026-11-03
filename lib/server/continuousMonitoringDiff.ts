import type { CaptureSourceType } from "@/lib/sourceLayer/capturePackage";
import type {
  V3AcquisitionMode,
  V3MetricNature,
  V3ModuleEvidence,
  V3ModuleId,
  V3ModuleStatus,
} from "@/lib/sourceLayer/v3ModuleEvidence";

/** Immutable Capture V3 references. The payload itself remains authoritative in EvidenceStore. */
export type MonitoringEvidenceReference = {
  subjectKey: string;
  module: V3ModuleId;
  attachmentId: string;
  contentHash: string;
  capturedAt: string;
  sourceType: CaptureSourceType;
  provider: string;
  acquisitionMode: V3AcquisitionMode;
  metricNature: V3MetricNature;
  rawArtifactId: string;
  rawArtifactHash: string;
};

export type MonitoringEvidenceSnapshot = {
  sourceType: CaptureSourceType;
  evidence: V3ModuleEvidence;
  evidenceRef: MonitoringEvidenceReference;
};

export type MonitoringFieldRule = {
  field: string;
  comparison: "numeric_delta";
  absoluteThreshold: number | null;
  relativeThreshold: number | null;
  enabled: boolean;
};

export type MonitoringPolicy = {
  cooldownMinutes: number;
  rules: readonly MonitoringFieldRule[];
};

export type MonitoringCaptureOutcome =
  | { status: "CAPTURED"; snapshot: MonitoringEvidenceSnapshot }
  | { status: "FAILED" | "HUMAN_ACTION_REQUIRED"; errorCode: string };

export type MonitoringFieldDiff = {
  field: string;
  comparison: "numeric_delta";
  before: number;
  after: number;
  delta: number;
  relativeDelta: number | null;
  unit: string;
  absoluteThreshold: number | null;
  relativeThreshold: number | null;
  source: CaptureSourceType;
  metricNature: V3MetricNature;
  previousEvidenceRef: MonitoringEvidenceReference;
  currentEvidenceRef: MonitoringEvidenceReference;
};

/**
 * A configured field that could not be compared in this run. It never blocks the
 * other configured fields: the run only fails as NOT_COMPARABLE when every
 * enabled field is uncomparable.
 */
export type MonitoringUncomparableField = {
  field: string;
  /** Stable machine reason, e.g. `field_status_ambiguous`, `unit_mismatch`. */
  reason: string;
  /** Provider-side detail, e.g. `conflicting_candidates`; never a guessed value. */
  detail: string | null;
};

export type MonitoringComparisonResult =
  | {
    status: "RUN_FAILED";
    errorCode: string;
    diffs: [];
    changeEvent: null;
  }
  | {
    status: "BASELINE_ESTABLISHED";
    diffs: [];
    changeEvent: null;
  }
  | {
    status: "NOT_COMPARABLE";
    reason: string;
    diffs: [];
    uncomparable: MonitoringUncomparableField[];
    changeEvent: null;
  }
  | {
    status: "NO_MEANINGFUL_CHANGE";
    diffDetected: boolean;
    diffs: MonitoringFieldDiff[];
    uncomparable: MonitoringUncomparableField[];
    changeEvent: null;
  }
  | {
    status: "CHANGE_DETECTED";
    diffDetected: true;
    diffs: MonitoringFieldDiff[];
    uncomparable: MonitoringUncomparableField[];
    changeEvent: {
      subjectKey: string;
      module: V3ModuleId;
      detectedAt: string;
      evidenceRefs: [MonitoringEvidenceReference, MonitoringEvidenceReference];
      diffs: MonitoringFieldDiff[];
    };
  };

const COMPARABLE_STATUSES: ReadonlySet<V3ModuleStatus> = new Set([
  "VALIDATED_AVAILABLE",
  "AVAILABLE_WITH_LIMITATION",
  "PLAN_LIMITATION",
]);

/**
 * V1's first field profile is deliberately narrow. Other module shapes need their own
 * reviewed semantic allowlist before they can produce change events.
 */
const FIELD_PROFILES: Readonly<Partial<Record<V3ModuleId, Readonly<Record<string, "currency" | "stars" | "reviews">>>>> = Object.freeze({
  amazon_detail: Object.freeze({ price: "currency", rating: "stars", reviewCount: "reviews" }),
});

type ExtractedMetric = { value: number; unit: string };

export type MonitoringMetricExtraction =
  | { ok: true; metric: ExtractedMetric }
  | { ok: false; reason: string; detail: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[,$\s]/gu, "");
  if (!normalized || !/^-?(?:\d+\.?\d*|\.\d+)$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Field extraction reports why a value is unusable instead of collapsing to null, so a
 * single unavailable field can no longer hide the remaining configured fields.
 */
export function extractMonitoringField(evidence: V3ModuleEvidence, field: string): MonitoringMetricExtraction {
  const profile = FIELD_PROFILES[evidence.module];
  if (!profile || !(field in profile)) return { ok: false, reason: "field_not_supported_by_module", detail: null };
  const registeredFields = evidence.data.registeredFields;
  if (!isRecord(registeredFields)) return { ok: false, reason: "registered_fields_missing", detail: null };
  const registeredField = registeredFields[field];
  if (!isRecord(registeredField)) return { ok: false, reason: "field_absent", detail: null };

  const providerReason = typeof registeredField.reason === "string" ? registeredField.reason : null;
  const fieldStatus = typeof registeredField.status === "string" ? registeredField.status : "unknown";
  if (fieldStatus !== "observed") return { ok: false, reason: `field_status_${fieldStatus}`, detail: providerReason };
  if (registeredField.fieldNature !== "DIRECT_FACT") return { ok: false, reason: "field_not_direct_fact", detail: providerReason };

  if (field === "price") {
    const price = registeredField.value;
    if (!isRecord(price) || typeof price.currency !== "string") return { ok: false, reason: "price_shape_invalid", detail: providerReason };
    const amount = finiteNumber(price.amount);
    const currency = price.currency.trim().toUpperCase();
    return amount === null || !currency
      ? { ok: false, reason: "price_not_numeric", detail: providerReason }
      : { ok: true, metric: { value: amount, unit: currency } };
  }

  const value = finiteNumber(registeredField.value);
  return value === null
    ? { ok: false, reason: "value_not_numeric", detail: providerReason }
    : { ok: true, metric: { value, unit: profile[field] } };
}

/**
 * Ratings are one-decimal numbers, so `4.3 - 4.2` evaluates to `0.09999999999999964`.
 * Normalize before thresholding; otherwise an exact 0.1 change silently misses the gate.
 */
function normalizeDelta(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function hasValue(value: string): boolean {
  return value.trim().length > 0;
}

function snapshotIsWellBound(snapshot: MonitoringEvidenceSnapshot): boolean {
  const { evidence, evidenceRef } = snapshot;
  return evidence.subjectKey === evidenceRef.subjectKey
    && evidence.module === evidenceRef.module
    && evidence.capturedAt === evidenceRef.capturedAt
    && snapshot.sourceType === evidenceRef.sourceType
    && evidence.provider === evidenceRef.provider
    && evidence.acquisitionMode === evidenceRef.acquisitionMode
    && evidence.metricNature === evidenceRef.metricNature
    && hasValue(evidenceRef.attachmentId)
    && hasValue(evidenceRef.contentHash)
    && hasValue(evidenceRef.rawArtifactId)
    && hasValue(evidenceRef.rawArtifactHash)
    && Number.isFinite(Date.parse(evidence.capturedAt));
}

function notComparable(reason: string): MonitoringComparisonResult {
  return { status: "NOT_COMPARABLE", reason, diffs: [], uncomparable: [], changeEvent: null };
}

function pairIsComparable(
  previous: MonitoringEvidenceSnapshot,
  current: MonitoringEvidenceSnapshot,
): boolean {
  const before = previous.evidence;
  const after = current.evidence;
  return snapshotIsWellBound(previous)
    && snapshotIsWellBound(current)
    && before.subjectKey === after.subjectKey
    && before.marketplace === after.marketplace
    && before.module === after.module
    && previous.sourceType === current.sourceType
    && before.provider === after.provider
    && before.acquisitionMode === after.acquisitionMode
    && before.metricNature === after.metricNature
    && COMPARABLE_STATUSES.has(before.status)
    && COMPARABLE_STATUSES.has(after.status)
    && Date.parse(after.capturedAt) > Date.parse(before.capturedAt);
}

function isValidRule(rule: MonitoringFieldRule): boolean {
  return rule.comparison === "numeric_delta"
    && (rule.absoluteThreshold === null || (Number.isFinite(rule.absoluteThreshold) && rule.absoluteThreshold >= 0))
    && (rule.relativeThreshold === null || (Number.isFinite(rule.relativeThreshold) && rule.relativeThreshold >= 0))
    && (rule.absoluteThreshold !== null || rule.relativeThreshold !== null);
}

function ruleIsMeaningful(rule: MonitoringFieldRule, delta: number, relativeDelta: number | null): boolean {
  const absoluteChanged = rule.absoluteThreshold !== null && Math.abs(delta) >= rule.absoluteThreshold;
  const relativeChanged = rule.relativeThreshold !== null
    && relativeDelta !== null
    && relativeDelta >= rule.relativeThreshold;
  return absoluteChanged || relativeChanged;
}

/**
 * Compare only configured, reviewed business fields from a successful V3 snapshot.
 * Failure never reaches the diff path, and a change event exists only after the
 * deterministic threshold gate is satisfied.
 */
export function evaluateMonitoringCapturePair(input: {
  previous: MonitoringEvidenceSnapshot | null;
  capture: MonitoringCaptureOutcome;
  policy: MonitoringPolicy;
}): MonitoringComparisonResult {
  if (input.capture.status !== "CAPTURED") {
    return {
      status: "RUN_FAILED",
      errorCode: input.capture.errorCode,
      diffs: [],
      changeEvent: null,
    };
  }

  const current = input.capture.snapshot;
  if (!snapshotIsWellBound(current)) return notComparable("current_evidence_reference_invalid");
  if (input.previous === null) {
    return { status: "BASELINE_ESTABLISHED", diffs: [], changeEvent: null };
  }
  if (!pairIsComparable(input.previous, current)) {
    return notComparable("evidence_identity_provenance_status_or_order_mismatch");
  }

  const enabledRules = input.policy.rules.filter((rule) => rule.enabled);
  const profile = FIELD_PROFILES[current.evidence.module];
  if (enabledRules.length === 0 || !profile) return notComparable("no_reviewed_enabled_field_profile");
  if (enabledRules.some((rule) => !(rule.field in profile) || !isValidRule(rule))) {
    return notComparable("policy_field_or_threshold_invalid");
  }
  if (new Set(enabledRules.map((rule) => rule.field)).size !== enabledRules.length) {
    return notComparable("policy_field_duplicate");
  }

  const diffs: MonitoringFieldDiff[] = [];
  const uncomparable: MonitoringUncomparableField[] = [];
  for (const rule of enabledRules) {
    const beforeExtraction = extractMonitoringField(input.previous.evidence, rule.field);
    const afterExtraction = extractMonitoringField(current.evidence, rule.field);
    if (!afterExtraction.ok) {
      uncomparable.push({ field: rule.field, reason: afterExtraction.reason, detail: afterExtraction.detail });
      continue;
    }
    if (!beforeExtraction.ok) {
      uncomparable.push({
        field: rule.field,
        reason: `baseline_${beforeExtraction.reason}`,
        detail: beforeExtraction.detail,
      });
      continue;
    }
    const before = beforeExtraction.metric.value;
    const after = afterExtraction.metric.value;
    if (beforeExtraction.metric.unit !== afterExtraction.metric.unit) {
      uncomparable.push({
        field: rule.field,
        reason: "unit_mismatch",
        detail: `${beforeExtraction.metric.unit}->${afterExtraction.metric.unit}`,
      });
      continue;
    }
    if (before === after) continue;

    const delta = normalizeDelta(after - before);
    const relativeDelta = before === 0 ? null : normalizeDelta(Math.abs(delta) / Math.abs(before));
    diffs.push({
      field: rule.field,
      comparison: rule.comparison,
      before,
      after,
      delta,
      relativeDelta,
      unit: beforeExtraction.metric.unit,
      absoluteThreshold: rule.absoluteThreshold,
      relativeThreshold: rule.relativeThreshold,
      source: current.sourceType,
      metricNature: current.evidence.metricNature,
      previousEvidenceRef: input.previous.evidenceRef,
      currentEvidenceRef: current.evidenceRef,
    });
  }

  if (diffs.length === 0 && uncomparable.length === enabledRules.length) {
    return {
      status: "NOT_COMPARABLE",
      reason: `all_enabled_fields_not_comparable:${uncomparable.map((item) => `${item.field}:${item.reason}`).join(",")}`,
      diffs: [],
      uncomparable,
      changeEvent: null,
    };
  }

  const meaningfulDiffs = diffs.filter((diff) => {
    const rule = enabledRules.find((item) => item.field === diff.field);
    return rule ? ruleIsMeaningful(rule, diff.delta, diff.relativeDelta) : false;
  });
  if (meaningfulDiffs.length === 0) {
    return { status: "NO_MEANINGFUL_CHANGE", diffDetected: diffs.length > 0, diffs, uncomparable, changeEvent: null };
  }

  const changeEvent = {
    subjectKey: current.evidence.subjectKey,
    module: current.evidence.module,
    detectedAt: current.evidence.capturedAt,
    evidenceRefs: [input.previous.evidenceRef, current.evidenceRef] as [MonitoringEvidenceReference, MonitoringEvidenceReference],
    diffs: meaningfulDiffs,
  };
  return {
    status: "CHANGE_DETECTED",
    diffDetected: true,
    diffs: meaningfulDiffs,
    uncomparable,
    changeEvent,
  };
}
