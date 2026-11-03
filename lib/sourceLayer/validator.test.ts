import { describe, expect, it } from "vitest";

import {
  buildCapturePackage,
  type CapturePackage,
  type CapturePackageDraft,
} from "@/lib/sourceLayer/capturePackage";
import {
  targetStateForVerdict,
  validateCapturePackage,
  validateCaptureReport,
  validationAuditEntries,
} from "@/lib/sourceLayer/validator";
import { CAPTURE_FIELD_KEYS } from "@/lib/sourceLayer/expiration";

const CAPTURED_AT = "2026-02-01T00:00:00.000Z";
const NOW = new Date("2026-02-01T01:00:00.000Z");

const baseFields: CapturePackageDraft["fields"] = {
  asin: { value: "B0FH1ZXTN1", valueOrigin: "provider_export", sourceRef: "x.asin" },
  title: {
    value: "Owala FreeSip Insulated Stainless Steel Water Bottle with Straw, 24 oz",
    valueOrigin: "provider_export",
    sourceRef: "x.title",
  },
  images: {
    value: ["https://m.media-amazon.com/images/I/a.jpg", "https://m.media-amazon.com/images/I/b.jpg"],
    valueOrigin: "provider_export",
    sourceRef: "x.images",
  },
  price: { value: { amount: 29.99, currency: "USD" }, valueOrigin: "provider_export", sourceRef: "x.price" },
  rating: { value: 4.6, valueOrigin: "provider_export", sourceRef: "x.rating" },
  reviewCount: { value: 2948, valueOrigin: "provider_export", sourceRef: "x.reviews" },
  bsr: {
    value: { rank: 120, category: "Sports & Outdoors" },
    valueOrigin: "provider_export",
    sourceRef: "x.bsr",
  },
  keywords: { value: ["water bottle"], valueOrigin: "provider_export", sourceRef: "x.keywords" },
};

function makePackage(overrides: {
  fields?: Partial<CapturePackageDraft["fields"]>;
  sourceProof?: Partial<CapturePackageDraft["sourceProof"]>;
  captureId?: string;
  version?: number;
  subjectKey?: string;
  marketplace?: string;
} = {}): CapturePackage {
  const draft: CapturePackageDraft = {
    subjectKey: overrides.subjectKey ?? "amazon:US:B0FH1ZXTN1",
    marketplace: overrides.marketplace ?? "US",
    fields: { ...baseFields, ...overrides.fields },
    sourceProof: {
      sourceType: "sellersprite_xlsx",
      sourceUrl: "https://www.amazon.com/dp/B0FH1ZXTN1",
      capturedAt: CAPTURED_AT,
      captureMethod: "xlsx_export",
      operator: "owner:v1",
      sourceFingerprint: "a".repeat(64),
      sourceRecordRef: "rows=2",
      ...overrides.sourceProof,
    },
    replay: { url: null, capturedAt: CAPTURED_AT, pageDigest: "sheet=US", warnings: [] },
  };
  return buildCapturePackage({
    captureId: overrides.captureId ?? "cap-1",
    version: overrides.version ?? 1,
    draft,
  });
}

function codes(pkg: CapturePackage, context = { now: NOW }) {
  return validateCapturePackage(pkg, context).issues.map((item) => item.error.code);
}

