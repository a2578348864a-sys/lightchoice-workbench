import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuthenticated: vi.fn(),
  getSourceEvidenceDetail: vi.fn(),
}));

vi.mock("@/lib/server/demoGuard", () => ({ requireAuthenticated: mocks.requireAuthenticated }));
vi.mock("@/lib/sourceLayer/server/sourceLayerService", () => ({ getSourceEvidenceDetail: mocks.getSourceEvidenceDetail }));

import { GET } from "./route";

describe("GET /api/source-layer/evidence/[subjectKey] category evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticated.mockReturnValue({ ok: true, context: { mode: "owner", userId: "owner-1" } });
  });

  it("returns a category market capture from the same Source Layer Evidence read path", async () => {
    const marketCaptures = [{
      schemaVersion: "category-market-capture-batch.v1",
      batchId: "category-0123456789abcdef01234567",
      sourceType: "category",
      provider: "SellerSprite",
      marketplace: "US",
      amazonConfirmed: false,
      rows: [],
    }];
    mocks.getSourceEvidenceDetail.mockResolvedValue({
      subject: {
        subjectKey: "market:US:category:1055398",
        marketplace: "US",
        versions: [],
        marketCaptures,
      },
      audit: [],
    });
    const request = new NextRequest("http://localhost:3010/api/source-layer/evidence/market%3AUS%3Acategory%3A1055398");

    const response = await GET(request, { params: Promise.resolve({ subjectKey: "market:US:category:1055398" }) });
    const body = await response.json() as { ok: boolean; data: { marketCaptures: typeof marketCaptures; versions: unknown[] } };
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.marketCaptures).toEqual(marketCaptures);
    expect(body.data.versions).toEqual([]);
  });
});
