import { captureContentHashOf, contentHashOf, type CaptureEvidenceRecord } from "@/lib/sourceLayer/sourceAdapter";
import { evaluateFieldExpiration, type CaptureFieldKey } from "@/lib/sourceLayer/expiration";
import type { FactField, FactFieldEvidenceRef, ProductFact } from "@/lib/sourceLayer/fact/types";
import { AMAZON_DETAIL_FIELD_REGISTRY } from "@/tools/collectors/amazon/detail-page-field-registry";

export type AmazonDetailRestorableField = "title" | "price";
export type AmazonDetailPriceContext = "one_time" | "subscribe_save";

export type AmazonDetailFieldOrigin = {
  readonly evidenceId: string;
  readonly captureId: string;
  readonly subjectKey: string;
  readonly version: number;
  readonly contentHash: string;
  readonly capturedAt: string;
  readonly sourceType: "amazon_dom";
  readonly sourceUrl: string;
  readonly marketplace: string;
  readonly asin: string;
  readonly sourceRef: string;
  readonly ruleId: string;
  readonly registryVersion: string;
  readonly resolverVersion: string | null;
  readonly priceContext?: AmazonDetailPriceContext;
};

export type AmazonDetailFieldResolution = {
  readonly field: AmazonDetailRestorableField;
  readonly status: "current" | "restored" | "historical_only" | "missing" | "conflict" | "invalid";
  readonly value: unknown;
  readonly origin: AmazonDetailFieldOrigin | null;
  readonly candidateOrigins: readonly AmazonDetailFieldOrigin[];
  readonly rejected: readonly { evidenceId: string; contentHash: string; reason: string }[];
  readonly reason: string | null;
  readonly decisionHash: string;
};

export type AmazonDetailHistoryProjection = {
  readonly schemaVersion: "amazon-detail-field-history-projection.v1";
  readonly subjectKey: string;
  readonly marketplace: string;
  readonly asin: string;
  readonly injectedNow: string;
  readonly priceContext: AmazonDetailPriceContext | null;
  readonly fields: Readonly<Record<AmazonDetailRestorableField, AmazonDetailFieldResolution>>;
  readonly decisionHash: string;
};

type Input = {
  readonly subjectKey: string;
  readonly marketplace: string;
  readonly asin: string;
  readonly now: string;
  readonly priceContext?: AmazonDetailPriceContext | null;
  readonly currentEvidenceId?: string | null;
  readonly candidates: readonly CaptureEvidenceRecord[];
};

type CandidateResolution = {
  evidence: CaptureEvidenceRecord;
  origin: AmazonDetailFieldOrigin;
  value: unknown;
  capturedMs: number;
  expired: boolean;
};

const HASH = /^[a-f0-9]{64}$/u;
const ASIN = /^[A-Z0-9]{10}$/u;
const TTL_FIELD: Record<AmazonDetailRestorableField, CaptureFieldKey> = { title: "title", price: "price" };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizedAsin(value: unknown): string | null {
  return typeof value === "string" && ASIN.test(value.trim().toUpperCase())
    ? value.trim().toUpperCase()
    : null;
}

function sameValue(a: unknown, b: unknown): boolean {
  return contentHashOf(a) === contentHashOf(b);
}

function sourceUrlBinds(urlValue: string | null, asin: string, marketplace: string): boolean {
  if (!urlValue) return false;
  try {
    const url = new URL(urlValue);
    const host = url.hostname.toLowerCase();
    const marketHosts: Readonly<Record<string, readonly string[]>> = {
      US: ["amazon.com", "www.amazon.com"],
      CA: ["amazon.ca", "www.amazon.ca"],
      UK: ["amazon.co.uk", "www.amazon.co.uk"],
      DE: ["amazon.de", "www.amazon.de"],
    };
    const pathAsin = /^(?:\/[^/]+)?\/dp\/([A-Z0-9]{10})(?:\/|$)/iu.exec(url.pathname)?.[1]?.toUpperCase()
      ?? /^\/gp\/product\/([A-Z0-9]{10})(?:\/|$)/iu.exec(url.pathname)?.[1]?.toUpperCase();
    return url.protocol === "https:" && (marketHosts[marketplace.toUpperCase()] ?? []).includes(host) && pathAsin === asin;
  } catch {
    return false;
  }
}

function canonicalValue(evidence: CaptureEvidenceRecord, field: AmazonDetailRestorableField): unknown {
  return field === "title" ? evidence.pkg.fields.title : evidence.pkg.fields.price;
}

