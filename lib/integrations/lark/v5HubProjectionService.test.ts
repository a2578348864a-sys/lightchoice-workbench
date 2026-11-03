import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listTableFields: vi.fn(),
  searchTableRecords: vi.fn(),
  batchCreateRecords: vi.fn(),
  batchUpdateRecords: vi.fn(),
  LarkApiError: class extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status = 500,
      public readonly larkCode?: number,
    ) { super(message); }
  },
}));

vi.mock("./baseClient", () => ({
  LarkApiError: mocks.LarkApiError,
  listTableFields: mocks.listTableFields,
  searchTableRecords: mocks.searchTableRecords,
  batchCreateRecords: mocks.batchCreateRecords,
  batchUpdateRecords: mocks.batchUpdateRecords,
  readBitableTextValue: (value: unknown) => typeof value === "string" ? value : "",
}));

import { FEISHU_FIELD_TYPE_BY_KIND, V5_HUB_TABLES } from "./v5HubSchema";
import {
  projectV5HubRecord,
  projectV5HubRecords,
  reconcileV5HubRecordsReadOnly,
  v5HubLogicalKey,
  V5_HUB_AUTHORIZED_TEST_BASE_ID,
  V5HubProjectionError,
} from "./v5HubProjectionService";

const config = {
  appId: "test-app",
  appSecret: "test-secret",
  appToken: V5_HUB_AUTHORIZED_TEST_BASE_ID,
  tableId: "legacy-table",
  openApiDomain: "https://open.feishu.cn",
};

function remoteFields(tableId: "T01" | "T02" | "T03" | "T04" | "T05" | "T06") {
  const table = V5_HUB_TABLES.find((candidate) => candidate.id === tableId)!;
  return [
    ...table.fields.map((field, index) => ({
      fieldId: `fld-${index}`,
      fieldName: field.displayName,
      type: FEISHU_FIELD_TYPE_BY_KIND[field.kind],
      uiType: field.kind,
      isPrimary: false,
    })),
    { fieldId: "fld-primary", fieldName: "记录名称", type: 1, uiType: "Text", isPrimary: true },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listTableFields.mockImplementation(async () => remoteFields("T02"));
});

