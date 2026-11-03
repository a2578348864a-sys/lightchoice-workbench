import type { ResearchInputBundleEvidenceRef } from "@/lib/sourceLayer/v2/contracts";
import type { AdaptedV3ProductMarket } from "@/lib/server/research/v3EvidenceResearchAdapter";

export const PROVIDER_PRODUCT_MARKET_EVIDENCE_SCHEMA = "provider-product-market-evidence.v1" as const;

export type ResearchProviderProductMarketMetric = {
  readonly metric: string;
  readonly value: number;
  readonly unit: "count" | "currency" | "unknown";
  readonly currency: string | null;
  readonly metricNature: "provider_observed" | "provider_estimate";
  readonly status: "parsed";
  readonly raw: string;
  readonly scope: string | null;
};

/**
 * EvidenceStore 中精确绑定到单个 ASIN 的第三方商品市场观察。
 * 它是 Research 的只读输入，不会成为 Amazon ProductFact 或事实库。
 */
export type ResearchProviderProductMarketEvidence = {
  readonly schemaVersion: typeof PROVIDER_PRODUCT_MARKET_EVIDENCE_SCHEMA;
  readonly provider: string;
  readonly module: "sellersprite_product_market";
  readonly subjectKey: string;
  readonly marketplace: string;
  readonly asin: string;
  readonly parentAsin: string | null;
  readonly sourceType: string;
  readonly sourceSurface: string;
  readonly sourceUrl: string | null;
  readonly evidenceRefId: string;
  readonly attachmentId: string;
  readonly contentHash: string;
  readonly capturedAt: string;
  readonly observedAt: string | null;
  /** 当前来源未声明指标周期时保持 null。 */
  readonly metricPeriod: string | null;
  readonly metricNature: "provider_observed" | "provider_estimate";
  readonly limitations: readonly string[];
  readonly metrics: readonly ResearchProviderProductMarketMetric[];
};

export function bindProviderProductMarketEvidence(input: {
  readonly adapted: readonly AdaptedV3ProductMarket[];
  readonly refs: readonly ResearchInputBundleEvidenceRef[];
  readonly subjectKey: string;
  readonly asin: string | null;
}): ResearchProviderProductMarketEvidence[] {
  if (!input.asin) return [];

  const attachmentRefs = new Map(
    input.refs
      .filter((ref) => ref.kind === "attachment" && typeof ref.attachmentId === "string" && ref.attachmentId)
      .map((ref) => [ref.refId, ref]),
  );
  const out: ResearchProviderProductMarketEvidence[] = [];

  for (const item of input.adapted) {
    const ref = attachmentRefs.get(item.evidenceRef);
    if (!ref || ref.attachmentId !== item.attachmentId) continue;
    if (ref.subjectKey !== item.subjectKey || item.subjectKey !== input.subjectKey || item.asin !== input.asin) continue;
    if (ref.contentHash !== item.contentHash || ref.capturedAt !== item.capturedAt) continue;
    if (!/^[a-f0-9]{64}$/iu.test(item.contentHash)) continue;
    if (item.provider.trim().toLowerCase() !== "sellersprite" || item.sourceType !== "sellersprite_plugin") continue;
    if (item.metricNature !== "provider_observed" && item.metricNature !== "provider_estimate") continue;

    const metrics = item.productMetrics.flatMap((metric) => {
      if (metric.metricNature !== item.metricNature || !Number.isFinite(metric.value)) return [];
      return [{
        metric: metric.metric,
        value: metric.value,
        unit: metric.unit,
        currency: metric.currency ?? null,
        metricNature: metric.metricNature,
        status: "parsed" as const,
        raw: metric.raw,
        scope: metric.scope ?? null,
      }];
    });
    if (metrics.length === 0) continue;

    out.push({
      schemaVersion: PROVIDER_PRODUCT_MARKET_EVIDENCE_SCHEMA,
      provider: item.provider,
      module: item.module,
      subjectKey: item.subjectKey,
      marketplace: item.marketplace,
      asin: item.asin,
      parentAsin: item.parentAsin,
      sourceType: item.sourceType,
      sourceSurface: item.sourceSurface,
      sourceUrl: item.sourceUrl,
      evidenceRefId: item.evidenceRef,
      attachmentId: item.attachmentId,
      contentHash: item.contentHash,
      capturedAt: item.capturedAt,
      observedAt: isIsoDate(item.observedAt) ? item.observedAt : null,
      metricPeriod: null,
      metricNature: item.metricNature,
      limitations: [...item.limitations],
      metrics,
    });
  }

  return out.sort((a, b) => a.attachmentId.localeCompare(b.attachmentId)
    || a.contentHash.localeCompare(b.contentHash));
}

function isIsoDate(value: string | null): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}
