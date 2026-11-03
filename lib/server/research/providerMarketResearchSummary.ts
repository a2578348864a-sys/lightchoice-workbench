import type { ResearchInputBundleEvidenceRef, ResearchProviderMetricEvidence, TrendObservation } from "@/lib/sourceLayer/v2/contracts";
import type { ResearchProviderProductMarketEvidence } from "@/lib/server/research/providerProductMarketEvidence";
import { SELLERSPRITE_PROVIDER_NAME } from "@/lib/sourceLayer/v3ModuleRegistry";

export type ProviderMarketResearchMetricSummary = {
  readonly dimension: string | null;
  readonly metric: string;
  readonly value: number | string | boolean | null;
  readonly unit: string;
  readonly currency: string | null;
  readonly scope: string | null;
  readonly metricNature: "provider_observed" | "provider_estimate";
  readonly period: string | null;
  readonly status: "parsed" | "unknown";
  readonly raw: string | null;
  readonly trend?: {
    readonly pointsCount: number;
    readonly startValue: number | string | boolean | null;
    readonly endValue: number | string | boolean | null;
    readonly minValue: number | null;
    readonly maxValue: number | null;
    readonly conflictedInstantsCount: number;
    readonly direction: "rising" | "falling" | "stable" | "fluctuating" | "unknown";
  };
};

export type ProviderMarketResearchSourceSummary = {
  readonly provider: string;
  readonly module: string;
  readonly subjectKey: string;
  readonly marketplace: string;
  readonly asin: string | null;
  readonly parentAsin: string | null;
  readonly sourceType: string;
  readonly sourceSurface: string;
  readonly sourceUrl: string | null;
  readonly evidenceRefId: string;
  readonly attachmentId: string;
  readonly capturedAt: string;
  readonly observedAt: string | null;
  readonly metricPeriod: string | null;
  readonly metricNature: "provider_observed" | "provider_estimate";
  readonly limitations: readonly string[];
  readonly metrics: readonly ProviderMarketResearchMetricSummary[];
};

export type ProviderMarketResearchSummary = {
  readonly sources: readonly ProviderMarketResearchSourceSummary[];
};

/**
 * Create a compact, deterministic research prompt projection from already-bound
 * provider evidence. This function does not discover evidence or authorize refs.
 */
