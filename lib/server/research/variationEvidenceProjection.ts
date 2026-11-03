import "server-only";

import type { ResearchEvidenceRef } from "@/lib/research/researchContracts";
import type { SourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import { parseV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";

export type VariationEvidenceOutcome =
  | "complete"
  | "partial"
  | "no_variation_with_evidence"
  | "human_required"
  | "retryable_failure"
  | "missing"
  | "unknown"
  | "identity_conflict"
  | "status_conflict";

export type VariationEvidenceCompleteness = "complete" | "partial" | "none" | "unavailable";

export type VariationEvidenceRelation = {
  readonly fromAsin: string;
  readonly toAsin: string;
  readonly relation: "parent" | "child" | "peer";
  /** The capture that directly observed this specific relationship. */
  readonly evidenceRefs: readonly ResearchEvidenceRef[];
};

export type VariationEvidenceMember = {
  readonly asin: string;
  readonly options: readonly {
    readonly dimensionKey: string;
    readonly label: string | null;
    readonly value: string;
  }[];
  readonly evidenceRefs: readonly ResearchEvidenceRef[];
};

/**
 * Read-only projection of the latest Variation module attachment for one
 * research subject. Relationships are emitted only from identity-bound,
 * successful captures; failures retain provenance but expose no family edges.
 */
export type VariationEvidenceProjection = {
  readonly schemaVersion: "variation-evidence-projection.v1";
  readonly subjectKey: string;
  readonly subjectAsin: string;
  readonly outcome: VariationEvidenceOutcome;
  readonly completeness: VariationEvidenceCompleteness;
  readonly parentAsin: string | null;
  readonly memberAsins: readonly string[];
  readonly members: readonly VariationEvidenceMember[];
  readonly relations: readonly VariationEvidenceRelation[];
  readonly evidenceRefs: readonly ResearchEvidenceRef[];
  readonly limitation: string | null;
};

type NormalizedVariation = {
  readonly outcome: Exclude<VariationEvidenceOutcome,
    "missing" | "unknown" | "identity_conflict" | "status_conflict">;
  readonly completeness: VariationEvidenceCompleteness;
  readonly subjectAsin: string;
  readonly parentAsin: string | null;
  readonly memberAsins: readonly string[];
  readonly members: readonly VariationEvidenceMember[];
  readonly evidenceRef: ResearchEvidenceRef;
  readonly limitation: string | null;
};

const ASIN_PATTERN = /^[A-Z0-9]{10}$/u;
const SUBJECT_PATTERN = /^amazon:([A-Z]{2}):([A-Z0-9]{10})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAsin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const asin = value.trim().toUpperCase();
  return ASIN_PATTERN.test(asin) ? asin : null;
}

function referenceFor(attachment: SourceEvidenceAttachment, subjectKey: string): ResearchEvidenceRef | null {
  if (!attachment.attachmentId.trim() || !SHA256_PATTERN.test(attachment.contentHash)) return null;
  if (!Number.isFinite(Date.parse(attachment.capturedAt))) return null;
  return {
    refId: `attachment:${attachment.attachmentId}`,
    source: "amazon_dom",
    captureId: attachment.attachmentId,
    evidenceId: attachment.attachmentId,
    subjectKey,
    capturedAt: new Date(attachment.capturedAt).toISOString(),
    contentHash: attachment.contentHash,
    sourceUrl: attachment.sourceUrl,
  };
}

function dataStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const item of value) {
    const asin = normalizeAsin(item);
    if (!asin) return null;
    if (result.includes(asin)) return null;
    result.push(asin);
  }
  return result;
}

