import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuthenticated: vi.fn(),
  preflight: vi.fn(),
  commodityPreflight: vi.fn(),
}));

vi.mock("@/lib/server/demoGuard", () => ({ requireAuthenticated: mocks.requireAuthenticated }));
vi.mock("@/lib/integrations/lark", () => ({
  LarkBaseDestination: class {
    preflight = mocks.preflight;
  },
  LarkCommodityPoolDestination: class {
    preflight = mocks.commodityPreflight;
  },
}));

import { GET } from "./route";

describe("GET /api/research-export/lark-preflight", () => {
  beforeEach(() => {
    mocks.requireAuthenticated.mockReset();
    mocks.preflight.mockReset();
    mocks.commodityPreflight.mockReset();
    mocks.requireAuthenticated.mockReturnValue({
      ok: true,
      context: { mode: "owner", demoAccessId: null },
    });
  });

  it("未登录时拒绝访问", async () => {
    mocks.requireAuthenticated.mockReturnValueOnce({
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "未登录。",
    });

    const response = await GET(new NextRequest("http://localhost/api/research-export/lark-preflight"));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(mocks.preflight).not.toHaveBeenCalled();
  });

  it("登录后正常返回 Preflight 结果", async () => {
    mocks.preflight.mockResolvedValueOnce({
      configured: true,
      connected: true,
      baseAccessible: true,
      tableAccessible: true,
      writable: true,
      appToken: "app_123",
      tableId: "tbl_456",
      missingFields: [],
      missingWriteFields: [],
      missingOptionalFields: [],
      incompatibleFields: [],
      fieldMapping: {},
    });

    const response = await GET(new NextRequest("http://localhost/api/research-export/lark-preflight"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.connected).toBe(true);
    expect(body.data.writable).toBe(true);
    expect(body.data.missingWriteFields).toEqual([]);
  });

  it("写入字段缺失时不静默：missingWriteFields 与 writable=false 原样透出", async () => {
    mocks.preflight.mockResolvedValueOnce({
      configured: true,
      connected: true,
      baseAccessible: true,
      tableAccessible: true,
      writable: false,
      appToken: "app_123",
      tableId: "tbl_456",
      missingFields: [],
      missingWriteFields: ["预估月销量"],
      missingOptionalFields: ["预估月销量"],
      incompatibleFields: [],
      fieldMapping: {},
      errorCode: "TABLE_FIELDS_MISMATCH",
      errorMessage: "飞书表结构不满足 V1 契约，缺少必须字段: 无；缺少写入字段: 预估月销量",
    });

    const response = await GET(new NextRequest("http://localhost/api/research-export/lark-preflight"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.writable).toBe(false);
    expect(body.data.missingWriteFields).toEqual(["预估月销量"]);
  });

  it("contract=commodity 时读取商品池字段契约，默认旧预检保持不变", async () => {
    mocks.commodityPreflight.mockResolvedValueOnce({
      configured: true,
      connected: true,
      tableAccessible: true,
      writable: false,
      missingFields: ["subjectKey"],
      missingWriteFields: ["subjectKey"],
      missingOptionalFields: [],
      incompatibleFields: [],
      fieldMapping: {},
      errorCode: "TABLE_FIELDS_MISMATCH",
    });

    const response = await GET(new NextRequest("http://localhost/api/research-export/lark-preflight?contract=commodity"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.writable).toBe(false);
    expect(body.data.missingWriteFields).toEqual(["subjectKey"]);
    expect(mocks.preflight).not.toHaveBeenCalled();
  });
});
