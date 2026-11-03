import { describe, it, expect, vi } from "vitest";
import { LarkBaseDestination } from "./researchExportSync";
import type { ResearchExportRecord } from "@/lib/research/researchContracts";
import type { LarkConfig } from "./types";

describe("Zero AI Invocation Audit in Sync Pipeline", () => {
  const dummyConfig: LarkConfig = {
    appId: "cli_zero_ai",
    appSecret: "sec_zero_ai",
    appToken: "app_zero_ai",
    tableId: "tbl_zero_ai",
    openApiDomain: "https://open.feishu.cn",
  };

  const dummyRecord: ResearchExportRecord = {
    taskId: "task-zero-ai-01",
    candidateId: "cand-01",
    product: {
      asin: "B0ZEROAI01",
      title: "Zero AI Product",
      image: "https://img.com/zero.jpg",
      category: "Home",
    },
    market: {
      price: { amount: 15.99, currency: "USD" },
      sales: 300,
      bsr: 450,
    },
    research: {
      summary: "已经生成的静态报告摘要",
      priority: "P2",
      opportunity: "已有机会点",
      risks: [],
      unverifiedAssumptions: [],
    },
    humanDecision: {
      status: "continue",
      nextAction: "continue_research",
      notes: "已确认",
      reviewedReportHash: "hash-zero-ai",
      reviewStale: false,
    },
    evidence: {
      reportHash: "hash-zero-ai",
      generatedAt: "2026-09-19T00:00:00.000Z",
      citationCount: 4,
      factCitationCount: 4,
      narrativeCitationCount: 0,
      unverifiedAssumptionCount: 0,
    },
  };

  it("严格证明 Preflight 与 Sync 链路绝对不调用 DeepSeek 或任何 AI 供应商", async () => {
    // 监控全局或潜在的 AI 调用
    const mockAiCaller = vi.fn();

    const mockFetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("api.deepseek.com") || urlStr.includes("typesafe.ai") || urlStr.includes("openai")) {
        mockAiCaller(urlStr);
        throw new Error(`ILLEGAL_AI_CALL: ${urlStr}`);
      }

      if (urlStr.includes("/auth/v3/tenant_access_token")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-safe", expire: 7200 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/fields?page_size=100")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                { field_id: "f1", field_name: "ASIN", type: 1, ui_type: "Text" },
                { field_id: "f2", field_name: "商品标题", type: 1, ui_type: "Text" },
                { field_id: "f3", field_name: "商品图片", type: 1, ui_type: "Text" },
                { field_id: "f4", field_name: "类目", type: 1, ui_type: "Text" },
                { field_id: "f5", field_name: "研究链接", type: 1, ui_type: "Text" },
                { field_id: "f6", field_name: "当前售价", type: 2, ui_type: "Number" },
                { field_id: "f7", field_name: "售价币种", type: 1, ui_type: "Text" },
                { field_id: "f8", field_name: "预估月销量", type: 2, ui_type: "Number" },
                { field_id: "f9", field_name: "BSR", type: 2, ui_type: "Number" },
                { field_id: "f10", field_name: "研究优先级", type: 3, ui_type: "SingleSelect" },
                { field_id: "f11", field_name: "核心机会", type: 1, ui_type: "Text" },
                { field_id: "f12", field_name: "核心风险", type: 1, ui_type: "Text" },
                { field_id: "f13", field_name: "AI研究摘要", type: 1, ui_type: "Text" },
                { field_id: "f14", field_name: "人工状态", type: 3, ui_type: "SingleSelect" },
                { field_id: "f15", field_name: "下一步动作", type: 3, ui_type: "SingleSelect" },
                { field_id: "f16", field_name: "人工备注", type: 1, ui_type: "Text" },
                { field_id: "f17", field_name: "Task ID", type: 1, ui_type: "Text" },
                { field_id: "f18", field_name: "Candidate ID", type: 1, ui_type: "Text" },
                { field_id: "f19", field_name: "Report Hash", type: 1, ui_type: "Text" },
                { field_id: "f20", field_name: "报告生成时间", type: 1, ui_type: "Text" },
                { field_id: "f21", field_name: "最近同步时间", type: 1, ui_type: "Text" },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (urlStr.includes("/records/search")) {
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/records/batch_create")) {
        return new Response(JSON.stringify({ code: 0, data: { records: [{ record_id: "rec_1" }] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unhandled URL: ${urlStr}`);
    });

    const destination = new LarkBaseDestination(dummyConfig, { fetcher: mockFetcher });

    // 运行 Preflight
    const preflight = await destination.preflight();
    expect(preflight.connected).toBe(true);

    // 运行 Sync
    const syncRes = await destination.sync([dummyRecord]);
    expect(syncRes.created).toBe(1);

    // 断言 AI 调用次数绝对为 0
    expect(mockAiCaller).not.toHaveBeenCalled();
    expect(mockAiCaller.mock.calls.length).toBe(0);
  });
});
