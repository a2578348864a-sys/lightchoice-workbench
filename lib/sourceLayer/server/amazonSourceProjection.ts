import "server-only";

import type { AccessContext } from "@/lib/server/accessPassword";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { adaptEvidenceToProductFact } from "@/lib/sourceLayer/fact/productFactAdapter";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";

export type AmazonSourceProjectionItem = {
  subjectKey: string;
  evidenceId: string;
  contentHash: string;
  productFact: ProductFact;
  capturedAt: string;
  sourceType: "amazon_dom";
  availability: "可研究" | "需复核" | "已阻断";
};

export function projectAmazonEvidence(evidence: import("@/lib/sourceLayer/sourceAdapter").CaptureEvidenceRecord): AmazonSourceProjectionItem | null {
  if (evidence.sourceType !== "amazon_dom" || !evidence.pkg.sourceProof.entityBinding?.bound) return null;
  const productFact = adaptEvidenceToProductFact({ evidence });
  const asin = productFact.basic.asin.value;
  const hasUsefulFact = Boolean(
    productFact.basic.title.value
    || productFact.basic.price.value
    || productFact.basic.image.value
    || (productFact.basic.bulletPoints.value?.length ?? 0) > 0,
  );
  if (!asin || !hasUsefulFact) return null;
  const availability = evidence.validation.readyForResearch && evidence.validation.verdict === "passed"
    ? "可研究"
    : evidence.validation.verdict === "blocked" ? "已阻断" : "需复核";
  return {
    subjectKey: evidence.subjectKey,
    evidenceId: evidence.evidenceId,
    contentHash: evidence.contentHash,
    productFact,
    capturedAt: evidence.capturedAt,
    sourceType: "amazon_dom",
    availability,
  };
}

function operatorOf(context: AccessContext): string {
  return context.mode === "owner" ? "owner:v1" : `visitor:${context.demoAccessId}`;
}

/** Read-only management projection from the authoritative EvidenceStore. */
export async function listAmazonSourceProjection(context: AccessContext): Promise<AmazonSourceProjectionItem[]> {
  const store = createEvidenceStore(operatorOf(context));
  const subjects = await store.listSubjects();
  const items: AmazonSourceProjectionItem[] = [];
  for (const subject of subjects) {
    if (subject.sourceType !== "amazon_dom") continue;
    const record = await store.getSubject(subject.subjectKey);
    const evidence = record?.versions.at(-1);
    if (!evidence || evidence.sourceType !== "amazon_dom") continue;
    const projected = projectAmazonEvidence(evidence);
    if (projected) items.push(projected);
  }
  return items.sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
}
