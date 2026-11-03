/**
 * Explicit contract for a genuinely structured historical trend series.
 * A screenshot, plotted curve, or caller assertion is not a time-series value.
 */

export type HistoricalTrendMetricNature = "source_observed" | "provider_observed" | "provider_estimate";
export type HistoricalTrendAcquisitionMode = "DOM_DIRECT" | "VISIBLE_CHART" | "FILE_EXPORT" | "SCREENSHOT_EVIDENCE";

export type HistoricalTrendSeriesV1 = {
  schemaVersion: "historical-trend-series.v1";
  identity: { marketplace: string; asin: string };
  provider: string;
  sourceUrl: string;
  acquisitionMode: HistoricalTrendAcquisitionMode;
  metric: {
    key: string;
    unit: string;
    nature: HistoricalTrendMetricNature;
    periodStart: string;
    periodEnd: string;
    timeZone: string;
  };
  points: Array<{ observedAt: string; value: number; evidenceRef: string }>;
};

export type HistoricalTrendParseError =
  | "series_invalid"
  | "identity_invalid"
  | "provenance_invalid"
  | "metric_contract_invalid"
  | "period_invalid"
  | "timezone_invalid"
  | "screenshot_is_not_structured_data"
  | "points_invalid";

export type HistoricalTrendParseResult =
  | { ok: true; series: HistoricalTrendSeriesV1 }
  | { ok: false; code: HistoricalTrendParseError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validHttpsUrl(value: unknown): value is string {
  if (!nonEmpty(value, 2048)) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Parse fail-closed: no value is inferred from an image or a missing label. */
export function parseHistoricalTrendSeries(value: unknown): HistoricalTrendParseResult {
  if (!isRecord(value) || value.schemaVersion !== "historical-trend-series.v1") {
    return { ok: false, code: "series_invalid" };
  }
  const identity = value.identity;
  if (!isRecord(identity)
    || !nonEmpty(identity.marketplace, 8)
    || !/^[A-Z]{2}$/u.test(identity.marketplace.trim().toUpperCase())
    || typeof identity.asin !== "string"
    || !/^[A-Z0-9]{10}$/u.test(identity.asin.trim().toUpperCase())) {
    return { ok: false, code: "identity_invalid" };
  }
  if (!nonEmpty(value.provider, 80)
    || !validHttpsUrl(value.sourceUrl)
    || !["DOM_DIRECT", "VISIBLE_CHART", "FILE_EXPORT", "SCREENSHOT_EVIDENCE"].includes(String(value.acquisitionMode))) {
    return { ok: false, code: "provenance_invalid" };
  }
  if (value.acquisitionMode === "SCREENSHOT_EVIDENCE") {
    return { ok: false, code: "screenshot_is_not_structured_data" };
  }
  const metric = value.metric;
  if (!isRecord(metric)
    || !nonEmpty(metric.key, 100)
    || !nonEmpty(metric.unit, 40)
    || !["source_observed", "provider_observed", "provider_estimate"].includes(String(metric.nature))) {
    return { ok: false, code: "metric_contract_invalid" };
  }
  if (!validDate(metric.periodStart) || !validDate(metric.periodEnd)
    || Date.parse(metric.periodStart) > Date.parse(metric.periodEnd)) {
    return { ok: false, code: "period_invalid" };
  }
  if (!nonEmpty(metric.timeZone, 80)) return { ok: false, code: "timezone_invalid" };
  try {
    new Intl.DateTimeFormat("en", { timeZone: metric.timeZone }).format(0);
  } catch {
    return { ok: false, code: "timezone_invalid" };
  }
  if (!Array.isArray(value.points) || value.points.length === 0 || value.points.length > 20_000) {
    return { ok: false, code: "points_invalid" };
  }
  const points: HistoricalTrendSeriesV1["points"] = [];
  const seen = new Set<string>();
  for (const point of value.points) {
    if (!isRecord(point)
      || !validDate(point.observedAt)
      || typeof point.value !== "number"
      || !Number.isFinite(point.value)
      || !nonEmpty(point.evidenceRef, 240)) {
      return { ok: false, code: "points_invalid" };
    }
    const observedAt = new Date(point.observedAt).toISOString();
    const observedMs = Date.parse(observedAt);
    if (observedMs < Date.parse(metric.periodStart) || observedMs > Date.parse(metric.periodEnd)) {
      return { ok: false, code: "points_invalid" };
    }
    if (seen.has(observedAt)) return { ok: false, code: "points_invalid" };
    seen.add(observedAt);
    points.push({ observedAt, value: point.value, evidenceRef: point.evidenceRef.trim() });
  }
  points.sort((left, right) => left.observedAt.localeCompare(right.observedAt));

  return {
    ok: true,
    series: {
      schemaVersion: "historical-trend-series.v1",
      identity: {
        marketplace: identity.marketplace.trim().toUpperCase(),
        asin: identity.asin.trim().toUpperCase(),
      },
      provider: value.provider.trim(),
      sourceUrl: value.sourceUrl.trim(),
      acquisitionMode: value.acquisitionMode as HistoricalTrendAcquisitionMode,
      metric: {
        key: metric.key.trim(),
        unit: metric.unit.trim(),
        nature: metric.nature as HistoricalTrendMetricNature,
        periodStart: new Date(metric.periodStart).toISOString(),
        periodEnd: new Date(metric.periodEnd).toISOString(),
        timeZone: metric.timeZone.trim(),
      },
      points,
    },
  };
}
