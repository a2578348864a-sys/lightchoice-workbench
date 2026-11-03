import { describe, expect, it } from "vitest";
import { manualEntryAdapter } from "@/lib/sourceLayer/adapters/manualEntryAdapter";
import type { CaptureEvidenceRecord } from "@/lib/sourceLayer/sourceAdapter";
import { projectAmazonEvidence } from "./amazonSourceProjection";

function fixture(): CaptureEvidenceRecord {
  const capturedAt = "2026-09-23T00:00:00.000Z";
  const captured = manualEntryAdapter.capture({
    payload: { asin: "B0GH9R927H", title: "Insulated bottle", productUrl: "https://www.amazon.com/dp/B0GH9R927H", price: 21, currency: "USD" },
    capturedAt,
    operator: "owner:v1",
  });
  const draft = captured.drafts[0]!;
  const pkg = manualEntryAdapter.normalize({ draft, captureId: "projection-test", version: 1 });
  const validation = manualEntryAdapter.validate({ pkg, context: { now: capturedAt } });
  const evidence = manualEntryAdapter.createEvidence({ pkg: validation.pkg, report: validation.report });
  return {
    ...evidence,
    sourceType: "amazon_dom",
    pkg: {
      ...evidence.pkg,
      sourceProof: {
        ...evidence.pkg.sourceProof,
        sourceType: "amazon_dom",
        entityBinding: {
          bound: true,
          expectedAsin: "B0GH9R927H",
          observedAsin: "B0GH9R927H",
          expectedMarketplace: "US",
          observedMarketplace: "US",
          urlAsin: "B0GH9R927H",
          urlMarketplace: "US",
        },
      },
    },
  } as CaptureEvidenceRecord;
}

describe("Amazon management projection", () => {
  it("projects only bound Amazon evidence references and its ProductFact", () => {
    const projected = projectAmazonEvidence(fixture());
    expect(projected).not.toBeNull();
    expect(projected).toMatchObject({ sourceType: "amazon_dom", subjectKey: expect.any(String), evidenceId: expect.any(String), contentHash: expect.any(String) });
    expect(projected?.productFact.basic.asin.value).toBe("B0GH9R927H");
    expect(projected?.productFact.basic.title.value).toBe("Insulated bottle");
  });

  it("does not expose unbound Amazon evidence or a different source type", () => {
    const evidence = fixture();
    const unbound = { ...evidence, pkg: { ...evidence.pkg, sourceProof: { ...evidence.pkg.sourceProof, entityBinding: { ...evidence.pkg.sourceProof.entityBinding!, bound: false } } } } as CaptureEvidenceRecord;
    const other = { ...evidence, sourceType: "sellersprite_xlsx" } as CaptureEvidenceRecord;
    expect(projectAmazonEvidence(unbound)).toBeNull();
    expect(projectAmazonEvidence(other)).toBeNull();
  });
});
