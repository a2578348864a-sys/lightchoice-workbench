import { describe, expect, it } from "vitest";
import { defaultBrowseState, readBrowseState, validSamplePreview, resolveExcludedItem } from "./workspaceBrowseState";

describe("tab-local workspace restoration allowlist", () => {
  const saved = { ...defaultBrowseState("batch-a"), view: "matrix", itemId: "item-12", module: "review_voc", page: 2,
    search: "spider", sort: "rating_desc", matrix: { group: "basic", module: "review_voc", issue: "human" },
    scroll: { page: 750, matrixTop: 800, matrixLeft: 120, review: 320 } };
  it("restores stable identities, never an index as the reviewing item", () => { expect(readBrowseState(saved, "batch-a")).toMatchObject({ itemId: "item-12", page: 2, scroll: saved.scroll }); });
  it("rejects cross-batch UI snapshots", () => { expect(readBrowseState(saved, "batch-b")).toBeNull(); });
  it("rejects unsafe batch identifiers", () => { expect(readBrowseState({ batchId: "../a" }, "../a")).toBeNull(); });
  it("does not restore selections, confirmations, permissions, evidence or run status", () => {
    const state = readBrowseState({ ...saved, selectedIds: ["item-12"], deleteOpen: true, run: { status: "RUNNING" }, evidence: "body", token: "secret" }, "batch-a");
    expect(Object.keys(state!)).toEqual(["batchId", "view", "search", "status", "sort", "page", "itemId", "module", "matrix", "location", "scroll"]);
  });
  it("normalizes invalid filters and action-like view values", () => { expect(readBrowseState({ batchId: "batch-a", view: "delete", status: "confirmed", sort: "random", module: "collect" }, "batch-a")).toMatchObject({ view: "gallery", status: "all", sort: "original", module: null }); });
  it("bounds storage positions and query size", () => { expect(readBrowseState({ batchId: "batch-a", search: "x".repeat(500), page: -2, scroll: { page: Infinity, matrixTop: -2, matrixLeft: 1e9 } }, "batch-a")).toMatchObject({ search: "x".repeat(300), page: 0, scroll: { page: 0, matrixTop: 0, matrixLeft: 1e6 } }); });
  it("drops invalid cell locations", () => { expect(readBrowseState({ ...saved, location: { itemId: "item-12", module: "confirm" } }, "batch-a")?.location).toBeNull(); });
});

describe("precise exclusion navigation", () => {
  const item = { id: "source-item-a", asin: "B07HMRZSWT", marketplace: null, archivedAt: null };
  it("maps a subject identity to the unique batch source item", () => { expect(resolveExcludedItem([item], { id: "amazon:US:B07HMRZSWT", asin: item.asin }, "US")).toBe(item); });
  it("does not guess when ASIN association is ambiguous", () => { expect(resolveExcludedItem([item, { ...item, id: "other" }], { id: "amazon:US:B07HMRZSWT", asin: item.asin }, "US")).toBeNull(); });
  it("refuses a cross-market subject", () => { expect(resolveExcludedItem([item], { id: "amazon:CA:B07HMRZSWT", asin: item.asin }, "US")).toBeNull(); });
  it("does not locate archived source items", () => { expect(resolveExcludedItem([{ ...item, archivedAt: "2026-10-26" }], { id: item.id, asin: item.asin }, "US")).toBeNull(); });
});

describe("market handoff requires current batch server preview", () => {
  const preview = { productBatchId: "batch-a", sourceItemCount: 30, preliminaryValidCount: 30, finalFreezableCount: 30, minimumRequired: 30, sufficient: true, stages: [{ items: [], droppedCount: 0 }] };
  it("accepts an existing server projection without recomputing eligibility", () => { expect(validSamplePreview(preview, "batch-a")).toBe(true); expect(validSamplePreview({ ...preview, sufficient: false }, "batch-a")).toBe(true); });
  it("rejects a missing precheck instead of falling back to UI counts", () => { expect(validSamplePreview(null, "batch-a")).toBe(false); });
  it("rejects another batch response", () => { expect(validSamplePreview(preview, "batch-b")).toBe(false); });
  it("rejects malformed counts or exclusions", () => { expect(validSamplePreview({ ...preview, finalFreezableCount: "30" }, "batch-a")).toBe(false); expect(validSamplePreview({ ...preview, stages: [{}] }, "batch-a")).toBe(false); });
});
