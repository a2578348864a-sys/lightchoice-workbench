import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ get: vi.fn(), preview: vi.fn(), sync: vi.fn() }));
vi.mock("@/lib/server/marketOpportunityRepository", () => ({ createMarketOpportunityRepository: () => ({ getById: state.get }) }));
vi.mock("@/lib/server/research/researchExportBatch", () => ({
  buildResearchExportBatchPreview: state.preview,
  normalizeResearchExportTaskIds: (ids: string[]) => ids,
  RESEARCH_EXPORT_BATCH_MAX_ITEMS: 50,
}));
vi.mock("@/lib/integrations/lark/productProjectSync", () => ({ syncProductProject: state.sync }));
vi.mock("@/lib/integrations/lark", () => ({ LarkBaseDestination: class {}, syncResearchDecisionsToCommodityPool: state.sync }));
import { POST as projectSync } from "@/app/api/market-opportunities/[id]/product-project-sync/route";
import { POST as exportSync } from "@/app/api/research-export/lark-sync/route";
const internal = "DATABASE_URL file:C:/private/business.db credential=fixture-sensitive-value";
const req = () => new NextRequest("http://localhost:3011/api/p4-error-test", { method: "POST",
  headers: { host: "localhost:3011", origin: "http://localhost:3011", "content-type": "application/json" }, body: JSON.stringify({ taskIds: ["p4-task-0"] }) });
afterEach(() => { vi.clearAllMocks(); });
describe("P4 public errors preserve business contract and suppress internal exception strings", () => {
  it("product-project-sync responds with generic 500 before any external write", async () => {
    state.get.mockRejectedValue(new Error(internal));
    const response = await projectSync(req(), { params: Promise.resolve({ id: "p4-missing-opportunity" }) });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: { code: "product_project_sync_failed", message: "产品开发项目同步失败，请稍后重试。" } });
    expect(state.sync).not.toHaveBeenCalled();
  });
  it("research export responds with generic 500 before any external write", async () => {
    state.preview.mockRejectedValue(new Error(internal));
    const response = await exportSync(req());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: { code: "lark_sync_failed", message: "同步到飞书多维表格发生异常，请稍后重试。" } });
    expect(state.sync).not.toHaveBeenCalled();
  });
});
