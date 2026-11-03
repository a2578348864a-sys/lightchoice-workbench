import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/db", () => ({
  prisma: {
    productBatch: { count: vi.fn(async () => 2) },
    marketScan: { findMany: vi.fn(async () => []) },
    productBatchItem: { count: vi.fn(async () => 7) },
  },
}));

vi.mock("@/lib/server/v5ResearchService", () => ({
  listResearch: vi.fn(async () => ({
    items: [],
    counts: {
      all: 17,
      needs_decision: 6,
      ready: 3,
      proceed: 5,
      pause: 4,
      validate_more: 3,
      drop: 2,
      archived: 1,
    },
    nextCursor: null,
  })),
}));

vi.mock("@/lib/server/v5FeishuService", () => ({
  getFeishuConnectionStatus: vi.fn(() => ({ configured: false })),
}));

import { GET } from "./route";

function request() {
  return new NextRequest("http://localhost:3011/api/home/summary", {
    headers: { host: "localhost:3011" },
  });
}

describe("GET /api/home/summary decision breakdown", () => {
  it("exposes read-only paused/validateMore while keeping legacy choiceWatch", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.decision).toEqual({ paused: 4, validateMore: 3 });
    // 旧合并字段与 pipeline 口径保持不变，兼容既有消费方。
    expect(body.data.counts.choiceWatch).toBe(7);
    expect(body.data.pipeline.choices.watch).toBe(7);
    expect(body.data.counts.researchNeedsChoice).toBe(6);
  });
});