function candidateRecordReason(
  evidence: CaptureEvidenceRecord,
  input: Input,
  nowMs: number,
): string | null {
  if (evidence.sourceType !== "amazon_dom" || evidence.pkg.sourceProof.sourceType !== "amazon_dom") return "source_type_mismatch";
  if (evidence.factAuthority !== "evidence_only") return "fact_authority_mismatch";
  if (evidence.subjectKey !== input.subjectKey || evidence.pkg.subjectKey !== input.subjectKey) return "subject_mismatch";
  if (evidence.pkg.captureId !== evidence.captureId || evidence.pkg.version !== evidence.version) return "record_package_binding_mismatch";
  if (evidence.pkg.marketplace.toUpperCase() !== input.marketplace.toUpperCase()) return "marketplace_mismatch";
  const asin = normalizedAsin(evidence.pkg.fields.asin);
  const binding = evidence.pkg.sourceProof.entityBinding;
  if (!asin || asin !== input.asin || !binding?.bound
    || normalizedAsin(binding.expectedAsin) !== input.asin
    || normalizedAsin(binding.observedAsin) !== input.asin
    || normalizedAsin(binding.urlAsin) !== input.asin
    || binding.expectedMarketplace.toUpperCase() !== input.marketplace.toUpperCase()
    || binding.observedMarketplace?.toUpperCase() !== input.marketplace.toUpperCase()
    || binding.urlMarketplace?.toUpperCase() !== input.marketplace.toUpperCase()
    || evidence.pkg.sourceProof.sourceUrl !== evidence.sourceUrl
    || evidence.pkg.sourceProof.capturedAt !== evidence.capturedAt
    || !sourceUrlBinds(evidence.sourceUrl, input.asin, input.marketplace)) return "entity_binding_mismatch";
  if (evidence.validation.verdict !== "passed" || evidence.validation.readyForResearch !== true) return "evidence_not_research_ready";
  if (!HASH.test(evidence.contentHash) || captureContentHashOf(evidence.pkg) !== evidence.contentHash
    || !Number.isSafeInteger(evidence.version) || evidence.version < 1
    || !evidence.evidenceId.trim() || !evidence.captureId.trim() || !evidence.sourceUrl) return "evidence_proof_incomplete";

  const capturedMs = Date.parse(evidence.capturedAt);
  if (!Number.isFinite(capturedMs)) return "captured_at_invalid";
  if (capturedMs > nowMs) return "captured_at_future";
  return null;
}

function qualifiedCandidate(
  evidence: CaptureEvidenceRecord,
  field: AmazonDetailRestorableField,
  input: Input,
  nowMs: number,
): { candidate?: CandidateResolution; reason?: string } {
  const recordReason = candidateRecordReason(evidence, input, nowMs);
  if (recordReason) return { reason: recordReason };

  const fieldState = evidence.pkg.fieldStates[field];
  const sourceRef = fieldState?.sourceRef;
  const sourceUrl = evidence.sourceUrl;
  const detail = evidence.pkg.extensions?.amazonDetail;
  const registered = detail?.registeredFields[field];
  const trace = record(registered?.sourceTrace);
  if (fieldState?.status === "conflict" || registered?.status === "ambiguous") return { reason: "field_conflict_or_ambiguous" };
  if (!fieldState || fieldState.status !== "confirmed" || fieldState.metricNature !== "snapshot"
    || fieldState.valueOrigin !== "page_measured") return { reason: "field_not_confirmed_snapshot" };
  if (!registered || registered.status !== "observed" || registered.fieldNature !== "DIRECT_FACT"
    || registered.priority === "BLOCKED" || registered.value === null || registered.value === undefined
    || !trace || trace.ruleId !== field || trace.registryVersion !== detail?.fieldRegistryVersion
    || typeof trace.selector !== "string" || !trace.selector.trim()
    || !AMAZON_DETAIL_FIELD_REGISTRY.find((rule) => rule.canonicalField === field)?.selectorCandidates.includes(trace.selector)
    || typeof sourceRef !== "string" || !sourceRef.startsWith("amazon_dom.")
    || typeof sourceUrl !== "string" || !sourceUrl.trim()) return { reason: "field_provenance_incomplete" };
  const value = canonicalValue(evidence, field);
  if (value === null || value === undefined || !sameValue(registered.value, value)) return { reason: "field_value_not_bound_to_canonical_value" };
  if (field === "title" && (typeof value !== "string" || !value.trim() || value.length > 1_200)) return { reason: "field_value_invalid" };

  let priceContext: AmazonDetailPriceContext | undefined;
  if (field === "price") {
    const price = record(value);
    if (!price || typeof price.amount !== "number" || !Number.isFinite(price.amount) || price.amount <= 0
      || typeof price.currency !== "string" || price.currency.toUpperCase() !== "USD") return { reason: "field_value_invalid" };
    if (!input.priceContext || trace.selected !== true || trace.purchaseContext !== input.priceContext
      || trace.semanticRole !== (input.priceContext === "one_time" ? "current_pay_now" : "subscribe_price")) {
      return { reason: "price_purchase_context_unproven" };
    }
    priceContext = input.priceContext;
  }

  const capturedMs = Date.parse(evidence.capturedAt);
  const expiry = evaluateFieldExpiration({ field: TTL_FIELD[field], capturedAt: evidence.capturedAt, present: true, now: nowMs });
  const ttl = expiry.ttlMs;
  const age = nowMs - capturedMs;
  const expired = age > ttl;
  const origin: AmazonDetailFieldOrigin = {
    evidenceId: evidence.evidenceId,
    captureId: evidence.captureId,
    subjectKey: evidence.subjectKey,
    version: evidence.version,
    contentHash: evidence.contentHash,
    capturedAt: evidence.capturedAt,
    sourceType: "amazon_dom",
    sourceUrl,
    marketplace: input.marketplace.toUpperCase(),
    asin: input.asin,
    sourceRef,
    ruleId: String(trace.ruleId),
    registryVersion: detail!.fieldRegistryVersion,
    resolverVersion: typeof detail.resolverVersion === "string" ? detail.resolverVersion : null,
    ...(priceContext ? { priceContext } : {}),
  };
  return { candidate: { evidence, origin, value, capturedMs, expired } };
}

