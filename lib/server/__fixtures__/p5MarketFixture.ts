import type { PrismaClient } from "@prisma/client";
import { captureThroughGateway } from "@/lib/sourceLayer/server/captureGateway";
import { projectProductFactsFromEvidence, isEligibleMarketScanProjection, marketFactValuesOf } from "@/lib/marketScan/productFactSource";
import { evaluateMarketSampleValidity } from "@/lib/marketScan/marketSampleValidity";
import { createAmazonSearchProductBatch } from "@/lib/server/amazonSearchProductBatchHandoff";

/** All evidence is explicitly synthetic; only run in a newly migrated disposable store. */
export async function seedP5MarketBatch(client: PrismaClient, count: number, offset = 100) {
  const context = { mode: "owner", token: "" } as const;
  const captures = [];
  for (let index = 0; index < count; index += 1) {
    const asin = "B" + String(offset + index).padStart(9, "0");
    captures.push(await captureThroughGateway({ context, source: "amazon_dom", now: new Date("2026-10-01T01:00:00.000Z"),
      subjectKey: "amazon:US:" + asin, marketplace: "US", sourceUrl: "https://www.amazon.com/dp/" + asin,
      payload: { asin, title: `离线验证水杯 ${index + 1}`, productUrl: "https://www.amazon.com/dp/" + asin,
        images: ["https://m.media-amazon.com/images/I/offline-fixture.jpg"], price: 24.75, currency: "USD", rating: 4.3, reviewCount: 123, brand: "ClearTrail", bsrRank: 80, bsrCategory: "Home & Kitchen" },
      pageContext: { pageClass: "amazon_search_normal", allowFields: true, entityBinding: { bound: true,
        expectedAsin: asin, observedAsin: asin, urlAsin: asin, expectedMarketplace: "US", observedMarketplace: "US", urlMarketplace: "US" } },
    }));
  }
  const facts = await projectProductFactsFromEvidence({ operator: "owner:v1", marketplace: "US" });
  for (const fact of facts) if (!isEligibleMarketScanProjection(fact)) throw new Error("fixture_validity:" + JSON.stringify({ verdict: fact.validationVerdict, subject: fact.productFact.sourceProof.subjectKey === fact.subjectKey, id: fact.productFact.sourceProof.evidenceId === fact.evidenceId, hash: fact.productFact.sourceProof.contentHash === fact.sourceProofHash, result: evaluateMarketSampleValidity({ asin: fact.asin, subjectKey: fact.subjectKey, marketplace: fact.marketplace, factValues: marketFactValuesOf(fact.productFact), evidenceId: fact.evidenceId, evidenceVersion: fact.evidenceVersion, sourceProofHash: fact.sourceProofHash, capturedAt: fact.capturedAt, integrityValid: true }) }));
  const result = await createAmazonSearchProductBatch({ context, query: "离线门禁验证", traceId: crypto.randomUUID(), plan: null, captures });
  if (!result.batchId) throw new Error("fixture_batch_not_created");
  const items = await client.productBatchItem.findMany({ where: { batchId: result.batchId }, orderBy: { ordinal: "asc" } });
  return { batchId: result.batchId, items };
}
