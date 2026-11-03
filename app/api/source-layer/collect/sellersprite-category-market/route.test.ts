import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuthenticated: vi.fn(),
  captureSellerSpriteCategoryMarketTable: vi.fn(),
  captureCategoryMarketBatchThroughGateway: vi.fn(),
}));

vi.mock("@/lib/server/demoGuard", () => ({ requireAuthenticated: mocks.requireAuthenticated }));
vi.mock("@/lib/server/sellerSpriteCategoryMarketCapture", () => ({
  captureSellerSpriteCategoryMarketTable: mocks.captureSellerSpriteCategoryMarketTable,
  SellerSpriteCategoryCaptureError: class SellerSpriteCategoryCaptureError extends Error {
    code: string;
    constructor(code: string, message: string) { super(message); this.code = code; }
  },
}));
vi.mock("@/lib/sourceLayer/server/captureGateway", () => ({
  captureCategoryMarketBatchThroughGateway: mocks.captureCategoryMarketBatchThroughGateway,
}));

import { POST } from "./route";

const batch = {
  schemaVersion: "category-market-capture-batch.v1",
  batchId: "category-0123456789abcdef01234567",
  sourceType: "category",
  provider: "SellerSprite",
  marketplace: "US",
  query: "kitchen",
  category: { nodeId: "1055398:284507", label: "Home & Kitchen:Kitchen & Dining", productCount: { value: 1333736, nature: "provider_estimate" } },
  capturedAt: "2026-10-07T10:00:00.000Z",
  sourceUrl: "https://www.sellersprite.com/v2/market-research",
  rowCount: 1,
  amazonConfirmed: false,
  rows: [],
};

