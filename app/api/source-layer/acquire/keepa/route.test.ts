import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuthenticated: vi.fn(),
  captureV3ModuleEvidence: vi.fn(),
  getMarketIntelligence: vi.fn(),
}));
vi.mock("@/lib/server/marketIntelligenceService", () => ({ getMarketIntelligence: mocks.getMarketIntelligence }));

vi.mock("@/lib/server/demoGuard", () => ({
  requireAuthenticated: mocks.requireAuthenticated,
}));

vi.mock("@/lib/sourceLayer/v3ModuleEvidence", () => ({
  captureV3ModuleEvidence: mocks.captureV3ModuleEvidence,
}));

import { POST } from "./route";

const CSV_FIXTURE = `ASIN,Title,Buy Box: Current,Buy Box: 90 days lowest,Buy Box: 90 days avg,Buy Box: 360 days lowest,Sales Rank: 90 days avg,Sales Rank: drops 90 days,Buy Box: % Amazon 90 days,Lightning Deals: 90 days count
B085DTZQNZ,Test Bottle,$25.00,$22.00,$24.00,$19.00,1500,12,45.5%,3`;

function formRequest(csv: string | null, scanId?: string): NextRequest {
  const form = new FormData();
  if (csv !== null) form.append("file", new File([csv], "keepa.csv", { type: "text/csv" }));
  form.append("marketplace", "US");
  if (scanId) form.append("researchScanId", scanId);
  return new NextRequest("http://127.0.0.1:3010/api/source-layer/acquire/keepa", {
    method: "POST",
    headers: { host: "127.0.0.1:3010", origin: "http://127.0.0.1:3010" },
    body: form,
  });
}