function compareCandidate(a: CandidateResolution, b: CandidateResolution): number {
  return b.capturedMs - a.capturedMs
    || b.evidence.version - a.evidence.version
    || a.evidence.evidenceId.localeCompare(b.evidence.evidenceId)
    || a.evidence.contentHash.localeCompare(b.evidence.contentHash);
}

function resolveField(input: Input, field: AmazonDetailRestorableField, nowMs: number): AmazonDetailFieldResolution {
  const eligible: CandidateResolution[] = [];
  const expiredTitles: CandidateResolution[] = [];
  let expiredPrices = false;
  const rejected: Array<{ evidenceId: string; contentHash: string; reason: string }> = [];
  const sortedEvidence = [...input.candidates].sort((a, b) =>
    a.capturedAt.localeCompare(b.capturedAt) || a.version - b.version || a.evidenceId.localeCompare(b.evidenceId) || a.contentHash.localeCompare(b.contentHash));
  for (const evidence of sortedEvidence) {
    const result = qualifiedCandidate(evidence, field, input, nowMs);
    if (result.candidate?.expired) {
      const reason = field === "title" ? "title_expired" : "price_expired";
      rejected.push({ evidenceId: evidence.evidenceId, contentHash: evidence.contentHash, reason });
      if (field === "title") expiredTitles.push(result.candidate);
      else expiredPrices = true;
    } else if (result.candidate) eligible.push(result.candidate);
    else rejected.push({ evidenceId: evidence.evidenceId, contentHash: evidence.contentHash, reason: result.reason ?? "unqualified" });
  }
  eligible.sort(compareCandidate);
  expiredTitles.sort(compareCandidate);

  const current = eligible.find((candidate) => candidate.evidence.evidenceId === input.currentEvidenceId);
  const currentState = input.candidates.find((candidate) => candidate.evidenceId === input.currentEvidenceId);
  const currentField = currentState?.pkg.extensions?.amazonDetail?.registeredFields[field];
  const currentFieldState = currentState?.pkg.fieldStates[field];
  if (currentState) {
    const currentCaptured = Date.parse(currentState.capturedAt);
    const recordReason = candidateRecordReason(currentState, input, nowMs);
    if (!Number.isFinite(currentCaptured) || recordReason === "captured_at_invalid") {
      rejected.push({ evidenceId: currentState.evidenceId, contentHash: currentState.contentHash, reason: "current_captured_at_invalid" });
      return makeResolution(field, "invalid", null, null, [], rejected, "current_captured_at_invalid");
    }
    if (currentCaptured > nowMs || recordReason === "captured_at_future") {
      rejected.push({ evidenceId: currentState.evidenceId, contentHash: currentState.contentHash, reason: "current_captured_at_future" });
      return makeResolution(field, "invalid", null, null, [], rejected, "current_captured_at_future");
    }
    if (recordReason) {
      rejected.push({ evidenceId: currentState.evidenceId, contentHash: currentState.contentHash, reason: `current_${recordReason}` });
      return makeResolution(field, "invalid", null, null, [], rejected, `current_${recordReason}`);
    }
  }
  if (currentField?.status === "ambiguous" || currentFieldState?.status === "conflict") {
    return makeResolution(field, "conflict", null, null, eligible.map((item) => item.origin), rejected, "current_field_conflict_or_ambiguous");
  }
  if (current && nowMs - current.capturedMs <= evaluateFieldExpiration({ field: TTL_FIELD[field], capturedAt: current.evidence.capturedAt, present: true, now: nowMs }).ttlMs) {
    return makeResolution(field, "current", current.value, current.origin, eligible.map((item) => item.origin), rejected, null);
  }

  if (eligible.length === 0) {
    if (field === "title" && expiredTitles.length > 0) {
      const latestTime = expiredTitles[0]!.capturedMs;
      const tied = expiredTitles.filter((item) => item.capturedMs === latestTime);
      const values = new Map(tied.map((item) => [contentHashOf(item.value), item.value]));
      if (values.size > 1) {
        return makeResolution(field, "conflict", null, null, tied.map((item) => item.origin), rejected, "same_time_different_values");
      }
      const winner = [...tied].sort((a, b) => b.evidence.version - a.evidence.version
        || a.evidence.evidenceId.localeCompare(b.evidence.evidenceId)
        || a.evidence.contentHash.localeCompare(b.evidence.contentHash))[0]!;
      return makeResolution(field, "historical_only", winner.value, winner.origin, expiredTitles.map((item) => item.origin), rejected, "title_expired");
    }
    return makeResolution(field, "missing", null, null, [], rejected, expiredPrices ? "price_expired" : "no_eligible_confirmed_candidate");
  }
  const latestTime = eligible[0]!.capturedMs;
  const tied = eligible.filter((item) => item.capturedMs === latestTime);
  const values = new Map(tied.map((item) => [contentHashOf(item.value), item.value]));
  if (values.size > 1) {
    return makeResolution(field, "conflict", null, null, tied.map((item) => item.origin), rejected, "same_time_different_values");
  }
  const winner = [...tied].sort((a, b) => b.evidence.version - a.evidence.version
    || a.evidence.evidenceId.localeCompare(b.evidence.evidenceId)
    || a.evidence.contentHash.localeCompare(b.evidence.contentHash))[0]!;
  const historicalOrigin = input.currentEvidenceId && winner.evidence.evidenceId === input.currentEvidenceId ? null : winner.origin;
  const latestVersion = Math.max(...eligible.map((item) => item.evidence.version));
  const versionTimeDisagrees = eligible.some((item) => item.evidence.version === latestVersion && item.capturedMs < latestTime);
  return makeResolution(
    field,
    "restored",
    winner.value,
    winner.origin,
    eligible.map((item) => item.origin),
    rejected,
    versionTimeDisagrees ? "selected_by_captured_at_version_order_disagrees" : historicalOrigin ? null : "current_candidate_unavailable",
  );
}

