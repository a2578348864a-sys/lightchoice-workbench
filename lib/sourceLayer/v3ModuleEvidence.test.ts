import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AccessContext } from "@/lib/server/accessPassword";
import { captureThroughGateway } from "@/lib/sourceLayer/server/captureGateway";
import {
  buildV3ModuleEvidence,
  captureV3ModuleEvidence,
  readV3ModuleEvidence,
} from "@/lib/sourceLayer/v3ModuleEvidence";

const OWNER_CONTEXT: AccessContext = { mode: "owner", token: "" };
const CAPTURED_AT = "2026-09-26T08:00:00.000Z";
const SUBJECT_KEY = "amazon:US:B0GATEWAY1";

describe("Capture System V3 module evidence", () => {
  let tempRoot = "";

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "source-layer-v3-module-"));
    process.env.SOURCE_LAYER_STORE_DIR = join(tempRoot, "store");
  });

  afterEach(() => {
    delete process.env.SOURCE_LAYER_STORE_DIR;
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it("keeps provenance and rejects credential-like fields", () => {
    expect(() => buildV3ModuleEvidence({
      module: "reverse_asin",
      subjectKey: SUBJECT_KEY,
      capturedAt: CAPTURED_AT,
      provider: "SellerSprite",
      sourceSurface: "reverse asin visible table",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/?q=B0GATEWAY1&marketId=1",
      acquisitionMode: "DOM_DIRECT",
      metricNature: "provider_observed",
      status: "VALIDATED_AVAILABLE",
      identity: { asin: "B0GATEWAY1", keyword: "water bottle" },
      data: { rows: [{ keyword: "water bottle", reverseAsins: 12 }], token: "must-not-persist" },
    })).toThrow("V3_MODULE_CREDENTIAL_FIELD_FORBIDDEN");
  });

  it("binds the visible module identity to its Amazon subject", () => {
    expect(() => buildV3ModuleEvidence({
      module: "reverse_asin",
      subjectKey: SUBJECT_KEY,
      capturedAt: CAPTURED_AT,
      provider: "SellerSprite",
      sourceSurface: "reverse asin visible table",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/?q=B0GATEWAY1&marketId=1",
      acquisitionMode: "DOM_DIRECT",
      metricNature: "provider_observed",
      status: "AVAILABLE_WITH_LIMITATION",
      limitations: ["export:PLAN_LIMITATION"],
      identity: { asin: "B0OTHER001" },
      data: { rows: [] },
    })).toThrow("V3_MODULE_ASIN_SUBJECT_MISMATCH");
  });

  it("persists Browser Visible Evidence through Gateway and reads it back from the same store", async () => {
    await captureThroughGateway({
      context: OWNER_CONTEXT,
      source: "amazon_dom",
      payload: {
        asin: "B0GATEWAY1",
        title: "Gateway structural mapping fixture",
        productUrl: "https://www.amazon.com/dp/B0GATEWAY1",
        images: ["https://m.media-amazon.com/images/I/gateway.jpg"],
        brand: "Gateway Brand",
        price: 24.99,
        currency: "USD",
        rating: 4.7,
        reviewCount: 321,
        bsrRank: 88,
        bsrCategory: "Home & Kitchen",
      },
      now: new Date(CAPTURED_AT),
      subjectKey: SUBJECT_KEY,
      sourceUrl: "https://www.amazon.com/dp/B0GATEWAY1",
      marketplace: "US",
    });

    const result = await captureV3ModuleEvidence({
      context: OWNER_CONTEXT,
      sourceType: "sellersprite_plugin",
      moduleEvidence: {
        module: "reverse_asin",
        subjectKey: SUBJECT_KEY,
        capturedAt: CAPTURED_AT,
        provider: "SellerSprite",
        sourceSurface: "reverse asin visible table",
        sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/?q=B0GATEWAY1&marketId=1",
        acquisitionMode: "DOM_DIRECT",
        metricNature: "provider_observed",
        status: "AVAILABLE_WITH_LIMITATION",
        limitations: ["export:PLAN_LIMITATION"],
        identity: { asin: "B0GATEWAY1", keyword: "water bottle" },
        data: {
          rows: [{ keyword: "water bottle", reverseAsins: 12, observed: true }],
        },
      },
    });

    expect(result.gateway.created).toBe(true);
    expect(result.attachment.kind).toBe("v3_reverse_asin_v1");
    expect(result.rawArtifact.artifact.provenance.acquisitionMode).toBe("dom_direct");
    expect(result.rawArtifact.artifact.subjectKey).toBe(SUBJECT_KEY);
    expect(result.downstream).toMatchObject({ readable: true, evidenceOnly: true, subjectKey: SUBJECT_KEY });

    const readback = await readV3ModuleEvidence({ context: OWNER_CONTEXT, subjectKey: SUBJECT_KEY, module: "reverse_asin" });
    expect(readback.modules).toHaveLength(1);
    expect(readback.modules[0]).toMatchObject({
      module: "reverse_asin",
      metricNature: "provider_observed",
      status: "AVAILABLE_WITH_LIMITATION",
      limitations: ["export:PLAN_LIMITATION"],
      identity: { asin: "B0GATEWAY1", keyword: "water bottle" },
    });
    expect(readback.evidenceStore?.versions).toHaveLength(1);
    expect(readback.evidenceStore?.attachments).toHaveLength(1);
    expect(readback.evidenceStore?.rawArtifacts).toHaveLength(1);
  });

  it("keeps all eight module happy paths on the same EvidenceStore subject", async () => {
    await captureThroughGateway({
      context: OWNER_CONTEXT,
      source: "amazon_dom",
      payload: {
        asin: "B0GATEWAY1",
        title: "Eight module fixture",
        productUrl: "https://www.amazon.com/dp/B0GATEWAY1",
        images: [],
        brand: "Fixture",
        price: 20,
        currency: "USD",
        rating: 4.5,
        reviewCount: 100,
        bsrRank: 10,
        bsrCategory: "Home & Kitchen",
      },
      now: new Date(CAPTURED_AT),
      subjectKey: SUBJECT_KEY,
      sourceUrl: "https://www.amazon.com/dp/B0GATEWAY1",
      marketplace: "US",
    });
    const modules = [
      "amazon_detail",
      "amazon_search_market",
      "sellersprite_product_market",
      "reverse_asin",
      "keyword_mining_trend",
      "variation",
      "review_voc",
      "historical_trend",
    ] as const;
    for (const moduleId of modules) {
      await captureV3ModuleEvidence({
        context: OWNER_CONTEXT,
        sourceType: moduleId === "amazon_detail" || moduleId === "amazon_search_market" ? "amazon_dom" : "sellersprite_plugin",
        moduleEvidence: {
          module: moduleId,
          subjectKey: SUBJECT_KEY,
          capturedAt: CAPTURED_AT,
          provider: moduleId.startsWith("amazon_") ? "Amazon" : "SellerSprite",
          sourceSurface: `visible ${moduleId}`,
          sourceUrl: moduleId.startsWith("amazon_")
            ? "https://www.amazon.com/dp/B0GATEWAY1"
            : "https://www.sellersprite.com/v3/visible",
          acquisitionMode: moduleId === "historical_trend" ? "VISIBLE_CHART" : "DOM_DIRECT",
          metricNature: moduleId === "keyword_mining_trend" || moduleId === "historical_trend" ? "provider_estimate" : "provider_observed",
          status: "AVAILABLE_WITH_LIMITATION",
          limitations: ["export:PLAN_LIMITATION"],
          identity: {
            ...(moduleId === "variation" ? { asin: "B0GATEWAY1", parentAsin: "B0PARENT01" } : { asin: "B0GATEWAY1" }),
            ...(moduleId === "amazon_search_market" ? { query: "water bottle" } : {}),
            ...(moduleId === "keyword_mining_trend" ? { keyword: "water bottle" } : {}),
          },
          data: { module: moduleId, rows: [{ observed: true }] },
        },
      });
    }
    const readback = await readV3ModuleEvidence({ context: OWNER_CONTEXT, subjectKey: SUBJECT_KEY });
    expect(new Set(readback.modules.map((item) => item.module))).toEqual(new Set(modules));
    expect(readback.evidenceStore?.attachments).toHaveLength(8);
    expect(readback.evidenceStore?.rawArtifacts).toHaveLength(8);
  });
});
