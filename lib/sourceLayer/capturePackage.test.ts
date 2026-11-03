import { describe, expect, it } from "vitest";

import {
  CAPTURE_FIELD_KEYS,
  SOURCE_TYPES,
  buildCapturePackage,
  deriveRiskFlags,
  normalizeAsin,
  parseCapturePackage,
  sourceAllowsConfirmed,
  sourceTrustLevelOf,
  type CapturePackageDraft,
} from "@/lib/sourceLayer/capturePackage";
import { createSourceLayerError } from "@/lib/sourceLayer/errorCodes";

const CAPTURED_AT = "2026-02-01T00:00:00.000Z";

function draft(overrides: Partial<CapturePackageDraft["fields"]> = {}): CapturePackageDraft {
  const providerExport = "provider_export" as const;
  const field = <T,>(value: T, sourceRef: string) => ({
    value,
    valueOrigin: providerExport,
    sourceRef,
    confidence: 1,
  });
  return {
    subjectKey: "amazon:US:B0FH1ZXTN1",
    marketplace: "us",
    fields: {
      asin: field("B0FH1ZXTN1", "x.asin"),
      title: field("Owala FreeSip Insulated Stainless Steel Water Bottle 24 oz", "x.title"),
      images: field(["https://m.media-amazon.com/images/I/a.jpg"], "x.images"),
      price: field({ amount: 29.99, currency: "usd" }, "x.price"),
      rating: field(4.6, "x.rating"),
      reviewCount: field(2948, "x.reviews"),
      bsr: field({ rank: 120, category: "Sports & Outdoors" }, "x.bsr"),
      keywords: field(["water bottle"], "x.keywords"),
      ...overrides,
    },
    sourceProof: {
      sourceType: "sellersprite_xlsx",
      sourceUrl: "https://www.amazon.com/dp/B0FH1ZXTN1",
      capturedAt: CAPTURED_AT,
      captureMethod: "xlsx_export",
      operator: "owner:v1",
      sourceFingerprint: "a".repeat(64),
      sourceRecordRef: "rows=2",
    },
    replay: {
      url: "https://www.amazon.com/dp/B0FH1ZXTN1",
      capturedAt: CAPTURED_AT,
      pageDigest: "sheet=US",
      warnings: [],
    },
  };
}

