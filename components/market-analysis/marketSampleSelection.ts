type MarketSampleIdentity = {
  marketSampleKey?: string;
  asin: string;
};

type SavedRepresentativeIdentity = {
  marketSampleKey: string;
};

export function representativeDraftMatches(
  draft: readonly { marketSampleKey: string; role: string; note: string | null }[],
  saved: readonly { marketSampleKey: string; role: string; note: string | null }[],
) {
  return draft.length === saved.length && draft.every((item) => saved.some((row) => row.marketSampleKey === item.marketSampleKey && row.role === item.role && (row.note ?? "").trim() === (item.note ?? "").trim()));
}

export function marketSampleKeyFor(scanId: string, item: MarketSampleIdentity): string {
  return item.marketSampleKey?.trim() || `${scanId}:${item.asin.trim().toUpperCase()}`;
}

export function restoreRepresentativeSelection<TSample extends MarketSampleIdentity>(
  scanId: string,
  samples: readonly TSample[],
  representatives: readonly SavedRepresentativeIdentity[],
): Record<string, boolean> {
  const sampleKeys = new Set(samples.map((sample) => marketSampleKeyFor(scanId, sample)));
  return Object.fromEntries(
    representatives
      .filter((representative) => sampleKeys.has(representative.marketSampleKey))
      .map((representative) => [representative.marketSampleKey, true]),
  );
}

export function resolveSelectedMarketSamples<TSample extends MarketSampleIdentity>(
  scanId: string,
  samples: readonly TSample[],
  selection: Readonly<Record<string, boolean>>,
): TSample[] {
  return samples.filter((sample) => selection[marketSampleKeyFor(scanId, sample)] === true);
}

export function resolveResearchHandoffSamples<TSample extends MarketSampleIdentity>(
  scanId: string,
  samples: readonly TSample[],
  representatives: readonly SavedRepresentativeIdentity[],
  requestedMarketSampleKey?: string,
): TSample[] {
  const samplesByKey = new Map(samples.map((sample) => [marketSampleKeyFor(scanId, sample), sample]));

  if (requestedMarketSampleKey !== undefined) {
    if (!representatives.some((representative) => representative.marketSampleKey === requestedMarketSampleKey)) {
      return [];
    }

    const sample = samplesByKey.get(requestedMarketSampleKey);
    return sample ? [sample] : [];
  }

  return representatives
    .map((representative) => samplesByKey.get(representative.marketSampleKey))
    .filter((sample): sample is TSample => Boolean(sample));
}
