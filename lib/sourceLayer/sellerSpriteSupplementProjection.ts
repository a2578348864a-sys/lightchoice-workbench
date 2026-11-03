import type { SourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import { parseSourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import { parseV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import { parseSellerSpriteQuerySubjectKey } from "@/lib/sourceLayer/queryEvidenceSubject";
import {matchesSellerSpriteQueryEvidenceSubject} from "@/lib/server/research/sellerSpriteQueryEvidenceIdentity";
import { record } from "@/lib/marketScan/intelligence";

const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
const aliases: Record<string, string[]> = {
  asin: ["ASIN", "商品ASIN", "产品ASIN"], title: ["Title", "Product Title", "商品标题", "商品名称", "产品名称"],
  price: ["Price", "价格", "价格($)", "价格($USD)"], rating: ["Rating", "评分"], reviewCount: ["Reviews", "Review Count", "评论数", "评分数"],
  monthlySales: ["月销量", "Monthly Sales"], fbaFee: ["预估FBA费", "Estimated FBA Fee", "FBA费用", "FBA Fee"],
};
export type SellerSpriteQueryProduct = { asin: string; title: string | null; price: number | null; rating: number | null; reviewCount: number | null; monthlySales: number | null; fbaFee: number | null; currency: "USD"; metricNature: "provider_estimate" };

function numeric(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^(?:US\$|\$)?\s*\d[\d,]*(?:\.\d+)?$/u.test(raw.trim())) return null;
  const value = Number(raw.replace(/US\$|[$,\s]/gu, ""));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Only named columns; no positional guesses. Query rows remain query-scoped. */
export function projectSellerSpriteSupplement(attachment: SourceEvidenceAttachment) {
  const checked = parseSourceEvidenceAttachment(attachment);
  const parsed = checked ? parseV3ModuleEvidence(checked.payload) : null;
  if (!checked || !parsed || parsed.module !== "sellersprite_product_market" || parsed.provider.toLowerCase() !== "sellersprite"
    || checked.sourceType !== "sellersprite_plugin" || checked.subjectKey !== parsed.subjectKey || checked.capturedAt !== parsed.capturedAt
    || !["VALIDATED_AVAILABLE", "AVAILABLE_WITH_LIMITATION"].includes(parsed.status)
    || !["provider_observed", "provider_estimate"].includes(parsed.metricNature) || parsed.data.rowScope === "traversal_checkpoint_only") return null;
  const query = parseSellerSpriteQuerySubjectKey(parsed.subjectKey);
  if (query && (!matchesSellerSpriteQueryEvidenceSubject(parsed) || query.marketplace !== parsed.marketplace)) return null;
  const data = parsed.data;
  const snapshot = record(data.visibleSnapshot ?? data.visibleDom ?? data);
  const tables = Array.isArray(snapshot.tables) ? snapshot.tables : [];
  const rows = new Map<string, SellerSpriteQueryProduct | null>();
  for (const raw of tables) {
    const table = record(raw);
    if (!Array.isArray(table.headers) || !table.headers.every((s) => typeof s === "string") || !Array.isArray(table.rows)) continue;
    const headers = table.headers as string[];
    const column = (key: string) => {
      const indices = headers.flatMap((header, i) => aliases[key].some((alias) => normalize(alias) === normalize(header)) ? [i] : []);
      return indices.length === 1 ? indices[0] : -1;
    };
    const asinIndex = column("asin");
    if (asinIndex === -1) continue;
    for (const rawRow of table.rows) {
      if (!Array.isArray(rawRow)) continue;
      const asin = String(rawRow[asinIndex] ?? "").trim().toUpperCase();
      if (!/^[A-Z0-9]{10}$/u.test(asin)) continue;
      const read = (name: string) => numeric(rawRow[column(name)]);
      const rating = read("rating"), reviewCount = read("reviewCount");
      const row: SellerSpriteQueryProduct = { asin, title: typeof rawRow[column("title")] === "string" ? rawRow[column("title")] : null, price: read("price"), rating: rating !== null && rating <= 5 ? rating : null, reviewCount: reviewCount !== null && Number.isSafeInteger(reviewCount) ? reviewCount : null, monthlySales: read("monthlySales"), fbaFee: read("fbaFee"), currency: "USD", metricNature: "provider_estimate" };
      if (!rows.has(asin)) rows.set(asin, row);
      else if (JSON.stringify(rows.get(asin)) !== JSON.stringify(row)) rows.set(asin, null);
    }
  }
  const productRows = [...rows.values()].filter((r): r is SellerSpriteQueryProduct => r !== null);
  const asin = /^amazon:([A-Z]{2}):([A-Z0-9]{10})$/u.exec(parsed.subjectKey);
  let fbaFee: { amount: number; currency: string } | null = null;
  if (asin && parsed.identity.asin === asin[2] && parsed.marketplace === asin[1]) {
    const fee = record(data.estimatedFbaFee);
    if (typeof fee.amount === "number" && Number.isFinite(fee.amount) && fee.amount >= 0 && fee.currency === "USD") fbaFee = { amount: fee.amount, currency: "USD" };
    const row = productRows.find((r) => r.asin === asin[2]);
    if (row?.fbaFee !== null && row?.fbaFee !== undefined) {
      const incoming = { amount: row.fbaFee, currency: "USD" };
      fbaFee = fbaFee && fbaFee.amount !== incoming.amount ? null : incoming;
    }
  }
  return { productRows: query ? productRows : [], fbaFee };
}