function readMembers(value: unknown, memberAsins: readonly string[]): VariationEvidenceMember[] | null {
  if (!Array.isArray(value)) return null;
  const optionsByAsin = new Map<string, VariationEvidenceMember["options"]>();
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const asin = normalizeAsin(entry.asin);
    if (!asin || !Array.isArray(entry.options)) return null;
    if (optionsByAsin.has(asin)) return null;
    const options: VariationEvidenceMember["options"][number][] = [];
    for (const option of entry.options) {
      if (!isRecord(option)
        || typeof option.dimensionKey !== "string" || !option.dimensionKey.trim()
        || typeof option.value !== "string" || !option.value.trim()
        || !(option.label === null || typeof option.label === "string")) {
        return null;
      }
      options.push({
        dimensionKey: option.dimensionKey.trim(),
        label: typeof option.label === "string" ? option.label.trim() || null : null,
        value: option.value.trim(),
      });
    }
    optionsByAsin.set(asin, options);
  }
  if (optionsByAsin.size !== memberAsins.length || memberAsins.some((asin) => !optionsByAsin.has(asin))) return null;
  return memberAsins.map((asin) => ({ asin, options: optionsByAsin.get(asin) ?? [], evidenceRefs: [] }));
}

function limitationFrom(payload: Record<string, unknown>): string | null {
  const limitations = Array.isArray(payload.limitations) ? payload.limitations : [];
  return limitations.find((item): item is string => typeof item === "string" && item.trim().length > 0)?.trim() ?? null;
}

