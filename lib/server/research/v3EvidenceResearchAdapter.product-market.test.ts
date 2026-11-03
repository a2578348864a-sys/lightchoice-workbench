import { describe, expect, it } from "vitest";
import type { SourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import { buildV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import { adaptV3ProductMarketAttachment } from "@/lib/server/research/v3EvidenceResearchAdapter";

const SUBJECT = "amazon:US:B07G4YXMNK";
const PARENT = "B0B75Y63J4";
const CAPTURED_AT = "2026-09-26T08:50:36.000Z";

function productMarketAttachment(input: {
  subjectKey?: string;
  asin?: string;
  parentAsin?: string | null;
  attachmentSourceUrl?: string | null;
  metricNature?: "provider_estimate" | "provider_observed" | "source_observed";
  status?: "VALIDATED_AVAILABLE" | "AVAILABLE_WITH_LIMITATION" | "BLOCKED_WITH_EVIDENCE";
  data?: Record<string, unknown>;
} = {}): SourceEvidenceAttachment {
  const subjectKey = input.subjectKey ?? SUBJECT;
  const capturedAt = CAPTURED_AT;
  const payload = buildV3ModuleEvidence({
    module: "sellersprite_product_market",
    subjectKey,
    marketplace: "US",
    capturedAt,
    provider: "SellerSprite",
    sourceSurface: "SellerSprite competitor lookup visible result",
    sourceUrl: "https://www.sellersprite.com/v3/competitor-lookup?asins=%5B%22B07G4YXMNK%22%5D",
    acquisitionMode: "DOM_DIRECT",
    metricNature: input.metricNature ?? "provider_observed",
    status: input.status ?? "AVAILABLE_WITH_LIMITATION",
    limitations: ["visible result only"],
    identity: {
      asin: input.asin ?? "B07G4YXMNK",
      parentAsin: input.parentAsin === undefined ? PARENT : input.parentAsin,
    },
    data: input.data ?? {
      bsr: { rank: 30297, category: "Home & Kitchen" },
      price: { amount: 37.01, currency: "USD" },
      rating: 4.6,
      reviewCount: 1046,
    },
  });

  return {
    schemaVersion: "source-evidence-attachment.v1",
    attachmentId: "att-sellersprite-market-1",
    subjectKey,
    kind: "v3_sellersprite_product_market_v1",
    sourceType: "sellersprite_plugin",
    capturedAt,
    sourceUrl: input.attachmentSourceUrl === undefined ? payload.sourceUrl : input.attachmentSourceUrl,
    sourceFingerprint: "fixture-query-fingerprint",
    contentHash: "a".repeat(64),
    payload,
  } as SourceEvidenceAttachment;
}

describe("V3 SellerSprite Product Market Research adapter", () => {
  it("projects only explicit exact-ASIN metrics and keeps provider provenance and parent identity", () => {
    const adapted = adaptV3ProductMarketAttachment(productMarketAttachment(), SUBJECT);

    expect(adapted).toMatchObject({
      attachmentId: "att-sellersprite-market-1",
      evidenceRef: "attachment:att-sellersprite-market-1",
      subjectKey: SUBJECT,
      asin: "B07G4YXMNK",
      parentAsin: PARENT,
      module: "sellersprite_product_market",
      sourceSurface: "SellerSprite competitor lookup visible result",
      sourceType: "sellersprite_plugin",
      sourceUrl: expect.stringContaining("sellersprite.com/v3/competitor-lookup"),
      capturedAt: CAPTURED_AT,
      metricNature: "provider_observed",
      productMetrics: [
        { metric: "bsrRank", value: 30297, unit: "unknown", scope: "Home & Kitchen", metricNature: "provider_observed" },
        { metric: "price", value: 37.01, unit: "currency", raw: "37.01 USD", metricNature: "provider_observed" },
        { metric: "rating", value: 4.6, raw: "4.6 / 5", metricNature: "provider_observed" },
        { metric: "reviewCount", value: 1046, unit: "count", metricNature: "provider_observed" },
      ],
    });
  });

  it("rejects mismatched subject or ASIN identity", () => {
    expect(adaptV3ProductMarketAttachment(productMarketAttachment({
      subjectKey: "amazon:US:B000000001",
      asin: "B000000001",
    }), SUBJECT)).toBeNull();
    const valid = productMarketAttachment();
    const payload = valid.payload as Record<string, unknown>;
    expect(adaptV3ProductMarketAttachment(
      { ...valid, payload: { ...payload, identity: { asin: "B000000001", parentAsin: PARENT } } },
      SUBJECT,
    )).toBeNull();
  });

  it("fails closed for blocked evidence or non-provider metric nature", () => {
    expect(adaptV3ProductMarketAttachment(productMarketAttachment({ status: "BLOCKED_WITH_EVIDENCE" }), SUBJECT)).toBeNull();
    expect(adaptV3ProductMarketAttachment(productMarketAttachment({ metricNature: "source_observed" }), SUBJECT)).toBeNull();
  });

  it("rejects conflicting attachment and payload source URLs", () => {
    expect(adaptV3ProductMarketAttachment(productMarketAttachment({
      attachmentSourceUrl: "https://www.sellersprite.com/v3/different-module/",
    }), SUBJECT)).toBeNull();
  });

  it("does not infer metric meanings from unnamed table columns or parent-level rows", () => {
    expect(adaptV3ProductMarketAttachment(productMarketAttachment({ data: {
      tables: [{ index: 1, rows: [["1", "parent sales", "267", "child sales", "50+"]] }],
    } }), SUBJECT)).toBeNull();
  });

  it("preserves provider-estimate nature for estimated direct metrics", () => {
    const adapted = adaptV3ProductMarketAttachment(productMarketAttachment({
      metricNature: "provider_estimate",
      data: { bsr: { rank: 120, category: "Home & Kitchen" } },
    }), SUBJECT);

    expect(adapted?.productMetrics).toEqual([
      expect.objectContaining({ metric: "bsrRank", value: 120, metricNature: "provider_estimate" }),
    ]);
  });
});
