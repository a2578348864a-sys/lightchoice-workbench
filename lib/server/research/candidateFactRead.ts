import "server-only";

import type { AccessContext } from "@/lib/server/accessPassword";
import { hashJson } from "@/lib/server/v5CanonicalHash";
import { verifyCandidateFactBinding } from "@/lib/marketScan/candidateContract";
import { adaptEvidenceToProductFact } from "@/lib/sourceLayer/fact/productFactAdapter";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { sourceLayerOperator } from "@/lib/sourceLayer/server/sourceLayerService";
import {
  attachAmazonDetailFieldHistory,
  isAmazonDetailHistoryProjection,
  projectAmazonDetailFieldHistory,
} from "@/lib/sourceLayer/amazonDetailFieldHistory";
import { projectProductFactEvidence } from "@/lib/server/research/productFactEvidenceProjection";

function normalizeFactForComparison(fact: any): any {
  if (!fact || typeof fact !== "object") return fact;
  if (Array.isArray(fact)) return fact.map(normalizeFactForComparison);
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(fact)) {
    if (v && typeof v === "object" && (v as any).status === "missing" && (v as any).value === null) {
      continue;
    }
    const normalized = normalizeFactForComparison(v);
    if (normalized && typeof normalized === "object" && !Array.isArray(normalized) && Object.keys(normalized).length === 0) {
      continue;
    }
    result[k] = normalized;
  }
  return result;
}

/** Cached Candidate facts are references, never an independent fact authority. No writes or recovery. */
export async function readVerifiedCandidateFact(input: {
  context: AccessContext;
  meta: Record<string, unknown>;
  productFact: ProductFact;
  /** Injected for deterministic projection replay; production reads default to the current time. */
  now?: string;
}): Promise<ProductFact> {
  const { productFact, meta } = input;
  const checked = verifyCandidateFactBinding({ meta, productFact });
  if (!checked.valid) throw new Error(`PRODUCT_FACT_BINDING_INVALID:${checked.code}`);
  const proof = productFact.sourceProof;
  const subject = await createEvidenceStore(sourceLayerOperator(input.context)).getSubject(productFact.subjectKey);
  const evidence = subject?.versions.find((item) => item.subjectKey === productFact.subjectKey
    && item.evidenceId === proof.evidenceId && item.captureId === proof.captureId
    && item.contentHash === proof.contentHash
    && (checked.binding?.evidenceVersion == null || item.version === checked.binding.evidenceVersion));
  if (!evidence || subject?.subjectKey !== productFact.subjectKey) {
    throw new Error("RESEARCH_INPUT_BUNDLE_EVIDENCE_MISSING");
  }
  if (evidence.validation?.verdict !== "passed" || evidence.validation.readyForResearch !== true
    || evidence.factAuthority !== "evidence_only") {
    throw new Error("RESEARCH_INPUT_BUNDLE_EVIDENCE_MISSING: Evidence is not ready for research.");
  }
  const authoritative = adaptEvidenceToProductFact({ evidence });
  let replayedFact = authoritative;
  if (productFact.amazonDetailHistory !== undefined) {
    const projection = productFact.amazonDetailHistory;
    if (!isAmazonDetailHistoryProjection(projection)
      || projection.subjectKey !== proof.subjectKey
      || projection.asin !== authoritative.basic.asin.value
      || projection.marketplace !== proof.entityBinding?.expectedMarketplace.toUpperCase()) {
      throw new Error("AMAZON_DETAIL_HISTORY_BINDING_INVALID");
    }
    const replayed = projectAmazonDetailFieldHistory({
      subjectKey: projection.subjectKey,
      marketplace: projection.marketplace,
      asin: projection.asin,
      now: projection.injectedNow,
      priceContext: projection.priceContext,
      currentEvidenceId: proof.evidenceId,
      candidates: subject.versions,
    });
    if (replayed.decisionHash !== projection.decisionHash) throw new Error("AMAZON_DETAIL_HISTORY_DECISION_HASH_MISMATCH");
    replayedFact = attachAmazonDetailFieldHistory(authoritative, replayed);
  } else if (evidence.sourceType === "amazon_dom" && authoritative.basic.asin.value) {
    const priceField = evidence.pkg.extensions?.amazonDetail?.registeredFields.price;
    const priceTrace = priceField?.sourceTrace;
    const priceContext = priceField?.status === "observed"
      && priceTrace?.selected === true
      && priceTrace.semanticRole === "current_pay_now"
      && priceTrace.purchaseContext === "one_time"
      ? "one_time"
      : priceField?.status === "observed"
        && priceTrace?.selected === true
        && priceTrace.semanticRole === "subscribe_price"
        && priceTrace.purchaseContext === "subscribe_save"
        ? "subscribe_save"
        : null;
    const projection = projectAmazonDetailFieldHistory({
      subjectKey: authoritative.subjectKey,
      marketplace: evidence.pkg.marketplace,
      asin: authoritative.basic.asin.value,
      now: input.now ?? new Date().toISOString(),
      priceContext,
      currentEvidenceId: evidence.evidenceId,
      candidates: subject.versions,
    });
    replayedFact = attachAmazonDetailFieldHistory(authoritative, projection);
  }

  const projected = projectProductFactEvidence(replayedFact, subject.attachments ?? []);
  const matchesExpected = (expected: ProductFact) => hashJson(productFact) === hashJson(expected)
    || hashJson(normalizeFactForComparison(productFact)) === hashJson(normalizeFactForComparison(expected));
  // Candidate metadata may still contain the original single-capture ProductFact or a previously
  // materialized projection. Both are accepted only when they exactly replay from current Evidence.
  if (!matchesExpected(authoritative) && !matchesExpected(replayedFact) && !matchesExpected(projected)) {
    throw new Error("PRODUCT_FACT_CACHE_HASH_MISMATCH");
  }
  return projected;
}