describe("P2-CAP-01 POST /api/source-layer/acquire/keepa", () => {
  it("rejects a foreign ASIN before any row is written to a research-scoped import", async () => {
    mocks.getMarketIntelligence.mockResolvedValue({ marketplace: "US", statistics: { subjects: ["amazon:US:B01ACUA8HC"] } });
    const response = await POST(formRequest(CSV_FIXTURE, "study-1"));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("keepa_research_scope_mismatch");
    expect(mocks.captureV3ModuleEvidence).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticated.mockReturnValue({ ok: true, context: { mode: "owner", userId: "owner-1" } });
  });

  it("非法文件 fail-closed：无数据行返回 400 且零入库调用", async () => {
    const response = await POST(formRequest("not,a,keepa,file\n1,2,3"));
    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("keepa_export_invalid");
    expect(mocks.captureV3ModuleEvidence).not.toHaveBeenCalled();
  });

  it("缺文件返回 400", async () => {
    const response = await POST(formRequest(null));
    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe("file_required");
  });

  it("合法导表入库：sourceType=keepa_export、module=historical_trend、data.timeSeries 承载时序指标", async () => {
    mocks.captureV3ModuleEvidence.mockResolvedValue({
      moduleEvidence: { data: { timeSeries: { price90dMin: 22 } } },
    });
    const response = await POST(formRequest(CSV_FIXTURE));
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; data: { importedCount: number; imported: Array<{ asin: string; subjectKey: string }>; sourceFileSha256: string } };
    expect(body.ok).toBe(true);
    expect(body.data.importedCount).toBe(1);
    expect(body.data.imported[0].asin).toBe("B085DTZQNZ");
    expect(body.data.imported[0].subjectKey).toBe("amazon:US:B085DTZQNZ");
    const sourceFileSha256 = createHash("sha256").update(Buffer.from(CSV_FIXTURE, "utf8")).digest("hex");
    expect(body.data.sourceFileSha256).toBe(sourceFileSha256);
    expect(mocks.captureV3ModuleEvidence).toHaveBeenCalledTimes(1);
    const call = mocks.captureV3ModuleEvidence.mock.calls[0][0] as { sourceType: string; sourceFingerprint: string; moduleEvidence: { module: string; data: Record<string, unknown>; acquisitionMode: string; metricNature: string; limitations: string[] } };
    expect(call.sourceType).toBe("keepa_export");
    expect(call.sourceFingerprint).toBe(sourceFileSha256);
    expect(call.moduleEvidence.module).toBe("historical_trend");
    expect(call.moduleEvidence.acquisitionMode).toBe("FILE_EXPORT");
    expect(call.moduleEvidence.metricNature).toBe("provider_observed");
    expect(call.moduleEvidence.data.timeSeries).toBeTruthy();
    expect(call.moduleEvidence.data.sourceFileSha256).toBe(sourceFileSha256);
    expect(call.moduleEvidence.data.rawSourceRow).toEqual(expect.objectContaining({ ASIN: "B085DTZQNZ" }));
    expect(call.moduleEvidence.limitations.join(" ")).toContain("不独立验证文件来源");
    expect(call.moduleEvidence.limitations.join(" ")).toContain("不保存整份上传文件");
  });

  it("有效行超出每次预算时报告未尝试数量，不与解析隔离混算", async () => {
    mocks.captureV3ModuleEvidence.mockResolvedValue({
      moduleEvidence: { data: { timeSeries: { price90dMin: 22 } } },
    });
    const headers = "ASIN,Title,Buy Box: Current,Buy Box: 90 days lowest,Buy Box: 90 days avg,Buy Box: 360 days lowest,Sales Rank: 90 days avg,Sales Rank: drops 90 days,Buy Box: % Amazon 90 days,Lightning Deals: 90 days count";
    const rows = Array.from({ length: 51 }, (_, index) => `B${String(index).padStart(9, "0")},Item,25,22,24,19,1500,12,45.5%,3`);
    const response = await POST(formRequest([headers, ...rows].join("\n")));
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { importedCount: number; failedCount: number; quarantinedCount: number; omittedByBudgetCount: number } };
    expect(body.data).toMatchObject({ importedCount: 50, failedCount: 0, quarantinedCount: 0, omittedByBudgetCount: 1 });
    expect(mocks.captureV3ModuleEvidence).toHaveBeenCalledTimes(50);
  });

  it("同一导表内重复 ASIN 只保存一次并把重复项作为失败明细返回", async () => {
    mocks.captureV3ModuleEvidence.mockResolvedValue({
      moduleEvidence: { data: { timeSeries: { price90dMin: 22 } } },
    });
    const headers = CSV_FIXTURE.slice(0, CSV_FIXTURE.indexOf("\n"));
    const row = CSV_FIXTURE.slice(CSV_FIXTURE.indexOf("\n") + 1);
    const response = await POST(formRequest([headers, row, row].join("\n")));
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { importedCount: number; failedCount: number; failed: Array<{ asin: string; reason: string }> } };
    expect(body.data.importedCount).toBe(1);
    expect(body.data.failedCount).toBe(1);
    expect(body.data.failed[0]).toEqual({ asin: "B085DTZQNZ", reason: "同一导表内 ASIN 重复，已拒绝重复写入" });
    expect(mocks.captureV3ModuleEvidence).toHaveBeenCalledOnce();
  });

  it("整份文件无有效 ASIN 行时 fail-closed（400，零入库）", async () => {
    const csv = `ASIN,Title,Buy Box: Current,Buy Box: 90 days lowest,Buy Box: 90 days avg,Buy Box: 360 days lowest,Sales Rank: 90 days avg,Sales Rank: drops 90 days,Buy Box: % Amazon 90 days,Lightning Deals: 90 days count
BADASIN,Broken,1,2,3,4,5,6,7,8`;
    const response = await POST(formRequest(csv));
    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe("keepa_export_invalid");
    expect(mocks.captureV3ModuleEvidence).not.toHaveBeenCalled();
  });

  it("未鉴权请求 fail-closed", async () => {
    mocks.requireAuthenticated.mockReturnValue({ ok: false, status: 401, code: "unauthorized", message: "请先输入访问密码" });
    const response = await POST(formRequest(CSV_FIXTURE));
    expect(response.status).toBe(401);
  });
});
