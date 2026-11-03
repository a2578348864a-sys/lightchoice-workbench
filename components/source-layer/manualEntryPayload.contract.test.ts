import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 手工录入的 UI → API 契约护栏。
 *
 * 为什么需要：`AddProductDialog` / `SourceLayerClient` 曾把 payload 写成
 * `price: { amount, currency }` 与 `bsr: { rank, category }`，而正式的
 * `manual_entry` 适配器读取的是扁平的 `price` / `currency` / `bsrRank` / `bsrCategory`，
 * 导致价格与 BSR 被静默丢弃（价格属 REVIEW_FIELDS，进而使录入必然 blocked）。
 *
 * 这些断言直接盯住源码形状，防止同类断链再次出现。
 */

const SOURCE_CLIENT = resolve(process.cwd(), "components/source-layer/SourceLayerClient.tsx");
const ADD_DIALOG = resolve(process.cwd(), "components/source-layer/AddProductDialog.tsx");
const ADAPTER = resolve(process.cwd(), "lib/sourceLayer/adapters/manualEntryAdapter.ts");

const read = (path: string) => readFileSync(path, "utf8");

describe("manual entry UI → adapter payload contract", () => {
  it("sends a flat price/currency pair, never a nested money object", () => {
    for (const path of [SOURCE_CLIENT, ADD_DIALOG]) {
      const source = read(path);
      expect(source).toMatch(/payload\.price = num;/u);
      expect(source).toMatch(/payload\.currency = "USD";/u);
      expect(source).not.toMatch(/payload\.price = \{/u);
    }
  });

  it("sends flat bsrRank/bsrCategory, never a nested bsr object", () => {
    for (const path of [SOURCE_CLIENT, ADD_DIALOG]) {
      const source = read(path);
      expect(source).toMatch(/payload\.bsrRank = Math\.round\(rank\);/u);
      expect(source).toMatch(/payload\.bsrCategory = bsrCategory;/u);
      expect(source).not.toMatch(/payload\.bsr = \{/u);
    }
  });

  it("keeps the UI payload keys aligned with what the adapter actually reads", () => {
    const adapter = read(ADAPTER);
    // 适配器读取的键必须是 UI 实际发送的键。
    for (const key of ["asin", "title", "productUrl", "price", "currency", "rating", "reviewCount", "bsrRank", "bsrCategory", "images", "keywords"]) {
      expect(adapter).toContain(`payload.${key}`);
    }
  });

  it("reports the real validation outcome instead of always claiming success", () => {
    for (const path of [SOURCE_CLIENT, ADD_DIALOG]) {
      const source = read(path);
      expect(source).toContain("readyCount");
      expect(source).toContain("blockedCount");
      expect(source).not.toMatch(/成功录入商品 \$\{cleanAsin\} 来源证据！/u);
    }
  });
});

describe("source asset inbox read-only presentation", () => {
  const inbox = read(resolve(process.cwd(), "lib/sourceLayer/server/sourceAssetInbox.ts"));

  it("never writes: no prisma mutation, no evidence append, no handoff, no AI/Lark", () => {
    expect(inbox).not.toMatch(/prisma\./u);
    expect(inbox).not.toMatch(/\.create\(|\.update\(|\.delete\(/u);
    expect(inbox).not.toMatch(/appendEvidence/u);
    expect(inbox).not.toMatch(/handoffCapturesToResearch/u);
    expect(inbox).not.toMatch(/callAi|aiClient|lark|Lark/u);
    expect(inbox).not.toMatch(/fetch\(/u);
  });

  it("derives field coverage from FactField.status through one shared helper", () => {
    expect(inbox).toContain("hasDisplayValue");
    expect(inbox).toMatch(/field\.status === "present"/u);
    // 不允许退回 Boolean(field.value) 这类逐字段判断。
    expect(inbox).not.toMatch(/Boolean\(fact\.basic\./u);
  });

  it("reads the authoritative readyForResearch flag instead of re-deriving it", () => {
    expect(inbox).toContain("readyForResearch: latest.validation.readyForResearch");
    expect(inbox).toContain("isReadyForResearch");
  });
});

describe("product image fallback", () => {
  const image = read(resolve(process.cwd(), "components/source-layer/ProductImage.tsx"));

  it("renders a placeholder when the source is empty and when loading fails", () => {
    expect(image).toContain("onError");
    expect(image).toContain("setFailed(true)");
    expect(image).toMatch(/if \(!hasSource \|\| failed\)/u);
  });

  it("never fabricates a product image", () => {
    expect(image).not.toMatch(/placeholder\.com|placehold\.it|dummyimage/u);
    expect(image).not.toMatch(/https?:\/\/(?!www\.w3\.org)/u);
  });

  it("is wired into the list, the drawer and the mobile drawer", () => {
    const client = read(SOURCE_CLIENT);
    const usages = client.match(/<ProductImage/gu) ?? [];
    expect(usages.length).toBeGreaterThanOrEqual(2);
    expect(client).not.toMatch(/<img\s/u);
  });
});
