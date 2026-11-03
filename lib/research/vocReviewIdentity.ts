export type VocReviewIdentityInput = {
  text: string | null | undefined;
  rating: number | null | undefined;
};

/**
 * Content identity used when a source does not expose a stable review ID.
 * Matching rating + normalized text is deliberately conservative: repeated
 * captures of the same visible Amazon comment cannot inflate independent-review
 * strength, even if the capture generated a different externalContentId.
 */
export function vocReviewContentIdentity(input: VocReviewIdentityInput): string | null {
  const normalizedText = input.text
    ?.normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();

  if (!normalizedText) return null;
  const rating = typeof input.rating === "number" && Number.isFinite(input.rating)
    ? String(input.rating)
    : "unknown";
  return `${rating}:${normalizedText}`;
}
