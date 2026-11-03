import "server-only";

import { randomUUID } from "node:crypto";
import type { AccessContext } from "@/lib/server/accessPassword";
import { prisma } from "@/lib/server/db";
import { getProductBatchStore } from "@/lib/server/productBatchStoreResolver";
import {
  parseEvidencePromotionReference,
  type EvidencePromotionReferenceV1,
} from "@/lib/sourceLayer/server/evidencePromotionReference";

type CandidateRow = {
  id: string;
  name: string;
  status: string;
  sourceMetaJson: string;
  analysisJson: string;
  convertedTaskId: string | null;
  originProductBatchItemId: string | null;
};

export type EvidencePromotionCandidateResult = {
  candidateId: string;
  created: boolean;
  reference: EvidencePromotionReferenceV1 & { productBatchItemId: string };
};

function candidateAnalysis(reference: EvidencePromotionReferenceV1 & { productBatchItemId: string }, itemHash: string) {
  return {
    version: "evidence-promotion-analysis.v1",
    originKind: "evidence_store_promotion" as const,
    researchMode: "market_research_only" as const,
    promotionEligible: false as const,
    evidenceHash: reference.contentHash,
    itemHash,
  };
}

function sameCandidate(row: CandidateRow, reference: EvidencePromotionReferenceV1 & { productBatchItemId: string }, itemHash: string): boolean {
  return row.originProductBatchItemId === reference.productBatchItemId
    && row.name === reference.title
    && JSON.stringify(JSON.parse(row.sourceMetaJson)) === JSON.stringify(reference)
    && JSON.stringify(JSON.parse(row.analysisJson)) === JSON.stringify(candidateAnalysis(reference, itemHash));
}

export async function createOrReuseEvidencePromotionCandidate(input: {
  context: AccessContext;
  batchId: string;
  itemId: string;
}): Promise<EvidencePromotionCandidateResult> {
  if (input.context.mode !== "owner") throw new Error("evidence_promotion_owner_required");
  const store = getProductBatchStore(input.context);
  const batch = await store.getBatch(input.batchId);
  if (!batch || batch.batchStatus !== "ready") throw new Error("evidence_promotion_batch_not_ready");
  const item = (await store.getBatchItems(batch.id)).find((entry) => entry.id === input.itemId);
  if (!item) throw new Error("evidence_promotion_item_not_found");
  const parsed = parseEvidencePromotionReference(item.normalizedProductJson);
  if (!parsed || parsed.productBatchId !== batch.id) throw new Error("evidence_promotion_reference_invalid");
  const reference = { ...parsed, productBatchItemId: item.id };
  const analysis = candidateAnalysis(reference, item.itemHash);
  const sourceMetaJson = JSON.stringify(reference);
  const analysisJson = JSON.stringify(analysis);
  const inputRow = {
    name: reference.title,
    rawInput: reference.asin,
    link: `https://www.amazon.com/dp/${reference.asin}`,
    score: 0,
    source: "EvidenceStore promotion",
    keyword: reference.asin,
    riskLevel: "unknown",
    riskLabel: "需人工核验",
    summaryLabel: "已有采集证据提档候选",
    status: "worth_analyzing",
    sourceMetaJson,
    analysisJson,
    originProductBatchItemId: item.id,
  };

  const create = async () => prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<CandidateRow[]>`
      SELECT "id", "name", "status", "sourceMetaJson", "analysisJson", "convertedTaskId", "originProductBatchItemId"
      FROM "OpportunityCandidate" WHERE "originProductBatchItemId" = ${item.id} LIMIT 2
    `;
    if (rows.length > 1) throw new Error("evidence_promotion_candidate_conflict");
    const existing = rows[0];
    if (existing) {
      if (!sameCandidate(existing, reference, item.itemHash)) throw new Error("evidence_promotion_candidate_conflict");
      return { candidateId: existing.id, created: false };
    }
    const id = randomUUID();
    const now = new Date();
    await tx.opportunityCandidate.create({
      data: {
        id,
        ...inputRow,
        lastActionAt: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    return { candidateId: id, created: true };
  });

  try {
    const result = await create();
    return { ...result, reference };
  } catch (error) {
    const rows = await prisma.$queryRaw<CandidateRow[]>`
      SELECT "id", "name", "status", "sourceMetaJson", "analysisJson", "convertedTaskId", "originProductBatchItemId"
      FROM "OpportunityCandidate" WHERE "originProductBatchItemId" = ${item.id} LIMIT 2
    `;
    const existing = rows.length === 1 ? rows[0] : null;
    if (!existing || !sameCandidate(existing, reference, item.itemHash)) throw error;
    return { candidateId: existing.id, created: false, reference };
  }
}
