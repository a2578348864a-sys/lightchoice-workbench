import { describe, expect, it } from "vitest";
import {
  keepaAdapter,
  captureKeepaExport,
  buildKeepaTimeseriesAttachment,
} from "./keepaAdapter";
import { getSourceAdapter } from "@/lib/sourceLayer/sourceAdapter";
import { parseSourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";

describe("Keepa Source Adapter", () => {
  const SAMPLE_CSV = `ASIN,Title,Image,Buy Box: Current,Buy Box: 90 days lowest,Buy Box: 90 days avg,Buy Box: 360 days lowest,Sales Rank: Current,Sales Rank: 90 days avg,Sales Rank: drops 90 days,Buy Box: % Amazon 90 days,Lightning Deals: 90 days count,Reviews: Rating,Reviews: Review Count
B085DTZQNZ,"Owala FreeSip Water Bottle",https://m.media-amazon.com/images/I/71xyz.jpg,$27.99,$19.99,$26.49,$16.99,120,450,85,15%,4,4.8,42150
`;

  it("is registered in the global adapter registry", () => {
    const adapter = getSourceAdapter("keepa_export");
    expect(adapter).toBeDefined();
    expect(adapter?.sourceType).toBe("keepa_export");
    expect(adapter?.label).toBe("Keepa 官方导表");
  });

  it("captures valid Keepa CSV into drafts with time series metrics", () => {
    const result = captureKeepaExport({
      payload: SAMPLE_CSV,
      capturedAt: "2026-09-25T10:00:00.000Z",
      operator: "owner:v1",
      sourceUrl: "https://keepa.com/#!viewer",
    });

    expect(result.errorCodes).toEqual([]);
    expect(result.drafts).toHaveLength(1);
    const draft = result.drafts[0];
    expect(draft.subjectKey).toBe("amazon:US:B085DTZQNZ");
    expect(draft.marketplace).toBe("US");
    expect(draft.fields.asin.value).toBe("B085DTZQNZ");
    expect(draft.fields.price.value).toEqual({ amount: 27.99, currency: "USD" });
    expect(draft.fields.bsr.value).toEqual({ rank: 120, category: null });
    expect(draft.sourceProof.sourceType).toBe("keepa_export");
    expect(draft.sourceProof.sourceMethod).toBe("keepa_official_export");

    expect(draft.extensions?.timeSeriesMetrics).toEqual({
      price90dMin: 19.99,
      price90dAvg: 26.49,
      price360dMin: 16.99,
      bsr90dAvg: 450,
      bsrDrops90d: 85,
      buyBoxAmazonSharePercent: 15,
      dealCount90d: 4,
    });
  });

  it("normalizes, validates and produces an evidence record", () => {
    const captureResult = keepaAdapter.capture({
      payload: SAMPLE_CSV,
      capturedAt: "2026-09-25T10:00:00.000Z",
      operator: "owner:v1",
    });
    expect(captureResult.drafts).toHaveLength(1);

    const pkg = keepaAdapter.normalize({
      draft: captureResult.drafts[0],
      captureId: "cap_test_keepa_01",
      version: 1,
    });
    expect(pkg.schemaVersion).toBe("source-capture-package.v1");
    expect(pkg.extensions?.timeSeriesMetrics?.price90dMin).toBe(19.99);

    const outcome = keepaAdapter.validate({
      pkg,
      context: {
        now: new Date("2026-09-25T10:00:00.000Z"),
        previousPackages: [],
      },
    });
    expect(outcome.report.verdict).toBe("passed");

    const evidence = keepaAdapter.createEvidence({
      pkg: outcome.pkg,
      report: outcome.report,
    });
    expect(evidence.schemaVersion).toBe("source-evidence-record.v1");
    expect(evidence.sourceType).toBe("keepa_export");
    expect(evidence.pkg.extensions?.timeSeriesMetrics?.buyBoxAmazonSharePercent).toBe(15);
  });

  it("builds a valid SourceEvidenceAttachment of kind keepa_timeseries_v1", () => {
    const attachment = buildKeepaTimeseriesAttachment({
      subjectKey: "amazon:US:B085DTZQNZ",
      asin: "B085DTZQNZ",
      metrics: {
        price90dMin: 19.99,
        price90dAvg: 26.49,
        price360dMin: 16.99,
        bsr90dAvg: 450,
        bsrDrops90d: 85,
        buyBoxAmazonSharePercent: 15,
        dealCount90d: 4,
      },
      capturedAt: "2026-09-25T10:00:00.000Z",
      sourceUrl: "https://keepa.com/#!viewer",
    });

    expect(attachment.kind).toBe("keepa_timeseries_v1");
    expect(attachment.sourceType).toBe("keepa_export");
    expect(attachment.payload.schema).toBe("keepa-timeseries-attachment.v1");
    expect(attachment.payload.asin).toBe("B085DTZQNZ");

    const parsed = parseSourceEvidenceAttachment(attachment);
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("keepa_timeseries_v1");
  });
});
