import type { PrismaClient } from "@prisma/client";
import { captureThroughGateway } from "@/lib/sourceLayer/server/captureGateway";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { adaptEvidenceToProductFact } from "@/lib/sourceLayer/fact/productFactAdapter";
import { createAmazonSearchProductBatch } from "@/lib/server/amazonSearchProductBatchHandoff";
import { hashJson } from "@/lib/server/v5CanonicalHash";

/** Offline seed only: call on a newly migrated disposable database/store. */
export async function seedP4ReadPath(client: PrismaClient) {
  const context = { mode: "owner", token: "" } as const;
  const asin = "B000000041";
  const title = "便携不锈钢水杯";
  const captured = await captureThroughGateway({
    context, source: "amazon_dom", now: new Date("2026-10-01T01:00:00.000Z"),
    subjectKey: "amazon:US:" + asin, marketplace: "US", sourceUrl: "https://www.amazon.com/dp/" + asin,
    payload: { asin, title, productUrl: "https://www.amazon.com/dp/" + asin,
      images: ["https://m.media-amazon.com/images/I/offline-fixture.jpg"], price: 24.75, currency: "USD", rating: 4.3, reviewCount: 123, brand: "ClearTrail", bsrRank: 80, bsrCategory: "Home & Kitchen" },
    pageContext: { pageClass: "amazon_search_normal", allowFields: true, entityBinding: {
      bound: true, expectedAsin: asin, observedAsin: asin, urlAsin: asin,
      expectedMarketplace: "US", observedMarketplace: "US", urlMarketplace: "US" } },
  });
  const batch = await createAmazonSearchProductBatch({ context, query: "portable bottle", traceId: "p4-offline-seed", plan: null, captures: [captured] });
  if (!batch.batchId) throw new Error("p4_fixture_batch_not_created");
  const item = await client.productBatchItem.findFirstOrThrow({ where: { batchId: batch.batchId } });
  const evidence = (await createEvidenceStore("owner:v1").getSubject("amazon:US:" + asin))?.versions[0];
  if (!evidence) throw new Error("p4_fixture_evidence_missing");
  const productFact = adaptEvidenceToProductFact({ evidence });
  for (const [index, choice] of [null, null, "PROCEED"].entries()) {
    const taskId = "p4-task-" + index, candidateId = "p4-candidate-" + index;
    const report = { schema: "research-report.v5", summary: "离线样本研究结论，等待人工复核。", opportunities: [], risks: [], citations: [{ quote: title, source: "evidence:" + evidence.evidenceId }], narrativeBindings: [{ field: "summary", text: "离线样本研究结论，等待人工复核。", evidenceRefs: ["evidence:" + evidence.evidenceId] }] };
    await client.opportunityCandidate.create({ data: { id: candidateId, name: title, convertedTaskId: taskId,
      sourceMetaJson: JSON.stringify({ productFact, identity: { asin, brand: "非证据品牌", price: 99 } }) } });
    await client.viralAnalysisRecord.create({ data: { id: taskId, type: "workflow", decisionStatus: choice ? "proceed" : "pending",
      title, platform: "Amazon", materialText: "", source: "p4-offline-fixture", score: 0, level: "", oneLineSummary: "",
      resultJson: JSON.stringify({ candidateToTask: { candidateId }, preserveUnknown: { value: 41 }, v5Research: {
        schema: "v5-research.v1", candidateId, asin, marketplace: "US", title,
        factHash: hashJson(productFact), evidenceHash: hashJson([{ refId: "evidence:" + evidence.evidenceId, evidenceId: evidence.evidenceId, contentHash: evidence.contentHash }]), evidenceRefs: [evidence.evidenceId],
        researchRevision: 1, report, reportHash: hashJson(report), advisory: null, temporaryWatches: [],
        myChoice: choice ? { choice, canonicalStatus: choice, scope: "FINAL", chosenBy: "Owner", chosenAt: new Date().toISOString() } : null,
      } }) } });
  }
  await client.opportunityCandidate.create({ data: { id: "p4-display-only", name: "候选身份资料",
    sourceMetaJson: JSON.stringify({ identity: { asin: "B000000042", brand: "资料品牌", category: "资料品类", price: 99, rating: 4.9 } }) } });
  return { batchId: batch.batchId, itemId: item.id, asin, title, price: 24.75, rating: 4.3, reviewCount: 123, briefTaskId: "p4-task-2" };
}