function outcomeForEvidence(
  attachment: SourceEvidenceAttachment,
  expectedSubjectKey: string,
): { kind: "identity_conflict" | "status_conflict" | "unknown" } | { kind: "valid"; value: NormalizedVariation } {
  const expected = SUBJECT_PATTERN.exec(expectedSubjectKey);
  if (!expected) return { kind: "identity_conflict" };
  const expectedMarketplace = expected[1];
  const expectedAsin = expected[2];
  if (attachment.kind !== "v3_variation_v1" || attachment.subjectKey !== expectedSubjectKey) {
    return { kind: "identity_conflict" };
  }
  const parsed = parseV3ModuleEvidence(attachment.payload);
  const evidenceRef = referenceFor(attachment, expectedSubjectKey);
  if (!parsed || !evidenceRef || parsed.module !== "variation") return { kind: "status_conflict" };
  if (parsed.subjectKey !== expectedSubjectKey
    || parsed.marketplace !== expectedMarketplace
    || normalizeAsin(parsed.identity.asin) !== expectedAsin) {
    return { kind: "identity_conflict" };
  }
  if (new Date(parsed.capturedAt).toISOString() !== evidenceRef.capturedAt) return { kind: "status_conflict" };

  const data = parsed.data;
  const currentAsin = normalizeAsin(data.currentAsin);
  const parentFromData = data.parentAsin === null ? null : normalizeAsin(data.parentAsin);
  const parentFromIdentity = parsed.identity.parentAsin === null || parsed.identity.parentAsin === undefined
    ? null
    : normalizeAsin(parsed.identity.parentAsin);
  if (currentAsin !== expectedAsin || parentFromData === null && data.parentAsin !== null
    || parentFromIdentity === null && parsed.identity.parentAsin != null
    || parentFromData !== parentFromIdentity) {
    return { kind: "identity_conflict" };
  }

  const outcome = typeof data.outcome === "string" ? data.outcome : null;
  const variationStatus = typeof data.variationStatus === "string" ? data.variationStatus : null;
  const error = isRecord(data.error) ? data.error : null;
  const limitation = limitationFrom(parsed as unknown as Record<string, unknown>);
  const retryable = error?.retryable === true;
  const knownOutcomes = new Set([
    "COMPLETE",
    "CAPTURED_PARTIAL",
    "NO_DATA_WITH_EVIDENCE",
    "FAILED_HUMAN",
    "FAILED_RETRYABLE",
  ]);
  if (!outcome || !knownOutcomes.has(outcome)) return { kind: "unknown" };

  if (outcome === "FAILED_HUMAN") {
    if (parsed.status !== "HUMAN_ACTION_REQUIRED" || error?.retryable !== false
      || typeof error.code !== "string" || !error.code.trim()
      || (variationStatus !== null && variationStatus !== "HUMAN_REQUIRED")) {
      return { kind: "status_conflict" };
    }
    return { kind: "valid", value: {
      outcome: "human_required", completeness: "unavailable", subjectAsin: expectedAsin,
      parentAsin: null, memberAsins: [], members: [], evidenceRef, limitation,
    } };
  }
  if (outcome === "FAILED_RETRYABLE") {
    if (parsed.status !== "BLOCKED_WITH_EVIDENCE" || !retryable
      || typeof error?.code !== "string" || !error.code.trim()) return { kind: "status_conflict" };
    return { kind: "valid", value: {
      outcome: "retryable_failure", completeness: "unavailable", subjectAsin: expectedAsin,
      parentAsin: null, memberAsins: [], members: [], evidenceRef, limitation,
    } };
  }

  const memberAsins = dataStrings(data.variantAsins);
  const parentAsin = parentFromData;
  const identityProof = isRecord(data.identityProof) ? data.identityProof : null;
  const identityBound = identityProof?.bound === true
    && normalizeAsin(identityProof.urlAsin) === expectedAsin
    && normalizeAsin(identityProof.pageAsin) === expectedAsin
    && identityProof.productContainerFound === true;
  if ((outcome === "COMPLETE" || outcome === "CAPTURED_PARTIAL" || outcome === "NO_DATA_WITH_EVIDENCE")
    && !identityBound) return { kind: "identity_conflict" };
  const members = memberAsins ? readMembers(data.variants, memberAsins) : null;
  const successfulEnvelope = parsed.metricNature === "source_observed"
    && parsed.evidenceOnly
    && parsed.acquisitionMode === "DOM_DIRECT"
    && parsed.provider === "Amazon"
    && typeof parsed.sourceUrl === "string"
    && parsed.sourceUrl === attachment.sourceUrl
    && /^https:\/\/(?:www\.)?amazon\.com\//iu.test(parsed.sourceUrl)
    && memberAsins !== null
    && memberAsins.includes(expectedAsin)
    && members !== null
    && Object.prototype.hasOwnProperty.call(data, "error")
    && data.error === null;

  if (!successfulEnvelope) return { kind: "status_conflict" };

  if (outcome === "COMPLETE") {
    if (variationStatus !== "COMPLETE" || parsed.status !== "VALIDATED_AVAILABLE"
      || !parentAsin || memberAsins.length < 2 || !limitationIsEmpty(parsed)) {
      return { kind: "status_conflict" };
    }
    return { kind: "valid", value: {
      outcome: "complete", completeness: "complete", subjectAsin: expectedAsin,
      parentAsin, memberAsins, members, evidenceRef, limitation: null,
    } };
  }
  if (outcome === "CAPTURED_PARTIAL") {
    if (variationStatus !== "CAPTURED_PARTIAL" || parsed.status !== "AVAILABLE_WITH_LIMITATION"
      || !parsed.limitations.includes("variation_mapping_incomplete")) {
      return { kind: "status_conflict" };
    }
    return { kind: "valid", value: {
      outcome: "partial", completeness: "partial", subjectAsin: expectedAsin,
      parentAsin, memberAsins, members, evidenceRef, limitation,
    } };
  }
  if (outcome === "NO_DATA_WITH_EVIDENCE") {
    if (variationStatus !== "NO_VARIATION_WITH_EVIDENCE" || parsed.status !== "AVAILABLE_WITH_LIMITATION"
      || !parsed.limitations.includes("no_variation_with_evidence") || memberAsins.length !== 1) {
      return { kind: "status_conflict" };
    }
    return { kind: "valid", value: {
      outcome: "no_variation_with_evidence", completeness: "none", subjectAsin: expectedAsin,
      parentAsin: null, memberAsins, members, evidenceRef, limitation,
    } };
  }
  return { kind: "status_conflict" };
}

