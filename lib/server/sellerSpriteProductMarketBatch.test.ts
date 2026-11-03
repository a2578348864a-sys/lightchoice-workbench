import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import type { AccessContext } from "@/lib/server/accessPassword";
import { sourceEvidenceAttachmentContentHash } from "@/lib/sourceLayer/evidenceAttachment";
import type { EvidenceSubjectRecord } from "@/lib/sourceLayer/server/evidenceStore";
import { captureContentHashOf, type CaptureEvidenceRecord } from "@/lib/sourceLayer/sourceAdapter";
import {
  captureSellerSpriteProductMarketQueryForBatch,
  isSellerSpriteProductMarketBcrEnabled,
  preflightSellerSpriteProductMarketBaseEvidence,
} from "./sellerSpriteProductMarketBatch";
import { sellerSpriteProductMarketQuerySubjectKey, sellerSpriteQueryFingerprint } from "./sellerSpriteVisibleQuery";

// 批量 BCR 用例需显式声明运行范围；生产缺省仍为 single_asin_only（只允许单 ASIN）。
process.env.V5_ACQUISITION_SCOPE = "batch_and_single";

const owner: AccessContext = { mode: "owner", token: "" };
const ASIN = "B000000001";
const OTHER_ASIN = "B000000002";
const enabledEnv = { NODE_ENV: "test", LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single", SELLERSPRITE_PRODUCT_MARKET_BCR_ENABLED: "true" } as NodeJS.ProcessEnv;
const disabledEnv = { NODE_ENV: "test", LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single", SELLERSPRITE_PRODUCT_MARKET_BCR_ENABLED: "false" } as NodeJS.ProcessEnv;

function baseEvidence(asin: string): EvidenceSubjectRecord {
  const subjectKey = `amazon:US:${asin}`;
  const pkg = {
    schemaVersion: "capture-package.v1",
    captureId: `capture-${asin}`,
    subjectKey,
    version: 1,
    marketplace: "US",
    fields: { asin, title: "Verified product", brand: null, images: [], price: null, rating: null, reviewCount: null, bsr: null, subCategoryBsr: null, estimatedMonthlySales: null, estimatedMonthlyRevenueUsd: null, keywords: [] },
    fieldStates: {}, sourceProof: {}, replay: {}, riskFlags: [],
  } as never;
  const contentHash = captureContentHashOf(pkg as never);
  const evidence: CaptureEvidenceRecord = {
    schemaVersion: "source-evidence-record.v1",
    evidenceId: `evidence-${asin}`,
    captureId: `capture-${asin}`,
    subjectKey,
    version: 1,
    sourceType: "amazon_dom",
    sourceUrl: "https://www.amazon.com/dp/B000000001",
    capturedAt: "2026-10-13T00:00:00.000Z",
    contentHash,
    pkg,
    validation: { verdict: "passed", readyForResearch: false, issueCodes: [], checkedAt: "2026-10-13T00:00:00.000Z" },
    factAuthority: "evidence_only",
  };
  return {
    schemaVersion: "source-evidence-subject.v1",
    subjectKey,
    marketplace: "US",
    updatedAt: "2026-10-13T00:00:00.000Z",
    operator: "owner:v1",
    versions: [evidence],
  };
}

function queryCaptureFixture(
  category: string,
  tables: Array<{ headers: string[]; rows: Array<Array<string | null>> }>,
  queryFingerprint = "",
) {
  const queryInput = { module: "sellersprite_product_market" as const, category, marketplace: "US" as const, filters: {} };
  const subjectKey = sellerSpriteProductMarketQuerySubjectKey(queryInput);
  const payload = {
    schemaVersion: "capture-system-v3-module-evidence.v1",
    module: "sellersprite_product_market",
    subjectKey,
    marketplace: "US",
    capturedAt: "2026-10-13T00:00:00.000Z",
    provider: "SellerSprite",
    sourceSurface: "SellerSprite Product Market",
    sourceUrl: "https://www.sellersprite.com/v3/product-research/",
    providerUpdatedAt: null,
    freshness: { cadenceKey: "sellersprite_product_market" },
    acquisitionMode: "DOM_DIRECT",
    metricNature: "provider_estimate",
    status: "AVAILABLE_WITH_LIMITATION",
    limitations: ["visible_rows_are_not_total_rows"],
    identity: { category },
    data: {
      queryContract: {
        module: queryInput.module,
        marketplace: "US",
        queryInput,
        queryFingerprint: queryFingerprint || sellerSpriteQueryFingerprint(queryInput, "bcr"),
      },
      visibleSnapshot: { tables },
      amazonConfirmed: false,
    },
    evidenceOnly: true,
  };
  const contentHash = sourceEvidenceAttachmentContentHash({
    kind: "v3_sellersprite_product_market_v1",
    sourceType: "sellersprite_plugin",
    subjectKey,
    payload,
  });
  const attachment = {
    schemaVersion: "source-evidence-attachment.v1",
    attachmentId: "attachment-product-market-01",
    subjectKey,
    kind: "v3_sellersprite_product_market_v1",
    sourceType: "sellersprite_plugin",
    capturedAt: "2026-10-13T00:00:00.000Z",
    sourceUrl: "https://www.sellersprite.com/v3/product-research/",
    sourceFingerprint: "query-fingerprint",
    contentHash,
    payload,
  };
  const subject: EvidenceSubjectRecord = {
    schemaVersion: "source-evidence-subject.v1",
    subjectKey,
    marketplace: "US",
    updatedAt: "2026-10-13T00:00:00.000Z",
    operator: "owner:v1",
    versions: [],
    attachments: [attachment as never],
  };
  return {
    subjectKey,
    contentHash,
    attachment,
    subject,
    capture: {
      moduleEvidence: { module: "sellersprite_product_market", subjectKey, metricNature: "provider_estimate" },
      attachment,
      downstream: { subjectKey, attachmentId: attachment.attachmentId },
    },
  };
}

describe("SellerSprite Product Market BCR query-level worker", () => {
  it("keeps real-source execution disabled unless both local and Product Market flags are explicitly true", () => {
    expect(isSellerSpriteProductMarketBcrEnabled(disabledEnv)).toBe(false);
    expect(isSellerSpriteProductMarketBcrEnabled({ NODE_ENV: "test", SELLERSPRITE_PRODUCT_MARKET_BCR_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isSellerSpriteProductMarketBcrEnabled(enabledEnv)).toBe(true);
  });

  it("fails closed before the query/browser call when an authorized ASIN has no valid base Evidence", async () => {
    const captureQuery = vi.fn();
    const getSubject = vi.fn(async () => null);
    const result = await captureSellerSpriteProductMarketQueryForBatch({
      context: owner,
      query: { category: "Kitchen & Dining", filters: {} },
      authorizedAsins: [ASIN],
      env: enabledEnv,
    }, { getSubject, captureQuery: captureQuery as never });

    expect(result).toMatchObject({ status: "blocked", navigationPerformed: false, errorCode: "SELLERSPRITE_PRODUCT_MARKET_BASE_EVIDENCE_MISSING" });
    expect(getSubject).toHaveBeenCalledWith(`amazon:US:${ASIN}`);
    expect(captureQuery).not.toHaveBeenCalled();
  });

  it("stores one query-level V3 attachment and links only authorized rows with a verified product Evidence identity", async () => {
    const category = "Kitchen & Dining";
    const fixture = queryCaptureFixture(category, [{
      headers: ["ASIN", "Title"],
      rows: [[ASIN, "Verified from SellerSprite visible query"], [OTHER_ASIN, "Another product"], [ASIN, ""]],
    }]);
    let querySubject: EvidenceSubjectRecord | null = null;
    const getSubject = vi.fn(async (subjectKey: string) => {
      if (subjectKey === `amazon:US:${ASIN}`) return baseEvidence(ASIN);
      if (subjectKey === fixture.subjectKey) return querySubject;
      return null;
    });
    const captureQuery = vi.fn(async () => {
      querySubject = fixture.subject;
      return {
        status: "captured",
        module: "sellersprite_product_market",
        sourceUrl: "https://www.sellersprite.com/v3/product-research/",
        snapshot: { tables: [{ headers: ["ASIN", "Title"], rows: [[ASIN, "Verified from SellerSprite visible query"], [OTHER_ASIN, "Another product"], [ASIN, ""]] }] },
        capture: fixture.capture,
        errorCode: null,
      } as never;
    });
    const result = await captureSellerSpriteProductMarketQueryForBatch({
      context: owner,
      query: { category, filters: {} },
      authorizedAsins: [ASIN],
      env: enabledEnv,
    }, { getSubject, captureQuery: captureQuery as never });

    expect(result.status).toBe("captured");
    expect(result.navigationPerformed).toBe(true);
    expect(result.querySubjectKey).toBe(fixture.subjectKey);
    expect(result.evidenceAttachmentId).toBe(fixture.attachment.attachmentId);
    expect(result.evidenceContentHash).toBe(fixture.contentHash);
    expect(result.rowsObserved).toBe(2);
    expect(result.productAssociations).toEqual([{
      asin: ASIN,
      rowKey: `asin:${createHash("sha256").update(ASIN).digest("hex")}`,
      rowContentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      baseEvidenceId: `evidence-${ASIN}`,
      baseEvidenceVersion: 1,
      baseEvidenceContentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }]);
    expect(result.productAssociations.some((link) => link.asin === OTHER_ASIN)).toBe(false);
  });

  it("rejects a self-consistent attachment whose query fingerprint does not match its query contract", async () => {
    const category = "Kitchen & Dining";
    const fixture = queryCaptureFixture(category, [{
      headers: ["ASIN", "Title"],
      rows: [[ASIN, "Verified from SellerSprite visible query"]],
    }], "f".repeat(64));
    const getSubject = vi.fn(async (subjectKey: string) => {
      if (subjectKey === `amazon:US:${ASIN}`) return baseEvidence(ASIN);
      if (subjectKey === fixture.subjectKey) return fixture.subject;
      return null;
    });
    const result = await captureSellerSpriteProductMarketQueryForBatch({
      context: owner,
      query: { category, filters: {} },
      authorizedAsins: [ASIN],
      env: enabledEnv,
    }, {
      getSubject,
      captureQuery: vi.fn(async () => ({
        status: "captured",
        sourceUrl: "https://www.sellersprite.com/v3/product-research/",
        snapshot: { tables: [{ headers: ["ASIN", "Title"], rows: [[ASIN, "Verified from SellerSprite visible query"]] }] },
        capture: fixture.capture,
        errorCode: null,
      } as never)) as never,
    });

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "SELLERSPRITE_PRODUCT_MARKET_EVIDENCE_READBACK_INVALID",
      productAssociations: [],
    });
  });
});
