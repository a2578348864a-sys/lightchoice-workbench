import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditResearchClaims, makeUnavailableClaimAudit } from "@/lib/research/evidenceAudit";

const mocks = vi.hoisted(() => ({ find: vi.fn(), detail: vi.fn(), create: vi.fn(), update: vi.fn(), search: vi.fn(), fields: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ prisma: { viralAnalysisRecord: { findFirst: mocks.find } } }));
vi.mock("@/lib/server/v5ResearchService", () => ({ getResearchDetail: mocks.detail }));
vi.mock("@/lib/integrations/lark/baseClient", () => ({
  batchCreateRecords: mocks.create, batchUpdateRecords: mocks.update, searchTableRecords: mocks.search, listTableFields: mocks.fields,
  LarkApiError: class extends Error {},
}));
import { syncResearchTask } from "./v5FeishuService";

const input = { context: { mode: "owner" as const, token: "" }, taskId: "task", expectedReportHash: "report", expectedFactHash: "fact", expectedEvidenceHash: "evidence", idempotencyKey: "guard" };
const audit = (opportunities: string[]) => auditResearchClaims({ summary: null, opportunities, risks: [], painPoints: [], salesGrade: "ESTIMATED", reviewBase: null });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.find.mockResolvedValue({ id: "task", resultJson: JSON.stringify({ v5Research: { reportHash: "report", factHash: "fact", evidenceHash: "evidence", researchRevision: 1 } }) });
  mocks.detail.mockResolvedValue({ stale: false, reportHash: "report", factHash: "fact", evidenceHash: "evidence", claimAudit: audit([]) });
});

describe("飞书研究同步的消费门禁", () => {
  it.each([
    { name: "结论越级", overrides: { claimAudit: audit(["购买量600件，说明已有稳定动销，是机会点。"]), stale: false }, code: "RESEARCH_CLAIMS_NOT_CONSUMABLE" },
    { name: "审查缺失", overrides: { claimAudit: null }, code: "RESEARCH_CLAIMS_NOT_CONSUMABLE" },
    { name: "审查不可用", overrides: { claimAudit: makeUnavailableClaimAudit() }, code: "RESEARCH_CLAIMS_NOT_CONSUMABLE" },
    { name: "旧表无法承载警告", overrides: { claimAudit: auditResearchClaims({ summary: null, opportunities: [], risks: ["多位买家反馈尺寸过小"], painPoints: [], salesGrade: "ESTIMATED", reviewBase: null }) }, code: "RESEARCH_CLAIMS_REVIEW_REQUIRED" },
    { name: "当前来源过期", overrides: { stale: true }, code: "REPORT_STALE" },
    { name: "当前权威报告变更", overrides: { reportHash: "new-report" }, code: "REPORT_STALE" },
  ])("$name 时在任何外部适配调用前拒绝", async ({ overrides, code }) => {
    mocks.detail.mockResolvedValue({ stale: false, reportHash: "report", factHash: "fact", evidenceHash: "evidence", claimAudit: audit([]), ...overrides });
    await expect(syncResearchTask(input)).rejects.toMatchObject({ code, status: 409 });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.fields).not.toHaveBeenCalled();
  });
});
