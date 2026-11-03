import { describe, expect, it } from "vitest";
import { evaluateMarketSampleValidity, resolveDeterministicMarketSamples } from "@/lib/marketScan/marketSampleValidity";
import { projectFrozenMarketValidity } from "@/lib/marketScan/frozenMarketValidity";
import { buildSampleSnapshot, computeMarketMetricsV1 } from "@/lib/marketScan/metrics";
import { makeSampleInput, FIXTURE_NICHE_DEFINITION, FIXTURE_SAMPLE_DEFINITION, FIXTURE_REFERENCE_DATE } from "@/lib/marketScan/__fixtures__/productFactFixture";
const bound = { id: "a", ordinal: 0, asin: "B000000001", subjectKey: "amazon:US:B000000001", marketplace: "US",
  factValues: { asin: "B000000001", title: { presence: "present", value: "观察到的商品" } }, evidenceId: "ev-bound", evidenceVersion: 1,
  sourceProofHash: "a".repeat(64), capturedAt: "2026-10-01T01:00:00.000Z", integrityValid: true, evidenceStatus: "limited_evidence" };
describe("P5 deterministic validity independent from completeness", () => {
  it("limited evidence with bound title is valid without price, demand or brand", () => {
    expect(evaluateMarketSampleValidity(bound).valid).toBe(true);
    expect(resolveDeterministicMarketSamples({ items: [bound], marketplace: "US" }).validCount).toBe(1);
  });
  it.each([{ asin: "invalid" }, { subjectKey: "amazon:CA:B000000001" }, { subjectKey: "amazon:US:B000000002" },
    { factValues: { asin: "B000000001", title: { presence: "missing" } } }, { evidenceVersion: 0 }, { evidenceId: "" },
    { sourceProofHash: "wrong" }, { capturedAt: "unknown" }, { integrityValid: false }, { evidenceStatus: "blocked" }, { evidenceStatus: "corrupted" }])("excludes invalid required identity/proof %j", (change) => {
    expect(evaluateMarketSampleValidity({ ...bound, ...change }).valid).toBe(false);
  });
  it("collapses duplicate identities and deterministic parent families", () => {
    const items = [bound, { ...bound, id: "duplicate", ordinal: 1 }, { ...bound, id: "child", ordinal: 2, asin: "B000000002", subjectKey: "amazon:US:B000000002", factValues: { ...bound.factValues, asin: "B000000002" }, parentAsin: bound.asin }];
    expect(resolveDeterministicMarketSamples({ items, marketplace: "US" }).validCount).toBe(1);
  });
  it("legacy snapshot self-fingerprint corruption cannot count; read projection leaves input intact", () => {
    const snapshot = buildSampleSnapshot({ nicheDefinition: FIXTURE_NICHE_DEFINITION, sampleDefinition: FIXTURE_SAMPLE_DEFINITION, metricsVersion: "market-metrics.v1", sample: [makeSampleInput({ asin: bound.asin })] });
    const original = JSON.stringify(snapshot);
    expect(projectFrozenMarketValidity(snapshot.items as unknown as Record<string, unknown>[], "US").validCount).toBe(1);
    expect(projectFrozenMarketValidity([{ ...snapshot.items[0], factValuesFingerprint: "bad" }], "US").validCount).toBe(0);
    expect(projectFrozenMarketValidity([{ ...snapshot.items[0], sampleValidityPolicyVersion: "unsupported.v99" }], "US").validCount).toBe(0);
    expect(JSON.stringify(snapshot)).toBe(original);
  });
  it("adapted WT-M eligibility regression uses actual identity mismatch rather than display fixture labels", () => {
    const valid = makeSampleInput({ asin: "B000000001", monthlySalesEstimate: null, price: 21 });
    const invalid = makeSampleInput({ asin: "B000000002", subjectKey: "amazon:US:B000000003", price: 99 });
    const foreign = makeSampleInput({ asin: "B000000003", subjectKey: "amazon:CA:B000000003", price: 33 });
    const metrics = computeMarketMetricsV1({ sample: [valid, valid, invalid, foreign], referenceDate: FIXTURE_REFERENCE_DATE, marketplace: "US" });
    expect(metrics.sampleCount).toBe(4); expect(metrics.validSampleCount).toBe(1); expect(metrics.price.sampleSize).toBe(1);
    expect(metrics.price.value?.median).toBe(21); expect(metrics.sales.status).toBe("NOT_AVAILABLE");
  });
});