function makeRequest(body: unknown) {
  return new NextRequest("http://127.0.0.1:3010/api/source-layer/collect/sellersprite-category-market", {
    method: "POST",
    headers: { origin: "http://localhost:3010", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/source-layer/collect/sellersprite-category-market", () => {
  it.each(["seller_sprite_session_unavailable", "seller_sprite_login_required"] as const)("blocks %s without Gateway writes", async code => {
    const { SellerSpriteCategoryCaptureError } = await import("@/lib/server/sellerSpriteCategoryMarketCapture");
    mocks.captureSellerSpriteCategoryMarketTable.mockRejectedValue(new SellerSpriteCategoryCaptureError(code, "fixture-source-gate"));
    const response = await POST(makeRequest({ query: "kitchen", categoryId: "1055398:284507", amazonNodeId: "284507", amazonPathEn: ["Home & Kitchen", "Kitchen & Dining"] }));
    const body = await response.json();
    expect(response.status).toBeGreaterThanOrEqual(400); expect(body.error.code).toBe(code);
    expect(mocks.captureCategoryMarketBatchThroughGateway).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticated.mockReturnValue({ ok: true, context: { mode: "owner", userId: "owner-1" } });
    mocks.captureSellerSpriteCategoryMarketTable.mockResolvedValue(batch);
    mocks.captureCategoryMarketBatchThroughGateway.mockResolvedValue({
      schemaVersion: "capture-gateway-result.v1",
      traceId: "trace-category-1",
      subjectKey: "market:US:category:1055398:284507",
      contentHash: "a".repeat(64),
      batch,
      created: true,
      duplicate: false,
    });
  });

  it("A. query + categoryId without Amazon context is fail-closed", async () => {
    const response = await POST(makeRequest({ query: "kitchen", categoryId: "1055398:284507" }));
    const body = await response.json() as { error: { code: string } };
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("category_match_unconfirmed");
    expect(mocks.captureSellerSpriteCategoryMarketTable).not.toHaveBeenCalled();
    expect(mocks.captureCategoryMarketBatchThroughGateway).not.toHaveBeenCalled();
  });

  it("B. only amazonNodeId is rejected", async () => {
    const response = await POST(makeRequest({
      query: "kitchen",
      categoryId: "1055398:284507",
      amazonNodeId: "284507",
    }));
    const body = await response.json() as { error: { code: string } };
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("category_match_unconfirmed");
    expect(mocks.captureSellerSpriteCategoryMarketTable).not.toHaveBeenCalled();
    expect(mocks.captureCategoryMarketBatchThroughGateway).not.toHaveBeenCalled();
  });

  it("C. only amazonPathEn is rejected", async () => {
    const response = await POST(makeRequest({
      query: "kitchen",
      categoryId: "1055398:284507",
      amazonPathEn: ["Home & Kitchen", "Kitchen & Dining"],
    }));
    const body = await response.json() as { error: { code: string } };
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("category_match_unconfirmed");
    expect(mocks.captureSellerSpriteCategoryMarketTable).not.toHaveBeenCalled();
    expect(mocks.captureCategoryMarketBatchThroughGateway).not.toHaveBeenCalled();
  });

  it("rejects empty amazonPathEn array as incomplete context", async () => {
    const response = await POST(makeRequest({
      query: "kitchen",
      categoryId: "1055398:284507",
      amazonNodeId: "284507",
      amazonPathEn: [],
    }));
    const body = await response.json() as { error: { code: string } };
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("category_match_unconfirmed");
    expect(mocks.captureSellerSpriteCategoryMarketTable).not.toHaveBeenCalled();
    expect(mocks.captureCategoryMarketBatchThroughGateway).not.toHaveBeenCalled();
  });

  it("D. full Amazon context + EXACT_NODE_MATCH allows capture and Gateway write", async () => {
    const response = await POST(makeRequest({
      query: "kitchen",
      categoryId: "1055398:284507",
      amazonNodeId: "284507",
      amazonPathEn: ["Home & Kitchen", "Kitchen & Dining"],
    }));
    expect(response.status).toBe(201);
    const body = await response.json() as { ok: boolean; data: { batch: typeof batch; subjectKey: string; match: { matchType: string; trusted: boolean } } };
    expect(body.ok).toBe(true);
    expect(body.data.batch).toEqual(batch);
    expect(body.data.subjectKey).toBe("market:US:category:1055398:284507");
    expect(body.data.match.matchType).toBe("EXACT_NODE_MATCH");
    expect(body.data.match.trusted).toBe(true);
    expect(mocks.captureSellerSpriteCategoryMarketTable).toHaveBeenCalledWith({
      query: "kitchen",
      categoryId: "1055398:284507",
      amazonNodeId: "284507",
      amazonPathEn: ["Home & Kitchen", "Kitchen & Dining"],
    });
    expect(mocks.captureCategoryMarketBatchThroughGateway).toHaveBeenCalledTimes(1);
  });

  it("E. service-level UNCONFIRMED/conflicting is 409 and no Gateway write", async () => {
    mocks.captureSellerSpriteCategoryMarketTable.mockRejectedValue(
      Object.assign(new Error("该 SellerSprite 节点与当前 Amazon 类目不匹配。"), {
        name: "SellerSpriteCategoryCaptureError",
        code: "category_match_unconfirmed",
      }),
    );
    // Keep instanceof working by throwing the mocked class shape via route's imported error
    const { SellerSpriteCategoryCaptureError } = await import("@/lib/server/sellerSpriteCategoryMarketCapture");
    mocks.captureSellerSpriteCategoryMarketTable.mockRejectedValue(
      new SellerSpriteCategoryCaptureError("category_match_unconfirmed", "该 SellerSprite 节点与当前 Amazon 类目不匹配。"),
    );

    const response = await POST(makeRequest({
      query: "Cell Phones",
      categoryId: "2335752011",
      amazonNodeId: "15857501",
      amazonPathEn: ["Automotive", "Accessories"],
    }));
    const body = await response.json() as { error: { code: string; message: string } };
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("category_match_unconfirmed");
    expect(mocks.captureSellerSpriteCategoryMarketTable).toHaveBeenCalledTimes(1);
    expect(mocks.captureCategoryMarketBatchThroughGateway).not.toHaveBeenCalled();
  });

  it("rejects invalid node identities without invoking external capture", async () => {
    const response = await POST(makeRequest({ query: "kitchen", categoryId: "javascript:alert(1)" }));
    const body = await response.json() as { error: { code: string } };
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("category_capture_input_invalid");
    expect(mocks.captureSellerSpriteCategoryMarketTable).not.toHaveBeenCalled();
    expect(mocks.captureCategoryMarketBatchThroughGateway).not.toHaveBeenCalled();
  });
});
