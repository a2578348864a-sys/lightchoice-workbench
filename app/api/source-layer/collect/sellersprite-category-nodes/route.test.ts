import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuthenticated: vi.fn(),
  getSellerSpriteCategoryNodes: vi.fn(),
}));

vi.mock("@/lib/server/demoGuard", () => ({ requireAuthenticated: mocks.requireAuthenticated }));
vi.mock("@/lib/server/sellerSpriteCategoryMarketCapture", () => ({
  getSellerSpriteCategoryNodes: mocks.getSellerSpriteCategoryNodes,
  SellerSpriteCategoryCaptureError: class SellerSpriteCategoryCaptureError extends Error {
    code: string;
    constructor(code: string, message: string) { super(message); this.code = code; }
  },
}));

import { POST } from "./route";

describe("POST /api/source-layer/collect/sellersprite-category-nodes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticated.mockReturnValue({ ok: true, context: { mode: "owner", userId: "owner-1" } });
  });

  it("returns category node suggestions after auth and same-origin validation", async () => {
    mocks.getSellerSpriteCategoryNodes.mockResolvedValue([
      { id: "1055398", label: "Home & Kitchen", products: 1333736 },
    ]);
    const request = new NextRequest("http://127.0.0.1:3010/api/source-layer/collect/sellersprite-category-nodes", {
      method: "POST",
      headers: { origin: "http://localhost:3010", "content-type": "application/json" },
      body: JSON.stringify({ query: "kitchen" }),
    });

    const response = await POST(request);
    const body = await response.json() as { ok: boolean; data: { nodes: Array<{ id: string }> } };
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.nodes[0]?.id).toBe("1055398");
    expect(mocks.getSellerSpriteCategoryNodes).toHaveBeenCalledWith("kitchen");
  });

  it("rejects missing category input before contacting SellerSprite", async () => {
    const request = new NextRequest("http://127.0.0.1:3010/api/source-layer/collect/sellersprite-category-nodes", {
      method: "POST",
      headers: { origin: "http://localhost:3010", "content-type": "application/json" },
      body: JSON.stringify({ query: " " }),
    });

    const response = await POST(request);
    const body = await response.json() as { error: { code: string } };
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("category_query_invalid");
    expect(mocks.getSellerSpriteCategoryNodes).not.toHaveBeenCalled();
  });

  it("rejects untrusted request origins", async () => {
    const request = new NextRequest("http://127.0.0.1:3010/api/source-layer/collect/sellersprite-category-nodes", {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ query: "kitchen" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(403);
    expect(mocks.getSellerSpriteCategoryNodes).not.toHaveBeenCalled();
  });
});
