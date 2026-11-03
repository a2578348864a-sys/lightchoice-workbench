import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSubject: vi.fn(),
}));

vi.mock("@/lib/sourceLayer/server/evidenceStore", () => ({
  createEvidenceStore: vi.fn(() => ({ getSubject: mocks.getSubject })),
}));

import { resolveMarketScanImageRef } from "@/lib/server/marketScanImage";

const ONE_PIXEL_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("resolveMarketScanImageRef", () => {
  beforeEach(() => {
    mocks.getSubject.mockReset();
  });

  it("returns a stored HTTPS URL without consulting Evidence", async () => {
    const ref = {
      schemaVersion: "market-scan-image-ref.v1" as const,
      kind: "external_url" as const,
      url: "https://cdn.example.com/product.jpg",
    };

    await expect(resolveMarketScanImageRef(ref)).resolves.toBe(ref.url);
    expect(mocks.getSubject).not.toHaveBeenCalled();
  });

  it("reads the exact Evidence version instead of falling back to latest", async () => {
    mocks.getSubject.mockResolvedValue({
      versions: [
        { version: 1, evidenceId: "ev-image-v1", pkg: { fields: { images: [ONE_PIXEL_DATA_URL] } } },
        { version: 2, evidenceId: "ev-image-v2", pkg: { fields: { images: ["https://cdn.example.com/v2.jpg"] } } },
      ],
    });
    const ref = {
      schemaVersion: "market-scan-image-ref.v1" as const,
      kind: "source_evidence" as const,
      subjectKey: "amazon:US:B0IMAGE001",
      evidenceId: "ev-image-v1",
      evidenceVersion: 1,
    };

    await expect(resolveMarketScanImageRef(ref)).resolves.toBe(ONE_PIXEL_DATA_URL);
    expect(mocks.getSubject).toHaveBeenCalledWith(ref.subjectKey);
  });

  it("fails closed when the referenced Evidence version is unavailable", async () => {
    mocks.getSubject.mockResolvedValue({ versions: [] });
    await expect(resolveMarketScanImageRef({
      schemaVersion: "market-scan-image-ref.v1",
      kind: "source_evidence",
      subjectKey: "amazon:US:B0IMAGE001",
      evidenceId: "ev-image-v1",
      evidenceVersion: 1,
    })).resolves.toBeNull();
  });
});
