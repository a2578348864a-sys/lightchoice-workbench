/** Display projection only. Frozen snapshot facts and hashes remain untouched. */
export function projectMarketSampleDisplayFacts(value: unknown) {
  const facts = record(value);
  const text = (v: unknown): string | null => {
    const field = record(v);
    return field.presence === "present" && typeof field.value === "string" && field.value.trim() ? field.value.trim() : null;
  };
  const number = (v: unknown): number | null => {
    const field = record(v);
    return field.presence === "present" && typeof field.value === "number" && Number.isFinite(field.value) ? field.value : null;
  };
  const price = record(facts.price);
  const money = record(price.value);
  const hasPrice = price.presence === "present" && typeof money.amount === "number" && Number.isFinite(money.amount) && typeof money.currency === "string";
  return {
    title: text(facts.title), brand: text(facts.brand), category: text(facts.category),
    price: hasPrice ? money.amount as number : null,
    priceCurrency: hasPrice ? money.currency as string : null,
    rating: number(facts.rating), reviewCount: number(facts.reviewCount),
    monthlySalesEstimate: number(facts.monthlySalesEstimate), bsr: number(facts.bsr),
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function projectMarketMetricDisplaySummary(value: unknown) {
  const metrics = record(value);
  const price = record(metrics.price), priceValue = record(price.value);
  const cr5 = record(record(metrics.brandConcentration).brandCr5), cr5Value = record(cr5.value);
  return {
    medianPrice: price.status === "PRESENT" && typeof priceValue.median === "number" && Number.isFinite(priceValue.median) ? priceValue.median : null,
    cr5: cr5.status === "PRESENT" && typeof cr5Value.ratio === "number" && Number.isFinite(cr5Value.ratio) ? cr5Value.ratio : null,
  };
}
