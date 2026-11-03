import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuthenticated: vi.fn(),
  getLatestCategoryMarketCapture: vi.fn(),
}));

vi.mock("@/lib/server/demoGuard", () => ({ requireAuthenticated: mocks.requireAuthenticated }));
vi.mock("@/lib/sourceLayer/server/sourceLayerService", () => ({ getLatestCategoryMarketCapture: mocks.getLatestCategoryMarketCapture }));

import { GET } from "./route";

const latest = {
  subjectKey: "market:US:category:1055398",
  batch: {
    schemaVersion: "category-market-capture-batch.v1",
    batchId: "category-0123456789abcdef01234567",
    sourceType: "category",
    provider: "SellerSprite",
    marketplace: "US",
    query: "kitchen",
    category: { nodeId: "1055398", label: "Home & Kitchen", productCount: { value: 1333736, nature: "provider_estimate" } },
    capturedAt: "2026-10-07T10:00:00.000Z",
    sourceUrl: "https://www.sellersprite.com/v2/market-research",
    rowCount: 1,
    amazonConfirmed: false,
    rows: [{ segment: { value: "Storage", authority: "provider_derived" } }],
  },
};

describe("GET /api/source-layer/category-market/latest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticated.mockReturnValue({ ok: true, context: { mode: "owner", userId: "owner-1" } });
    mocks.getLatestCategoryMarketCapture.mockResolvedValue(latest);
  });

  it("returns the latest existing EvidenceStore capture with its provider boundary", async () => {
    const response = await GET(new NextRequest("http://localhost:3010/api/source-layer/category-market/latest"));
    const body = await response.json() as { ok: boolean; data: typeof latest };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual(latest);
    expect(body.data.batch.amazonConfirmed).toBe(false);
    expect(body.data.batch.rows[0]?.segment.authority).toBe("provider_derived");
  });

  it("returns an empty result when no category capture exists", async () => {
    mocks.getLatestCategoryMarketCapture.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost:3010/api/source-layer/category-market/latest"));
    const body = await response.json() as { ok: boolean; data: unknown };

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, data: null });
  });

  it("keeps the authenticated Source Layer boundary", async () => {
    mocks.requireAuthenticated.mockReturnValue({ ok: false, status: 401, code: "auth_required", message: "需要登录。" });
    const response = await GET(new NextRequest("http://localhost:3010/api/source-layer/category-market/latest"));

    expect(response.status).toBe(401);
    expect(mocks.getLatestCategoryMarketCapture).not.toHaveBeenCalled();
  });
});
