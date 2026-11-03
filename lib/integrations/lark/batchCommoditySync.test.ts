import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeProductFact } from "@/lib/marketScan/__fixtures__/productFactFixture";
import { clearCachedLarkToken } from "./auth";
import {
  COMMODITY_POOL_TABLE_FIELDS,
  mapProductFactToCommodityRow,
  validateCommodityPoolFields,
} from "./commodityTableContract";
import {
  LarkCommodityPoolDestination,
  planCommoditySyncRecords,
} from "./batchCommoditySync";
import type { LarkConfig } from "./types";

const dummyConfig: LarkConfig = {
  appId: "cli_commodity_test",
  appSecret: "secret_commodity_test",
  appToken: "app_commodity_test",
  tableId: "tbl_commodity_test",
  openApiDomain: "https://open.feishu.cn",
};

const fullRemoteFields = COMMODITY_POOL_TABLE_FIELDS.map((field, index) => ({
  field_id: `fld_${index + 1}`,
  field_name: field.name,
  type: field.expectedTypes[0],
  ui_type: field.expectedTypes[0] === 2 ? "Number" : "Text",
}));

const fullRemoteFieldMeta = fullRemoteFields.map((field) => ({
  fieldId: field.field_id,
  fieldName: field.field_name,
  type: field.type,
  uiType: field.ui_type,
}));

function jsonBody(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function productFact(index: number) {
  const asin = `B0COM${String(index).padStart(5, "0")}`;
  return makeProductFact({
    asin,
    subjectKey: `amazon:US:${asin}`,
  });
}

describe("commodity table contract", () => {
  it("uses one complete field contract and preserves snapshot/estimate naming", () => {
    const validation = validateCommodityPoolFields(fullRemoteFieldMeta);
    expect(validation.isValid).toBe(true);
    expect(validation.missingWriteFields).toEqual([]);

    const row = mapProductFactToCommodityRow(productFact(1), { baseUrl: "http://localhost:3011" });
    expect(row.subjectKey).toBe("amazon:US:B0COM00001");
    expect(row["预估月销量"]).toBe(300);
    expect(row["预估FBA费"]).toBe(4.25);
    expect(row["数据来源"]).toBe("sellersprite_xlsx");
    expect(row["工作台链接"]).toContain("/source-layer?subjectKey=amazon%3AUS%3AB0COM00001");
    expect(row["研究状态"]).toBe("未研究");
    expect(row["人工决策"]).toBe("未决策");
  });

  it("0=create、1=update、>1=fail-closed，不随机选择重复行", () => {
    const candidates = [1, 2, 3].map((index) => ({
      subjectKey: productFact(index).subjectKey,
      rowFields: mapProductFactToCommodityRow(productFact(index)),
    }));
    const plan = planCommoditySyncRecords(candidates, [
      { record_id: "rec-update", fields: { subjectKey: candidates[1].subjectKey } },
      { record_id: "rec-duplicate-a", fields: { subjectKey: candidates[2].subjectKey } },
      { record_id: "rec-duplicate-b", fields: { subjectKey: [{ text: candidates[2].subjectKey }] } },
    ]);
    expect(plan.toCreate.map((item) => item.subjectKey)).toEqual([candidates[0].subjectKey]);
    expect(plan.toUpdate).toMatchObject([{ subjectKey: candidates[1].subjectKey, recordId: "rec-update" }]);
    expect(plan.duplicateSubjectKeys).toEqual([{ subjectKey: candidates[2].subjectKey, matchCount: 2 }]);
  });
});

describe("LarkCommodityPoolDestination", () => {
  beforeEach(() => clearCachedLarkToken());

  it("向 100 条商品按 50 分片写入，并为批量写请求携带 client_token", async () => {
    const createUrls: string[] = [];
    const mockFetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlString = String(url);
      if (urlString.includes("/auth/v3/tenant_access_token")) {
        return jsonBody({ code: 0, tenant_access_token: "tenant-token", expire: 7200 });
      }
      if (urlString.includes("/fields")) return jsonBody({ code: 0, data: { items: fullRemoteFields } });
      if (urlString.includes("/records/search")) return jsonBody({ code: 0, data: { items: [], total: 0 } });
      if (urlString.includes("/records/batch_create")) {
        createUrls.push(urlString);
        const body = JSON.parse(String(init?.body));
        return jsonBody({
          code: 0,
          data: {
            records: body.records.map((record: { fields: Record<string, unknown> }, index: number) => ({
              record_id: `rec-${createUrls.length}-${index}`,
              fields: record.fields,
            })),
          },
        });
      }
      throw new Error(`Unhandled URL ${urlString}`);
    });

    const result = await new LarkCommodityPoolDestination(dummyConfig, { fetcher: mockFetcher }).sync(
      Array.from({ length: 100 }, (_, index) => productFact(index + 1)),
      { requestClientToken: "11111111-1111-4111-8111-111111111111" },
    );

    expect(result.createdCount).toBe(100);
    expect(result.failedCount).toBe(0);
    expect(createUrls).toHaveLength(2);
    expect(createUrls.every((url) => /[?&]client_token=[0-9a-f-]{36}/iu.test(url))).toBe(true);
    expect(createUrls[0]).toContain("client_token=11111111-1111-4111-8111-111111111111");
  });

  it("更新已有商品时只写事实字段，不覆盖人工决策字段", async () => {
    let updateFields: Record<string, unknown> | null = null;
    const fact = productFact(101);
    const mockFetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlString = String(url);
      if (urlString.includes("/auth/v3/tenant_access_token")) return jsonBody({ code: 0, tenant_access_token: "tenant-token", expire: 7200 });
      if (urlString.includes("/fields")) return jsonBody({ code: 0, data: { items: fullRemoteFields } });
      if (urlString.includes("/records/search")) {
        return jsonBody({
          code: 0,
          data: {
            items: [{
              record_id: "rec-existing",
              fields: { subjectKey: [{ text: fact.subjectKey }], 人工决策: "可做", 决策理由: "保留" },
            }],
          },
        });
      }
      if (urlString.includes("/records/batch_update")) {
        const body = JSON.parse(String(init?.body));
        updateFields = body.records[0].fields;
        return jsonBody({ code: 0, data: { records: body.records } });
      }
      throw new Error(`Unhandled URL ${urlString}`);
    });

    const result = await new LarkCommodityPoolDestination(dummyConfig, { fetcher: mockFetcher }).sync([fact]);
    expect(result.updatedCount).toBe(1);
    expect(updateFields).not.toBeNull();
    expect(updateFields).not.toHaveProperty("人工决策");
    expect(updateFields).not.toHaveProperty("决策理由");
    expect(updateFields).toHaveProperty("subjectKey", fact.subjectKey);
  });

  it("批量 API 返回短响应时不虚报成功", async () => {
    const mockFetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlString = String(url);
      if (urlString.includes("/auth/v3/tenant_access_token")) return jsonBody({ code: 0, tenant_access_token: "tenant-token", expire: 7200 });
      if (urlString.includes("/fields")) return jsonBody({ code: 0, data: { items: fullRemoteFields } });
      if (urlString.includes("/records/search")) return jsonBody({ code: 0, data: { items: [], total: 0 } });
      if (urlString.includes("/records/batch_create")) return jsonBody({ code: 0, data: { records: [] } });
      throw new Error(`Unhandled URL ${urlString}`);
    });
    const result = await new LarkCommodityPoolDestination(dummyConfig, { fetcher: mockFetcher }).sync([productFact(102)]);
    expect(result.createdCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.results[0].errorCode).toBe("BATCH_CREATE_FAILED");
  });
});
