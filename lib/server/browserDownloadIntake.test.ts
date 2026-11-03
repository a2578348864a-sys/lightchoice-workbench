import { describe, expect, it } from "vitest";

import { readBrowserDownload } from "@/lib/server/browserDownloadIntake";

describe("browser download intake", () => {
  it("reads a Playwright-like download stream with the suggested filename", async () => {
    const result = await readBrowserDownload({
      suggestedFilename: () => "market.csv",
      path: async () => null,
      createReadStream: async () => (async function* () {
        yield new TextEncoder().encode("ASIN,title\nB0RAWTEST1,Sample\n");
      })(),
    });
    expect(result.fileName).toBe("market.csv");
    expect(new TextDecoder().decode(result.bytes)).toContain("B0RAWTEST1");
  });

  it("fails closed when Playwright cannot expose a downloaded file", async () => {
    await expect(readBrowserDownload({
      suggestedFilename: () => "market.csv",
      path: async () => null,
    })).rejects.toThrow("DOWNLOAD_FAILED");
  });
});
