import { parseProductBrief, type ProductBrief } from "@/lib/productBrief/contract";

export class ProductBriefHistoryPreservationError extends Error {
  constructor() {
    super("Product Brief history preservation is blocked by an invalid stored snapshot.");
    this.name = "ProductBriefHistoryPreservationError";
  }
}

export function readProductBriefHistory(value: unknown): { valid: true; items: ProductBrief[] } | { valid: false; items: [] } {
  if (value === undefined) return { valid: true, items: [] };
  if (!Array.isArray(value)) return { valid: false, items: [] };
  const items: ProductBrief[] = [];
  for (const entry of value) {
    const brief = parseProductBrief(entry);
    if (!brief) return { valid: false, items: [] };
    items.push(brief);
  }
  return { valid: true, items };
}

export function appendProductBriefVersion(currentRaw: unknown, historyRaw: unknown, next: ProductBrief): {
  brief: ProductBrief;
  history: unknown[];
} {
  const current = currentRaw === undefined || currentRaw === null ? null : parseProductBrief(currentRaw);
  const history = readProductBriefHistory(historyRaw);
  if ((currentRaw !== undefined && currentRaw !== null && !current) || !history.valid) {
    throw new ProductBriefHistoryPreservationError();
  }
  const nextHistory = [...(historyRaw === undefined ? [] : historyRaw as unknown[])];
  if (current) nextHistory.push(currentRaw);
  return { brief: next, history: nextHistory };
}
