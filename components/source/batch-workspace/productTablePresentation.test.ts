import { describe, expect, it } from "vitest";
import type { GalleryItem } from "./presentation";
import { filterBatchProducts, sortBatchProducts } from "./productTablePresentation";

const make = (id: string, value: number | null, status: "confirmed" | "conflict" = "confirmed", currency = "USD"): GalleryItem => ({ id, asin: id, usageStatus: "needs_review", price: { value, status, currency } });
describe("shared batch product order", () => {
  it("keeps unknown and conflicting prices last in both directions without mutating input", () => {
    const items = [make("missing", null), make("high", 20), make("zero", 0), make("conflict", 1, "conflict")];
    expect(sortBatchProducts(items, "price_asc").map(i => i.id)).toEqual(["zero", "high", "missing", "conflict"]);
    expect(sortBatchProducts(items, "price_desc").map(i => i.id)).toEqual(["high", "zero", "missing", "conflict"]);
    expect(items[0].id).toBe("missing");
  });
  it("retains tie order and restores original order", () => {
    const items = [make("a", 10), make("b", 10)];
    expect(sortBatchProducts(items, "price_desc")).toEqual(items);
    expect(sortBatchProducts(items, "original")).toEqual(items);
  });
  it("groups currencies without exchange rate assumptions", () => {
    expect(sortBatchProducts([make("usd", 1), make("eur", 30, "confirmed", "EUR")], "price_asc").map(i => i.id)).toEqual(["eur", "usd"]);
  });
  it("sorts reliable ratings and counts, keeping missing/conflict/non-finite values last", () => {
    const items = [make("a", 1), make("b", 1), make("c", 1)];
    items[0].rating = { value: 4.9, status: "conflict" };
    items[1].rating = { value: 4.2, status: "confirmed" };
    items[2].rating = { value: NaN, status: "confirmed" };
    items[1].reviewCount = { value: 0, status: "confirmed" };
    expect(sortBatchProducts(items, "rating_desc").map(i => i.id)).toEqual(["b", "a", "c"]);
    expect(sortBatchProducts(items, "reviews_desc").map(i => i.id)).toEqual(["b", "a", "c"]);
  });
});

describe("shared search and status", () => {
  it("searches original title, ASIN, brand and category without mutating source records", () => {
    const item = { ...make("B00001", 3), title: "Original lantern", brand: "Acme", chineseCategory: "户外灯" };
    for (const query of ["b00001", " LANTERN ", "acme", "户外"]) expect(filterBatchProducts([item], query, "all")).toEqual([item]);
    expect(filterBatchProducts([item], "", "ready")).toEqual([]);
    expect(filterBatchProducts([item], "not found", "all")).toEqual([]);
    expect(filterBatchProducts([item], "", "review")).toEqual([item]);
  });
});