function makeResolution(
  field: AmazonDetailRestorableField,
  status: AmazonDetailFieldResolution["status"],
  value: unknown,
  origin: AmazonDetailFieldOrigin | null,
  candidateOrigins: readonly AmazonDetailFieldOrigin[],
  rejected: readonly { evidenceId: string; contentHash: string; reason: string }[],
  reason: string | null,
): AmazonDetailFieldResolution {
  const orderedOrigins = [...candidateOrigins].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.version - b.version || a.evidenceId.localeCompare(b.evidenceId) || a.contentHash.localeCompare(b.contentHash));
  const orderedRejected = [...rejected].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId) || a.contentHash.localeCompare(b.contentHash) || a.reason.localeCompare(b.reason));
  const decision = { field, status, value, origin, candidateOrigins: orderedOrigins, rejected: orderedRejected, reason };
  return { ...decision, decisionHash: contentHashOf(decision) };
}

/** Deterministic read-only projection. It never mutates Evidence or silently promotes a derived/estimated value. */
export function projectAmazonDetailFieldHistory(input: Input): AmazonDetailHistoryProjection {
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs) || normalizedAsin(input.asin) !== input.asin || !input.marketplace.trim() || !input.subjectKey.trim()) {
    throw new Error("AMAZON_DETAIL_HISTORY_INPUT_INVALID");
  }
  if (input.subjectKey !== `amazon:${input.marketplace.toUpperCase()}:${input.asin}`) throw new Error("AMAZON_DETAIL_HISTORY_INPUT_IDENTITY_MISMATCH");
  const normalized: Input = { ...input, marketplace: input.marketplace.toUpperCase(), priceContext: input.priceContext ?? null };
  const fields = {
    title: resolveField(normalized, "title", nowMs),
    price: resolveField(normalized, "price", nowMs),
  } as const;
  const projection = {
    schemaVersion: "amazon-detail-field-history-projection.v1" as const,
    subjectKey: input.subjectKey,
    marketplace: normalized.marketplace,
    asin: input.asin,
    injectedNow: input.now,
    priceContext: normalized.priceContext ?? null,
    fields,
  };
  return { ...projection, decisionHash: contentHashOf(projection) };
}