describe("validateCapturePackage — field completeness and format", () => {
  it("passes a complete, well-formed package", () => {
    const report = validateCapturePackage(makePackage(), { now: NOW });
    expect(report.verdict).toBe("passed");
    expect(report.readyForResearch).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.fieldDetails).toHaveLength(CAPTURE_FIELD_KEYS.length);
  });

  it("覆盖全部采集包字段（含 brand / subCategoryBsr / 月销量与月销售额）", () => {
    const pkg = makePackage({
      fields: {
        brand: { value: "Owala", valueOrigin: "provider_export", sourceRef: "x.brand" },
        subCategoryBsr: { value: 15, valueOrigin: "provider_export", sourceRef: "x.subCategoryBsr" },
        estimatedMonthlySales: { value: 3500, valueOrigin: "provider_export", sourceRef: "x.estimatedMonthlySales" },
        estimatedMonthlyRevenueUsd: { value: 104965, valueOrigin: "provider_export", sourceRef: "x.estimatedMonthlyRevenue" },
      },
    });
    const report = validateCapturePackage(pkg, { now: NOW });
    // 验证明细必须逐个字段覆盖，不能只覆盖手写子集
    expect(report.fieldDetails.map((item) => item.field).sort())
      .toEqual([...CAPTURE_FIELD_KEYS].sort());
    for (const field of ["brand", "subCategoryBsr", "estimatedMonthlySales", "estimatedMonthlyRevenueUsd"] as const) {
      const detail = report.fieldDetails.find((item) => item.field === field);
      expect(detail, field).toBeDefined();
      const estimate = field === "estimatedMonthlySales" || field === "estimatedMonthlyRevenueUsd";
      expect(detail?.status, field).toBe(estimate ? "estimated" : "confirmed");
      if (estimate) {
        expect(pkg.fieldStates[field].metricNature).toBe("estimate");
        expect(detail?.confidence).toBeLessThan(1);
      }
    }
    expect(report.verdict).toBe("passed");
  });

  it("新增字段同样受过期判定约束（ttl 到点即 SOURCE_EXPIRED）", () => {
    const pkg = makePackage({
      fields: {
        estimatedMonthlySales: { value: 3500, valueOrigin: "provider_export", sourceRef: "x.estimatedMonthlySales" },
      },
    });
    const report = validateCapturePackage(pkg, {
      now: NOW,
      // 只把月销量压到 1 毫秒有效期：过期必须落在该字段上
      fieldPolicy: { estimatedMonthlySales: 1 },
    });
    const expired = report.issues.filter((item) => item.error.code === "SOURCE_EXPIRED").map((item) => item.field);
    expect(expired).toContain("estimatedMonthlySales");
  });

  it("blocks when the identity fields are missing (never auto-fills them)", () => {
    const pkg = makePackage({
      fields: {
        asin: { value: null, valueOrigin: "provider_export", sourceRef: "x.asin" },
        title: { value: null, valueOrigin: "provider_export", sourceRef: "x.title" },
      },
    });
    const report = validateCapturePackage(pkg, { now: NOW });
    expect(report.verdict).toBe("blocked");
    expect(report.readyForResearch).toBe(false);
    expect(report.issues.map((item) => item.error.code)).toContain("FIELD_MISSING");
    expect(report.issues.filter((item) => item.error.code === "FIELD_MISSING")).toHaveLength(2);
    // 缺失字段的值必须保持为空，验证器不会写回任何默认值
    expect(pkg.fields.asin).toBeNull();
    expect(pkg.fields.title).toBeNull();
  });

  it("routes missing market-observation fields to human review instead of passing silently", () => {
    const pkg = makePackage({
      fields: {
        price: { value: null, valueOrigin: "provider_export", sourceRef: "x.price" },
        rating: { value: null, valueOrigin: "provider_export", sourceRef: "x.rating" },
      },
    });
    const report = validateCapturePackage(pkg, { now: NOW });
    expect(report.verdict).toBe("blocked");
    expect(report.issues.filter((item) => item.error.code === "FIELD_MISSING")).toHaveLength(2);
  });

  it("flags placeholder titles and malformed images as INVALID_FORMAT", () => {
    const pkg = makePackage({
      fields: {
        title: { value: "N/A", valueOrigin: "provider_export", sourceRef: "x.title" },
        images: {
          value: ["http://insecure.example.com/a.jpg"],
          valueOrigin: "provider_export",
          sourceRef: "x.images",
        },
      },
    });
    const found = codes(pkg);
    expect(found).toContain("INVALID_FORMAT");
  });

  it("accepts verified inline image bytes but rejects other non-https protocols", () => {
    const inline = makePackage({
      fields: {
        images: {
          value: ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="],
          valueOrigin: "provider_export",
          sourceRef: "x.images",
        },
      },
    });
    expect(codes(inline)).not.toContain("INVALID_FORMAT");

    for (const bad of [
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:text/html;base64,PHNjcmlwdD4=",
      "file:///C:/secret.png",
      "javascript:alert(1)",
      "data:image/png;base64,bm90IGJhc2U2NA!!",
    ]) {
      const badPkg = makePackage({
        fields: {
          images: { value: [bad], valueOrigin: "provider_export", sourceRef: "x.images" },
        },
      });
      expect(codes(badPkg), bad).toContain("INVALID_FORMAT");
    }
  });

  it("derives risk flags and lands conflicts in the same validated package", () => {
    const sparse = makePackage({
      fields: {
        keywords: { value: [], valueOrigin: "provider_export", sourceRef: "x.keywords" },
        images: {
          value: ["https://m.media-amazon.com/images/I/only-one.jpg"],
          valueOrigin: "provider_export",
          sourceRef: "x.images",
        },
      },
    });
    const outcome = validateCaptureReport(sparse, { now: NOW });
    expect(outcome.pkg.riskFlags).toContain("keyword_missing");
    expect(outcome.pkg.riskFlags).toContain("image_single");
    expect(outcome.pkg.riskFlags).toEqual([...outcome.pkg.riskFlags].sort());

    const previous = makePackage({ captureId: "cap-old", version: 1 });
    const conflicting = makePackage({
      captureId: "cap-conflict",
      version: 2,
      fields: {
        title: {
          value: "A completely different product title for the same ASIN",
          valueOrigin: "provider_export",
          sourceRef: "x.title",
        },
      },
    });
    const conflicted = validateCaptureReport(conflicting, { now: NOW, previousPackages: [previous] });
    expect(conflicted.pkg.fieldStates.title.status).toBe("conflict");
    expect(conflicted.pkg.riskFlags).toContain("field_conflict");
  });

  it("warns (not blocks) on low-confidence estimates and marks needs_review", () => {
    const pkg = makePackage({
      fields: {
        rating: { value: 4.2, valueOrigin: "model_estimated", sourceRef: "ai.rating" },
      },
    });
    const report = validateCapturePackage(pkg, { now: NOW });
    expect(report.issues.map((item) => item.error.code)).toContain("LOW_CONFIDENCE");
    expect(report.verdict).toBe("needs_review");
    expect(report.readyForResearch).toBe(false);
  });

  it("blocks an estimated field that claims confidence 1 (estimate cannot look measured)", () => {
    const pkg = makePackage({
      fields: {
        price: { value: { amount: 19.99, currency: "USD" }, valueOrigin: "derived", sourceRef: "x.price", confidence: 1 },
      },
    });
    expect(codes(pkg)).toContain("LOW_CONFIDENCE");
  });
});

