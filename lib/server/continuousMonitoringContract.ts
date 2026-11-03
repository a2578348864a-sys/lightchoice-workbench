import type { MonitoringFieldRule, MonitoringPolicy } from "@/lib/server/continuousMonitoringDiff";

export const MONITORING_CAPTURE_MODULE = "amazon_detail" as const;
export const MONITORING_SCHEDULES = ["daily@09:00", "daily@21:00"] as const;
export type MonitoringSchedule = (typeof MONITORING_SCHEDULES)[number];

export const DEFAULT_MONITORING_POLICY: MonitoringPolicy = Object.freeze({
  cooldownMinutes: 120,
  rules: Object.freeze([
    Object.freeze({ field: "price", comparison: "numeric_delta", absoluteThreshold: 0.5, relativeThreshold: 0.05, enabled: true }),
    Object.freeze({ field: "rating", comparison: "numeric_delta", absoluteThreshold: 0.1, relativeThreshold: null, enabled: true }),
    Object.freeze({ field: "reviewCount", comparison: "numeric_delta", absoluteThreshold: 1, relativeThreshold: null, enabled: true }),
  ]),
});

const ALLOWED_FIELDS = new Set(["price", "rating", "reviewCount"]);
const ABSOLUTE_THRESHOLD_MAX: Readonly<Record<string, number>> = Object.freeze({
  price: 100_000,
  rating: 5,
  reviewCount: 100_000_000,
});
const MAX_POLICY_BYTES = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseThreshold(value: unknown, max: number): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) return undefined;
  return value;
}

/** Validate stored/API policy against V1's reviewed Amazon Detail metric allowlist. */
export function parseMonitoringPolicy(value: unknown): MonitoringPolicy | null {
  if (!isRecord(value) || !Array.isArray(value.rules) || value.rules.length === 0 || value.rules.length > 3) return null;
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_POLICY_BYTES) return null;
  } catch {
    return null;
  }

  const cooldownMinutes = value.cooldownMinutes;
  if (typeof cooldownMinutes !== "number"
    || !Number.isInteger(cooldownMinutes)
    || cooldownMinutes < 0
    || cooldownMinutes > 1_440) return null;

  const seen = new Set<string>();
  const rules: MonitoringFieldRule[] = [];
  for (const rawRule of value.rules) {
    if (!isRecord(rawRule)
      || typeof rawRule.field !== "string"
      || !ALLOWED_FIELDS.has(rawRule.field)
      || seen.has(rawRule.field)
      || rawRule.comparison !== "numeric_delta"
      || typeof rawRule.enabled !== "boolean") return null;
    const maxAbsolute = ABSOLUTE_THRESHOLD_MAX[rawRule.field];
    const absoluteThreshold = parseThreshold(rawRule.absoluteThreshold, maxAbsolute);
    const relativeThreshold = parseThreshold(rawRule.relativeThreshold, 10);
    if (absoluteThreshold === undefined
      || relativeThreshold === undefined
      || (absoluteThreshold === null && relativeThreshold === null)) return null;
    seen.add(rawRule.field);
    rules.push({
      field: rawRule.field,
      comparison: "numeric_delta",
      absoluteThreshold,
      relativeThreshold,
      enabled: rawRule.enabled,
    });
  }
  if (!rules.some((rule) => rule.enabled)) return null;
  return { cooldownMinutes, rules };
}

export function isMonitoringSchedule(value: unknown): value is MonitoringSchedule {
  return typeof value === "string" && MONITORING_SCHEDULES.includes(value as MonitoringSchedule);
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 80 || value.trim() !== value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

type LocalDateParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function localParts(at: Date, timeZone: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function localWallTimeToUtc(parts: LocalDateParts, timeZone: string): Date | null {
  const desiredWallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let candidateMs = desiredWallAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = localParts(new Date(candidateMs), timeZone);
    const observedWallAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
    const correction = desiredWallAsUtc - observedWallAsUtc;
    if (correction === 0) break;
    candidateMs += correction;
  }
  const candidate = new Date(candidateMs);
  const verified = localParts(candidate, timeZone);
  return verified.year === parts.year
    && verified.month === parts.month
    && verified.day === parts.day
    && verified.hour === parts.hour
    && verified.minute === parts.minute
    ? candidate
    : null;
}

/**
 * Compute the next daily wall-clock occurrence in an IANA timezone. The two
 * supported V1 times avoid the common DST ambiguity window; nonexistent local
 * times fail closed instead of silently shifting the watch schedule.
 */
export function nextMonitoringRunAt(
  schedule: MonitoringSchedule,
  timeZone: string,
  now: Date,
): Date {
  if (!isMonitoringSchedule(schedule) || !isValidTimeZone(timeZone) || !Number.isFinite(now.getTime())) {
    throw new Error("MONITORING_SCHEDULE_INVALID");
  }
  const [hourText, minuteText] = schedule.slice("daily@".length).split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const today = localParts(now, timeZone);
  let target: LocalDateParts = { ...today, hour, minute, second: 0 };
  let next = localWallTimeToUtc(target, timeZone);
  if (!next) throw new Error("MONITORING_SCHEDULE_LOCAL_TIME_INVALID");
  if (next.getTime() <= now.getTime()) {
    const nextDate = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
    target = {
      ...target,
      year: nextDate.getUTCFullYear(),
      month: nextDate.getUTCMonth() + 1,
      day: nextDate.getUTCDate(),
    };
    next = localWallTimeToUtc(target, timeZone);
  }
  if (!next || next.getTime() <= now.getTime()) throw new Error("MONITORING_SCHEDULE_LOCAL_TIME_INVALID");
  return next;
}
