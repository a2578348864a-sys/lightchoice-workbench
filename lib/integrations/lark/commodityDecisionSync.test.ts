import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearCachedLarkToken } from "./auth";
import { COMMODITY_POOL_TABLE_FIELDS } from "./commodityTableContract";
import {
  LarkCommodityPoolDestination,
  planCommodityDecisionSyncRecords,
  syncCommodityDecisions,
} from "./batchCommoditySync";
import type { LarkConfig } from "./types";

const config: LarkConfig = {
  appId: "cli_decision_test",
  appSecret: "secret_decision_test",
  appToken: "app_decision_test",
  tableId: "tbl_decision_test",
  openApiDomain: "https://open.feishu.cn",
};

const remoteFields = COMMODITY_POOL_TABLE_FIELDS.map((field, index) => ({
  field_id: `field-${index}`,
  field_name: field.name,
  type: field.expectedTypes[0],
  ui_type: field.expectedTypes[0] === 2 ? "Number" : "Text",
}));

const input = {
  subjectKey: "amazon:US:B0DEC00001",
  decision: {
    researchStatus: "已完成" as const,
    decision: "可做" as const,
    reason: "证据满足当前立项门槛。",
    nextAction: "进入小单验证",
    decidedAt: "2026-09-24T00:00:00.000Z",
    reportHash: "a".repeat(64),
    syncedAt: "2026-09-24T00:00:01.000Z",
  },
};

function jsonBody(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("commodity decision writeback", () => {
  beforeEach(() => clearCachedLarkToken());

  it("0 条匹配时创建，1 条匹配时只更新决策字段", async () => {
    const createdFields: Record<string, unknown>[] = [];
    const updatedFields: Record<string, unknown>[] = [];
    let existing = false;
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.includes("/auth/v3/tenant_access_token")) return jsonBody({ code: 0, tenant_access_token: "tenant", expire: 7200 });
      if (value.includes("/fields")) return jsonBody({ code: 0, data: { items: remoteFields } });
      if (value.includes("/records/search")) {
        return jsonBody({
          code: 0,
          data: {
            items: existing ? [{ record_id: "rec-existing", fields: { subjectKey: [{ text: input.subjectKey }] } }] : [],
          },
        });
      }
      if (value.includes("/records/batch_create")) {
        const body = JSON.parse(String(init?.body)) as { records: { fields: Record<string, unknown> }[] };
        createdFields.push(body.records[0].fields);
        existing = true;
        return jsonBody({ code: 0, data: { records: [{ record_id: "rec-created", fields: body.records[0].fields }] } });
      }
      if (value.includes("/records/batch_update")) {
        const body = JSON.parse(String(init?.body)) as { records: { fields: Record<string, unknown> }[] };
        updatedFields.push(body.records[0].fields);
        return jsonBody({ code: 0, data: { records: body.records } });
      }
      throw new Error(`Unhandled URL ${value}`);
    });

    const destination = new LarkCommodityPoolDestination(config, { fetcher });
    const first = await destination.syncDecisions([input], {
      requestClientToken: "11111111-1111-4111-8111-111111111111",
    });
    expect(first.createdCount).toBe(1);
    expect(createdFields[0]).toMatchObject({
      subjectKey: input.subjectKey,
      "研究状态": "已完成",
      "人工决策": "可做",
    });

    const second = await destination.syncDecisions([input]);
    expect(second.updatedCount).toBe(1);
    expect(updatedFields[0]).toEqual({
      "研究状态": "已完成",
      "人工决策": "可做",
      "决策理由": "证据满足当前立项门槛。",
      "下一步动作": "进入小单验证",
      "决策时间": "2026-09-24T00:00:00.000Z",
      "Report Hash": "a".repeat(64),
      "最近同步时间": "2026-09-24T00:00:01.000Z",
    });
    expect(updatedFields[0]).not.toHaveProperty("商品标题");
    expect(updatedFields[0]).not.toHaveProperty("subjectKey");
  });

  it(">1 条匹配时 fail-closed，不发起任何写入", async () => {
    let writeCalls = 0;
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value.includes("/auth/v3/tenant_access_token")) return jsonBody({ code: 0, tenant_access_token: "tenant", expire: 7200 });
      if (value.includes("/fields")) return jsonBody({ code: 0, data: { items: remoteFields } });
      if (value.includes("/records/search")) {
        return jsonBody({
          code: 0,
          data: {
            items: [
              { record_id: "rec-1", fields: { subjectKey: input.subjectKey } },
              { record_id: "rec-2", fields: { subjectKey: [{ text: input.subjectKey }] } },
            ],
          },
        });
      }
      if (value.includes("/records/batch_create") || value.includes("/records/batch_update")) {
        writeCalls++;
        return jsonBody({ code: 0, data: { records: [] } });
      }
      throw new Error(`Unhandled URL ${value}`);
    });

    const result = await syncCommodityDecisions([input], { config, clientOptions: { fetcher } });
    expect(result.conflictCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.results[0]).toMatchObject({
      subjectKey: input.subjectKey,
      action: "conflict",
      errorCode: "DUPLICATE_SUBJECT_KEY_RECORDS",
    });
    expect(writeCalls).toBe(0);
  });

  it("纯计划函数保持 0/1/>1 分支且不依赖网络", () => {
    const candidates = [{ subjectKey: input.subjectKey, rowFields: { subjectKey: input.subjectKey } }];
    expect(planCommodityDecisionSyncRecords(candidates, [])).toMatchObject({
      toCreate: [{ subjectKey: input.subjectKey }],
      toUpdate: [],
      duplicateSubjectKeys: [],
    });
    expect(planCommodityDecisionSyncRecords(candidates, [
      { record_id: "rec-1", fields: { subjectKey: input.subjectKey } },
    ])).toMatchObject({
      toCreate: [],
      toUpdate: [{ subjectKey: input.subjectKey, recordId: "rec-1" }],
    });
  });
});