describe("validateCapturePackage — source credibility", () => {
  it("blocks a manual entry that pretends to carry a file fingerprint", () => {
    const pkg = makePackage({
      sourceProof: {
        sourceType: "manual_entry",
        sourceUrl: "https://www.amazon.com/dp/B0FH1ZXTN1",
        captureMethod: "xlsx_export",
        sourceFingerprint: "b".repeat(64),
      },
    });
    const found = codes(pkg);
    expect(found).toContain("SOURCE_UNTRUSTED");
  });

  it("blocks a source URL whose host contradicts the declared source type", () => {
    const pkg = makePackage({
      sourceProof: { sourceUrl: "https://evil.example.com/dp/B0FH1ZXTN1" },
    });
    expect(codes(pkg)).toContain("SOURCE_UNTRUSTED");
  });

  it("blocks a capture time in the future and a missing capture time", () => {
    const future = makePackage({
      sourceProof: { capturedAt: "2026-03-01T00:00:00.000Z" },
    });
    expect(codes(future)).toContain("INVALID_FORMAT");
  });

  it("honours an explicit allowed-source policy", () => {
    const report = validateCapturePackage(makePackage(), {
      now: NOW,
      allowedSourceTypes: ["manual_entry"],
    });
    expect(report.verdict).toBe("blocked");
    expect(report.issues.some((item) => item.error.code === "SOURCE_UNTRUSTED")).toBe(true);
  });

  it("blocks sources that require a URL but provide none", () => {
    const pkg = makePackage({ sourceProof: { sourceUrl: null } });
    expect(codes(pkg)).toContain("SOURCE_MISSING");
  });
});

