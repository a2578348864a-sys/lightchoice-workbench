import { describe, expect, it } from "vitest";
import type { MarketIntelligence } from "@/lib/marketScan/intelligence";
import { trustedSampleImageUrl } from "./MarketResearchReport";

const data = (url: string) => ({ productDetails: [{ subjectKey: "amazon:US:B0IMAGE001", facts: { imageUrl: url } }] }) as unknown as MarketIntelligence;
describe("saved research image presentation", () => {
  it("resolves only the requested subject, never a neighboring product image", () => {
    const value = data("https://m.media-amazon.com/images/I/saved.jpg");
    expect(trustedSampleImageUrl(value, "amazon:US:B0IMAGE001")).toContain("saved.jpg");
    expect(trustedSampleImageUrl(value, "amazon:US:B0OTHER001")).toBeNull();
  });
  it("accepts a raster snapshot already stored under that subject", () => {
    const url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    expect(trustedSampleImageUrl(data(url), "amazon:US:B0IMAGE001")).toBe(url);
  });
  it("rejects untrusted hosts, HTTP, scriptable data and lookalike domains", () => {
    for (const url of ["https://example.com/photo.jpg", "http://m.media-amazon.com/photo.jpg", "https://m.media-amazon.com.attacker.test/photo.jpg", "data:image/svg+xml;base64,PHN2Zy8+", "javascript:alert(1)"]) {
      expect(trustedSampleImageUrl(data(url), "amazon:US:B0IMAGE001")).toBeNull();
    }
  });
});
