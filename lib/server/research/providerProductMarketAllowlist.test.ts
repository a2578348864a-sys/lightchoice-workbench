import { describe, expect, it } from "vitest";
import { allowedEvidenceRefsOf } from "@/lib/server/v5ResearchService";

const subjectKey = "amazon:US:B000000001";
const attachmentId = "market-attachment-1";
const contentHash = "a".repeat(64);
const capturedAt = "2026-09-26T08:50:36.000Z";

function providerEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "provider-product-market-evidence.v1",
    provider: "SellerSprite",
    module: "sellersprite_product_market",
    subjectKey,
    marketplace: "US",
    asin: "B000000001",
    parentAsin: null,
    sourceType: "sellersprite_plugin",
    sourceSurface: "visible product summary",
    sourceUrl: null,
    evidenceRefId: `attachment:${attachmentId}`,
    attachmentId,
    contentHash,
    capturedAt,
    observedAt: null,
    metricPeriod: null,
    metricNature: "provider_estimate",
    limitations: [],
    metrics: [{ metric: "monthlySalesEstimate", value: 80, unit: "count", currency: null, metricNature: "provider_estimate", status: "parsed", raw: "80", scope: null }],
    ...overrides,
  };
}

function bundle(evidence: Record<string, unknown> = providerEvidence(), refOverrides: Record<string, unknown> = {}) {
  return {
    productFact: { subjectKey, basic: { asin: { value: "B000000001" } } },
    sourceEvidenceRefs: [{
      refId: `attachment:${attachmentId}`,
      kind: "attachment",
      subjectKey,
      attachmentId,
      contentHash,
      capturedAt,
      evidenceId: "evidence-1",
      captureId: "capture-1",
      version: 1,
      ...refOverrides,
    }],
    providerProductMarketEvidence: [evidence],
  };
}

describe("SellerSprite Product Market allowlist binding", () => {
  it("allows only the exact attachment reference after subject, ASIN, hash and capture-time match", () => {
    const allowed = allowedEvidenceRefsOf(bundle() as never);

    expect(allowed).toContain(`attachment:${attachmentId}`);
    expect(allowed).toContain(`attachment:${contentHash}`);
    expect(allowed).toContain(`attachment:a-${contentHash}`);
  });

  it.each([
    ["cross subject", providerEvidence({ subjectKey: "amazon:US:B0ZZZZZZZZ", asin: "B0ZZZZZZZZ" }), {}],
    ["wrong ASIN", providerEvidence({ asin: "B0ZZZZZZZZ" }), {}],
    ["unbound hash", providerEvidence({ contentHash: "b".repeat(64) }), {}],
    ["unbound capture time", providerEvidence({ capturedAt: "2026-09-27T08:50:36.000Z" }), {}],
    ["wrong metric nature", providerEvidence({ metricNature: "source_observed" }), {}],
    ["wrong reference subject", providerEvidence(), { subjectKey: "amazon:US:B0ZZZZZZZZ" }],
  ])("rejects %s provider evidence", (_label, evidence, refOverrides) => {
    const allowed = allowedEvidenceRefsOf(bundle(evidence as Record<string, unknown>, refOverrides as Record<string, unknown>) as never);
    expect(allowed).not.toContain(`attachment:${attachmentId}`);
  });
});
