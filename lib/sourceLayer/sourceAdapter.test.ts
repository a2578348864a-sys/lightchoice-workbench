import { describe, expect, it } from "vitest";

import { buildCapturePackage, type CapturePackageDraft } from "@/lib/sourceLayer/capturePackage";
import { captureContentHashOf } from "@/lib/sourceLayer/sourceAdapter";

const CAPTURED_AT = "2026-02-01T00:00:00.000Z";

function draft(): CapturePackageDraft {
  return {
    subjectKey: "amazon:US:B0FH1ZXTN1",
    marketplace: "US",
    fields: {
      asin: { value: "B0FH1ZXTN1", valueOrigin: "human_manual", sourceRef: "f.asin" },
      title: { value: "Owala FreeSip Insulated Stainless Steel Water Bottle, 24 oz", valueOrigin: "human_manual", sourceRef: "f.title" },
      images: { value: ["https://m.media-amazon.com/images/I/a.jpg"], valueOrigin: "human_manual", sourceRef: "f.images" },
      price: { value: { amount: 29.99, currency: "USD" }, valueOrigin: "human_manual", sourceRef: "f.price" },
      rating: { value: 4.6, valueOrigin: "human_manual", sourceRef: "f.rating" },
      reviewCount: { value: 2948, valueOrigin: "human_manual", sourceRef: "f.reviews" },
      bsr: { value: { rank: 120, category: "Sports & Outdoors" }, valueOrigin: "human_manual", sourceRef: "f.bsr" },
      keywords: { value: ["water bottle"], valueOrigin: "human_manual", sourceRef: "f.keywords" },
    },
    sourceProof: {
      sourceType: "manual_entry",
      sourceUrl: "https://www.amazon.com/dp/B0FH1ZXTN1",
      capturedAt: CAPTURED_AT,
      captureMethod: "manual_form",
      operator: "owner:v1",
      sourceFingerprint: null,
      sourceRecordRef: null,
    },
    replay: { url: null, capturedAt: CAPTURED_AT, pageDigest: "manual_entry", warnings: [] },
  };
}

describe("captureContentHashOf", () => {
  it("ignores captureId and version so re-capture dedupe works", () => {
    const a = buildCapturePackage({ captureId: "cap-aaa", version: 1, draft: draft() });
    const b = buildCapturePackage({ captureId: "cap-bbb", version: 7, draft: draft() });
    expect(captureContentHashOf(a)).toBe(captureContentHashOf(b));
  });

  it("changes when the captured content changes", () => {
    const a = buildCapturePackage({ captureId: "cap-aaa", version: 1, draft: draft() });
    const changed = draft();
    const b = buildCapturePackage({
      captureId: "cap-aaa",
      version: 1,
      draft: {
        ...changed,
        fields: { ...changed.fields, price: { value: { amount: 21.5, currency: "USD" }, valueOrigin: "human_manual", sourceRef: "f.price" } },
      },
    });
    expect(captureContentHashOf(a)).not.toBe(captureContentHashOf(b));
  });

  it("ignores event timestamps so semantic versions do not grow on identical recaptures", () => {
    const a = buildCapturePackage({ captureId: "cap-aaa", version: 1, draft: draft() });
    const later = draft();
    const b = buildCapturePackage({
      captureId: "cap-bbb",
      version: 2,
      draft: {
        ...later,
        sourceProof: { ...later.sourceProof, capturedAt: "2026-02-02T00:00:00.000Z" },
        replay: { ...later.replay, capturedAt: "2026-02-02T00:00:00.000Z" },
      },
    });
    expect(captureContentHashOf(a)).toBe(captureContentHashOf(b));
  });
});
