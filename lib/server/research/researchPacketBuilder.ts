import "server-only";

import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import type { ResearchInputBundle } from "@/lib/sourceLayer/v2/contracts";
import type {
  EconomicAssumptionsInput,
  ResearchFactSnapshot,
  ResearchEvidenceRef,
} from "@/lib/research/researchContracts";
import { evaluateDeterministicRiskGates } from "./riskGateEvaluator";
import { calculateUnitEconomics } from "./unitEconomicsCalculator";
import { canonicalJson, hashJson } from "@/lib/server/v5CanonicalHash";

export const V5_RESEARCH_PACKET_SCHEMA = "v5-research-packet.v1" as const;

export type V5ResearchPacket = {
  readonly schemaVersion: typeof V5_RESEARCH_PACKET_SCHEMA;
  readonly subjectKey: string;
  readonly asin: string;
  readonly marketplace: string;
  readonly taskId: string;
  readonly revision: number;
  readonly generatedAt: string;
  readonly factHash: string;
  readonly evidenceHash: string;
  readonly packetHash: string;
  readonly economics: {
    readonly price: { amount: number; currency: string } | null;
    readonly currency: string | null;
    readonly fbaFee: { amount: number; currency: string } | null;
    readonly landedCost: number | null;
    readonly netProfit: { amount: number; currency: string } | null;
    readonly breakEvenPrice: { amount: number; currency: string } | null;
    readonly stressMargin: number | null;
    readonly metricNatureByField: Readonly<Record<string, string>>;
  };
  readonly riskGate: "PASSED" | "WARNING" | "BLOCKED" | "UNAVAILABLE";
  readonly riskCoverage: {
    readonly ruleCount: number;
    readonly computableCount: number;
    readonly unavailableCount: number;
    readonly unavailableRuleIds: readonly string[];
  };
  readonly evidenceSufficiency: {
    readonly status: "READY_EXISTING_DATA" | "READY_NEEDS_ADAPTER" | "BLOCKED_MISSING_INPUT";
    readonly evidenceRefCount: number;
    readonly evidenceKinds: Readonly<Record<string, number>>;
    readonly missingFields: readonly string[];
    readonly conflicts: readonly string[];
    readonly identityBinding: "BOUND" | "UNCONFIRMED";
    readonly latestCapturedAt: string | null;
    readonly ageDays: number | null;
    readonly fieldReadiness: Readonly<Record<string, "READY_EXISTING_DATA" | "READY_NEEDS_ADAPTER" | "BLOCKED_MISSING_INPUT" | "DEFERRED">>;
  };
  readonly vocSummary: {
    readonly status: "BLOCKED_MISSING_INPUT";
    readonly reason: "NO_VERSIONED_PAIN_POINT_CLASSIFICATION";
    readonly observationCount: number;
    readonly omittedCount: number;
    readonly sourceCounts: Readonly<Record<string, number>>;
    readonly identityMatchCounts: Readonly<Record<string, number>>;
  };
  readonly keywordSummary: {
    readonly status: "READY_EXISTING_DATA" | "BLOCKED_MISSING_INPUT";
    readonly metricNature: "estimate";
    readonly items: readonly {
      readonly keyword: string;
      readonly monthlySearches: number | null;
      readonly sourceRef: string;
      readonly evidenceRef: string;
    }[];
  };
  readonly assumptions: {
    readonly economicAssumptions: EconomicAssumptionsInput | null;
    readonly metricNatureByField: Readonly<Record<string, string>>;
  };
  readonly evidenceRefs: readonly {
    readonly refId: string;
    readonly kind: string;
    readonly contentHash: string;
    readonly capturedAt: string;
  }[];
  readonly missingFields: readonly string[];
  readonly packetStatus: "READY_EXISTING_DATA" | "READY_NEEDS_ADAPTER" | "BLOCKED_MISSING_INPUT";
};

export class ResearchPacketBuildError extends Error {
  constructor(
    public readonly code:
      | "PACKET_IDENTITY_MISSING"
      | "PACKET_IDENTITY_MISMATCH"
      | "PACKET_PRODUCT_FACT_MISMATCH"
      | "PACKET_PRIMARY_EVIDENCE_REF_MISSING"
      | "PACKET_EVIDENCE_REF_INVALID"
      | "PACKET_REVISION_INVALID"
      | "PACKET_GENERATED_AT_INVALID",
  ) {
    super(code);
    this.name = "ResearchPacketBuildError";
  }
}

