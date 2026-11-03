import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuthenticated: vi.fn(),
  ingest: vi.fn(),
  gateway: vi.fn(),
  handoff: vi.fn(),
  listEvidence: vi.fn(),
  getDetail: vi.fn(),
  bridge: vi.fn(),
  gatewayBatch: vi.fn(),
  getSourceAssetInbox: vi.fn(),
}));

vi.mock("@/lib/sourceLayer/server/sourceAssetInbox", () => ({
  getSourceAssetInbox: mocks.getSourceAssetInbox,
}));

vi.mock("@/lib/server/demoGuard", () => ({
  requireAuthenticated: mocks.requireAuthenticated,
}));

vi.mock("@/lib/sourceLayer/server/sourceLayerService", async () => {
  class SourceLayerServiceError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
      this.name = "SourceLayerServiceError";
    }
  }
  return {
    SOURCE_LAYER_INGEST_SCHEMA: "source-layer-ingest-result.v1",
    SourceLayerServiceError,
    ingestSourceCapture: mocks.ingest,
    handoffCapturesToResearch: mocks.handoff,
    listSourceEvidence: mocks.listEvidence,
    getSourceEvidenceDetail: mocks.getDetail,
    captureFromProductBatch: mocks.bridge,
    sourceLayerOperator: (context: { mode: string }) => (context.mode === "owner" ? "owner:v1" : "visitor:x"),
  };
});

vi.mock("@/lib/sourceLayer/server/captureGateway", () => ({
  captureThroughGateway: mocks.gateway,
  captureProductBatchThroughGateway: mocks.gatewayBatch,
}));

import { GET as getLedger } from "@/app/api/source-layer/route";
import { POST as postIngest } from "@/app/api/source-layer/ingest/route";
import { POST as postHandoff } from "@/app/api/source-layer/handoff/route";
import { POST as postFromProductBatch } from "@/app/api/source-layer/from-product-batch/route";
import { GET as getEvidence } from "@/app/api/source-layer/evidence/[subjectKey]/route";

const BASE = "http://localhost:3000";

function request(body: unknown, headers: Record<string, string> = {}) {
  return {
    url: `${BASE}/api/source-layer`,
    nextUrl: new URL(`${BASE}/api/source-layer`),
    headers: new Headers({
      origin: BASE,
      host: "localhost:3000",
      "content-type": "application/json",
      ...headers,
    }),
    json: async () => body,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuthenticated.mockReturnValue({
    ok: true,
    context: { mode: "owner", token: "owner-token" },
  });
  mocks.listEvidence.mockResolvedValue({ operator: "owner:v1", subjects: [] });
  mocks.ingest.mockResolvedValue({
    schemaVersion: "source-layer-ingest-result.v1",
    operator: "owner:v1",
    sourceType: "manual_entry",
    adapterLabel: "人工录入",
    capturedAt: "2026-02-01T00:00:00.000Z",
    pageDigest: "manual_entry",
    totalDrafts: 1,
    quarantinedCount: 0,
    readyCount: 1,
    reviewCount: 0,
    blockedCount: 0,
    captureErrorCodes: [],
    items: [],
    errors: [],
  });
  mocks.gateway.mockResolvedValue({
    source: "manual",
    capturedAt: "2026-02-01T00:00:00.000Z",
    capture: {
      schemaVersion: "source-layer-ingest-result.v1",
      operator: "owner:v1",
      sourceType: "manual_entry",
      adapterLabel: "人工录入",
      capturedAt: "2026-02-01T00:00:00.000Z",
      pageDigest: "manual_entry",
      totalDrafts: 1,
      quarantinedCount: 0,
      readyCount: 1,
      reviewCount: 0,
      blockedCount: 0,
      captureErrorCodes: [],
      items: [],
      errors: [],
    },
    productFacts: [],
    qualityGate: { enabled: false, status: "disabled", gateId: null, issues: [] },
  });
  mocks.handoff.mockResolvedValue({
    summary: { created: [{ rowHash: "a".repeat(64), candidateId: "candidate-1" }], skipped: [], conflicts: [] },
    evidenceOnlyNote: "采集证据仅作为来源证据（evidence only），商品事实仍需在任务内人工确认。",
    productBatchId: null,
  });
  mocks.getDetail.mockResolvedValue({
    subject: {
      schemaVersion: "source-evidence-subject.v1",
      subjectKey: "amazon:US:B0FH1ZXTN1",
      marketplace: "US",
      updatedAt: "2026-02-01T00:00:00.000Z",
      operator: "owner-v1",
      versions: [],
    },
    audit: [],
  });
});

