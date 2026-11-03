import type { GalleryItem } from "./presentation";

export type ProductSort = "original" | "price_asc" | "price_desc" | "rating_desc" | "reviews_desc";

/** Both views and T02 navigate this same order. Unknown/conflicting values stay last. */
export function sortBatchProducts<T extends GalleryItem>(items: readonly T[], sort: ProductSort): T[] {
  if (sort === "original") return [...items];
  const field = sort.startsWith("price") ? "price" : sort === "rating_desc" ? "rating" : "reviewCount";
  const number = (item: T): number | null => {
    const value = item[field];
    return value && !["conflict", "missing", "not_available"].includes(value.status)
      && typeof value.value === "number" && Number.isFinite(value.value) ? value.value : null;
  };
  return items.map((item, index) => ({ item, index })).sort((a, b) => {
    const av = number(a.item), bv = number(b.item);
    if (av === null || bv === null) return av === bv ? a.index - b.index : av === null ? 1 : -1;
    // Do not pretend different currencies are comparable; retain currency groups.
    if (field === "price") {
      const currency = (a.item.price?.currency ?? "").localeCompare(b.item.price?.currency ?? "");
      if (currency) return currency;
    }
    return (sort === "price_asc" ? av - bv : bv - av) || a.index - b.index;
  }).map(({ item }) => item);
}

/** Same search/status filter for gallery, table and review navigation. */
export function filterBatchProducts<T extends GalleryItem>(items: readonly T[], search: string, status: "all" | "ready" | "review" | "blocked"): T[] {
  const query = search.trim().toLowerCase();
  return items.filter(item => {
    if (status === "ready" && item.usageStatus !== "research_ready") return false;
    if (status === "review" && item.usageStatus !== "needs_review") return false;
    if (status === "blocked" && item.usageStatus !== "blocked") return false;
    return !query || [item.asin, item.title, item.brand, item.chineseTitle, item.chineseCategory].some(value => value?.toLowerCase().includes(query));
  });
}
