import { DEFAULT_MATRIX_FILTER, MATRIX_GROUPS, type MatrixFilter } from "./materialMatrixPresentation";
import type { ProductSort } from "./productTablePresentation";

export type BrowseState = {
  batchId: string; view: "gallery" | "table" | "matrix";
  search: string; status: "all" | "ready" | "review" | "blocked"; sort: ProductSort;
  page: number; itemId: string | null; module: string | null; matrix: MatrixFilter;
  location: { itemId: string; module: string } | null;
  scroll: { page: number; matrixTop: number; matrixLeft: number; review: number };
};
export const BROWSE_KEY = "lc-source-browse-v1";
export const BROWSE_PARAM = "workspaceBatch";
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const modules = [...MATRIX_GROUPS.basic, ...MATRIX_GROUPS.supplementary] as readonly string[];
const position = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1000000, value)) : 0;

/** Explicit allowlist: never deserialize selections, dialogs, facts, permissions or run state. */
export function readBrowseState(value: unknown, batchId: string): BrowseState | null {
  if (!id(batchId) || !value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.batchId !== batchId) return null;
  const matrix = (v.matrix ?? {}) as Record<string, unknown>, scroll = (v.scroll ?? {}) as Record<string, unknown>;
  const group = matrix.group === "supplementary" ? "supplementary" : "basic";
  const location = v.location as Record<string, unknown> | null;
  return {
    batchId, view: v.view === "table" || v.view === "matrix" ? v.view : "gallery",
    search: typeof v.search === "string" ? v.search.slice(0, 300) : "",
    status: ["ready", "review", "blocked"].includes(String(v.status)) ? v.status as BrowseState["status"] : "all",
    sort: ["price_asc", "price_desc", "rating_desc", "reviews_desc"].includes(String(v.sort)) ? v.sort as ProductSort : "original",
    page: Math.floor(position(v.page)), itemId: id(v.itemId) ? v.itemId : null,
    module: modules.includes(String(v.module)) ? String(v.module) : null,
    matrix: { group, module: (MATRIX_GROUPS[group] as readonly string[]).includes(String(matrix.module)) ? String(matrix.module) : "all", issue: ["human", "partial", "blocked", "failed", "missing", "not_in_scope"].includes(String(matrix.issue)) ? matrix.issue as MatrixFilter["issue"] : DEFAULT_MATRIX_FILTER.issue },
    location: location && id(location.itemId) && modules.includes(String(location.module)) ? { itemId: location.itemId, module: String(location.module) } : null,
    scroll: { page: position(scroll.page), matrixTop: position(scroll.matrixTop), matrixLeft: position(scroll.matrixLeft), review: position(scroll.review) },
  };
}

export function defaultBrowseState(batchId: string): BrowseState {
  return readBrowseState({ batchId }, batchId)!;
}

export function validSamplePreview(value: unknown, batchId: string): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.productBatchId === batchId && ["sourceItemCount", "preliminaryValidCount", "finalFreezableCount", "minimumRequired"].every(k => Number.isInteger(v[k]) && Number(v[k]) >= 0)
    && typeof v.sufficient === "boolean" && Array.isArray(v.stages) && v.stages.every(s => s && typeof s === "object" && Array.isArray(s.items) && Number.isInteger(s.droppedCount));
}

/** Preview exclusion IDs can be subject keys, not source item IDs. Only unique same-market identities may navigate. */
export function resolveExcludedItem<T extends { id: string; asin: string; marketplace?: string | null; archivedAt?: string | null }>(items: readonly T[], excluded: { id: string; asin: string | null }, marketplace: string): T | null {
  const market = marketplace.toUpperCase();
  const candidates = items.filter(item => !item.archivedAt && (item.marketplace || market).toUpperCase() === market);
  const exact = candidates.find(item => item.id === excluded.id);
  if (exact) return exact;
  if (!excluded.asin || !/^[A-Z0-9]{10}$/.test(excluded.asin)) return null;
  if (excluded.id.startsWith("amazon:") && excluded.id !== `amazon:${market}:${excluded.asin}`) return null;
  const matches = candidates.filter(item => item.asin === excluded.asin);
  return matches.length === 1 ? matches[0] : null;
}
