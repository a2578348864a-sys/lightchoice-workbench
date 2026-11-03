import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/server/db", () => ({ prisma: {} }));
import { captureThroughGateway } from "@/lib/sourceLayer/server/captureGateway";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { getLatestAmazonCaptureSummary } from "./latestAmazonCaptureSummary";
let root: string;
const context = { mode: "owner", token: "" } as const;
describe("latest Amazon evidence read-only projection", () => {
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "p0-amazon-summary-")); vi.stubEnv("SOURCE_LAYER_STORE_DIR", root); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network_forbidden"); })); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });
  it("reads a persisted Gateway version without collecting or rewriting evidence", async () => {
    const asin = "B000000001";
    await captureThroughGateway({ context, source: "amazon_dom", now: new Date("2026-10-12T00:00:00Z"),
      subjectKey: "amazon:US:" + asin, marketplace: "US", sourceUrl: "https://www.amazon.com/dp/" + asin,
      payload: { asin, title: "P0 fixture-only detail", productUrl: "https://www.amazon.com/dp/" + asin,
        brand: "Fixture", images: ["https://m.media-amazon.com/images/I/fixture.jpg"], price: 25, currency: "USD", rating: 4.5, reviewCount: 200 } });
    const snapshot = () => readdirSync(root, { recursive: true }).filter(name => typeof name === "string" && name.endsWith(".json"))
      .map(name => [name, readFileSync(join(root, name as string), "utf8")]);
    const before = snapshot();
    const summary = await getLatestAmazonCaptureSummary(context);
    expect(summary).toMatchObject({ asin, version: 1, sourceLabel: "Amazon 商品页面", brand: "Fixture", price: { amount: 25, currency: "USD" } });
    expect(snapshot()).toEqual(before); expect(fetch).not.toHaveBeenCalled();
  });
  it("does not substitute failed latest evidence or invent an empty result", async () => {
    const store = createEvidenceStore("owner:v1");
    expect(await getLatestAmazonCaptureSummary(context, store)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