function limitationIsEmpty(evidence: { limitations: readonly string[] }): boolean {
  return evidence.limitations.length === 0;
}

function buildRelations(value: NormalizedVariation): VariationEvidenceRelation[] {
  const evidenceRefs = [value.evidenceRef];
  const relations: VariationEvidenceRelation[] = [];
  const { subjectAsin, parentAsin } = value;
  if (parentAsin && parentAsin !== subjectAsin) {
    relations.push({ fromAsin: subjectAsin, toAsin: parentAsin, relation: "parent", evidenceRefs });
  }
  if (parentAsin === subjectAsin) {
    for (const childAsin of value.memberAsins) {
      if (childAsin === subjectAsin) continue;
      relations.push({ fromAsin: subjectAsin, toAsin: childAsin, relation: "child", evidenceRefs });
    }
  } else if (parentAsin) {
    for (const peerAsin of value.memberAsins) {
      if (peerAsin === subjectAsin || peerAsin === parentAsin) continue;
      relations.push({ fromAsin: subjectAsin, toAsin: peerAsin, relation: "peer", evidenceRefs });
    }
  }
  return relations;
}

function emptyProjection(
  subjectKey: string,
  subjectAsin: string,
  outcome: Extract<VariationEvidenceOutcome, "missing" | "unknown" | "identity_conflict" | "status_conflict">,
  evidenceRefs: readonly ResearchEvidenceRef[] = [],
  limitation: string | null = null,
): VariationEvidenceProjection {
  return {
    schemaVersion: "variation-evidence-projection.v1",
    subjectKey,
    subjectAsin,
    outcome,
    completeness: "unavailable",
    parentAsin: null,
    memberAsins: [],
    members: [],
    relations: [],
    evidenceRefs,
    limitation,
  };
}

/**
 * Projects only the newest Variation attachment so a newer failure, unknown
 * outcome, or identity conflict cannot be masked by an older successful capture.
 */
export function projectVariationEvidence(
  attachments: readonly SourceEvidenceAttachment[],
  expectedSubjectKey: string,
): VariationEvidenceProjection {
  const expected = SUBJECT_PATTERN.exec(expectedSubjectKey);
  if (!expected) return emptyProjection(expectedSubjectKey, "", "identity_conflict");
  const subjectAsin = expected[2]!;
  const candidates = attachments.filter((attachment) => attachment.kind === "v3_variation_v1");
  if (candidates.length === 0) return emptyProjection(expectedSubjectKey, subjectAsin, "missing");
  if (candidates.some((attachment) => !Number.isFinite(Date.parse(attachment.capturedAt)))) {
    return emptyProjection(expectedSubjectKey, subjectAsin, "status_conflict");
  }
  const ordered = [...candidates].sort((left, right) => {
    const timeOrder = Date.parse(right.capturedAt) - Date.parse(left.capturedAt);
    return timeOrder || right.attachmentId.localeCompare(left.attachmentId);
  });
  const latest = ordered[0]!;
  const evidenceRef = referenceFor(latest, expectedSubjectKey);
  const result = outcomeForEvidence(latest, expectedSubjectKey);
  if (result.kind !== "valid") {
    return emptyProjection(expectedSubjectKey, subjectAsin, result.kind, evidenceRef ? [evidenceRef] : []);
  }
  const value = result.value;
  const evidenceRefs = [value.evidenceRef];
  const members = value.members.map((member) => ({ ...member, evidenceRefs }));
  return {
    schemaVersion: "variation-evidence-projection.v1",
    subjectKey: expectedSubjectKey,
    subjectAsin,
    outcome: value.outcome,
    completeness: value.completeness,
    parentAsin: value.parentAsin,
    memberAsins: value.memberAsins,
    members,
    relations: buildRelations(value),
    evidenceRefs,
    limitation: value.limitation,
  };
}