describe("GET /api/source-layer", () => {
  it("requires authentication", async () => {
    mocks.requireAuthenticated.mockReturnValue({ ok: false, status: 401, code: "invalid_access", message: "请先登录。" });
    const response = await getLedger(request(null) as never);
    expect(response.status).toBe(401);
  });

  it("returns the ledger with registered adapters", async () => {
    const response = await getLedger(request(null) as never);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.operator).toBe("owner:v1");
    expect(body.data.subjects).toEqual([]);
    expect(body.data.adapters.map((adapter: { sourceType: string }) => adapter.sourceType))
      .toContain("sellersprite_xlsx");
    expect(body.data.adapters.map((adapter: { sourceType: string }) => adapter.sourceType))
      .toContain("manual_entry");
  });

  it("returns the source asset inbox when view=assets", async () => {
    mocks.getSourceAssetInbox.mockResolvedValueOnce({
      schemaVersion: "source-asset-inbox.v1",
      accessMode: "owner",
      operator: "owner:v1",
      totalCount: 1,
      passedCount: 1,
      reviewCount: 0,
      blockedCount: 0,
      items: [
        {
          subjectKey: "amazon:US:B0EXAMPLE",
          asin: "B0EXAMPLE",
          title: "Test Item",
          statusLabel: "可研究",
          latestVerdict: "passed",
        },
      ],
    });
    const req = {
      ...request(null),
      nextUrl: new URL(`${BASE}/api/source-layer?view=assets`),
    };
    const response = await getLedger(req as never);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.schemaVersion).toBe("source-asset-inbox.v1");
    expect(body.data.items[0].asin).toBe("B0EXAMPLE");
    expect(mocks.getSourceAssetInbox).toHaveBeenCalled();
  });
});

describe("POST /api/source-layer/ingest", () => {
  it("rejects a cross-origin request", async () => {
    const response = await postIngest(request({ sourceType: "manual_entry", payload: {} }, {
      origin: "https://evil.example.com",
    }) as never);
    expect(response.status).toBe(403);
    expect(mocks.gateway).not.toHaveBeenCalled();
  });

  it("rejects unsupported source types without calling the service", async () => {
    const response = await postIngest(request({ sourceType: "totally_new_source", payload: {} }) as never);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("source_type_invalid");
    expect(mocks.gateway).not.toHaveBeenCalled();
  });

  it("rejects a source type without a registered adapter", async () => {
    const response = await postIngest(request({ sourceType: "browser_agent", payload: {} }) as never);
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("adapter_not_found");
    expect(mocks.gateway).not.toHaveBeenCalled();
  });

  it("rejects a missing payload", async () => {
    const response = await postIngest(request({ sourceType: "manual_entry" }) as never);
    expect(response.status).toBe(400);
    expect(mocks.gateway).not.toHaveBeenCalled();
  });

  it("ingests a valid manual entry and only passes server-side fields through", async () => {
    const response = await postIngest(request({
      sourceType: "manual_entry",
      payload: { asin: "B0FH1ZXTN1" },
      sourceUrl: "https://www.amazon.com/dp/B0FH1ZXTN1",
    }) as never);
    expect(response.status).toBe(201);
    expect(mocks.gateway).toHaveBeenCalledWith(expect.objectContaining({
      source: "manual",
      payload: { asin: "B0FH1ZXTN1" },
      sourceUrl: "https://www.amazon.com/dp/B0FH1ZXTN1",
    }));
  });

  it("maps service fail-closed codes to 4xx instead of 500", async () => {
    const { SourceLayerServiceError } = await import("@/lib/sourceLayer/server/sourceLayerService");
    mocks.gateway.mockRejectedValueOnce(new SourceLayerServiceError("no_capturable_records", "没有可用记录。"));
    const response = await postIngest(request({ sourceType: "manual_entry", payload: {} }) as never);
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("no_capturable_records");
  });
});

describe("POST /api/source-layer/handoff", () => {
  it("requires a non-empty selection", async () => {
    const response = await postHandoff(request({ subjectKeys: [] }) as never);
    expect(response.status).toBe(400);
    expect(mocks.handoff).not.toHaveBeenCalled();
  });

  it("rejects unsafe subject keys", async () => {
    const response = await postHandoff(request({ subjectKeys: ["../../etc/passwd"] }) as never);
    expect(response.status).toBe(400);
    expect(mocks.handoff).not.toHaveBeenCalled();
  });

  it("caps the selection size", async () => {
    const response = await postHandoff(request({
      subjectKeys: Array.from({ length: 21 }, (_, index) => `amazon:US:B0FH1ZXT${String(index).padStart(2, "0")}`),
    }) as never);
    expect(response.status).toBe(400);
    expect(mocks.handoff).not.toHaveBeenCalled();
  });

  it("hands off a valid selection and returns a site-relative destination", async () => {
    const response = await postHandoff(request({ subjectKeys: ["amazon:US:B0FH1ZXTN1"] }) as never);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.created).toHaveLength(1);
    expect(body.data.destinationUrl.startsWith("/")).toBe(true);
    expect(body.data.evidenceOnlyNote).toContain("人工确认");
  });
});