/** All immutable candidate origins needed to explain the history decision, deduplicated by evidence identity. */
export function amazonDetailHistoryOriginsOf(productFact: ProductFact): AmazonDetailFieldOrigin[] {
  const projection = productFact.amazonDetailHistory;
  if (!projection) return [];
  const origins = [
    ...projection.fields.title.candidateOrigins,
    ...projection.fields.price.candidateOrigins,
    ...(projection.fields.title.origin ? [projection.fields.title.origin] : []),
    ...(projection.fields.price.origin ? [projection.fields.price.origin] : []),
  ];
  const unique = new Map<string, AmazonDetailFieldOrigin>();
  for (const origin of origins) {
    // The current candidate is already represented by ProductFact.sourceProof.
    if (origin.evidenceId === productFact.sourceProof.evidenceId
      && origin.contentHash === productFact.sourceProof.contentHash) continue;
    unique.set(`${origin.evidenceId}\u0000${origin.contentHash}`, origin);
  }
  return [...unique.values()].sort((a, b) =>
    a.capturedAt.localeCompare(b.capturedAt) || a.evidenceId.localeCompare(b.evidenceId) || a.contentHash.localeCompare(b.contentHash));
}

/** All immutable evidence refs needed to explain the history decision. */
export function amazonDetailHistoryEvidenceRefsOf(productFact: ProductFact): FactFieldEvidenceRef[] {
  return amazonDetailHistoryOriginsOf(productFact).map((origin) => ({
      refId: `evidence:${origin.evidenceId}`,
      source: "amazon_dom",
      captureId: origin.captureId,
      evidenceId: origin.evidenceId,
      subjectKey: productFact.subjectKey,
      capturedAt: origin.capturedAt,
      contentHash: origin.contentHash,
      sourceUrl: origin.sourceUrl,
    }));
}

export function isAmazonDetailHistoryProjection(value: unknown): value is AmazonDetailHistoryProjection {
  const candidate = record(value);
  if (!candidate || candidate.schemaVersion !== "amazon-detail-field-history-projection.v1"
    || typeof candidate.subjectKey !== "string" || typeof candidate.marketplace !== "string"
    || typeof candidate.asin !== "string" || typeof candidate.injectedNow !== "string"
    || typeof candidate.decisionHash !== "string" || !HASH.test(candidate.decisionHash)) return false;
  if (!["one_time", "subscribe_save", null].includes(candidate.priceContext as never)) return false;
  const fields = record(candidate.fields);
  if (!fields || !isFieldResolution(fields.title, "title") || !isFieldResolution(fields.price, "price")) return false;
  const { decisionHash, ...body } = candidate;
  return contentHashOf(body) === decisionHash;
}

function isFieldResolution(value: unknown, field: AmazonDetailRestorableField): value is AmazonDetailFieldResolution {
  const resolution = record(value);
  const statuses: readonly string[] = ["current", "restored", "historical_only", "missing", "conflict", "invalid"];
  return Boolean(resolution
    && resolution.field === field
    && statuses.includes(String(resolution.status))
    && typeof resolution.decisionHash === "string" && HASH.test(resolution.decisionHash)
    && Array.isArray(resolution.candidateOrigins)
    && resolution.candidateOrigins.every(isOrigin)
    && (resolution.origin === null || isOrigin(resolution.origin))
    && Array.isArray(resolution.rejected)
    && resolution.rejected.every((item) => {
      const rejected = record(item);
      return Boolean(rejected && typeof rejected.evidenceId === "string" && typeof rejected.contentHash === "string"
        && HASH.test(rejected.contentHash) && typeof rejected.reason === "string");
    })
    && (resolution.reason === null || typeof resolution.reason === "string"));
}

