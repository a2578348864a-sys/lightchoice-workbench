import { factValuesFingerprintOf } from "@/lib/marketScan/metrics";
import { resolveDeterministicMarketSamples } from "@/lib/marketScan/marketSampleValidity";
import { MARKET_SAMPLE_POLICY_VERSION } from "@/lib/marketScan/marketSamplePolicy";
import type { MarketFactValuesV1 } from "@/lib/marketScan/types";

/** Legacy compatibility is a read projection, never a rewrite of frozen historical metrics. */
export function projectFrozenMarketValidity(items: readonly Record<string, unknown>[], marketplace: string) {
  return resolveDeterministicMarketSamples({ marketplace, items: items.map((item, ordinal) => {
    let integrityValid = false;
    try {
      integrityValid = item.factValuesFingerprint === factValuesFingerprintOf({ subjectKey: String(item.subjectKey), factValues: item.factValues as MarketFactValuesV1 })
        && (item.sampleValidityPolicyVersion === undefined || item.sampleValidityPolicyVersion === MARKET_SAMPLE_POLICY_VERSION);
    } catch { /* Invalid historical snapshots stay visible but cannot satisfy the gate. */ }
    return { ...item, id: String(ordinal), ordinal, asin: item.asin, subjectKey: item.subjectKey, marketplace,
      factValues: item.factValues, evidenceId: item.evidenceId, evidenceVersion: item.evidenceVersion,
      sourceProofHash: item.sourceProofHash, capturedAt: item.capturedAt, integrityValid,
      evidenceStatus: typeof item.evidenceStatus === "string" ? item.evidenceStatus : undefined,
      parentAsin: typeof item.parentAsin === "string" ? item.parentAsin : null };
  }) });
}
