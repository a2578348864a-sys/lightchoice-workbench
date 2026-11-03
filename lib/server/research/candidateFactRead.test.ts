import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureEvidenceRecord } from "@/lib/sourceLayer/sourceAdapter";
import { captureContentHashOf } from "@/lib/sourceLayer/sourceAdapter";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import { buildSourceEvidenceAttachment, type SourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import { buildV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import { getAmazonDetailFieldRule } from "@/tools/collectors/amazon/detail-page-field-registry";

const mocks = vi.hoisted(() => ({
  getSubject: vi.fn(),
  adaptEvidence: vi.fn(),
}));

vi.mock("@/lib/sourceLayer/server/evidenceStore", () => ({
  createEvidenceStore: vi.fn(() => ({ getSubject: mocks.getSubject })),
}));
vi.mock("@/lib/sourceLayer/server/sourceLayerService", () => ({
  sourceLayerOperator: vi.fn(() => ({})),
}));
vi.mock("@/lib/marketScan/candidateContract", () => ({
  verifyCandidateFactBinding: vi.fn(() => ({ valid: true, binding: null })),
}));
vi.mock("@/lib/sourceLayer/fact/productFactAdapter", () => ({
  adaptEvidenceToProductFact: mocks.adaptEvidence,
}));

import { readVerifiedCandidateFact } from "@/lib/server/research/candidateFactRead";

const ASIN = "B0HISTORY1";
const SUBJECT = `amazon:US:${ASIN}`;
const URL = `https://www.amazon.com/dp/${ASIN}`;
const NOW = "2026-10-01T00:00:00.000Z";

function evidence(options: { id: string; version: number; capturedAt: string; title?: string | null }): CaptureEvidenceRecord {
  const title = options.title === undefined ? "Historical product title" : options.title;
  const isCurrentEmpty = title === null;
  const sourceProof = {
    sourceType: "amazon_dom",
    capturedAt: options.capturedAt,
    sourceUrl: URL,
    operator: "owner:v1",
    entityBinding: {
      bound: true,
      expectedAsin: ASIN,
      observedAsin: ASIN,
      expectedMarketplace: "US",
      observedMarketplace: "US",
      urlAsin: ASIN,
      urlMarketplace: "US",
    },
  };
  const sourceTrace = (ruleId: "title" | "price") => ({
    ruleId,
    registryVersion: "amazon-detail-field-registry.v1",
    region: ruleId === "title" ? "primary_product_title" : "primary_buy_box",
    selector: ruleId === "title" ? "#productTitle" : "#corePrice_feature_div .apex-pricetopay-value .a-offscreen",
    label: null,
    ruleVersion: null,
    ...(ruleId === "price" ? {
      semanticRole: "current_pay_now",
      purchaseContext: "one_time",
      selected: true,
      resolverVersion: "amazon-detail-field-resolver.v1",
    } : {}),
  });
  const pkg = {
    schemaVersion: "source-capture-package.v1",
    captureId: `capture-${options.id}`,
    subjectKey: SUBJECT,
    version: options.version,
    marketplace: "US",
    fields: { asin: ASIN, title, price: null },
    fieldStates: {
      title: {
        status: isCurrentEmpty ? "missing" : "confirmed",
        metricNature: isCurrentEmpty ? "unknown" : "snapshot",
        valueOrigin: isCurrentEmpty ? "none" : "page_measured",
        confidence: isCurrentEmpty ? 0 : 1,
        sourceRef: "amazon_dom.title",
      },
      price: { status: "missing", metricNature: "unknown", valueOrigin: "none", confidence: 0, sourceRef: "amazon_dom.price" },
    },
    extensions: {
      amazonDetail: {
        schemaVersion: "amazon-detail-registered-fields.v1",
        extractorVersion: "amazon-detail-extractor.v2",
        fieldRegistryVersion: "amazon-detail-field-registry.v1",
        primaryBsrProjectionVersion: "primary-bsr.v1",
        resolverVersion: "amazon-detail-field-resolver.v1",
        registeredFields: {
          title: {
            canonicalField: "title",
            priority: "P0",
            fieldNature: "DIRECT_FACT",
            status: isCurrentEmpty ? "missing" : "observed",
            value: title,
            reason: isCurrentEmpty ? "selector_not_found" : null,
            sourceTrace: sourceTrace("title"),
          },
          price: {
            canonicalField: "price",
            priority: "P0",
            fieldNature: "DIRECT_FACT",
            status: "missing",
            value: null,
            reason: "selector_not_found",
            sourceTrace: sourceTrace("price"),
          },
        },
      },
    },
    sourceProof,
  };
  const record = {
    schemaVersion: "source-evidence-record.v1",
    evidenceId: options.id,
    captureId: `capture-${options.id}`,
    subjectKey: SUBJECT,
    version: options.version,
    sourceType: "amazon_dom",
    sourceUrl: URL,
    capturedAt: options.capturedAt,
    contentHash: captureContentHashOf(pkg as never),
    pkg,
    validation: { verdict: "passed", readyForResearch: true, issueCodes: [], checkedAt: NOW },
    factAuthority: "evidence_only",
  };
  return record as unknown as CaptureEvidenceRecord;
}

function baseFact(current: CaptureEvidenceRecord): ProductFact {
  const missing = (source: "amazon_dom" = "amazon_dom") => ({
    value: null,
    status: "missing",
    source,
    confidence: 0,
    capturedAt: NOW,
    rawProofHash: current.contentHash,
  });
  const fact = {
    schema: "product-fact.v3",
    subjectKey: SUBJECT,
    sourceProof: {
      source: "amazon_dom",
      captureId: current.captureId,
      evidenceId: current.evidenceId,
      subjectKey: SUBJECT,
      capturedAt: current.capturedAt,
      contentHash: current.contentHash,
      sourceUrl: URL,
      operator: "owner:v1",
      entityBinding: current.pkg.sourceProof.entityBinding,
    },
    basic: {
      asin: { value: ASIN, status: "present", source: "amazon_dom", confidence: 1, capturedAt: NOW, rawProofHash: current.contentHash },
      title: missing(),
      image: missing(),
      price: missing(),
      brand: missing(),
      category: missing(),
      rating: missing(),
      reviewCount: missing(),
      bulletPoints: missing(),
    },
    market: {
      bsr: missing(), monthlySalesEstimate: missing(), monthlyRevenueEstimate: missing(), launchedDate: missing(),
      subCategoryBsr: missing(), dateFirstAvailable: missing(), buyboxSeller: missing(), fulfillmentType: missing(),
      estimatedGrossMargin: missing(), listingQualityScore: missing(),
    },
    profit: {
      packageWeight: missing(), packageDimensions: missing(), fbaFee: missing(), itemWeight: missing(), itemDimensions: missing(),
    },
    extended: {
      categoryPath: missing(), parentAsin: missing(), material: missing(), includedComponents: missing(),
      galleryImageUrls: missing(), listPrice: missing(), coupon: missing(), seller: missing(), shipsFrom: missing(),
      fulfillment: missing(), buyBox: missing(), ratingDistribution: missing(), boughtPastMonth: missing(), variations: missing(),
      bsrRanks: missing(), itemWeight: missing(), itemDimensions: missing(), amazonDetail: missing(),
    },
  };
  return fact as unknown as ProductFact;
}

function amazonDetailAttachment(input: {
  fields: Record<string, { value: unknown; fieldNature?: string; status?: string; ruleVersion?: string | null }>;
  asin?: string;
  subject?: string;
  capturedAt?: string;
  status?: "VALIDATED_AVAILABLE" | "AVAILABLE_WITH_LIMITATION";
}): SourceEvidenceAttachment {
  const asin = input.asin ?? ASIN;
  const subjectKey = input.subject ?? SUBJECT;
  const capturedAt = input.capturedAt ?? NOW;
  const registeredFields = Object.fromEntries(Object.entries(input.fields).map(([key, field]) => [key, {
    canonicalField: key,
    priority: getAmazonDetailFieldRule(key)?.priority ?? "P1",
    fieldNature: field.fieldNature ?? getAmazonDetailFieldRule(key)?.fieldNature ?? "DIRECT_FACT",
    status: field.status ?? "observed",
    value: field.value,
    reason: null,
    sourceTrace: {
      ruleId: key,
      registryVersion: "amazon-detail-field-registry.v1",
      region: getAmazonDetailFieldRule(key)?.pageRegion ?? "test_region",
      selector: ".test",
      label: null,
      ruleVersion: field.ruleVersion ?? null,
    },
  }]));
  const payload = buildV3ModuleEvidence({
    module: "amazon_detail",
    subjectKey,
    marketplace: "US",
    capturedAt,
    provider: "Amazon",
    sourceSurface: "Amazon product detail DOM",
    sourceUrl: `https://www.amazon.com/dp/${asin}`,
    acquisitionMode: "DOM_DIRECT",
    metricNature: "source_observed",
    status: input.status ?? "VALIDATED_AVAILABLE",
    limitations: input.status === "AVAILABLE_WITH_LIMITATION" ? ["limited_fields"] : [],
    identity: { asin },
    data: { fieldRegistryVersion: "amazon-detail-field-registry.v1", registeredFields },
    evidenceOnly: true,
  });
  return buildSourceEvidenceAttachment({
    attachmentId: `detail-${asin}-${capturedAt}`,
    subjectKey,
    kind: "v3_amazon_detail_v1",
    sourceType: "amazon_dom",
    capturedAt,
    sourceUrl: payload.sourceUrl,
    payload: payload as unknown as Record<string, unknown>,
  });
}

function variationAttachment(): SourceEvidenceAttachment {
  const capturedAt = "2026-10-04T00:00:00.000Z";
  const parentAsin = "B0PARENT01";
  const peerAsin = "B0CHILD002";
  const payload = buildV3ModuleEvidence({
    module: "variation",
    subjectKey: SUBJECT,
    marketplace: "US",
    capturedAt,
    provider: "Amazon",
    sourceSurface: "Amazon product detail variation selector",
    sourceUrl: URL,
    acquisitionMode: "DOM_DIRECT",
    metricNature: "source_observed",
    status: "VALIDATED_AVAILABLE",
    identity: { asin: ASIN, parentAsin },
    data: {
      outcome: "COMPLETE",
      variationStatus: "COMPLETE",
      currentAsin: ASIN,
      parentAsin,
      variantAsins: [ASIN, peerAsin],
      variants: [
        { asin: ASIN, options: [{ dimensionKey: "color", label: "Color", value: "Blue" }] },
        { asin: peerAsin, options: [{ dimensionKey: "color", label: "Color", value: "Red" }] },
      ],
      identityProof: { urlAsin: ASIN, pageAsin: ASIN, productContainerFound: true, bound: true },
      error: null,
    },
    evidenceOnly: true,
  });
  return buildSourceEvidenceAttachment({
    attachmentId: "variation-current",
    subjectKey: SUBJECT,
    kind: "v3_variation_v1",
    sourceType: "amazon_dom",
    capturedAt,
    sourceUrl: URL,
    payload: payload as unknown as Record<string, unknown>,
  });
}

describe("readVerifiedCandidateFact Amazon history projection", () => {
  beforeEach(() => {
    mocks.getSubject.mockReset();
    mocks.adaptEvidence.mockReset();
  });

  it("projects safe history, replays the stored decision hash, and rejects a tampered cached field", async () => {
    const old = evidence({ id: "ev-old-title", version: 1, capturedAt: "2026-09-30T00:00:00.000Z" });
    const current = evidence({ id: "ev-current", version: 2, capturedAt: NOW, title: null });
    const authoritative = baseFact(current);
    mocks.getSubject.mockResolvedValue({ subjectKey: SUBJECT, versions: [old, current], attachments: [] });
    mocks.adaptEvidence.mockReturnValue(authoritative);
    const input = {
      context: { mode: "owner", token: "test" } as never,
      meta: {},
      productFact: authoritative,
      now: NOW,
    };

    const projected = await readVerifiedCandidateFact(input);
    expect(projected.basic.title).toMatchObject({
      value: "Historical product title",
      source: "amazon_dom",
      status: "present",
      evidenceRefs: [{ evidenceId: old.evidenceId, contentHash: old.contentHash }],
    });
    expect(projected.basic.price.value).toBeNull();
    expect(projected.amazonDetailHistory?.fields.price.status).toBe("missing");

    const replayed = await readVerifiedCandidateFact({ ...input, productFact: projected });
    expect(replayed).toEqual(projected);

    await expect(readVerifiedCandidateFact({
      ...input,
      productFact: { ...projected, basic: { ...projected.basic, title: { ...projected.basic.title, value: "Tampered" } } },
    })).rejects.toThrow("PRODUCT_FACT_CACHE_HASH_MISMATCH");
  });

  it("projects a validated same-ASIN detail attachment into missing fields with field-level provenance", async () => {
    const current = evidence({ id: "ev-detail-current", version: 1, capturedAt: NOW, title: null });
    const authoritative = baseFact(current);
    const detail = amazonDetailAttachment({ fields: {
      brand: { value: "Koolstuffs" },
      itemDimensions: { value: { rawText: '16.5\"L x 11.6\"W', dimensions: [16.5, 11.6], unit: "in" } },
      itemWeight: { value: { rawText: "9.76 ounces", amount: 9.76, unit: "oz" } },
    } });
    mocks.getSubject.mockResolvedValue({ subjectKey: SUBJECT, versions: [current], attachments: [detail] });
    mocks.adaptEvidence.mockReturnValue(authoritative);

    const projected = await readVerifiedCandidateFact({
      context: { mode: "owner", token: "test" } as never,
      meta: {},
      productFact: authoritative,
      now: NOW,
    });

    expect(projected.basic.brand).toMatchObject({ value: "Koolstuffs", status: "present", source: "amazon_dom" });
    expect(projected.basic.brand.evidenceRefs).toEqual([expect.objectContaining({
      refId: `attachment:${detail.attachmentId}`,
      evidenceId: detail.attachmentId,
      contentHash: detail.contentHash,
      subjectKey: SUBJECT,
    })]);
    expect(projected.profit.itemDimensions?.value).toEqual({ length: 16.5, width: 11.6, unit: "in" });
    expect(projected.profit.packageDimensions.value).toBeNull();
    expect(projected.profit.itemWeight?.value).toEqual({ value: 9.76, unit: "oz" });
    expect(projected.profit.packageWeight.value).toBeNull();
  });

  it("projects only identity-bound variation structure and does not invent sales metrics", async () => {
    const current = evidence({ id: "ev-variation-current", version: 1, capturedAt: NOW, title: null });
    const authoritative = baseFact(current);
    const variation = variationAttachment();
    mocks.getSubject.mockResolvedValue({ subjectKey: SUBJECT, versions: [current], attachments: [variation] });
    mocks.adaptEvidence.mockReturnValue(authoritative);

    const projected = await readVerifiedCandidateFact({
      context: { mode: "owner", token: "test" } as never,
      meta: {},
      productFact: authoritative,
      now: NOW,
    });

    expect(projected.extended?.parentAsin).toMatchObject({ value: "B0PARENT01", status: "present" });
    expect(projected.extended?.variationStructure).toMatchObject({
      outcome: "complete",
      parentAsin: "B0PARENT01",
      memberAsins: [ASIN, "B0CHILD002"],
      members: [
        { asin: ASIN, options: [{ dimensionKey: "color", label: "Color", value: "Blue" }] },
        { asin: "B0CHILD002", options: [{ dimensionKey: "color", label: "Color", value: "Red" }] },
      ],
    });
    expect(projected.variationAnalysis).toBeUndefined();
    expect(projected.extended?.variationStructure?.evidenceRefs[0]?.refId).toBe(`attachment:${variation.attachmentId}`);
  });

  it("retains both source references for equal values and suppresses unresolved review-count conflicts", async () => {
    const current = evidence({ id: "ev-detail-conflict", version: 1, capturedAt: NOW, title: null });
    const base = baseFact(current);
    const authoritative = {
      ...base,
      basic: {
        ...base.basic,
        brand: { ...base.basic.brand, value: "Koolstuffs", status: "present", confidence: 1 },
        reviewCount: { ...base.basic.reviewCount, value: 3, status: "present", confidence: 1 },
      },
    } as ProductFact;
    const detail = amazonDetailAttachment({ fields: {
      brand: { value: "Koolstuffs" },
      reviewCount: { value: 3354 },
    } });
    mocks.getSubject.mockResolvedValue({ subjectKey: SUBJECT, versions: [current], attachments: [detail] });
    mocks.adaptEvidence.mockReturnValue(authoritative);

    const projected = await readVerifiedCandidateFact({
      context: { mode: "owner", token: "test" } as never,
      meta: {},
      productFact: authoritative,
      now: NOW,
    });

    expect(projected.basic.brand.value).toBe("Koolstuffs");
    expect(projected.basic.brand.evidenceRefs?.map((ref) => ref.refId)).toEqual([
      `evidence:${current.evidenceId}`,
      `attachment:${detail.attachmentId}`,
    ]);
    expect(projected.basic.reviewCount).toMatchObject({ value: null, status: "missing" });
    expect(projected.sourceConflicts).toEqual([expect.objectContaining({
      field: "basic.reviewCount",
      code: "SOURCE_CONFLICT_UNRESOLVED",
      resolved: false,
      candidates: expect.arrayContaining([
        expect.objectContaining({ value: 3, capturedAt: current.capturedAt }),
        expect.objectContaining({ value: 3354, capturedAt: detail.capturedAt }),
      ]),
    })]);
  });

  it("treats Amazon image renditions of the same asset as one image fact", async () => {
    const current = evidence({ id: "ev-image-rendition", version: 1, capturedAt: NOW, title: null });
    const base = baseFact(current);
    const searchImage = "https://m.media-amazon.com/images/I/51+hwXt2HML._AC_UL320_.jpg";
    const detailImage = "https://m.media-amazon.com/images/I/51+hwXt2HML._AC_SL1366_.jpg";
    const authoritative = {
      ...base,
      basic: {
        ...base.basic,
        image: { ...base.basic.image, value: searchImage, status: "present", confidence: 1 },
      },
    } as ProductFact;
    const detail = amazonDetailAttachment({ fields: { mainImage: { value: detailImage } } });
    mocks.getSubject.mockResolvedValue({ subjectKey: SUBJECT, versions: [current], attachments: [detail] });
    mocks.adaptEvidence.mockReturnValue(authoritative);

    const projected = await readVerifiedCandidateFact({
      context: { mode: "owner", token: "test" } as never,
      meta: {},
      productFact: authoritative,
      now: NOW,
    });

    expect(projected.basic.image.value).toBe(searchImage);
    expect(projected.basic.image.evidenceRefs?.map((ref) => ref.refId)).toEqual([
      `evidence:${current.evidenceId}`,
      `attachment:${detail.attachmentId}`,
    ]);
    expect(projected.sourceConflicts ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "basic.image", code: "SOURCE_CONFLICT_UNRESOLVED" }),
    ]));
  });

  it("rejects image URLs from hosts that only share the media-amazon.com suffix", async () => {
    const current = evidence({ id: "ev-image-host", version: 1, capturedAt: NOW, title: null });
    const authoritative = baseFact(current);
    const detail = amazonDetailAttachment({ fields: {
      mainImage: { value: "https://notmedia-amazon.com/images/I/fake.jpg" },
    } });
    mocks.getSubject.mockResolvedValue({ subjectKey: SUBJECT, versions: [current], attachments: [detail] });
    mocks.adaptEvidence.mockReturnValue(authoritative);

    const projected = await readVerifiedCandidateFact({
      context: { mode: "owner", token: "test" } as never,
      meta: {},
      productFact: authoritative,
      now: NOW,
    });

    expect(projected.basic.image.value).toBeNull();
    expect(projected.basic.image.evidenceRefs).toBeUndefined();
  });

  it("rejects mismatched or limited detail evidence and does not upgrade estimates into Amazon facts", async () => {
    const current = evidence({ id: "ev-detail-rejected", version: 1, capturedAt: NOW, title: null });
    const authoritative = baseFact(current);
    const wrongIdentity = amazonDetailAttachment({
      asin: "B0OTHER001",
      subject: "amazon:US:B0OTHER001",
      fields: { brand: { value: "Wrong brand" } },
    });
    const limited = amazonDetailAttachment({
      status: "AVAILABLE_WITH_LIMITATION",
      fields: { brand: { value: "Unverified brand" } },
      capturedAt: "2026-10-02T00:00:00.000Z",
    });
    const estimated = amazonDetailAttachment({
      fields: { boughtPastMonth: { value: 500, fieldNature: "ESTIMATED_METRIC" } },
      capturedAt: "2026-10-03T00:00:00.000Z",
    });
    mocks.getSubject.mockResolvedValue({ subjectKey: SUBJECT, versions: [current], attachments: [wrongIdentity, limited, estimated] });
    mocks.adaptEvidence.mockReturnValue(authoritative);

    const projected = await readVerifiedCandidateFact({
      context: { mode: "owner", token: "test" } as never,
      meta: {},
      productFact: authoritative,
      now: NOW,
    });

    expect(projected.basic.brand.value).toBeNull();
    expect(projected.market?.monthlySalesEstimate?.value).toBeNull();
  });
});
