import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTable,
  createTableField,
  listTables,
  listTableFields,
  searchTableRecords,
  batchCreateRecords,
  batchUpdateRecords,
  readBitableTextValue,
  LarkApiError,
} from "./baseClient";
import { clearCachedLarkToken } from "./auth";
import type { LarkConfig } from "./types";

describe("readBitableTextValue（飞书文本字段回读归一）", () => {
  it("数组文本段（真实 Base 回读形态）归一为字符串", () => {
    expect(readBitableTextValue([{ text: "B0BROWSE01", type: "text" }])).toBe("B0BROWSE01");
    expect(readBitableTextValue([{ text: "A" }, { text: "B" }])).toBe("AB");
  });

  it("纯字符串与多余空白归一", () => {
    expect(readBitableTextValue("  B0TEST  ")).toBe("B0TEST");
    expect(readBitableTextValue(["x", "y"])).toBe("xy");
  });

  it("对象 / 空值 / 非法形态归一为空字符串（绝不猜测）", () => {
    expect(readBitableTextValue({ text: "Z" })).toBe("Z");
    expect(readBitableTextValue(null)).toBe("");
    expect(readBitableTextValue(undefined)).toBe("");
    expect(readBitableTextValue(123)).toBe("");
    expect(readBitableTextValue([])).toBe("");
    expect(readBitableTextValue([{ notText: 1 }])).toBe("");
  });
});