export function buildProviderMarketResearchSummary(input: {
  readonly subjectKey: string;
  readonly allowedEvidenceRefs: readonly string[];
  readonly sourceEvidenceRefs: readonly ResearchInputBundleEvidenceRef[];
  readonly providerMetricEvidence?: readonly ResearchProviderMetricEvidence[];
  readonly providerProductMarketEvidence?: readonly ResearchProviderProductMarketEvidence[];
  readonly trendObservations?: readonly TrendObservation[];
}): ProviderMarketResearchSummary | null {
  const allowed = new Set(input.allowedEvidenceRefs);
  const sources: ProviderMarketResearchSourceSummary[] = [];

  for (const item of input.providerMetricEvidence ?? []) {
    if (!isValidNature(item.metricNature) || item.provider.trim().toLowerCase() !== "sellersprite") continue;
    if (item.subjectKey !== input.subjectKey || item.queryIdentity.subjectKey !== item.subjectKey) continue;
    const subjectMatch = /^amazon:([A-Z]{2}):([A-Z0-9]{10})$/u.exec(item.subjectKey);
    if (!subjectMatch || subjectMatch[1] !== item.queryIdentity.marketplace
      || subjectMatch[2] !== item.queryIdentity.asin) continue;
    if (!isBoundProviderAttachment(item, input.subjectKey, input.sourceEvidenceRefs, allowed)) continue;
    const metrics = item.rows.flatMap((row) => row.metrics.flatMap((metric) => {
      if (!isValidNature(metric.metricNature)) return [];
      return [{
        dimension: row.keyword,
        metric: metric.metric,
        value: typeof metric.value === "number" && Number.isFinite(metric.value) ? metric.value : null,
        unit: metric.unit,
        currency: null,
        scope: null,
        metricNature: metric.metricNature,
        period: null,
        status: metric.status,
        raw: metric.raw,
      }];
    }));
    if (metrics.length === 0) continue;
    sources.push({
      provider: item.provider,
      module: item.module,
      subjectKey: item.subjectKey,
      marketplace: item.queryIdentity.marketplace,
      asin: item.queryIdentity.asin,
      parentAsin: null,
      sourceType: item.sourceType,
      sourceSurface: item.sourceSurface,
      sourceUrl: item.sourceUrl,
      evidenceRefId: item.evidenceRefId,
      attachmentId: item.attachmentId,
      capturedAt: item.capturedAt,
      observedAt: item.observedAt,
      metricPeriod: item.metricPeriod,
      metricNature: item.metricNature,
      limitations: [...item.limitations],
      metrics,
    });
  }

  for (const item of input.providerProductMarketEvidence ?? []) {
    if (!isValidNature(item.metricNature) || item.provider.trim().toLowerCase() !== "sellersprite") continue;
    if (item.subjectKey !== input.subjectKey || !isBoundProviderAttachment(item, input.subjectKey, input.sourceEvidenceRefs, allowed)) continue;
    const metrics = item.metrics.flatMap((metric) => {
      if (metric.metricNature !== item.metricNature || !Number.isFinite(metric.value)) return [];
      return [{
        dimension: null,
        metric: metric.metric,
        value: metric.value,
        unit: metric.unit,
        currency: metric.currency,
        scope: metric.scope,
        metricNature: metric.metricNature,
        period: null,
        status: metric.status,
        raw: metric.raw,
      }];
    });
    if (metrics.length === 0) continue;
    sources.push({
      provider: item.provider,
      module: item.module,
      subjectKey: item.subjectKey,
      marketplace: item.marketplace,
      asin: item.asin,
      parentAsin: item.parentAsin,
      sourceType: item.sourceType,
      sourceSurface: item.sourceSurface,
      sourceUrl: item.sourceUrl,
      evidenceRefId: item.evidenceRefId,
      attachmentId: item.attachmentId,
      capturedAt: item.capturedAt,
      observedAt: item.observedAt,
      metricPeriod: item.metricPeriod,
      metricNature: item.metricNature,
      limitations: [...item.limitations],
      metrics,
    });
  }

  const trendPoints = new Map<string, {
    readonly ref: ResearchInputBundleEvidenceRef & { readonly attachmentId: string };
    readonly subjectKey: string;
    readonly field: string;
    readonly observations: TrendObservation[];
  }>();
  for (const observation of input.trendObservations ?? []) {
    if (observation.subjectKey !== input.subjectKey || observation.sourceType !== "sellersprite_plugin"
      || observation.valueKind !== "estimated") continue;
    const attachmentRefs = [...new Set(observation.evidenceRefs.filter((ref) => ref.startsWith("attachment:")))];
    if (attachmentRefs.length !== 1) continue;
    const evidenceRefId = attachmentRefs[0];
    if (!allowed.has(evidenceRefId)) continue;
    const ref = input.sourceEvidenceRefs.find((candidate) => candidate.refId === evidenceRefId);
    if (ref?.kind !== "attachment" || !ref.attachmentId || ref.subjectKey !== observation.subjectKey
      || !/^[a-f0-9]{64}$/iu.test(ref.contentHash) || !Number.isFinite(Date.parse(ref.capturedAt))) continue;

    const marketplace = /^amazon:([A-Z]{2}):([A-Z0-9]{10})$/u.exec(observation.subjectKey);
    if (!marketplace) continue;
    const key = `${ref.attachmentId}:${ref.contentHash}:${ref.capturedAt}:${observation.field}`;
    const existing = trendPoints.get(key);
    if (existing) trendPoints.set(key, { ...existing, observations: [...existing.observations, observation] });
    else trendPoints.set(key, {
      ref: ref as ResearchInputBundleEvidenceRef & { readonly attachmentId: string },
      subjectKey: observation.subjectKey,
      field: observation.field,
      observations: [observation],
    });
  }

  const sellerSpriteTrends = new Map<string, { source: ProviderMarketResearchSourceSummary; metrics: ProviderMarketResearchMetricSummary[] }>();
  for (const item of trendPoints.values()) {
    const sorted = [...item.observations].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    const values = sorted.map((observation) => observation.value);
    const numericValues = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const byInstant = new Map<string, Set<string>>();
    for (const observation of sorted) {
      const valuesAtInstant = byInstant.get(observation.capturedAt) ?? new Set<string>();
      valuesAtInstant.add(JSON.stringify(observation.value));
      byInstant.set(observation.capturedAt, valuesAtInstant);
    }
    const conflictedInstantsCount = [...byInstant.values()].filter((instantValues) => instantValues.size > 1).length;
    const startInstant = sorted[0]?.capturedAt;
    const endInstant = sorted.at(-1)?.capturedAt;
    const startValues = startInstant ? [...(byInstant.get(startInstant) ?? [])] : [];
    const endValues = endInstant ? [...(byInstant.get(endInstant) ?? [])] : [];
    const startValue = startValues.length === 1 ? JSON.parse(startValues[0]) as number | string | boolean | null : null;
    const endValue = endValues.length === 1 ? JSON.parse(endValues[0]) as number | string | boolean | null : null;
    const minValue = numericValues.length > 0 ? Math.min(...numericValues) : null;
    const maxValue = numericValues.length > 0 ? Math.max(...numericValues) : null;
    let direction: NonNullable<ProviderMarketResearchMetricSummary["trend"]>["direction"] = "unknown";
    if (conflictedInstantsCount === 0 && numericValues.length > 1 && startValue !== null && endValue !== null
      && typeof startValue === "number" && typeof endValue === "number") {
      direction = minValue === maxValue
        ? "stable"
        : endValue > startValue ? "rising" : endValue < startValue ? "falling" : "fluctuating";
    }
    const firstPeriod = sorted[0]?.capturedDate ?? null;
    const lastPeriod = sorted.at(-1)?.capturedDate ?? null;
    const metric: ProviderMarketResearchMetricSummary = {
      dimension: null,
      metric: item.field,
      value: null,
      unit: "unknown",
      currency: null,
      scope: null,
      metricNature: "provider_estimate",
      period: firstPeriod === lastPeriod ? firstPeriod : `${firstPeriod} ~ ${lastPeriod}`,
      status: values.some((value) => value !== null) ? "parsed" : "unknown",
      raw: null,
      trend: {
        pointsCount: sorted.length,
        startValue,
        endValue,
        minValue,
        maxValue,
        conflictedInstantsCount,
        direction,
      },
    };
    const sourceKey = `${item.ref.attachmentId}:${item.ref.contentHash}:${item.ref.capturedAt}`;
    const existing = sellerSpriteTrends.get(sourceKey);
    if (existing) existing.metrics.push(metric);
    else sellerSpriteTrends.set(sourceKey, {
      source: {
        provider: SELLERSPRITE_PROVIDER_NAME,
        module: "historical_trend",
        subjectKey: item.subjectKey,
        marketplace: item.subjectKey.split(":")[1] ?? "unknown",
        asin: item.subjectKey.split(":").at(-1) ?? null,
        parentAsin: null,
        sourceType: "sellersprite_plugin",
        sourceSurface: "EvidenceStore historical trend projection",
        sourceUrl: null,
        evidenceRefId: `attachment:${item.ref.attachmentId}`,
        attachmentId: item.ref.attachmentId,
        capturedAt: item.ref.capturedAt,
        observedAt: null,
        metricPeriod: null,
        metricNature: "provider_estimate",
        limitations: ["source surface and module limitations are not retained on TrendObservation"],
        metrics: [],
      },
      metrics: [metric],
    });
  }
  for (const { source, metrics } of sellerSpriteTrends.values()) {
    sources.push({ ...source, metrics: metrics.sort((a, b) => a.metric.localeCompare(b.metric)) });
  }

  if (sources.length === 0) return null;
  return {
    sources: sources.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)
      || a.module.localeCompare(b.module)
      || a.attachmentId.localeCompare(b.attachmentId)),
  };
}

function isValidNature(value: string): value is "provider_observed" | "provider_estimate" {
  return value === "provider_observed" || value === "provider_estimate";
}

function isBoundProviderAttachment(
  item: {
    evidenceRefId: string;
    attachmentId: string;
    contentHash: string;
    capturedAt: string;
    subjectKey: string;
  },
  expectedSubjectKey: string,
  sourceEvidenceRefs: readonly ResearchInputBundleEvidenceRef[],
  allowedEvidenceRefs: ReadonlySet<string>,
): boolean {
  if (item.subjectKey !== expectedSubjectKey || !allowedEvidenceRefs.has(item.evidenceRefId)) return false;
  const ref = sourceEvidenceRefs.find((candidate) => candidate.refId === item.evidenceRefId);
  return ref?.kind === "attachment"
    && ref.attachmentId === item.attachmentId
    && ref.subjectKey === item.subjectKey
    && ref.contentHash === item.contentHash
    && ref.capturedAt === item.capturedAt;
}
