import { describe, expect, it } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { ProductIdentity, resolveProductIdentityTitle } from "./ProductIdentity";

describe("ProductIdentity (PRODUCT_IDENTITY_UI_CONTRACT)", () => {
  it("renders image, title, and secondary metadata correctly", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ProductIdentity, {
        image: "https://example.com/tumbler.jpg",
        title: "KINTO Travel Tumbler 500ml",
        asin: "B07G4VTV2F",
        marketplace: "US",
        brand: "KINTO",
        category: "Drinkware",
      })
    );

    expect(html).toContain("KINTO Travel Tumbler 500ml");
    expect(html).toContain("KINTO");
    expect(html).toContain("Drinkware");
    expect(html).toContain("B07G4VTV2F · 美国站 (US)");
    expect(html).toContain("https://example.com/tumbler.jpg");
  });

  it("falls back to brand and category when title is missing", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ProductIdentity, {
        image: null,
        asin: "B07G4VTV2F",
        brand: "KINTO",
        category: "Drinkware",
      })
    );

    expect(html).toContain("KINTO · Drinkware");
  });

  it("falls back to Amazon 商品 · ASIN when only ASIN exists", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ProductIdentity, {
        image: null,
        asin: "B0113UZJE2",
      })
    );

    expect(html).toContain("Amazon 商品 · B0113UZJE2");
  });

  it("does not promote an ASIN duplicated as the product title", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ProductIdentity, {
        image: null,
        title: "B0SRC00001",
        asin: "B0SRC00001",
        brand: "Royal Craft",
      })
    );

    expect(html).toContain("Royal Craft 商品");
    expect(html.indexOf("Royal Craft 商品")).toBeLessThan(html.indexOf("B0SRC00001"));
  });

  it("shares the same display-safe name with business context when title is only an ASIN", () => {
    expect(resolveProductIdentityTitle({
      title: "B0SRC00001",
      asin: "B0SRC00001",
      brand: "Royal Craft",
    })).toBe("Royal Craft 商品");
  });

  it("renders honest placeholder when image is null", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ProductIdentity, {
        image: null,
        title: "Test Product",
        asin: "B000000001",
      })
    );

    expect(html).toContain('role="img"');
    expect(html).toContain("暂无图片");
  });
});