describe("validateCapturePackage — expiration", () => {
  it("marks an old capture as SOURCE_EXPIRED without touching the value", () => {
    const pkg = makePackage();
    const report = validateCapturePackage(pkg, { now: new Date("2026-03-15T00:00:00.000Z") });
    expect(report.issues.map((item) => item.error.code)).toContain("SOURCE_EXPIRED");
    expect(report.verdict).toBe("blocked");
    const price = report.fieldDetails.find((item) => item.field === "price");
    expect(price?.expiration.state).toBe("expired");
    const images = report.fieldDetails.find((item) => item.field === "images");
    expect(images?.expiration.state).toBe("valid");
    expect(pkg.fields.price).toEqual({ amount: 29.99, currency: "USD" });
  });

  it("expired field detail drives RETRYABLE via the verdict mapping", () => {
    const pkg = makePackage();
    const report = validateCapturePackage(pkg, { now: new Date("2026-03-15T00:00:00.000Z") });
    expect(targetStateForVerdict(report)).toBe("RETRYABLE");
  });

  it("accepts an explicit per-field policy override", () => {
    const pkg = makePackage();
    const report = validateCapturePackage(pkg, {
      now: new Date("2026-02-01T03:00:00.000Z"),
      fieldPolicy: { price: 60 * 60 * 1000 },
    });
    expect(report.issues.map((item) => item.error.code)).toContain("SOURCE_EXPIRED");
  });
});

