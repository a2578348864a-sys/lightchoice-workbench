import { deriveObservedAmazonMarketContext, type AmazonPageContextSignals, type AmazonSearchPageExtraction } from "./extract-search-page";
import { evaluateAmazonEnvironment, type AmazonEnvironmentGateResult } from "./environment-gate";

/**
 * Evaluate every Amazon search page from that page's own URL, delivery region,
 * language and observed prices. The caller's requested marketplace is never
 * treated as evidence that the rendered page actually matches it.
 */
export function evaluateAmazonSearchPageEnvironment(
  signals: AmazonPageContextSignals,
  extraction: Pick<AmazonSearchPageExtraction, "pageStatus" | "observations">,
): AmazonEnvironmentGateResult {
  const observed = deriveObservedAmazonMarketContext(
    signals,
    extraction.observations.map((item) => item.priceCurrency ?? null),
    "10001",
  );
  return evaluateAmazonEnvironment({
    pageStatus: extraction.pageStatus,
    pageUrl: signals.pageUrl,
    amazonBrandMarkerPresent: signals.amazonBrandMarkerPresent,
    deliveryRegion: signals.deliveryRegion,
    language: signals.language,
    currencyPreference: observed.currency,
  });
}
