import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getBatch: vi.fn(),
  getBatchItems: vi.fn(),
  status: vi.fn(),
  readV3: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({ prisma: {} }));
vi.mock("@/lib/server/v5ApiRoute", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server/v5ApiRoute")>(),
  readAuth: mocks.auth,
}));
vi.mock("@/lib/server/batchCaptureRunService", () => ({
  createBatchCaptureRunService: () => ({ status: mocks.status }),
}));
vi.mock("@/lib/server/productBatchStoreResolver", () => ({
  getProductBatchStore: () => ({ getBatch: mocks.getBatch, getBatchItems: mocks.getBatchItems }),
}));
vi.mock("@/lib/sourceLayer/v3ModuleEvidence", () => ({
  readV3ModuleEvidence: mocks.readV3,
}));

import { GET } from "./route";

const PRODUCT_SUBJECT = "amazon:US:B000000001";
const PRODUCT_SUBJECT_2 = "amazon:US:B000000002";
const PRODUCT_QUERY_SUBJECT = `sellersprite:US:product-market:${"a".repeat(64)}`;
const KEYWORD_QUERY_SUBJECT = `sellersprite:US:keyword-mining:${"b".repeat(64)}`;

function request(batchId = "batch-external-evidence-01"): NextRequest {
  return new NextRequest(
    `http://localhost:3010/api/source-layer/batch-capture/external-evidence?batchId=${batchId}`,
    { method: "GET", headers: { host: "localhost:3010" } },
  );
}

function batch() {
  return { id: "batch-external-evidence-01", marketplace: "US", batchStatus: "ready" };
}

function items() {
  return [
    { id: "item-1", batchId: "batch-external-evidence-01", asin: "B000000001", archivedAt: null },
    { id: "item-2", batchId: "batch-external-evidence-01", asin: "B000000002", archivedAt: null },
    { id: "item-3", batchId: "batch-external-evidence-01", asin: null, archivedAt: null },
    { id: "item-4", batchId: "batch-external-evidence-01", asin: "B000000003", archivedAt: "2026-10-01T00:00:00.000Z" },
  ];
}

function run() {
  return {
    runId: "run-external-evidence-01",
    productMarketQueries: [{ querySubjectKey: PRODUCT_QUERY_SUBJECT, status: "captured" }],
    keywordMiningQueries: [{ querySubjectKey: KEYWORD_QUERY_SUBJECT, status: "blocked" }],
  };
}

function evidence(module: string, capturedAt: string) {
  return { module, capturedAt };
}

