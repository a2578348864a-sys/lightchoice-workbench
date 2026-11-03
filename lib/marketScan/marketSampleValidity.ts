import { resolveValidMarketProductSet, MARKET_SAMPLE_POLICY_VERSION, type MarketProductCandidate } from "@/lib/marketScan/marketSamplePolicy";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

/** Deterministic identity/proof fields, independent from optional economic coverage. */
export function evaluateMarketSampleValidity(input: {
  asin: unknown; subjectKey: unknown; marketplace: string;
  factValues: unknown; evidenceId: unknown; evidenceVersion: unknown;
  sourceProofHash: unknown; capturedAt: unknown; integrityValid: boolean;
  evidenceStatus?: string; parentAsin?: unknown;
}) {
  const asin = typeof input.asin === "string" ? input.asin.trim().toUpperCase() : "";
  const subject = typeof input.subjectKey === "string" ? input.subjectKey.split(":") : [];
  const facts = record(input.factValues), title = record(facts.title);
  let reason: string | null = null;
  if (!/^[A-Z0-9]{10}$/.test(asin)) reason = "INVALID_ASIN";
  else if (subject.length !== 3 || subject[0] !== "amazon" || subject[2]?.toUpperCase() !== asin || facts.asin !== asin) reason = "SUBJECT_MISMATCH";
  else if (subject[1]?.toUpperCase() !== input.marketplace.toUpperCase()) reason = "MARKETPLACE_MISMATCH";
  else if (title.presence !== "present" || typeof title.value !== "string" || !title.value.trim()) reason = "REQUIRED_FACT_MISSING";
  else if (!input.integrityValid || typeof input.sourceProofHash !== "string" || !/^[a-f0-9]{64}$/.test(input.sourceProofHash)
    || typeof input.evidenceId !== "string" || !input.evidenceId.trim()
    || !Number.isSafeInteger(input.evidenceVersion) || Number(input.evidenceVersion) < 1
    || typeof input.capturedAt !== "string" || !Number.isFinite(Date.parse(input.capturedAt))) reason = "EVIDENCE_BINDING_INVALID";
  else if (["blocked", "corrupted", "rejected", "invalid", "quarantined"].includes(input.evidenceStatus ?? "")) reason = "EVIDENCE_BLOCKED";
  return { valid: reason === null, reason: reason ?? "VALID", policyVersion: MARKET_SAMPLE_POLICY_VERSION };
}

/** One resolver for frozen facts and metric inputs; family/identity collapse uses the P1 policy. */
export function resolveDeterministicMarketSamples(input: {
  items: readonly (Parameters<typeof evaluateMarketSampleValidity>[0] & { id: string; ordinal: number; parentAsin?: string | null; familyProjectionJson?: string })[];
  marketplace: string;
}) {
  const candidates: MarketProductCandidate[] = input.items.map((item) => ({
    id: item.id, ordinal: item.ordinal, productKey: String(item.subjectKey ?? ""), asin: typeof item.asin === "string" ? item.asin : null,
    parentAsin: item.parentAsin ?? null, familyProjectionJson: item.familyProjectionJson ?? "{}", archivedAt: null,
    evidenceStatus: item.evidenceStatus ?? "sufficient_for_comparison", deterministicValid: evaluateMarketSampleValidity(item).valid,
  }));
  return resolveValidMarketProductSet({ items: candidates, batchMarketplace: input.marketplace });
}
