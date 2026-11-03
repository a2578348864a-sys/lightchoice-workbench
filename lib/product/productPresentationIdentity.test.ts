import { describe, expect, it } from "vitest";

import { resolveProductPresentationIdentity } from "@/lib/product/productPresentationIdentity";

/**
 * 中文展示主标题（PRESENTATION-ONLY）。
 * 目标：在**不调用在线翻译、不写入 ProductFact**的前提下，
 * 用已有权威字段（标题 / 品牌 / 类目）生成中文主标题，并保留英文原标题为副标题。
 */
describe("resolveProductPresentationIdentity", () => {
  it("keeps an authoritative title that already contains Chinese as the primary title", () => {
    const identity = resolveProductPresentationIdentity({
      title: "皇家竹业 有机竹制砧板",
      brand: "Royal Bamboo",
      category: "Kitchen",
    });
    expect(identity.status).toBe("AUTHORITATIVE_CHINESE_TITLE");
    expect(identity.chineseTitle).toBe("皇家竹业 有机竹制砧板");
    expect(identity.presentationOnly).toBe(true);
  });

  it("derives brand + Chinese product type + model from an English title and authoritative category", () => {
    const identity = resolveProductPresentationIdentity({
      title: "Organic Bamboo Cutting Board Model 1",
      brand: "Royal Bamboo",
      category: "Kitchen",
    });
    expect(identity.status).toBe("DERIVED_FROM_CATEGORY");
    // "Bamboo" 已在品牌名 "Royal Bamboo" 中，不再重复翻译为「竹制」，避免噪音。
    expect(identity.chineseTitle).toBe("Royal Bamboo 有机砧板 Model 1");
    // 英文原标题必须保留为副标题来源。
    expect(identity.englishTitle).toBe("Organic Bamboo Cutting Board Model 1");
  });

  it("never fabricates Chinese when no authoritative category is available", () => {
    const identity = resolveProductPresentationIdentity({
      title: "Organic Bamboo Cutting Board Model 1",
      brand: "Royal Bamboo",
      category: "Some Unknown Category",
    });
    expect(identity.status).toBe("UNAVAILABLE");
    expect(identity.chineseTitle).toBeNull();
    expect(identity.englishTitle).toBe("Organic Bamboo Cutting Board Model 1");
  });

  it("falls back to the Chinese category label when the title has no recognized product-type term", () => {
    const identity = resolveProductPresentationIdentity({
      title: "Royal Bamboo Premium Set",
      brand: "Royal Bamboo",
      category: "Kitchen",
    });
    expect(identity.status).toBe("DERIVED_FROM_CATEGORY");
    expect(identity.chineseTitle).toBe("Royal Bamboo 厨房与餐厨");
  });

  it("maps an already-Chinese category through unchanged", () => {
    const identity = resolveProductPresentationIdentity({
      title: "String Lights 20m",
      brand: "BrightCo",
      category: "家居装饰",
    });
    expect(identity.chineseCategory).toBe("家居装饰");
    // 关键规格（20m）保留英文原样追加，避免误译。
    expect(identity.chineseTitle).toBe("BrightCo 灯串 20m");
  });

  it("returns UNAVAILABLE instead of inventing a title when everything is missing", () => {
    const identity = resolveProductPresentationIdentity({});
    expect(identity.status).toBe("UNAVAILABLE");
    expect(identity.chineseTitle).toBeNull();
    expect(identity.englishTitle).toBeNull();
  });

  it("never claims to be authoritative (presentation-only marker is always true)", () => {
    for (const input of [
      { title: "Royal Bamboo 竹砧板", category: "Kitchen" },
      { title: "Organic Bamboo Cutting Board", brand: "Royal Bamboo", category: "Kitchen" },
      { title: undefined, category: undefined },
    ]) {
      expect(resolveProductPresentationIdentity(input).presentationOnly).toBe(true);
    }
  });
});
