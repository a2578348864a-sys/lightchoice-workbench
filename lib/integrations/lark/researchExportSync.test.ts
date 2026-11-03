import { describe, it, expect, vi, beforeEach } from "vitest";
import { LarkBaseDestination } from "./researchExportSync";
import { clearCachedLarkToken } from "./auth";
import type { LarkConfig } from "./types";
import type { ResearchExportRecord } from "@/lib/research/researchContracts";

describe("LarkBaseDestination Sync & Idempotency", () => {
  const dummyConfig: LarkConfig = {
    appId: "cli_sync_test",
    appSecret: "sec_sync_test",
    appToken: "app_sync_test",
    tableId: "tbl_sync_test",
    openApiDomain: "https://open.feishu.cn",
  };

  const createDummyRecord = (asin: string, taskId: string): ResearchExportRecord => ({
    taskId,
    candidateId: `cand-${asin}`,
    product: {
      asin,
      title: `Product ${asin}`,
      image: `https://img.com/${asin}.jpg`,
      category: "Home",
    },
    market: {
      price: { amount: 19.99, currency: "USD" },
      sales: 500,
      bsr: 300,
    },
    research: {
      summary: "优质标的",
      priority: "P2",
      opportunity: "机会良好",
      risks: [],
      unverifiedAssumptions: [],
    },
    humanDecision: {
      status: "continue",
      nextAction: "continue_research",
      notes: "人工复核通过",
      reviewedReportHash: `hash-${asin}`,
      reviewStale: false,
    },
    evidence: {
      reportHash: `hash-${asin}`,
      generatedAt: "2026-09-19T10:00:00.000Z",
      citationCount: 5,
      factCitationCount: 5,
      narrativeCitationCount: 0,
      unverifiedAssumptionCount: 0,
    },
  });

  beforeEach(() => {
    clearCachedLarkToken();
  });

  /** 与 BITABLE_V1_FIELDS 一致的 21 字段远端表快照。 */
  const FULL_CONTRACT_SPEC: Array<[string, number, string]> = [
    ["ASIN", 1, "Text"],
    ["商品标题", 1, "Text"],
    ["商品图片", 1, "Text"],
    ["类目", 1, "Text"],
    ["研究链接", 1, "Text"],
    ["当前售价", 2, "Number"],
    ["售价币种", 1, "Text"],
    ["预估月销量", 2, "Number"],
    ["BSR", 2, "Number"],
    ["研究优先级", 3, "SingleSelect"],
    ["核心机会", 1, "Text"],
    ["核心风险", 1, "Text"],
    ["AI研究摘要", 1, "Text"],
    ["人工状态", 3, "SingleSelect"],
    ["下一步动作", 3, "SingleSelect"],
    ["人工备注", 1, "Text"],
    ["Task ID", 1, "Text"],
    ["Candidate ID", 1, "Text"],
    ["Report Hash", 1, "Text"],
    ["报告生成时间", 1, "Text"],
    ["最近同步时间", 1, "Text"],
  ];
  const toRemoteFields = (spec: Array<[string, number, string]>) =>
    spec.map(([field_name, type, ui_type], index) => ({
      field_id: `f${index + 1}`,
      field_name,
      type,
      ui_type,
    }));

  const validTableFields = toRemoteFields(FULL_CONTRACT_SPEC);

  it("当环境未配置时，sync 返回 LIVE_SYNC_BLOCKED_BY_CREDENTIALS 且安全拦截", async () => {
    // 实例化时不传 config，且环境变量为空
    const originalEnv = { ...process.env };
    delete process.env.LARK_APP_ID;
    delete process.env.FEISHU_APP_ID;

    try {
      const destination = new LarkBaseDestination();
      const result = await destination.sync([createDummyRecord("B0TEST01", "t1")]);

      expect(result.blockedReason).toBe("LIVE_SYNC_BLOCKED_BY_CREDENTIALS");
      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.results[0].errorCode).toBe("LIVE_SYNC_BLOCKED_BY_CREDENTIALS");
    } finally {
      process.env = originalEnv;
    }
  });

  it("幂等写入验证：新 ASIN 执行 create，已有 ASIN 执行 update，绝不产生重复记录", async () => {
    // 模拟飞书现有数据状态
    const remoteTableDb = new Map<string, { record_id: string; fields: Record<string, unknown> }>();
    // 初始表中已存在 B0EXIST01
    remoteTableDb.set("B0EXIST01", {
      record_id: "rec_exist_01",
      fields: { ASIN: "B0EXIST01", 商品标题: "旧标题" },
    });

    let createCallCount = 0;
    let updateCallCount = 0;

    const mockFetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);

      // Auth
      if (urlStr.includes("/auth/v3/tenant_access_token")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-mock", expire: 7200 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Fields
      if (urlStr.includes("/fields?page_size=100")) {
        return new Response(JSON.stringify({ code: 0, data: { items: validTableFields } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Search
      if (urlStr.includes("/records/search")) {
        const body = JSON.parse(init?.body as string);
        const searchedItems: { record_id: string; fields: Record<string, unknown> }[] = [];
        for (const item of remoteTableDb.values()) {
          searchedItems.push(item);
        }
        return new Response(JSON.stringify({ code: 0, data: { items: searchedItems, total: searchedItems.length } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Batch Create
      if (urlStr.includes("/records/batch_create")) {
        createCallCount++;
        const body = JSON.parse(init?.body as string);
        const createdResponses = body.records.map((r: { fields: Record<string, unknown> }, idx: number) => {
          const recId = `rec_new_${Date.now()}_${idx}`;
          remoteTableDb.set(r.fields.ASIN as string, { record_id: recId, fields: r.fields });
          return { record_id: recId, fields: r.fields };
        });
        return new Response(JSON.stringify({ code: 0, data: { records: createdResponses } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Batch Update
      if (urlStr.includes("/records/batch_update")) {
        updateCallCount++;
        const body = JSON.parse(init?.body as string);
        body.records.forEach((r: { record_id: string; fields: Record<string, unknown> }) => {
          const asin = r.fields.ASIN as string;
          remoteTableDb.set(asin, { record_id: r.record_id, fields: r.fields });
        });
        return new Response(JSON.stringify({ code: 0, data: { records: body.records } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      throw new Error(`Unhandled URL in mock: ${urlStr}`);
    });

    const destination = new LarkBaseDestination(dummyConfig, { fetcher: mockFetcher });

    const recordsToSync = [
      createDummyRecord("B0NEW001", "task-1"),  // 新商品 -> 应该 create
      createDummyRecord("B0EXIST01", "task-2"), // 已有商品 -> 应该 update
    ];

    // 第一次同步：1 新增, 1 更新
    const result1 = await destination.sync(recordsToSync);
    expect(result1.created).toBe(1);
    expect(result1.updated).toBe(1);
    expect(result1.failed).toBe(0);
    expect(createCallCount).toBe(1);
    expect(updateCallCount).toBe(1);

    // 第二次同步完全相同的记录：此时 B0NEW001 已经存在，因此两个都应该 update，零新增！
    const result2 = await destination.sync(recordsToSync);
    expect(result2.created).toBe(0);
    expect(result2.updated).toBe(2);
    expect(result2.failed).toBe(0);
    // 远端表中总记录数仍然是 2（B0EXIST01 与 B0NEW001），绝对没有产生重复行！
    expect(remoteTableDb.size).toBe(2);
  });

  const tokenBody = () =>
    new Response(JSON.stringify({ code: 0, tenant_access_token: "t-mock", expire: 7200 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const jsonBody = (data: unknown) =>
    new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });

  it("Case B：必须字段齐全但缺 1 个写入字段时，Preflight 不可写且 sync 零写入", async () => {
    let writeCalls = 0;
    const missingOne = toRemoteFields(FULL_CONTRACT_SPEC.filter(([name]) => name !== "预估月销量"));

    const mockFetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/auth/v3/tenant_access_token")) return tokenBody();
      if (urlStr.includes("/fields?page_size=100")) return jsonBody({ code: 0, data: { items: missingOne } });
      if (urlStr.includes("/records/search")) return jsonBody({ code: 0, data: { items: [] } });
      if (urlStr.includes("/records/batch_create") || urlStr.includes("/records/batch_update")) {
        writeCalls++;
        return jsonBody({ code: 0, data: { records: [] } });
      }
      throw new Error(`Unhandled URL in mock: ${urlStr}`);
    });

    const destination = new LarkBaseDestination(dummyConfig, { fetcher: mockFetcher });

    const preflight = await destination.preflight();
    expect(preflight.connected).toBe(true);
    expect(preflight.writable).toBe(false);
    // 必须字段一个都不缺 —— 旧实现会在这里假绿
    expect(preflight.missingFields).toEqual([]);
    expect(preflight.missingOptionalFields).toContain("预估月销量");
    expect(preflight.missingWriteFields).toContain("预估月销量");

    const result = await destination.sync([createDummyRecord("B0OPT01", "t-opt")]);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(1);
    // 零写入：没有任何 batch_create / batch_update 被调用
    expect(writeCalls).toBe(0);
  });

  it("Case C：字段类型不兼容时，Preflight 不可写且 sync 零写入", async () => {
    let writeCalls = 0;
    const wrongType = toRemoteFields(FULL_CONTRACT_SPEC).map((field) =>
      field.field_name === "BSR" ? { ...field, type: 1, ui_type: "Text" } : field,
    );

    const mockFetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/auth/v3/tenant_access_token")) return tokenBody();
      if (urlStr.includes("/fields?page_size=100")) return jsonBody({ code: 0, data: { items: wrongType } });
      if (urlStr.includes("/records/search")) return jsonBody({ code: 0, data: { items: [] } });
      if (urlStr.includes("/records/batch_create") || urlStr.includes("/records/batch_update")) {
        writeCalls++;
        return jsonBody({ code: 0, data: { records: [] } });
      }
      throw new Error(`Unhandled URL in mock: ${urlStr}`);
    });

    const destination = new LarkBaseDestination(dummyConfig, { fetcher: mockFetcher });
    const preflight = await destination.preflight();
    expect(preflight.writable).toBe(false);
    expect(preflight.missingWriteFields).toEqual([]);
    expect(preflight.incompatibleFields).toHaveLength(1);
    expect(preflight.incompatibleFields[0].fieldName).toBe("BSR");

    const result = await destination.sync([createDummyRecord("B0TYPE01", "t-type")]);
    expect(result.failed).toBe(1);
    expect(writeCalls).toBe(0);
  });

  it("Case D：Base/Table 不可达时 fail closed，不写入任何记录", async () => {
    let batchCalls = 0;
    let fieldProbeCalls = 0;
    const mockFetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/auth/v3/tenant_access_token")) return tokenBody();
      if (urlStr.includes("/records/batch_create") || urlStr.includes("/records/batch_update")) {
        batchCalls++;
        return jsonBody({ code: 0, data: { records: [] } });
      }
      if (urlStr.includes("/fields")) {
        fieldProbeCalls++;
        return new Response(JSON.stringify({ code: 1254005, msg: "TableIdNotFound" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unhandled URL in mock: ${urlStr}`);
    });

    const destination = new LarkBaseDestination(dummyConfig, { fetcher: mockFetcher });

    const preflight = await destination.preflight();
    expect(preflight.configured).toBe(true);
    expect(preflight.connected).toBe(false);
    expect(preflight.baseAccessible).toBe(false);
    expect(preflight.tableAccessible).toBe(false);
    expect(preflight.writable).toBe(false);
    expect(preflight.missingWriteFields).toEqual([]);

    const result = await destination.sync([createDummyRecord("B0DOWN01", "t-down")]);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(1);
    // 只发生字段探测（显式 preflight 1 次 + sync 内部 preflight 1 次），零 batch 写入
    expect(fieldProbeCalls).toBe(2);
    expect(batchCalls).toBe(0);
  });

  it("Case F（真实幂等回归）：飞书文本字段以 [{text}] 数组回读时，已有 ASIN 必须走 update", async () => {
    // 真实 Base 的回读形态：文本字段是文本段数组，而不是 plain string
    const remoteTableDb = new Map<string, { record_id: string; fields: Record<string, unknown> }>();
    remoteTableDb.set("B0ARRAY01", {
      record_id: "rec_array_01",
      fields: {
        ASIN: [{ text: "B0ARRAY01", type: "text" }],
        商品标题: [{ text: "旧标题", type: "text" }],
      },
    });

    let createCalls = 0;
    let updateCalls = 0;

    const mockFetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/auth/v3/tenant_access_token")) return tokenBody();
      if (urlStr.includes("/fields?page_size=100")) return jsonBody({ code: 0, data: { items: validTableFields } });
      if (urlStr.includes("/records/search")) {
        return jsonBody({ code: 0, data: { items: [...remoteTableDb.values()], total: remoteTableDb.size } });
      }
      if (urlStr.includes("/records/batch_create")) {
        createCalls++;
        const body = JSON.parse(init?.body as string);
        const records = body.records.map((r: { fields: Record<string, unknown> }, idx: number) => {
          const id = `rec_new_${idx}`;
          remoteTableDb.set(r.fields.ASIN as string, { record_id: id, fields: r.fields });
          return { record_id: id, fields: r.fields };
        });
        return jsonBody({ code: 0, data: { records } });
      }
      if (urlStr.includes("/records/batch_update")) {
        updateCalls++;
        const body = JSON.parse(init?.body as string);
        return jsonBody({ code: 0, data: { records: body.records } });
      }
      throw new Error(`Unhandled URL in mock: ${urlStr}`);
    });

    const destination = new LarkBaseDestination(dummyConfig, { fetcher: mockFetcher });
    const result = await destination.sync([createDummyRecord("B0ARRAY01", "t-array")]);

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.results[0].action).toBe("updated");
    expect(result.results[0].recordId).toBe("rec_array_01");
    expect(createCalls).toBe(0);
    expect(updateCalls).toBe(1);
    // 远端仍是 1 条，没有产生重复
    expect(remoteTableDb.size).toBe(1);
  });

  it("Case G：同一 ASIN 存在多条记录时必须 duplicate fail-closed，禁止 create/update", async () => {
    let createCalls = 0;
    let updateCalls = 0;
    const mockFetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/auth/v3/tenant_access_token")) return tokenBody();
      if (urlStr.includes("/fields?page_size=100")) {
        return jsonBody({ code: 0, data: { items: validTableFields } });
      }
      if (urlStr.includes("/records/search")) {
        return jsonBody({
          code: 0,
          data: {
            total: 2,
            has_more: false,
            items: [
              { record_id: "rec_duplicate_1", fields: { ASIN: [{ text: "B0DUP01", type: "text" }] } },
              { record_id: "rec_duplicate_2", fields: { ASIN: [{ text: "B0DUP01", type: "text" }] } },
            ],
          },
        });
      }
      if (urlStr.includes("/records/batch_create")) {
        createCalls++;
        return jsonBody({ code: 0, data: { records: [] } });
      }
      if (urlStr.includes("/records/batch_update")) {
        updateCalls++;
        return jsonBody({ code: 0, data: { records: [] } });
      }
      throw new Error(`Unhandled URL in mock: ${urlStr}`);
    });

    const destination = new LarkBaseDestination(dummyConfig, { fetcher: mockFetcher });
    const result = await destination.sync([createDummyRecord("B0DUP01", "task-duplicate")]);

    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.results[0]).toMatchObject({
      asin: "B0DUP01",
      action: "failed",
      errorCode: "duplicate_asin_records",
    });
    expect(result.results[0].errorMessage).toContain("2");
    expect(createCalls).toBe(0);
    expect(updateCalls).toBe(0);
  });
});