describe("GET /api/source-layer/batch-capture/external-evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockReturnValue({ ok: true, context: { mode: "owner", token: "" } });
    mocks.getBatch.mockResolvedValue(batch());
    mocks.getBatchItems.mockResolvedValue(items());
    mocks.status.mockResolvedValue(run());
    mocks.readV3.mockImplementation(async (input: { subjectKey: string; module?: string }) => {
      if (input.subjectKey === PRODUCT_SUBJECT) {
        return {
          subjectKey: input.subjectKey,
          modules: [evidence("historical_trend", "2026-10-02T00:00:00.000Z"), evidence("reverse_asin", "2026-10-01T00:00:00.000Z")],
          evidenceStore: null,
        };
      }
      if (input.subjectKey === PRODUCT_SUBJECT_2) {
        return { subjectKey: input.subjectKey, modules: [evidence("reverse_asin", "2026-10-03T00:00:00.000Z")], evidenceStore: null };
      }
      if (input.subjectKey === PRODUCT_QUERY_SUBJECT) {
        return {
          subjectKey: input.subjectKey,
          modules: [
            evidence("sellersprite_product_market", "2026-10-04T00:00:00.000Z"),
            evidence("sellersprite_product_market", "2026-10-03T00:00:00.000Z"),
          ],
          evidenceStore: null,
        };
      }
      if (input.subjectKey === KEYWORD_QUERY_SUBJECT) {
        return { subjectKey: input.subjectKey, modules: [evidence("keyword_mining_trend", "2026-10-05T00:00:00.000Z")], evidenceStore: null };
      }
      return { subjectKey: input.subjectKey, modules: [], evidenceStore: null };
    });
  });

  it("按 ASIN × {反查/历史趋势} 与查询主体 × {商品市场/关键词} 返回附件计数", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    const json = await response.json() as {
      ok: boolean;
      data: {
        runId: string | null;
        subjects: Array<{ subjectKey: string; module: string; attachmentCount: number; latestCapturedAt: string | null }>;
        totals: {
          subjectCount: number; checkedSubjectCount: number; attachmentCount: number;
          productSubjectCount: number; productAttachmentCount: number;
          querySubjectCount: number; queryAttachmentCount: number; failedSubjectCount: number;
        };
      };
    };
    expect(json.ok).toBe(true);
    expect(json.data.runId).toBe("run-external-evidence-01");
    // 2 个有效 ASIN × 2 个商品级模块 + 2 个查询主体 = 6 个被检查主体。
    expect(json.data.subjects).toHaveLength(6);
    expect(json.data.totals).toMatchObject({
      subjectCount: 5,
      checkedSubjectCount: 6,
      attachmentCount: 6,
      productSubjectCount: 3,
      productAttachmentCount: 3,
      querySubjectCount: 2,
      queryAttachmentCount: 3,
      failedSubjectCount: 0,
    });
    const reverseOfFirst = json.data.subjects.find((subject) =>
      subject.subjectKey === PRODUCT_SUBJECT && subject.module === "reverse_asin");
    expect(reverseOfFirst).toEqual({
      subjectKey: PRODUCT_SUBJECT,
      module: "reverse_asin",
      attachmentCount: 1,
      latestCapturedAt: "2026-10-01T00:00:00.000Z",
    });
    const productQuery = json.data.subjects.find((subject) => subject.module === "sellersprite_product_market");
    expect(productQuery?.attachmentCount).toBe(2);
    expect(productQuery?.latestCapturedAt).toBe("2026-10-04T00:00:00.000Z");
    // 主体键必须来自 run 回执，不能自行拼装。
    expect(productQuery?.subjectKey).toBe(PRODUCT_QUERY_SUBJECT);
    // 无效 ASIN / 已归档条目不会产生读取。
    expect(mocks.readV3).not.toHaveBeenCalledWith(expect.objectContaining({ subjectKey: "amazon:US:B000000003" }));
  });

  it("单个主体读取失败时 fail-soft：整体仍 200，其余主体照常返回", async () => {
    mocks.readV3.mockImplementation(async (input: { subjectKey: string }) => {
      if (input.subjectKey === PRODUCT_SUBJECT_2) throw new Error("EVIDENCE_SUBJECT_READ_FAILED");
      return { subjectKey: input.subjectKey, modules: [], evidenceStore: null };
    });
    const response = await GET(request());
    expect(response.status).toBe(200);
    const json = await response.json() as {
      data: { subjects: unknown[]; totals: { failedSubjectCount: number; failures: Array<{ subjectKey: string; message: string }> } };
    };
    expect(json.data.subjects).toHaveLength(6);
    expect(json.data.totals.failedSubjectCount).toBe(1);
    expect(json.data.totals.failures[0]).toMatchObject({ subjectKey: PRODUCT_SUBJECT_2, message: "EVIDENCE_SUBJECT_READ_FAILED" });
  });

  it("没有 run 时只读取商品级主体（不伪造查询主体）", async () => {
    mocks.status.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(200);
    const json = await response.json() as {
      data: { runId: string | null; subjects: Array<{ module: string }>; totals: { querySubjectCount: number } };
    };
    expect(json.data.runId).toBeNull();
    expect(json.data.subjects).toHaveLength(4);
    expect(json.data.subjects.every((subject) => ["reverse_asin", "historical_trend"].includes(subject.module))).toBe(true);
    expect(json.data.totals.querySubjectCount).toBe(0);
  });

  it("失败态隔离：批次不存在返回 404，不读取 EvidenceStore", async () => {
    mocks.getBatch.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(mocks.readV3).not.toHaveBeenCalled();
  });

  it("owner-only：visitor 上下文直接拒绝，不读取任何主体", async () => {
    mocks.auth.mockReturnValue({ ok: true, context: { mode: "demo", demoAccessId: "demo-1" } });
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(mocks.readV3).not.toHaveBeenCalled();
  });

  it("鉴权失败按既有只读路由形状返回", async () => {
    mocks.auth.mockReturnValue({ ok: false, status: 403, code: "origin_denied", message: "请求来源校验失败。" });
    const response = await GET(request());
    expect(response.status).toBe(403);
    const json = await response.json() as { ok: boolean; error: { code: string } };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("缺少 batchId 返回 400", async () => {
    const response = await GET(new NextRequest(
      "http://localhost:3010/api/source-layer/batch-capture/external-evidence",
      { method: "GET", headers: { host: "localhost:3010" } },
    ));
    expect(response.status).toBe(400);
  });
});
