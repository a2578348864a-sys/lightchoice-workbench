/** Candidate metadata is a display fallback, never a ProductFact or hash input. */
export function researchDisplayIdentity(meta: Record<string, unknown>, facts: {
  brand: string | null; price: number | null; rating: number | null; reviewCount: number | null; mainCategory: string | null; imageUrl: string | null;
}) {
  const identity = typeof meta.identity === "object" && meta.identity !== null && !Array.isArray(meta.identity) ? meta.identity as Record<string, unknown> : {};
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    nature: "DISPLAY_ONLY" as const, label: "非证据值" as const,
    brand: facts.brand === null ? text(identity.brand) : null,
    category: facts.mainCategory === null ? text(identity.category) : null,
    imageUrl: facts.imageUrl === null ? text(identity.imageUrl ?? identity.image) : null,
    price: facts.price === null ? number(identity.priceUsd ?? identity.price) : null,
    rating: facts.rating === null ? number(identity.rating) : null,
    reviewCount: facts.reviewCount === null ? number(identity.reviewCount) : null,
  };
}
export type ResearchDisplayIdentity = ReturnType<typeof researchDisplayIdentity>;
