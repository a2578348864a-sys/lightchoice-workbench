import { describe, expect, it } from "vitest";

import {
  representativeDraftMatches,
  marketSampleKeyFor,
  resolveResearchHandoffSamples,
  resolveSelectedMarketSamples,
  restoreRepresentativeSelection,
} from "@/components/market-analysis/marketSampleSelection";

type Sample = { asin: string; marketSampleKey?: string; title: string };

const scanId = "scan-1";
const samples: Sample[] = [
  { asin: "B000000001", title: "First product" },
  { asin: "B000000002", title: "Second product" },
  { asin: "B000000003", title: "Third product" },
];

describe("market sample selection", () => {
  it("separates a saved representative set from unsaved identity, role and reason changes", () => {
    const saved=[{marketSampleKey:"scan:A",role:"benchmark",note:"Evidence A"},{marketSampleKey:"scan:B",role:"pain_point",note:"Evidence B"}];
    expect(representativeDraftMatches([...saved].reverse(),saved)).toBe(true);
    expect(representativeDraftMatches([{...saved[0],marketSampleKey:"scan:C"},saved[1]],saved)).toBe(false);
    expect(representativeDraftMatches([{...saved[0],role:"newcomer"},saved[1]],saved)).toBe(false);
    expect(representativeDraftMatches([{...saved[0],note:"New evidence"},saved[1]],saved)).toBe(false);
  });
  it("uses a stable sample key when a filtered or sorted table changes row positions", () => {
    const selected = { [`${scanId}:B000000002`]: true };
    const filteredAndSorted = [samples[2], samples[1]];

    expect(resolveSelectedMarketSamples(scanId, filteredAndSorted, selected)).toEqual([samples[1]]);
    expect(resolveSelectedMarketSamples(scanId, samples, selected)).toEqual([samples[1]]);
  });

  it("restores representative selection by the saved sample key after refresh", () => {
    const refreshed = samples.map((item) => ({ ...item }));
    const selection = restoreRepresentativeSelection(scanId, refreshed, [
      { marketSampleKey: `${scanId}:B000000003` },
      { marketSampleKey: `${scanId}:B000000001` },
    ]);

    expect(selection).toEqual({ [`${scanId}:B000000003`]: true, [`${scanId}:B000000001`]: true });
    expect(resolveSelectedMarketSamples(scanId, refreshed, selection).map((item) => item.asin)).toEqual([
      "B000000001",
      "B000000003",
    ]);
  });

  it("prefers the persisted key and normalizes the fallback key from the ASIN", () => {
    expect(marketSampleKeyFor(scanId, { asin: "b000000001", marketSampleKey: "persisted-key" })).toBe("persisted-key");
    expect(marketSampleKeyFor(scanId, { asin: "b000000001" })).toBe(`${scanId}:B000000001`);
  });

  it("does not restore a representative that is absent from the locked sample", () => {
    expect(restoreRepresentativeSelection(scanId, samples, [
      { marketSampleKey: `${scanId}:B999999999` },
    ])).toEqual({});
  });

  it("hands off only the saved representative requested by a single-row action", () => {
    const representatives = [
      { marketSampleKey: `${scanId}:B000000001` },
      { marketSampleKey: `${scanId}:B000000003` },
    ];

    expect(resolveResearchHandoffSamples(scanId, [samples[2], samples[1], samples[0]], representatives, `${scanId}:B000000003`)).toEqual([samples[2]]);
  });

  it("returns no handoff sample when a row action targets an unsaved representative", () => {
    expect(resolveResearchHandoffSamples(scanId, samples, [
      { marketSampleKey: `${scanId}:B000000001` },
    ], `${scanId}:B000000002`)).toEqual([]);
  });

  it("keeps the bottom bulk handoff scoped to all saved representatives in saved order", () => {
    const representatives = [
      { marketSampleKey: `${scanId}:B000000003` },
      { marketSampleKey: `${scanId}:B000000001` },
    ];

    expect(resolveResearchHandoffSamples(scanId, samples, representatives).map((sample) => sample.asin)).toEqual([
      "B000000003",
      "B000000001",
    ]);
  });
});