export function serializeResearchPacketJson(value: unknown): string {
  return canonicalJson(value);
}

function countBy<T extends string>(values: readonly T[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function canonicalBundleRefs(bundle: ResearchInputBundle, subjectKey: string) {
  const refs = new Map<string, ResearchInputBundle["sourceEvidenceRefs"][number]>();
  for (const ref of bundle.sourceEvidenceRefs) {
    if (!ref.refId.trim() || ref.subjectKey !== subjectKey || !/^[a-f0-9]{64}$/i.test(ref.contentHash)) {
      throw new ResearchPacketBuildError("PACKET_EVIDENCE_REF_INVALID");
    }
    const prior = refs.get(ref.refId);
    if (prior && (prior.contentHash !== ref.contentHash || prior.kind !== ref.kind)) {
      throw new ResearchPacketBuildError("PACKET_EVIDENCE_REF_INVALID");
    }
    refs.set(ref.refId, ref);
  }
  return [...refs.values()].sort((a, b) => a.refId.localeCompare(b.refId));
}

function availableFactNature(field: { metricNature?: string } | undefined): string {
  return field?.metricNature ?? "unknown";
}

function asAmount(value: { amount: number; currency: string } | null | undefined) {
  return value ? { amount: value.amount, currency: value.currency } : null;
}

/** Build a deterministic packet only from an already-authoritative ProductFact/ResearchInputBundle snapshot. */
export function buildV5ResearchPacket(input: {
  readonly productFact: ProductFact;
  readonly facts: ResearchFactSnapshot;
  readonly researchInputBundle: ResearchInputBundle;
  readonly taskId: string;
  readonly revision: number;
  readonly marketplace: string;
  readonly generatedAt: string;
  readonly economicAssumptions?: EconomicAssumptionsInput | null;
}): V5ResearchPacket {
  const { productFact, facts, researchInputBundle: bundle } = input;
  const asin = productFact.basic.asin.value?.trim();
  const marketplace = input.marketplace.trim();
  if (!productFact.subjectKey.trim() || !asin || !marketplace || !input.taskId.trim()) {
    throw new ResearchPacketBuildError("PACKET_IDENTITY_MISSING");
  }
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    throw new ResearchPacketBuildError("PACKET_REVISION_INVALID");
  }
  if (Number.isNaN(Date.parse(input.generatedAt))) {
    throw new ResearchPacketBuildError("PACKET_GENERATED_AT_INVALID");
  }
  if (bundle.taskId !== input.taskId || bundle.subjectKey !== productFact.subjectKey) {
    throw new ResearchPacketBuildError("PACKET_IDENTITY_MISMATCH");
  }
  if (!bundle.productFact || hashJson(bundle.productFact) !== hashJson(productFact)) {
    throw new ResearchPacketBuildError("PACKET_PRODUCT_FACT_MISMATCH");
  }
  if (facts.basic.asin.value && facts.basic.asin.value !== asin) {
    throw new ResearchPacketBuildError("PACKET_IDENTITY_MISMATCH");
  }
  if (hashJson(facts.basic.price.value) !== hashJson(productFact.basic.price.value)
    || hashJson(facts.profit.fbaFee.value) !== hashJson(productFact.profit.fbaFee.value)) {
    throw new ResearchPacketBuildError("PACKET_PRODUCT_FACT_MISMATCH");
  }
  const binding = productFact.sourceProof.entityBinding;
  if (binding?.bound === false
    || (binding?.expectedMarketplace && binding.expectedMarketplace !== marketplace)
    || (binding?.observedMarketplace && binding.observedMarketplace !== marketplace)) {
    throw new ResearchPacketBuildError("PACKET_IDENTITY_MISMATCH");
  }

  const refs = canonicalBundleRefs(bundle, productFact.subjectKey);
  const primaryEvidenceRef = refs.find((ref) => ref.kind === "product_evidence"
    && ref.evidenceId === productFact.sourceProof.evidenceId
    && ref.captureId === productFact.sourceProof.captureId
    && ref.contentHash === productFact.sourceProof.contentHash);
  if (!primaryEvidenceRef) throw new ResearchPacketBuildError("PACKET_PRIMARY_EVIDENCE_REF_MISSING");

  const factHash = hashJson(productFact);
  const evidenceHash = hashJson(refs.map(({ refId, kind, evidenceId, captureId, version, contentHash }) => ({
    refId, kind, evidenceId, captureId, version, contentHash,
  })));
  const assumptions = input.economicAssumptions ?? null;
  const unitEconomics = calculateUnitEconomics({ facts, assumptions });
  const risk = evaluateDeterministicRiskGates({ facts, unitEconomics });
  const computableRules = risk.rules.filter((rule) => rule.status !== "not_computable");
  const unavailableRules = risk.rules.filter((rule) => rule.status === "not_computable");
  const riskGate: V5ResearchPacket["riskGate"] = computableRules.length === 0
    ? "UNAVAILABLE"
    : risk.status === "blocked" ? "BLOCKED"
      : risk.status === "warning" || unavailableRules.length > 0 ? "WARNING" : "PASSED";

  const nature = {
    price: availableFactNature(productFact.basic.price),
    fbaFee: availableFactNature(productFact.profit.fbaFee),
    landedCost: unitEconomics.costBreakdown ? "derived" : "unknown",
    netProfit: unitEconomics.netProfit.status === "available" ? "derived" : "unknown",
    breakEvenPrice: unitEconomics.breakEvenPrice.status === "available" ? "derived" : "unknown",
    stressMargin: unitEconomics.stressMargin?.status === "available" ? "derived" : "unknown",
  };

  const voiceGroups = bundle.customerVoiceEvidence ?? [];
  const voiceObservations = voiceGroups.flatMap((group) => group.observations);
  const identityBinding: V5ResearchPacket["evidenceSufficiency"]["identityBinding"] = binding?.bound === true ? "BOUND" : "UNCONFIRMED";
  const missingFields = [...new Set(bundle.missingFields)].sort();
  const conflicts = [...new Set(bundle.conflicts)].sort();
  const evidenceSufficiencyStatus: V5ResearchPacket["evidenceSufficiency"]["status"] = conflicts.length > 0 || refs.length === 0
    ? "BLOCKED_MISSING_INPUT"
    : identityBinding === "UNCONFIRMED" ? "READY_NEEDS_ADAPTER" : "READY_EXISTING_DATA";
  const keywordItems = (productFact.keywordEvidence?.topKeywords.value ?? [])
    .filter((item) => item.metricNature === "estimate"
      && item.evidenceRef !== null
      && refs.some((ref) => ref.refId === item.evidenceRef))
    .map((item) => ({
      keyword: item.keyword,
      monthlySearches: item.monthlySearches,
      sourceRef: item.sourceRef,
      evidenceRef: item.evidenceRef as string,
    }))
    .sort((a, b) => a.keyword.localeCompare(b.keyword));
  const fieldReadiness = {
    identity: identityBinding === "BOUND" ? "READY_EXISTING_DATA" as const : "READY_NEEDS_ADAPTER" as const,
    factHash: "READY_EXISTING_DATA" as const,
    evidenceHash: "READY_EXISTING_DATA" as const,
    packetHash: "READY_NEEDS_ADAPTER" as const,
    price: productFact.basic.price.status === "present" ? "READY_EXISTING_DATA" as const : "BLOCKED_MISSING_INPUT" as const,
    fbaFee: productFact.profit.fbaFee.status === "present" ? "READY_EXISTING_DATA" as const : "BLOCKED_MISSING_INPUT" as const,
    landedCost: unitEconomics.costBreakdown ? "READY_EXISTING_DATA" as const : "BLOCKED_MISSING_INPUT" as const,
    netProfit: unitEconomics.netProfit.status === "available" ? "READY_EXISTING_DATA" as const : "BLOCKED_MISSING_INPUT" as const,
    breakEvenPrice: unitEconomics.breakEvenPrice.status === "available" ? "READY_EXISTING_DATA" as const : "BLOCKED_MISSING_INPUT" as const,
    stressMargin: unitEconomics.stressMargin?.status === "available" ? "READY_EXISTING_DATA" as const : "BLOCKED_MISSING_INPUT" as const,
    riskGate: computableRules.length > 0 ? "READY_EXISTING_DATA" as const : "BLOCKED_MISSING_INPUT" as const,
    evidenceSufficiency: evidenceSufficiencyStatus,
    vocSummary: "BLOCKED_MISSING_INPUT" as const,
    keywordSummary: keywordItems.length > 0 ? "READY_EXISTING_DATA" as const : "BLOCKED_MISSING_INPUT" as const,
    assumptions: assumptions ? "READY_EXISTING_DATA" as const : "BLOCKED_MISSING_INPUT" as const,
    evidenceRefs: primaryEvidenceRef ? "READY_EXISTING_DATA" as const : "BLOCKED_MISSING_INPUT" as const,
    generatedAt: "READY_EXISTING_DATA" as const,
    schemaVersion: "READY_EXISTING_DATA" as const,
  };

  const evidenceRefs = refs.map((ref) => ({
    refId: ref.refId,
    kind: ref.kind,
    contentHash: ref.contentHash,
    capturedAt: ref.capturedAt,
  }));
  const packetWithoutHash = {
    schemaVersion: V5_RESEARCH_PACKET_SCHEMA,
    subjectKey: productFact.subjectKey,
    asin,
    marketplace,
    taskId: input.taskId,
    revision: input.revision,
    generatedAt: new Date(input.generatedAt).toISOString(),
    factHash,
    evidenceHash,
    economics: {
      price: asAmount(productFact.basic.price.value),
      currency: productFact.basic.price.value?.currency ?? null,
      fbaFee: asAmount(productFact.profit.fbaFee.value),
      landedCost: unitEconomics.costBreakdown?.landedCostUsd ?? null,
      netProfit: asAmount(unitEconomics.netProfit.value),
      breakEvenPrice: asAmount(unitEconomics.breakEvenPrice.value),
      stressMargin: unitEconomics.stressMargin?.value ?? null,
      metricNatureByField: nature,
    },
    riskGate,
    riskCoverage: {
      ruleCount: risk.rules.length,
      computableCount: computableRules.length,
      unavailableCount: unavailableRules.length,
      unavailableRuleIds: unavailableRules.map((rule) => rule.ruleId).sort(),
    },
    evidenceSufficiency: {
      status: evidenceSufficiencyStatus,
      evidenceRefCount: refs.length,
      evidenceKinds: countBy(refs.map((ref) => ref.kind)),
      missingFields,
      conflicts,
      identityBinding,
      latestCapturedAt: bundle.freshness.latestCapturedAt,
      ageDays: bundle.freshness.ageDays,
      fieldReadiness,
    },
    vocSummary: {
      status: "BLOCKED_MISSING_INPUT" as const,
      reason: "NO_VERSIONED_PAIN_POINT_CLASSIFICATION" as const,
      observationCount: voiceObservations.length,
      omittedCount: voiceGroups.reduce((count, group) => count + group.omittedCount, 0),
      sourceCounts: countBy(voiceGroups.map((group) => group.source)),
      identityMatchCounts: countBy(voiceObservations.map((item) => item.identityMatch)),
    },
    keywordSummary: {
      status: keywordItems.length > 0 ? "READY_EXISTING_DATA" as const : "BLOCKED_MISSING_INPUT" as const,
      metricNature: "estimate" as const,
      items: keywordItems,
    },
    assumptions: {
      economicAssumptions: assumptions,
      metricNatureByField: nature,
    },
    evidenceRefs,
    missingFields,
    packetStatus: evidenceSufficiencyStatus,
  };

  // Hash binds the versioned identity, fact/evidence digests, and normalized payload;
  // generatedAt is retained for display but intentionally excluded from identity.
  const {
    generatedAt: _generatedAt,
    factHash: _factHash,
    evidenceHash: _evidenceHash,
    ...hashPayload
  } = packetWithoutHash;
  const packetHash = hashJson({
    schemaVersion: packetWithoutHash.schemaVersion,
    subjectKey: packetWithoutHash.subjectKey,
    asin: packetWithoutHash.asin,
    marketplace: packetWithoutHash.marketplace,
    taskId: packetWithoutHash.taskId,
    revision: packetWithoutHash.revision,
    factHash,
    evidenceHash,
    payload: hashPayload,
  });
  return { ...packetWithoutHash, packetHash };
}