describe("validateCapturePackage — conflict detection", () => {
  it("flags a title that contradicts the previously confirmed version", () => {
    const previous = makePackage({ captureId: "cap-old", version: 1 });
    const current = makePackage({
      captureId: "cap-new",
      version: 2,
      fields: {
        title: {
          value: "Completely Different Product Title For The Same ASIN, 32 oz",
          valueOrigin: "provider_export",
          sourceRef: "x.title",
        },
      },
    });
    const report = validateCapturePackage(current, { now: NOW, previousPackages: [previous] });
    expect(report.issues.map((item) => item.error.code)).toContain("FIELD_CONFLICT");
    expect(report.verdict).toBe("blocked");
    expect(report.effectivePackage.fieldStates.title.status).toBe("conflict");
    expect(report.effectivePackage.fieldStates.title.conflictWith?.[0]?.sourceRef).toContain("cap-old");
    // 原始采集包本身不被修改
    expect(current.fieldStates.title.status).toBe("confirmed");
  });

  it("does not treat normal price/rating movement as a conflict", () => {
    const previous = makePackage({ captureId: "cap-old", version: 1 });
    const current = makePackage({
      captureId: "cap-new",
      version: 2,
      fields: {
        price: { value: { amount: 24.99, currency: "USD" }, valueOrigin: "provider_export", sourceRef: "x.price" },
        rating: { value: 4.4, valueOrigin: "provider_export", sourceRef: "x.rating" },
        reviewCount: { value: 3100, valueOrigin: "provider_export", sourceRef: "x.reviews" },
      },
    });
    const report = validateCapturePackage(current, { now: NOW, previousPackages: [previous] });
    expect(report.issues.map((item) => item.error.code)).not.toContain("FIELD_CONFLICT");
    expect(report.verdict).toBe("passed");
  });

  it("keeps cross-provider image variants as separate observations", () => {
    const previous = makePackage({ captureId: "cap-sellersprite", version: 1 });
    const current = makePackage({
      captureId: "cap-amazon",
      version: 2,
      sourceProof: { sourceType: "amazon_dom", captureMethod: "browser_dom", capturedAt: "2026-02-01T00:30:00.000Z" },
      fields: { images: { value: ["https://m.media-amazon.com/images/I/another-variant.jpg"], valueOrigin: "page_measured", sourceRef: "amazon_dom.images" } },
    });
    const report = validateCapturePackage(current, { now: NOW, previousPackages: [previous] });
    expect(report.issues.map((item) => item.error.code)).not.toContain("FIELD_CONFLICT");
    expect(report.effectivePackage.fieldStates.images.status).toBe("confirmed");
    expect(current.fieldStates.images.status).toBe("confirmed");
  });

  it("does not conflict different providers even when capture timestamps match", () => {
    const previous = makePackage({ captureId: "cap-sellersprite-same-time", version: 1 });
    const current = makePackage({
      captureId: "cap-amazon-same-time",
      version: 2,
      sourceProof: { sourceType: "amazon_dom", captureMethod: "browser_dom" },
      fields: { title: { value: "Amazon DOM observed title at the same timestamp", valueOrigin: "page_measured", sourceRef: "amazon_dom.title" } },
    });
    const report = validateCapturePackage(current, { now: NOW, previousPackages: [previous] });
    expect(report.issues.map((item) => item.error.code)).not.toContain("FIELD_CONFLICT");
    expect(report.verdict).toBe("passed");
  });

  it("treats same-provider image changes at different times as separate snapshots", () => {
    const previous = makePackage({ captureId: "cap-image-old", version: 1 });
    const current = makePackage({
      captureId: "cap-image-new",
      version: 2,
      sourceProof: { capturedAt: "2026-02-01T00:30:00.000Z" },
      fields: { images: { value: ["https://m.media-amazon.com/images/I/replaced.jpg"], valueOrigin: "provider_export", sourceRef: "x.images" } },
    });
    const report = validateCapturePackage(current, { now: NOW, previousPackages: [previous] });
    expect(report.issues.map((item) => item.error.code)).not.toContain("FIELD_CONFLICT");
    expect(report.verdict).toBe("passed");
  });

  it("blocks an incompatible value from the same provider, field, source ref, and capture time", () => {
    const previous = makePackage({ captureId: "cap-same-scope-v1", version: 1 });
    const current = makePackage({
      captureId: "cap-same-scope-v2",
      version: 2,
      fields: { title: { value: "Different title in the same SellerSprite field at the same capture time", valueOrigin: "provider_export", sourceRef: "x.title" } },
    });
    const report = validateCapturePackage(current, { now: NOW, previousPackages: [previous] });
    expect(report.issues.map((item) => item.error.code)).toContain("FIELD_CONFLICT");
    expect(report.verdict).toBe("blocked");
    expect(report.effectivePackage.fieldStates.title.status).toBe("conflict");
    expect(current.fieldStates.title.status).toBe("confirmed");
  });

  it("fails closed when an ASIN contradicts the amazon subjectKey", () => {
    const current = makePackage({
      fields: { asin: { value: "B0ZZZZZZZZ", valueOrigin: "page_measured", sourceRef: "amazon_dom.asin" } },
      sourceProof: { sourceType: "amazon_dom", captureMethod: "browser_dom", sourceUrl: "https://www.amazon.com/dp/B0ZZZZZZZZ" },
    });
    const report = validateCapturePackage(current, { now: NOW });
    expect(report.issues.map((item) => item.error.code)).toContain("ASIN_NOT_FOUND");
    expect(report.verdict).toBe("blocked");
  });

  it("fails closed when marketplace contradicts the amazon subjectKey", () => {
    const current = makePackage({
      marketplace: "CA",
      sourceProof: { sourceType: "amazon_dom", captureMethod: "browser_dom", sourceUrl: "https://www.amazon.ca/dp/B0FH1ZXTN1" },
    });
    const report = validateCapturePackage(current, { now: NOW });
    expect(report.issues.map((item) => item.error.code)).toContain("MARKETPLACE_MISMATCH");
    expect(report.verdict).toBe("blocked");
  });

  it("ignores versions belonging to a different subject", () => {
    const other = makePackage({
      captureId: "cap-other",
      subjectKey: "amazon:US:B0ZZZZZZZZ",
      fields: {
        title: { value: "A totally unrelated other product title here", valueOrigin: "provider_export", sourceRef: "x.title" },
      },
    });
    const report = validateCapturePackage(makePackage(), { now: NOW, previousPackages: [other] });
    expect(report.verdict).toBe("passed");
  });
});

