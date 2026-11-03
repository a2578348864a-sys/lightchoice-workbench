import { describe, expect, it } from "vitest";

import {
  RAW_ARTIFACT_MAX_BYTES,
  buildSourceRawArtifact,
  inspectRawArtifact,
  parseSourceRawArtifact,
  rawArtifactIdFor,
  sha256OfRawArtifact,
} from "@/lib/sourceLayer/rawArtifact";

const XLSX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
const PROVENANCE = {
  provider: "SellerSprite",
  sourceSurface: "search-results-export",
  sourceUrl: "https://www.sellersprite.com/",
  sourceRecordRef: "sheet=US;row=2",
  providerUpdatedAt: null,
  acquisitionMode: "file_upload" as const,
  parserVersion: "sellersprite-adapter.v1",
};

describe("source raw artifact", () => {
  it("prechecks and builds a stable, provenance-complete artifact", () => {
    const inspection = inspectRawArtifact({
      fileName: "market.xlsx",
      bytes: XLSX_BYTES,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const artifact = buildSourceRawArtifact({
      subjectKey: "amazon:US:B0RAWTEST1",
      sourceType: "sellersprite_xlsx",
      kind: "market_export",
      capturedAt: "2026-09-26T00:00:00.000Z",
      fileName: "market.xlsx",
      contentType: inspection.contentType,
      bytes: XLSX_BYTES,
      provenance: PROVENANCE,
    });
    expect(artifact.sha256).toBe(sha256OfRawArtifact(XLSX_BYTES));
    expect(artifact.artifactId).toBe(rawArtifactIdFor(artifact.sha256));
    expect(artifact.storageFileName).toBe(`r-${artifact.sha256}.xlsx`);
    expect(parseSourceRawArtifact(artifact)).toEqual(artifact);
  });

  it("fails closed for unsupported, malformed, and oversized files", () => {
    expect(() => inspectRawArtifact({ fileName: "secret.exe", bytes: XLSX_BYTES })).toThrow("RAW_ARTIFACT_EXTENSION_UNSUPPORTED");
    expect(() => inspectRawArtifact({ fileName: "broken.xlsx", bytes: new Uint8Array([1, 2, 3]) })).toThrow("RAW_ARTIFACT_MALFORMED");
    expect(() => inspectRawArtifact({ fileName: "empty.csv", bytes: new Uint8Array() })).toThrow("RAW_ARTIFACT_EMPTY");
    expect(() => inspectRawArtifact({ fileName: "large.csv", bytes: new Uint8Array(RAW_ARTIFACT_MAX_BYTES + 1) })).toThrow("RAW_ARTIFACT_OVERSIZED");
  });

  it("accepts a PNG screenshot only by its binary signature", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(inspectRawArtifact({ fileName: "visible.png", bytes: png }).format).toBe("png");
    expect(() => inspectRawArtifact({ fileName: "visible.png", bytes: new Uint8Array([1, 2, 3]) })).toThrow("RAW_ARTIFACT_MALFORMED");
  });

  it("rejects path traversal and non-HTTPS provenance URLs", () => {
    expect(() => buildSourceRawArtifact({
      subjectKey: "amazon:US:B0RAWTEST1",
      sourceType: "sellersprite_xlsx",
      kind: "workbook",
      capturedAt: "2026-09-26T00:00:00.000Z",
      fileName: "../market.xlsx",
      bytes: XLSX_BYTES,
      provenance: PROVENANCE,
    })).toThrow("RAW_ARTIFACT_FILENAME_INVALID");
    expect(() => buildSourceRawArtifact({
      subjectKey: "amazon:US:B0RAWTEST1",
      sourceType: "sellersprite_xlsx",
      kind: "workbook",
      capturedAt: "2026-09-26T00:00:00.000Z",
      fileName: "market.xlsx",
      bytes: XLSX_BYTES,
      provenance: { ...PROVENANCE, sourceUrl: "http://localhost/file" },
    })).toThrow("RAW_ARTIFACT_SOURCE_URL_INVALID");
  });
});