function isOrigin(value: unknown): value is AmazonDetailFieldOrigin {
  const origin = record(value);
  return Boolean(origin
    && typeof origin.evidenceId === "string" && origin.evidenceId.trim()
    && typeof origin.captureId === "string" && origin.captureId.trim()
    && Number.isSafeInteger(origin.version) && Number(origin.version) > 0
    && typeof origin.contentHash === "string" && HASH.test(origin.contentHash)
    && typeof origin.capturedAt === "string" && Number.isFinite(Date.parse(origin.capturedAt))
    && origin.sourceType === "amazon_dom"
    && typeof origin.sourceUrl === "string" && typeof origin.marketplace === "string"
    && typeof origin.asin === "string" && ASIN.test(origin.asin)
    && typeof origin.subjectKey === "string"
    && typeof origin.sourceRef === "string" && typeof origin.ruleId === "string"
    && typeof origin.registryVersion === "string"
    && (origin.resolverVersion === null || typeof origin.resolverVersion === "string")
    && (origin.priceContext === undefined || origin.priceContext === "one_time" || origin.priceContext === "subscribe_save"));
}

function evidenceRef(origin: AmazonDetailFieldOrigin): FactFieldEvidenceRef {
  return {
    refId: `evidence:${origin.evidenceId}`,
    source: "amazon_dom",
    captureId: origin.captureId,
    evidenceId: origin.evidenceId,
    subjectKey: origin.subjectKey,
    capturedAt: origin.capturedAt,
    contentHash: origin.contentHash,
    sourceUrl: origin.sourceUrl,
  };
}
function currentEvidenceRef(productFact: ProductFact): FactFieldEvidenceRef {
  const proof = productFact.sourceProof;
  return {
    refId: `evidence:${proof.evidenceId}`,
    source: proof.source,
    captureId: proof.captureId,
    evidenceId: proof.evidenceId,
    subjectKey: proof.subjectKey,
    capturedAt: proof.capturedAt,
    contentHash: proof.contentHash,
    sourceUrl: proof.sourceUrl,
  };
}

/** Attach the immutable decision to ProductFact and overlay only safely restored Title/Price values. */
export function attachAmazonDetailFieldHistory(
  productFact: ProductFact,
  projection: AmazonDetailHistoryProjection,
): ProductFact {
  if (!isAmazonDetailHistoryProjection(projection)
    || projection.subjectKey !== productFact.subjectKey
    || projection.subjectKey !== productFact.sourceProof.subjectKey
    || projection.asin !== productFact.basic.asin.value
    || projection.marketplace !== productFact.sourceProof.entityBinding?.expectedMarketplace.toUpperCase()) {
    throw new Error("AMAZON_DETAIL_HISTORY_PRODUCT_FACT_IDENTITY_MISMATCH");
  }
  // Keep the canonical ProductFact byte-for-byte stable when history adds no
  // usable decision. In particular, routine current/missing diagnostics must
  // not invalidate downstream Research snapshots or report fingerprints.
  if (![projection.fields.title, projection.fields.price].some((field) =>
    field.status === "restored" || field.status === "historical_only" || field.status === "conflict")) {
    return productFact;
  }
  const fieldWithDecision = <T>(base: FactField<T>, field: AmazonDetailRestorableField): FactField<T> => {
    const decision = projection.fields[field];
    const refs = decision.status === "restored" && decision.origin
      ? [evidenceRef(decision.origin)]
      : decision.status === "conflict"
        ? [currentEvidenceRef(productFact), ...decision.candidateOrigins.map(evidenceRef)]
        : [currentEvidenceRef(productFact)];
    if (decision.status !== "restored" || !decision.origin) {
      return { ...base, evidenceRefs: refs };
    }
    return {
      ...base,
      value: decision.value as T,
      status: "present" as const,
      metricNature: "snapshot" as const,
      source: "amazon_dom" as const,
      confidence: 1,
      capturedAt: decision.origin.capturedAt,
      rawProofHash: decision.origin.contentHash,
      evidenceRefs: refs,
    };
  };
  return {
    ...productFact,
    amazonDetailHistory: projection,
    basic: {
      ...productFact.basic,
      title: fieldWithDecision(productFact.basic.title, "title"),
      price: fieldWithDecision(productFact.basic.price, "price"),
    },
  };
}
