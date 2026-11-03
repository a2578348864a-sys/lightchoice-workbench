import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureBrowserVisibleSellerSpriteEvidence,
  parseBrowserVisibleSellerSpriteEvidence,
} from "@/lib/sourceLayer/browserVisibleEvidenceCapture";
import type { AccessContext } from "@/lib/server/accessPassword";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";

const OWNER_CONTEXT: AccessContext = { mode: "owner", token: "" };
const CAPTURED_AT = "2026-09-26T12:00:00.000Z";

function sampleEvidence() {
  return {
    schemaVersion: "sellersprite-browser-visible-dom.v1",
    sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/?q=B07G4VTV2F&marketId=1",
    sourceSurface: "v3/keyword-reverse",
    marketplace: "US",
    capturedAt: CAPTURED_AT,
    asin: "B07G4VTV2F",
    pageTitle: "Keyword reverse",
    product: {
      title: "KINTO 21093 Day-off Tumbler",
      amazonUrl: "https://www.amazon.com/dp/B07G4VTV2F?psc=1",
      seller: "Daily General Store!",
      category: "Home & Kitchen",
      bsr: 29962,
      priceUsd: 44.9,
      rating: 4.6,
      reviewCount: 1046,
      listingDate: "2019-09-22",
    },
    visibleKeywordRows: [
      { rank: 1, keyword: "kinto water bottle", translation: "kinto water bottle", rawText: "1 kinto water bottle" },
      { rank: 2, keyword: "kinto travel tumbler", translation: null, rawText: "2 kinto travel tumbler" },
    ],
    highFrequencyTerms: ["kinto", "tumbler"],
    visibleResultTable: {
      headers: ["流量占比", "自然排名"],
      rows: [["49.08%", "27"]],
    },
    extraction: {
      method: "dom",
      capturedFromVisibleDom: true,
      productRootSelector: ".traffica-anlysis",
      productSummarySelector: ".asin-info",
      keywordRowSelector: "tr.el-table__row .title .el-tooltip",
      highFrequencySelector: ".frequency-content .name",
    },
  };
}

describe("Browser Visible Evidence Capture", () => {
  let storeRoot: string | null = null;

  afterEach(() => {
    delete process.env.SOURCE_LAYER_STORE_DIR;
    if (storeRoot) rmSync(storeRoot, { recursive: true, force: true });
    storeRoot = null;
  });

  it("persists the visible DOM snapshot and the gateway Evidence in one subject", async () => {
    storeRoot = mkdtempSync(join(tmpdir(), "lightchoice-browser-visible-"));
    process.env.SOURCE_LAYER_STORE_DIR = storeRoot;

    const result = await captureBrowserVisibleSellerSpriteEvidence({
      context: OWNER_CONTEXT,
      evidence: sampleEvidence(),
    });

    expect(result.strategy).toBe("browser_visible_evidence_capture");
    expect(result.gateway.source).toBe("sellersprite_plugin");
    expect(result.gateway.capture.items).toHaveLength(1);
    expect(result.moduleEvidence).toMatchObject({
      module: "reverse_asin",
      acquisitionMode: "DOM_DIRECT",
      metricNature: "provider_observed",
      status: "AVAILABLE_WITH_LIMITATION",
      limitations: ["export:PLAN_LIMITATION"],
    });
    expect(result.moduleAttachment.attachment.kind).toBe("v3_reverse_asin_v1");
    expect(result.rawArtifact.artifact.provenance.acquisitionMode).toBe("browser_dom");
    expect(result.rawArtifact.artifact.sourceType).toBe("sellersprite_plugin");
    expect(result.evidenceStore.versions).toHaveLength(1);
    expect(result.evidenceStore.attachments).toHaveLength(1);
    expect(result.evidenceStore.rawArtifacts).toHaveLength(1);
    expect(result.evidenceStore.rawArtifacts?.[0]?.sha256).toBe(result.rawArtifact.artifact.sha256);
    expect(result.evidenceStore.versions[0]?.sourceType).toBe("sellersprite_plugin");
    expect(result.evidenceStore.versions[0]?.pkg.sourceProof.captureMethod).toBe("browser_dom");
    expect(result.evidenceStore.versions[0]?.pkg.sourceProof.sourceMethod).toBe("sellersprite_page_visible_dom");

    const reloaded = await createEvidenceStore("owner:v1").getSubject(result.subjectKey);
    expect(reloaded?.versions[0]?.pkg.fields.title).toBe("KINTO 21093 Day-off Tumbler");
    expect(reloaded?.rawArtifacts?.[0]?.provenance.sourceSurface).toBe("v3/keyword-reverse");
  });

  it("rejects non-SellerSprite pages and unbound ASINs before any capture", () => {
    expect(() => parseBrowserVisibleSellerSpriteEvidence({
      ...sampleEvidence(),
      sourceUrl: "https://example.com/v3/keyword-reverse/?q=B07G4VTV2F",
    })).toThrow("source_url_invalid");

    expect(() => parseBrowserVisibleSellerSpriteEvidence({
      ...sampleEvidence(),
      sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/?q=B0000000000",
    })).toThrow("asin_binding_invalid");
  });
});
