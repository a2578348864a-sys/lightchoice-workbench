import "server-only";

import { adaptEvidenceToProductFact } from "@/lib/sourceLayer/fact/productFactAdapter";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import type { AccessContext } from "@/lib/server/accessPassword";
import { isFixtureEvidenceSubject } from "@/lib/sourceLayer/server/fixtureRegistry";

const SHA256 = /^[a-f0-9]{64}$/u;
const ASIN = /^[A-Z0-9]{10}$/u;

export type EvidencePromotionReferenceV1 = {
  schemaVersion: "evidence-store-product-reference.v1";
  subjectKey: string;
  evidenceId: string;
  evidenceVersion: number;
  contentHash: string;
  factSchema: "product-fact.v3";
  factBuildable: true;
  asin: string;
  parentAsin: string | null;
  marketplace: string;
  title: string;
  image: string | null;
  capturedAt: string;
  productBatchId: string;
  productBatchItemId?: string;
  metricNature: "preserved_in_product_fact_projection";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= max
    ? value.trim()
    : null;
}

export function parseEvidencePromotionReference(value: unknown): EvidencePromotionReferenceV1 | null {
  const record = typeof value === "string"
    ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })()
    : value;
  if (!isRecord(record)
    || record.schemaVersion !== "evidence-store-product-reference.v1"
    || record.factSchema !== "product-fact.v3"
    || record.factBuildable !== true
    || record.metricNature !== "preserved_in_product_fact_projection"
    || typeof record.evidenceVersion !== "number"
    || !Number.isSafeInteger(record.evidenceVersion)
    || record.evidenceVersion < 1
    || typeof record.contentHash !== "string"
    || !SHA256.test(record.contentHash)
    || typeof record.asin !== "string"
    || !ASIN.test(record.asin)
    || (record.parentAsin !== null && (typeof record.parentAsin !== "string" || !ASIN.test(record.parentAsin)))) {
    return null;
  }
  const subjectKey = text(record.subjectKey, 240);
  const evidenceId = text(record.evidenceId, 240);
  const marketplace = text(record.marketplace, 32);
  const title = text(record.title, 500);
  const capturedAt = text(record.capturedAt, 64);
  const productBatchId = text(record.productBatchId, 128);
  const productBatchItemId = text(record.productBatchItemId, 128);
  if (!subjectKey || !evidenceId || !marketplace || !title || title.length < 2
    || !capturedAt || Number.isNaN(Date.parse(capturedAt)) || !productBatchId) {
    return null;
  }
  return {
    schemaVersion: "evidence-store-product-reference.v1",
    subjectKey,
    evidenceId,
    evidenceVersion: record.evidenceVersion,
    contentHash: record.contentHash,
    factSchema: "product-fact.v3",
    factBuildable: true,
    asin: record.asin,
    parentAsin: record.parentAsin,
    marketplace,
    title,
    image: record.image === null ? null : text(record.image, 2_048),
    capturedAt,
    productBatchId,
    ...(productBatchItemId ? { productBatchItemId } : {}),
    metricNature: "preserved_in_product_fact_projection",
  };
}

export function claimsEvidencePromotionReference(value: unknown): boolean {
  return parseEvidencePromotionReference(value) !== null;
}

export async function resolveEvidencePromotionProductFact(
  context: AccessContext,
  reference: EvidencePromotionReferenceV1,
): Promise<ProductFact | null> {
  if (context.mode !== "owner") return null;
  const subject = await createEvidenceStore("owner:v1").getSubject(reference.subjectKey);
  if (!subject || isFixtureEvidenceSubject({ subjectKey: subject.subjectKey, asin: reference.asin })) return null;
  const evidence = subject.versions.find((item) => item.version === reference.evidenceVersion
    && item.evidenceId === reference.evidenceId
    && item.contentHash === reference.contentHash);
  if (!evidence) return null;
  try {
    const fact = adaptEvidenceToProductFact({ evidence });
    if (fact.subjectKey !== reference.subjectKey
      || fact.basic.asin.value !== reference.asin
      || fact.basic.title.value !== reference.title
      || evidence.validation.verdict !== "passed"
      || evidence.validation.readyForResearch
      !== true
      || evidence.factAuthority !== "evidence_only") {
      return null;
    }
    return fact;
  } catch {
    return null;
  }
}
