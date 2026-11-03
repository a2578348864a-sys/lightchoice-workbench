/**
 * PH4-H0 溯源收口：方向确定性 + 单点/多点语义 + 身份附件读回
 * SPIKE_ONLY
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  adaptV3HistoricalTrendAttachment,
  summarizeTrendObservations,
} from "@/lib/server/research/v3EvidenceResearchAdapter";
import { buildTrendObservation } from "@/lib/sourceLayer/v2/contracts";

const LIVE_STORE_ROOT = process.env.LIGHTCHOICE_LIVE_EVIDENCESTORE_DIR;
const LIVE_FIXTURE_TESTS_ENABLED = process.env.LIGHTCHOICE_LIVE_EVIDENCESTORE_TESTS === "1" && Boolean(LIVE_STORE_ROOT);
const NEW_ATT = LIVE_STORE_ROOT
  ? join(LIVE_STORE_ROOT, "owner-v1", "subjects", "amazon%3AUS%3AB07Z5K2X2C")
  : "";

function loadLatestKeepaStyleTrend(): Record<string, unknown> | null {
  const files = readdirSync(NEW_ATT).filter((f) => f.startsWith("a-") && f.endsWith(".json") && !f.endsWith(".meta.json"));
  for (const f of files) {
    const raw = readFileSync(`${NEW_ATT}/${f}`, "utf8");
    if (raw.includes("att-4fddc36e5f8a02e94b98ba6c") || raw.includes("identity_locked") || raw.includes("visible_tooltip_hover_identity_locked")) {
      return JSON.parse(raw);
    }
  }
  for (const f of files) {
    const raw = readFileSync(`${NEW_ATT}/${f}`, "utf8");
    if (raw.includes("c4e94f23307cd9b65dae8e649cd3698a96ebb31a3eb26e6a87662efa7b3da1c5")) {
      return JSON.parse(raw);
    }
  }
  return null;
}

function obsFromValues(values: number[]) {
  return values.map((value, i) =>
    buildTrendObservation({
      observationId: `t:${i}`,
      subjectKey: "amazon:US:B0TEST00001",
      field: "test.metric",
      value,
      valueKind: "observed",
      sourceType: "sellersprite_plugin",
      capturedAt: `2025-0${(i % 9) + 1}-01T00:00:00.000Z`,
      evidenceRefs: ["attachment:att-test"],
    })
  );
}

describe("PH4-H0 Trend Summary direction determinism", () => {
  it("100→120→150 is rising", () => {
    const s = summarizeTrendObservations(obsFromValues([100, 120, 150]));
    expect(s!.metrics["test.metric"].direction).toBe("rising");
    expect(s!.metrics["test.metric"].startValue).toBe(100);
    expect(s!.metrics["test.metric"].endValue).toBe(150);
  });

  it("150→120→100 is falling", () => {
    const s = summarizeTrendObservations(obsFromValues([150, 120, 100]));
    expect(s!.metrics["test.metric"].direction).toBe("falling");
  });

  it("100→100→100 is stable", () => {
    const s = summarizeTrendObservations(obsFromValues([100, 100, 100]));
    expect(s!.metrics["test.metric"].direction).toBe("stable");
  });

  it("100→150→100 is fluctuating (first==last but range exists)", () => {
    const s = summarizeTrendObservations(obsFromValues([100, 150, 100]));
    expect(s!.metrics["test.metric"].direction).toBe("fluctuating");
  });

  it("single point is unknown, not stable", () => {
    const s = summarizeTrendObservations(obsFromValues([42]));
    expect(s!.metrics["test.metric"].direction).toBe("unknown");
  });

  it("does not mix fields", () => {
    const a = buildTrendObservation({
      observationId: "a1",
      subjectKey: "amazon:US:B0TEST00001",
      field: "m.a",
      value: 100,
      valueKind: "observed",
      sourceType: "sellersprite_plugin",
      capturedAt: "2025-01-01T00:00:00.000Z",
      evidenceRefs: ["attachment:x"],
    });
    const b = buildTrendObservation({
      observationId: "b1",
      subjectKey: "amazon:US:B0TEST00001",
      field: "m.b",
      value: 50,
      valueKind: "observed",
      sourceType: "sellersprite_plugin",
      capturedAt: "2025-02-01T00:00:00.000Z",
      evidenceRefs: ["attachment:x"],
    });
    const s = summarizeTrendObservations([a, b]);
    expect(Object.keys(s!.metrics).sort()).toEqual(["m.a", "m.b"]);
    expect(s!.metrics["m.a"].direction).toBe("unknown"); // single point each
  });
});

describe.skipIf(!LIVE_FIXTURE_TESTS_ENABLED)("PH4-H0 identity-locked attachment readback", () => {
  let att: Record<string, unknown> | null = null;
  beforeAll(() => {
    att = loadLatestKeepaStyleTrend();
  });
  it("loads new identity-locked evidence", () => {
    expect(att).toBeTruthy();
    expect(att!.kind).toBe("v3_historical_trend_v1");
    expect(att!.sourceType).toBe("sellersprite_plugin");
    expect(att!.subjectKey).toBe("amazon:US:B07Z5K2X2C");
    expect(att!.contentHash).toMatch(/^c4e94f23|^[a-f0-9]{64}$/u);
  });

  it("server capturedAt is near wall clock and after browserObservedAt in data", () => {
    expect(att).toBeTruthy();
    const cap = Date.parse(String(att!.capturedAt));
    // 2026-10-09 window of this session
    expect(cap).toBeGreaterThan(Date.parse("2026-10-09T00:00:00.000Z"));
    expect(cap).toBeLessThan(Date.parse("2026-10-10T00:00:00.000Z"));
    const payload = att!.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    const observed = data.browserObservedAt as string;
    expect(Date.parse(observed)).toBeLessThanOrEqual(cap + 60_000);
    // not the old fake fixed time
    expect(att!.capturedAt).not.toBe("2026-10-09T12:30:00.000Z");
  });

  it("adapts series with observation periods distinct from capture time", () => {
    const obs = adaptV3HistoricalTrendAttachment(att as never, "amazon:US:B07Z5K2X2C");
    expect(obs.length).toBeGreaterThan(15);
    const periods = [...new Set(obs.map((o) => o.capturedDate))].sort();
    expect(periods[0]).toMatch(/^20\d{2}-\d{2}/);
    expect(obs.every((o) => o.capturedDate !== String(att!.capturedAt).slice(0, 10))).toBe(true);
    expect(obs.every((o) => o.sourceType === "sellersprite_plugin")).toBe(true);
    expect(obs.some((o) => o.field.includes("自然流量"))).toBe(true);
  });

  it("count vs sharePct kept as distinct metrics", () => {
    const obs = adaptV3HistoricalTrendAttachment(att as never, "amazon:US:B07Z5K2X2C");
    const fields = new Set(obs.map((o) => o.field));
    expect([...fields].some((f) => f.includes("自然流量"))).toBe(true);
    expect([...fields].some((f) => f.includes("sharePct") || f.includes("%"))).toBe(true);
    // 348 and 46.96 are different field values if both present
    const natural = obs.filter((o) => o.field.includes("自然流量") && !o.field.includes("sharePct"));
    if (natural.length) {
      expect(typeof natural[0].value).toBe("number");
    }
  });
});
