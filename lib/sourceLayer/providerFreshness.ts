import type { V3ModuleId } from "@/lib/sourceLayer/v3ModuleEvidence";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * V3 provider cadence 是证据解释的一部分，不替代既有字段 expiration。
 * 未声明 provider 更新时间时保持 unknown，不能把采集时间冒充 provider 更新时间。
 */
export const V3_PROVIDER_CADENCE_MS = Object.freeze({
  amazon_price: 2 * DAY_MS,
  amazon_search: 3 * DAY_MS,
  amazon_detail_snapshot: 7 * DAY_MS,
  sellersprite_product_market: 7 * DAY_MS,
  sellersprite_reverse_asin: 30 * DAY_MS,
  keyword_monthly: 31 * DAY_MS,
  keyword_aba_weekly: 7 * DAY_MS,
  variation_snapshot: 7 * DAY_MS,
  review_voc_snapshot: 7 * DAY_MS,
  historical_window: 30 * DAY_MS,
} as const);

export type V3ProviderCadenceKey = keyof typeof V3_PROVIDER_CADENCE_MS;
export type V3FreshnessState = "fresh" | "stale" | "unknown";

export type V3FreshnessSnapshot = {
  cadenceKey: V3ProviderCadenceKey | null;
  ttlMs: number | null;
  providerUpdatedAt: string | null;
  ageMs: number | null;
  state: V3FreshnessState;
};

export function resolveV3ProviderCadence(input: {
  module: V3ModuleId;
  metricKey?: string | null;
}): { cadenceKey: V3ProviderCadenceKey | null; ttlMs: number | null } {
  const metricKey = input.metricKey?.trim().toLowerCase() ?? "";
  if (input.module === "amazon_detail" && metricKey === "price") return { cadenceKey: "amazon_price", ttlMs: V3_PROVIDER_CADENCE_MS.amazon_price };
  if (input.module === "amazon_detail") return { cadenceKey: "amazon_detail_snapshot", ttlMs: V3_PROVIDER_CADENCE_MS.amazon_detail_snapshot };
  if (input.module === "amazon_search_market") return { cadenceKey: "amazon_search", ttlMs: V3_PROVIDER_CADENCE_MS.amazon_search };
  if (input.module === "sellersprite_product_market") return { cadenceKey: "sellersprite_product_market", ttlMs: V3_PROVIDER_CADENCE_MS.sellersprite_product_market };
  if (input.module === "reverse_asin") return { cadenceKey: "sellersprite_reverse_asin", ttlMs: V3_PROVIDER_CADENCE_MS.sellersprite_reverse_asin };
  if (input.module === "keyword_mining_trend") {
    const cadenceKey = metricKey === "aba" || metricKey === "aba_rank" ? "keyword_aba_weekly" : "keyword_monthly";
    return { cadenceKey, ttlMs: V3_PROVIDER_CADENCE_MS[cadenceKey] };
  }
  if (input.module === "variation") return { cadenceKey: "variation_snapshot", ttlMs: V3_PROVIDER_CADENCE_MS.variation_snapshot };
  if (input.module === "review_voc") return { cadenceKey: "review_voc_snapshot", ttlMs: V3_PROVIDER_CADENCE_MS.review_voc_snapshot };
  return { cadenceKey: "historical_window", ttlMs: V3_PROVIDER_CADENCE_MS.historical_window };
}

export function evaluateV3ProviderFreshness(input: {
  module: V3ModuleId;
  metricKey?: string | null;
  providerUpdatedAt?: string | null;
  now: Date | string | number;
}): V3FreshnessSnapshot {
  const cadence = resolveV3ProviderCadence(input);
  const providerUpdatedAt = input.providerUpdatedAt?.trim() || null;
  const nowMs = input.now instanceof Date
    ? input.now.getTime()
    : typeof input.now === "number"
      ? input.now
      : Date.parse(input.now);
  const providerMs = providerUpdatedAt === null ? Number.NaN : Date.parse(providerUpdatedAt);
  if (providerUpdatedAt === null || !Number.isFinite(providerMs) || !Number.isFinite(nowMs)) {
    return { ...cadence, providerUpdatedAt, ageMs: null, state: "unknown" };
  }
  const ageMs = Math.max(0, nowMs - providerMs);
  return {
    ...cadence,
    providerUpdatedAt,
    ageMs,
    state: cadence.ttlMs !== null && ageMs <= cadence.ttlMs ? "fresh" : "stale",
  };
}