describe("Lark Base Client", () => {
  const dummyConfig: LarkConfig = {
    appId: "cli_test_123",
    appSecret: "sec_test_abc",
    appToken: "app_test_token",
    tableId: "tbl_test_table",
    openApiDomain: "https://open.feishu.cn",
  };

  beforeEach(() => {
    clearCachedLarkToken();
  });

  const makeAuthResponse = () =>
    new Response(
      JSON.stringify({
        code: 0,
        tenant_access_token: "t-mock-token-abc",
        expire: 7200,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  it("listTableFields 成功返回字段定义", async () => {
    const mockFetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/auth/v3/tenant_access_token")) {
        return makeAuthResponse();
      }
      if (urlStr.includes("/fields?page_size=100")) {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: "success",
            data: {
              items: [
                { field_id: "fld1", field_name: "ASIN", type: 1, ui_type: "Text", is_primary: true },
                { field_id: "fld2", field_name: "当前售价", type: 2, ui_type: "Number" },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unhandled URL: ${urlStr}`);
    });

    const fields = await listTableFields(dummyConfig, { fetcher: mockFetcher });
    expect(fields.length).toBe(2);
    expect(fields[0].fieldName).toBe("ASIN");
    expect(fields[1].fieldName).toBe("当前售价");
  });

  it("listTables 支持分页并返回脱敏表元数据", async () => {
    const mockFetcher = vi.fn(async (url: RequestInfo | URL) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.includes("/auth/v3/tenant_access_token")) return makeAuthResponse();
      if (parsed.pathname.endsWith("/tables")) {
        if (!parsed.searchParams.get("page_token")) {
          return new Response(JSON.stringify({
            code: 0,
            data: { items: [{ table_id: "tbl_a", name: "旧表" }], has_more: true, page_token: "next" },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({
          code: 0,
          data: { items: [{ table_id: "tbl_b", name: "商品池" }], has_more: false },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unhandled URL: ${String(url)}`);
    });

    await expect(listTables(dummyConfig, { fetcher: mockFetcher })).resolves.toEqual([
      { tableId: "tbl_a", name: "旧表" },
      { tableId: "tbl_b", name: "商品池" },
    ]);
  });

  it("createTable 与 createTableField 使用官方公开请求体", async () => {
    const mockFetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.includes("/auth/v3/tenant_access_token")) return makeAuthResponse();
      if (parsed.pathname.endsWith("/tables") && init?.method === "POST") {
        expect(JSON.parse(init.body as string)).toEqual({
          table: {
            name: "商品池",
            default_view_name: "表格",
            fields: [{ field_name: "subjectKey", type: 1 }],
          },
        });
        return new Response(JSON.stringify({ code: 0, data: { table_id: "tbl_new" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (parsed.pathname.endsWith("/fields") && init?.method === "POST") {
        expect(JSON.parse(init.body as string)).toEqual({ field_name: "当前售价", type: 2 });
        return new Response(JSON.stringify({ code: 0, data: { field_id: "fld_new" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unhandled URL: ${String(url)}`);
    });

    await expect(createTable(dummyConfig, {
      name: "商品池",
      default_view_name: "表格",
      fields: [{ field_name: "subjectKey", type: 1 }],
    }, { fetcher: mockFetcher })).resolves.toBe("tbl_new");
    await expect(createTableField(dummyConfig, {
      field_name: "当前售价",
      type: 2,
    }, { fetcher: mockFetcher })).resolves.toBe("fld_new");
  });

  it("searchTableRecords 成功执行查询", async () => {
    const mockFetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/auth/v3/tenant_access_token")) {
        return makeAuthResponse();
      }
      if (urlStr.includes("/records/search")) {
        const body = JSON.parse(init?.body as string);
        expect(body.field_names).toEqual(["ASIN"]);
        return new Response(
          JSON.stringify({
            code: 0,
            msg: "success",
            data: {
              total: 1,
              items: [
                { record_id: "rec_123", fields: { ASIN: "B0EXISTING" } },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unhandled URL: ${urlStr}`);
    });

    const records = await searchTableRecords(
      dummyConfig,
      { fieldNames: ["ASIN"] },
      { fetcher: mockFetcher },
    );
    expect(records.length).toBe(1);
    expect(records[0].record_id).toBe("rec_123");
    expect(records[0].fields.ASIN).toBe("B0EXISTING");
  });

  it("decision pull 可请求平台审核人与修改时间元数据，并保留记录级身份字段", async () => {
    const mockFetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.includes("/auth/v3/tenant_access_token")) return makeAuthResponse();
      if (parsed.pathname.endsWith("/records/search")) {
        expect(parsed.searchParams.get("user_id_type")).toBe("open_id");
        expect(JSON.parse(init?.body as string)).toEqual({ field_names: ["人工决策"], automatic_fields: true });
        return new Response(JSON.stringify({
          code: 0,
          data: {
            items: [{
              record_id: "rec_decision",
              fields: { "人工决策": "APPROVE" },
              created_by: { id: "ou_reviewer" },
              created_time: 1_790_000_000_000,
              last_modified_by: { id: "ou_reviewer" },
              last_modified_time: 1_790_000_100_000,
            }],
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unhandled URL: ${String(url)}`);
    });

    const records = await searchTableRecords(dummyConfig, {
      fieldNames: ["人工决策"],
      automaticFields: true,
      userIdType: "open_id",
    }, { fetcher: mockFetcher });

    expect(records).toEqual([{
      record_id: "rec_decision",
      fields: { "人工决策": "APPROVE" },
      created_by: { id: "ou_reviewer" },
      created_time: 1_790_000_000_000,
      last_modified_by: { id: "ou_reviewer" },
      last_modified_time: 1_790_000_100_000,
    }]);
  });

  it("searchTableRecords 会沿 page_token 读取全部 records/search 分页", async () => {
    const mockFetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlValue = new URL(String(url));
      if (urlValue.pathname.includes("/auth/v3/tenant_access_token")) {
        return makeAuthResponse();
      }
      if (urlValue.pathname.includes("/records/search")) {
        const body = JSON.parse(init?.body as string);
        expect(body.filter).toEqual({
          conjunction: "or",
          conditions: [{ field_name: "ASIN", operator: "is", value: ["B0PAGE01"] }],
        });
        if (urlValue.searchParams.get("page_token") === null) {
          return new Response(
            JSON.stringify({
              code: 0,
              data: {
                total: 2,
                has_more: true,
                page_token: "page-2",
                items: [{ record_id: "rec_page_1", fields: { ASIN: "B0PAGE01" } }],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        expect(urlValue.searchParams.get("page_token")).toBe("page-2");
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              total: 2,
              has_more: false,
              items: [{ record_id: "rec_page_2", fields: { ASIN: "B0PAGE01" } }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unhandled URL: ${String(url)}`);
    });

    const records = await searchTableRecords(
      dummyConfig,
      {
        fieldNames: ["ASIN"],
        filter: {
          conjunction: "or",
          conditions: [{ field_name: "ASIN", operator: "is", value: ["B0PAGE01"] }],
        },
        pageSize: 1,
      },
      { fetcher: mockFetcher },
    );

    expect(records.map((record) => record.record_id)).toEqual(["rec_page_1", "rec_page_2"]);
    expect(mockFetcher).toHaveBeenCalledTimes(3); // token + two search pages
  });

  it("batchCreateRecords 和 batchUpdateRecords 正常发送", async () => {
    const mockFetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/auth/v3/tenant_access_token")) {
        return makeAuthResponse();
      }
      if (urlStr.includes("/records/batch_create")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              records: [{ record_id: "rec_created_1", fields: { ASIN: "B0NEW" } }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (urlStr.includes("/records/batch_update")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              records: [{ record_id: "rec_updated_1", fields: { ASIN: "B0EXIST" } }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unhandled URL: ${urlStr}`);
    });

    const created = await batchCreateRecords(
      dummyConfig,
      [{ fields: { ASIN: "B0NEW" } }],
      { fetcher: mockFetcher },
    );
    expect(created.length).toBe(1);
    expect(created[0].record_id).toBe("rec_created_1");

    const updated = await batchUpdateRecords(
      dummyConfig,
      [{ record_id: "rec_updated_1", fields: { ASIN: "B0EXIST" } }],
      { fetcher: mockFetcher },
    );
    expect(updated.length).toBe(1);
    expect(updated[0].record_id).toBe("rec_updated_1");
  });

  it("当飞书返回 429 速率限制时能成功重试并返回", async () => {
    let callAttempts = 0;
    const mockFetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/auth/v3/tenant_access_token")) {
        return makeAuthResponse();
      }
      if (urlStr.includes("/fields")) {
        callAttempts++;
        if (callAttempts === 1) {
          return new Response(JSON.stringify({ code: 99991400, msg: "rate limit" }), {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "x-ogw-ratelimit-reset": "0.05",
            },
          });
        }
        return new Response(
          JSON.stringify({
            code: 0,
            data: { items: [{ field_id: "f1", field_name: "ASIN", type: 1, ui_type: "Text" }] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unhandled URL: ${urlStr}`);
    });

    const fields = await listTableFields(dummyConfig, { fetcher: mockFetcher, maxRetries: 2 });
    expect(fields.length).toBe(1);
    expect(callAttempts).toBe(2);
  });
});
