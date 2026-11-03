import "server-only";
import type { AccessContext } from "@/lib/server/accessPassword";
import { createEvidenceStore, type EvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { sourceLayerOperator } from "@/lib/sourceLayer/server/sourceLayerService";
import { adaptEvidenceToProductFact } from "@/lib/sourceLayer/fact/productFactAdapter";

/** A read-only display projection of persisted Evidence; no acquisition or new authority. */
export async function getLatestAmazonCaptureSummary(context: AccessContext, store?: Pick<EvidenceStore, "listSubjects" | "getSubject">) {
  const reader = store ?? createEvidenceStore(sourceLayerOperator(context));
  const subject = (await reader.listSubjects()).filter(item => item.sourceType === "amazon_dom"
    && /^amazon:US:[A-Z0-9]{10}$/.test(item.subjectKey) && item.latestVerdict === "passed")
    .sort((a, b) => Date.parse(b.latestCapturedAt) - Date.parse(a.latestCapturedAt))[0];
  if (!subject) return null;
  const saved = await reader.getSubject(subject.subjectKey);
  const evidence = saved?.versions.find(item => item.version === subject.latestVersion);
  if (!evidence || evidence.validation.verdict !== "passed" || evidence.sourceType !== "amazon_dom") return null;
  const fact = adaptEvidenceToProductFact({ evidence });
  let path = "";
  try { if (evidence.sourceUrl) path = new URL(evidence.sourceUrl).pathname; } catch { /* legacy URL remains unknown */ }
  return { subjectKey: evidence.subjectKey, evidenceId: evidence.evidenceId, version: evidence.version,
    capturedAt: evidence.capturedAt, contentHash: evidence.contentHash,
    sourceLabel: /^\/(?:dp|gp\/product)\//.test(path) ? "Amazon 商品页面" : path === "/s" ? "Amazon 搜索页面" : "Amazon 来源快照",
    asin: fact.basic.asin.value, title: fact.basic.title.value, brand: fact.basic.brand.value,
    price: fact.basic.price.value, rating: fact.basic.rating.value, reviewCount: fact.basic.reviewCount.value };
}
