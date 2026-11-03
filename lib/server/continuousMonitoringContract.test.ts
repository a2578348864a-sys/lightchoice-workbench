import { describe, expect, it } from "vitest";

import {
  DEFAULT_MONITORING_POLICY,
  isMonitoringSchedule,
  isValidTimeZone,
  nextMonitoringRunAt,
  parseMonitoringPolicy,
} from "@/lib/server/continuousMonitoringContract";

describe("continuous monitoring contract", () => {
  it("rejects modules and metrics outside the reviewed Amazon Detail allowlist", () => {
    expect(isMonitoringSchedule("every_minute")).toBe(false);
    expect(parseMonitoringPolicy({ ...DEFAULT_MONITORING_POLICY, rules: [{
      field: "monthlySalesEstimate",
      comparison: "numeric_delta",
      absoluteThreshold: 1,
      relativeThreshold: null,
      enabled: true,
    }] })).toBeNull();
    expect(parseMonitoringPolicy({ ...DEFAULT_MONITORING_POLICY, rules: [{
      field: "reviewCount",
      comparison: "numeric_delta",
      absoluteThreshold: -1,
      relativeThreshold: null,
      enabled: true,
    }] })).toBeNull();
  });

  it("accepts only bounded, unique enabled rules and a bounded cooldown", () => {
    expect(parseMonitoringPolicy(DEFAULT_MONITORING_POLICY)).toEqual(DEFAULT_MONITORING_POLICY);
    expect(parseMonitoringPolicy({ ...DEFAULT_MONITORING_POLICY, cooldownMinutes: 1_441 })).toBeNull();
    expect(parseMonitoringPolicy({
      ...DEFAULT_MONITORING_POLICY,
      rules: [DEFAULT_MONITORING_POLICY.rules[0], DEFAULT_MONITORING_POLICY.rules[0]],
    })).toBeNull();
  });

  it("computes the next daily occurrence in local time across DST changes", () => {
    const now = new Date("2026-03-08T06:30:00.000Z");
    const next = nextMonitoringRunAt("daily@09:00", "America/New_York", now);
    expect(next.toISOString()).toBe("2026-03-08T13:00:00.000Z");
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it("rolls to the following local day when today's scheduled time passed", () => {
    const now = new Date("2026-09-27T10:00:00.000Z");
    const next = nextMonitoringRunAt("daily@09:00", "Asia/Shanghai", now);
    expect(next.toISOString()).toBe("2026-09-28T01:00:00.000Z");
  });

  it("rejects unknown or unrepresentable timezone inputs", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(() => nextMonitoringRunAt("daily@09:00", "Not/AZone", new Date())).toThrow("MONITORING_SCHEDULE_INVALID");
  });
});