describe("GET /api/source-layer/evidence/[subjectKey]", () => {
  it("rejects an unsafe subject key", async () => {
    const response = await getEvidence(request(null) as never, {
      params: Promise.resolve({ subjectKey: "../../etc" }),
    });
    expect(response.status).toBe(400);
    expect(mocks.getDetail).not.toHaveBeenCalled();
  });

  it("returns 404 when there is no evidence for the subject", async () => {
    mocks.getDetail.mockResolvedValueOnce({ subject: null, audit: [] });
    const response = await getEvidence(request(null) as never, {
      params: Promise.resolve({ subjectKey: "amazon%3AUS%3AB0FH1ZXTN1" }),
    });
    expect(response.status).toBe(404);
  });

  it("returns the evidence versions and audit timeline", async () => {
    const response = await getEvidence(request(null) as never, {
      params: Promise.resolve({ subjectKey: "amazon%3AUS%3AB0FH1ZXTN1" }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.subjectKey).toBe("amazon:US:B0FH1ZXTN1");
    expect(mocks.getDetail).toHaveBeenCalledWith(
      { mode: "owner", token: "owner-token" },
      "amazon:US:B0FH1ZXTN1",
    );
  });
});

describe("POST /api/source-layer/from-product-batch", () => {
  beforeEach(() => {
    mocks.gatewayBatch.mockResolvedValue({
      source: "sellersprite_xlsx",
      capturedAt: "2026-02-01T00:00:00.000Z",
      capture: {
        productBatchId: "batch-1",
        batchName: "Sports & Outdoors · water bottle",
        requestedItemIds: ["item-a", "item-b"],
        skippedItemIds: [],
        items: [],
        errors: [],
        readyCount: 1,
        reviewCount: 1,
        blockedCount: 0,
      },
      productFacts: [{}],
      qualityGate: { enabled: false, status: "disabled", gateId: null, issues: [] },
    });
  });

  it("requires authentication and same-origin", async () => {
    mocks.requireAuthenticated.mockReturnValueOnce({ ok: false, status: 401, code: "invalid_access", message: "请先登录。" });
    const unauth = await postFromProductBatch(request({}) as never);
    expect(unauth.status).toBe(401);

    const crossOrigin = await postFromProductBatch(request({}, { origin: "https://evil.example.com" }) as never);
    expect(crossOrigin.status).toBe(403);
    expect(mocks.gatewayBatch).not.toHaveBeenCalled();
  });

  it("bridges the whole active batch when no item id is given", async () => {
    const response = await postFromProductBatch(request({}) as never);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.productBatchId).toBe("batch-1");
    expect(body.data.batchName).toContain("water bottle");
    expect(body.data.totalDrafts).toBe(2);
    expect(body.data.readyCount).toBe(1);
    expect(body.data.schemaVersion).toBe("source-layer-ingest-result.v1");
    expect(mocks.gatewayBatch).toHaveBeenCalledWith({
      context: { mode: "owner", token: "owner-token" },
    });
  });

  it("accepts an explicit item id and rejects an unsafe one", async () => {
    const ok = await postFromProductBatch(request({ productBatchItemId: "item-a" }) as never);
    expect(ok.status).toBe(200);
    expect(mocks.gatewayBatch).toHaveBeenCalledWith({
      context: { mode: "owner", token: "owner-token" },
      productBatchItemId: "item-a",
    });

    mocks.gatewayBatch.mockClear();
    const bad = await postFromProductBatch(request({ productBatchItemId: "../../etc/passwd" }) as never);
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(body.error.code).toBe("product_batch_item_id_invalid");
    expect(mocks.gatewayBatch).not.toHaveBeenCalled();
  });

  it("surfaces fail-closed batch state as 409 instead of 500", async () => {
    const { SourceLayerServiceError } = await import("@/lib/sourceLayer/server/sourceLayerService");
    mocks.gatewayBatch.mockRejectedValueOnce(new SourceLayerServiceError("candidate_not_ready", "当前商品批次尚不可用。"));
    const response = await postFromProductBatch(request({}) as never);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("candidate_not_ready");
  });
});
