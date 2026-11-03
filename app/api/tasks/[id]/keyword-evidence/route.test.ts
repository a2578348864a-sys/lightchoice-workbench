import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOwnerOnly: vi.fn(),
  findFirst: vi.fn(),
  captureSellerSpriteKeywordEvidence: vi.fn(),
  getKeywordEvidence: vi.fn(),
  getKeywordEvidenceReports: vi.fn(),
  readKeywordEvidenceSnapshot: vi.fn(),
  saveKeywordEvidence: vi.fn(),
  buildResearchEngineInput: vi.fn(),
}));

vi.mock("@/lib/server/research/researchInput", () => ({
  buildResearchEngineInput: mocks.buildResearchEngineInput,
}));

vi.mock("@/lib/server/demoGuard", () => ({
  requireOwnerOnly: mocks.requireOwnerOnly,
  requireAuthenticated: mocks.requireOwnerOnly,
}));

vi.mock("@/lib/server/db", () => {
  const deep = () => new Proxy({}, { get: (t: Record<string, unknown>, k: string) => t[k] ?? (t[k] = vi.fn(() => null)) });
  const prisma = new Proxy({ viralAnalysisRecord: { findFirst: mocks.findFirst } } as Record<string, unknown>, {
    get: (t: Record<string, unknown>, k: string) => t[k] ?? (t[k] = deep()),
  });
  return { prisma };
});

vi.mock("@/lib/server/runtimeMode", () => ({ getRuntimeMode: () => "local_owner" }));

vi.mock("@/lib/server/sellerSpriteKeywordCapture", () => ({
  captureSellerSpriteKeywordEvidence: mocks.captureSellerSpriteKeywordEvidence,
}));

vi.mock("@/lib/server/keywordEvidence", () => ({
  KEYWORD_EVIDENCE_SCHEMA: "seller-sprite-keyword-evidence.v1",
  KeywordEvidenceError: class KeywordEvidenceError extends Error {
    code = "test_error";
    status = 400;
  },
  getKeywordEvidence: mocks.getKeywordEvidence,
  getKeywordEvidenceReports: mocks.getKeywordEvidenceReports,
  readKeywordEvidenceSnapshot: mocks.readKeywordEvidenceSnapshot,
  saveKeywordEvidence: mocks.saveKeywordEvidence,
}));

import { GET, POST } from "./route";
import {
  storeBrowserUsePreview,
  _clearBrowserUsePreviewCacheForTests,
  type BrowserUseResearchPreviewV1,
} from "@/lib/server/browserUseResearch";

const OWNER_PREVIEW_BINDING = { subjectKey: "owner:v1", taskId: "task-k" };

function ownerRequest(body: unknown, contentType = "application/json") {
  return {
    url: "http://localhost:3000/api/tasks/task-k/keyword-evidence",
    headers: new Headers({ origin: "http://localhost:3000", host: "localhost:3000", "content-type": contentType }),
    json: async () => body,
    clone: function () { return this; },
    formData: async () => { throw new Error("no form"); },
  } as never;
}

function ownerGetRequest() {
  return {
    url: "http://localhost:3000/api/tasks/task-k/keyword-evidence",
    headers: new Headers({ origin: "http://localhost:3000", host: "localhost:3000" }),
    clone: function () { return this; },
  } as never;
}

function keywordPreview(overrides: Partial<BrowserUseResearchPreviewV1> = {}): BrowserUseResearchPreviewV1 {
  return {
    schema: "browser-use-research-preview.v1", version: 1, kind: "keyword",
    seedAsin: "B0SAMPLE12", marketplace: "Amazon US", seedProductUrl: null,
    sourceUrl: "https://www.amazon.com/dp/B0SAMPLE12", capturedAt: "2026-08-14T02:00:00.000Z",
    results: [{ keyword: "insulated tumbler", keywordTranslation: null, searchVolume: 45000, relevance: null, competition: 0.5, capturedAt: "2026-08-14T02:00:01.000Z" }],
    missing: [], failureReason: null,
    collector: { tool: "browser-use", version: "0.1.9" },
    ...overrides,
  } as BrowserUseResearchPreviewV1;
}

beforeEach(() => {
  vi.clearAllMocks();
  _clearBrowserUsePreviewCacheForTests();
  mocks.requireOwnerOnly.mockReturnValue({ ok: true, context: { mode: "owner", token: "t" } });
  mocks.findFirst.mockResolvedValue({ id: "task-k", resultJson: JSON.stringify({ candidateAnalysisContext: { version: "candidate-analysis-context-v1", integrity: "verified_product_batch", facts: { productName: "T", marketplace: "US", asin: "B0SAMPLE12", reportType: "search_results" }, assessment: {} } }), updatedAt: new Date("2026-08-14T02:00:00.000Z") });
  mocks.getKeywordEvidence.mockResolvedValue(null);
  mocks.getKeywordEvidenceReports.mockResolvedValue({});
  mocks.buildResearchEngineInput.mockRejectedValue(new Error("no_product_fact"));
  mocks.readKeywordEvidenceSnapshot.mockImplementation(async () => {
    const row = await mocks.findFirst();
    return {
      resultJson: row?.resultJson ?? "{}",
      updatedAt: row?.updatedAt ?? new Date("2026-08-14T02:00:00.000Z"),
    };
  });
});