describe("buildCapturePackage", () => {
  it("applies the same field trust to plugin and XLSX and never confirms modeled estimates", () => {
    const packages = (["sellersprite_plugin", "sellersprite_xlsx"] as const).map((sourceType) => {
      const input = draft({
        estimatedMonthlySales: { value: 500, valueOrigin: "provider_export", sourceRef: "sales" },
        rating: { value: 4.6, valueOrigin: "model_estimated", metricNature: "snapshot", sourceRef: "modeled" },
      });
      return buildCapturePackage({ captureId: "trust-fixture", version: 1,
        draft: { ...input, sourceProof: { ...input.sourceProof, sourceType } } });
    });
    for (const pkg of packages) {
      expect(pkg.fieldStates.title.status).toBe("confirmed");
      expect(pkg.fieldStates.estimatedMonthlySales).toMatchObject({ status: "estimated", metricNature: "estimate" });
      expect(pkg.fieldStates.rating).toMatchObject({ status: "estimated", metricNature: "estimate" });
    }
  });
  it("builds a schema-complete package with all eight fields and four-state markers", () => {
    const pkg = buildCapturePackage({ captureId: "cap-1", version: 1, draft: draft() });
    expect(pkg.schemaVersion).toBe("source-capture-package.v1");
    expect(pkg.marketplace).toBe("US");
    expect(Object.keys(pkg.fieldStates).sort()).toEqual([...CAPTURE_FIELD_KEYS].sort());
    for (const key of CAPTURE_FIELD_KEYS) {
      expect(["confirmed", "estimated", "missing", "conflict"]).toContain(pkg.fieldStates[key].status);
    }
    expect(pkg.fields.asin).toBe("B0FH1ZXTN1");
    expect(pkg.fields.price).toEqual({ amount: 29.99, currency: "USD" });
    expect(pkg.fieldStates.price.status).toBe("confirmed");
  });

  it("does not truncate a validated inline image to the ordinary text limit", () => {
    const pngBytes = Buffer.concat([
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
      Buffer.alloc(1_200, 0x41),
    ]);
    const image = `data:image/png;base64,${pngBytes.toString("base64")}`;
    const pkg = buildCapturePackage({
      captureId: "cap-long-image",
      version: 1,
      draft: draft({ images: { value: [image], valueOrigin: "provider_export", sourceRef: "x.imageSnapshot" } }),
    });

    expect(pkg.fields.images).toEqual([image]);
    expect(pkg.fields.images[0].length).toBeGreaterThan(1_000);
  });

  it("normalizes invalid scalars into missing state instead of inventing values", () => {
    const pkg = buildCapturePackage({
      captureId: "cap-2",
      version: 1,
      draft: draft({
        asin: { value: "bad-asin", valueOrigin: "provider_export", sourceRef: "x.asin" },
        rating: { value: 9.9, valueOrigin: "provider_export", sourceRef: "x.rating" },
        reviewCount: { value: -5, valueOrigin: "provider_export", sourceRef: "x.reviews" },
        bsr: { value: { rank: 0, category: null }, valueOrigin: "provider_export", sourceRef: "x.bsr" },
        price: { value: { amount: -1, currency: "USD" }, valueOrigin: "provider_export", sourceRef: "x.price" },
      }),
    });
    expect(pkg.fields.asin).toBeNull();
    expect(pkg.fieldStates.asin.status).toBe("missing");
    expect(pkg.fields.rating).toBeNull();
    expect(pkg.fields.reviewCount).toBeNull();
    expect(pkg.fields.bsr).toBeNull();
    expect(pkg.fields.price).toBeNull();
  });

  it("treats placeholders as missing values, never as confirmed text", () => {
    const pkg = buildCapturePackage({
      captureId: "cap-3",
      version: 1,
      draft: draft({
        title: { value: "   ", valueOrigin: "provider_export", sourceRef: "x.title" },
      }),
    });
    expect(pkg.fields.title).toBeNull();
    expect(pkg.fieldStates.title.status).toBe("missing");
  });

  it("caps model-estimated confidence so estimates cannot masquerade as measurements", () => {
    const pkg = buildCapturePackage({
      captureId: "cap-4",
      version: 1,
      draft: draft({
        price: { value: { amount: 12, currency: "USD" }, valueOrigin: "model_estimated", sourceRef: "ai.price", confidence: 1 },
      }),
    });
    expect(pkg.fieldStates.price.status).toBe("estimated");
    expect(pkg.fieldStates.price.confidence).toBeLessThanOrEqual(0.4);
  });

  it("refuses untrusted source types and unknown source types", () => {
    expect(() => buildCapturePackage({
      captureId: "cap-5",
      version: 1,
      draft: { ...draft(), sourceProof: { ...draft().sourceProof, sourceType: "unknown_source" as never } },
    })).toThrow();
    expect(() => buildCapturePackage({
      captureId: "cap-6",
      version: 1,
      draft: { ...draft(), sourceProof: { ...draft().sourceProof, sourceType: "scraped_anonymous" as never } },
    })).toThrow();
  });

  it("rejects invalid capture id, version and subject key", () => {
    expect(() => buildCapturePackage({ captureId: " ", version: 1, draft: draft() })).toThrow();
    expect(() => buildCapturePackage({ captureId: "cap", version: 0, draft: draft() })).toThrow();
    expect(() => buildCapturePackage({
      captureId: "cap",
      version: 1,
      draft: { ...draft(), subjectKey: "" },
    })).toThrow();
  });

  it("declares every supported source type with a deterministic trust level", () => {
    for (const sourceType of SOURCE_TYPES) {
      expect(["trusted", "estimated_only", "untrusted"]).toContain(sourceTrustLevelOf(sourceType));
    }
    expect(sourceAllowsConfirmed("browser_agent")).toBe(false);
    expect(sourceAllowsConfirmed("sellersprite_xlsx")).toBe(true);
  });
});

describe("normalizeAsin", () => {
  it("accepts only 10-char alphanumeric identifiers", () => {
    expect(normalizeAsin("b0fh1zxtn1")).toBe("B0FH1ZXTN1");
    expect(normalizeAsin("B0FH1ZXTN")).toBeNull();
    expect(normalizeAsin("B0FH1ZXTN12")).toBeNull();
    expect(normalizeAsin(null)).toBeNull();
  });
});

describe("deriveRiskFlags", () => {
  it("maps missing/weak signals to risk flags deterministically", () => {
    const pkg = buildCapturePackage({ captureId: "cap-7", version: 1, draft: draft() });
    const flags = deriveRiskFlags({
      fields: pkg.fields,
      fieldStates: pkg.fieldStates,
      sourceType: pkg.sourceProof.sourceType,
      errors: [createSourceLayerError("SOURCE_EXPIRED")],
    });
    expect(flags).toContain("source_expired");
    expect(flags).toContain("image_single");
    expect(flags).toEqual([...flags].sort());
  });
});

describe("parseCapturePackage", () => {
  it("round-trips a valid package", () => {
    const pkg = buildCapturePackage({ captureId: "cap-8", version: 1, draft: draft() });
    expect(parseCapturePackage(JSON.parse(JSON.stringify(pkg)))).toEqual(pkg);
  });

  it("fail-closed on schema mismatch, missing fields and unknown risk flags", () => {
    const pkg = buildCapturePackage({ captureId: "cap-9", version: 1, draft: draft() });
    expect(parseCapturePackage({ ...pkg, schemaVersion: "other" })).toBeNull();
    expect(parseCapturePackage({ ...pkg, riskFlags: ["invented_flag"] })).toBeNull();
    const brokenStates = { ...pkg.fieldStates, price: { ...pkg.fieldStates.price, confidence: 2 } };
    expect(parseCapturePackage({ ...pkg, fieldStates: brokenStates })).toBeNull();
    expect(parseCapturePackage(null)).toBeNull();
  });
});
