import { describe, expect, it } from "vitest";
import {
  parseKeepaExport,
  parseKeepaNumber,
  parseKeepaPercent,
  parseCsvText,
} from "./keepaExportParser";

describe("Keepa Export Parser MVP", () => {
  const SAMPLE_KEEPA_CSV = `ASIN,Title,Buy Box: Current,Buy Box: 90 days lowest,Buy Box: 90 days avg,Buy Box: 360 days lowest,Sales Rank: Current,Sales Rank: 90 days avg,Sales Rank: drops 90 days,Buy Box: % Amazon 90 days,Lightning Deals: 90 days count,Reviews: Rating,Reviews: Review Count
B085DTZQNZ,"Owala FreeSip Insulated Water Bottle, 24 Oz",$27.99,$19.99,$26.49,$16.99,120,450,85,15%,4,4.8,42150
B0CQVWT2NH,"Stanley Quencher H2.0 FlowState Tumbler",$35.00,$29.99,$34.50,$25.00,80,210,120,0%,0,4.7,18900
`;

  it("parses valid Keepa Product Viewer CSV export accurately", () => {
    const result = parseKeepaExport(SAMPLE_KEEPA_CSV);
    expect(result.ok).toBe(true);
    expect(result.format).toBe("csv");
    expect(result.totalRows).toBe(2);
    expect(result.acceptedRows).toBe(2);
    expect(result.sourceFileSha256).toMatch(/^[a-f0-9]{64}$/);

    const owala = result.rows[0];
    expect(owala.asin).toBe("B085DTZQNZ");
    expect(owala.title).toBe("Owala FreeSip Insulated Water Bottle, 24 Oz");
    expect(owala.currentPrice).toBe(27.99);
    expect(owala.metrics.price90dMin).toBe(19.99);
    expect(owala.metrics.price90dAvg).toBe(26.49);
    expect(owala.metrics.price360dMin).toBe(16.99);
    expect(owala.metrics.bsr90dAvg).toBe(450);
    expect(owala.metrics.bsrDrops90d).toBe(85);
    expect(owala.metrics.buyBoxAmazonSharePercent).toBe(15);
    expect(owala.metrics.dealCount90d).toBe(4);
    expect(owala.rating).toBe(4.8);
    expect(owala.reviewCount).toBe(42150);

    const stanley = result.rows[1];
    expect(stanley.asin).toBe("B0CQVWT2NH");
    expect(stanley.metrics.buyBoxAmazonSharePercent).toBe(0);
    expect(stanley.metrics.dealCount90d).toBe(0);
  });

  it("handles Keepa -1, N/A, and empty values as null (honest missing state)", () => {
    const csv = `ASIN,Title,Buy Box: Current,Buy Box: 90 days lowest,Buy Box: 90 days avg,Buy Box: 360 days lowest,Sales Rank: 90 days avg,Sales Rank: drops 90 days,Buy Box: % Amazon 90 days,Lightning Deals: 90 days count
B000TEST01,Test Item,-1,-1,N/A,--,none,nan,-1,N/A
`;
    const result = parseKeepaExport(csv);
    expect(result.ok).toBe(true);
    expect(result.acceptedRows).toBe(1);
    const item = result.rows[0];
    expect(item.currentPrice).toBeNull();
    expect(item.metrics.price90dMin).toBeNull();
    expect(item.metrics.price90dAvg).toBeNull();
    expect(item.metrics.price360dMin).toBeNull();
    expect(item.metrics.bsr90dAvg).toBeNull();
    expect(item.metrics.bsrDrops90d).toBeNull();
    expect(item.metrics.buyBoxAmazonSharePercent).toBeNull();
    expect(item.metrics.dealCount90d).toBeNull();
  });

  it("handles European semicolon-delimited CSV exports", () => {
    const csv = `ASIN;Title;Buy Box: Current;Buy Box: 90 days lowest;Buy Box: 90 days avg
B085DTZQNZ;Owala Water Bottle;€29.99;€24.99;€28.00
`;
    const result = parseKeepaExport(csv);
    expect(result.ok).toBe(true);
    expect(result.acceptedRows).toBe(1);
    expect(result.rows[0].currentPrice).toBe(29.99);
    expect(result.rows[0].metrics.price90dMin).toBe(24.99);
    expect(result.rows[0].metrics.price90dAvg).toBe(28.0);
  });

  it("handles UTF-8 with BOM signature", () => {
    const csvWithBom = `\uFEFFASIN,Title,Price\nB085DTZQNZ,Bottle,$25.00`;
    const result = parseKeepaExport(csvWithBom);
    expect(result.ok).toBe(true);
    expect(result.acceptedRows).toBe(1);
    expect(result.rows[0].asin).toBe("B085DTZQNZ");
  });

  it("rejects exports missing the ASIN column gracefully", () => {
    const invalidCsv = `Title,Price,Sales Rank\nItem Without ASIN,$10.00,100`;
    const result = parseKeepaExport(invalidCsv);
    expect(result.ok).toBe(false);
    expect(result.acceptedRows).toBe(0);
    expect(result.errors).toContain("asin_column_not_found");
  });

  it("parses numbers and percentages correctly", () => {
    expect(parseKeepaNumber("$1,499.99")).toBe(1499.99);
    expect(parseKeepaNumber("€19.50")).toBe(19.5);
    expect(parseKeepaNumber("-1")).toBeNull();
    expect(parseKeepaNumber("N/A")).toBeNull();
    expect(parseKeepaNumber("")).toBeNull();

    expect(parseKeepaPercent("85%")).toBe(85);
    expect(parseKeepaPercent("0.85")).toBe(85);
    expect(parseKeepaPercent("100%")).toBe(100);
    expect(parseKeepaPercent("0%")).toBe(0);
    expect(parseKeepaPercent("-1")).toBeNull();
  });

  it("parses quoted multiline fields in CSV", () => {
    const csv = `ASIN,Title,Price
B085DTZQNZ,"Owala Bottle
With Newline",29.99
`;
    const result = parseKeepaExport(csv);
    expect(result.ok).toBe(true);
    expect(result.acceptedRows).toBe(1);
    expect(result.rows[0].title).toBe("Owala Bottle\nWith Newline");
  });
});