describe("关键词证据入口：Browser Preview 或人工确认的官方 SellerSprite 表格", () => {
  it("关键词自动采集（collect_browser_use）→ 400 invalid_action", async () => {
    const res = await POST(ownerRequest({ action: "collect_browser_use" }), { params: Promise.resolve({ id: "task-k" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_action");
  });

  it("人工报表上传（multipart / action=save）→ 400 upload_disabled / invalid_action", async () => {
    const upload = await POST(ownerRequest({ file: "xlsx" }, "multipart/form-data; boundary=x"), { params: Promise.resolve({ id: "task-k" }) });
    expect(upload.status).toBe(400);
    expect((await upload.json()).error.code).toBe("upload_disabled");
    const manualSave = await POST(ownerRequest({ action: "save", report: {} }), { params: Promise.resolve({ id: "task-k" }) });
    expect(manualSave.status).toBe(400);
    expect((await manualSave.json()).error.code).toBe("invalid_action");
  });

  it("官方页面 TSV 未绑定正式 ProductFact 时 fail-closed，不进入任务或 Source Layer", async () => {
    const response = await POST(ownerRequest({
      action: "save_sellersprite_report",
      asin: "B0SAMPLE12",
      sourceRef: "SellerSprite official panel",
      sourceMethod: "sellersprite_page_manual_tsv",
      headers: ["Keyword", "Monthly Searches"],
      rows: [["insulated tumbler", "45000"]],
      expectedStorageVersion: { resultJsonHash: "a".repeat(64), updatedAt: "2026-08-14T02:00:00.000Z" },
    }), { params: Promise.resolve({ id: "task-k" }) });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("source_product_fact_required");
  });

  it("保存权限拒绝（demo）→ 403", async () => {
    mocks.requireOwnerOnly.mockReturnValueOnce({ ok: false, status: 403, code: "browser_use_local_owner_only", message: "x" });
    const denied = await POST(ownerRequest({ action: "save_browser_use", previewId: "bup_preview_x", expectedStorageVersion: { resultJsonHash: "a".repeat(64), updatedAt: "x" } }), { params: Promise.resolve({ id: "task-k" }) });
    expect(denied.status).toBe(403);
  });

  it("身份缺失 409；交换 seed 409；伪造外站 URL 400；预览缺失 400", async () => {
    mocks.findFirst.mockResolvedValue({ id: "task-k", resultJson: JSON.stringify({ candidateAnalysisContext: { integrity: "unverified" } }), updatedAt: new Date() });
    const noIdentity = await POST(ownerRequest({ action: "save_browser_use", previewId: "bup_preview_x", expectedStorageVersion: { resultJsonHash: "a".repeat(64), updatedAt: "x" } }), { params: Promise.resolve({ id: "task-k" }) });
    expect(noIdentity.status).toBe(409);
    expect((await noIdentity.json()).error.code).toBe("browser_use_identity_unavailable");

    mocks.findFirst.mockResolvedValue({ id: "task-k", resultJson: JSON.stringify({ candidateAnalysisContext: { version: "candidate-analysis-context-v1", integrity: "verified_product_batch", facts: { productName: "T", marketplace: "US", asin: "B0SAMPLE12", reportType: "search_results" }, assessment: {} } }), updatedAt: new Date() });
    const evilId = storeBrowserUsePreview(keywordPreview({ sourceUrl: "https://evil.example/x" }), OWNER_PREVIEW_BINDING);
    const forged = await POST(ownerRequest({ action: "save_browser_use", previewId: evilId, expectedStorageVersion: { resultJsonHash: "a".repeat(64), updatedAt: "x" } }), { params: Promise.resolve({ id: "task-k" }) });
    expect(forged.status).toBe(400);
    expect((await forged.json()).error.code).toBe("forged_external_source_url");

    const missing = await POST(ownerRequest({ action: "save_browser_use", previewId: "bup_preview_missing", expectedStorageVersion: { resultJsonHash: "a".repeat(64), updatedAt: "x" } }), { params: Promise.resolve({ id: "task-k" }) });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe("preview_not_found");
  });
});

describe("SellerSprite 官方结构化报表入口", () => {
  it("先调用 Source Layer capture adapter，再通过 CAS writer 保存 task KeywordEvidence", async () => {
    const evidence = {
      schema: "seller-sprite-keyword-evidence.v1",
      reportType: "reverse_asin",
      capturedAt: "2026-08-14T02:00:00.000Z",
      dataPeriod: null,
      rows: [{ rowNumber: 1, keyword: "wood board", keywordTranslation: null, fields: {} }],
      updatedAt: "2026-08-14T02:00:00.000Z",
      sourceEvidenceRefs: [{ sourceEvidenceId: "se-1", subjectKey: "amazon:US:B0SAMPLE12", sourceType: "sellersprite_xlsx", evidenceVersion: "v1" }],
    };
    mocks.captureSellerSpriteKeywordEvidence.mockResolvedValue({
      ok: true,
      evidence,
      gateway: { sourceEvidenceRef: "se-1", created: true, duplicate: false },
      reportType: "reverse_asin",
    });
    mocks.saveKeywordEvidence.mockResolvedValue(evidence);
    mocks.buildResearchEngineInput.mockResolvedValueOnce({
      taskId: "task-k",
      candidateId: "cand-k",
      productFact: {
        basic: {
          asin: { value: "B0SAMPLE12", status: "confirmed" },
        },
      },
    });

    const response = await POST(ownerRequest({
      action: "save_sellersprite_report",
      asin: "B0SAMPLE12",
      sourceRef: "seller-sprite-official-export-2026-08-14",
      headers: ["Keyword", "Monthly Searches"],
      rows: [["wood board", "1200"]],
      expectedStorageVersion: { resultJsonHash: "a".repeat(64), updatedAt: "2026-08-14T02:00:00.000Z" },
    }), { params: Promise.resolve({ id: "task-k" }) });

    expect(response.status).toBe(200);
    expect((await response.json()).data.saved).toEqual(["wood board"]);
    expect(mocks.captureSellerSpriteKeywordEvidence).toHaveBeenCalledWith(expect.objectContaining({
      asin: "B0SAMPLE12",
      sourceRef: "seller-sprite-official-export-2026-08-14",
      headers: ["Keyword", "Monthly Searches"],
      rows: [["wood board", "1200"]],
    }));
    expect(mocks.saveKeywordEvidence).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-k",
      evidence: expect.objectContaining({
        ...evidence,
        sourceEvidenceRefs: ["se-1"],
      }),
      expectedStorageVersion: { resultJsonHash: "a".repeat(64), updatedAt: "2026-08-14T02:00:00.000Z" },
    }));
  });
});

describe("GET /api/tasks/[id]/keyword-evidence 纯只读 Pending Preview Contract", () => {
  it("无 pending 缓存时返回 pendingPreview: null", async () => {
    const res = await GET(ownerGetRequest(), { params: Promise.resolve({ id: "task-k" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.pendingPreview).toBeNull();
  });

  it("有 pending 缓存时返回 pendingPreview 且纯只读不消费，并安全脱敏 items", async () => {
    const preview = keywordPreview({
      seedAsin: "B0SAMPLE12",
      results: [
        {
          keyword: "insulated tumbler",
          keywordTranslation: "保温杯",
          searchVolume: 45000,
          abaWeeklyRank: 120,
          purchaseVolume: 3500,
          relevance: 0.95,
          competition: 0.5,
          capturedAt: "2026-08-14T02:00:01.000Z",
        },
      ],
    });
    const previewId = storeBrowserUsePreview(preview, OWNER_PREVIEW_BINDING);

    const res1 = await GET(ownerGetRequest(), { params: Promise.resolve({ id: "task-k" }) });
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.ok).toBe(true);
    expect(body1.data.pendingPreview).toEqual({
      previewId,
      seedAsin: "B0SAMPLE12",
      sourceUrl: preview.sourceUrl,
      keywordCount: 1,
      capturedAt: preview.capturedAt,
      expiresAt: expect.any(String),
      items: [
        {
          keyword: "insulated tumbler",
          keywordTranslation: "保温杯",
          searchVolume: 45000,
          abaWeeklyRank: 120,
          purchaseVolume: 3500,
          relevance: 0.95,
          competition: "0.5",
        },
      ],
    });

    // 纯只读验证：再次读取仍能获取到
    const res2 = await GET(ownerGetRequest(), { params: Promise.resolve({ id: "task-k" }) });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.data.pendingPreview).toEqual(body1.data.pendingPreview);

    // 严禁泄露内部凭证或完整 raw results
    expect(body1.data.pendingPreview.results).toBeUndefined();
  });

  it("缓存过期时返回 pendingPreview: null", async () => {
    const preview = keywordPreview({ seedAsin: "B0SAMPLE12" });
    const previewId = storeBrowserUsePreview(preview, OWNER_PREVIEW_BINDING);

    // 模拟时间流逝导致过期
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 15 * 60 * 1000);
    try {
      const res = await GET(ownerGetRequest(), { params: Promise.resolve({ id: "task-k" }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.pendingPreview).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("任务缺少权威 ASIN 时返回 pendingPreview: null", async () => {
    storeBrowserUsePreview(keywordPreview({ seedAsin: "B0SAMPLE12" }), OWNER_PREVIEW_BINDING);
    mocks.findFirst.mockResolvedValue({
      id: "task-k",
      resultJson: JSON.stringify({ candidateAnalysisContext: { integrity: "unverified" } }),
      updatedAt: new Date(),
    });

    const res = await GET(ownerGetRequest(), { params: Promise.resolve({ id: "task-k" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.pendingPreview).toBeNull();
  });
});
