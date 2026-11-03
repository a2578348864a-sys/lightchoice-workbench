import { describe, expect, it } from "vitest";

import {
  buildTrendObservation,
  semanticContentHash,
} from "@/lib/sourceLayer/v2/contracts";

describe("Source Layer V2 contracts", () => {
  it("keeps semantic hash stable when only capture metadata changes", () => {
    expect(semanticContentHash({ title: "A", capturedAt: "one", captureId: "x", version: 1 }))
      .toBe(semanticContentHash({ title: "A", capturedAt: "two", captureId: "y", version: 2 }));
  });

  it("builds a daily trend dedupe key without pretending to have history", () => {
    const observation = buildTrendObservation({
      observationId: "trend-1",
      subjectKey: "amazon:US:B000000001",
      field: "bsr",
      value: 12,
      valueKind: "observed",
      sourceType: "amazon_dom",
      capturedAt: "2026-02-01T01:00:00.000Z",
      evidenceRefs: ["ev-1"],
    });
    expect(observation.capturedDate).toBe("2026-02-01");
    expect(observation.dedupeKey).toHaveLength(64);
  });
});

