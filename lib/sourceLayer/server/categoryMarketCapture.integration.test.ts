import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AccessContext } from "@/lib/server/accessPassword";
import { adaptSellerSpriteCategoryMarketTable } from "@/lib/sourceLayer/sellerSpriteCategoryMarketAdapter";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { captureCategoryMarketBatchThroughGateway } from "@/lib/sourceLayer/server/captureGateway";

const OWNER_CONTEXT: AccessContext = { mode: "owner", token: "" };
const NOW = new Date("2026-10-07T10:00:00.000Z");

describe("Category Market Capture through the Capture Gateway", () => {
  let tempRoot = "";

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "category-market-capture-"));
    process.env.SOURCE_LAYER_STORE_DIR = join(tempRoot, "evidence-store");
  });

  afterEach(() => {
    delete process.env.SOURCE_LAYER_STORE_DIR;
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it("writes and reads a provider-estimate market batch in the existing EvidenceStore", async () => {
    const batch = adaptSellerSpriteCategoryMarketTable({
      query: "kitchen",
      category: { id: "1055398:284507", label: "Home & Kitchen:Kitchen & Dining", products: 415126 },
      headers: ["细分市场", "样本数量", "月总销量", "月均销量(头部)"],
      rows: [["Thermoses", "商品 100 / 品牌 33 / 卖家 35", "978,477", "9,784"]],
      sourceUrl: "https://www.sellersprite.com/v2/market-research",
      capturedAt: NOW.toISOString(),
    });

    const result = await captureCategoryMarketBatchThroughGateway({ context: OWNER_CONTEXT, batch, now: NOW });
    const duplicate = await captureCategoryMarketBatchThroughGateway({ context: OWNER_CONTEXT, batch, now: NOW });
    const stored = await createEvidenceStore("owner:v1").getSubject("market:US:category:1055398:284507");
    const latest = await createEvidenceStore("owner:v1").getLatestCategoryMarketCapture?.();
    const audit = await createEvidenceStore("owner:v1").getAudit("market:US:category:1055398:284507");

    expect(result.batch).toEqual(batch);
    expect(result.created).toBe(true);
    expect(duplicate.duplicate).toBe(true);
    expect(stored?.versions).toEqual([]);
    expect(stored?.marketCaptures).toHaveLength(1);
    expect(stored?.marketCaptures?.[0]).toEqual(batch);
    expect(latest).toEqual({ subjectKey: "market:US:category:1055398:284507", batch });
    expect(stored?.marketCaptures?.[0]?.amazonConfirmed).toBe(false);
    expect(stored?.marketCaptures?.[0]?.rows[0]?.monthlyTotalSales).toEqual({
      value: 978477,
      nature: "provider_estimate",
    });
    expect(audit.some((entry) => entry.eventType === "category_market_capture_persisted"
      && entry.contentHash === result.contentHash)).toBe(true);
  });
});