describe("safe V5 Test Base projection service", () => {
  it("recovers only an exact T04 full-payload match and never writes during reconciliation", async () => {
    mocks.listTableFields.mockImplementation(async () => remoteFields("T04"));
    const fields = {
      "主体键": "amazon:US:B000000001", "关键词": "test phrase", "销售站点": "US",
      "数据来源": "SellerSprite", "统计周期": "月度（2026-09）", "搜索量": 42,
    };
    const logicalKey = v5HubLogicalKey("T04", fields);
    mocks.searchTableRecords.mockResolvedValueOnce([{
      record_id: "rec-t04-existing",
      fields: { ...fields, "记录名称": "关键词 amazon:US:B000000001" },
    }]);

    const result = await reconcileV5HubRecordsReadOnly({ config, tableId: "T04", rows: [{ logicalKey, fields }] });
    expect(result).toEqual([{ status: "UNCHANGED", recordId: "rec-t04-existing" }]);
    expect(mocks.batchCreateRecords).not.toHaveBeenCalled();
    expect(mocks.batchUpdateRecords).not.toHaveBeenCalled();
  });

  it("does not recover a T04 receipt when any exact key is absent", async () => {
    mocks.listTableFields.mockImplementation(async () => remoteFields("T04"));
    const fields = {
      "主体键": "amazon:US:B000000001", "关键词": "missing phrase", "销售站点": "US",
      "数据来源": "SellerSprite", "统计周期": "月度（2026-09）", "搜索量": 42,
    };
    mocks.searchTableRecords.mockResolvedValueOnce([]);

    const result = await reconcileV5HubRecordsReadOnly({
      config,
      tableId: "T04",
      rows: [{ logicalKey: v5HubLogicalKey("T04", fields), fields }],
    });
    expect(result).toBeNull();
    expect(mocks.batchCreateRecords).not.toHaveBeenCalled();
    expect(mocks.batchUpdateRecords).not.toHaveBeenCalled();
  });

  it("does not recover a T04 receipt from duplicate keys or mismatched payloads", async () => {
    mocks.listTableFields.mockImplementation(async () => remoteFields("T04"));
    const fields = {
      "主体键": "amazon:US:B000000001", "关键词": "conflicted phrase", "销售站点": "US",
      "数据来源": "SellerSprite", "统计周期": "月度（2026-09）", "搜索量": 42,
    };
    const row = { logicalKey: v5HubLogicalKey("T04", fields), fields };

    mocks.searchTableRecords.mockResolvedValueOnce([
      { record_id: "rec-1", fields: { ...fields, "记录名称": "关键词 amazon:US:B000000001" } },
      { record_id: "rec-2", fields: { ...fields, "记录名称": "关键词 amazon:US:B000000001" } },
    ]);
    expect(await reconcileV5HubRecordsReadOnly({ config, tableId: "T04", rows: [row] })).toBeNull();

    mocks.searchTableRecords.mockResolvedValueOnce([{
      record_id: "rec-mismatch",
      fields: { ...fields, "搜索量": 43, "记录名称": "关键词 amazon:US:B000000001" },
    }]);
    expect(await reconcileV5HubRecordsReadOnly({ config, tableId: "T04", rows: [row] })).toBeNull();
    expect(mocks.batchCreateRecords).not.toHaveBeenCalled();
    expect(mocks.batchUpdateRecords).not.toHaveBeenCalled();
  });

  it("creates on zero matches and verifies remote readback", async () => {
    const fields = { "研究包哈希": "hash-1", ASIN: "B000000001", "修订版本": 3 };
    mocks.searchTableRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ record_id: "rec-1", fields: { ...fields, "记录名称": "研究包 B000000001 r3" } }]);
    mocks.batchCreateRecords.mockResolvedValueOnce([{ record_id: "rec-1", fields }]);

    const result = await projectV5HubRecord({ config, tableId: "T02", logicalKey: "hash-1", fields });
    expect(result).toEqual({ status: "CREATED", recordId: "rec-1" });
    expect(mocks.batchCreateRecords).toHaveBeenCalledOnce();
    expect(mocks.batchCreateRecords.mock.calls[0]?.[2]).toMatchObject({ maxRetries: 0 });
    expect(mocks.batchCreateRecords.mock.calls[0]?.[2]?.clientToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("returns UNCHANGED for an exact immutable T02 match without writing", async () => {
    const fields = {
      "研究包哈希": "hash-existing", ASIN: "B000000001", "修订版本": 3,
      "记录名称": "研究包 B000000001 r3",
    };
    mocks.searchTableRecords.mockResolvedValueOnce([{ record_id: "rec-existing", fields }]);

    const result = await projectV5HubRecord({
      config, tableId: "T02", logicalKey: "hash-existing", fields: {
        "研究包哈希": "hash-existing", ASIN: "B000000001", "修订版本": 3,
      },
    });

    expect(result).toEqual({ status: "UNCHANGED", recordId: "rec-existing" });
    expect(mocks.batchCreateRecords).not.toHaveBeenCalled();
    expect(mocks.batchUpdateRecords).not.toHaveBeenCalled();
    expect(mocks.searchTableRecords.mock.calls[0]?.[1].fieldNames).toContain("ASIN");
  });

  it("updates the single mutable T01 match, but never overwrites an immutable T02 Packet", async () => {
    const t01Fields = { "主体键": "amazon:US:B000000002", ASIN: "B000000002", "商品标题": "new", "记录名称": "商品 B000000002" };
    mocks.listTableFields.mockImplementation(async () => remoteFields("T01"));
    mocks.searchTableRecords
      .mockResolvedValueOnce([{ record_id: "rec-product", fields: { "主体键": "amazon:US:B000000002", ASIN: "B000000002", "商品标题": "old" } }])
      .mockResolvedValueOnce([{ record_id: "rec-product", fields: t01Fields }]);
    mocks.batchUpdateRecords.mockResolvedValueOnce([{ record_id: "rec-product", fields: t01Fields }]);
    const updated = await projectV5HubRecord({ config, tableId: "T01", logicalKey: "amazon:US:B000000002", fields: { "主体键": "amazon:US:B000000002", ASIN: "B000000002", "商品标题": "new" } });
    expect(updated).toEqual({ status: "UPDATED", recordId: "rec-product" });

    mocks.listTableFields.mockImplementation(async () => remoteFields("T02"));
    mocks.searchTableRecords.mockResolvedValueOnce([{ record_id: "rec-packet", fields: { "研究包哈希": "hash-1", ASIN: "B000000001" } }]);
    await expect(projectV5HubRecord({ config, tableId: "T02", logicalKey: "hash-1", fields: { "研究包哈希": "hash-1", ASIN: "B000000001" } }))
      .rejects.toMatchObject({ code: "V5_HUB_IMMUTABLE_PACKET_CONFLICT" });
    expect(mocks.batchUpdateRecords).toHaveBeenCalledOnce();
  });

  it("fails closed for duplicate keys and any Base other than the fixed Test Base", async () => {
    mocks.searchTableRecords.mockResolvedValueOnce([
      { record_id: "rec-a", fields: {} }, { record_id: "rec-b", fields: {} },
    ]);
    await expect(projectV5HubRecord({ config, tableId: "T02", logicalKey: "hash-1", fields: { "研究包哈希": "hash-1" } }))
      .rejects.toMatchObject({ code: "V5_HUB_DUPLICATE_LOGICAL_KEY" });
    await expect(projectV5HubRecord({ config: { ...config, appToken: "other-base" }, tableId: "T02", logicalKey: "hash-1", fields: { "研究包哈希": "hash-1" } }))
      .rejects.toThrowError(new V5HubProjectionError("V5_HUB_WRONG_BASE"));
    expect(mocks.batchCreateRecords).not.toHaveBeenCalled();
  });

  it("preserves a safe Feishu rejection code instead of misreporting it as an unknown outcome", async () => {
    mocks.searchTableRecords.mockResolvedValueOnce([]);
    mocks.batchCreateRecords.mockRejectedValueOnce(new mocks.LarkApiError(
      "lark_api_failed_1254004", "redacted upstream message", 400, 1254004,
    ));

    await expect(projectV5HubRecord({
      config, tableId: "T02", logicalKey: "hash-1", fields: { "研究包哈希": "hash-1" },
    })).rejects.toMatchObject({
      code: "V5_HUB_API_REJECTED",
      upstreamCode: "lark_api_failed_1254004",
      upstreamStatus: 400,
      larkCode: 1254004,
    });
  });

  it("preflights and writes 51 rows in deterministic 50+1 batches, then reads back every key", async () => {
    const rows = Array.from({ length: 51 }, (_, index) => ({
      logicalKey: `hash-${index}`,
      fields: { "研究包哈希": `hash-${index}`, ASIN: `B000000${String(index).padStart(3, "0")}`, "修订版本": 1 },
    }));
    let preflightSearches = 0;
    const createdFields = new Map<string, Record<string, unknown>>();
    mocks.searchTableRecords.mockImplementation(async (_config, request) => {
      const key = request.filter.conditions[0]?.value[0] as string;
      if (preflightSearches < rows.length) {
        preflightSearches += 1;
        return [];
      }
      const fields = createdFields.get(key);
      return fields ? [{ record_id: `rec-${key}`, fields }] : [];
    });
    mocks.batchCreateRecords.mockImplementation(async (_config, records: readonly { fields: Record<string, unknown> }[]) => {
      for (const record of records) createdFields.set(record.fields["研究包哈希"] as string, record.fields);
      return records.map((record, index) => ({ record_id: `rec-${index}`, fields: record.fields }));
    });

    const result = await projectV5HubRecords({ config, tableId: "T02", rows });

    expect(result).toHaveLength(51);
    expect(result.every((item) => item.status === "CREATED")).toBe(true);
    expect(mocks.batchCreateRecords.mock.calls.map((call) => call[1].length)).toEqual([50, 1]);
    expect(mocks.searchTableRecords).toHaveBeenCalledTimes(102);
    expect(mocks.batchCreateRecords.mock.calls.every((call) => call[2]?.maxRetries === 0)).toBe(true);
  });

  it("supports a composite T06 key with exact all-field readback and immutable conflict protection", async () => {
    const fields = {
      "监控目标 ID": "watch-target-1",
      "监控运行 ID": "monitor-run-1",
      "事件键": "event-hash-1",
      "主体键": "amazon:US:B000000001",
      "运行时间": 1_790_000_000_000,
      "事件状态": "SUCCEEDED",
    };
    const logicalKey = v5HubLogicalKey("T06", fields);
    expect(logicalKey).toBe(JSON.stringify([
      ["监控目标 ID", "watch-target-1"],
      ["监控运行 ID", "monitor-run-1"],
      ["事件键", "event-hash-1"],
    ]));
    mocks.listTableFields.mockImplementation(async () => remoteFields("T06"));
    mocks.searchTableRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ record_id: "rec-monitor-1", fields: { ...fields, "记录名称": "监控事件 amazon:US:B000000001" } }]);
    mocks.batchCreateRecords.mockResolvedValueOnce([{ record_id: "rec-monitor-1", fields }]);

    const created = await projectV5HubRecord({ config, tableId: "T06", logicalKey, fields });
    expect(created).toEqual({ status: "CREATED", recordId: "rec-monitor-1" });
    expect(mocks.searchTableRecords.mock.calls[0]?.[1].filter?.conditions).toEqual([
      { field_name: "监控目标 ID", operator: "is", value: ["watch-target-1"] },
      { field_name: "监控运行 ID", operator: "is", value: ["monitor-run-1"] },
      { field_name: "事件键", operator: "is", value: ["event-hash-1"] },
    ]);

    mocks.searchTableRecords.mockResolvedValueOnce([{ record_id: "rec-monitor-1", fields: { ...fields, "记录名称": "监控事件 amazon:US:B000000001" } }]);
    await expect(projectV5HubRecord({
      config,
      tableId: "T06",
      logicalKey,
      fields: { ...fields, "事件状态": "FAILED" },
    })).rejects.toMatchObject({ code: "V5_HUB_IMMUTABLE_RECORD_CONFLICT" });
    expect(mocks.batchUpdateRecords).not.toHaveBeenCalled();
  });

  it("updates only the local Human Decision mirror on the same immutable T05 concept revision", async () => {
    mocks.listTableFields.mockImplementation(async () => remoteFields("T05"));
    const sourceFields = {
      "概念 ID": "pcv5_test",
      "主体键": "amazon:US:B000000001",
      "修订版本": 2,
      "事实哈希": "a".repeat(64),
      "预期研究包哈希": "b".repeat(64),
    };
    const recordName = "产品概念 amazon:US:B000000001";
    const existingFields = { ...sourceFields, "人工决策状态": "UNREVIEWED", "记录名称": recordName };
    const nextFields = { ...sourceFields, "人工决策状态": "APPROVE", "记录名称": recordName };
    mocks.searchTableRecords.mockResolvedValueOnce([{ record_id: "rec-concept", fields: existingFields }])
      .mockResolvedValueOnce([{ record_id: "rec-concept", fields: nextFields }]);
    mocks.batchUpdateRecords.mockResolvedValueOnce([{ record_id: "rec-concept", fields: nextFields }]);

    const result = await projectV5HubRecord({
      config,
      tableId: "T05",
      logicalKey: v5HubLogicalKey("T05", sourceFields),
      fields: { ...sourceFields, "人工决策状态": "APPROVE" },
    });
    expect(result).toEqual({ status: "UPDATED", recordId: "rec-concept" });
    expect(mocks.batchUpdateRecords).toHaveBeenCalledOnce();

    mocks.searchTableRecords.mockResolvedValueOnce([{ record_id: "rec-concept", fields: nextFields }]);
    await expect(projectV5HubRecord({
      config,
      tableId: "T05",
      logicalKey: v5HubLogicalKey("T05", sourceFields),
      fields: { ...sourceFields, "事实哈希": "c".repeat(64), "人工决策状态": "DROP" },
    })).rejects.toMatchObject({ code: "V5_HUB_IMMUTABLE_RECORD_CONFLICT" });
  });

  it("rejects duplicate input keys before any remote write", async () => {
    const row = { logicalKey: "same", fields: { "研究包哈希": "same" } };
    await expect(projectV5HubRecords({ config, tableId: "T02", rows: [row, row] }))
      .rejects.toMatchObject({ code: "V5_HUB_DUPLICATE_LOGICAL_KEY" });
    expect(mocks.batchCreateRecords).not.toHaveBeenCalled();
    expect(mocks.batchUpdateRecords).not.toHaveBeenCalled();
  });
});