describe("validateCapturePackage — AI claims are never facts", () => {
  it("blocks an AI claim presented as fact without traceable evidence", () => {
    const report = validateCapturePackage(makePackage(), {
      now: NOW,
      aiClaims: [{
        claimId: "claim-1",
        text: "该商品月销 10000 件",
        generatedBy: "gpt",
        evidenceCaptureIds: [],
        presentedAsFact: true,
      }],
    });
    expect(report.issues.map((item) => item.error.code)).toContain("AI_GENERATED_AS_FACT");
    expect(report.verdict).toBe("blocked");
    const entries = validationAuditEntries({
      report,
      operator: "owner:v1",
      captureId: "cap-1",
      subjectKey: "amazon:US:B0FH1ZXTN1",
    });
    expect(entries.find((entry) => entry.errorCode === "AI_GENERATED_AS_FACT")?.eventKind).toBe("security_audit");
  });

  it("blocks a claim with no evidence at all", () => {
    const report = validateCapturePackage(makePackage(), {
      now: NOW,
      aiClaims: [{
        claimId: "claim-2",
        text: "利润率 40%",
        generatedBy: null,
        evidenceCaptureIds: [],
        presentedAsFact: false,
      }],
    });
    expect(report.issues.map((item) => item.error.code)).toContain("NO_EVIDENCE");
  });

  it("blocks a claim citing evidence that does not belong to this capture", () => {
    const report = validateCapturePackage(makePackage(), {
      now: NOW,
      aiClaims: [{
        claimId: "claim-3",
        text: "差评集中在漏水",
        generatedBy: "gpt",
        evidenceCaptureIds: ["cap-somewhere-else"],
        presentedAsFact: false,
      }],
    });
    expect(report.issues.map((item) => item.error.code)).toContain("UNSUPPORTED_CLAIM");
  });

  it("accepts a claim that cites this capture as evidence", () => {
    const report = validateCapturePackage(makePackage(), {
      now: NOW,
      aiClaims: [{
        claimId: "claim-4",
        text: "标题提到 24oz 容量",
        generatedBy: "gpt",
        evidenceCaptureIds: ["cap-1"],
        presentedAsFact: false,
      }],
    });
    expect(report.verdict).toBe("passed");
  });
});

describe("validateCapturePackage — audit wiring", () => {
  it("turns every issue into an audit entry under the same capture", () => {
    const pkg = makePackage({
      fields: { title: { value: null, valueOrigin: "provider_export", sourceRef: "x.title" } },
    });
    const report = validateCapturePackage(pkg, { now: NOW });
    const entries = validationAuditEntries({
      report,
      operator: "owner:v1",
      captureId: "cap-1",
      subjectKey: "amazon:US:B0FH1ZXTN1",
    });
    expect(entries[0].eventKind).toBe("validation_result");
    expect(entries[0].detail.verdict).toBe("blocked");
    expect(entries.filter((entry) => entry.eventKind === "error")).toHaveLength(report.issues.length);
    for (const entry of entries) {
      expect(entry.captureId).toBe("cap-1");
      expect(entry.subjectKey).toBe("amazon:US:B0FH1ZXTN1");
    }
  });
});
